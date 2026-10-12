/** Where a place name came from. Frame-based names are AI guesses and the UI should present them that way. */
export type PlaceSource = 'caption' | 'text-ai' | 'frame-ai';

/** A place name that still needs coordinates. `area` is an optional city/region/country hint for the geocoder. */
export interface PlaceCandidate {
  name: string;
  area: string | null;
  source: PlaceSource;
  /** Index of the video frame that produced this candidate (frame-ai only). */
  frameIndex?: number | null;
}

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  source: PlaceSource;
  /** Full address line from the geocoder, for display only. */
  displayName: string | null;
  /** Storage key of a frame image showing this place (frame-ai only). */
  photoKey: string | null;
  /** Human label for the kind of place, for example "Mountain peak". */
  category: string | null;
}

/** A place found by the enricher, with the frame it came from so the worker can store that frame as its photo. */
export type EnrichedPlace = Place & { frameIndex: number | null };

export interface VideoSummary {
  title: string | null;
  takeaways: string[];
}

export const MAX_PLACES = 8;
const MAX_NAME = 100;
const MAX_AREA = 80;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const URL_LIKE = /https?:\/\/|www\.|@/i;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/** Lowercase letters and digits only, so "Pantai Kuta" matches the hashtag "#PantaiKuta". */
export function foldName(s: string): string {
  return s.toLowerCase().replace(NON_ALNUM, '');
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > max * 3) return null; // absurdly long output is a bad answer, not something to truncate
  const out = t.slice(0, max).trim();
  return out.length >= 2 && HAS_LETTER_OR_DIGIT.test(out) && !URL_LIKE.test(out) ? out : null;
}

/** Models sometimes wrap JSON in code fences or add a sentence around it. Take the outermost object. */
function jsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Validates an LLM answer of the shape {"places":[{"name":"...","area":"..."}]}. Anything else yields [].
 * `groundedIn`: when given, a name must appear in that text (ignoring case and punctuation), which drops names
 * the model invented. Use it for text answers; image answers cannot be grounded.
 */
export function parseLlmPlaces(raw: string, source: PlaceSource, opts: { groundedIn?: string; max?: number; frameIndex?: number } = {}): PlaceCandidate[] {
  const obj = jsonObject(raw);
  const list = obj && typeof obj === 'object' ? (obj as { places?: unknown }).places : null;
  if (!Array.isArray(list)) return [];
  const haystack = opts.groundedIn === undefined ? null : foldName(opts.groundedIn);
  const max = opts.max ?? MAX_PLACES;
  const out: PlaceCandidate[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= max) break;
    const rec = typeof item === 'string' ? { name: item } : item && typeof item === 'object' ? (item as { name?: unknown; area?: unknown }) : null;
    if (!rec) continue;
    const name = cleanText(rec.name, MAX_NAME);
    if (!name) continue;
    const key = foldName(name);
    if (key.length === 0 || seen.has(key) || (haystack !== null && !haystack.includes(key))) continue;
    seen.add(key);
    out.push({ name, area: 'area' in rec ? cleanText(rec.area, MAX_AREA) : null, source, ...(opts.frameIndex !== undefined ? { frameIndex: opts.frameIndex } : {}) });
  }
  return out;
}

/** Keeps first occurrence per folded name; earlier sources are more trustworthy, so callers pass them first. */
export function dedupeCandidates(list: readonly PlaceCandidate[], max = MAX_PLACES): PlaceCandidate[] {
  const seen = new Set<string>();
  const out: PlaceCandidate[] = [];
  for (const c of list) {
    const key = foldName(c.name);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Defensive read of the JSONB column: anything malformed is dropped rather than trusted. */
export function parseStoredPlaces(v: unknown): Place[] {
  if (!Array.isArray(v)) return [];
  const out: Place[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    const lat = r.latitude;
    const lon = r.longitude;
    if (typeof r.name !== 'string' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const source: PlaceSource = r.source === 'text-ai' || r.source === 'frame-ai' ? r.source : 'caption';
    const photoKey = typeof r.photoKey === 'string' && /^social-videos\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,80}\/place-\d{1,2}\.jpg$/.test(r.photoKey) ? r.photoKey : null;
    const category = typeof r.category === 'string' && r.category.trim().length > 0 ? r.category.trim().slice(0, 40) : null;
    out.push({ name: r.name.slice(0, MAX_NAME), latitude: lat, longitude: lon, source, displayName: typeof r.displayName === 'string' ? r.displayName.slice(0, 200) : null, photoKey, category });
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

const BY_CATEGORY_TYPE: Record<string, string> = {
  'natural:peak': 'Mountain peak', 'natural:volcano': 'Volcano', 'natural:water': 'Lake', 'natural:bay': 'Bay', 'natural:beach': 'Beach',
  'natural:bare_rock': 'Rock formation', 'natural:cliff': 'Cliff', 'natural:cave_entrance': 'Cave', 'natural:wood': 'Forest', 'natural:glacier': 'Glacier',
  'natural:valley': 'Valley', 'natural:hot_spring': 'Hot spring', 'natural:island': 'Island', 'natural:ridge': 'Ridge', 'natural:saddle': 'Mountain pass',
  'waterway:waterfall': 'Waterfall', 'waterway:river': 'River', 'tourism:attraction': 'Tourist attraction', 'tourism:viewpoint': 'Viewpoint',
  'tourism:museum': 'Museum', 'tourism:hotel': 'Hotel', 'tourism:guest_house': 'Guest house', 'tourism:hostel': 'Hostel', 'tourism:camp_site': 'Campsite',
  'tourism:alpine_hut': 'Mountain hut', 'tourism:zoo': 'Zoo', 'tourism:theme_park': 'Theme park', 'amenity:restaurant': 'Restaurant', 'amenity:cafe': 'Cafe',
  'amenity:bar': 'Bar', 'amenity:pub': 'Pub', 'amenity:place_of_worship': 'Place of worship', 'historic:castle': 'Castle', 'historic:monument': 'Monument',
  'historic:ruins': 'Ruins', 'historic:archaeological_site': 'Archaeological site', 'leisure:park': 'Park', 'leisure:nature_reserve': 'Nature reserve',
  'highway:path': 'Trail', 'highway:footway': 'Trail', 'route:hiking': 'Hiking trail', 'boundary:national_park': 'National park', 'boundary:protected_area': 'Protected area',
};
const BY_ADDRESS_TYPE: Record<string, string> = {
  city: 'City', town: 'Town', village: 'Village', hamlet: 'Hamlet', suburb: 'Neighbourhood', neighbourhood: 'Neighbourhood', quarter: 'Neighbourhood',
  state: 'State', region: 'Region', province: 'Province', county: 'County', island: 'Island', municipality: 'Municipality', mountain_range: 'Mountain range',
  peak: 'Mountain peak', lake: 'Lake', beach: 'Beach', waterfall: 'Waterfall', attraction: 'Tourist attraction', viewpoint: 'Viewpoint', park: 'Park',
};

/** A short human label for the kind of place, from Nominatim's category, type, and addresstype. null when nothing fits. */
export function categoryLabel(category: string | null, type: string | null, addressType: string | null): string | null {
  if (category && type && BY_CATEGORY_TYPE[`${category}:${type}`]) return BY_CATEGORY_TYPE[`${category}:${type}`]!;
  if (addressType && BY_ADDRESS_TYPE[addressType]) return BY_ADDRESS_TYPE[addressType]!;
  if (type && BY_ADDRESS_TYPE[type]) return BY_ADDRESS_TYPE[type]!;
  return null;
}

const MAX_TITLE = 90;
const MAX_TAKEAWAY = 160;
const MAX_TAKEAWAYS = 5;

/** Validates an LLM answer of the shape {"title":"...","takeaways":["..."]}. Returns null when nothing usable is left. */
export function parseSummary(raw: string): VideoSummary | null {
  const obj = jsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { title?: unknown; takeaways?: unknown };
  const title = cleanText(o.title, MAX_TITLE);
  const takeaways: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o.takeaways)) {
    for (const t of o.takeaways) {
      const s = cleanText(t, MAX_TAKEAWAY);
      if (!s || s.length < 8) continue;
      const key = foldName(s);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      takeaways.push(s);
      if (takeaways.length >= MAX_TAKEAWAYS) break;
    }
  }
  return title || takeaways.length > 0 ? { title, takeaways } : null;
}

/** Defensive read of the summary JSONB column. */
export function parseStoredSummary(v: unknown): VideoSummary | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { title?: unknown; takeaways?: unknown };
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, MAX_TITLE) : null;
  const takeaways = Array.isArray(o.takeaways) ? o.takeaways.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, MAX_TAKEAWAYS).map((t) => t.trim().slice(0, MAX_TAKEAWAY)) : [];
  return title || takeaways.length > 0 ? { title, takeaways } : null;
}

/** Whether a video's place enrichment is still running. `expectedPlaces` is the count the video itself announces ("5 tempat ..."), if any. */
export interface Enrichment {
  state: 'processing' | 'done';
  expectedPlaces: number | null;
}

const COUNT_NOUNS =
  'tempat|places?|spots?|destinations?|destinasi|lokasi|locations?|hikes?|trails?|trek|restaurants?|restoran|cafes?|kafe|beaches?|pantai|wisata|attractions?|stops?|islands?|pulau|temples?|candi|waterfalls?|air terjun|villages?|desa|hotels?|resorts?|bars?|museums?|parks?|taman|mountains?|gunung|cities|kota|countries|negara|landmarks?|sites?|cara';
const COUNT_AFTER = new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})\\s+(?:[\\p{L}'-]+\\s+){0,2}(?:${COUNT_NOUNS})(?![\\p{L}\\p{N}])`, 'iu');
const COUNT_TOP = /(?<![\p{L}\p{N}])(?:top|best|terbaik|paling)\s+(\d{1,2})(?![\p{L}\p{N}])/iu;
const COUNT_BEST = /(?<![\p{L}\p{N}])(\d{1,2})\s+(?:best|top|terbaik|paling|must)(?![\p{L}\p{N}])/iu;

/** The number of places a post announces in its own words ("5 tempat wisata", "Top 7", "10 best beaches"), 2 to 20, else null. */
export function expectedPlaceCount(text: string | null | undefined): number | null {
  if (!text) return null;
  for (const re of [COUNT_TOP, COUNT_BEST, COUNT_AFTER]) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 2 && n <= 20) return n;
  }
  return null;
}

/** Defensive read of the enrichment JSONB column. */
export function parseStoredEnrichment(v: unknown): Enrichment | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { state?: unknown; expectedPlaces?: unknown };
  if (o.state !== 'processing' && o.state !== 'done') return null;
  const n = typeof o.expectedPlaces === 'number' && Number.isInteger(o.expectedPlaces) && o.expectedPlaces >= 2 && o.expectedPlaces <= 20 ? o.expectedPlaces : null;
  return { state: o.state, expectedPlaces: n };
}
