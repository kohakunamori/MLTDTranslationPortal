import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.export_translation_portal_catalogue import ExportError, load_catalogue, sql_literal

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "export_translation_portal_catalogue.py"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def row(bundle: str, key: str, source: str) -> dict:
    return {"bundle": bundle, "key": key, "source": source, "source_sha256": digest(source)}


def test_sql_literal_escapes_quotes_for_plain_values() -> None:
    assert sql_literal("a'b") == "'a''b'"


def test_sql_literal_uses_flat_hex_cast_for_control_characters() -> None:
    # Regression: a '||' chain nests one expression level per line break and D1
    # rejects statements deeper than 100 levels ("Expression tree is too large
    # (maximum depth 100)"), which broke catalogue batches 10-13 on 2026-09-26.
    value = "\r\n".join(f"行{i}" for i in range(120)) + "\n"
    literal = sql_literal(value)
    assert literal.startswith("CAST(X'")
    assert literal.endswith("' AS TEXT)")
    assert "||" not in literal
    payload = bytes.fromhex(literal[len("CAST(X'") : -len("' AS TEXT)")])
    assert payload.decode("utf-8") == value


def test_load_catalogue_skips_reserved_separator_and_pins_version(tmp_path: Path) -> None:
    catalogue = tmp_path / "catalogue.jsonl"
    write_jsonl(catalogue, [row("b", "k1", "原文|中"), row("b", "k2", "原文")])
    rows, skipped = load_catalogue(catalogue, "9.0.200+1077500")
    assert skipped == 1
    assert rows == [
        {
            "base_version": "9.0.200+1077500",
            "bundle": "b",
            "item_key": "k2",
            "source_sha256": digest("原文"),
            "source": "原文",
        }
    ]


def test_load_catalogue_rejects_duplicate_identity(tmp_path: Path) -> None:
    catalogue = tmp_path / "catalogue.jsonl"
    write_jsonl(catalogue, [row("b", "k", "a"), row("b", "k", "b")])
    with pytest.raises(ExportError, match="duplicate bundle/key"):
        load_catalogue(catalogue, "v1")


def test_load_catalogue_rejects_stale_hash(tmp_path: Path) -> None:
    catalogue = tmp_path / "catalogue.jsonl"
    document = row("b", "k", "a")
    document["source_sha256"] = "0" * 64
    write_jsonl(catalogue, [document])
    with pytest.raises(ExportError, match="does not match source"):
        load_catalogue(catalogue, "v1")


def test_cli_writes_batches_and_manifest(tmp_path: Path) -> None:
    catalogue = tmp_path / "catalogue.jsonl"
    write_jsonl(catalogue, [row("b", "k1", "a"), row("b", "k2", "b\nc"), row("b", "k3", "d")])
    out_dir = tmp_path / "out"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--catalogue",
            str(catalogue),
            "--base-version",
            "v1",
            "--out-dir",
            str(out_dir),
            "--batch-rows",
            "2",
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    manifest = json.loads(result.stdout)
    assert manifest["rows"] == 3
    assert manifest["batch_count"] == 2
    assert manifest["skipped_reserved_separator"] == 0
    assert (out_dir / "catalogue-0001.sql").exists()
    assert (out_dir / "catalogue-0002.sql").exists()
    first_batch = (out_dir / "catalogue-0001.sql").read_text(encoding="utf-8")
    assert "CAST(X'" in first_batch
    assert "||" not in first_batch
    on_disk = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert on_disk["batches"][0]["rows"] == 2
    assert on_disk["batches"][1]["rows"] == 1
