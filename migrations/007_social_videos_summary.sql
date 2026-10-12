-- AI title and key takeaways: {title, takeaways[]}, filled in after import. NULL until then.
ALTER TABLE social_videos
  ADD COLUMN summary JSONB;
