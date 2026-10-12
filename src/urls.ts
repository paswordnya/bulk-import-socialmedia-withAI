export type Platform = 'tiktok' | 'instagram' | 'facebook' | 'x' | 'pinterest' | 'reddit' | 'threads' | 'youtube';

export type UrlErrorCode = 'INVALID_URL' | 'UNSUPPORTED_PLATFORM';

export class SocialUrlError extends Error {
  constructor(
    public readonly code: UrlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SocialUrlError';
  }
}

export interface ParsedSocialUrl {
  platform: Platform;
  /** Null for TikTok short links, which only resolve to an ID after fetching. */
  contentId: string | null;
  normalizedUrl: string;
}

import { parseExtraPlatforms } from './urlsExtra.js';

const MAX_URL_LENGTH = 2048;

const TIKTOK_FULL_HOSTS = new Set(['www.tiktok.com', 'tiktok.com']);
const TIKTOK_SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const INSTAGRAM_HOSTS = new Set(['www.instagram.com', 'instagram.com']);

const FACEBOOK_HOSTS = new Set(['www.facebook.com', 'facebook.com', 'm.facebook.com', 'web.facebook.com']);
const FACEBOOK_SHORT_HOST = 'fb.watch';

const FB_ID = '(\\d{5,25})';
const FB_REEL_PATH = new RegExp(`^/reel/${FB_ID}/?$`);
const FB_WATCH_PATHS = new Set(['/watch', '/watch/', '/video.php']);
const FB_PAGE_VIDEO_PATH = new RegExp(`^/([A-Za-z0-9._-]{1,80})/videos/(?:[^/]{1,200}/)?${FB_ID}/?$`);
const FB_SHARE_PATH = /^\/share\/(?:v|r)\/([A-Za-z0-9_-]{5,40})\/?$/;
const FB_SHORT_PATH = /^\/([A-Za-z0-9_-]{4,40})\/?$/;

const TIKTOK_VIDEO_PATH = /^\/@([A-Za-z0-9._]{1,64})\/video\/(\d{1,25})\/?$/;
const TIKTOK_SHORT_PATH = /^\/([A-Za-z0-9]{4,32})\/?$/;
const INSTAGRAM_PATH = /^\/(?:reel|p)\/([A-Za-z0-9_-]{5,32})\/?$/;

/**
 * Strict allowlist parser. Server-side this is the only gate before a URL is
 * handed to a provider, so anything not matching an explicit pattern is rejected.
 */
export function parseSocialUrl(input: string): ParsedSocialUrl {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new SocialUrlError('INVALID_URL', 'Please enter a valid TikTok or Instagram URL.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SocialUrlError('INVALID_URL', 'Please enter a valid TikTok or Instagram URL.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new SocialUrlError('UNSUPPORTED_PLATFORM', 'This URL isn\'t supported.');
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (TIKTOK_FULL_HOSTS.has(host)) {
    const m = TIKTOK_VIDEO_PATH.exec(path);
    if (m) {
      return {
        platform: 'tiktok',
        contentId: m[2]!,
        normalizedUrl: `https://www.tiktok.com/@${m[1]!.toLowerCase()}/video/${m[2]}`,
      };
    }
  } else if (TIKTOK_SHORT_HOSTS.has(host)) {
    const m = TIKTOK_SHORT_PATH.exec(path);
    if (m) {
      return { platform: 'tiktok', contentId: null, normalizedUrl: `https://${host}/${m[1]}` };
    }
  } else if (INSTAGRAM_HOSTS.has(host)) {
    const m = INSTAGRAM_PATH.exec(path);
    if (m) {
      const kind = path.startsWith('/reel/') ? 'reel' : 'p';
      return {
        platform: 'instagram',
        contentId: m[1]!,
        normalizedUrl: `https://www.instagram.com/${kind}/${m[1]}/`,
      };
    }
  }

  if (FACEBOOK_HOSTS.has(host)) {
    const fb = parseFacebookPath(path, url.searchParams);
    if (fb) return fb;
  } else if (host === FACEBOOK_SHORT_HOST) {
    const m = FB_SHORT_PATH.exec(path);
    if (m) return { platform: 'facebook', contentId: null, normalizedUrl: `https://fb.watch/${m[1]}/` };
  }

  const extra = parseExtraPlatforms(host, path, url.searchParams);
  if (extra) return extra;

  throw new SocialUrlError('UNSUPPORTED_PLATFORM', 'This URL isn\'t supported.');
}

function parseFacebookPath(path: string, params: URLSearchParams): ParsedSocialUrl | null {
  let m = FB_REEL_PATH.exec(path);
  if (m) return fbResult(m[1]!, `https://www.facebook.com/reel/${m[1]}`);

  if (FB_WATCH_PATHS.has(path)) {
    const v = params.get('v');
    if (v && /^\d{5,25}$/.test(v)) return fbResult(v, `https://www.facebook.com/watch/?v=${v}`);
    return null;
  }

  m = FB_PAGE_VIDEO_PATH.exec(path);
  if (m) return fbResult(m[2]!, `https://www.facebook.com/${m[1]!.toLowerCase()}/videos/${m[2]}`);

  m = FB_SHARE_PATH.exec(path);
  if (m) {
    const kind = path.startsWith('/share/v/') ? 'v' : 'r';
    return { platform: 'facebook', contentId: null, normalizedUrl: `https://www.facebook.com/share/${kind}/${m[1]}/` };
  }
  return null;
}

const fbResult = (contentId: string, normalizedUrl: string): ParsedSocialUrl => ({
  platform: 'facebook',
  contentId,
  normalizedUrl,
});

export function isSupportedSocialUrl(input: string): boolean {
  try {
    parseSocialUrl(input);
    return true;
  } catch {
    return false;
  }
}
