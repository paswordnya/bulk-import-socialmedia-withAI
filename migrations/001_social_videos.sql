CREATE TABLE social_videos (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  platform             TEXT NOT NULL,
  source_url           TEXT NOT NULL,
  normalized_url       TEXT NOT NULL,
  content_id           TEXT,
  author_username      TEXT,
  author_display_name  TEXT,
  description          TEXT,
  thumbnail_url        TEXT,
  thumbnail_key        TEXT,
  storage_key          TEXT,
  video_url            TEXT,
  duration             INTEGER,
  status               TEXT NOT NULL
    CHECK (status IN ('PENDING','FETCHING','DOWNLOADING','STORING','COMPLETED','FAILED')),
  error_code           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup per user: platform + content_id, falling back to normalized_url.
CREATE UNIQUE INDEX social_videos_user_content_uq
  ON social_videos (user_id, platform, content_id) WHERE content_id IS NOT NULL;
CREATE UNIQUE INDEX social_videos_user_url_uq
  ON social_videos (user_id, platform, normalized_url);

CREATE TABLE social_video_import_jobs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  normalized_url   TEXT NOT NULL,
  platform         TEXT NOT NULL,
  status           TEXT NOT NULL
    CHECK (status IN ('PENDING','FETCHING','DOWNLOADING','STORING','COMPLETED','FAILED')),
  progress         SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  provider         TEXT,
  provider_run_id  TEXT,
  video_id         TEXT REFERENCES social_videos(id),
  error_code       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX social_video_import_jobs_user_idx ON social_video_import_jobs (user_id, created_at DESC);
