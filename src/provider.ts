import { parseSocialUrl, type Platform } from './urls.js';
import type { ErrorCode } from './jobs.js';

export interface SocialVideoResult {
  platform: Platform;
  sourceUrl: string;
  contentId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  /** May be temporary; the worker must copy it to our own storage. */
  videoUrl: string;
  duration: number | null;
  publishedAt: string | null;
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
  /** Place names the creator wrote in the caption. Optional; treated as empty when absent. */
  locations?: string[];
  /** 'embed' = played through the platform's official embed; nothing is downloaded or stored. Default 'file'. */
  /** True when thumbnailUrl is short-lived and the worker should keep its own copy. */
  storeThumbnail?: boolean;
  playbackKind?: 'file' | 'embed';
  embedUrl?: string | null;
  /** Headers the CDN requires when downloading videoUrl (e.g. Referer, User-Agent). */
  downloadHeaders?: Record<string, string>;
}

export interface SocialVideoProvider {
  canHandle(url: string): boolean;
  fetchVideo(url: string): Promise<SocialVideoResult>;
  /**
   * Optional. Providers whose media URLs are bound to the extraction session (e.g. TikTok CDN)
   * download the file themselves; otherwise the worker downloads result.videoUrl.
   */
  downloadVideo?(url: string, destPath: string, maxBytes: number): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** First provider whose canHandle() accepts the URL wins. */
export function selectProvider(
  providers: readonly SocialVideoProvider[],
  url: string,
): SocialVideoProvider {
  const p = providers.find((x) => x.canHandle(url));
  if (!p) throw new ProviderError('UNSUPPORTED_PLATFORM', 'no provider for url');
  return p;
}

export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const clean = (s: string | null, max: number): string | null =>
  s === null ? null : s.replace(CONTROL_CHARS, ' ').trim().slice(0, max);

export function sanitize(r: SocialVideoResult): SocialVideoResult {
  return {
    ...r,
    authorUsername: clean(r.authorUsername, 64) ?? '',
    authorDisplayName: clean(r.authorDisplayName, 128),
    title: clean(r.title, 300),
    musicTitle: clean(r.musicTitle, 200),
    musicArtist: clean(r.musicArtist, 200),
    authorId: clean(r.authorId, 128),
    description: clean(r.description, 2000),
    locations: (r.locations ?? []).map((l) => clean(l, 100) ?? '').filter((l) => l.length > 0).slice(0, 5),
    thumbnailUrl: r.thumbnailUrl && isHttpsUrl(r.thumbnailUrl) ? r.thumbnailUrl : null,
  };
}
