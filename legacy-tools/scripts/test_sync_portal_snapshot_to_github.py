#!/usr/bin/env python3
"""Unit tests for scripts/sync_portal_snapshot_to_github.py."""
from __future__ import annotations

import json
from pathlib import Path
import pytest

from scripts.sync_portal_snapshot_to_github import (
    PortalSyncError,
    apply_portal_snapshot,
    find_bundle_file,
    sha256_text,
)


def create_mock_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo_root = tmp_path / "repo"
    story_dir = repo_root / "locales" / "story"
    story_dir.mkdir(parents=True)

    bundle_file = story_dir / "event_story_01.gtx.jsonl"
    ja1 = "プロデューサー、おはようございます！"
    ja2 = "今日のライブ、頑張りましょう！"

    rows = [
        {
            "base_version": "9.0.200+1077500",
            "bundle": "event_story_01.gtx",
            "item_key": "msg_01",
            "source_sha256": sha256_text(ja1),
            "ja": ja1,
            "zh": "",
            "status": "untranslated",
            "updated_at": "2026-09-27T00:00:00Z",
        },
        {
            "base_version": "9.0.200+1077500",
            "bundle": "event_story_01.gtx",
            "item_key": "msg_02",
            "source_sha256": sha256_text(ja2),
            "ja": ja2,
            "zh": "今天的演唱会，一起加油吧！",
            "status": "accepted",
            "updated_at": "2026-09-27T00:00:00Z",
        }
    ]
    with bundle_file.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    return repo_root, bundle_file


def test_find_bundle_file(tmp_path: Path):
    repo_root, bundle_file = create_mock_repo(tmp_path)
    found = find_bundle_file(repo_root, "event_story_01.gtx")
    assert found == bundle_file


def test_apply_portal_snapshot_success(tmp_path: Path):
    repo_root, bundle_file = create_mock_repo(tmp_path)
    snapshot_file = tmp_path / "snapshot.jsonl"

    ja1 = "プロデューサー、おはようございます！"
    snapshot_rows = [
        {
            "base_version": "9.0.200+1077500",
            "bundle": "event_story_01.gtx",
            "key": "msg_01",
            "source": ja1,
            "source_sha256": sha256_text(ja1),
            "translation": "制作人，早上好！",
            "status": "accepted",
        }
    ]
    snapshot_file.write_text(json.dumps(snapshot_rows[0], ensure_ascii=False) + "\n", encoding="utf-8")

    stats = apply_portal_snapshot(snapshot_file, repo_root, dry_run=False, now_iso="2026-09-27T12:00:00Z")
    assert stats["updated_rows"] == 1
    assert stats["bundles_affected"] == 1

    # Verify content in bundle file
    lines = [json.loads(line) for line in bundle_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 2
    assert lines[0]["item_key"] == "msg_01"
    assert lines[0]["zh"] == "制作人，早上好！"
    assert lines[0]["status"] == "accepted"
    assert lines[0]["updated_at"] == "2026-09-27T12:00:00Z"


def test_apply_portal_snapshot_delimiter_rejection(tmp_path: Path):
    repo_root, _ = create_mock_repo(tmp_path)
    snapshot_file = tmp_path / "snapshot.jsonl"

    ja1 = "プロデューサー、おはようございます！"
    snapshot_row = {
        "base_version": "9.0.200+1077500",
        "bundle": "event_story_01.gtx",
        "key": "msg_01",
        "source": ja1,
        "source_sha256": sha256_text(ja1),
        "translation": "制作人|早上好！",
        "status": "accepted",
    }
    snapshot_file.write_text(json.dumps(snapshot_row, ensure_ascii=False) + "\n", encoding="utf-8")

    with pytest.raises(PortalSyncError, match="reserved delimiter"):
        apply_portal_snapshot(snapshot_file, repo_root)


def test_apply_portal_snapshot_sha_mismatch(tmp_path: Path):
    repo_root, _ = create_mock_repo(tmp_path)
    snapshot_file = tmp_path / "snapshot.jsonl"

    snapshot_row = {
        "base_version": "9.0.200+1077500",
        "bundle": "event_story_01.gtx",
        "key": "msg_01",
        "source": "違う日本語",
        "source_sha256": "wrong_sha" * 7,
        "translation": "错误译文",
        "status": "accepted",
    }
    snapshot_file.write_text(json.dumps(snapshot_row, ensure_ascii=False) + "\n", encoding="utf-8")

    with pytest.raises(PortalSyncError, match="Source SHA mismatch"):
        apply_portal_snapshot(snapshot_file, repo_root)


def test_apply_portal_snapshot_dry_run(tmp_path: Path):
    repo_root, bundle_file = create_mock_repo(tmp_path)
    snapshot_file = tmp_path / "snapshot.jsonl"

    ja1 = "プロデューサー、おはようございます！"
    snapshot_row = {
        "base_version": "9.0.200+1077500",
        "bundle": "event_story_01.gtx",
        "key": "msg_01",
        "source": ja1,
        "source_sha256": sha256_text(ja1),
        "translation": "制作人，早上好！",
        "status": "accepted",
    }
    snapshot_file.write_text(json.dumps(snapshot_row, ensure_ascii=False) + "\n", encoding="utf-8")

    stats = apply_portal_snapshot(snapshot_file, repo_root, dry_run=True)
    assert stats["updated_rows"] == 1

    # Verify bundle file unchanged
    lines = [json.loads(line) for line in bundle_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert lines[0]["zh"] == ""
    assert lines[0]["status"] == "untranslated"
