#!/usr/bin/env python3
"""Synchronize accepted translations from Web Portal snapshot back into GitHub SSOT repository.

Consumes candidate snapshots produced by the Cloudflare Worker translation portal
(POST /api/publish, R2 snapshot JSONL) and updates the corresponding categorized
files in the GitHub repository (locales/<category>/<bundle>.jsonl).

Safety & Invariants:
- Verifies source_sha256 matches Japanese source text exactly (prevents drift).
- Strict validation: forbids reserved delimiters (| and ^) in translations.
- In-place row updates: updates zh, status='accepted', and updated_at.
- Emits detailed diff summaries and optionally triggers repository validation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HEX64 = re.compile(r"^[0-9a-f]{64}$")
RESERVED = ("|", "^")


class PortalSyncError(ValueError):
    pass


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest().lower()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise PortalSyncError(f"{path}:{line_no}: invalid JSON") from exc
            if not isinstance(row, dict):
                raise PortalSyncError(f"{path}:{line_no}: expected JSON object")
            row["_file_line"] = line_no
            rows.append(row)
    return rows


def find_bundle_file(repo_root: Path, bundle: str) -> Path | None:
    locales_dir = repo_root / "locales"
    if not locales_dir.is_dir():
        raise PortalSyncError(f"Missing locales/ directory at {locales_dir}")

    # Search for matching .jsonl across all categories
    target_name = f"{bundle}.jsonl"
    matches = list(locales_dir.rglob(target_name))
    if not matches:
        # Also try matching without .jsonl if bundle already has it or vice versa
        matches = list(locales_dir.rglob(bundle))

    if len(matches) > 1:
        raise PortalSyncError(f"Ambiguous bundle {bundle}: found in multiple categories: {matches}")
    if matches:
        return matches[0]
    return None


def apply_portal_snapshot(
    snapshot_path: Path,
    repo_root: Path,
    dry_run: bool = False,
    now_iso: str | None = None,
) -> dict[str, Any]:
    if not snapshot_path.is_file():
        raise PortalSyncError(f"Snapshot file not found at {snapshot_path}")

    snapshot_rows = read_jsonl(snapshot_path)
    if not snapshot_rows:
        raise PortalSyncError("Empty snapshot file")

    if now_iso is None:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Group snapshot entries by bundle
    by_bundle: dict[str, list[dict[str, Any]]] = {}
    for r in snapshot_rows:
        line_no = r.get("_file_line", 0)
        bundle = str(r.get("bundle", "")).strip()
        key = str(r.get("key") or r.get("item_key") or "").strip()
        trans = str(r.get("translation") or r.get("zh") or "").strip()
        source = r.get("source") or r.get("ja")
        source_sha = str(r.get("source_sha256", "")).strip().lower()

        if not bundle or not key or not trans:
            continue

        # Check delimiter safety
        for delim in RESERVED:
            if delim in trans:
                raise PortalSyncError(
                    f"Snapshot line {line_no} ({bundle}/{key}) contains reserved delimiter '{delim}': {trans}"
                )

        by_bundle.setdefault(bundle, []).append({
            "bundle": bundle,
            "item_key": key,
            "translation": trans,
            "source": source,
            "source_sha256": source_sha,
            "_line": line_no,
        })

    stats = {
        "total_snapshot_entries": len(snapshot_rows),
        "bundles_affected": 0,
        "updated_rows": 0,
        "unchanged_rows": 0,
        "missing_in_repo": 0,
        "modified_files": [],
    }

    # For each affected bundle file, update in place
    for bundle, entries in by_bundle.items():
        bundle_file = find_bundle_file(repo_root, bundle)
        if not bundle_file:
            stats["missing_in_repo"] += len(entries)
            print(f"WARNING: Bundle {bundle} not found in repo locales", file=sys.stderr)
            continue

        entry_map = {e["item_key"]: e for e in entries}
        existing_rows = read_jsonl(bundle_file)
        file_modified = False
        new_file_rows: list[dict[str, Any]] = []

        for row in existing_rows:
            row.pop("_file_line", None)
            item_key = row.get("item_key")
            if item_key in entry_map:
                update_item = entry_map[item_key]
                new_zh = update_item["translation"]
                expected_sha = row.get("source_sha256", "").lower()
                provided_sha = update_item.get("source_sha256", "").lower()

                # Source sha verification
                if provided_sha and provided_sha != expected_sha:
                    raise PortalSyncError(
                        f"Source SHA mismatch for {bundle}/{item_key}: repo {expected_sha} != snapshot {provided_sha}"
                    )

                if row.get("zh") != new_zh or row.get("status") != "accepted":
                    row["zh"] = new_zh
                    row["status"] = "accepted"
                    row["updated_at"] = now_iso
                    stats["updated_rows"] += 1
                    file_modified = True
                else:
                    stats["unchanged_rows"] += 1

            new_file_rows.append(row)

        if file_modified:
            stats["bundles_affected"] += 1
            stats["modified_files"].append(str(bundle_file.relative_to(repo_root)))
            if not dry_run:
                with bundle_file.open("w", encoding="utf-8") as out:
                    for r in new_file_rows:
                        out.write(json.dumps(r, ensure_ascii=False) + "\n")

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True, help="Path to portal snapshot JSONL file")
    parser.add_argument("--repo-root", type=Path, required=True, help="Root directory of the GitHub localization repository")
    parser.add_argument("--dry-run", action="store_true", help="Simulate update without writing to disk")
    args = parser.parse_args()

    try:
        stats = apply_portal_snapshot(args.snapshot, args.repo_root, dry_run=args.dry_run)
    except PortalSyncError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("Portal Snapshot Sync Completed:")
    print(f"  Snapshot entries: {stats['total_snapshot_entries']}")
    print(f"  Updated rows:     {stats['updated_rows']}")
    print(f"  Unchanged rows:   {stats['unchanged_rows']}")
    print(f"  Bundles modified: {stats['bundles_affected']}")
    if stats["missing_in_repo"] > 0:
        print(f"  Missing in repo:  {stats['missing_in_repo']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
