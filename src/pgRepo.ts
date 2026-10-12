import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertTransition, PROGRESS, isTerminal, type JobStatus } from './jobs.js';
import { DuplicateVideoError, type JobRow, type NewJob, type NewVideo, type Repo, type VideoCursor, type VideoRow } from './repo.js';
import { parseStoredEnrichment, parseStoredPlaces, parseStoredSummary, type Enrichment, type Place, type VideoSummary } from './places.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** BIGINT comes back from pg as a string. */
const num = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));

const toJob = (r: any): JobRow => ({
  id: r.id, userId: r.user_id, sourceUrl: r.source_url, normalizedUrl: r.normalized_url, platform: r.platform,
  status: r.status, progress: r.progress, provider: r.provider, providerRunId: r.provider_run_id,
  videoId: r.video_id, errorCode: r.error_code, errorMessage: r.error_message,
  createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
});

const toVideo = (r: any): VideoRow => ({
  id: r.id, userId: r.user_id, platform: r.platform, sourceUrl: r.source_url, normalizedUrl: r.normalized_url,
  contentId: r.content_id, authorUsername: r.author_username, authorDisplayName: r.author_display_name,
  title: r.title, description: r.description, thumbnailKey: r.thumbnail_key, storageKey: r.storage_key,
  duration: r.duration,
  playbackKind: r.playback_kind === 'embed' ? 'embed' : 'file', embedUrl: r.embed_url, thumbnailUrl: r.thumbnail_url,
  publishedAt: r.published_at, viewCount: num(r.view_count), likeCount: num(r.like_count),
  commentCount: num(r.comment_count), repostCount: num(r.repost_count), saveCount: num(r.save_count),
  musicTitle: r.music_title, musicArtist: r.music_artist, authorId: r.author_id, authorUrl: r.author_url,
  hashtags: r.hashtags ?? [], locations: r.locations ?? [], places: parseStoredPlaces(r.places), summary: parseStoredSummary(r.summary), enrichment: parseStoredEnrichment(r.enrichment), width: r.width, height: r.height, videoCodec: r.video_codec,
  fileSizeBytes: num(r.file_size_bytes), createdAt: r.created_at,
});

export class PgRepo implements Repo {
  constructor(private readonly pool: Pool) {}

  async findVideoByDedup(userId: string, platform: string, contentId: string | null, normalizedUrl: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM social_videos WHERE user_id=$1 AND platform=$2 AND status='COMPLETED'
         AND (($3::text IS NOT NULL AND content_id=$3) OR normalized_url=$4) LIMIT 1`,
      [userId, platform, contentId, normalizedUrl],
    );
    return rows[0] ? toVideo(rows[0]) : null;
  }

  async findActiveJob(userId: string, normalizedUrl: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM social_video_import_jobs WHERE user_id=$1 AND normalized_url=$2
         AND status NOT IN ('COMPLETED','FAILED') ORDER BY created_at DESC LIMIT 1`,
      [userId, normalizedUrl],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async createJob(n: NewJob) {
    const status = n.status ?? 'PENDING';
    const { rows } = await this.pool.query(
      `INSERT INTO social_video_import_jobs
         (id,user_id,source_url,normalized_url,platform,status,progress,video_id,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $6='COMPLETED' THEN now() END) RETURNING *`,
      [`job_${randomUUID()}`, n.userId, n.sourceUrl, n.normalizedUrl, n.platform, status, PROGRESS[status], n.videoId ?? null],
    );
    return toJob(rows[0]);
  }

  async getJob(id: string, userId?: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM social_video_import_jobs WHERE id=$1 AND ($2::text IS NULL OR user_id=$2)`,
      [id, userId ?? null],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async transitionJob(id: string, to: JobStatus, patch: Parameters<Repo['transitionJob']>[2] = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(`SELECT * FROM social_video_import_jobs WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rows[0]) throw new Error(`job ${id} not found`);
      const from = cur.rows[0].status as JobStatus;
      assertTransition(from, to);
      const { rows } = await client.query(
        `UPDATE social_video_import_jobs SET status=$2,
           progress=CASE WHEN $2='FAILED' THEN progress ELSE $3 END,
           provider=COALESCE($4,provider), provider_run_id=COALESCE($5,provider_run_id),
           video_id=COALESCE($6,video_id), error_code=COALESCE($7,error_code),
           error_message=COALESCE($8,error_message), updated_at=now(),
           completed_at=CASE WHEN $9 THEN now() END
         WHERE id=$1 RETURNING *`,
        [id, to, PROGRESS[to], patch.provider ?? null, patch.providerRunId ?? null, patch.videoId ?? null,
         patch.errorCode ?? null, patch.errorMessage ?? null, isTerminal(to)],
      );
      await client.query('COMMIT');
      return toJob(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async createVideo(v: NewVideo) {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO social_videos
           (id,user_id,platform,source_url,normalized_url,content_id,author_username,author_display_name,
            title,description,thumbnail_key,storage_key,duration,published_at,view_count,like_count,
            comment_count,repost_count,save_count,music_title,music_artist,author_id,author_url,hashtags,
            width,height,video_codec,file_size_bytes,playback_kind,embed_url,thumbnail_url,locations,places,summary,enrichment,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                 $25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34::jsonb,$35::jsonb,'COMPLETED') RETURNING *`,
        [v.id ?? `video_${randomUUID()}`, v.userId, v.platform, v.sourceUrl, v.normalizedUrl, v.contentId,
         v.authorUsername, v.authorDisplayName, v.title, v.description, v.thumbnailKey, v.storageKey, v.duration,
         v.publishedAt, v.viewCount, v.likeCount, v.commentCount, v.repostCount, v.saveCount, v.musicTitle,
         v.musicArtist, v.authorId, v.authorUrl, v.hashtags, v.width, v.height, v.videoCodec, v.fileSizeBytes, v.playbackKind ?? 'file', v.embedUrl ?? null,
         v.thumbnailUrl ?? null, v.locations ?? [], JSON.stringify(v.places ?? []), v.summary ? JSON.stringify(v.summary) : null, v.enrichment ? JSON.stringify(v.enrichment) : null],
      );
      return toVideo(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateVideoError();
      throw e;
    }
  }

  async updatePlaces(videoId: string, userId: string, places: Place[]) {
    const r = await this.pool.query(`UPDATE social_videos SET places=$3::jsonb WHERE id=$1 AND user_id=$2`, [videoId, userId, JSON.stringify(places)]);
    return (r.rowCount ?? 0) > 0;
  }

  async updateSummary(videoId: string, userId: string, summary: VideoSummary) {
    const r = await this.pool.query(`UPDATE social_videos SET summary=$3::jsonb WHERE id=$1 AND user_id=$2`, [videoId, userId, JSON.stringify(summary)]);
    return (r.rowCount ?? 0) > 0;
  }

  async updateEnrichment(videoId: string, userId: string, enrichment: Enrichment) {
    const r = await this.pool.query(`UPDATE social_videos SET enrichment=$3::jsonb WHERE id=$1 AND user_id=$2`, [videoId, userId, JSON.stringify(enrichment)]);
    return (r.rowCount ?? 0) > 0;
  }

  async finishStaleEnrichment() {
    const r = await this.pool.query(`UPDATE social_videos SET enrichment = jsonb_set(enrichment, '{state}', '"done"') WHERE enrichment->>'state' = 'processing'`);
    return r.rowCount ?? 0;
  }

  async deleteVideo(videoId: string, userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The jobs reference the video, so they go first; only the owner's rows are touched.
      const owned = await client.query(`SELECT 1 FROM social_videos WHERE id=$1 AND user_id=$2 FOR UPDATE`, [videoId, userId]);
      if (!owned.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(`DELETE FROM social_video_import_jobs WHERE video_id=$1 AND user_id=$2`, [videoId, userId]);
      const { rows } = await client.query(`DELETE FROM social_videos WHERE id=$1 AND user_id=$2 RETURNING *`, [videoId, userId]);
      await client.query('COMMIT');
      return rows[0] ? toVideo(rows[0]) : null;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getVideo(id: string, userId: string) {
    const { rows } = await this.pool.query(`SELECT * FROM social_videos WHERE id=$1 AND user_id=$2`, [id, userId]);
    return rows[0] ? toVideo(rows[0]) : null;
  }

  async listVideos(userId: string, limit: number, before?: VideoCursor) {
    const { rows } = await this.pool.query(
      `SELECT * FROM social_videos
        WHERE user_id=$1 AND status='COMPLETED'
          AND ($2::timestamptz IS NULL
               OR (date_trunc('milliseconds', created_at), id) < ($2::timestamptz, $3::text))
        ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
        LIMIT $4`,
      [userId, before?.createdAt ?? null, before?.id ?? null, limit],
    );
    return rows.map(toVideo);
  }

  async listIncompleteJobs() {
    const { rows } = await this.pool.query(`SELECT * FROM social_video_import_jobs WHERE status NOT IN ('COMPLETED','FAILED')`);
    return rows.map(toJob);
  }
}
