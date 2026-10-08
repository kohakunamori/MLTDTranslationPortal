-- Queued image backfill jobs.
--
-- The portal stores an uploaded Chinese composite in R2 and records the job
-- here. The actual slice-and-paste backfill needs Pillow, so it runs in the
-- GitHub Actions job (`.github/workflows/backfill-image.yml`) instead of at
-- the edge; this table is the handoff queue between the two.

CREATE TABLE IF NOT EXISTS image_restore_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  upload_key TEXT NOT NULL,
  upload_sha256 TEXT NOT NULL,
  model_size TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'done', 'failed')) DEFAULT 'queued',
  actor_email TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  localized_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_restore_status
  ON image_restore_requests (status, created_at);
