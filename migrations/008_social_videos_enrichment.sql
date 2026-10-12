-- Whether the AI enrichment (places, summary) is still running, and how many places the video itself announces:
-- {state: 'processing' | 'done', expectedPlaces: number | null}. NULL when enrichment is off or the row predates it.
ALTER TABLE social_videos
  ADD COLUMN enrichment JSONB;
