import type { ParsedSocialUrl } from './urls.js';

// Strict allowlists for X, Pinterest, Reddit and Threads. Anything not matching is rejected.

const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const X_STATUS = /^\/([A-Za-z0-9_]{1,15}|i)\/status\/(\d{5,25})(?:\/(?:video|photo)\/\d{1,2})?\/?$/;

const PINTEREST_HOST = /^(?:(?:www|[a-z]{2})\.)?pinterest\.com$/;
const PINTEREST_PIN = /^\/pin\/(\d{5,25})\/?$/;
const PINTEREST_SHORT_HOST = 'pin.it';
const PINTEREST_SHORT = /^\/([A-Za-z0-9]{4,20})\/?$/;

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com']);
const REDDIT_POST = /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{5,10})(?:\/[A-Za-z0-9_%-]{0,200})?\/?$/;
const REDDIT_SHARE = /^\/r\/([A-Za-z0-9_]{2,21})\/s\/([A-Za-z0-9]{5,20})\/?$/;
const REDDIT_SHORT_HOST = 'redd.it';
const REDDIT_SHORT = /^\/([a-z0-9]{5,10})\/?$/;

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_SHORTS = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/;
const YT_SHORT_HOST = 'youtu.be';
const YT_SHORT_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/;

const THREADS_HOSTS = new Set(['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com']);
const THREADS_POST = /^\/@([A-Za-z0-9._]{1,30})\/post\/([A-Za-z0-9_-]{5,20})\/?$/;

const yt = (id: string, shorts: boolean): ParsedSocialUrl => ({
  platform: 'youtube',
  contentId: id,
  normalizedUrl: shorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
});

export function parseExtraPlatforms(host: string, path: string, params: URLSearchParams = new URLSearchParams()): ParsedSocialUrl | null {
  if (YT_HOSTS.has(host)) {
    const m = YT_SHORTS.exec(path);
    if (m) return yt(m[1]!, true);
    if (path === '/watch' || path === '/watch/') {
      const v = params.get('v');
      return v && YT_ID.test(v) ? yt(v, false) : null;
    }
    return null;
  }
  if (host === YT_SHORT_HOST) {
    const m = YT_SHORT_PATH.exec(path);
    return m ? yt(m[1]!, false) : null;
  }

  if (X_HOSTS.has(host)) {
    const m = X_STATUS.exec(path);
    if (m) {
      return { platform: 'x', contentId: m[2]!, normalizedUrl: `https://x.com/${m[1]!.toLowerCase()}/status/${m[2]}` };
    }
    return null;
  }

  if (PINTEREST_HOST.test(host)) {
    const m = PINTEREST_PIN.exec(path);
    return m ? { platform: 'pinterest', contentId: m[1]!, normalizedUrl: `https://www.pinterest.com/pin/${m[1]}/` } : null;
  }
  if (host === PINTEREST_SHORT_HOST) {
    const m = PINTEREST_SHORT.exec(path);
    return m ? { platform: 'pinterest', contentId: null, normalizedUrl: `https://pin.it/${m[1]}` } : null;
  }

  if (REDDIT_HOSTS.has(host)) {
    let m = REDDIT_POST.exec(path);
    if (m) {
      return { platform: 'reddit', contentId: m[2]!, normalizedUrl: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/` };
    }
    m = REDDIT_SHARE.exec(path);
    if (m) return { platform: 'reddit', contentId: null, normalizedUrl: `https://www.reddit.com/r/${m[1]}/s/${m[2]}` };
    return null;
  }
  if (host === REDDIT_SHORT_HOST) {
    const m = REDDIT_SHORT.exec(path);
    return m ? { platform: 'reddit', contentId: m[1]!, normalizedUrl: `https://redd.it/${m[1]}` } : null;
  }

  if (THREADS_HOSTS.has(host)) {
    const m = THREADS_POST.exec(path);
    return m
      ? { platform: 'threads', contentId: m[2]!, normalizedUrl: `https://www.threads.com/@${m[1]!.toLowerCase()}/post/${m[2]}` }
      : null;
  }
  return null;
}
