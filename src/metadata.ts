import type { Platform } from './urls.js';

/** Counts must be non-negative safe integers; anything else (strings, floats, negatives) becomes null. */
export function toCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

const HASHTAG_RE = /#([\p{L}\p{N}_]{1,100})/gu;

export function extractHashtags(text: string | null | undefined, max = 30): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(HASHTAG_RE)) {
    const tag = m[1]!;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

const FB_STATS_SEGMENT = /^\s*(?:[\d.,]+\s*[KMB]?\s+(?:views?|reactions?|likes?|comments?|shares?|plays?)(?:\s*[·•]\s*)?)+\s*$/i;

/** Facebook titles often start with "754K views · 10K reactions | real title". Drop the stats prefix. */
export function cleanFacebookTitle(title: string | null): string | null {
  if (!title) return title;
  let t = title;
  for (;;) {
    const i = t.indexOf('|');
    if (i < 0 || !FB_STATS_SEGMENT.test(t.slice(0, i))) break;
    t = t.slice(i + 1);
  }
  t = t.trim();
  return t.length > 0 ? t : null;
}

const PROFILE_HOSTS: Record<Platform, RegExp> = {
  tiktok: /^(?:www\.)?tiktok\.com$/,
  instagram: /^(?:www\.)?instagram\.com$/,
  facebook: /^(?:www\.|m\.|web\.)?facebook\.com$/,
  x: /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/,
  pinterest: /^(?:(?:www|[a-z]{2})\.)?pinterest\.com$/,
  reddit: /^(?:www\.|old\.|m\.)?reddit\.com$/,
  threads: /^(?:www\.)?threads\.(?:net|com)$/,
  youtube: /^(?:www\.|m\.)?youtube\.com$/,
};

/** Profile links are shown to users, so only https links on the platform's own domain are kept. */
export function safeProfileUrl(platform: Platform, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (!PROFILE_HOSTS[platform].test(u.hostname.toLowerCase())) return null;
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Instagram's generic fallback title ("Video by <user>") carries no information. */
export function cleanInstagramTitle(title: string | null): string | null {
  if (!title) return title;
  return /^(?:video|reel|photo)s? by\s+\S.*$/i.test(title.trim()) && title.trim().length < 80 ? null : title;
}

const IG_HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** yt-dlp gives no profile URL for Instagram; a validated handle maps to a canonical one. */
export function instagramProfileUrl(handle: string | null): string | null {
  return handle && IG_HANDLE.test(handle) ? `https://www.instagram.com/${handle}/` : null;
}

const HANDLE_RULES: Partial<Record<Platform, { re: RegExp; url: (h: string) => string }>> = {
  instagram: { re: /^[A-Za-z0-9._]{1,30}$/, url: (h) => `https://www.instagram.com/${h}/` },
  x: { re: /^[A-Za-z0-9_]{1,15}$/, url: (h) => `https://x.com/${h}` },
  pinterest: { re: /^[A-Za-z0-9_]{3,30}$/, url: (h) => `https://www.pinterest.com/${h}/` },
  reddit: { re: /^[A-Za-z0-9_-]{3,20}$/, url: (h) => `https://www.reddit.com/user/${h}/` },
  threads: { re: /^[A-Za-z0-9._]{1,30}$/, url: (h) => `https://www.threads.com/@${h}` },
  youtube: { re: /^[A-Za-z0-9._-]{3,30}$/, url: (h) => `https://www.youtube.com/@${h}` },
};

/** Canonical profile link from a validated handle, for platforms where yt-dlp gives none. */
export function profileUrlFromHandle(platform: Platform, handle: string | null): string | null {
  const rule = HANDLE_RULES[platform];
  return rule && handle && rule.re.test(handle) ? rule.url(handle) : null;
}

/** yt-dlp builds X titles as "<display name> - <tweet text>", which only repeats the description. */
export function cleanXTitle(title: string | null, displayName: string | null): string | null {
  if (!title) return title;
  if (displayName && title.startsWith(`${displayName} - `)) return null;
  return title;
}

// A place name runs from a marker to the end of the line, or to the next hashtag, mention, or emoji.
const LOCATION_STOP = String.raw`[^\n#@\p{Extended_Pictographic}️‍]`;
const PIN_RE = new RegExp(String.raw`\u{1F4CD}️?\s*(${LOCATION_STOP}{2,100})`, 'gu');
const LABEL_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:location|lokasi|loc)\s*[:：]\s*(${LOCATION_STOP}{2,100})`, 'giu');
const TRAILING_PUNCT = /[\s.,;:!?|/\\\-–—_*~"'`]+$/u;
const URL_LIKE = /https?:\/\/|www\./i;

/**
 * Place names a creator wrote in the caption: after a 📍 pin, or after "Location:" / "Lokasi:" / "Loc:".
 * Best effort only: it finds what the creator typed, not the platform's own location tag.
 */
export function extractLocations(text: string | null | undefined, max = 5): string[] {
  if (!text || max <= 0) return [];
  const found: { index: number; value: string }[] = [];
  for (const re of [PIN_RE, LABEL_RE]) {
    for (const m of text.matchAll(re)) {
      const value = m[1]!.replace(TRAILING_PUNCT, '').trim();
      if (value.length < 2 || URL_LIKE.test(value) || !/[\p{L}\p{N}]/u.test(value)) continue;
      found.push({ index: m.index ?? 0, value });
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { value } of found.sort((a, b) => a.index - b.index)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}
