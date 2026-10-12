import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ERROR_MESSAGES, type ErrorCode } from './jobs.js';
import { DEFAULT_MEDIA_LIMITS, InvalidMediaError, validateDownload, validateProbe, type MediaLimits, type MediaProber } from './media.js';
import { ProviderError, selectProvider, type SocialVideoProvider, type SocialVideoResult } from './provider.js';
import { DuplicateVideoError, type JobRow, type NewVideo, type Repo, type VideoRow } from './repo.js';
import { thumbKey, videoKey, type Storage } from './storage.js';
import type { Downloader } from './download.js';
import type { Thumbnailer } from './thumbnail.js';
import { randomUUID } from 'node:crypto';
import type { FrameExtractor } from './frames.js';
import { DEFAULT_PLACE_FRAMES, framesFor, MAX_EXTRA_FRAMES, type PlaceJob } from './enrich.js';
import { expectedPlaceCount } from './places.js';

export interface WorkerDeps {
  repo: Repo;
  providers: readonly SocialVideoProvider[];
  providerName: string;
  downloader: Downloader;
  prober: MediaProber;
  storage: Storage;
  limits?: MediaLimits;
  jobTimeoutMs?: number;
  log?: (entry: Record<string, unknown>) => void;
  thumbnailer?: Thumbnailer;
  tmpRoot?: string;
  /** Optional place enrichment: runs after the job is COMPLETED and never affects its outcome. */
  frameExtractor?: FrameExtractor;
  enqueuePlaces?: (job: PlaceJob) => void;
  /** How many frames to hand the vision model. */
  placeFrames?: number;
}

export class StorageError extends Error {}

function toErrorCode(e: unknown): ErrorCode {
  if (e instanceof ProviderError) return e.code;
  if (e instanceof InvalidMediaError) {
    return e.reason === 'TOO_LONG' ? 'VIDEO_TOO_LONG' : e.reason === 'TOO_LARGE' ? 'FILE_TOO_LARGE' : 'INVALID_MEDIA';
  }
  if (e instanceof StorageError) return 'STORAGE_ERROR';
  return 'UNKNOWN_ERROR';
}

async function readHead(file: string, n = 16): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new ProviderError('IMPORT_TIMEOUT', 'job timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Runs one job to a terminal state. Never throws for pipeline failures; they become FAILED. */
export async function processJob(deps: WorkerDeps, jobId: string): Promise<void> {
  const { repo } = deps;
  const log = deps.log ?? (() => {});
  const startedAt = Date.now();
  const job = await repo.getJob(jobId);
  if (!job || job.status === 'COMPLETED' || job.status === 'FAILED') return;

  try {
    // After a restart a job may be mid-pipeline; the pipeline is idempotent, so restart from the top.
    if (job.status !== 'PENDING') {
      await repo.transitionJob(job.id, 'FAILED', { errorCode: 'UNKNOWN_ERROR', errorMessage: 'interrupted by restart' });
      log({ jobId, userId: job.userId, status: 'FAILED', errorCode: 'UNKNOWN_ERROR', reason: 'interrupted' });
      return;
    }
    await withTimeout(run(deps, job), deps.jobTimeoutMs ?? 5 * 60_000);
    log({ jobId, userId: job.userId, platform: job.platform, provider: deps.providerName, status: 'COMPLETED', durationMs: Date.now() - startedAt });
  } catch (e) {
    const code = toErrorCode(e);
    log({ jobId, userId: job.userId, platform: job.platform, provider: deps.providerName, status: 'FAILED', errorCode: code, durationMs: Date.now() - startedAt, detail: e instanceof Error ? e.message : 'unknown' });
    const cur = await repo.getJob(jobId);
    if (cur && cur.status !== 'COMPLETED' && cur.status !== 'FAILED') {
      await repo.transitionJob(jobId, 'FAILED', { errorCode: code, errorMessage: ERROR_MESSAGES[code] });
    }
  }
}

async function run(deps: WorkerDeps, job: JobRow): Promise<void> {
  const { repo, storage } = deps;
  const limits = deps.limits ?? DEFAULT_MEDIA_LIMITS;
  const tmp = await mkdtemp(path.join(deps.tmpRoot ?? tmpdir(), 'svi-'));
  try {
    await repo.transitionJob(job.id, 'FETCHING', { provider: deps.providerName });
    const provider = selectProvider(deps.providers, job.normalizedUrl);
    const meta = await provider.fetchVideo(job.normalizedUrl);

    // Short links only reveal their content id here; dedup again before downloading.
    const existing = await repo.findVideoByDedup(job.userId, job.platform, meta.contentId, job.normalizedUrl);
    if (existing) {
      await repo.transitionJob(job.id, 'DOWNLOADING');
      await repo.transitionJob(job.id, 'STORING');
      await repo.transitionJob(job.id, 'COMPLETED', { videoId: existing.id });
      return;
    }

    if (meta.playbackKind === 'embed') {
      // Official embed: nothing is downloaded or stored. Step through the states so progress stays consistent.
      if (!meta.embedUrl) throw new ProviderError('PROVIDER_ERROR', 'embed without url');
      await repo.transitionJob(job.id, 'DOWNLOADING');
      await repo.transitionJob(job.id, 'STORING');
      const embedId = `video_${randomUUID()}`;
      let embedThumbKey: string | null = null;
      if (meta.storeThumbnail && meta.thumbnailUrl) {
        // Short-lived preview URL: keep our own copy. Best-effort; falls back to the external URL.
        try {
          const f = path.join(tmp, 'embed-thumb.jpg');
          await deps.downloader.download(meta.thumbnailUrl, {}, f, 5 * 1024 * 1024);
          const head = await readHead(f, 4);
          if (head[0] === 0xff && head[1] === 0xd8) {
            const key = thumbKey(job.userId, embedId);
            await storage.putFile(key, f, 'image/jpeg');
            embedThumbKey = key;
          }
        } catch {
          embedThumbKey = null;
        }
      }
      const embedded = await saveVideo(repo, job, meta, {
        enrichment: enrichmentStart(deps, meta),
        id: embedId, storageKey: null, playbackKind: 'embed', embedUrl: meta.embedUrl,
        thumbnailUrl: embedThumbKey ? null : meta.thumbnailUrl, thumbnailKey: embedThumbKey,
        duration: meta.duration, width: null, height: null, videoCodec: null, fileSizeBytes: null,
      });
      await repo.transitionJob(job.id, 'COMPLETED', { videoId: embedded.id });
      queuePlaces(deps, embedded, meta, []);
      return;
    }

    await repo.transitionJob(job.id, 'DOWNLOADING');
    const file = path.join(tmp, 'video.mp4');
    if (provider.downloadVideo) await provider.downloadVideo(job.normalizedUrl, file, limits.maxBytes);
    else await deps.downloader.download(meta.videoUrl, meta.downloadHeaders ?? {}, file, limits.maxBytes);
    const { size } = await stat(file);
    validateDownload(await readHead(file), size, limits);
    const probe = await deps.prober.probe(file);
    validateProbe(probe, limits);

    let thumbFile: string | null = null;
    if (meta.thumbnailUrl) {
      try {
        const f = path.join(tmp, 'thumb.jpg');
        await deps.downloader.download(meta.thumbnailUrl, {}, f, 5 * 1024 * 1024);
        const head = await readHead(f, 4);
        thumbFile = head[0] === 0xff && head[1] === 0xd8 ? f : null; // must be a real JPEG
      } catch {
        thumbFile = null;
      }
    }
    if (!thumbFile && deps.thumbnailer) {
      try {
        const f = path.join(tmp, 'frame.jpg');
        await deps.thumbnailer.fromVideo(file, f, Math.min(1, probe.durationSeconds / 2));
        const head = await readHead(f, 4);
        thumbFile = head[0] === 0xff && head[1] === 0xd8 ? f : null;
      } catch {
        thumbFile = null; // thumbnails are best-effort
      }
    }

    await repo.transitionJob(job.id, 'STORING');
    const videoId = `video_${randomUUID()}`;
    const vKey = videoKey(job.userId, videoId);
    const tKey = thumbFile ? thumbKey(job.userId, videoId) : null;
    try {
      await storage.putFile(vKey, file, 'video/mp4');
      if (thumbFile && tKey) await storage.putFile(tKey, thumbFile, 'image/jpeg');
    } catch {
      throw new StorageError('upload failed');
    }

    const video = await saveVideo(repo, job, meta, {
      enrichment: enrichmentStart(deps, meta),
      id: videoId,
      thumbnailKey: tKey,
      storageKey: vKey,
      duration: meta.duration ?? Math.round(probe.durationSeconds),
      width: probe.width ?? null,
      height: probe.height ?? null,
      videoCodec: probe.videoCodec,
      fileSizeBytes: size,
    });
    await repo.transitionJob(job.id, 'COMPLETED', { videoId: video.id });
    if (deps.enqueuePlaces) {
      let frames: Buffer[] = [];
      try {
        // A video that announces a count may need a second, denser look, so extract twice as many frames up front.
        const base = framesFor(probe.durationSeconds, deps.placeFrames ?? DEFAULT_PLACE_FRAMES);
        const count = announcedPlaces(meta) !== null && base > 0 ? Math.min(base * 2, MAX_EXTRA_FRAMES) : base;
        frames = (await deps.frameExtractor?.extract(file, probe.durationSeconds, count)) ?? [];
      } catch {
        frames = []; // place enrichment is best-effort
      }
      queuePlaces(deps, video, meta, frames);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The place count the video announces in its own title or caption, if any. */
function announcedPlaces(meta: SocialVideoResult): number | null {
  return expectedPlaceCount([meta.title, meta.description].filter(Boolean).join('\n'));
}

/** Videos start as 'processing' when enrichment is on, so the apps know more places may still arrive. */
function enrichmentStart(deps: WorkerDeps, meta: SocialVideoResult) {
  return deps.enqueuePlaces ? { state: 'processing' as const, expectedPlaces: announcedPlaces(meta) } : null;
}

function queuePlaces(deps: WorkerDeps, video: VideoRow, meta: SocialVideoResult, frames: Buffer[]): void {
  if (!deps.enqueuePlaces) return;
  try {
    deps.enqueuePlaces({
      videoId: video.id,
      userId: video.userId,
      input: { title: meta.title, description: meta.description, hashtags: meta.hashtags, locations: meta.locations ?? [], expectedPlaces: announcedPlaces(meta) },
      frames,
    });
  } catch {
    // never let enrichment affect the import
  }
}

type StoredFields = Pick<NewVideo, 'storageKey' | 'thumbnailKey' | 'duration' | 'width' | 'height' | 'videoCodec' | 'fileSizeBytes'> &
  Partial<Pick<NewVideo, 'id' | 'playbackKind' | 'embedUrl' | 'thumbnailUrl' | 'enrichment'>>;

/** Persists the video row; if a concurrent job for the same video won the race, reuses the winner. */
async function saveVideo(repo: Repo, job: JobRow, meta: SocialVideoResult, stored: StoredFields): Promise<VideoRow> {
  try {
    return await repo.createVideo({
      userId: job.userId,
      platform: job.platform,
      sourceUrl: job.sourceUrl,
      normalizedUrl: job.normalizedUrl,
      contentId: meta.contentId,
      authorUsername: meta.authorUsername || null,
      authorDisplayName: meta.authorDisplayName,
      title: meta.title,
      description: meta.description,
      publishedAt: meta.publishedAt ? new Date(meta.publishedAt) : null,
      viewCount: meta.viewCount,
      likeCount: meta.likeCount,
      commentCount: meta.commentCount,
      repostCount: meta.repostCount,
      saveCount: meta.saveCount,
      musicTitle: meta.musicTitle,
      musicArtist: meta.musicArtist,
      authorId: meta.authorId,
      authorUrl: meta.authorUrl,
      hashtags: meta.hashtags,
      locations: meta.locations ?? [],
      ...stored,
    });
  } catch (e) {
    if (!(e instanceof DuplicateVideoError)) throw e;
    const winner = await repo.findVideoByDedup(job.userId, job.platform, meta.contentId, job.normalizedUrl);
    if (!winner) throw e;
    return winner;
  }
}
