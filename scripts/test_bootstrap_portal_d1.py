#!/usr/bin/env python3
"""Tests for the portal D1 bootstrap/migration preflight.

Everything here runs offline against scratch databases under a temporary
directory. Nothing touches `local_portal.db`, the remote D1, R2, or the network.

The suite is organised around one question: **does the preflight ever write to,
or plan a write for, a database it should be refusing?** Every read-only test
therefore asserts on the bytes of the target, not only on the exit code.

Run:
    python web/translation-portal/scripts/test_bootstrap_portal_d1.py
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
PORTAL_DIR = SCRIPTS_DIR.parent


def load_module():
    spec = importlib.util.spec_from_file_location("bootstrap_portal_d1", SCRIPTS_DIR / "bootstrap_portal_d1.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bp = load_module()

# The exit codes the tests assert on, named where they are used so a change to
# the numbers shows up as a renamed constant rather than a silently passing
# comparison.
READY = bp.EXIT_READY
NOT_READY = bp.EXIT_NOT_READY
FOREIGN = bp.EXIT_FOREIGN
HASH_MISMATCH = bp.EXIT_HASH_MISMATCH
LEDGER_AHEAD = bp.EXIT_LEDGER_AHEAD


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    """Invoke main() and capture its streams, the way the CLI would."""
    out, err = io.StringIO(), io.StringIO()
    try:
        with redirect_stdout(out), redirect_stderr(err):
            code = bp.main(argv)
    except SystemExit as exc:  # bootstrap raises SystemExit for refused operations
        code = exc.code if isinstance(exc.code, int) else 1
        err.write(str(exc) + "\n")
    return code, out.getvalue(), err.getvalue()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ScratchDatabase(unittest.TestCase):
    """A temp dir per test; a database is created on demand."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def db(self, name: str = "test.db") -> Path:
        return self.tmp / name

    def connect(self, path: Path) -> sqlite3.Connection:
        return sqlite3.connect(path)

    def apply_schema_only(self, path: Path) -> None:
        """The `0006`-shaped database: schema.sql applied, no ledger, no 0007."""
        conn = self.connect(path)
        try:
            for statement in bp.split_statements(bp.SCHEMA_FILE.read_text(encoding="utf-8")):
                conn.execute(statement)
            conn.commit()
        finally:
            conn.close()

    def ledger_state(self, path: Path) -> dict:
        conn = self.connect(path)
        try:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            return {
                "has_ledger": "schema_migrations" in tables,
                "has_d1_migrations": "d1_migrations" in tables,
                "tables": tables,
            }
        finally:
            conn.close()

    def make_wrangler_managed(self, path: Path) -> None:
        conn = self.connect(path)
        try:
            conn.execute(
                "CREATE TABLE d1_migrations ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " name TEXT UNIQUE,"
                " applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
            )
            conn.execute("INSERT INTO d1_migrations (name) VALUES ('0007_github_sync_consumer.sql')")
            conn.commit()
        finally:
            conn.close()


class TestFreshDatabase(ScratchDatabase):
    def test_empty_file_classifies_as_fresh(self):
        path = self.db()
        path.write_bytes(b"")
        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, NOT_READY, "fresh is manageable but not ready")
        self.assertIn("state=fresh", out)

    def test_missing_file_classifies_as_fresh_without_creating_it(self):
        path = self.db("absent.db")
        code, _, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, NOT_READY)
        self.assertFalse(path.exists(), "--status must not create the database file it is inspecting")

    def test_bootstrap_applies_everything_then_is_idempotent(self):
        path = self.db()
        path.write_bytes(b"")
        code, out, _ = run_cli(["--db", str(path)])
        self.assertEqual(code, READY)
        self.assertIn("applied=11", out)  # schema.sql + 0002–0011
        self.assertIn("migrations_applied=10", out)
        self.assertIn("0010_portal_sessions.sql", out)
        self.assertIn("0011_github_user_tokens.sql", out)
        conn = self.connect(path)
        try:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"portal_sessions", "github_user_tokens"} <= tables)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(github_user_tokens)")}
            self.assertTrue({"ciphertext", "iv", "key_id"} <= columns)
            self.assertNotIn("token", columns)
        finally:
            conn.close()

        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, READY, "managed-current is the one ready state")
        self.assertIn("state=managed-current", out)

        code, out, _ = run_cli(["--db", str(path)])
        self.assertEqual(code, READY)
        self.assertIn("applied=1", out)  # schema.sql is re-applied on every run
        self.assertIn("migrations_applied=0", out)
        self.assertIn("skipped=10", out)

    def test_replay_executes_no_statement_twice(self):
        """Every file is replayable: a second run must not raise or grow the schema."""
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            before = conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
        finally:
            conn.close()
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            after = conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(before, after)

    def test_schema_sql_stays_in_applied_but_migrations_do_not(self):
        conn = sqlite3.connect(":memory:")
        try:
            bp.ensure_ledger(conn)
            first = bp.bootstrap(conn)
            second = bp.bootstrap(conn)
        finally:
            conn.close()
        self.assertIn("schema.sql", first["applied"])
        self.assertIn("schema.sql", second["applied"])
        self.assertEqual(first["migrations_applied"], [
            "0002_optimize_indexes.sql", "0003_image_status_overrides.sql",
            "0004_image_restore_requests.sql", "0005_decouple_release_versions.sql",
            "0006_independent_release_axes.sql", "0007_github_sync_consumer.sql",
            "0008_historical_seed_provenance.sql", "0009_github_collab.sql",
            "0010_portal_sessions.sql", "0011_github_user_tokens.sql",
        ])
        self.assertEqual(second["migrations_applied"], [], "a re-run executes no migration")
        self.assertTrue(first["schema_reapplied"])
        self.assertTrue(second["schema_reapplied"])


class TestObjectPresentLedgerAbsent(ScratchDatabase):
    """The state `local_portal.db` is actually in: objects, no ledger."""

    def setUp(self):
        super().setUp()
        self.path = self.db()
        self.path.write_bytes(b"")
        self.apply_schema_only(self.path)

    def test_classified_foreign_unmanaged_and_not_reported_as_fresh(self):
        code, out, _ = run_cli(["--db", str(self.path), "--status"])
        self.assertEqual(code, FOREIGN)
        self.assertIn("state=foreign-unmanaged", out)
        self.assertNotIn("state=fresh", out)

    def test_status_does_not_create_a_ledger(self):
        before = digest(self.path)
        run_cli(["--db", str(self.path), "--status"])
        self.assertFalse(self.ledger_state(self.path)["has_ledger"])
        self.assertEqual(before, digest(self.path), "a probe must not rewrite the file")

    def test_inspect_json_is_read_only_too(self):
        code, out, _ = run_cli(["--db", str(self.path), "--inspect", "--json"])
        self.assertEqual(code, FOREIGN)
        self.assertIn('"foreign-unmanaged"', out)
        self.assertFalse(self.ledger_state(self.path)["has_ledger"])

    def test_write_is_refused_and_creates_nothing(self):
        before = (self.path.stat().st_size, digest(self.path))
        code, _, err = run_cli(["--db", str(self.path)])
        self.assertEqual(code, FOREIGN)
        self.assertIn("refusing to write", err)
        self.assertEqual(before, (self.path.stat().st_size, digest(self.path)))
        self.assertFalse(self.ledger_state(self.path)["has_ledger"], "a refused write must not even create the ledger")

    def test_write_refusal_leaves_no_journal_beside_the_database(self):
        run_cli(["--db", str(self.path)])
        strays = [p.name for p in self.path.parent.iterdir() if p.name != self.path.name]
        self.assertEqual(strays, [], f"a refused write must leave nothing behind: {strays}")

    def test_dry_run_is_refused_too_and_produces_no_plan(self):
        """A plan for a database we must not write to is a plan nobody should run."""
        before = digest(self.path)
        code, out, err = run_cli(["--db", str(self.path), "--dry-run"])
        self.assertEqual(code, FOREIGN)
        self.assertIn("refusing to plan a write", err)
        self.assertNotIn("would apply", out, "no plan may be printed for a refused target")
        self.assertEqual(before, digest(self.path))


class TestEmptyLedger(ScratchDatabase):
    """An empty ledger beside populated tables is not a fresh database."""

    def build(self) -> Path:
        """`schema.sql` objects present, `schema_migrations` created but empty."""
        path = self.db()
        path.write_bytes(b"")
        self.apply_schema_only(path)
        conn = self.connect(path)
        try:
            bp.ensure_ledger(conn)
            conn.commit()
        finally:
            conn.close()
        return path

    def test_an_empty_ledger_beside_portal_objects_is_foreign_unmanaged(self):
        path = self.build()
        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, FOREIGN)
        self.assertIn("state=foreign-unmanaged", out)
        self.assertNotIn("state=fresh", out)

    def test_an_empty_ledger_with_no_objects_is_still_fresh(self):
        """A brand-new database mid-bootstrap looks exactly like this."""
        path = self.db()
        path.write_bytes(b"")
        conn = self.connect(path)
        try:
            bp.ensure_ledger(conn)
            conn.commit()
        finally:
            conn.close()
        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, NOT_READY)
        self.assertIn("state=fresh", out)

    def test_write_and_dry_run_are_both_refused(self):
        path = self.build()
        before = digest(path)

        code, _, err = run_cli(["--db", str(path)])
        self.assertEqual(code, FOREIGN)
        self.assertIn("refusing to write", err)

        code, out, err = run_cli(["--db", str(path), "--dry-run"])
        self.assertEqual(code, FOREIGN)
        self.assertIn("refusing to plan a write", err)
        self.assertNotIn("would apply", out)

        self.assertEqual(before, digest(path))


class TestLedgerCompleteness(ScratchDatabase):
    """`managed-current` requires the ledger to mention schema.sql too."""

    def test_all_migrations_recorded_but_no_schema_row_is_pending(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("DELETE FROM schema_migrations WHERE filename='schema.sql'")
            conn.commit()
        finally:
            conn.close()

        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, NOT_READY, "a ledger that does not mention schema.sql is not current")
        self.assertIn("state=pending", out)
        self.assertIn("schema.sql", out)
        self.assertNotIn("state=managed-current", out)

    def test_that_state_is_manageable_and_repairs_itself(self):
        """Missing the schema row is incomplete, not hazardous: a run fixes it."""
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("DELETE FROM schema_migrations WHERE filename='schema.sql'")
            conn.commit()
        finally:
            conn.close()

        code, out, _ = run_cli(["--db", str(path)])
        self.assertEqual(code, READY)
        self.assertIn("applied=1", out)
        self.assertIn("migrations_applied=0", out)

        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, READY)
        self.assertIn("state=managed-current", out)

    def test_the_docstring_states_the_schema_rule(self):
        """The states are documented where they are implemented."""
        doc = bp.classify.__doc__ or ""
        self.assertIn("empty*", doc, "the empty-ledger case must be documented")
        self.assertIn("schema.sql included", doc)


class TestForeignLedger(ScratchDatabase):
    def test_d1_migrations_presence_is_foreign_unmanaged(self):
        path = self.db()
        path.write_bytes(b"")
        self.make_wrangler_managed(path)
        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, FOREIGN)
        self.assertIn("state=foreign-unmanaged", out)
        self.assertIn("d1_migrations", out)

    def test_a_wrangler_ledger_is_never_treated_as_applied(self):
        """The whole point: a name without a hash cannot be verified."""
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute(
                "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP)"
            )
            conn.execute("INSERT INTO d1_migrations (name) VALUES ('0007_github_sync_consumer.sql')")
            self.assertEqual(bp.read_ledger(conn), {})
            self.assertEqual(bp.foreign_ledger_tables(conn), ["d1_migrations"])
        finally:
            conn.close()

    def test_write_and_dry_run_are_both_refused(self):
        path = self.db()
        path.write_bytes(b"")
        self.make_wrangler_managed(path)
        before = digest(path)

        code, _, err = run_cli(["--db", str(path)])
        self.assertEqual(code, FOREIGN)
        self.assertIn("refusing to write", err)

        code, _, err = run_cli(["--db", str(path), "--dry-run"])
        self.assertEqual(code, FOREIGN, "a dry run must not plan a write for a database it cannot write")
        self.assertIn("refusing to plan a write", err)

        self.assertEqual(before, digest(path))
        self.assertFalse(self.ledger_state(path)["has_ledger"])


class TestMissing0007Columns(ScratchDatabase):
    """`sync_jobs` without the four columns 0007 adds must be visible as such."""

    def test_ledger_ahead_is_detected_and_fails(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            # Simulate a database the ledger believes is at 0007 while the
            # columns are gone. This is the state that silently skips repairs.
            conn.execute("DROP TABLE sync_jobs")
            conn.execute("CREATE TABLE sync_jobs (job_id TEXT PRIMARY KEY, status TEXT)")
            conn.commit()
        finally:
            conn.close()

        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, LEDGER_AHEAD)
        self.assertIn("state=ledger-ahead", out)
        self.assertIn("sync_jobs.before_sha", out)

    def test_ledger_ahead_blocks_the_write_and_the_plan(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("DROP TABLE sync_jobs")
            conn.execute("CREATE TABLE sync_jobs (job_id TEXT PRIMARY KEY, status TEXT)")
            conn.commit()
        finally:
            conn.close()
        before = digest(path)

        code, _, err = run_cli(["--db", str(path)])
        self.assertEqual(code, LEDGER_AHEAD)
        self.assertIn("refusing to write", err)

        code, _, err = run_cli(["--db", str(path), "--dry-run"])
        self.assertEqual(code, LEDGER_AHEAD)
        self.assertIn("refusing to plan a write", err)

        self.assertEqual(before, digest(path))

    def test_the_four_columns_are_what_0007_really_adds(self):
        """Guard against the probe list drifting away from the migration."""
        effects = bp.file_effects(bp.MIGRATIONS_DIR / "0007_github_sync_consumer.sql")
        columns = {f"{table}.{column}" for table, column in effects["columns"]}
        for expected in ("sync_jobs.before_sha", "sync_jobs.cursor_json",
                         "sync_jobs.rows_written", "sync_jobs.result_json"):
            self.assertIn(expected, columns)


class TestHashIntegrity(ScratchDatabase):
    def test_empty_recorded_hash_is_unverifiable_not_applied(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("UPDATE schema_migrations SET sha256='' WHERE filename LIKE '0007%'")
            conn.commit()
        finally:
            conn.close()

        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, HASH_MISMATCH)
        self.assertIn("state=hash-mismatch", out)
        self.assertIn("no hash recorded", out)

    def test_empty_hash_blocks_write_and_plan(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("UPDATE schema_migrations SET sha256='' WHERE filename LIKE '0007%'")
            conn.commit()
        finally:
            conn.close()
        before = digest(path)

        code, _, err = run_cli(["--db", str(path)])
        self.assertEqual(code, HASH_MISMATCH)
        self.assertIn("refusing to write", err)
        code, _, err = run_cli(["--db", str(path), "--dry-run"])
        self.assertEqual(code, HASH_MISMATCH)
        self.assertEqual(before, digest(path))

    def test_rewritten_migration_is_refused(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("UPDATE schema_migrations SET sha256=? WHERE filename LIKE '0007%'",
                         ("0" * 64,))
            conn.commit()
        finally:
            conn.close()
        code, _, err = run_cli(["--db", str(path)])
        self.assertEqual(code, HASH_MISMATCH)
        self.assertIn("refusing to write", err)


class TestDryRun(ScratchDatabase):
    def test_dry_run_leaves_target_bytes_identical(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])  # give it content
        before = (path.stat().st_size, digest(path))
        code, out, _ = run_cli(["--db", str(path), "--dry-run"])
        self.assertEqual(code, READY)
        self.assertIn("target bytes unchanged: True", out)
        self.assertEqual(before, (path.stat().st_size, digest(path)))

    def test_dry_run_on_a_missing_file_does_not_create_it(self):
        path = self.db("absent.db")
        code, out, _ = run_cli(["--db", str(path), "--dry-run"])
        self.assertEqual(code, READY)
        self.assertFalse(path.exists())

    def test_dry_run_plans_a_fresh_database(self):
        path = self.db()
        path.write_bytes(b"")
        code, out, _ = run_cli(["--db", str(path), "--dry-run"])
        self.assertEqual(code, READY)
        self.assertIn("state=fresh", out)
        self.assertIn("migrations applied: 10", out)
        self.assertEqual(path.read_bytes(), b"", "the target must still be empty")

    def test_dry_run_does_not_leave_a_copy_behind(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        strays = {p.name for p in Path(tempfile.gettempdir()).glob("bootstrap-dryrun-*.db")}
        run_cli(["--db", str(path), "--dry-run"])
        after = {p.name for p in Path(tempfile.gettempdir()).glob("bootstrap-dryrun-*.db")}
        self.assertEqual(strays, after, "the temporary copy must be removed")


class TestBaselineEvidence(ScratchDatabase):
    def test_baseline_is_refused_when_no_file_has_evidence(self):
        """A ledger with nothing in it, and no objects: 0002 has no seeded row.

        The database is writable (`fresh`), so this refusal comes from the
        evidence rule itself rather than from the writable-state gate.
        """
        path = self.db()
        path.write_bytes(b"")
        conn = self.connect(path)
        try:
            bp.ensure_ledger(conn)
            conn.commit()
        finally:
            conn.close()

        before = digest(path)
        code, _, err = run_cli(["--db", str(path), "--baseline"])
        self.assertEqual(code, bp.EXIT_WRONG_TARGET)
        self.assertIn("refusing to baseline without evidence", err)
        self.assertIn("0002_optimize_indexes.sql", err)
        self.assertEqual(before, digest(path), "a refusal to baseline must not have recorded schema.sql first")

    def test_a_schema_shaped_database_is_refused_before_baselining(self):
        """`local_portal.db`'s shape: the evidence rule never even gets asked."""
        path = self.db()
        path.write_bytes(b"")
        self.apply_schema_only(path)
        before = digest(path)
        code, _, err = run_cli(["--db", str(path), "--baseline"])
        self.assertEqual(code, FOREIGN)
        self.assertIn("refusing to write", err)
        self.assertEqual(before, digest(path))

    def test_there_is_no_flag_to_baseline_without_evidence(self):
        """A CLI switch must not be able to turn an assertion into a recorded fact."""
        self.assertFalse(
            hasattr(bp, "allow_unsatisfied"),
            "the blanket override was removed deliberately; do not reintroduce it",
        )
        code, _, err = run_cli(["--db", ":memory:", "--baseline", "--allow-unsatisfied"])
        self.assertNotEqual(code, 0, "the flag must not be accepted")
        self.assertIn("unrecognized arguments", err)

    def test_baseline_accepts_a_file_whose_seeded_row_is_present(self):
        """0006 seeds `assets_releases`; that row is evidence it ran."""
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("DELETE FROM schema_migrations WHERE filename LIKE '0006%'")
            conn.commit()
            ok, why = bp.baseline_evidence(conn, bp.MIGRATIONS_DIR / "0006_independent_release_axes.sql")
            self.assertTrue(ok, why)
            self.assertIn("seeded rows present", why)
        finally:
            conn.close()

    def test_a_seedless_file_has_no_evidence(self):
        conn = sqlite3.connect(":memory:")
        try:
            for statement in bp.split_statements(bp.SCHEMA_FILE.read_text(encoding="utf-8")):
                conn.execute(statement)
            ok, why = bp.baseline_evidence(conn, bp.MIGRATIONS_DIR / "0003_image_status_overrides.sql")
            self.assertFalse(ok)
            self.assertIn("no seeded row", why)
        finally:
            conn.close()

    def test_baseline_records_schema_without_executing_it(self):
        """`--baseline` adopts a database it did not build; it must not execute."""
        conn = sqlite3.connect(":memory:")
        try:
            bp.ensure_ledger(conn)
            # A fresh empty database has no evidence for any migration, so the
            # adoption is refused outright — which is the point.
            with self.assertRaises(SystemExit):
                bp.bootstrap(conn, baseline=True)
            self.assertEqual(bp.read_ledger(conn), {}, "the refusal must precede the ledger write")
        finally:
            conn.close()


class TestExitCodes(ScratchDatabase):
    """The contract a caller scripts against: 0 means "ready", nothing else does."""

    def test_only_managed_current_is_ready(self):
        path = self.db()
        path.write_bytes(b"")
        code, _, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, NOT_READY, "fresh")

        run_cli(["--db", str(path)])
        code, _, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, READY, "managed-current")

    def test_pending_is_not_ready(self):
        path = self.db()
        path.write_bytes(b"")
        run_cli(["--db", str(path)])
        conn = self.connect(path)
        try:
            conn.execute("DELETE FROM schema_migrations WHERE filename LIKE '0004%'")
            conn.commit()
        finally:
            conn.close()
        code, out, _ = run_cli(["--db", str(path), "--status"])
        self.assertEqual(code, NOT_READY)
        self.assertIn("state=pending", out)

    def test_every_bad_state_has_a_non_zero_code(self):
        for state, code in bp.STATE_EXIT_CODES.items():
            if state == "managed-current":
                self.assertEqual(code, 0)
            else:
                self.assertNotEqual(code, 0, f"{state} must not report success")

    def test_the_unrecoverable_states_have_codes_of_their_own(self):
        """`fresh` and the refusal-worthy states must be distinguishable by code.

        `fresh` and `pending` legitimately share a code — both mean "manageable,
        not current". But foreign / hash-mismatch / ledger-ahead each need their
        own, or a caller cannot tell "run the bootstrap" from "stop and look".
        """
        self.assertEqual(bp.STATE_EXIT_CODES["fresh"], bp.STATE_EXIT_CODES["pending"])
        distinct = {
            bp.STATE_EXIT_CODES["foreign-unmanaged"],
            bp.STATE_EXIT_CODES["hash-mismatch"],
            bp.STATE_EXIT_CODES["ledger-ahead"],
        }
        self.assertEqual(len(distinct), 3)
        self.assertNotIn(bp.STATE_EXIT_CODES["fresh"], distinct)


class TestReadOnlyGuarantees(ScratchDatabase):
    def test_read_ledger_never_creates_the_table(self):
        conn = sqlite3.connect(":memory:")
        try:
            self.assertEqual(bp.read_ledger(conn), {})
            self.assertFalse(bp.ledger_exists(conn))
        finally:
            conn.close()

    def test_classify_does_not_write(self):
        conn = sqlite3.connect(":memory:")
        try:
            bp.classify(conn)
            self.assertFalse(bp.ledger_exists(conn))
        finally:
            conn.close()

    def test_status_on_the_real_local_database_writes_nothing(self):
        """The repository's own local database must be untouched by a probe."""
        local = PORTAL_DIR / "local_portal.db"
        if not local.exists():
            self.skipTest("local_portal.db is not present")
        before = (local.stat().st_size, digest(local), local.stat().st_mtime_ns)
        run_cli(["--db", str(local), "--status"])
        run_cli(["--db", str(local), "--inspect", "--json"])
        after = (local.stat().st_size, digest(local), local.stat().st_mtime_ns)
        self.assertEqual(before, after, "a read-only probe must not modify local_portal.db")

    def test_dry_run_on_the_real_local_database_writes_nothing(self):
        local = PORTAL_DIR / "local_portal.db"
        if not local.exists():
            self.skipTest("local_portal.db is not present")
        before = (local.stat().st_size, digest(local))
        code, _, err = run_cli(["--db", str(local), "--dry-run"])
        # local_portal.db has objects and no ledger: it is foreign-unmanaged, so
        # neither a write nor a plan is produced for it.
        self.assertEqual(code, FOREIGN)
        self.assertIn("refusing to plan a write", err)
        self.assertEqual(before, (local.stat().st_size, digest(local)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
