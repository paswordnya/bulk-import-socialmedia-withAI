ALTER TABLE social_videos ADD COLUMN title TEXT;
CREATE INDEX social_videos_user_created_idx ON social_videos (user_id, created_at DESC, id DESC) WHERE status = 'COMPLETED';
