#!/usr/bin/env python3
"""Export a source-catalogue JSONL into batched D1 SQL seed files.

Candidate-only: this command writes only its --out-dir. It does not contact
D1, R2, NAS, the production translation queues, or any device.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

HEX64 = re.compile(r"^[0-9a-f]{64}$")
RESERVED = ("|", "^")


class ExportError(ValueError):
    pass


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[tuple[int, dict[str, Any]]]:
    rows: list[tuple[int, dict[str, Any]]] = []
    with path.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ExportError(f"{path}:{line_number}: invalid JSON") from exc
            if not isinstance(row, dict):
                raise ExportError(f"{path}:{line_number}: expected JSON object")
            rows.append((line_number, row))
    if not rows:
        raise ExportError(f"{path}: no rows")
    return rows


def field(row: dict[str, Any], name: str, line_number: int) -> str:
    value = row.get(name)
    if not isinstance(value, str) or not value:
        raise ExportError(f"line {line_number}: missing or empty {name}")
    return value


def sql_literal(value: str) -> str:
    """Return a single SQLite string expression for ``value``.

    Control characters (newlines included) are emitted through a hex blob cast
    instead of a ``'a'||char(10)||'b'`` chain: D1 rejects statements whose
    expression tree nests deeper than 100 levels, and catalogue rows with many
    line breaks used to exceed that limit (SQLITE_ERROR "Expression tree is too
    large (maximum depth 100)").
    """
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        return f"CAST(X'{value.encode('utf-8').hex()}' AS TEXT)"
    return "'" + value.replace("'", "''") + "'"


def render_insert(row: dict[str, str], created_at: str) -> str:
    return (
        "INSERT INTO source_catalogue "
        "(base_version,bundle,item_key,source_sha256,source,created_at) VALUES ("
        f"{sql_literal(row['base_version'])},{sql_literal(row['bundle'])},"
        f"{sql_literal(row['item_key'])},{sql_literal(row['source_sha256'])},"
        f"{sql_literal(row['source'])},{sql_literal(created_at)}) "
        "ON CONFLICT(base_version,bundle,item_key) DO UPDATE SET "
        "source_sha256=excluded.source_sha256,source=excluded.source,created_at=excluded.created_at;"
    )


def load_catalogue(path: Path, base_version: str) -> tuple[list[dict[str, str]], int]:
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    skipped = 0
    for line_number, raw in read_jsonl(path):
        bundle = field(raw, "bundle", line_number)
        key = field(raw, "key", line_number)
        source = field(raw, "source", line_number)
        source_sha = str(raw.get("source_sha256") or sha256_text(source)).lower()
        if not HEX64.fullmatch(source_sha):
            raise ExportError(f"line {line_number}: source_sha256 is not a SHA-256 hex digest")
        if source_sha != sha256_text(source):
            raise ExportError(f"line {line_number}: source_sha256 does not match source")
        if any(token in source for token in RESERVED):
            skipped += 1
            continue
        identity = (bundle, key)
        if identity in seen:
            raise ExportError(f"line {line_number}: duplicate bundle/key {bundle}/{key}")
        seen.add(identity)
        rows.append(
            {
                "base_version": base_version,
                "bundle": bundle,
                "item_key": key,
                "source_sha256": source_sha,
                "source": source,
            }
        )
    if not rows:
        raise ExportError(f"{path}: no exportable rows after reserved-separator filtering")
    return rows, skipped


def write_batches(rows: list[dict[str, str]], out_dir: Path, batch_rows: int, created_at: str) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    batches: list[dict[str, Any]] = []
    for index in range(0, len(rows), batch_rows):
        batch = rows[index : index + batch_rows]
        path = out_dir / f"catalogue-{index // batch_rows + 1:04d}.sql"
        path.write_text("\n".join(render_insert(row, created_at) for row in batch) + "\n", encoding="utf-8")
        batches.append({"path": path.name, "rows": len(batch), "sha256": sha256_file(path)})
    manifest = {
        "schema_version": 1,
        "kind": "mltd-translation-portal-catalogue-export",
        "base_version": rows[0]["base_version"],
        "rows": len(rows),
        "batch_rows": batch_rows,
        "batch_count": len(batches),
        "created_at": created_at,
        "batches": batches,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue", required=True, type=Path, help="Source-catalogue JSONL")
    parser.add_argument("--base-version", required=True, help="Opaque portal base_version to pin every row to")
    parser.add_argument("--out-dir", required=True, type=Path, help="Directory for generated SQL batches and manifest")
    parser.add_argument("--batch-rows", type=int, default=5000, help="Rows per SQL file (default: 5000)")
    parser.add_argument("--created-at", default="2026-09-26T00:00:00Z", help="created_at value written to every row")
    parser.add_argument("--json", action="store_true", help="Print the manifest as JSON")
    args = parser.parse_args(argv)
    if args.batch_rows < 1:
        parser.error("--batch-rows must be positive")
    if not args.created_at.strip():
        parser.error("--created-at must not be empty")
    rows, skipped = load_catalogue(args.catalogue, args.base_version)
    manifest = write_batches(rows, args.out_dir, args.batch_rows, args.created_at)
    manifest.update(
        {
            "source": str(args.catalogue),
            "source_sha256": sha256_file(args.catalogue),
            "skipped_reserved_separator": skipped,
            "out_dir": str(args.out_dir),
        }
    )
    if args.json:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
    else:
        print(
            f"{manifest['rows']} rows -> {manifest['batch_count']} batch(es), "
            f"skipped {skipped} reserved-separator row(s) in {args.out_dir}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
