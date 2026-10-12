import { execFile } from 'node:child_process';
import { parseSocialUrl } from './urls.js';
import { InvalidMediaError } from './media.js';
import { cleanFacebookTitle, cleanInstagramTitle, cleanXTitle, extractHashtags, extractLocations, profileUrlFromHandle, safeProfileUrl, toCount } from './metadata.js';
import {
  ProviderError,
  isHttpsUrl,
  sanitize,
  type SocialVideoProvider,
  type SocialVideoResult,
} from './provider.js';

export interface ExecOptions {
  timeoutMs: number;
  maxBufferBytes: number;
}

/** Injectable so unit tests never spawn a process. Must not use a shell. */
export type Exec = (args: string[], opts: ExecOptions) => Promise<{ stdout: string }>;

export interface YtDlpConfig {
  /** Allow downloading YouTube (YOUTUBE_MODE=download). Off by default: YouTube is embed-only. */
  allowYoutube?: boolean;
  binaryPath?: string;
  timeoutMs?: number;
  exec?: Exec;
}

/** Prefer a single progressive mp4; fall back to merging separate video+audio (needs ffmpeg), e.g. Reddit. */
const FORMAT_SELECTOR = 'best[ext=mp4][protocol=https]/best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';

/** YouTube serves video and audio separately; merge H.264 mp4 video (max 1080p) with m4a audio so every player can play it. */
const YOUTUBE_SELECTOR =
  'bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

const selectorFor = (platform: string): string => (platform === 'youtube' ? YOUTUBE_SELECTOR : FORMAT_SELECTOR);

/** Any available format, including HLS (downloaded and remuxed with ffmpeg). Used only after the first attempt fails. */
const FALLBACK_SELECTOR = 'best';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

const PRIVATE_RE = /private|log ?in|sign ?in|authentication|cookies|age[- ]restricted|rate-limit/i;
const GONE_RE = /unavailable|removed|deleted|not found|404|no longer|does not exist/i;

export function createExecFile(binaryPath: string): Exec {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      execFile(
        binaryPath,
        args,
        { timeout: opts.timeoutMs, maxBuffer: opts.maxBufferBytes, shell: false, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            reject(Object.assign(new Error(String(stderr || e.message)), { killed: e.killed === true }));
          } else resolve({ stdout: String(stdout) });
        },
      );
    });
}

/**
 * Self-hosted provider. Resolves metadata and a direct media URL with yt-dlp
 * (no download happens here); the worker downloads and validates the file.
 * URL is re-validated against the allowlist and passed as a single argv entry
 * after "--", so it can never be parsed as an option.
 */
export class YtDlpSocialVideoProvider implements SocialVideoProvider {
  private readonly exec: Exec;
  private readonly timeoutMs: number;
  private readonly allowYoutube: boolean;

  constructor(cfg: YtDlpConfig = {}) {
    this.allowYoutube = cfg.allowYoutube === true;
    this.exec = cfg.exec ?? createExecFile(cfg.binaryPath ?? 'yt-dlp');
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** YouTube is deliberately excluded: it is only ever played through its official embed (see youtube.ts). */
  canHandle(url: string): boolean {
    try {
      const p = parseSocialUrl(url).platform;
      return p !== 'threads' && (p !== 'youtube' || this.allowYoutube);
    } catch {
      return false;
    }
  }

  async fetchVideo(url: string): Promise<SocialVideoResult> {
    const parsed = parseSocialUrl(url);
    if (parsed.platform === 'threads' || (parsed.platform === 'youtube' && !this.allowYoutube)) {
      throw new ProviderError('UNSUPPORTED_PLATFORM', 'embed-only platform');
    }

    let stdout: string;
    try {
      ({ stdout } = await this.exec(
        [
          '--dump-single-json',
          '--no-playlist',
          '--no-warnings',
          '--no-config',
          '--no-cookies-from-browser',
          '-f',
          selectorFor(parsed.platform),
          '--merge-output-format',
          'mp4',
          '--',
          parsed.normalizedUrl,
        ],
        { timeoutMs: this.timeoutMs, maxBufferBytes: MAX_JSON_BYTES },
      ));
    } catch (e) {
      throw classifyFailure(e);
    }

    let info: Record<string, unknown>;
    try {
      const v = JSON.parse(stdout) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      info = v as Record<string, unknown>;
    } catch {
      throw new ProviderError('PROVIDER_ERROR', 'unparseable yt-dlp output');
    }

    return sanitize(mapInfo(parsed.platform, parsed.normalizedUrl, parsed.contentId, info));
  }

  async downloadVideo(url: string, destPath: string, maxBytes: number): Promise<void> {
    const parsed = parseSocialUrl(url);
    if (parsed.platform === 'threads' || (parsed.platform === 'youtube' && !this.allowYoutube)) {
      throw new ProviderError('UNSUPPORTED_PLATFORM', 'embed-only platform');
    }

    const run = (selector: string) =>
      this.exec(
        [
          '--no-playlist',
          '--no-warnings',
          '--no-config',
          '--no-part',
          '--no-mtime',
          '--max-filesize',
          String(maxBytes),
          '--socket-timeout',
          '20',
          '-f',
          selector,
          '--merge-output-format',
          'mp4',
          '-o',
          destPath.replace(/%/g, '%%'),
          '--',
          parsed.normalizedUrl,
        ],
        { timeoutMs: this.timeoutMs * 3, maxBufferBytes: MAX_JSON_BYTES },
      );

    let stdout = '';
    try {
      ({ stdout } = await run(selectorFor(parsed.platform)));
    } catch (first) {
      // Some platforms (e.g. X) list progressive mp4 URLs that 404 while HLS works. Retry once with any format.
      // Timeouts and private content would fail the same way, so they are not retried.
      const firstError = classifyFailure(first);
      if (['IMPORT_TIMEOUT', 'PRIVATE_CONTENT', 'UNSUPPORTED_PLATFORM'].includes(firstError.code)) throw firstError;
      try {
        ({ stdout } = await run(FALLBACK_SELECTOR));
      } catch (second) {
        throw classifyFailure(second);
      }
    }
    // yt-dlp exits 0 without writing a file when --max-filesize is exceeded.
    if (/larger than max-filesize/i.test(stdout)) throw new InvalidMediaError('file too large', 'TOO_LARGE');
  }
}

export function classifyFailure(e: unknown): ProviderError {
  const err = e as { killed?: boolean; message?: string };
  if (err?.killed) return new ProviderError('IMPORT_TIMEOUT', 'yt-dlp timed out');
  const msg = err?.message ?? '';
  // No extractor for this site in the installed yt-dlp: retrying can never help.
  if (/unsupported url/i.test(msg)) return new ProviderError('UNSUPPORTED_PLATFORM', 'no yt-dlp extractor');
  if (PRIVATE_RE.test(msg)) return new ProviderError('PRIVATE_CONTENT', 'content not public');
  if (GONE_RE.test(msg)) return new ProviderError('VIDEO_UNAVAILABLE', 'video unavailable');
  // Raw stderr is intentionally not propagated; callers log it server-side if needed.
  return new ProviderError('PROVIDER_ERROR', 'yt-dlp failed');
}

const validDate = (iso: string | null): string | null => (iso !== null && !Number.isNaN(Date.parse(iso)) ? iso : null);

const firstString = (v: unknown): string | null =>
  Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0 ? v[0] : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * yt-dlp's uploader/channel fields mean different things per extractor.
 * TikTok: uploader = @handle, channel = display name. Instagram: the reverse.
 * X/Pinterest/Threads: uploader = display name, uploader_id = handle. Reddit: uploader = u/name.
 * YouTube: uploader = channel name, uploader_id = "@handle".
 */
function authorFields(
  platform: SocialVideoResult['platform'],
  info: Record<string, unknown>,
): { authorUsername: string; authorDisplayName: string | null } {
  switch (platform) {
    case 'instagram':
      return { authorUsername: str(info.channel) ?? str(info.uploader) ?? '', authorDisplayName: str(info.uploader) ?? str(info.channel) };
    case 'x':
    case 'pinterest':
    case 'threads':
      return { authorUsername: str(info.uploader_id) ?? str(info.uploader) ?? '', authorDisplayName: str(info.uploader) ?? str(info.channel) };
    case 'reddit':
      return { authorUsername: str(info.uploader) ?? str(info.uploader_id) ?? '', authorDisplayName: null };
    case 'youtube': {
      // uploader = channel name, uploader_id = "@handle".
      const handle = str(info.uploader_id)?.replace(/^@/, '') ?? '';
      return { authorUsername: /^[A-Za-z0-9._-]{3,30}$/.test(handle) ? handle : '', authorDisplayName: str(info.uploader) ?? str(info.channel) };
    }
    default:
      return { authorUsername: str(info.uploader) ?? str(info.uploader_id) ?? '', authorDisplayName: str(info.channel) ?? str(info.uploader) };
  }
}

export function mapInfo(
  platform: SocialVideoResult['platform'],
  sourceUrl: string,
  urlContentId: string | null,
  info: Record<string, unknown>,
): SocialVideoResult {
  const requested = Array.isArray(info.requested_formats) ? (info.requested_formats[0] as { url?: unknown } | undefined) : undefined;
  const videoUrl = str(info.url) ?? str(requested?.url);
  if (!videoUrl || !isHttpsUrl(videoUrl)) {
    throw new ProviderError('VIDEO_UNAVAILABLE', 'missing or non-https media url');
  }
  if (info.ext !== undefined && info.ext !== 'mp4') {
    throw new ProviderError('INVALID_MEDIA', `unexpected ext ${String(info.ext)}`);
  }

  // yt-dlp reports the media id for X tweets, not the tweet id the user pasted; prefer the url id there.
  const contentId = platform === 'x' ? urlContentId ?? str(info.id) : str(info.id) ?? urlContentId;
  if (!contentId) throw new ProviderError('PROVIDER_ERROR', 'no content id');

  const duration = typeof info.duration === 'number' && info.duration > 0 ? Math.round(info.duration) : null;
  const uploadDate = typeof info.upload_date === 'string' && /^\d{8}$/.test(info.upload_date)
    ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}T00:00:00.000Z`
    : null;
  const ts = typeof info.timestamp === 'number' ? new Date(info.timestamp * 1000).toISOString() : validDate(uploadDate);

  const rawHeaders = info.http_headers;
  const downloadHeaders: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v === 'string' && /^(user-agent|referer|accept|accept-language)$/i.test(k)) downloadHeaders[k] = v;
    }
  }

  return {
    platform,
    sourceUrl,
    contentId,
    ...authorFields(platform, info),
    title:
      platform === 'facebook'
        ? cleanFacebookTitle(str(info.title))
        : platform === 'instagram'
          ? cleanInstagramTitle(str(info.title))
          : platform === 'x'
            ? cleanXTitle(str(info.title), str(info.uploader))
            : str(info.title),
    description: str(info.description),
    thumbnailUrl: str(info.thumbnail),
    videoUrl,
    duration,
    publishedAt: ts,
    viewCount: toCount(info.view_count),
    likeCount: toCount(info.like_count),
    commentCount: toCount(info.comment_count),
    repostCount: toCount(info.repost_count),
    saveCount: toCount(info.save_count),
    musicTitle: str(info.track),
    musicArtist: str(info.artist) ?? firstString(info.artists),
    authorId: platform === 'youtube' ? str(info.channel_id) ?? str(info.uploader_id) : str(info.uploader_id) ?? str(info.channel_id),
    authorUrl:
      safeProfileUrl(platform, info.uploader_url) ??
      safeProfileUrl(platform, info.channel_url) ??
      profileUrlFromHandle(platform, platform === 'instagram' ? str(info.channel) : authorFields(platform, info).authorUsername),
    hashtags: extractHashtags(str(info.description) ?? str(info.title)),
    locations: platform === 'tiktok' || platform === 'instagram' ? extractLocations(str(info.description) ?? str(info.title)) : [],
    downloadHeaders,
  };
}
