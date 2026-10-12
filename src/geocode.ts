export interface GeoPoint {
  latitude: number;
  longitude: number;
  displayName: string | null;
  /** Nominatim place_rank: 2 continent, 4 country, 8 state/region, up to 30 for buildings. null when absent. */
  placeRank: number | null;
  /** Nominatim addresstype, for example "country", "state", "city", "tourism". null when absent. */
  addressType: string | null;
  /** Nominatim category and type (for example natural / peak), used to label the kind of place. */
  placeCategory: string | null;
  placeType: string | null;
}

export interface Geocoder {
  /** null when the place is not found. Throws on transport or HTTP failure (callers treat that as "unknown"). */
  geocode(query: string): Promise<GeoPoint | null>;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const MAX_QUERY = 200;

/**
 * OpenStreetMap Nominatim. The public server's policy: identify the app with a User-Agent, at most one request
 * per second, cache results, and show OSM attribution. Requests are serialized and spaced to honor that.
 */
export class NominatimGeocoder implements Geocoder {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, GeoPoint | null>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;

  constructor(
    private readonly opts: {
      userAgent: string;
      baseUrl?: string;
      fetch?: FetchLike;
      minIntervalMs?: number;
      cacheSize?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    if (!opts.userAgent.trim()) throw new Error('Nominatim requires an identifying User-Agent');
    const base = (opts.baseUrl ?? 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('GEOCODER_URL must be http or https');
    this.baseUrl = base;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  geocode(query: string): Promise<GeoPoint | null> {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q.length < 2 || q.length > MAX_QUERY) return Promise.resolve(null);
    const key = q.toLowerCase();
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key)!);
    // One at a time, so the spacing below is accurate even when callers race.
    const run = this.chain.then(() => this.lookup(q, key));
    this.chain = run.catch(() => {});
    return run;
  }

  private async lookup(q: string, key: string): Promise<GeoPoint | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const wait = (this.opts.minIntervalMs ?? 1100) - (this.now() - this.lastStart);
    if (this.lastStart > 0 && wait > 0) await this.sleep(wait);
    this.lastStart = this.now();
    const url = `${this.baseUrl}/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '1', 'accept-language': 'en' })}`;
    const res = await this.fetchFn(url, { headers: { 'user-agent': this.opts.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`geocoder http ${res.status}`); // not cached: 429 and 5xx are transient
    const body = await res.json();
    const point = Array.isArray(body) ? toPoint(body[0]) : null;
    const limit = this.opts.cacheSize ?? 500;
    if (this.cache.size >= limit) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, point);
    return point;
  }
}

function toPoint(r: unknown): GeoPoint | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as { lat?: unknown; lon?: unknown; display_name?: unknown; place_rank?: unknown; addresstype?: unknown; category?: unknown; type?: unknown };
  const lat = typeof o.lat === 'string' || typeof o.lat === 'number' ? Number(o.lat) : NaN;
  const lon = typeof o.lon === 'string' || typeof o.lon === 'number' ? Number(o.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = typeof o.display_name === 'string' ? o.display_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
  const rank = typeof o.place_rank === 'number' && Number.isInteger(o.place_rank) && o.place_rank >= 0 && o.place_rank <= 30 ? o.place_rank : null;
  const addressType = typeof o.addresstype === 'string' && /^[a-z_]{1,40}$/.test(o.addresstype) ? o.addresstype : null;
  const token = (v: unknown) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : null);
  return { latitude: lat, longitude: lon, displayName: name || null, placeRank: rank, addressType, placeCategory: token(o.category), placeType: token(o.type) };
}
