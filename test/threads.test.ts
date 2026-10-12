import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { ProviderError } from '../src/provider.js';
import { ThreadsEmbedProvider, decodeEntities, ogTag } from '../src/threads.js';
import { YtDlpSocialVideoProvider, type Exec } from '../src/ytdlp.js';
import { InMemoryRepo } from '../src/repo.js';
import { MemoryStorage } from '../src/storage.js';
import { JobQueue } from '../src/queue.js';
import { ImportService } from '../src/service.js';
import { processJob, type WorkerDeps } from '../src/worker.js';
import type { Downloader } from '../src/download.js';

const URL_IN = 'https://www.threads.net/@Some.User/post/AbCdE12345?xmt=1&slof=1';
const NORMAL = 'https://www.threads.com/@some.user/post/AbCdE12345';
const code = (c: string) => (e: unknown) => e instanceof ProviderError && e.code === c;

const PAGE = `<html><head>
<meta property="og:title" content=":Some Name (&#064;some.user) on Threads" />
<meta content="Caption &amp; more #Tag1 #tag1 #Two" property="og:description" />
<meta property="og:image" content="https://scontent-xx.cdninstagram.com/v/t51/abc.jpg?oe=123" />
</head></html>`;
const EMBED = '<html><body><video src="blob:x"></video></body></html>';

type R = { status?: number; html?: string; url?: string; throws?: Error };
function fakeFetch(map: (url: string) => R) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = map(url);
    if (r.throws) throw r.throws;
    return { status: r.status ?? 200, url: r.url ?? url, text: async () => r.html ?? '' } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const happy = (u: string): R => ({ html: u.endsWith('/embed') ? EMBED : PAGE });

test('entities and og tag parsing (either attribute order, decoded)', () => {
  assert.equal(decodeEntities('a &amp; b &#064; &#x1F600; &quot;q&quot; &unknown; &#0; &#xD800;'), 'a & b @ \u{1F600} "q" &unknown; &#0; &#xD800;');
  assert.equal(ogTag(PAGE, 'og:description'), 'Caption & more #Tag1 #tag1 #Two');
  assert.equal(ogTag(PAGE, 'og:title'), ':Some Name (@some.user) on Threads');
  assert.equal(ogTag(PAGE, 'og:missing'), null);
  assert.equal(ogTag('', 'og:title'), null);
});

test('maps a public video post to an embed result', async () => {
  const { f, calls } = fakeFetch(happy);
  const r = await new ThreadsEmbedProvider({ fetchImpl: f }).fetchVideo(URL_IN);
  assert.equal(r.platform, 'threads');
  assert.equal(r.playbackKind, 'embed');
  assert.equal(r.embedUrl, `${NORMAL}/embed`);
  assert.equal(r.sourceUrl, NORMAL);
  assert.equal(r.contentId, 'AbCdE12345');
  assert.equal(r.authorUsername, 'some.user');
  assert.equal(r.authorDisplayName, 'Some Name');
  assert.equal(r.authorUrl, 'https://www.threads.com/@some.user');
  assert.equal(r.description, 'Caption & more #Tag1 #tag1 #Two');
  assert.deepEqual(r.hashtags, ['Tag1', 'Two']);
  assert.equal(r.thumbnailUrl, 'https://scontent-xx.cdninstagram.com/v/t51/abc.jpg?oe=123');
  assert.equal(r.storeThumbnail, true);
  assert.equal(r.title, null);
  assert.deepEqual(calls, [`${NORMAL}/embed`, NORMAL], 'only the two fixed threads urls are fetched');
});

test('posts without a video are rejected as INVALID_MEDIA', async () => {
  const { f } = fakeFetch((u) => ({ html: u.endsWith('/embed') ? '<html><img src=x></html>' : PAGE }));
  await assert.rejects(new ThreadsEmbedProvider({ fetchImpl: f }).fetchVideo(URL_IN), code('INVALID_MEDIA'));
});

test('status and redirect mapping: 404/410 unavailable, 401/403 private, login/off-host redirects private, 5xx provider error', async () => {
  const run = (r: R) => new ThreadsEmbedProvider({ fetchImpl: fakeFetch(() => r).f }).fetchVideo(URL_IN);
  await assert.rejects(run({ status: 404 }), code('VIDEO_UNAVAILABLE'));
  await assert.rejects(run({ status: 410 }), code('VIDEO_UNAVAILABLE'));
  await assert.rejects(run({ status: 401 }), code('PRIVATE_CONTENT'));
  await assert.rejects(run({ status: 403 }), code('PRIVATE_CONTENT'));
  await assert.rejects(run({ status: 500 }), code('PROVIDER_ERROR'));
  await assert.rejects(run({ html: EMBED, url: 'https://www.instagram.com/accounts/login/' }), code('PRIVATE_CONTENT'));
  await assert.rejects(run({ html: EMBED, url: 'https://evil.example/x' }), code('PRIVATE_CONTENT'));
  await assert.rejects(run({ html: EMBED, url: 'https://www.threads.com/login?next=/x' }), code('PRIVATE_CONTENT'));
  await assert.rejects(run({ html: 'x'.repeat(3_000_001) }), code('PROVIDER_ERROR'));
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  await assert.rejects(run({ throws: timeout }), code('IMPORT_TIMEOUT'));
  await assert.rejects(run({ throws: new Error('ECONNRESET secret') }), (e) => e instanceof ProviderError && e.code === 'PROVIDER_ERROR' && !/secret/.test(e.message));
});

test('hostile or missing og data: bad thumbnail host, http thumbnail, no tags at all', async () => {
  const bad = fakeFetch((u) => ({ html: u.endsWith('/embed') ? EMBED : '<meta property="og:image" content="https://evil.com/x.jpg"><meta property="og:title" content="garbage">' }));
  const r = await new ThreadsEmbedProvider({ fetchImpl: bad.f }).fetchVideo(URL_IN);
  assert.equal(r.thumbnailUrl, null);
  assert.equal(r.storeThumbnail, false);
  assert.equal(r.authorDisplayName, null);
  assert.equal(r.description, null);
  assert.deepEqual(r.hashtags, []);
  const http = fakeFetch((u) => ({ html: u.endsWith('/embed') ? EMBED : '<meta property="og:image" content="http://x.cdninstagram.com/a.jpg">' }));
  assert.equal((await new ThreadsEmbedProvider({ fetchImpl: http.f }).fetchVideo(URL_IN)).thumbnailUrl, null);
  const page404 = fakeFetch((u) => (u.endsWith('/embed') ? { html: EMBED } : { status: 404 }));
  const r3 = await new ThreadsEmbedProvider({ fetchImpl: page404.f }).fetchVideo(URL_IN);
  assert.equal(r3.thumbnailUrl, null, 'main page failure only loses the preview, not the import');
});

test('only threads urls are handled; others rejected before any request', async () => {
  const { f, calls } = fakeFetch(happy);
  const p = new ThreadsEmbedProvider({ fetchImpl: f });
  assert.equal(p.canHandle(URL_IN), true);
  assert.equal(p.canHandle('https://vt.tiktok.com/ZSabc123/'), false);
  await assert.rejects(p.fetchVideo('https://evil.com/@a/post/AbCdE12345'));
  await assert.rejects(p.fetchVideo('https://vt.tiktok.com/ZSabc123/'));
  assert.equal(calls.length, 0);
});

test('yt-dlp never handles threads', async () => {
  let spawned = 0;
  const exec: Exec = async () => { spawned++; return { stdout: '{}' }; };
  const y = new YtDlpSocialVideoProvider({ exec });
  assert.equal(y.canHandle(URL_IN), false);
  await assert.rejects(y.fetchVideo(URL_IN), code('UNSUPPORTED_PLATFORM'));
  await assert.rejects(y.downloadVideo(URL_IN, '/tmp/v.mp4', 1), code('UNSUPPORTED_PLATFORM'));
  assert.equal(spawned, 0);
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
function worker(downloader: Downloader) {
  const repo = new InMemoryRepo();
  const storage = new MemoryStorage();
  const deps: WorkerDeps = {
    repo, storage, downloader, providerName: 'test',
    providers: [new ThreadsEmbedProvider({ fetchImpl: fakeFetch(happy).f })],
    prober: { probe: async () => { throw new Error('must not probe'); } },
  };
  const queue = new JobQueue((id) => processJob(deps, id));
  const service = new ImportService(repo, storage, (id) => queue.enqueue(id));
  return { repo, storage, queue, service };
}

test('worker keeps its own copy of the short-lived preview image for threads embeds', async () => {
  const w = worker({ download: async (_u, _h, dest) => { await writeFile(dest, JPEG); return JPEG.length; } });
  const { jobId } = await w.service.startImport('u1', URL_IN);
  await w.queue.onIdle();
  const j = (await w.service.getJob('u1', jobId))!;
  assert.equal(j.status, 'COMPLETED');
  assert.equal(j.video!.videoUrl, null);
  assert.deepEqual(j.video!.playback, { kind: 'embed', embedUrl: `${NORMAL}/embed` });
  assert.match(j.video!.thumbnailUrl!, /^https:\/\/storage\.test\/social-videos\/u1\/video_.+\/thumbnail\.jpg/);
  assert.equal(w.storage.objects.size, 1, 'only the thumbnail is stored, never a video');
});

test('worker falls back to the external preview url when the copy fails or is not a jpeg', async () => {
  for (const dl of [
    async () => { throw new Error('cdn 403'); },
    async (_u: string, _h: Record<string, string>, dest: string) => { await writeFile(dest, Buffer.from('RIFFxxxxWEBP')); return 12; },
  ]) {
    const w = worker({ download: dl as Downloader['download'] });
    const { jobId } = await w.service.startImport('u1', URL_IN);
    await w.queue.onIdle();
    const j = (await w.service.getJob('u1', jobId))!;
    assert.equal(j.status, 'COMPLETED');
    assert.equal(j.video!.thumbnailUrl, 'https://scontent-xx.cdninstagram.com/v/t51/abc.jpg?oe=123');
    assert.equal(w.storage.objects.size, 0);
  }
});
