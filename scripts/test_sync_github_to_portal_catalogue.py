#!/usr/bin/env python3
"""Unit tests for scripts/sync_github_to_portal_catalogue.py."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import pytest

from scripts.sync_github_to_portal_catalogue import (
    SyncExportError,
    deterministic_id,
    export_sync_sql,
    read_locales,
    render_contributions_sql,
    sha256_text,
    sql_literal,
)


def test_sql_literal_control_characters():
    assert sql_literal("simple text") == "'simple text'"
    assert sql_literal("text with 'quotes'") == "'text with ''quotes'''"
    # Newline must trigger CAST(X'...' AS TEXT) to avoid D1 depth > 100 limit
    res = sql_literal("line1\nline2")
    assert res.startswith("CAST(X'")
    assert res.endswith("' AS TEXT)")


def test_deterministic_id():
    id1 = deterministic_id("9.0.200", "story_01", "msg_01", "sha_abc")
    id2 = deterministic_id("9.0.200", "story_01", "msg_01", "sha_abc")
    id3 = deterministic_id("9.0.200", "story_01", "msg_02", "sha_abc")
    assert id1 == id2
    assert id1 != id3
    assert len(id1) == 32


def test_read_locales_and_verification(tmp_path: Path):
    locales_dir = tmp_path / "locales" / "story"
    locales_dir.mkdir(parents=True)
    jsonl_file = locales_dir / "story_01.jsonl"

    ja_text = "こんにちは"
    ja_sha = sha256_text(ja_text)

    rows = [
        {
            "asset_version": "1077100",
            "bundle": "story_01.unity3d",
            "item_key": "msg_01",
            "source_sha256": ja_sha,
            "ja": ja_text,
            "zh": "你好",
            "status": "accepted",
            "updated_at": "2026-09-27T00:00:00Z",
        },
        {
            "asset_version": "1077100",
            "bundle": "story_01.unity3d",
            "item_key": "msg_02",
            "source_sha256": sha256_text("未翻訳"),
            "ja": "未翻訳",
            "zh": "",
            "status": "untranslated",
            "updated_at": "2026-09-27T00:00:00Z",
        }
    ]
    with jsonl_file.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    res = read_locales(tmp_path, {"accepted"})
    assert len(res) == 1
    assert res[0]["item_key"] == "msg_01"
    assert res[0]["translation"] == "你好"


def test_read_locales_hash_mismatch(tmp_path: Path):
    locales_dir = tmp_path / "locales" / "story"
    locales_dir.mkdir(parents=True)
    jsonl_file = locales_dir / "story_01.jsonl"

    row = {
        "asset_version": "1077100",
        "bundle": "story_01.unity3d",
        "item_key": "msg_01",
        "source_sha256": "bad_sha" * 8,
        "ja": "こんにちは",
        "zh": "你好",
        "status": "accepted",
        "updated_at": "2026-09-27T00:00:00Z",
    }
    jsonl_file.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")

    with pytest.raises(SyncExportError, match="source hash mismatch"):
        read_locales(tmp_path, {"accepted"})


def test_read_locales_reserved_delimiter_rejection(tmp_path: Path):
    locales_dir = tmp_path / "locales" / "story"
    locales_dir.mkdir(parents=True)
    jsonl_file = locales_dir / "story_01.jsonl"

    ja_text = "こんにちは"
    row = {
        "asset_version": "1077100",
        "bundle": "story_01.unity3d",
        "item_key": "msg_01",
        "source_sha256": sha256_text(ja_text),
        "ja": ja_text,
        "zh": "你好|世界",
        "status": "accepted",
        "updated_at": "2026-09-27T00:00:00Z",
    }
    jsonl_file.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")

    with pytest.raises(SyncExportError, match="illegal delimiter"):
        read_locales(tmp_path, {"accepted"})


def test_export_sync_sql_end_to_end(tmp_path: Path):
    repo_root = tmp_path / "repo"
    out_dir = tmp_path / "sql_out"
    locales_dir = repo_root / "locales" / "card"
    locales_dir.mkdir(parents=True)

    ja_text = "カード台詞"
    row = {
        "asset_version": "1077100",
        "bundle": "card_01.unity3d",
        "item_key": "card_msg",
        "source_sha256": sha256_text(ja_text),
        "ja": ja_text,
        "zh": "卡片台词",
        "status": "accepted",
        "updated_at": "2026-09-27T00:00:00Z",
    }
    (locales_dir / "card_01.jsonl").write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")

    summary = export_sync_sql(repo_root, out_dir, batch_size=2)
    assert summary["total_rows"] == 1
    assert summary["batch_count"] == 1

    sql_file = out_dir / "contributions-batch-0001.sql"
    assert sql_file.is_file()
    sql_text = sql_file.read_text(encoding="utf-8")
    assert "INSERT INTO contributions" in sql_text
    assert "卡片台词" in sql_text

    manifest_file = out_dir / "manifest.json"
    assert manifest_file.is_file()


def test_composite_base_version_is_rejected(tmp_path: Path):
    """A pre-decoupling entry must fail the sync, not be carried into D1."""
    locales_dir = tmp_path / "locales" / "story"
    locales_dir.mkdir(parents=True)
    ja_text = "本領発揮"
    row = {
        "base_version": "9.0.200+1077100",
        "bundle": "story_01.unity3d",
        "item_key": "msg_01",
        "source_sha256": sha256_text(ja_text),
        "ja": ja_text,
        "zh": "大显身手",
        "status": "accepted",
        "updated_at": "2026-09-27T00:00:00Z",
    }
    (locales_dir / "story_01.jsonl").write_text(
        json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    with pytest.raises(SyncExportError, match="composite versions"):
        read_locales(tmp_path, {"accepted"})


def test_asset_version_wins_over_absent_base_version(tmp_path: Path):
    """The decoupled field is the identity when present."""
    locales_dir = tmp_path / "locales" / "card"
    locales_dir.mkdir(parents=True)
    ja_text = "カード台詞"
    row = {
        "channel": "assets",
        "asset_version": "1077100",
        "client_version": None,
        "source_client_version": "9.0.200",
        "bundle": "card_01.unity3d",
        "item_key": "card_msg",
        "source_sha256": sha256_text(ja_text),
        "ja": ja_text,
        "zh": "卡片台词",
        "status": "accepted",
        "updated_at": "2026-09-27T00:00:00Z",
    }
    (locales_dir / "card_01.jsonl").write_text(
        json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    rows = read_locales(tmp_path, {"accepted"})
    assert len(rows) == 1
    assert rows[0]["base_version"] == "1077100"
