-- Videos that are played through an official embed (e.g. YouTube) have no stored file.
ALTER TABLE social_videos
  ADD COLUMN playback_kind TEXT NOT NULL DEFAULT 'file' CHECK (playback_kind IN ('file', 'embed')),
  ADD COLUMN embed_url     TEXT;
-- A stored file is required for file playback; embeds reference the provider instead.
ALTER TABLE social_videos
  ADD CONSTRAINT social_videos_playback_ck
  CHECK ((playback_kind = 'file' AND storage_key IS NOT NULL) OR (playback_kind = 'embed' AND embed_url IS NOT NULL)) NOT VALID;
