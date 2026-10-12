import { createWriteStream } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import https from 'node:https';
import { InvalidMediaError } from './media.js';
import { ProviderError } from './provider.js';

export interface Downloader {
  download(url: string, headers: Record<string, string>, destPath: string, maxBytes: number): Promise<number>;
}

export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (fam === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true; // not an IP literal -> treat as unsafe when used as a resolved address
}

/**
 * DNS lookup that refuses private addresses; used at connect time so DNS rebinding can't bypass it.
 * Node may call it with `all: true` (happy eyeballs) and then expects an array of addresses.
 */
export const safeLookup = ((host: string, opts: unknown, cb: unknown) => {
  const options = (typeof opts === 'object' && opts !== null ? opts : {}) as { all?: boolean; family?: number };
  const callback = (typeof opts === 'function' ? opts : cb) as (
    e: Error | null,
    a?: string | Array<{ address: string; family: number }>,
    f?: number,
  ) => void;
  dnsLookup(host, { all: true, family: options.family }, (err, addrs) => {
    if (err) return callback(err);
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      return callback(new Error('blocked address'));
    }
    if (options.all) return callback(null, addrs);
    const first = addrs[0]!;
    callback(null, first.address, first.family);
  });
}) as unknown as typeof dnsLookup;

const MAX_REDIRECTS = 3;

export class HttpsDownloader implements Downloader {
  constructor(private readonly timeoutMs = 60_000) {}

  download(url: string, headers: Record<string, string>, destPath: string, maxBytes: number) {
    return this.get(url, headers, destPath, maxBytes, 0);
  }

  private get(url: string, headers: Record<string, string>, destPath: string, maxBytes: number, depth: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try { u = new URL(url); } catch { return reject(new ProviderError('PROVIDER_ERROR', 'bad media url')); }
      if (u.protocol !== 'https:' || u.username || u.password || isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0) {
        return reject(new ProviderError('PROVIDER_ERROR', 'media url not allowed'));
      }
      const req = https.get(u, { headers, lookup: safeLookup, timeout: this.timeoutMs }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (depth >= MAX_REDIRECTS) return reject(new ProviderError('PROVIDER_ERROR', 'too many redirects'));
          const next = new URL(res.headers.location, u).toString();
          return this.get(next, headers, destPath, maxBytes, depth + 1).then(resolve, reject);
        }
        if (status === 404 || status === 410) { res.resume(); return reject(new ProviderError('VIDEO_UNAVAILABLE', 'media gone')); }
        if (status !== 200) { res.resume(); return reject(new ProviderError('PROVIDER_ERROR', `media http ${status}`)); }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); return reject(new InvalidMediaError('file too large', 'TOO_LARGE')); }

        let bytes = 0;
        const out = createWriteStream(destPath, { flags: 'w', mode: 0o600 });
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes > maxBytes) { req.destroy(); out.destroy(); reject(new InvalidMediaError('file too large', 'TOO_LARGE')); }
        });
        res.pipe(out);
        out.on('finish', () => resolve(bytes));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new ProviderError('IMPORT_TIMEOUT', 'media download timed out')));
      req.on('error', (e) => reject(e instanceof ProviderError ? e : new ProviderError('PROVIDER_ERROR', 'media download failed')));
    });
  }
}
