import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { InMemoryRepo } from '../src/repo.js';
import { MemoryStorage } from '../src/storage.js';
import { JobQueue } from '../src/queue.js';
import { ImportService } from '../src/service.js';
import { buildServer, devAuthVerifier } from '../src/server.js';
import { processJob, type WorkerDeps } from '../src/worker.js';
import { ProviderError, type SocialVideoProvider, type SocialVideoResult } from '../src/provider.js';
import type { Downloader } from '../src/download.js';
import type { MediaProber, ProbeResult } from '../src/media.js';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), Buffer.from('isom0000')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const TT = 'https://www.tiktok.com/@creator/video/111';
const auth = { authorization: 'Bearer dev-user1' };

const meta = (o: Partial<SocialVideoResult> = {}): SocialVideoResult => ({
  platform: 'tiktok', sourceUrl: TT, contentId: '111', authorUsername: 'creator', authorDisplayName: 'Creator',
  title: 'Synthetic title', description: 'synthetic', thumbnailUrl: 'https://cdn.example.com/t.jpg', videoUrl: 'https://cdn.example.com/v.mp4',
  duration: 12, publishedAt: '2026-01-02T03:04:05.000Z', viewCount: 1000, likeCount: 50, commentCount: 5, repostCount: 2,
  saveCount: 1, musicTitle: 'Original sound', musicArtist: 'Creator', authorId: '42', authorUrl: 'https://www.tiktok.com/@creator',
  hashtags: ['tag1', 'tag2'], ...o,
});

function setup(opts: { fetch?: () => Promise<SocialVideoResult>; body?: Buffer; probe?: ProbeResult; storageFails?: boolean; remoteThumb?: Buffer | 'fail'; frame?: Buffer | 'fail' | 'none'; extraDeps?: Partial<WorkerDeps> } = {}) {
  const repo = new InMemoryRepo();
  const storage = new MemoryStorage();
  storage.failPuts = opts.storageFails ?? false;
  let fetchCalls = 0;
  const provider: SocialVideoProvider = {
    canHandle: () => true,
    fetchVideo: async () => { fetchCalls++; return (opts.fetch ?? (async () => meta()))(); },
  };
  const downloader: Downloader = {
    download: async (url, _h, dest) => {
      if (url.endsWith('.jpg') && opts.remoteThumb === 'fail') throw new Error('cdn 403');
      const b = url.endsWith('.jpg') ? (opts.remoteThumb as Buffer | undefined) ?? JPEG : (opts.body ?? MP4);
      await writeFile(dest, b);
      return b.length;
    },
  };
  const prober: MediaProber = { probe: async () => opts.probe ?? { container: 'mp4', videoCodec: 'h264', durationSeconds: 12, width: 720, height: 1280 } };
  const logs: Array<Record<string, unknown>> = [];
  const thumbnailer = opts.frame === 'none' ? undefined : {
    fromVideo: async (_v: string, dest: string) => {
      if (opts.frame === 'fail') throw new Error('ffmpeg failed');
      await writeFile(dest, (opts.frame as Buffer | undefined) ?? JPEG);
    },
  };
  const deps: WorkerDeps = { repo, providers: [provider], providerName: 'test', downloader, prober, storage, thumbnailer, log: (l) => logs.push(l), ...opts.extraDeps };
  const queue = new JobQueue((id) => processJob(deps, id));
  const service = new ImportService(repo, storage, (id) => queue.enqueue(id));
  const app = buildServer(service, devAuthVerifier);
  return { app, repo, storage, queue, logs, fetchCalls: () => fetchCalls };
}

const post = (app: ReturnType<typeof setup>['app'], url: unknown, headers = auth) =>
  app.inject({ method: 'POST', url: '/v1/social-videos/import', headers, payload: { url } as never });
const getJob = (app: ReturnType<typeof setup>['app'], id: string, headers = auth) =>
  app.inject({ method: 'GET', url: `/v1/social-videos/import/${id}`, headers });

test('full flow: import -> job completes -> signed video url -> video endpoint', async () => {
  const s = setup();
  const res = await post(s.app, TT);
  assert.equal(res.statusCode, 202);
  const { jobId, status } = res.json();
  assert.equal(status, 'PENDING');

  await s.queue.onIdle();
  const done = (await getJob(s.app, jobId)).json();
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.progress, 100);
  assert.match(done.video.videoUrl, /^https:\/\/storage\.test\/social-videos\/user1\/video_.+\/video\.mp4/);
  assert.match(done.video.thumbnailUrl, /thumbnail\.jpg/);
  assert.equal(done.video.authorUsername, 'creator');
  assert.ok(!('storageKey' in done.video));
  assert.ok(done.video.videoUrl.includes(`/${done.video.id}/`), 'storage key uses the same id as the video row');

  const v = await s.app.inject({ method: 'GET', url: `/v1/social-videos/${done.video.id}`, headers: auth });
  assert.equal(v.statusCode, 200);
  assert.equal(v.json().id, done.video.id);
  assert.equal(s.storage.objects.size, 2);
});

test('duplicate import returns the existing video without refetching', async () => {
  const s = setup();
  const first = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const again = await post(s.app, 'https://tiktok.com/@Creator/video/111?utm=x');
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().status, 'COMPLETED');
  const job = (await getJob(s.app, again.json().jobId)).json();
  const orig = (await getJob(s.app, first.jobId)).json();
  assert.equal(job.video.id, orig.video.id);
  assert.equal(s.fetchCalls(), 1);
  assert.equal(s.repo.videos.size, 1);
});

test('re-import while a job is active returns the same job', async () => {
  const s = setup();
  const a = (await post(s.app, TT)).json();
  const b = (await post(s.app, TT)).json();
  assert.equal(a.jobId, b.jobId);
  await s.queue.onIdle();
  assert.equal(s.fetchCalls(), 1);
});

test('dedup is per user', async () => {
  const s = setup();
  await post(s.app, TT);
  await s.queue.onIdle();
  const other = await post(s.app, TT, { authorization: 'Bearer dev-user2' });
  assert.equal(other.statusCode, 202);
  await s.queue.onIdle();
  assert.equal(s.repo.videos.size, 2);
});

test('user cannot read another user\'s job or video', async () => {
  const s = setup();
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const other = { authorization: 'Bearer dev-user2' };
  assert.equal((await getJob(s.app, jobId, other)).statusCode, 404);
  const vid = (await getJob(s.app, jobId)).json().video.id;
  assert.equal((await s.app.inject({ method: 'GET', url: `/v1/social-videos/${vid}`, headers: other })).statusCode, 404);
});

test('auth and input validation', async () => {
  const s = setup();
  assert.equal((await post(s.app, TT, {} as never)).statusCode, 401);
  assert.equal((await post(s.app, TT, { authorization: 'Bearer nope' })).statusCode, 401);
  for (const bad of [undefined, null, 42, '', 'https://evil.com/x', 'http://127.0.0.1/reel/abcde/']) {
    const r = await post(s.app, bad);
    assert.equal(r.statusCode, 400);
    assert.ok(['INVALID_URL', 'UNSUPPORTED_PLATFORM'].includes(r.json().errorCode));
  }
  assert.equal(s.repo.jobs.size, 0, 'no job created for rejected input');
  assert.equal((await getJob(s.app, '../etc/passwd')).statusCode, 404);
  assert.equal((await getJob(s.app, 'job_missing')).statusCode, 404);
});

async function failedWith(s: ReturnType<typeof setup>) {
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  return (await getJob(s.app, jobId)).json();
}

test('provider failures map to error codes and user messages', async () => {
  for (const [code, text] of [['PRIVATE_CONTENT', /isn't publicly accessible/], ['VIDEO_UNAVAILABLE', /no longer available/], ['IMPORT_TIMEOUT', /too long/]] as const) {
    const j = await failedWith(setup({ fetch: async () => { throw new ProviderError(code, 'internal detail'); } }));
    assert.equal(j.status, 'FAILED');
    assert.equal(j.errorCode, code);
    assert.match(j.message, text);
    assert.ok(!JSON.stringify(j).includes('internal detail'));
  }
});

test('unexpected exceptions become UNKNOWN_ERROR', async () => {
  const j = await failedWith(setup({ fetch: async () => { throw new Error('boom'); } }));
  assert.equal(j.errorCode, 'UNKNOWN_ERROR');
});

test('invalid downloads are rejected and nothing is stored', async () => {
  const html = setup({ body: Buffer.from('<html>not a video</html>') });
  assert.equal((await failedWith(html)).errorCode, 'INVALID_MEDIA');
  assert.equal(html.storage.objects.size, 0);

  const longVid = setup({ probe: { container: 'mp4', videoCodec: 'h264', durationSeconds: 99999 } });
  const longJob = await failedWith(longVid);
  assert.equal(longJob.errorCode, 'VIDEO_TOO_LONG');
  assert.match(longJob.message, /too long/);

  const badCodec = setup({ probe: { container: 'mp4', videoCodec: 'mjpeg', durationSeconds: 5 } });
  assert.equal((await failedWith(badCodec)).errorCode, 'INVALID_MEDIA');
});

test('storage failure -> STORAGE_ERROR and no video row', async () => {
  const s = setup({ storageFails: true });
  assert.equal((await failedWith(s)).errorCode, 'STORAGE_ERROR');
  assert.equal(s.repo.videos.size, 0);
});

test('short link: dedup after fetch reuses existing video without downloading', async () => {
  const s = setup();
  await post(s.app, TT);
  await s.queue.onIdle();
  const before = s.storage.objects.size;
  // Short links have no content id up front; provider resolves it to the same video.
  const r = await post(s.app, 'https://vm.tiktok.com/ZSabc123');
  await s.queue.onIdle();
  const j = (await getJob(s.app, r.json().jobId)).json();
  assert.equal(j.status, 'COMPLETED');
  assert.equal(s.repo.videos.size, 1);
  assert.equal(s.storage.objects.size, before);
});

test('logs carry job metadata but no secrets', async () => {
  const s = setup({ fetch: async () => { throw new ProviderError('PROVIDER_ERROR', 'x'); } });
  await failedWith(s);
  const l = s.logs.at(-1)!;
  assert.equal(l.status, 'FAILED');
  assert.equal(l.errorCode, 'PROVIDER_ERROR');
  assert.ok(l.jobId && l.userId && l.platform && l.provider);
});

test('video fields include title, description and createdAt', async () => {
  const s = setup();
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const v = (await getJob(s.app, jobId)).json().video;
  assert.equal(v.title, 'Synthetic title');
  assert.equal(v.description, 'synthetic');
  assert.ok(!Number.isNaN(Date.parse(v.createdAt)));
});

async function seedVideos(s: ReturnType<typeof setup>, userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await s.repo.createVideo({
      userId, platform: 'tiktok', sourceUrl: `u${i}`, normalizedUrl: `https://www.tiktok.com/@c/video/${100000 + i}`,
      contentId: String(100000 + i), authorUsername: 'c', authorDisplayName: 'C', title: `t${i}`, description: null,
      thumbnailKey: null, storageKey: `k${i}`, duration: 5, publishedAt: null, viewCount: null, likeCount: null,
      commentCount: null, repostCount: null, saveCount: null, musicTitle: null, musicArtist: null, authorId: null,
      authorUrl: null, hashtags: [], width: null, height: null, videoCodec: null, fileSizeBytes: null,
    });
    await new Promise((r) => setTimeout(r, 2)); // distinct createdAt
  }
}
const list = (app: ReturnType<typeof setup>['app'], qs = '', headers = auth) =>
  app.inject({ method: 'GET', url: `/v1/social-videos${qs}`, headers });

test('feed: empty list, newest first, signed urls, no storage keys', async () => {
  const s = setup();
  const empty = (await list(s.app)).json();
  assert.deepEqual(empty, { items: [], nextCursor: null });
  await seedVideos(s, 'user1', 3);
  const r = (await list(s.app)).json();
  assert.deepEqual(r.items.map((v: { title: string }) => v.title), ['t2', 't1', 't0']);
  assert.equal(r.nextCursor, null);
  assert.ok(r.items.every((v: { videoUrl: string }) => v.videoUrl.startsWith('https://storage.test/')));
  assert.ok(!JSON.stringify(r).includes('storageKey'));
});

test('feed: pagination walks every item exactly once, boundaries at page size', async () => {
  const s = setup();
  await seedVideos(s, 'user1', 5);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const qs: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
    const r: { items: Array<{ title: string }>; nextCursor: string | null } = (await list(s.app, qs)).json();
    seen.push(...r.items.map((v: { title: string }) => v.title));
    cursor = r.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert.deepEqual(seen, ['t4', 't3', 't2', 't1', 't0']);
  assert.equal(pages, 3);
  // exact multiple: 4 items, limit 2 -> second page must have no cursor
  const s2 = setup();
  await seedVideos(s2, 'user1', 4);
  const p1 = (await list(s2.app, '?limit=2')).json();
  const p2 = (await list(s2.app, `?limit=2&cursor=${p1.nextCursor}`)).json();
  assert.equal(p2.items.length, 2);
  assert.equal(p2.nextCursor, null);
});

test('feed: only the caller\'s videos', async () => {
  const s = setup();
  await seedVideos(s, 'user1', 2);
  await seedVideos(s, 'user2', 3);
  assert.equal((await list(s.app)).json().items.length, 2);
  assert.equal((await list(s.app, '', { authorization: 'Bearer dev-user2' })).json().items.length, 3);
});

test('feed: auth and parameter validation', async () => {
  const s = setup();
  assert.equal((await list(s.app, '', {} as never)).statusCode, 401);
  for (const qs of ['?limit=0', '?limit=51', '?limit=-1', '?limit=abc', '?limit=1.5', '?cursor=!!!', '?cursor=' + 'a'.repeat(300), `?cursor=${Buffer.from('nope').toString('base64url')}`, `?cursor=${Buffer.from('2020-01-01T00:00:00.000Z|bad id').toString('base64url')}`]) {
    const r = await list(s.app, qs);
    assert.equal(r.statusCode, 400, qs);
    assert.equal(r.json().errorCode, 'INVALID_REQUEST');
  }
  assert.equal((await list(s.app, '?limit=1')).statusCode, 200);
  assert.equal((await list(s.app, '?limit=50')).statusCode, 200);
});

test('full metadata is stored and returned', async () => {
  const s = setup();
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const v = (await getJob(s.app, jobId)).json().video;
  assert.equal(v.publishedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(v.stats, { views: 1000, likes: 50, comments: 5, reposts: 2, saves: 1 });
  assert.deepEqual(v.music, { title: 'Original sound', artist: 'Creator' });
  assert.deepEqual(v.hashtags, ['tag1', 'tag2']);
  assert.equal(v.authorId, '42');
  assert.equal(v.authorUrl, 'https://www.tiktok.com/@creator');
  assert.deepEqual(v.media, { width: 720, height: 1280, codec: 'h264', fileSizeBytes: MP4.length });
  const viaFeed = (await list(s.app)).json().items[0];
  assert.deepEqual(viaFeed.stats, v.stats);
});

test('absent metadata becomes nulls / empty, never undefined or crashes', async () => {
  const s = setup({ fetch: async () => meta({ publishedAt: null, viewCount: null, likeCount: null, commentCount: null, repostCount: null, saveCount: null, musicTitle: null, musicArtist: null, authorId: null, authorUrl: null, hashtags: [], duration: null }) });
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const v = (await getJob(s.app, jobId)).json().video;
  assert.equal(v.publishedAt, null);
  assert.deepEqual(v.stats, { views: null, likes: null, comments: null, reposts: null, saves: null });
  assert.equal(v.music, null);
  assert.deepEqual(v.hashtags, []);
  assert.equal(v.duration, 12, 'duration falls back to the probed value');
});

test('thumbnail: remote JPEG is used when valid', async () => {
  const s = setup();
  await post(s.app, TT);
  await s.queue.onIdle();
  assert.ok([...s.storage.objects.keys()].some((k) => k.endsWith('thumbnail.jpg')));
});

test('thumbnail: falls back to a video frame when the CDN download fails or is not a JPEG', async () => {
  for (const remoteThumb of ['fail', Buffer.from('RIFFxxxxWEBP')] as const) {
    const s = setup({ remoteThumb });
    const { jobId } = (await post(s.app, TT)).json();
    await s.queue.onIdle();
    const v = (await getJob(s.app, jobId)).json().video;
    assert.match(v.thumbnailUrl, /thumbnail\.jpg/);
  }
});

test('thumbnail: best-effort, import still completes when every thumbnail path fails', async () => {
  for (const frame of ['fail', 'none', Buffer.from('not a jpeg')] as const) {
    const s = setup({ remoteThumb: 'fail', frame });
    const { jobId } = (await post(s.app, TT)).json();
    await s.queue.onIdle();
    const j = (await getJob(s.app, jobId)).json();
    assert.equal(j.status, 'COMPLETED');
    assert.equal(j.video.thumbnailUrl, null);
  }
});

test('duration boundary: exactly the limit passes, just over fails with VIDEO_TOO_LONG', async () => {
  const atLimit = setup({ probe: { container: 'mp4', videoCodec: 'h264', durationSeconds: 600 } });
  assert.equal((await failedWith(atLimit)).status, 'COMPLETED');
  const over = setup({ probe: { container: 'mp4', videoCodec: 'h264', durationSeconds: 600.1 } });
  assert.equal((await failedWith(over)).errorCode, 'VIDEO_TOO_LONG');
  const real = setup({ probe: { container: 'mp4', videoCodec: 'h264', durationSeconds: 623.3 } }); // the real-world case
  assert.equal((await failedWith(real)).errorCode, 'VIDEO_TOO_LONG');
});

test('configured limits are honoured by the worker', async () => {
  const repo = new InMemoryRepo();
  const storage = new MemoryStorage();
  const deps: WorkerDeps = {
    repo, storage, providers: [{ canHandle: () => true, fetchVideo: async () => meta() }], providerName: 'test',
    downloader: { download: async (_u, _h, dest) => { await writeFile(dest, MP4); return MP4.length; } },
    prober: { probe: async () => ({ container: 'mp4', videoCodec: 'h264', durationSeconds: 623.3, width: 1280, height: 676 }) },
    limits: { maxBytes: 200 * 1024 * 1024, maxDurationSeconds: 900 },
  };
  const queue = new JobQueue((id) => processJob(deps, id));
  const service = new ImportService(repo, storage, (id) => queue.enqueue(id));
  const { jobId } = await service.startImport('user1', TT);
  await queue.onIdle();
  assert.equal((await service.getJob('user1', jobId))!.status, 'COMPLETED');
});

test('too-large file from the downloader maps to FILE_TOO_LARGE', async () => {
  const { InvalidMediaError } = await import('../src/media.js');
  const repo = new InMemoryRepo();
  const storage = new MemoryStorage();
  const deps: WorkerDeps = {
    repo, storage, providers: [{ canHandle: () => true, fetchVideo: async () => meta() }], providerName: 'test',
    downloader: { download: async () => { throw new InvalidMediaError('file too large', 'TOO_LARGE'); } },
    prober: { probe: async () => ({ container: 'mp4', videoCodec: 'h264', durationSeconds: 5 }) },
  };
  const queue = new JobQueue((id) => processJob(deps, id));
  const service = new ImportService(repo, storage, (id) => queue.enqueue(id));
  const { jobId } = await service.startImport('user1', TT);
  await queue.onIdle();
  const j = (await service.getJob('user1', jobId))!;
  assert.equal(j.errorCode, 'FILE_TOO_LARGE');
  assert.match(j.message!, /too large/);
});

test('locations are stored and returned; absent locations come back as an empty list', async () => {
  const s = setup({ fetch: async () => meta({ locations: ['Ubud, Bali', 'Canggu'] }) });
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const v = (await getJob(s.app, jobId)).json().video;
  assert.deepEqual(v.locations, ['Ubud, Bali', 'Canggu']);

  const s2 = setup();
  const j2 = (await post(s2.app, TT)).json();
  await s2.queue.onIdle();
  assert.deepEqual((await getJob(s2.app, j2.jobId)).json().video.locations, []);
});

test('places: file video enqueues enrichment after COMPLETED with frames and caption data; failures never affect the import', async () => {
  const jobs: any[] = [];
  const s = setup({
    fetch: async () => meta({ description: 'Sunset 📍Ubud', locations: ['Ubud'] }),
    extraDeps: { frameExtractor: { extract: async () => [Buffer.from('f1'), Buffer.from('f2')] }, enqueuePlaces: (j) => jobs.push(j) },
  });
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const done = (await getJob(s.app, jobId)).json();
  assert.equal(done.status, 'COMPLETED');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].videoId, done.video.id);
  assert.equal(jobs[0].userId, 'user1');
  assert.equal(jobs[0].frames.length, 2);
  assert.deepEqual(jobs[0].input.locations, ['Ubud']);
  assert.deepEqual(jobs[0].input.hashtags, ['tag1', 'tag2']);
});

test('places: a throwing frame extractor or enqueue still completes the import', async () => {
  const s = setup({ extraDeps: { frameExtractor: { extract: async () => { throw new Error('ffmpeg missing'); } }, enqueuePlaces: () => { throw new Error('queue broke'); } } });
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  assert.equal((await getJob(s.app, jobId)).json().status, 'COMPLETED');
});

test('places: with a frame extractor but no enqueue hook, frames are never extracted', async () => {
  let called = 0;
  const s = setup({ extraDeps: { frameExtractor: { extract: async () => { called++; return []; } } } });
  await post(s.app, TT);
  await s.queue.onIdle();
  assert.equal(called, 0);
});

test('places: end to end, saved places show up in the API video; none yet means an empty list', async () => {
  const s = setup();
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const v = (await getJob(s.app, jobId)).json().video;
  assert.deepEqual(v.places, []);
  await s.repo.updatePlaces(v.id, 'user1', [{ name: 'Ubud', latitude: -8.5, longitude: 115.2, source: 'caption', displayName: 'Ubud, Bali', photoKey: null, category: null }]);
  const again = (await s.app.inject({ method: 'GET', url: `/v1/social-videos/${v.id}`, headers: auth })).json();
  assert.deepEqual(again.places, [{ name: 'Ubud', latitude: -8.5, longitude: 115.2, source: 'caption', displayName: 'Ubud, Bali', category: null, photoUrl: null }]);
  assert.equal(again.summary, null, 'no summary until the enrichment writes one');
  const list = (await s.app.inject({ method: 'GET', url: '/v1/social-videos', headers: auth })).json();
  assert.equal(list.items[0].places.length, 1);
});

test('places: the worker asks the frame extractor for about one frame per 5 seconds, capped by the default or an override', async () => {
  const asked: number[] = [];
  const long = { container: 'mp4', videoCodec: 'h264', durationSeconds: 80, width: 720, height: 1280 };
  const mk = (placeFrames?: number, probe: typeof long | undefined = long) => setup({ probe, extraDeps: { frameExtractor: { extract: async (_f, _d, n) => { asked.push(n); return []; } }, enqueuePlaces: () => {}, ...(placeFrames === undefined ? {} : { placeFrames }) } });
  for (const s of [mk(), mk(3), mk(0), mk(undefined, { ...long, durationSeconds: 12 })]) { await post(s.app, TT); await s.queue.onIdle(); }
  assert.deepEqual(asked, [16, 3, 0, 3]);
});

test('places: API returns a signed photo URL and category for places with a photo, and the AI summary once written', async () => {
  const s = setup();
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const v = (await getJob(s.app, jobId)).json().video;
  await s.repo.updatePlaces(v.id, 'user1', [
    { name: 'Tre Cime', latitude: 46.6, longitude: 12.3, source: 'frame-ai', displayName: 'Tre Cime, Italy', photoKey: 'social-videos/user1/' + v.id + '/place-0.jpg', category: 'Mountain peak' },
    { name: 'Dolomites', latitude: 46.3, longitude: 12.05, source: 'text-ai', displayName: null, photoKey: null, category: 'Region' },
  ]);
  await s.repo.updateSummary(v.id, 'user1', { title: 'Dolomites hikes', takeaways: ['Tre Cime is best for views'] });
  const got = (await s.app.inject({ method: 'GET', url: `/v1/social-videos/${v.id}`, headers: auth })).json();
  assert.match(got.places[0].photoUrl, /^https:\/\/storage\.test\/social-videos\/user1\/video_.+\/place-0\.jpg\?sig=test$/);
  assert.equal(got.places[0].category, 'Mountain peak');
  assert.equal(got.places[1].photoUrl, null);
  assert.deepEqual(got.summary, { title: 'Dolomites hikes', takeaways: ['Tre Cime is best for views'] });
  assert.ok(!JSON.stringify(got.places).includes('photoKey'), 'storage keys are never exposed');
  const other = (await s.app.inject({ method: 'GET', url: `/v1/social-videos/${v.id}`, headers: { authorization: 'Bearer dev-someone-else' } }));
  assert.equal(other.statusCode, 404, 'another user cannot read the places or summary');
});

// ---------- deleting a video ----------

const del = (app: ReturnType<typeof setup>['app'], id: string, headers: Record<string, string> = auth) => app.inject({ method: 'DELETE', url: `/v1/social-videos/${id}`, headers });
const getVideoRes = (app: ReturnType<typeof setup>['app'], id: string, headers = auth) => app.inject({ method: 'GET', url: `/v1/social-videos/${id}`, headers });

async function importOne(s: ReturnType<typeof setup>) {
  const { jobId } = (await post(s.app, TT)).json();
  await s.queue.onIdle();
  const v = (await getJob(s.app, jobId)).json().video;
  return { jobId, v };
}

test('delete: owner deletes a video: 204, gone from GET and the list, files removed, its job is gone too', async () => {
  const s = setup();
  const { jobId, v } = await importOne(s);
  const row = (await s.repo.getVideo(v.id, 'user1'))!;
  const photo = `social-videos/user1/${v.id}/place-0.jpg`;
  await s.storage.putBuffer(photo, Buffer.from('jpg'), 'image/jpeg');
  await s.repo.updatePlaces(v.id, 'user1', [{ name: 'Ubud', latitude: 1, longitude: 2, source: 'frame-ai', displayName: null, photoKey: photo, category: null }]);
  assert.ok(s.storage.objects.has(row.storageKey!) && s.storage.objects.has(row.thumbnailKey!) && s.storage.objects.has(photo));

  const res = await del(s.app, v.id);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  assert.equal((await getVideoRes(s.app, v.id)).statusCode, 404);
  assert.equal((await list(s.app)).json().items.length, 0);
  assert.equal(s.storage.objects.size, 0, 'video, thumbnail, and place photo are all removed');
  assert.equal((await getJob(s.app, jobId)).statusCode, 404, 'the import job that pointed at the video is removed');
});

test('delete: a second delete, an unknown id, and a malformed id are all 404', async () => {
  const s = setup();
  const { v } = await importOne(s);
  assert.equal((await del(s.app, v.id)).statusCode, 204);
  assert.equal((await del(s.app, v.id)).statusCode, 404, 'deleting twice is a clean 404, which clients treat as already gone');
  assert.equal((await del(s.app, 'video_does-not-exist')).statusCode, 404);
  for (const bad of ['a%2Fb', '..%2Fx', 'x'.repeat(81), '%20', 'a%00b']) assert.equal((await del(s.app, bad)).statusCode, 404, bad);
});

test('delete: requires auth, and another user can neither delete nor see the video', async () => {
  const s = setup();
  const { v } = await importOne(s);
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/v1/social-videos/${v.id}` })).statusCode, 401);
  assert.equal((await del(s.app, v.id, { authorization: 'Bearer nope' })).statusCode, 401);
  assert.equal((await del(s.app, v.id, { authorization: 'Bearer dev-someone-else' })).statusCode, 404);
  assert.equal((await getVideoRes(s.app, v.id)).statusCode, 200, 'the owner still has it');
  assert.equal(s.storage.objects.size, 2, 'the files are untouched');
});

test('delete: the same link can be imported again afterwards and gets a new video', async () => {
  const s = setup();
  const first = await importOne(s);
  await del(s.app, first.v.id);
  const again = await post(s.app, TT);
  assert.equal(again.statusCode, 202, 'a new job is created, not a link to the deleted video');
  await s.queue.onIdle();
  const second = (await getJob(s.app, again.json().jobId)).json().video;
  assert.notEqual(second.id, first.v.id);
});

test('delete: a storage failure does not undo the delete; it is logged and the video is gone', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const s = setup();
  const { v } = await importOne(s);
  const service = new ImportService(s.repo, s.storage, () => {}, (l) => logs.push(l));
  s.storage.failDeletes = true;
  assert.equal(await service.deleteVideo('user1', v.id), true);
  assert.equal((await getVideoRes(s.app, v.id)).statusCode, 404);
  assert.ok(logs.some((l) => l.msg === 'delete.storage_failed' && l.objects === 2));
  assert.ok(!JSON.stringify(logs).includes('dev-user1'), 'no tokens in logs');
});

test('delete: an embed video has no files, so storage is not called at all', async () => {
  const s = setup();
  let calls = 0;
  const storage = { ...s.storage, deleteObjects: async () => { calls++; } } as unknown as MemoryStorage;
  const service = new ImportService(s.repo, storage, () => {});
  const v = await s.repo.createVideo({
    userId: 'user1', platform: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', normalizedUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', contentId: 'aaaaaaaaaaa',
    authorUsername: null, authorDisplayName: null, title: null, description: null, thumbnailKey: null, storageKey: null, duration: null, publishedAt: null, viewCount: null, likeCount: null,
    commentCount: null, repostCount: null, saveCount: null, musicTitle: null, musicArtist: null, authorId: null, authorUrl: null, hashtags: [], width: null, height: null, videoCodec: null, fileSizeBytes: null,
    playbackKind: 'embed', embedUrl: 'https://www.youtube.com/embed/aaaaaaaaaaa',
  });
  assert.equal(await service.deleteVideo('user1', v.id), true);
  assert.equal(calls, 0);
});

test('delete: only the deleted user\'s video goes; the same content imported by another user is untouched', async () => {
  const s = setup();
  const mine = await importOne(s);
  const other = (await s.app.inject({ method: 'POST', url: '/v1/social-videos/import', headers: { authorization: 'Bearer dev-user2' }, payload: { url: TT } as never })).json();
  await s.queue.onIdle();
  const theirs = (await s.app.inject({ method: 'GET', url: `/v1/social-videos/import/${other.jobId}`, headers: { authorization: 'Bearer dev-user2' } })).json().video;
  assert.equal((await del(s.app, mine.v.id)).statusCode, 204);
  assert.equal((await getVideoRes(s.app, theirs.id, { authorization: 'Bearer dev-user2' })).statusCode, 200);
  const keys = [...s.storage.objects.keys()];
  assert.ok(keys.length > 0 && keys.every((k) => k.startsWith('social-videos/user2/')), 'only user2 files remain');
});

test('enrichment: a video starts as processing with the announced count when enrichment is on, and null when it is off', async () => {
  const on = setup({ fetch: async () => meta({ title: '5 tempat wisata terbaik', description: 'five spots' }), extraDeps: { enqueuePlaces: () => {} } });
  const { jobId } = (await post(on.app, TT)).json();
  await on.queue.onIdle();
  const v = (await getJob(on.app, jobId)).json().video;
  assert.deepEqual(v.enrichment, { state: 'processing', expectedPlaces: 5 });
  const list = (await on.app.inject({ method: 'GET', url: '/v1/social-videos', headers: auth })).json();
  assert.deepEqual(list.items[0].enrichment, { state: 'processing', expectedPlaces: 5 });

  const off = setup();
  const j2 = (await post(off.app, TT)).json();
  await off.queue.onIdle();
  assert.equal((await getJob(off.app, j2.jobId)).json().video.enrichment, null, 'no enrichment configured: nothing to wait for');

  const noCount = setup({ extraDeps: { enqueuePlaces: () => {} } });
  const j3 = (await post(noCount.app, TT)).json();
  await noCount.queue.onIdle();
  assert.deepEqual((await getJob(noCount.app, j3.jobId)).json().video.enrichment, { state: 'processing', expectedPlaces: null });
});

test('enrichment: a video that announces a count gets twice as many frames extracted; one that does not gets the normal number', async () => {
  const asked: number[] = [];
  const long = { container: 'mp4', videoCodec: 'h264', durationSeconds: 80, width: 720, height: 1280 };
  const mk = (title: string, placeFrames?: number) => setup({ probe: long, fetch: async () => meta({ title, description: 'caption' }), extraDeps: { frameExtractor: { extract: async (_f, _d, n) => { asked.push(n); return []; } }, enqueuePlaces: () => {}, ...(placeFrames === undefined ? {} : { placeFrames }) } });
  for (const s of [mk('5 tempat wisata'), mk('just a title'), mk('top 3 beaches', 4), mk('5 tempat wisata', 0)]) { await post(s.app, TT); await s.queue.onIdle(); }
  assert.deepEqual(asked, [32, 16, 8, 0], 'doubled (capped at 32) when a count is announced; none when frames are turned off');
});

test('enrichment: the job input carries the announced count to the place worker', async () => {
  const jobs: any[] = [];
  const s = setup({ fetch: async () => meta({ title: null, description: 'Top 7 beaches in Bali' }), extraDeps: { enqueuePlaces: (j) => jobs.push(j) } });
  await post(s.app, TT);
  await s.queue.onIdle();
  assert.equal(jobs[0].input.expectedPlaces, 7);
});
