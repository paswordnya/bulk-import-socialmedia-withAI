import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedSocialUrl, parseSocialUrl } from '../src/urls.js';
import { ProviderError } from '../src/provider.js';
import { YouTubeEmbedProvider, embedUrlFor, parseIsoDuration } from '../src/youtube.js';
import { YtDlpSocialVideoProvider, type Exec } from '../src/ytdlp.js';

const ID = 'AbCdEfGhIjK';
const SHORTS = `https://www.youtube.com/shorts/${ID}`;

test('youtube: accepted forms normalize and share one content id', () => {
  const cases: Array<[string, string]> = [
    [`https://youtube.com/shorts/${ID}?si=xyz`, SHORTS],
    [`https://www.youtube.com/shorts/${ID}/`, SHORTS],
    [`https://m.youtube.com/shorts/${ID}`, SHORTS],
    [`https://www.youtube.com/watch?v=${ID}&t=5s&list=PL1`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch/?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}?si=abc`, `https://www.youtube.com/watch?v=${ID}`],
  ];
  for (const [input, normalized] of cases) {
    const r = parseSocialUrl(input);
    assert.equal(r.platform, 'youtube', input);
    assert.equal(r.normalizedUrl, normalized, input);
    assert.equal(r.contentId, ID, input);
  }
});

test('youtube: rejects lookalikes, bad ids, other paths, schemes and credentials', () => {
  const bad = [
    `http://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com.evil.com/shorts/${ID}`,
    `https://youtube.com@evil.com/shorts/${ID}`,
    `https://user:pw@www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com:8443/shorts/${ID}`,
    `https://youtu.be.evil.com/${ID}`,
    `https://evilyoutu.be/${ID}`,
    'https://www.youtube.com/shorts/short',
    `https://www.youtube.com/shorts/${ID}x`, // 12 chars
    'https://www.youtube.com/shorts/ABCDEFGHIJ!', // bad char
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/playlist?list=PL${ID}`,
    `https://www.youtube.com/channel/UC${ID}`,
    `https://www.youtube.com/@someone`,
    `https://www.youtube.com/embed/${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}/extra`,
    'https://youtu.be/',
  ];
  for (const s of bad) assert.equal(isSupportedSocialUrl(s), false, s);
});

test('iso duration parsing and boundaries', () => {
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('PT1M'), 60);
  assert.equal(parseIsoDuration('PT3M30S'), 210);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  for (const bad of ['P0D', 'PT0S', 'PT', 'P', '45', 'PT-5S', 'PT1.5S', 'pt45s', '', null, undefined, 45, {}]) {
    assert.equal(parseIsoDuration(bad), null, String(bad));
  }
  assert.equal(parseIsoDuration('PT99999999999999999999S'), null, 'beyond safe integer');
});

type Resp = { status?: number; body?: unknown; throws?: Error };
function fakeFetch(map: (url: string) => Resp) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = map(url);
    if (r.throws) throw r.throws;
    return { status: r.status ?? 200, json: async () => { if (r.body === undefined) throw new Error('no json'); return r.body; } } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

const OEMBED = {
  title: 'Cool short #Persib #persib #Football', author_name: 'Some Channel', author_url: 'https://www.youtube.com/@somechannel?x=1',
  thumbnail_url: `https://i.ytimg.com/vi/${ID}/hq2.jpg`, html: '<iframe></iframe>',
};

test('oEmbed mapping: embed playback, no download, sanitized metadata', async () => {
  const { f, calls } = fakeFetch(() => ({ body: OEMBED }));
  const r = await new YouTubeEmbedProvider({ fetchImpl: f }).fetchVideo(`https://youtu.be/${ID}?si=1`);
  assert.equal(r.platform, 'youtube');
  assert.equal(r.playbackKind, 'embed');
  assert.equal(r.embedUrl, embedUrlFor(ID));
  assert.equal(r.embedUrl, `https://www.youtube-nocookie.com/embed/${ID}?playsinline=1&rel=0`);
  assert.equal(r.sourceUrl, `https://www.youtube.com/watch?v=${ID}`);
  assert.equal(r.authorUsername, 'somechannel');
  assert.equal(r.authorDisplayName, 'Some Channel');
  assert.equal(r.authorUrl, 'https://www.youtube.com/@somechannel');
  assert.equal(r.thumbnailUrl, `https://i.ytimg.com/vi/${ID}/hq2.jpg`);
  assert.deepEqual(r.hashtags, ['Persib', 'Football']);
  assert.deepEqual([r.viewCount, r.likeCount, r.duration], [null, null, null]);
  assert.equal(calls.length, 1, 'no api key -> only oEmbed is called');
  assert.ok(calls[0]!.url.startsWith('https://www.youtube.com/oembed?'));
  assert.ok(calls[0]!.url.includes(encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`)));
});

test('oEmbed hostile values are dropped: thumbnail host, author url, handle', async () => {
  const { f } = fakeFetch(() => ({ body: { ...OEMBED, thumbnail_url: 'https://evil.com/t.jpg', author_url: 'https://evil.com/@x' } }));
  const r = await new YouTubeEmbedProvider({ fetchImpl: f }).fetchVideo(SHORTS);
  assert.equal(r.thumbnailUrl, `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  assert.equal(r.authorUrl, null);
  assert.equal(r.authorUsername, '');
  const g = fakeFetch(() => ({ body: { ...OEMBED, thumbnail_url: 'http://i.ytimg.com/x.jpg', author_url: 'https://www.youtube.com/channel/UCabcdefghijklmnop' } }));
  const r2 = await new YouTubeEmbedProvider({ fetchImpl: g.f }).fetchVideo(SHORTS);
  assert.equal(r2.thumbnailUrl, `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, 'http thumbnail rejected');
  assert.equal(r2.authorUsername, '', 'channel-id urls have no handle');
});

test('oEmbed status mapping: 404 unavailable, 401/403 embedding disabled, others provider error', async () => {
  const run = (status: number | undefined, throws?: Error) =>
    new YouTubeEmbedProvider({ fetchImpl: fakeFetch(() => ({ status, body: {}, throws })).f }).fetchVideo(SHORTS);
  await assert.rejects(run(404), (e) => e instanceof ProviderError && e.code === 'VIDEO_UNAVAILABLE');
  await assert.rejects(run(401), (e) => e instanceof ProviderError && e.code === 'EMBEDDING_DISABLED');
  await assert.rejects(run(403), (e) => e instanceof ProviderError && e.code === 'EMBEDDING_DISABLED');
  await assert.rejects(run(500), (e) => e instanceof ProviderError && e.code === 'PROVIDER_ERROR');
  await assert.rejects(run(200, new Error('ECONNRESET secret')), (e) => e instanceof ProviderError && e.code === 'PROVIDER_ERROR' && !/secret/.test(e.message));
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  await assert.rejects(run(200, timeout), (e) => e instanceof ProviderError && e.code === 'IMPORT_TIMEOUT');
  // non-json / non-object bodies
  for (const body of [undefined, null, 'x', 42]) {
    const f = fakeFetch(() => ({ body })).f;
    await assert.rejects(new YouTubeEmbedProvider({ fetchImpl: f }).fetchVideo(SHORTS), (e) => e instanceof ProviderError && e.code === 'PROVIDER_ERROR');
  }
});

test('api key enrichment: counts, duration, date, description; key only in a header', async () => {
  const api = {
    items: [{
      snippet: { publishedAt: '2026-10-01T10:00:00Z', description: 'Desc #Extra', channelId: 'UCabcdefghijklmnopqrstuv' },
      statistics: { viewCount: '12345', likeCount: '678', commentCount: '9' },
      contentDetails: { duration: 'PT45S' },
      status: { embeddable: true },
    }],
  };
  const { f, calls } = fakeFetch((u) => (u.includes('googleapis.com') ? { body: api } : { body: OEMBED }));
  const r = await new YouTubeEmbedProvider({ fetchImpl: f, apiKey: 'TEST-KEY' }).fetchVideo(SHORTS);
  assert.deepEqual([r.viewCount, r.likeCount, r.commentCount, r.duration], [12345, 678, 9, 45]);
  assert.equal(r.publishedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(r.description, 'Desc #Extra');
  assert.equal(r.authorId, 'UCabcdefghijklmnopqrstuv');
  assert.deepEqual(r.hashtags, ['Persib', 'Football', 'Extra']);
  const apiCall = calls.find((c) => c.url.includes('googleapis.com'))!;
  assert.equal(apiCall.headers['x-goog-api-key'], 'TEST-KEY');
  assert.ok(calls.every((c) => !c.url.includes('TEST-KEY')), 'key never in a URL');
});

test('api enrichment is best-effort; bad values become null; embeddable=false is rejected', async () => {
  const withApi = (api: () => Resp) => new YouTubeEmbedProvider({ apiKey: 'K', fetchImpl: fakeFetch((u) => (u.includes('googleapis') ? api() : { body: OEMBED })).f }).fetchVideo(SHORTS);
  for (const resp of [{ status: 500, body: {} }, { status: 403, body: { error: 'quota' } }, { throws: new Error('net') }, { body: { items: [] } }, { body: {} }, { body: null }]) {
    const r = await withApi(() => resp);
    assert.equal(r.title, 'Cool short #Persib #persib #Football', 'oEmbed data survives enrichment failure');
    assert.equal(r.viewCount, null);
  }
  const weird = await withApi(() => ({ body: { items: [{ statistics: { viewCount: '-5', likeCount: '1.5', commentCount: 12 }, contentDetails: { duration: 'bad' }, snippet: { publishedAt: 'not a date', channelId: '../x' } }] } }));
  assert.deepEqual([weird.viewCount, weird.likeCount, weird.commentCount, weird.duration, weird.publishedAt, weird.authorId], [null, null, null, null, null, null]);
  await assert.rejects(withApi(() => ({ body: { items: [{ status: { embeddable: false } }] } })), (e) => e instanceof ProviderError && e.code === 'EMBEDDING_DISABLED');
});

test('only youtube urls are handled; other platforms are rejected without any request', async () => {
  const { f, calls } = fakeFetch(() => ({ body: OEMBED }));
  const p = new YouTubeEmbedProvider({ fetchImpl: f });
  assert.equal(p.canHandle(SHORTS), true);
  assert.equal(p.canHandle('https://vt.tiktok.com/ZSabc123/'), false);
  assert.equal(p.canHandle('https://evil.com/shorts/' + ID), false);
  await assert.rejects(p.fetchVideo('https://vt.tiktok.com/ZSabc123/'));
  await assert.rejects(p.fetchVideo('https://evil.com/oembed'));
  assert.equal(calls.length, 0);
});

test('yt-dlp provider never handles or downloads youtube', async () => {
  let spawned = 0;
  const exec: Exec = async () => { spawned++; return { stdout: '{}' }; };
  const p = new YtDlpSocialVideoProvider({ exec });
  assert.equal(p.canHandle(SHORTS), false);
  assert.equal(p.canHandle('https://vt.tiktok.com/ZSabc123/'), true);
  await assert.rejects(p.fetchVideo(SHORTS), (e) => e instanceof ProviderError && e.code === 'UNSUPPORTED_PLATFORM');
  await assert.rejects(p.downloadVideo(SHORTS, '/tmp/v.mp4', 1000), (e) => e instanceof ProviderError && e.code === 'UNSUPPORTED_PLATFORM');
  assert.equal(spawned, 0);
});
