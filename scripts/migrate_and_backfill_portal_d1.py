#!/usr/bin/env python3
"""Import real manifests into the portal D1 schema (migration + backfill).

What this replaces
------------------
The previous version of this script backfilled D1 from the portal's *runtime
snapshot files* (``src/hot_catalogue.js``, ``public/data/lyrics/*.json``,
``public/data/image_tasks.json``) and seeded hard-coded releases with
placeholder hashes. Both are gone. The runtime snapshots were never release
truth, and the seeds made an unverified release look canonical.

This importer reads only trusted, source-bound inputs:

* ``--assets-release``  : an ``assets-release`` manifest (assets side axis)
* ``--client-release-input`` : a ``client-release-input`` manifest (client axis)
* ``--locales-dir``     : a GitHub export checkout (``locales/**/*.jsonl``)
* ``--lyrics-dir``      : the same checkout's ``lyrics/`` (songs + manifest)
* ``--images-manifest`` : ``images.manifest.json`` from that checkout
* ``--image-tasks-manifest`` : the D1 import manifest produced by
  ``web/translation-portal/scripts/generate_image_tasks_index.py``

Cross-version reuse is routed through ``localization.cross_version_reuse`` so
that every release_resource_ref carries one of exact / verified-compatible /
suggested / blocked, with ``reused_from_release_id`` naming the real source
release.

Schema management is delegated to ``bootstrap_portal_d1.py`` (owned by the
portal worker slice): this script never keeps a second migration ledger.

Refusals (fail-closed, no silent downgrade):

* a composite version such as ``9.0.200+1077500`` appearing where a single axis
  is required (the export files carry it as ``base_version``; the importer
  derives the asset cohort from the declared release, never from the composite);
* an unregistered/unverified ``asset_version`` in a release manifest;
* a client release manifest that carries ``asset_version``;
* any manifest whose declared ``release_id``/``client_version`` disagrees with
  the row it would write.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

PORTAL_DIR = ROOT_DIR / "web" / "translation-portal"
PORTAL_SCRIPTS = PORTAL_DIR / "scripts"
if str(PORTAL_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(PORTAL_SCRIPTS))

from localization.cross_version_reuse import (  # noqa: E402
    CrossVersionReuseEngine,
    ReuseStatus,
    ResourceKind,
    TranslationRecord,
    sha256_text,
)
from scripts.validate_release_models import (  # noqa: E402
    ReleaseModelValidationError,
    validate_assets_manifest,
    validate_client_manifest,
)

DEFAULT_PORTAL_DB = PORTAL_DIR / "local_portal.db"
DEFAULT_REPORT = (
    ROOT_DIR / "build" / "runs" / "text-localization" / "9.0.200"
    / "portal-decouple-backfill-20260928" / "migration-report.json"
)
COMPOSITE_DELIMITER = "+"
UNSUPPORTED_RESOURCE_KINDS = {"video"}


class ImportRefused(RuntimeError):
    """Raised instead of silently importing something unverifiable."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest().lower()


def read_json(path: Path) -> Dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ImportRefused(f"expected a JSON object: {path}")
    return value


def classify_bundle(bundle: str) -> str:
    lowered = bundle.lower()
    if lowered.startswith("scrobj_") or "lyric" in lowered:
        return "lyrics"
    if lowered.endswith(".unity3d"):
        return "unity3d"
    return "text"


def host_kind(bundle: str) -> str:
    """Which release axis a resource belongs to, by surface."""
    return "unity3d" if bundle.lower().endswith(".unity3d") else "text"


def release_id_for(kind: str, version: str) -> str:
    """Stable, single-axis release id. Never a composite of both axes."""
    if COMPOSITE_DELIMITER in version:
        raise ImportRefused(
            f"composite release identity is forbidden: {version!r}"
        )
    return f"{kind}-{version}"


def normalise_sha(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip().lower()
    return text or None


class PortalImporter:
    def __init__(self, connection: sqlite3.Connection, registry: Optional[Dict[str, Any]] = None):
        self.conn = connection
        self.conn.row_factory = sqlite3.Row
        self.engine = CrossVersionReuseEngine()
        # None means "load configs/registered-assets-releases.json". Tests pass
        # an explicit test-only registry; production never does.
        self.registry = registry
        self.report: Dict[str, Any] = {
            "schema_version": 1,
            "kind": "mltd-portal-d1-import-report",
            "inputs": {},
            "releases": {},
            "counts_before": {},
            "counts_after": {},
            "identity": {},
            "reuse": {
                "exact": 0, "verified-compatible": 0, "suggested": 0, "blocked": 0, "none": 0,
            },
            "reuse_engine_seeded_from_db": 0,
            "anomalies": {
                "source_hash_conflicts": [],
                "orphan_refs": [],
                "duplicate_logical_keys": [],
                "unsupported_resource_kinds": [],
            },
            "summaries": {},
        }

    # ------------------------------------------------------------------
    # bookkeeping
    # ------------------------------------------------------------------
    def table_counts(self, tables: Optional[Iterable[str]] = None) -> Dict[str, int]:
        names = tables or [
            row["name"] for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        counts: Dict[str, int] = {}
        for name in names:
            try:
                counts[name] = int(self.conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0])
            except sqlite3.OperationalError:
                continue
        return counts

    def record_input(self, label: str, path: Optional[Path]) -> None:
        if path is None:
            self.report["inputs"][label] = None
            return
        if not path.exists():
            raise ImportRefused(f"{label} does not exist: {path}")
        self.report["inputs"][label] = {
            "path": str(path.resolve()),
            "sha256": sha256_file(path) if path.is_file() else None,
        }

    # ------------------------------------------------------------------
    # releases
    # ------------------------------------------------------------------
    def ensure_assets_release(self, manifest: Dict[str, Any]) -> Dict[str, Any]:
        try:
            validate_assets_manifest(manifest, registry=self.registry, allow_unverified=False)
        except ReleaseModelValidationError as exc:
            raise ImportRefused(f"assets release manifest refused: {exc}") from exc
        asset_version = str(manifest["asset_version"])
        release_id = f"assets-{asset_version}"
        status = str(manifest.get("status") or "canonical")
        if status not in ("canonical", "staging", "unverified", "superseded"):
            raise ImportRefused(f"unknown assets release status: {status!r}")
        timestamp = str(manifest.get("published_at") or manifest.get("created_at") or "")
        if not timestamp:
            raise ImportRefused("assets release manifest needs published_at or created_at")
        self.conn.execute(
            """
            INSERT INTO assets_releases (
                asset_version, release_id, server_schema_version, status,
                source_manifest_sha256, assets_commit, note, created_at, updated_at, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asset_version) DO UPDATE SET
                release_id=excluded.release_id,
                server_schema_version=excluded.server_schema_version,
                status=excluded.status,
                source_manifest_sha256=excluded.source_manifest_sha256,
                assets_commit=excluded.assets_commit,
                note=excluded.note,
                updated_at=excluded.updated_at,
                published_at=excluded.published_at
            """,
            (
                asset_version, release_id, str(manifest["server_schema_version"]), status,
                str(manifest["source_manifest_sha256"]).lower(),
                str(manifest["assets_commit"]).lower(),
                str(manifest.get("note") or ""),
                timestamp, timestamp,
                timestamp if status == "canonical" else None,
            ),
        )
        self.report["releases"]["assets"] = {
            "asset_version": asset_version, "release_id": release_id, "status": status,
        }
        return {"release_kind": "assets", "release_id": release_id, "version": asset_version}

    def ensure_client_release(self, manifest: Dict[str, Any]) -> Dict[str, Any]:
        try:
            validate_client_manifest(manifest)
        except ReleaseModelValidationError as exc:
            raise ImportRefused(f"client release manifest refused: {exc}") from exc
        if "asset_version" in manifest:
            raise ImportRefused("client release manifest must not carry asset_version")
        client_version = str(manifest["client_version"])
        release_id = f"client-{client_version}-{manifest['abi']}"
        if str(manifest.get("release_id") or release_id) != release_id:
            raise ImportRefused("client release manifest release_id does not match its version/ABI")
        status = str(manifest.get("release_status") or "candidate")
        if status not in ("draft", "candidate", "published", "superseded", "failed"):
            raise ImportRefused(f"unknown client release status: {status!r}")
        timestamp = str(manifest.get("built_at") or manifest.get("created_at") or "")
        if not timestamp:
            raise ImportRefused("client release manifest needs built_at or created_at")
        self.conn.execute(
            """
            INSERT INTO client_releases (
                release_id, client_version, abi, base_apk_sha256, client_resources_commit,
                manifest_sha256, output_apk_sha256, release_url, status, created_at, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(release_id) DO UPDATE SET
                client_version=excluded.client_version,
                abi=excluded.abi,
                base_apk_sha256=excluded.base_apk_sha256,
                client_resources_commit=excluded.client_resources_commit,
                manifest_sha256=excluded.manifest_sha256,
                output_apk_sha256=excluded.output_apk_sha256,
                release_url=excluded.release_url,
                status=excluded.status
            """,
            (
                release_id, client_version, str(manifest["abi"]),
                str(manifest["base_apk_sha256"]).lower(),
                str(manifest["client_resources_commit"]).lower(),
                normalise_sha(manifest.get("patch_manifest_sha256")),
                normalise_sha(manifest.get("output_apk_sha256")),
                manifest.get("release_url"),
                status, timestamp,
                timestamp if status == "published" else None,
            ),
        )
        self.report["releases"]["client"] = {
            "client_version": client_version, "release_id": release_id, "status": status,
        }
        return {"release_kind": "client", "release_id": release_id, "version": client_version}

    # ------------------------------------------------------------------
    # resource units / variants / refs
    # ------------------------------------------------------------------
    def upsert_unit(self, logical_key: str, resource_kind: str, category: str,
                    timestamp: str) -> str:
        if resource_kind in UNSUPPORTED_RESOURCE_KINDS:
            raise ImportRefused(f"unsupported resource kind: {resource_kind}")
        row = self.conn.execute(
            "SELECT resource_id, resource_kind FROM resource_units WHERE logical_key=?",
            (logical_key,),
        ).fetchone()
        if row is not None:
            if row["resource_kind"] != resource_kind:
                self.report["anomalies"]["duplicate_logical_keys"].append({
                    "logical_key": logical_key,
                    "existing_kind": row["resource_kind"],
                    "incoming_kind": resource_kind,
                })
                raise ImportRefused(
                    f"logical_key {logical_key!r} already exists as {row['resource_kind']!r}"
                )
            return row["resource_id"]
        resource_id = f"res_{hashlib.sha256(logical_key.encode('utf-8')).hexdigest()[:16]}"
        self.conn.execute(
            "INSERT INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (resource_id, resource_kind, logical_key, category, timestamp),
        )
        return resource_id

    def upsert_variant(self, resource_id: str, release: Dict[str, Any], bundle: str,
                       item_key: str, source_sha256: str, source: str, timestamp: str) -> str:
        seed = f"{release['release_kind']}:{release['release_id']}:{bundle}:{item_key}"
        variant_id = f"var_{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16]}"
        self.conn.execute(
            """
            INSERT INTO source_variants (
                source_variant_id, resource_id, release_kind, release_id,
                source_sha256, source, bundle, item_key, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_variant_id) DO UPDATE SET
                resource_id=excluded.resource_id,
                source_sha256=excluded.source_sha256,
                source=excluded.source,
                created_at=excluded.created_at
            """,
            (
                variant_id, resource_id, release["release_kind"], release["release_id"],
                source_sha256, source, bundle, item_key, timestamp,
            ),
        )
        return variant_id

    def upsert_translation(self, logical_key: str, resource_kind: str, source_sha256: str,
                           translation: str, status: str, timestamp: str,
                           contributor: str = "import@mltd-local.INVALID") -> str:
        translation_id = f"tu_{hashlib.sha256(f'{logical_key}:{resource_kind}:{source_sha256}'.encode('utf-8')).hexdigest()[:24]}"
        self.conn.execute(
            """
            INSERT INTO translation_units (
                translation_id, logical_key, resource_kind, locale, source_sha256,
                translation, status, contributor_email, reviewer_email, created_at, updated_at
            ) VALUES (?, ?, ?, 'zh-CN', ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(logical_key, resource_kind, locale, source_sha256) DO UPDATE SET
                translation=excluded.translation,
                status=excluded.status,
                updated_at=excluded.updated_at
            """,
            (
                translation_id, logical_key, resource_kind, source_sha256,
                translation, status, contributor, timestamp, timestamp,
            ),
        )
        row = self.conn.execute(
            "SELECT translation_id FROM translation_units "
            "WHERE logical_key=? AND resource_kind=? AND locale='zh-CN' AND source_sha256=?",
            (logical_key, resource_kind, source_sha256),
        ).fetchone()
        return row["translation_id"]

    def bind_ref(self, release: Dict[str, Any], variant_id: str, translation_id: Optional[str],
                 reuse_mode: str, status: str, reused_from_release_id: Optional[str],
                 timestamp: str) -> None:
        seed = f"{release['release_kind']}:{release['release_id']}:{variant_id}"
        ref_id = f"ref_{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:24]}"
        self.conn.execute(
            """
            INSERT INTO release_resource_refs (
                id, release_kind, release_id, source_variant_id, translation_id,
                reuse_mode, reused_from_release_id, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(release_kind, release_id, source_variant_id) DO UPDATE SET
                translation_id=excluded.translation_id,
                reuse_mode=excluded.reuse_mode,
                reused_from_release_id=excluded.reused_from_release_id,
                status=excluded.status,
                updated_at=excluded.updated_at
            """,
            (
                ref_id, release["release_kind"], release["release_id"], variant_id,
                translation_id, reuse_mode, reused_from_release_id, status,
                timestamp, timestamp,
            ),
        )

    def evaluate_reuse(self, logical_key: str, resource_kind: str, source_text: str,
                       source_sha256: str, target_release: Dict[str, Any],
                       translation: Optional[str], status: str,
                       timestamp: str) -> Tuple[str, Optional[str], Optional[str]]:
        """Decide the reuse mode for one variant, then register it.

        The engine is consulted *before* this row is registered, so a hit can
        only come from a previously imported release. Two shapes of row:

        * the row carries its own translation — it is new content for this
          release. Reuse is ``exact``/``verified-compatible`` when an earlier
          release already supplied the same (logical_key, source_sha256);
          otherwise the mode is ``none``. Never ``blocked``: there is nothing
          to reuse *from*, which is not the same as a proven incompatibility.
        * the row has no translation — then a hit is real reuse (exact /
          verified-compatible), a similar-but-changed source is ``suggested``
          (display only, never accepted), and everything else is ``blocked``.

        Returns ``(reuse_mode, translation_id, reused_from_release_id)``.
        """
        decision = self.engine.evaluate_text_reuse(logical_key, source_text, source_sha256)
        engine_mode = decision.status.value
        reuse_record = decision.reuse_record or {}
        reused_from = (reuse_record.get("metadata") or {}).get("release_id")
        translation_id: Optional[str] = None

        if reused_from == target_release["release_id"]:
            # A hit that points back at *this* release is a re-import of the same
            # content, not cross-release reuse. Reporting it as `exact` with
            # `reused_from_release_id` = itself would tell a reader that these
            # rows were inherited from another release, which is false, and it
            # would also make a second import of one release disagree with the
            # first. Fall back to what a fresh import would have decided.
            engine_mode = "none" if translation else ReuseStatus.BLOCKED.value
            reuse_record = {}
            reused_from = None

        if translation:
            # Own translation wins; it is accepted content for this release.
            translation_id = self.upsert_translation(
                logical_key, resource_kind, source_sha256, str(translation), "accepted", timestamp,
            )
            mode = engine_mode if engine_mode in (
                ReuseStatus.EXACT.value, ReuseStatus.VERIFIED_COMPATIBLE.value,
            ) else "none"
            if mode == "none":
                reused_from = None
        else:
            mode = engine_mode
            if mode in (ReuseStatus.EXACT.value, ReuseStatus.VERIFIED_COMPATIBLE.value):
                reused_text = reuse_record.get("localized_text")
                if reused_text:
                    translation_id = self.upsert_translation(
                        logical_key, resource_kind, source_sha256, str(reused_text),
                        "accepted", timestamp,
                    )
            elif mode == ReuseStatus.SUGGESTED.value:
                # Suggestions are display-only: stored as 'suggested' and never
                # counted as accepted.
                suggestion = reuse_record.get("localized_text")
                if suggestion:
                    translation_id = self.upsert_translation(
                        logical_key, resource_kind, source_sha256, str(suggestion),
                        "suggested", timestamp,
                    )
            else:  # BLOCKED
                translation_id = None
                reused_from = None

        self.report["reuse"][mode] = self.report["reuse"].get(mode, 0) + 1
        # Register this unit so later releases can find it.
        self.engine.register_translation(TranslationRecord(
            logical_key=logical_key,
            resource_kind=resource_kind,
            locale="zh-CN",
            source_sha256=source_sha256,
            localized_text=str(translation) if translation else None,
            status=status,
            metadata={"source_text": source_text, "release_id": target_release["release_id"]},
        ))
        return mode, translation_id, reused_from

    # ------------------------------------------------------------------
    # reuse engine seeding
    # ------------------------------------------------------------------
    def seed_reuse_engine_from_db(self) -> int:
        """Load accepted units already in the database into the reuse engine.

        Reuse must work across import *runs*, not just within one process: a
        second release imported later (or by a different invocation) has to find
        the first release's accepted translations. Reading them back from
        `translation_units` joined to its release binding is what makes
        ``reused_from_release_id`` a real release id instead of an in-memory
        convention.
        """
        rows = self.conn.execute(
            """
            SELECT tu.logical_key, tu.resource_kind, tu.source_sha256, tu.translation,
                   sv.source AS source_text, rrr.release_id AS release_id
            FROM translation_units tu
            JOIN release_resource_refs rrr ON rrr.translation_id = tu.translation_id
            JOIN source_variants sv ON sv.source_variant_id = rrr.source_variant_id
            WHERE tu.status = 'accepted'
            """
        ).fetchall()
        seen: set[Tuple[str, str, str]] = set()
        seeded = 0
        for row in rows:
            identity = (row["resource_kind"], row["logical_key"], row["source_sha256"])
            if identity in seen:
                continue
            seen.add(identity)
            self.engine.register_translation(TranslationRecord(
                logical_key=row["logical_key"],
                resource_kind=row["resource_kind"],
                locale="zh-CN",
                source_sha256=row["source_sha256"],
                localized_text=row["translation"],
                status="accepted",
                metadata={"source_text": row["source_text"] or "", "release_id": row["release_id"]},
            ))
            seeded += 1
        return seeded

    def ensure_reuse_seeded(self) -> None:
        if not getattr(self, "_reuse_seeded", False):
            self.report["reuse_engine_seeded_from_db"] = self.seed_reuse_engine_from_db()
            self._reuse_seeded = True

    # ------------------------------------------------------------------
    # import drivers
    # ------------------------------------------------------------------
    def import_locales(self, locales_dir: Path, release: Dict[str, Any], timestamp: str,
                       limit: Optional[int] = None) -> int:
        self.ensure_reuse_seeded()
        imported = 0
        # The argument names a GitHub export checkout, but the same checkout
        # also carries lyrics/**. Scope the walk to locales/ so a lyrics row
        # can never be parsed as a locale row; when the caller points straight
        # at a locales directory, use it as given.
        locales_root = locales_dir / "locales" if (locales_dir / "locales").is_dir() else locales_dir
        for jsonl_path in sorted(locales_root.rglob("*.jsonl")):
            with jsonl_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    base_version = str(row.get("base_version") or "")
                    if COMPOSITE_DELIMITER in base_version:
                        # Composite identity in the export is provenance only.
                        # The single-axis release comes from the release manifest.
                        pass
                    for key in ("bundle", "item_key", "ja", "source_sha256"):
                        if key not in row:
                            raise ImportRefused(
                                f"locale row in {jsonl_path.name} lacks required field {key!r}"
                            )
                    bundle = str(row["bundle"])
                    item_key = str(row["item_key"])
                    source_text = str(row["ja"])
                    source_sha256 = str(row["source_sha256"]).lower()
                    if source_sha256 != sha256_text(source_text):
                        raise ImportRefused(
                            f"locale row source hash mismatch in {jsonl_path.name}: {item_key}"
                        )
                    translation = str(row.get("zh") or "") or None
                    status = str(row.get("status") or "untranslated")
                    kind = host_kind(bundle)
                    logical_key = f"{classify_bundle(bundle)}/{bundle.rsplit('.', 1)[0]}/{item_key}"
                    resource_id = self.upsert_unit(logical_key, kind, classify_bundle(bundle), timestamp)
                    variant_id = self.upsert_variant(
                        resource_id, release, bundle, item_key, source_sha256, source_text, timestamp,
                    )
                    mode, translation_id, reused_from = self.evaluate_reuse(
                        logical_key, kind, source_text, source_sha256, release,
                        translation, status, timestamp,
                    )
                    self.bind_ref(release, variant_id, translation_id, mode, status,
                                  reused_from, timestamp)
                    imported += 1
                    if limit and imported >= limit:
                        return imported
        return imported

    def import_lyrics(self, lyrics_dir: Path, release: Dict[str, Any], timestamp: str,
                      limit: Optional[int] = None) -> int:
        self.ensure_reuse_seeded()
        imported = 0
        # Accept either the GitHub export checkout root (…/lyrics/songs/*.jsonl)
        # or the lyrics directory itself; never silently import zero rows just
        # because the caller passed the more natural checkout path.
        lyrics_root = lyrics_dir / "lyrics" if (lyrics_dir / "lyrics").is_dir() else lyrics_dir
        songs_dir = lyrics_root / "songs"
        if not songs_dir.is_dir():
            raise ImportRefused(
                f"--lyrics-dir names no songs directory: {songs_dir} does not exist"
            )
        files = sorted(songs_dir.glob("*.jsonl"))
        for jsonl_path in files:
            bundle = jsonl_path.stem
            with jsonl_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    index = row.get("index")
                    if index in (None, ""):
                        raise ImportRefused(
                            f"lyrics row in {jsonl_path.name} lacks a numeric index"
                        )
                    index = str(index)
                    if "ja" not in row or "source_sha256" not in row:
                        raise ImportRefused(
                            f"lyrics row in {jsonl_path.name} lacks ja/source_sha256"
                        )
                    source_text = str(row["ja"])
                    source_sha256 = str(row["source_sha256"]).lower()
                    if source_sha256 != sha256_text(source_text):
                        raise ImportRefused(
                            f"lyrics source hash mismatch in {jsonl_path.name}: index {index}"
                        )
                    translation = str(row.get("zh") or "") or None
                    status = str(row.get("status") or "untranslated")
                    logical_key = f"lyrics/{bundle}/{index}"
                    resource_id = self.upsert_unit(logical_key, "lyrics", "lyrics", timestamp)
                    variant_id = self.upsert_variant(
                        resource_id, release, bundle, index, source_sha256, source_text, timestamp,
                    )
                    mode, translation_id, reused_from = self.evaluate_reuse(
                        logical_key, "lyrics", source_text, source_sha256, release,
                        translation, status, timestamp,
                    )
                    self.bind_ref(release, variant_id, translation_id, mode, status,
                                  reused_from, timestamp)
                    imported += 1
                    if limit and imported >= limit:
                        return imported
        return imported

    def import_image_tasks(self, manifest_path: Path, timestamp: str,
                           limit: Optional[int] = None) -> int:
        manifest = read_json(manifest_path)
        if manifest.get("kind") != "mltd-portal-image-task-import":
            raise ImportRefused("image task manifest is not an mltd-portal-image-task-import document")
        if manifest.get("import_target") != "d1:image_task_units":
            raise ImportRefused("image task manifest targets an unexpected table")
        if manifest.get("runtime_authoritative") is not False:
            raise ImportRefused("image task manifest must be marked runtime_authoritative=false")
        columns = manifest.get("import_columns") or []
        expected = ["task_id", "bundle", "category", "width", "height",
                    "image_format", "has_alpha", "r2_key", "source_sha256"]
        if columns != expected:
            raise ImportRefused(f"image task manifest column contract changed: {columns}")

        imported = 0
        for task in manifest.get("tasks", []):
            row = {
                "task_id": task.get("task_id"),
                "bundle": task.get("bundle"),
                "category": task.get("category"),
                "width": int(task.get("width") or 0),
                "height": int(task.get("height") or 0),
                "image_format": task.get("image_format"),
                "has_alpha": int(task.get("has_alpha") or 0),
                "r2_key": task.get("r2_key"),
                "source_sha256": normalise_sha(task.get("source_sha256")),
            }
            if not row["task_id"] or not row["bundle"] or not row["category"]:
                raise ImportRefused(f"image task row is missing required columns: {task!r}")
            self.conn.execute(
                """
                INSERT INTO image_task_units (
                    task_id, bundle, category, width, height, image_format,
                    has_alpha, r2_key, source_sha256, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET
                    bundle=excluded.bundle,
                    category=excluded.category,
                    width=excluded.width,
                    height=excluded.height,
                    image_format=excluded.image_format,
                    has_alpha=excluded.has_alpha,
                    r2_key=excluded.r2_key,
                    source_sha256=excluded.source_sha256,
                    updated_at=excluded.updated_at
                """,
                (
                    row["task_id"], row["bundle"], row["category"], row["width"], row["height"],
                    row["image_format"], row["has_alpha"], row["r2_key"], row["source_sha256"],
                    timestamp, timestamp,
                ),
            )
            imported += 1
            if limit and imported >= limit:
                self.write_image_category_summary(timestamp, truncated=True)
                return imported
        self.write_image_category_summary(timestamp)
        return imported

    def write_image_category_summary(self, timestamp: str, truncated: bool = False) -> int:
        """Roll up `image_task_units` into `portal_summary['image_categories']`.

        The portal's task listing shows per-category totals and a grand total, and
        it must not answer either with a COUNT/GROUP BY on the request path — this
        is the "walk once, read many" side of that split, and it runs here because
        the importer has already read every row.

        The row is rebuilt from the table rather than from the manifest, so a
        second import of the same manifest, or an import of a different one, still
        produces the truth for what is in D1. `truncated` marks a bounded smoke run
        explicitly: the counts are partial, and a reader deserves to know that
        rather than read them as whole.
        """
        counts = {
            str(row["category"]): int(row["count"])
            for row in self.conn.execute(
                "SELECT category, COUNT(*) AS count FROM image_task_units GROUP BY category"
            ).fetchall()
        }
        total = sum(counts.values())
        payload = {
            "counts": counts,
            "total": total,
            "truncated": bool(truncated),
        }
        self.conn.execute(
            "INSERT INTO portal_summary (key, value_json, updated_at) VALUES ('image_categories', ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (json.dumps(payload, ensure_ascii=False), timestamp),
        )
        self.report["image_category_summary"] = payload
        return total

    # ------------------------------------------------------------------
    # summaries
    # ------------------------------------------------------------------
    def rebuild_release_summary(self, release_kind: str, release_id: str, timestamp: str) -> Dict[str, Any]:
        rows = self.conn.execute(
            """
            SELECT rrr.status, rrr.reuse_mode, COUNT(*) AS count
            FROM release_resource_refs rrr
            WHERE rrr.release_kind=? AND rrr.release_id=?
            GROUP BY rrr.status, rrr.reuse_mode
            """,
            (release_kind, release_id),
        ).fetchall()

        total = translated = pending = untranslated = 0
        reuse_counts = {
            "exact": 0, "verified-compatible": 0, "suggested": 0, "blocked": 0, "none": 0,
        }
        categories: Dict[str, Dict[str, int]] = {}

        category_rows = self.conn.execute(
            """
            SELECT ru.category, rrr.status, rrr.reuse_mode, COUNT(*) AS count
            FROM release_resource_refs rrr
            JOIN source_variants sv ON sv.source_variant_id = rrr.source_variant_id
            JOIN resource_units ru ON ru.resource_id = sv.resource_id
            WHERE rrr.release_kind=? AND rrr.release_id=?
            GROUP BY ru.category, rrr.status, rrr.reuse_mode
            """,
            (release_kind, release_id),
        ).fetchall()

        for row in rows:
            count = int(row["count"])
            total += count
            status = str(row["status"])
            if status == "accepted":
                translated += count
            elif status == "pending":
                pending += count
            elif status == "suggested":
                pass
            else:
                untranslated += count
            mode = str(row["reuse_mode"])
            if mode in reuse_counts:
                reuse_counts[mode] += count

        for row in category_rows:
            category = str(row["category"] or "uncategorized")
            bucket = categories.setdefault(
                category, {"total": 0, "translated": 0, "pending": 0, "untranslated": 0},
            )
            count = int(row["count"])
            bucket["total"] += count
            status = str(row["status"])
            if status == "accepted":
                bucket["translated"] += count
            elif status == "pending":
                bucket["pending"] += count
            elif status == "suggested":
                pass
            else:
                bucket["untranslated"] += count

        self.conn.execute(
            """
            INSERT INTO release_summaries (
                release_kind, release_id, total_items, translated_items, pending_items,
                untranslated_items, reused_items, suggested_items, blocked_items,
                category_summary_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(release_kind, release_id) DO UPDATE SET
                total_items=excluded.total_items,
                translated_items=excluded.translated_items,
                pending_items=excluded.pending_items,
                untranslated_items=excluded.untranslated_items,
                reused_items=excluded.reused_items,
                suggested_items=excluded.suggested_items,
                blocked_items=excluded.blocked_items,
                category_summary_json=excluded.category_summary_json,
                updated_at=excluded.updated_at
            """,
            (
                release_kind, release_id, total, translated, pending, untranslated,
                reuse_counts["exact"] + reuse_counts["verified-compatible"],
                reuse_counts["suggested"], reuse_counts["blocked"],
                json.dumps(categories, ensure_ascii=False), timestamp,
            ),
        )
        summary = {
            "release_kind": release_kind, "release_id": release_id, "total_items": total,
            "translated_items": translated, "pending_items": pending,
            "untranslated_items": untranslated, "reuse": reuse_counts,
        }
        self.report["summaries"][f"{release_kind}:{release_id}"] = summary
        return summary

    # ------------------------------------------------------------------
    # audit helpers
    # ------------------------------------------------------------------
    def detect_orphan_refs(self) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT rrr.id, rrr.release_kind, rrr.release_id, rrr.source_variant_id
            FROM release_resource_refs rrr
            LEFT JOIN source_variants sv ON sv.source_variant_id = rrr.source_variant_id
            WHERE sv.source_variant_id IS NULL
            LIMIT 100
            """
        ).fetchall()
        return [dict(row) for row in rows]

    def detect_source_hash_conflicts(self) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT ru.logical_key, sv.source_sha256, COUNT(DISTINCT sv.release_id) AS releases
            FROM source_variants sv
            JOIN resource_units ru ON ru.resource_id = sv.resource_id
            GROUP BY ru.logical_key, sv.source_sha256
            HAVING COUNT(DISTINCT sv.release_id) > 1
            LIMIT 100
            """
        ).fetchall()
        return [dict(row) for row in rows]

    def identity_counts(self) -> Dict[str, Any]:
        def scalar(sql: str, args: Tuple[Any, ...] = ()) -> int:
            row = self.conn.execute(sql, args).fetchone()
            return int(row[0] or 0)

        client_items = scalar(
            "SELECT COUNT(*) FROM release_resource_refs WHERE release_kind='client'"
        )
        assets_items = scalar(
            "SELECT COUNT(*) FROM release_resource_refs WHERE release_kind='assets'"
        )
        return {
            "resource_units_by_kind": {
                row["resource_kind"]: int(row["count"])
                for row in self.conn.execute(
                    "SELECT resource_kind, COUNT(*) AS count FROM resource_units GROUP BY resource_kind"
                )
            },
            "source_variants_by_release_kind": {
                row["release_kind"]: int(row["count"])
                for row in self.conn.execute(
                    "SELECT release_kind, COUNT(*) AS count FROM source_variants GROUP BY release_kind"
                )
            },
            "release_resource_refs_by_release_kind": {
                row["release_kind"]: int(row["count"])
                for row in self.conn.execute(
                    "SELECT release_kind, COUNT(*) AS count FROM release_resource_refs GROUP BY release_kind"
                )
            },
            "client_releases": scalar("SELECT COUNT(*) FROM client_releases"),
            "assets_releases": scalar("SELECT COUNT(*) FROM assets_releases"),
            "client_resource_items": client_items,
            "assets_resource_items": assets_items,
            "translation_units": scalar("SELECT COUNT(*) FROM translation_units"),
            "image_task_units": scalar("SELECT COUNT(*) FROM image_task_units"),
        }

    def required_records_missing(self, *, expect_client_items: bool) -> List[str]:
        """Post-conditions that a completed import must satisfy.

        Reported, not silently corrected: an empty client side after importing a
        client release manifest means the import did not do what was asked.
        """
        missing: List[str] = []
        identity = self.identity_counts()
        if expect_client_items and identity["client_resource_items"] == 0:
            missing.append(
                "a client release manifest was imported but release_resource_refs "
                "has no client rows"
            )
        return missing


def ensure_schema(connection: sqlite3.Connection) -> Dict[str, Any]:
    """Delegate schema management to the portal bootstrap ledger."""
    from bootstrap_portal_d1 import bootstrap  # type: ignore

    return bootstrap(connection)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--db-path", type=Path, default=DEFAULT_PORTAL_DB, help="target SQLite database")
    parser.add_argument("--assets-release", type=Path, help="assets-release manifest (real inputs only)")
    parser.add_argument("--client-release-input", type=Path, help="client-release-input manifest")
    parser.add_argument("--locales-dir", type=Path, help="GitHub export checkout: locales/**/*.jsonl")
    parser.add_argument("--lyrics-dir", type=Path, help="GitHub export checkout: lyrics/")
    parser.add_argument("--image-tasks-manifest", type=Path, help="D1 import manifest from generate_image_tasks_index.py")
    parser.add_argument("--report-out", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--limit", type=int, default=0, help="import at most N rows per family (smoke runs)")
    parser.add_argument(
        "--phase", choices=("schema", "import"), default="import",
        help="'schema' only applies the bootstrap ledger; 'import' also ingests the given inputs",
    )
    args = parser.parse_args()

    if args.db_path != Path(":memory:") and not args.db_path.exists():
        args.db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(args.db_path))
    try:
        schema_result = ensure_schema(connection)
        importer = PortalImporter(connection)
        importer.report["schema"] = {
            "applied": schema_result.get("applied", []),
            "skipped": schema_result.get("skipped", []),
            "baselined": schema_result.get("baselined", []),
        }
        importer.report["counts_before"] = importer.table_counts()
        timestamp = "2026-09-28T00:00:00Z"

        if args.phase == "import":
            has_input = any([
                args.assets_release, args.client_release_input, args.locales_dir,
                args.lyrics_dir, args.image_tasks_manifest,
            ])
            if not has_input:
                print(
                    "refused: no trusted inputs supplied. Pass --assets-release / "
                    "--client-release-input / --locales-dir / --lyrics-dir / "
                    "--image-tasks-manifest; this importer never falls back to runtime snapshots.",
                    file=sys.stderr,
                )
                return 2

            assets_release = None
            client_release = None
            if args.assets_release:
                importer.record_input("assets_release", args.assets_release)
                assets_release = importer.ensure_assets_release(read_json(args.assets_release))
            if args.client_release_input:
                importer.record_input("client_release_input", args.client_release_input)
                client_release = importer.ensure_client_release(read_json(args.client_release_input))

            if args.locales_dir:
                if assets_release is None:
                    raise ImportRefused("--locales-dir requires --assets-release to name the target release")
                importer.record_input("locales_dir", args.locales_dir)
                count = importer.import_locales(
                    args.locales_dir, assets_release, timestamp, args.limit or None,
                )
                print(f"locales imported: {count}")

            if args.lyrics_dir:
                if assets_release is None:
                    raise ImportRefused("--lyrics-dir requires --assets-release to name the target release")
                importer.record_input("lyrics_dir", args.lyrics_dir)
                count = importer.import_lyrics(
                    args.lyrics_dir, assets_release, timestamp, args.limit or None,
                )
                print(f"lyrics imported: {count}")

            if args.image_tasks_manifest:
                importer.record_input("image_tasks_manifest", args.image_tasks_manifest)
                count = importer.import_image_tasks(
                    args.image_tasks_manifest, timestamp, args.limit or None,
                )
                print(f"image tasks imported: {count}")

            if assets_release is not None:
                importer.rebuild_release_summary("assets", assets_release["release_id"], timestamp)
            if client_release is not None:
                # A client release summary exists only when client-side
                # resources were actually imported for it. It is never seeded.
                importer.rebuild_release_summary("client", client_release["release_id"], timestamp)

        connection.commit()

        importer.report["counts_after"] = importer.table_counts()
        importer.report["identity"] = importer.identity_counts()
        importer.report["anomalies"]["orphan_refs"] = importer.detect_orphan_refs()
        importer.report["anomalies"]["source_hash_conflicts"] = importer.detect_source_hash_conflicts()
        importer.report["missing_required_records"] = importer.required_records_missing(
            expect_client_items=bool(args.client_release_input)
        )

        args.report_out.parent.mkdir(parents=True, exist_ok=True)
        args.report_out.write_text(
            json.dumps(importer.report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"[OK] report written: {args.report_out}")
        print(json.dumps(importer.report["identity"], ensure_ascii=False))
        return 0
    except ImportRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 3
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
