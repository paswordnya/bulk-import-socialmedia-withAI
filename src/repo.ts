import { randomUUID } from 'node:crypto';
import { assertTransition, PROGRESS, isTerminal, type ErrorCode, type JobStatus } from './jobs.js';
import type { Enrichment, Place, VideoSummary } from './places.js';
import type { Platform } from './urls.js';

export interface VideoCursor {
  createdAt: Date;
  id: string;
}

export interface VideoRow {
  id: string;
  userId: string;
  platform: Platform;
  sourceUrl: string;
  normalizedUrl: string;
  contentId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  title: string | null;
  description: string | null;
  thumbnailKey: string | null;
  storageKey: string | null;
  playbackKind: 'file' | 'embed';
  embedUrl: string | null;
  /** External thumbnail (embeds only); stored thumbnails use thumbnailKey. */
  thumbnailUrl: string | null;
  duration: number | null;
  publishedAt: Date | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  repostCount: number | null;
  saveCount: number | null;
  musicTitle: string | null;
  musicArtist: string | null;
  authorId: string | null;
  authorUrl: string | null;
  hashtags: string[];
  locations: string[];
  /** Geocoded places, filled in after import by the place enricher. */
  places: Place[];
  /** AI title and key takeaways, filled in after import. null until then. */
  summary: VideoSummary | null;
  /** Whether enrichment is still running. null when it is off or the row predates it. */
  enrichment: Enrichment | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  fileSizeBytes: number | null;
  createdAt: Date;
}

export interface JobRow {
  id: string;
  userId: string;
  sourceUrl: string;
  normalizedUrl: string;
  platform: Platform;
  status: JobStatus;
  progress: number;
  provider: string | null;
  providerRunId: string | null;
  videoId: string | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export type NewJob = Pick<JobRow, 'userId' | 'sourceUrl' | 'normalizedUrl' | 'platform'> &
  Partial<Pick<JobRow, 'status' | 'videoId'>>;

/** id is optional so the worker can use the same id in the storage key. */
export type NewVideo = Omit<VideoRow, 'id' | 'createdAt' | 'playbackKind' | 'embedUrl' | 'thumbnailUrl' | 'locations' | 'places' | 'summary' | 'enrichment'> & {
  id?: string;
  locations?: string[];
  places?: Place[];
  summary?: VideoSummary | null;
  enrichment?: Enrichment | null;
  playbackKind?: 'file' | 'embed';
  embedUrl?: string | null;
  thumbnailUrl?: string | null;
};

export interface Repo {
  findVideoByDedup(userId: string, platform: Platform, contentId: string | null, normalizedUrl: string): Promise<VideoRow | null>;
  findActiveJob(userId: string, normalizedUrl: string): Promise<JobRow | null>;
  createJob(j: NewJob): Promise<JobRow>;
  getJob(id: string, userId?: string): Promise<JobRow | null>;
  /** Validates the transition against the state machine. */
  transitionJob(id: string, to: JobStatus, patch?: Partial<Pick<JobRow, 'provider' | 'providerRunId' | 'videoId' | 'errorCode' | 'errorMessage'>>): Promise<JobRow>;
  createVideo(v: NewVideo): Promise<VideoRow>;
  getVideo(id: string, userId: string): Promise<VideoRow | null>;
  /** Newest first; `before` is an exclusive keyset cursor. */
  listVideos(userId: string, limit: number, before?: VideoCursor): Promise<VideoRow[]>;
  listIncompleteJobs(): Promise<JobRow[]>;
  /** Replaces the places of one of the user's videos. No-op if the video does not exist. */
  updatePlaces(videoId: string, userId: string, places: Place[]): Promise<boolean>;
  /** Sets the AI summary of one of the user's videos. No-op if the video does not exist. */
  updateSummary(videoId: string, userId: string, summary: VideoSummary): Promise<boolean>;
  /**
   * Deletes one of the user's videos together with the import jobs that point at it, and returns the deleted row so the
   * caller can remove its stored files. null when the video does not exist or belongs to someone else.
   */
  deleteVideo(videoId: string, userId: string): Promise<VideoRow | null>;
  /** Sets the enrichment state of one of the user's videos. false if the video does not exist. */
  updateEnrichment(videoId: string, userId: string, enrichment: Enrichment): Promise<boolean>;
  /** Marks every enrichment still 'processing' as 'done'. Used at startup, because the in-process queue is gone after a restart. */
  finishStaleEnrichment(): Promise<number>;
}

export class InMemoryRepo implements Repo {
  readonly jobs = new Map<string, JobRow>();
  readonly videos = new Map<string, VideoRow>();

  async findVideoByDedup(userId: string, platform: Platform, contentId: string | null, normalizedUrl: string) {
    for (const v of this.videos.values()) {
      if (v.userId !== userId || v.platform !== platform) continue;
      if ((contentId !== null && v.contentId === contentId) || v.normalizedUrl === normalizedUrl) return v;
    }
    return null;
  }

  async findActiveJob(userId: string, normalizedUrl: string) {
    for (const j of this.jobs.values()) {
      if (j.userId === userId && j.normalizedUrl === normalizedUrl && !isTerminal(j.status)) return j;
    }
    return null;
  }

  async createJob(n: NewJob) {
    const now = new Date();
    const status = n.status ?? 'PENDING';
    const j: JobRow = {
      id: `job_${randomUUID()}`,
      userId: n.userId,
      sourceUrl: n.sourceUrl,
      normalizedUrl: n.normalizedUrl,
      platform: n.platform,
      status,
      progress: PROGRESS[status],
      provider: null,
      providerRunId: null,
      videoId: n.videoId ?? null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: status === 'COMPLETED' ? now : null,
    };
    this.jobs.set(j.id, j);
    return { ...j };
  }

  async getJob(id: string, userId?: string) {
    const j = this.jobs.get(id);
    if (!j || (userId !== undefined && j.userId !== userId)) return null;
    return { ...j };
  }

  async transitionJob(id: string, to: JobStatus, patch: Parameters<Repo['transitionJob']>[2] = {}) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`job ${id} not found`);
    assertTransition(j.status, to);
    const now = new Date();
    Object.assign(j, patch, {
      status: to,
      progress: to === 'FAILED' ? j.progress : PROGRESS[to],
      updatedAt: now,
      completedAt: isTerminal(to) ? now : null,
    });
    return { ...j };
  }

  async createVideo(v: NewVideo) {
    const dup = await this.findVideoByDedup(v.userId, v.platform, v.contentId, v.normalizedUrl);
    if (dup) throw new DuplicateVideoError();
    const row: VideoRow = {
      ...v,
      id: v.id ?? `video_${randomUUID()}`,
      playbackKind: v.playbackKind ?? 'file',
      embedUrl: v.embedUrl ?? null,
      thumbnailUrl: v.thumbnailUrl ?? null,
      locations: v.locations ?? [],
      places: v.places ?? [],
      summary: v.summary ?? null,
      enrichment: v.enrichment ?? null,
      createdAt: new Date(),
    };
    this.videos.set(row.id, row);
    return { ...row };
  }

  async getVideo(id: string, userId: string) {
    const v = this.videos.get(id);
    return v && v.userId === userId ? { ...v } : null;
  }

  async listVideos(userId: string, limit: number, before?: VideoCursor) {
    return [...this.videos.values()]
      .filter((v) => v.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter((v) => !before || v.createdAt.getTime() < before.createdAt.getTime() || (v.createdAt.getTime() === before.createdAt.getTime() && v.id < before.id))
      .slice(0, limit)
      .map((v) => ({ ...v }));
  }

  async updatePlaces(videoId: string, userId: string, places: Place[]) {
    const v = this.videos.get(videoId);
    if (!v || v.userId !== userId) return false;
    v.places = places.map((p) => ({ ...p }));
    return true;
  }

  async updateSummary(videoId: string, userId: string, summary: VideoSummary) {
    const v = this.videos.get(videoId);
    if (!v || v.userId !== userId) return false;
    v.summary = { title: summary.title, takeaways: [...summary.takeaways] };
    return true;
  }

  async updateEnrichment(videoId: string, userId: string, enrichment: Enrichment) {
    const v = this.videos.get(videoId);
    if (!v || v.userId !== userId) return false;
    v.enrichment = { ...enrichment };
    return true;
  }

  async finishStaleEnrichment() {
    let n = 0;
    for (const v of this.videos.values()) if (v.enrichment?.state === 'processing') { v.enrichment = { ...v.enrichment, state: 'done' }; n++; }
    return n;
  }

  async deleteVideo(videoId: string, userId: string) {
    const v = this.videos.get(videoId);
    if (!v || v.userId !== userId) return null;
    this.videos.delete(videoId);
    for (const [id, j] of this.jobs) if (j.videoId === videoId && j.userId === userId) this.jobs.delete(id);
    return { ...v };
  }

  async listIncompleteJobs() {
    return [...this.jobs.values()].filter((j) => !isTerminal(j.status)).map((j) => ({ ...j }));
  }
}

export class DuplicateVideoError extends Error {
  constructor() {
    super('duplicate video');
    this.name = 'DuplicateVideoError';
  }
}
