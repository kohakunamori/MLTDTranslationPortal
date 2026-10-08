-- ============================================================================
-- Manual image-task status overrides (mark a reconstructed banner as
-- "not_needed" when it contains no Japanese text, or revive it afterwards).
-- The static index in public/data/image_tasks.json ships the reconstructed
-- composites; this table only records the human decisions layered on top.
-- ============================================================================

CREATE TABLE IF NOT EXISTS image_status_overrides (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('untranslated', 'not_needed', 'restored', 'accepted')),
  actor_email TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
