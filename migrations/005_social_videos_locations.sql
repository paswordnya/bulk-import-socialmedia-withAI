-- Place names the creator wrote in the caption (best effort, TikTok and Instagram only).
ALTER TABLE social_videos
  ADD COLUMN locations TEXT[] NOT NULL DEFAULT '{}';
