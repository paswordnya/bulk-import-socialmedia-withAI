import { extractHashtags, safeProfileUrl, toCount } from './metadata.js';
import { ProviderError, sanitize, type SocialVideoProvider, type SocialVideoResult } from './provider.js';
import { parseSocialUrl } from './urls.js';

export interface YouTubeConfig {
  /** Optional YouTube Data API v3 key. Without it only oEmbed metadata is available (no counts/duration). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const OEMBED = 'https://www.youtube.com/oembed';
const DATA_API = 'https://www.googleapis.com/youtube/v3/videos';
const THUMB_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com']);

export const embedUrlFor = (id: string): string => `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0`;

/** "PT1H2M3S" -> 3723. Returns null for anything unexpected (including live "P0D"). */
export function parseIsoDuration(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return null;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => (x ? Number(x) : 0)) as [number, number, number, number];
  const total = d * 86400 + h * 3600 + mi * 60 + s;
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

/**
 * YouTube is never downloaded or stored (its terms forbid it outside official features).
 * Metadata comes from the public oEmbed endpoint; playback happens in the official embed player.
 */
export class YouTubeEmbedProvider implements SocialVideoProvider {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: YouTubeConfig = {}) {
    this.f = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  canHandle(url: string): boolean {
    try {
      return parseSocialUrl(url).platform === 'youtube';
    } catch {
      return false;
    }
  }

  async fetchVideo(url: string): Promise<SocialVideoResult> {
    const parsed = parseSocialUrl(url);
    const id = parsed.contentId;
    if (parsed.platform !== 'youtube' || !id) throw new ProviderError('UNSUPPORTED_PLATFORM', 'not a youtube video');

    const oe = await this.getJson(`${OEMBED}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {});
    if (oe.status === 404) throw new ProviderError('VIDEO_UNAVAILABLE', 'oembed 404');
    if (oe.status === 401 || oe.status === 403) throw new ProviderError('EMBEDDING_DISABLED', `oembed ${oe.status}`);
    if (oe.status !== 200 || !oe.json || typeof oe.json !== 'object') throw new ProviderError('PROVIDER_ERROR', `oembed ${oe.status}`);
    const o = oe.json as Record<string, unknown>;

    const authorUrl = safeProfileUrl('youtube', o.author_url);
    const handle = authorUrl ? /^\/@([A-Za-z0-9._-]{3,30})$/.exec(new URL(authorUrl).pathname)?.[1] ?? '' : '';
    const thumb = str(o.thumbnail_url);
    const thumbOk = thumb !== null && (() => { try { const u = new URL(thumb); return u.protocol === 'https:' && THUMB_HOSTS.has(u.hostname); } catch { return false; } })();
    const embed = embedUrlFor(id);

    const result: SocialVideoResult = {
      platform: 'youtube',
      sourceUrl: parsed.normalizedUrl,
      contentId: id,
      authorUsername: handle,
      authorDisplayName: str(o.author_name),
      title: str(o.title),
      description: null,
      thumbnailUrl: thumbOk ? thumb : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      videoUrl: embed,
      playbackKind: 'embed',
      embedUrl: embed,
      duration: null,
      publishedAt: null,
      viewCount: null,
      likeCount: null,
      commentCount: null,
      repostCount: null,
      saveCount: null,
      musicTitle: null,
      musicArtist: null,
      authorId: null,
      authorUrl,
      hashtags: extractHashtags(str(o.title)),
    };

    if (this.cfg.apiKey) await this.enrich(id, result);
    return sanitize(result);
  }

  /** Best-effort: any failure leaves the oEmbed data as is. A video that forbids embedding is still rejected. */
  private async enrich(id: string, r: SocialVideoResult): Promise<void> {
    const res = await this.getJson(
      `${DATA_API}?part=snippet,statistics,contentDetails,status&id=${encodeURIComponent(id)}`,
      { 'x-goog-api-key': this.cfg.apiKey! },
    ).catch(() => null);
    const item = res && res.status === 200 ? (res.json as { items?: unknown[] } | null)?.items?.[0] : undefined;
    if (!item || typeof item !== 'object') return;
    const it = item as {
      snippet?: Record<string, unknown>; statistics?: Record<string, unknown>;
      contentDetails?: Record<string, unknown>; status?: Record<string, unknown>;
    };
    if (it.status?.embeddable === false) throw new ProviderError('EMBEDDING_DISABLED', 'embeddable=false');

    const count = (v: unknown) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? toCount(Number(v)) : null);
    r.viewCount = count(it.statistics?.viewCount);
    r.likeCount = count(it.statistics?.likeCount);
    r.commentCount = count(it.statistics?.commentCount);
    r.duration = parseIsoDuration(it.contentDetails?.duration);
    const published = str(it.snippet?.publishedAt);
    r.publishedAt = published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null;
    r.description = str(it.snippet?.description);
    const channelId = str(it.snippet?.channelId);
    r.authorId = channelId && /^[A-Za-z0-9_-]{10,40}$/.test(channelId) ? channelId : null;
    r.hashtags = extractHashtags(`${r.title ?? ''} ${r.description ?? ''}`);
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.f(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new ProviderError(timedOut ? 'IMPORT_TIMEOUT' : 'PROVIDER_ERROR', 'youtube request failed');
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }
}
