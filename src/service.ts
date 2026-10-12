import type { Enrichment, PlaceSource, VideoSummary } from './places.js';
import { ERROR_MESSAGES, type ErrorCode, type JobStatus } from './jobs.js';
import { parseSocialUrl, SocialUrlError } from './urls.js';
import type { JobRow, Repo, VideoCursor, VideoRow } from './repo.js';
import type { Storage } from './storage.js';

export interface VideoDto {
  id: string;
  platform: string;
  sourceUrl: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  /** null for embed playback; use `playback.embedUrl` instead. */
  videoUrl: string | null;
  playback: { kind: 'file' | 'embed'; embedUrl: string | null };
  createdAt: string;
  duration: number | null;
  publishedAt: string | null;
  authorId: string | null;
  authorUrl: string | null;
  hashtags: string[];
  /** Place names from the caption; empty when none were found. */
  locations: string[];
  /** Geocoded places (name + coordinates). Filled in shortly after import, so it can be empty at first. */
  places: Array<{ name: string; latitude: number; longitude: number; source: PlaceSource; displayName: string | null; category: string | null; /** Signed URL of a video frame showing the place (frame-ai only). */ photoUrl: string | null }>;
  /** AI title and key takeaways. null until the enrichment finishes (or when the feature is off). */
  summary: VideoSummary | null;
  /** 'processing' while places and the summary are still being worked out. null when enrichment is off (treat as done). */
  enrichment: Enrichment | null;
  stats: { views: number | null; likes: number | null; comments: number | null; reposts: number | null; saves: number | null };
  music: { title: string | null; artist: string | null } | null;
  media: { width: number | null; height: number | null; codec: string | null; fileSizeBytes: number | null };
}

export interface JobDto {
  jobId: string;
  status: JobStatus;
  progress: number;
  video?: VideoDto;
  errorCode?: ErrorCode;
  message?: string;
}

export interface VideoPage {
  items: VideoDto[];
  nextCursor: string | null;
}

export class InvalidCursorError extends Error {}

export function encodeCursor(v: { createdAt: Date; id: string }): string {
  return Buffer.from(`${v.createdAt.toISOString()}|${v.id}`).toString('base64url');
}

export function decodeCursor(c: string): VideoCursor {
  if (c.length > 200 || !/^[A-Za-z0-9_-]+$/.test(c)) throw new InvalidCursorError();
  const [iso, id, ...rest] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (rest.length > 0 || !id || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new InvalidCursorError();
  }
  return { createdAt, id };
}

export class ImportService {
  constructor(
    private readonly repo: Repo,
    private readonly storage: Storage,
    private readonly enqueue: (jobId: string) => void,
    private readonly log?: (entry: Record<string, unknown>) => void,
  ) {}

  /** Throws SocialUrlError for bad input. Returns an existing job/video link when it can. */
  async startImport(userId: string, rawUrl: string): Promise<{ jobId: string; status: JobStatus; created: boolean }> {
    const parsed = parseSocialUrl(rawUrl);

    const active = await this.repo.findActiveJob(userId, parsed.normalizedUrl);
    if (active) return { jobId: active.id, status: active.status, created: false };

    const existing = await this.repo.findVideoByDedup(userId, parsed.platform, parsed.contentId, parsed.normalizedUrl);
    if (existing) {
      const j = await this.repo.createJob({
        userId, sourceUrl: rawUrl.trim(), normalizedUrl: parsed.normalizedUrl, platform: parsed.platform,
        status: 'COMPLETED', videoId: existing.id,
      });
      return { jobId: j.id, status: j.status, created: false };
    }

    const job = await this.repo.createJob({
      userId, sourceUrl: rawUrl.trim(), normalizedUrl: parsed.normalizedUrl, platform: parsed.platform,
    });
    this.enqueue(job.id);
    return { jobId: job.id, status: job.status, created: true };
  }

  async getJob(userId: string, jobId: string): Promise<JobDto | null> {
    const job = await this.repo.getJob(jobId, userId);
    if (!job) return null;
    return this.toDto(job);
  }

  /**
   * Deletes the user's video and then its stored files (video, thumbnail, place photos). The database row goes first, so a
   * storage failure leaves only orphan files, which are logged, never a video that points at missing files.
   * Returns false when the video does not exist or is not the user's.
   */
  async deleteVideo(userId: string, videoId: string): Promise<boolean> {
    const v = await this.repo.deleteVideo(videoId, userId);
    if (!v) return false;
    const keys = [v.storageKey, v.thumbnailKey, ...v.places.map((p) => p.photoKey)].filter((k): k is string => typeof k === 'string' && k.length > 0);
    if (keys.length > 0) {
      try {
        await this.storage.deleteObjects(keys);
      } catch (e) {
        this.log?.({ msg: 'delete.storage_failed', videoId, objects: keys.length, detail: e instanceof Error ? e.message : 'unknown' });
      }
    }
    this.log?.({ msg: 'delete.done', videoId, objects: keys.length });
    return true;
  }

  async getVideo(userId: string, videoId: string): Promise<VideoDto | null> {
    const v = await this.repo.getVideo(videoId, userId);
    return v ? this.videoDto(v) : null;
  }

  async listVideos(userId: string, limit: number, cursor?: string): Promise<VideoPage> {
    const before = cursor === undefined ? undefined : decodeCursor(cursor);
    const rows = await this.repo.listVideos(userId, limit + 1, before);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await Promise.all(page.map((v) => this.videoDto(v))),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  private async toDto(job: JobRow): Promise<JobDto> {
    const base = { jobId: job.id, status: job.status, progress: job.progress };
    if (job.status === 'COMPLETED' && job.videoId) {
      const v = await this.repo.getVideo(job.videoId, job.userId);
      if (v) return { ...base, video: await this.videoDto(v) };
    }
    if (job.status === 'FAILED') {
      const code = job.errorCode ?? 'UNKNOWN_ERROR';
      return { ...base, errorCode: code, message: ERROR_MESSAGES[code] };
    }
    return base;
  }

  private async videoDto(v: VideoRow): Promise<VideoDto> {
    return {
      id: v.id,
      platform: v.platform,
      sourceUrl: v.sourceUrl,
      authorUsername: v.authorUsername,
      authorDisplayName: v.authorDisplayName,
      title: v.title,
      description: v.description,
      createdAt: v.createdAt.toISOString(),
      publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
      authorId: v.authorId,
      authorUrl: v.authorUrl,
      hashtags: v.hashtags,
      locations: v.locations,
      places: await Promise.all(v.places.map(async (p) => ({ name: p.name, latitude: p.latitude, longitude: p.longitude, source: p.source, displayName: p.displayName, category: p.category, photoUrl: p.photoKey ? await this.storage.signedUrl(p.photoKey) : null }))),
      summary: v.summary,
      enrichment: v.enrichment,
      stats: { views: v.viewCount, likes: v.likeCount, comments: v.commentCount, reposts: v.repostCount, saves: v.saveCount },
      music: v.musicTitle || v.musicArtist ? { title: v.musicTitle, artist: v.musicArtist } : null,
      media: { width: v.width, height: v.height, codec: v.videoCodec, fileSizeBytes: v.fileSizeBytes },
      thumbnailUrl: v.thumbnailKey ? await this.storage.signedUrl(v.thumbnailKey) : v.thumbnailUrl,
      videoUrl: v.storageKey ? await this.storage.signedUrl(v.storageKey) : null,
      playback: { kind: v.playbackKind, embedUrl: v.playbackKind === 'embed' ? v.embedUrl : null },
      duration: v.duration,
    };
  }
}

export { SocialUrlError };
