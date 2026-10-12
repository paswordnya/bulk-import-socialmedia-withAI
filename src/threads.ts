import { extractHashtags } from './metadata.js';
import { ProviderError, sanitize, type SocialVideoProvider, type SocialVideoResult } from './provider.js';
import { parseSocialUrl } from './urls.js';

export interface ThreadsConfig {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const PAGE_HOSTS = new Set(['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net']);
const THUMB_HOST = /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/;
const MAX_HTML_CHARS = 3_000_000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** Reads one OpenGraph property from HTML (attribute order tolerant). */
export function ogTag(html: string, prop: string): string | null {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const re of [
    new RegExp(`<meta[^>]+property=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${esc}["']`, 'i'),
  ]) {
    const m = re.exec(html);
    if (m) return decodeEntities(m[1]!);
  }
  return null;
}

/**
 * Threads has no downloadable media without login. This provider links a post through Threads' own
 * public embed page (nothing is downloaded or stored except the preview image) and reads the public
 * OpenGraph link-preview tags. Posts without a video are rejected.
 */
export class ThreadsEmbedProvider implements SocialVideoProvider {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: ThreadsConfig = {}) {
    this.f = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 12_000;
  }

  canHandle(url: string): boolean {
    try {
      return parseSocialUrl(url).platform === 'threads';
    } catch {
      return false;
    }
  }

  async fetchVideo(url: string): Promise<SocialVideoResult> {
    const parsed = parseSocialUrl(url);
    const m = /^https:\/\/www\.threads\.com\/@([a-z0-9._]+)\/post\/([A-Za-z0-9_-]+)$/.exec(parsed.normalizedUrl);
    if (parsed.platform !== 'threads' || !m) throw new ProviderError('UNSUPPORTED_PLATFORM', 'not a threads post');
    const [, handle, code] = m as unknown as [string, string, string];
    const embedUrl = `${parsed.normalizedUrl}/embed`;

    // Embed page first: it tells us whether the post is public and contains a video.
    const embed = await this.getHtml(embedUrl);
    if (embed.status === 404 || embed.status === 410) throw new ProviderError('VIDEO_UNAVAILABLE', 'threads 404');
    if (embed.status === 401 || embed.status === 403) throw new ProviderError('PRIVATE_CONTENT', 'threads 403');
    if (embed.status !== 200) throw new ProviderError('PROVIDER_ERROR', `threads ${embed.status}`);
    if (!/<video[\s>]/i.test(embed.html)) throw new ProviderError('INVALID_MEDIA', 'no video in post');

    const page = await this.getHtml(parsed.normalizedUrl);
    const og = page.status === 200 ? page.html : '';

    const title = ogTag(og, 'og:title');
    const display = title ? /^[:\s]*(.*?)\s*\(@[A-Za-z0-9._]+\)\s*on Threads\s*$/i.exec(title)?.[1]?.trim() || null : null;
    const caption = ogTag(og, 'og:description');
    const image = ogTag(og, 'og:image');
    const imageOk = image !== null && (() => { try { const u = new URL(image); return u.protocol === 'https:' && THUMB_HOST.test(u.hostname); } catch { return false; } })();

    return sanitize({
      platform: 'threads',
      sourceUrl: parsed.normalizedUrl,
      contentId: code,
      authorUsername: handle,
      authorDisplayName: display,
      title: null,
      description: caption && caption.trim() ? caption : null,
      thumbnailUrl: imageOk ? image : null,
      // Preview image URLs are signed and expire, so the worker keeps its own copy.
      storeThumbnail: imageOk,
      videoUrl: embedUrl,
      playbackKind: 'embed',
      embedUrl,
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
      authorUrl: `https://www.threads.com/@${handle}`,
      hashtags: extractHashtags(caption),
    });
  }

  private async getHtml(url: string): Promise<{ status: number; html: string }> {
    let res: Response;
    try {
      res = await this.f(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new ProviderError(timedOut ? 'IMPORT_TIMEOUT' : 'PROVIDER_ERROR', 'threads request failed');
    }
    // A redirect off the Threads hosts (e.g. a login page) means the post is not publicly viewable.
    try {
      if (res.url && !PAGE_HOSTS.has(new URL(res.url).hostname.toLowerCase())) throw new ProviderError('PRIVATE_CONTENT', 'redirected away');
      if (res.url && /\/(?:login|accounts)\b/.test(new URL(res.url).pathname)) throw new ProviderError('PRIVATE_CONTENT', 'login redirect');
    } catch (e) {
      if (e instanceof ProviderError) throw e;
    }
    let html = '';
    try {
      html = await res.text();
    } catch {
      html = '';
    }
    if (html.length > MAX_HTML_CHARS) throw new ProviderError('PROVIDER_ERROR', 'page too large');
    return { status: res.status, html };
  }
}
