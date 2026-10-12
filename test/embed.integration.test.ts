import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepo } from '../src/repo.js';
import { MemoryStorage } from '../src/storage.js';
import { JobQueue } from '../src/queue.js';
import { ImportService } from '../src/service.js';
import { buildServer, devAuthVerifier } from '../src/server.js';
import { processJob, type WorkerDeps } from '../src/worker.js';
import { YouTubeEmbedProvider } from '../src/youtube.js';
import type { Downloader } from '../src/download.js';

const ID = 'AbCdEfGhIjK';
const auth = { authorization: 'Bearer dev-user1' };
const OEMBED = { title: 'Short title #tag', author_name: 'Chan', author_url: 'https://www.youtube.com/@chan', thumbnail_url: `https://i.ytimg.com/vi/${ID}/hq2.jpg` };

function setup(resp: { status?: number; body?: unknown } = { body: OEMBED }) {
  const repo = new InMemoryRepo();
  const storage = new MemoryStorage();
  let oembedCalls = 0;
  const fetchImpl = (async () => {
    oembedCalls++;
    return { status: resp.status ?? 200, json: async () => resp.body } as Response;
  }) as unknown as typeof fetch;
  let downloads = 0;
  const downloader: Downloader = { download: async () => { downloads++; throw new Error('must not download'); } };
  const deps: WorkerDeps = {
    repo, storage, downloader, providers: [new YouTubeEmbedProvider({ fetchImpl })], providerName: 'test',
    prober: { probe: async () => { throw new Error('must not probe'); } },
  };
  const queue = new JobQueue((id) => processJob(deps, id));
  const service = new ImportService(repo, storage, (id) => queue.enqueue(id));
  const app = buildServer(service, devAuthVerifier);
  return { app, repo, storage, queue, oembedCalls: () => oembedCalls, downloads: () => downloads };
}

const post = (s: ReturnType<typeof setup>, url: string) =>
  s.app.inject({ method: 'POST', url: '/v1/social-videos/import', headers: auth, payload: { url } as never });
const job = (s: ReturnType<typeof setup>, id: string) => s.app.inject({ method: 'GET', url: `/v1/social-videos/import/${id}`, headers: auth });

test('youtube shorts: completes without download/probe/storage; embed playback in the dto', async () => {
  const s = setup();
  const res = await post(s, `https://youtube.com/shorts/${ID}?si=x`);
  assert.equal(res.statusCode, 202);
  await s.queue.onIdle();
  const j = (await job(s, res.json().jobId)).json();
  assert.equal(j.status, 'COMPLETED');
  assert.equal(j.progress, 100);
  const v = j.video;
  assert.equal(v.platform, 'youtube');
  assert.equal(v.videoUrl, null);
  assert.deepEqual(v.playback, { kind: 'embed', embedUrl: `https://www.youtube-nocookie.com/embed/${ID}?playsinline=1&rel=0` });
  assert.equal(v.thumbnailUrl, `https://i.ytimg.com/vi/${ID}/hq2.jpg`);
  assert.equal(v.title, 'Short title #tag');
  assert.equal(v.authorUsername, 'chan');
  assert.equal(v.authorUrl, 'https://www.youtube.com/@chan');
  assert.deepEqual(v.hashtags, ['tag']);
  assert.deepEqual(v.media, { width: null, height: null, codec: null, fileSizeBytes: null });
  assert.equal(s.downloads(), 0);
  assert.equal(s.storage.objects.size, 0);
});

test('youtube: shorts / watch / youtu.be spellings dedupe to one video and one oEmbed call', async () => {
  const s = setup();
  await post(s, `https://www.youtube.com/shorts/${ID}`);
  await s.queue.onIdle();
  const again = await post(s, `https://youtu.be/${ID}?si=1`);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().status, 'COMPLETED');
  assert.equal(s.repo.videos.size, 1);
  assert.equal(s.oembedCalls(), 1);
});

test('youtube: appears in the feed with file videos; file videos keep playback.kind=file', async () => {
  const s = setup();
  await post(s, `https://www.youtube.com/shorts/${ID}`);
  await s.queue.onIdle();
  await s.repo.createVideo({
    userId: 'user1', platform: 'tiktok', sourceUrl: 'u', normalizedUrl: 'https://www.tiktok.com/@c/video/100000', contentId: '100000',
    authorUsername: 'c', authorDisplayName: 'C', title: 't', description: null, thumbnailKey: 'tk', storageKey: 'sk', duration: 5,
    publishedAt: null, viewCount: null, likeCount: null, commentCount: null, repostCount: null, saveCount: null, musicTitle: null,
    musicArtist: null, authorId: null, authorUrl: null, hashtags: [], width: null, height: null, videoCodec: null, fileSizeBytes: null,
  });
  const feed = (await s.app.inject({ method: 'GET', url: '/v1/social-videos?limit=10', headers: auth })).json();
  assert.equal(feed.items.length, 2);
  const byPlatform = Object.fromEntries(feed.items.map((v: { platform: string }) => [v.platform, v]));
  assert.equal(byPlatform.tiktok.playback.kind, 'file');
  assert.equal(byPlatform.tiktok.playback.embedUrl, null);
  assert.match(byPlatform.tiktok.videoUrl, /^https:\/\/storage\.test\//);
  assert.equal(byPlatform.youtube.playback.kind, 'embed');
  assert.equal(byPlatform.youtube.videoUrl, null);
  // single-video endpoint serves embeds too
  const one = await s.app.inject({ method: 'GET', url: `/v1/social-videos/${byPlatform.youtube.id}`, headers: auth });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().playback.kind, 'embed');
});

test('youtube failures: embedding disabled, unavailable, provider error', async () => {
  const cases: Array<[number, string, RegExp]> = [
    [401, 'EMBEDDING_DISABLED', /outside YouTube/],
    [404, 'VIDEO_UNAVAILABLE', /no longer available/],
    [500, 'PROVIDER_ERROR', /couldn't import/],
  ];
  for (const [status, code, msg] of cases) {
    const s = setup({ status, body: {} });
    const { jobId } = (await post(s, `https://www.youtube.com/shorts/${ID}`)).json();
    await s.queue.onIdle();
    const j = (await job(s, jobId)).json();
    assert.equal(j.status, 'FAILED');
    assert.equal(j.errorCode, code);
    assert.match(j.message, msg);
    assert.equal(s.repo.videos.size, 0);
  }
});

test('youtube: bad urls are rejected before any request', async () => {
  const s = setup();
  for (const u of ['https://www.youtube.com/shorts/short', 'https://youtube.com.evil.com/shorts/' + ID, 'https://www.youtube.com/playlist?list=x']) {
    assert.equal((await post(s, u)).statusCode, 400, u);
  }
  assert.equal(s.oembedCalls(), 0);
  assert.equal(s.repo.jobs.size, 0);
});
