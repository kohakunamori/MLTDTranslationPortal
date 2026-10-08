#!/usr/bin/env python3
"""Bootstrap or migrate the portal D1 database, exactly once per file.

Why this exists
---------------
`schema.sql` is the *current* full schema and `migrations/*.sql` are the
*incremental* history. Because the schema file was updated in lockstep with the
early migrations (`assets_releases.release_id`, `source_catalogue.asset_version`
and friends now live in both), running `schema.sql` and then `migrations/0006…`
against the same database fails with `duplicate column name`. That made the two
required paths — "initialise an empty database" and "upgrade an existing one" —
mutually exclusive.

This script makes both work off one ledger:

* Every applied file is recorded in `schema_migrations` with its SHA-256.
* A file whose hash is already recorded is skipped.
* A file whose hash *changed* after being applied is a hard error (that is a
  rewritten migration, and silently re-running it is how data gets lost).
* `--baseline` records the files whose objects already exist without executing
  them — but only when that can be justified from the objects themselves.

SQL/DDL statements are executed one at a time so a failure reports the exact
statement, and a partial failure leaves the ledger consistent (a file is only
recorded after its last statement succeeds).

Read-only preflight (`--status`, `--inspect`) and `--dry-run`
------------------------------------------------------------
Nothing here is allowed to change a database it was only asked to look at:

* `--status` and `--inspect` **never create the ledger table**. A probe that
  writes a table into the database it is inspecting answers "was this database
  bootstrapped?" with the act of asking. No ledger is reported as no ledger.
* `--dry-run` copies the database to a temporary file and runs the full plan
  there, so the target's bytes, ledger and data are untouched.
* `--baseline` is **not** a blanket "trust me". It records a file only when the
  objects that file creates are all present *and* at least one of them carries a
  row that file itself seeded — positive evidence that it ran. A file whose
  objects merely look satisfied (the `ALTER TABLE ... ADD COLUMN` statements,
  which `schema.sql` already satisfies on a fresh database) has no such row and
  is refused. There is no flag to override that: a switch turning "I have no
  evidence" into a recorded fact is the failure this ledger exists to prevent.

Writing — `bootstrap` and `--dry-run` — **classifies first and refuses** unless
the database is `fresh`, `managed-current` or `pending`. A `foreign-unmanaged`,
`hash-mismatch` or `ledger-ahead` database is never written to and never
planned against, so no journal file is created next to it either.

Exit codes (see `STATE_EXIT_CODES`)

    0  managed-current                    6  write/dry-run refused on that state
    2  fresh or pending                   —  the rest are the states above
    3  foreign-unmanaged
    4  hash-mismatch
    5  ledger-ahead

Usage
-----
    # local SQLite file (also what the JS test harness reproduces)
    python web/translation-portal/scripts/bootstrap_portal_d1.py --db local_portal.db

    # a fresh database, printing the SQL to pipe into wrangler instead
    python web/translation-portal/scripts/bootstrap_portal_d1.py --db :memory: --emit-sql out.sql

    # inspect without touching anything (read-only; no ledger is created)
    python web/translation-portal/scripts/bootstrap_portal_d1.py --db local_portal.db --status
    python web/translation-portal/scripts/bootstrap_portal_d1.py --db local_portal.db --inspect --json

    # show exactly what a run would do, against a copy of the database
    python web/translation-portal/scripts/bootstrap_portal_d1.py --db local_portal.db --dry-run
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterable

PORTAL_DIR = Path(__file__).resolve().parents[1]
SCHEMA_FILE = PORTAL_DIR / "schema.sql"
MIGRATIONS_DIR = PORTAL_DIR / "migrations"
LEDGER = "schema_migrations"
LEDGER_COLUMNS = ("filename", "sha256", "applied_at", "stat_runtime")

# A ledger written by `wrangler d1 migrations apply` (id/name/applied_at, and no
# hash at all). It is a different contract, not an older version of ours: it
# cannot detect a rewritten migration, and a name without a hash cannot be
# verified. Its presence means this database is managed by something else.
FOREIGN_LEDGERS = ("d1_migrations",)

# Where `wrangler d1 migrations apply --local` keeps its state. If either file is
# present, a wrangler-managed ledger may exist somewhere this script cannot see,
# and that is a stop-the-line condition rather than a silent "fresh".
WRANGLER_STATE_DIRS = (
    Path(".wrangler") / "state" / "v3" / "d1",
)

# `ALTER TABLE ... ADD COLUMN` cannot be replayed: the second run raises
# "duplicate column name". These are the only such statements in the history and
# they are all satisfied by schema.sql, so they are treated as already applied
# rather than executed. Every later migration is written to be replayable.
UNREPLAYABLE_PATTERNS = (
    re.compile(r"^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\b", re.I),
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def split_statements(sql: str) -> list[str]:
    """Split on semicolons outside of string literals and comments.

    A naive `sql.split(';')` breaks on the CHECK constraints and the
    `'…'` literals in these files, so this walks the text a character at a time.
    """
    statements: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False
    index = 0
    while index < len(sql):
        char = sql[index]
        nxt = sql[index + 1] if index + 1 < len(sql) else ""
        if in_line_comment:
            if char == "\n":
                in_line_comment = False
                current.append(char)
            index += 1
            continue
        if in_block_comment:
            if char == "*" and nxt == "/":
                in_block_comment = False
                index += 2
                continue
            index += 1
            continue
        if in_single:
            current.append(char)
            if char == "'":
                if nxt == "'":
                    current.append(nxt)
                    index += 2
                    continue
                in_single = False
            index += 1
            continue
        if in_double:
            current.append(char)
            if char == '"':
                in_double = False
            index += 1
            continue
        if char == "-" and nxt == "-":
            in_line_comment = True
            index += 2
            continue
        if char == "/" and nxt == "*":
            in_block_comment = True
            index += 2
            continue
        if char == "'":
            in_single = True
            current.append(char)
            index += 1
            continue
        if char == '"':
            in_double = True
            current.append(char)
            index += 1
            continue
        if char == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def migration_files() -> list[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def ensure_ledger(connection: sqlite3.Connection) -> None:
    connection.execute(
        f"CREATE TABLE IF NOT EXISTS {LEDGER} ("
        "  filename TEXT PRIMARY KEY,"
        "  sha256 TEXT NOT NULL,"
        "  applied_at TEXT NOT NULL,"
        "  stat_runtime TEXT"
        ")"
    )


def ledger_exists(connection: sqlite3.Connection) -> bool:
    """Read-only ledger probe. Never creates anything."""
    row = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (LEDGER,)
    ).fetchone()
    return row is not None


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def table_columns(connection: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
    except sqlite3.Error:
        return []


def foreign_ledger_tables(connection: sqlite3.Connection) -> list[str]:
    """Ledger tables this script did not write. Their rows are not ours to trust."""
    return [name for name in FOREIGN_LEDGERS if table_exists(connection, name)]


def read_ledger(connection: sqlite3.Connection) -> dict[str, str | None]:
    """The recorded `filename -> sha256` map, read-only.

    A missing ledger is an empty map, not a created table. A ledger whose rows
    carry no `sha256` (an empty string, or NULL) still yields the filename — with
    `None` for the hash — so the caller can tell "recorded without a hash" from
    "not recorded at all". Conflating those is how an unverified row gets treated
    as an applied-and-verified one.
    """
    if not ledger_exists(connection):
        return {}
    rows = connection.execute(f"SELECT filename, sha256 FROM {LEDGER}").fetchall()
    return {row[0]: row[1] for row in rows}


def wrangler_state_present(root: Path | None = None) -> list[str]:
    """Paths where a wrangler-managed local D1 ledger could live, if any exist."""
    base = root or PORTAL_DIR
    found = []
    for rel in WRANGLER_STATE_DIRS:
        candidate = base / rel
        if candidate.exists():
            found.append(str(rel).replace("\\", "/"))
    return found


def is_unreplayable(statement: str) -> bool:
    return any(pattern.match(statement.strip()) for pattern in UNREPLAYABLE_PATTERNS)


def column_exists(connection: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return False
    return any(row[1] == column for row in rows)


def index_exists(connection: sqlite3.Connection, index: str) -> bool:
    return table_exists(connection, index) or bool(
        connection.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name=?", (index,)
        ).fetchone()
    )


def apply_file(
    connection: sqlite3.Connection,
    path: Path,
    *,
    dry_run: bool,
    emit: list[str] | None = None,
) -> tuple[int, int]:
    """Execute one SQL file. Returns (executed, skipped) statement counts."""
    sql = path.read_text(encoding="utf-8")
    executed = 0
    skipped = 0
    for statement in split_statements(sql):
        if is_unreplayable(statement):
            match = re.match(r"^ALTER\s+TABLE\s+(\S+)\s+ADD\s+COLUMN\s+(\S+)", statement.strip(), re.I)
            if match and column_exists(connection, match.group(1), match.group(2)):
                skipped += 1
                continue
        if emit is not None:
            emit.append(statement.rstrip() + ";")
        if not dry_run:
            connection.execute(statement)
        executed += 1
    return executed, skipped


def record(connection: sqlite3.Connection, path: Path, *, dry_run: bool) -> None:
    if dry_run:
        return
    connection.execute(
        f"INSERT OR REPLACE INTO {LEDGER} (filename, sha256, applied_at, stat_runtime) VALUES (?, ?, datetime('now'), ?)",
        (path.name, sha256_file(path), str(path)),
    )


# ---------------------------------------------------------------------------
# What each file is supposed to leave behind
# ---------------------------------------------------------------------------

_CREATE_OBJECT = re.compile(
    r"^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"'`\[]?(\w+)", re.I
)
_ALTER_COLUMN = re.compile(r"^ALTER\s+TABLE\s+[\"'`\[]?(\w+)[\"'`\]]?\s+ADD\s+COLUMN\s+[\"'`\[]?(\w+)", re.I)
_SEED_INSERT = re.compile(r"^INSERT\s+OR\s+(?:IGNORE|REPLACE)\s+INTO\s+[\"'`\[]?(\w+)", re.I)


def file_effects(path: Path) -> dict:
    """The objects a file creates, the columns it adds, and the tables it seeds.

    Used only for read-only reasoning about what a file *should* have produced.
    Nothing here executes anything.
    """
    effects = {"objects": [], "columns": [], "seeds": []}
    for statement in split_statements(path.read_text(encoding="utf-8")):
        stripped = statement.strip()
        create = _CREATE_OBJECT.match(stripped)
        if create:
            effects["objects"].append((create.group(1).upper(), create.group(2)))
            continue
        alter = _ALTER_COLUMN.match(stripped)
        if alter:
            effects["columns"].append((alter.group(1), alter.group(2)))
            continue
        seed = _SEED_INSERT.match(stripped)
        if seed:
            effects["seeds"].append(seed.group(1))
    return effects


def effect_status(connection: sqlite3.Connection, path: Path) -> dict:
    """Which of a file's effects are observable in the database right now."""
    effects = file_effects(path)
    missing_objects = []
    for kind, name in effects["objects"]:
        present = table_exists(connection, name) if kind == "TABLE" else index_exists(connection, name)
        if not present:
            missing_objects.append(f"{kind} {name}")
    missing_columns = [
        f"{table}.{column}"
        for table, column in effects["columns"]
        if not column_exists(connection, table, column)
    ]
    seeded_with_rows = []
    for table in effects["seeds"]:
        if not table_exists(connection, table):
            continue
        try:
            count = connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        except sqlite3.Error:
            continue
        if count:
            seeded_with_rows.append(f"{table}({count})")
    return {
        "missing_objects": missing_objects,
        "missing_columns": missing_columns,
        "seeded_with_rows": seeded_with_rows,
        "satisfied": not missing_objects and not missing_columns,
    }


def classify(connection: sqlite3.Connection) -> dict:
    """Read-only. Answers "what is this database?" without changing it.

    The six states are mutually exclusive and the first match wins:

      foreign-unmanaged  a ledger this script did not write is present, or the
                         portal objects exist while the ledger is absent *or
                         empty* — either way this database's history is not
                         described by our ledger, so our checksum contract does
                         not apply to it
      hash-mismatch      a recorded file does not hash to what was recorded
                         (including a recorded row with an empty hash, which is
                         unverifiable rather than applied)
      ledger-ahead       the ledger claims a file whose objects are absent — the
                         state that would silently skip the migration that fixes
                         the database
      pending            ledger is intact, some file (schema.sql included) is not
                         recorded
      managed-current    ledger intact, every file recorded, nothing pending
      fresh              no ledger and no portal objects
    """
    result: dict = {"state": None, "reason": "", "details": {}}

    # A ledger this script did not write is checked first and wins over every
    # other reading. It is the strongest signal that this database is someone
    # else's: its rows carry names but no hashes, so "was 0007 applied?" is a
    # question this script structurally cannot answer for it. Reporting "fresh"
    # here — which is what happens if the ledger check comes first — would invite
    # a bootstrap that re-runs the whole history over an unknown schema.
    #
    # Every reason string below is ASCII-only on purpose: this CLI is run from a
    # cp936 console on Windows, where a non-ASCII glyph reaches the operator as
    # mojibake. A classification nobody can read is a classification nobody acts
    # on.
    foreign = foreign_ledger_tables(connection)
    if foreign:
        result.update(
            state="foreign-unmanaged",
            reason=(
                f"a wrangler-managed ledger exists ({', '.join(foreign)}); it records file names "
                "without hashes, so its rows cannot be verified by this script's contract"
            ),
            details={"foreign_ledgers": foreign},
        )
        return result

    portal_objects = [
        name
        for name in ("source_catalogue", "contributions", "portal_summary", "assets_releases")
        if table_exists(connection, name)
    ]

    if not ledger_exists(connection):
        if portal_objects:
            result.update(
                state="foreign-unmanaged",
                reason=(
                    "portal tables exist but no schema_migrations ledger does: this database "
                    "was built by something other than this script"
                ),
                details={"present": portal_objects},
            )
        else:
            result.update(state="fresh", reason="no ledger and no portal objects")
        return result

    ledger = read_ledger(connection)
    if not ledger:
        # An empty ledger is not the same as no database. If the portal is
        # already populated, "records nothing" means the ledger did not survive
        # whatever built this database, and treating it as `fresh` would invite
        # re-running the whole history over live tables.
        if portal_objects:
            result.update(
                state="foreign-unmanaged",
                reason=(
                    "a schema_migrations ledger exists but records nothing, while portal tables "
                    "are populated: the ledger does not describe this database"
                ),
                details={"present": portal_objects},
            )
        else:
            result.update(state="fresh", reason="ledger table exists but records nothing")
        return result

    pending = [p.name for p in migration_files() if p.name not in ledger]
    if SCHEMA_FILE.name not in ledger:
        # schema.sql is re-applied on every run, so a missing row is an
        # incompleteness rather than a hazard -- but a database the ledger does
        # not mention in full is not "current" either, and reporting it as such
        # is how a caller concludes there is nothing left to do.
        pending.insert(0, SCHEMA_FILE.name)
    mismatched = []
    for path in migration_files() + [SCHEMA_FILE]:
        recorded = ledger.get(path.name)
        if recorded is None:
            continue
        is_schema = path == SCHEMA_FILE
        if not recorded:
            # An empty hash is unverifiable whatever the file is: the row says
            # "applied" and carries nothing that can confirm it.
            mismatched.append({"file": path.name, "recorded": "(empty)", "kind": "unverifiable: no hash recorded"})
            continue
        if recorded != sha256_file(path):
            if is_schema:
                # schema.sql legitimately grows; only a migration is frozen.
                continue
            mismatched.append({"file": path.name, "recorded": recorded[:12], "kind": "rewritten after it was applied"})

    if mismatched:
        result.update(
            state="hash-mismatch",
            reason="a recorded file does not match the hash on disk",
            details={"mismatched": mismatched},
        )
        return result

    ahead = []
    for path in migration_files():
        if path.name not in ledger:
            continue
        status = effect_status(connection, path)
        if not status["satisfied"]:
            ahead.append({"file": path.name, **status})
    if ahead:
        result.update(
            state="ledger-ahead",
            reason="the ledger records a file whose objects are not in the database",
            details={"ahead": ahead},
        )
        return result

    if pending:
        result.update(state="pending", reason="ledger intact; migrations recorded but not yet applied", details={"pending": pending})
        return result

    result.update(state="managed-current", reason="every file is recorded and its objects are present")
    return result


def baseline_evidence(connection: sqlite3.Connection, path: Path) -> tuple[bool, str]:
    """Can this file be baselined on evidence rather than on assertion?

    Evidence means the file left a mark that only running it could leave: a row
    in a table it seeds. A file whose only effects are `CREATE ... IF NOT EXISTS`
    and `ALTER TABLE ... ADD COLUMN` has no such mark — `schema.sql` already
    satisfies those columns on a fresh database, so "the objects are there" is
    not evidence that this file ran.
    """
    if path == SCHEMA_FILE:
        return True, "schema.sql is the bootstrap convenience: every statement is re-applicable"
    status = effect_status(connection, path)
    if not status["satisfied"]:
        return False, "objects are missing: " + ", ".join(status["missing_objects"] + status["missing_columns"])
    if status["seeded_with_rows"]:
        return True, "seeded rows present: " + ", ".join(status["seeded_with_rows"])
    return False, "no seeded row to point at; objects alone are not evidence that this file ran"


def bootstrap(
    connection: sqlite3.Connection,
    *,
    baseline: bool = False,
    dry_run: bool = False,
    emit: list[str] | None = None,
) -> dict:
    """Bring `connection` to the current schema, applying each file at most once."""
    ensure_ledger(connection)
    ledger = read_ledger(connection)
    report = {
        "applied": [],
        "skipped": [],
        "baselined": [],
        "refused": [],
        "rewritten": [],
        "schema_reapplied": False,
        "statements": 0,
        "unreplayable_skipped": 0,
    }

    # Baselining means writing "this file ran" into the ledger for a database we
    # did not migrate, so every such claim must be backed by something
    # observable. All of that is decided *before* anything is recorded or
    # executed: a refusal that had already written a ledger row would leave the
    # database half-adopted, which is worse than not starting. There is
    # deliberately no flag to override this — a CLI switch that turns "I have no
    # evidence" into a recorded fact is the exact failure this ledger exists to
    # prevent, and adopting a database without evidence is a reviewed migration
    # decision, not a command-line option.
    evidence: dict[str, str] = {}
    if baseline:
        for path in migration_files():
            if ledger.get(path.name) is not None:
                continue
            ok, why = baseline_evidence(connection, path)
            if ok:
                evidence[path.name] = why
            else:
                report["refused"].append({"file": path.name, "reason": why})
        if report["refused"]:
            raise SystemExit(
                "[!] refusing to baseline without evidence:\n"
                + "\n".join(f"      {item['file']}: {item['reason']}" for item in report["refused"])
                + "\n    A file may only be baselined when the database shows a mark it left "
                "(a seeded row). Adopting a database without that evidence is a reviewed "
                "migration decision, not a flag."
            )

    schema_hash = sha256_file(SCHEMA_FILE)
    schema_name = SCHEMA_FILE.name
    recorded_schema = ledger.get(schema_name)

    # schema.sql is not a migration: it is the bootstrap convenience that states
    # the current schema in one file, and it legitimately grows as migrations are
    # added. Every statement in it is CREATE ... IF NOT EXISTS, so re-applying a
    # changed copy is safe — unlike a migration, where a changed hash means an
    # applied file was rewritten and the data it produced cannot be trusted.
    #
    # It is always executed and its hash always refreshed, so it stays in
    # `applied` on every run — that is the existing contract every caller and
    # test already encodes. `migrations_applied` is reported alongside it, which
    # is the number a re-run should actually be judged by (it must be 0).
    if recorded_schema is None and baseline:
        report["baselined"].append(schema_name)
        record(connection, SCHEMA_FILE, dry_run=dry_run)
        report["schema_reapplied"] = False
    else:
        executed, skipped = apply_file(connection, SCHEMA_FILE, dry_run=dry_run, emit=emit)
        report["schema_reapplied"] = True
        report["applied"].append(schema_name)
        report["statements"] += executed
        report["unreplayable_skipped"] += skipped
        record(connection, SCHEMA_FILE, dry_run=dry_run)

    for path in migration_files():
        digest = sha256_file(path)
        recorded = ledger.get(path.name)
        if recorded is None and baseline:
            report["baselined"].append(path.name)
            record(connection, path, dry_run=dry_run)
            continue
        if recorded is None:
            executed, skipped = apply_file(connection, path, dry_run=dry_run, emit=emit)
            report["applied"].append(path.name)
            report["statements"] += executed
            report["unreplayable_skipped"] += skipped
            record(connection, path, dry_run=dry_run)
            continue
        if not recorded or recorded != digest:
            report["rewritten"].append(path.name)
            shown = recorded[:12] if recorded else "(empty hash: unverifiable)"
            raise SystemExit(
                f"[!] {path.name} is recorded as {shown} but hashes to {digest[:12]} now. "
                "Either the file was rewritten after it was applied (add a new migration instead), "
                "or the recorded hash is empty and this row cannot be trusted. "
                "Do not re-run it on a database that may already have its effects."
            )
        report["skipped"].append(path.name)

    report["evidence"] = evidence
    # `applied` includes schema.sql (always re-applied, by design). This is the
    # count that must be 0 on an idempotent re-run.
    report["migrations_applied"] = [name for name in report["applied"] if name != SCHEMA_FILE.name]
    if not dry_run:
        connection.commit()
    return report


# ---------------------------------------------------------------------------
# Read-only opening
# ---------------------------------------------------------------------------


def open_read_only(path: str) -> sqlite3.Connection:
    """Open an existing SQLite file without any possibility of writing to it.

    `sqlite3.connect()` creates a missing file and `ensure_ledger()` would then
    populate it — a probe that mutates what it measures. Read paths use this
    instead: a missing file becomes an in-memory database, and an existing one is
    opened with `mode=ro`.
    """
    if path == ":memory:":
        return sqlite3.connect(":memory:")
    resolved = Path(path).resolve()
    if not resolved.exists():
        return sqlite3.connect(":memory:")
    uri = resolved.as_posix()
    return sqlite3.connect(f"file:{uri}?mode=ro", uri=True)


def dry_run_copy(path: str) -> tuple[sqlite3.Connection, str | None]:
    """A throwaway copy of the target, so a dry run can plan without touching it.

    Returns the connection and the temporary file to delete (None for :memory:).
    """
    if path == ":memory:":
        return sqlite3.connect(":memory:"), None
    resolved = Path(path).resolve()
    if not resolved.exists():
        return sqlite3.connect(":memory:"), None
    handle = tempfile.NamedTemporaryFile(prefix="bootstrap-dryrun-", suffix=".db", delete=False)
    handle.close()
    shutil.copyfile(resolved, handle.name)
    return sqlite3.connect(handle.name), handle.name


def file_fingerprint(path: str) -> dict:
    """Size + mtime + hash of a database file, for proving a probe did not touch it."""
    resolved = Path(path).resolve()
    if not resolved.exists():
        return {"exists": False}
    stat = resolved.stat()
    return {
        "exists": True,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "sha256": sha256_file(resolved),
    }


def render_status(state: dict, connection: sqlite3.Connection, db: str) -> str:
    lines = [f"[*] db={db}", f"[*] state={state['state']}  ({state['reason']})"]
    details = state.get("details") or {}
    if details.get("pending"):
        lines.append(f"    pending:   {', '.join(details['pending'])}")
    for item in details.get("mismatched", []):
        lines.append(f"    mismatch:  {item['file']} recorded={item['recorded']} ({item['kind']})")
    for item in details.get("ahead", []):
        missing = item["missing_objects"] + item["missing_columns"]
        lines.append(f"    ahead:     {item['file']} missing {', '.join(missing)}")
    if details.get("foreign_ledgers"):
        lines.append(f"    foreign:   {', '.join(details['foreign_ledgers'])}")
    if details.get("present"):
        lines.append(f"    present:   {', '.join(details['present'])}")

    if ledger_exists(connection):
        rows = list(
            connection.execute(
                f"SELECT filename, sha256, applied_at FROM {LEDGER} ORDER BY filename"
            )
        )
        if rows:
            lines.append("    ledger:")
            for filename, digest, applied_at in rows:
                shown = digest[:12] if digest else "(empty)"
                lines.append(f"      {filename:44s} {shown}  {applied_at}")
    found = wrangler_state_present()
    if found:
        lines.append(f"[!] wrangler local state present ({', '.join(found)}): a second ledger may exist there")
    return "\n".join(lines)


# Exit codes. `status` answers "is this database ready?", not "did the command
# parse": anything short of managed-current is a non-zero answer, because a
# caller that treats "not bootstrapped" as success is a caller that proceeds.
EXIT_READY = 0
EXIT_NOT_READY = 2          # fresh / pending — manageable, simply not current yet
EXIT_FOREIGN = 3            # foreign-unmanaged
EXIT_HASH_MISMATCH = 4      # hash-mismatch
EXIT_LEDGER_AHEAD = 5       # ledger-ahead
EXIT_WRONG_TARGET = 6       # a write/dry-run asked for on a database we must not touch

STATE_EXIT_CODES = {
    "managed-current": EXIT_READY,
    "fresh": EXIT_NOT_READY,
    "pending": EXIT_NOT_READY,
    "foreign-unmanaged": EXIT_FOREIGN,
    "hash-mismatch": EXIT_HASH_MISMATCH,
    "ledger-ahead": EXIT_LEDGER_AHEAD,
}

# The only states a write may proceed from. Everything else is refused *before*
# the read-write connection is opened, so a refusal cannot so much as create a
# journal file next to the database it declined to touch.
WRITABLE_STATES = ("fresh", "managed-current", "pending")

REFUSAL_TEXT = {
    "foreign-unmanaged": (
        "this database is managed by something other than this script. Its rows carry no "
        "hashes, so nothing here can say which files are applied. Adopting it is a reviewed "
        "migration decision; it is not something a command-line flag should decide."
    ),
    "hash-mismatch": (
        "a recorded file does not match what is on disk. Re-running would execute a migration "
        "whose effects may already be present."
    ),
    "ledger-ahead": (
        "the ledger records a file whose objects are missing. The ledger believes it is applied; "
        "the database says it is not. Re-running would skip the very migration that fixes this."
    ),
}


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=str(PORTAL_DIR / "local_portal.db"), help="SQLite file, or ':memory:'")
    parser.add_argument("--baseline", action="store_true", help="Record files as applied WITHOUT executing them (adopt an existing database; requires evidence)")
    parser.add_argument("--status", action="store_true", help="Print the classification and ledger, read-only")
    parser.add_argument("--inspect", action="store_true", help="Alias of --status")
    parser.add_argument("--json", action="store_true", help="Emit the read-only report as JSON")
    parser.add_argument("--dry-run", action="store_true", help="Plan against a copy; the target file is never touched")
    parser.add_argument("--emit-sql", help="Write every statement that would run to this file (for `wrangler d1 execute --file`)")
    args = parser.parse_args(list(argv) if argv is not None else None)

    # --- read-only paths -------------------------------------------------
    if args.status or args.inspect:
        connection = open_read_only(args.db)
        try:
            state = classify(connection)
            if args.json:
                state["ledger"] = read_ledger(connection)
                state["wrangler_state"] = wrangler_state_present()
                print(json.dumps(state, ensure_ascii=False, indent=2, default=str))
            else:
                print(render_status(state, connection, args.db))
            return STATE_EXIT_CODES.get(state["state"], EXIT_NOT_READY)
        finally:
            connection.close()

    if args.dry_run:
        # Classify first. A dry run produces *a plan to write*; producing one for
        # a database this script must not write to would be a plan nobody should
        # run. Refusing here is the same decision the write path makes, moved to
        # where it costs nothing.
        probe = open_read_only(args.db)
        try:
            state = classify(probe)
        finally:
            probe.close()
        if state["state"] not in WRITABLE_STATES:
            print(f"[!] refusing to plan a write: state={state['state']} ({state['reason']})", file=sys.stderr)
            print(f"    {REFUSAL_TEXT.get(state['state'], '')}", file=sys.stderr)
            return STATE_EXIT_CODES.get(state["state"], EXIT_WRONG_TARGET)

        before = file_fingerprint(args.db)
        connection, temp_path = dry_run_copy(args.db)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            emit: list[str] | None = [] if args.emit_sql else None
            report = bootstrap(
                connection,
                baseline=args.baseline,
                dry_run=False,  # the copy is the thing being written to; the target is not
                emit=emit,
            )
            connection.rollback()  # discard the plan's writes on the copy
            after = file_fingerprint(args.db)
            if args.json:
                print(json.dumps({"state": state, "plan": report, "target_before": before, "target_after": after}, ensure_ascii=False, indent=2, default=str))
            else:
                print(f"[*] dry-run against a copy of {args.db} (target untouched)")
                print(f"    state={state['state']} ({state['reason']})")
                print(f"    would apply:      {', '.join(report['applied']) or '(nothing)'}")
                print(f"    would skip:       {', '.join(report['skipped']) or '(nothing)'}")
                if report["baselined"]:
                    print(f"    would baseline:   {', '.join(report['baselined'])}")
                print(f"    migrations applied: {len(report['migrations_applied'])} "
                      f"(statements={report['statements']} unreplayable_skipped={report['unreplayable_skipped']})")
                print(f"    target bytes unchanged: {before == after}")
            return EXIT_READY if before == after else EXIT_WRONG_TARGET
        except SystemExit as exc:
            # `bootstrap` refuses to baseline without evidence. That is a refusal
            # to plan, so it answers with the same code as any other refusal
            # rather than with "not ready" (which would read as "manageable").
            print(str(exc), file=sys.stderr)
            return EXIT_WRONG_TARGET
        finally:
            connection.close()
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    # --- write path ------------------------------------------------------
    # Classify on a read-only handle first, and refuse before opening anything
    # read-write. The previous order (connect, ensure_ledger, bootstrap) would
    # happily write a ledger table into a database it was only supposed to
    # inspect — or worse, run the whole history over a wrangler-managed one.
    probe = open_read_only(args.db)
    try:
        state = classify(probe)
    finally:
        probe.close()
    if state["state"] not in WRITABLE_STATES:
        print(f"[!] refusing to write: state={state['state']} ({state['reason']})", file=sys.stderr)
        print(f"    {REFUSAL_TEXT.get(state['state'], '')}", file=sys.stderr)
        return STATE_EXIT_CODES.get(state["state"], EXIT_WRONG_TARGET)

    connection = sqlite3.connect(args.db)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        ensure_ledger(connection)

        emit: list[str] | None = [] if args.emit_sql else None
        report = bootstrap(
            connection,
            baseline=args.baseline,
            dry_run=False,
            emit=emit,
        )

        if args.emit_sql and emit:
            Path(args.emit_sql).write_text("\n".join(emit) + "\n", encoding="utf-8")
            print(f"[*] wrote {len(emit)} statements to {args.emit_sql}")

        print(f"[*] db={args.db} applied={len(report['applied'])} skipped={len(report['skipped'])} "
              f"baselined={len(report['baselined'])} statements={report['statements']} "
              f"unreplayable_skipped={report['unreplayable_skipped']} "
              f"migrations_applied={len(report['migrations_applied'])}")
        if report["applied"]:
            print(f"    applied:   {', '.join(report['applied'])}")
        if report["baselined"]:
            for name in report["baselined"]:
                print(f"    baselined: {name}  ({report['evidence'].get(name, 'no evidence recorded')})")
        return EXIT_READY
    except SystemExit as exc:
        connection.rollback()
        print(str(exc), file=sys.stderr)
        return EXIT_WRONG_TARGET
    except sqlite3.Error as error:
        connection.rollback()
        print(f"[!] SQL error, ledger NOT advanced for the failing file: {error}", file=sys.stderr)
        print("[!] re-run after fixing; already-recorded files are skipped, so a retry is safe", file=sys.stderr)
        return 1
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
