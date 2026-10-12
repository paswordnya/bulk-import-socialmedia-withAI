-- Geocoded places for a video: [{name, latitude, longitude, source, displayName}], filled in after import.
ALTER TABLE social_videos
  ADD COLUMN places JSONB NOT NULL DEFAULT '[]'::jsonb;
