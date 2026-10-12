import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { parseYoutubeMode } from '../src/config.js';
import { ProviderError, selectProvider } from '../src/provider.js';
import { YouTubeEmbedProvider } from '../src/youtube.js';
import { YtDlpSocialVideoProvider, type Exec } from '../src/ytdlp.js';
import { InMemoryRepo } from '../src/repo.js';
import { MemoryStorage } from '../src/storage.js';
import { JobQueue } from '../src/queue.js';
import { ImportService } from '../src/service.js';
import { processJob, type WorkerDeps } from '../src/worker.js';

const ID = 'AbCdEfGhIjK';
const YT = `https://www.youtube.com/shorts/${ID}`;
const code = (c: string) => (e: unknown) => e instanceof ProviderError && e.code === c;

// Synthetic yt-dlp-shaped YouTube output.
const info = (o: Record<string, unknown> = {}) => ({
  id: ID, ext: 'mp4', url: undefined,
  requested_formats: [{ url: 'https://rr1.googlevideo.com/v.mp4' }, { url: 'https://rr1.googlevideo.com/a.m4a' }],
  title: 'A short title', description: 'Caption #One #two', uploader: 'Some Channel', uploader_id: '@somechannel',
  channel_id: 'UCabcdefghijklmnopqrstuv', uploader_url: 'https://www.youtube.com/@somechannel',
  view_count: 1706, like_count: 65, comment_count: 3, duration: 43, upload_date: '20261006', thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg', ...o,
});
const ok = (o?: Record<string, unknown>): Exec => async () => ({ stdout: JSON.stringify(info(o)) });

test('YOUTUBE_MODE parsing: default embed, explicit values, rejects anything else', () => {
  assert.equal(parseYoutubeMode(undefined), 'embed');
  assert.equal(parseYoutubeMode(''), 'embed');
  assert.equal(parseYoutubeMode('embed'), 'embed');
  assert.equal(parseYoutubeMode('download'), 'download');
  for (const bad of ['Download', 'EMBED', 'yes', 'true', ' download', 'download ', '1']) {
    assert.throws(() => parseYoutubeMode(bad), /YOUTUBE_MODE/, bad);
  }
});

test('download mode: yt-dlp takes youtube, still never threads', async () => {
  const p = new YtDlpSocialVideoProvider({ exec: ok(), allowYoutube: true });
  assert.equal(p.canHandle(YT), true);
  assert.equal(p.canHandle('https://www.threads.com/@a/post/AbCdE12345'), false);
  await assert.rejects(p.fetchVideo('https://www.threads.com/@a/post/AbCdE12345'), code('UNSUPPORTED_PLATFORM'));
  // default config is unchanged
  assert.equal(new YtDlpSocialVideoProvider({ exec: ok() }).canHandle(YT), false);
  assert.equal(new YtDlpSocialVideoProvider({ exec: ok(), allowYoutube: false }).canHandle(YT), false);
});

test('provider order decides: embed provider wins unless it is left out', () => {
  const embed = new YouTubeEmbedProvider({});
  const dl = new YtDlpSocialVideoProvider({ exec: ok(), allowYoutube: true });
  assert.equal(selectProvider([embed, dl], YT), embed);
  assert.equal(selectProvider([dl], YT), dl);
  // other platforms always go to yt-dlp
  assert.equal(selectProvider([embed, dl], 'https://vt.tiktok.com/ZSabc123/'), dl);
});

test('youtube mapping: handle, channel id as author id, date from upload_date, merged media url, hashtags', async () => {
  const r = await new YtDlpSocialVideoProvider({ exec: ok(), allowYoutube: true }).fetchVideo(YT);
  assert.equal(r.platform, 'youtube');
  assert.equal(r.playbackKind, undefined, 'file playback (default)');
  assert.equal(r.contentId, ID);
  assert.equal(r.videoUrl, 'https://rr1.googlevideo.com/v.mp4');
  assert.equal(r.authorUsername, 'somechannel');
  assert.equal(r.authorDisplayName, 'Some Channel');
  assert.equal(r.authorId, 'UCabcdefghijklmnopqrstuv');
  assert.equal(r.authorUrl, 'https://www.youtube.com/@somechannel');
  assert.equal(r.title, 'A short title');
  assert.deepEqual([r.viewCount, r.likeCount, r.commentCount, r.duration], [1706, 65, 3, 43]);
  assert.equal(r.publishedAt, '2026-10-06T00:00:00.000Z');
  assert.deepEqual(r.hashtags, ['One', 'two']);
});

test('youtube mapping edge cases: bad handle, missing id parts, malformed upload_date, hostile urls', async () => {
  const run = (o: Record<string, unknown>) => new YtDlpSocialVideoProvider({ exec: ok(o), allowYoutube: true }).fetchVideo(YT);
  const a = await run({ uploader_id: '@a', uploader_url: 'https://evil.com/@a', channel_id: undefined });
  assert.equal(a.authorUsername, '', 'handle shorter than 3 chars is dropped');
  assert.equal(a.authorUrl, null);
  assert.equal(a.authorId, '@a', 'falls back to uploader_id when there is no channel id');
  for (const upload_date of ['2026-10-06', '20261', '99999999', 'abcdefgh', 20261006, undefined]) {
    assert.equal((await run({ upload_date })).publishedAt, null, String(upload_date));
  }
  assert.equal((await run({ timestamp: 1700000000, upload_date: '20200101' })).publishedAt, '2023-11-14T22:13:20.000Z', 'timestamp wins');
  await assert.rejects(run({ requested_formats: [{ url: 'http://insecure/v.mp4' }] }), code('VIDEO_UNAVAILABLE'));
  await assert.rejects(run({ ext: 'webm' }), code('INVALID_MEDIA'));
});

test('youtube uses the h264 mp4 + m4a selector with an mp4 container; other platforms keep the old selector', async () => {
  const seen: string[][] = [];
  const exec: Exec = async (a) => { seen.push(a); return { stdout: JSON.stringify(info()) }; };
  const p = new YtDlpSocialVideoProvider({ exec, allowYoutube: true });
  await p.fetchVideo(YT);
  await p.downloadVideo(YT, '/tmp/v.mp4', 1000);
  await p.fetchVideo('https://vt.tiktok.com/ZSabc123/').catch(() => {});
  const sel = (a: string[]) => a[a.indexOf('-f') + 1]!;
  assert.match(sel(seen[0]!), /^bestvideo\[height<=1080\]\[vcodec\^=avc1\]\[ext=mp4\]\+bestaudio\[ext=m4a\]/);
  assert.equal(sel(seen[1]!), sel(seen[0]!));
  assert.equal(seen[0]![seen[0]!.indexOf('--merge-output-format') + 1], 'mp4');
  assert.equal(seen[0]!.at(-1), YT);
  assert.ok(sel(seen[2]!).startsWith('best[ext=mp4][protocol=https]/'), 'tiktok selector unchanged');
});

test('youtube download falls back to any format once, like other platforms; size cap is passed', async () => {
  const selectors: string[] = [];
  let maxFilesize = '';
  const exec: Exec = async (a) => {
    selectors.push(a[a.indexOf('-f') + 1]!);
    maxFilesize = a[a.indexOf('--max-filesize') + 1]!;
    if (selectors.length === 1) throw new Error('Requested format is not available');
    return { stdout: '[download] 100%' };
  };
  await new YtDlpSocialVideoProvider({ exec, allowYoutube: true }).downloadVideo(YT, '/tmp/v.mp4', 5555);
  assert.equal(selectors.length, 2);
  assert.equal(selectors[1], 'best');
  assert.equal(maxFilesize, '5555');
});

test('worker in download mode: youtube becomes a stored file video, no embed', async () => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), Buffer.from('isom0000')]);
  const repo = new InMemoryRepo();
  const storage = new MemoryStorage();
  const provider = new YtDlpSocialVideoProvider({ exec: ok(), allowYoutube: true });
  provider.downloadVideo = async (_u, dest) => { await writeFile(dest, MP4); };
  const deps: WorkerDeps = {
    repo, storage, providerName: 'test', providers: [provider],
    downloader: { download: async (_u, _h, dest) => { await writeFile(dest, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])); return 6; } },
    prober: { probe: async () => ({ container: 'mp4', videoCodec: 'h264', durationSeconds: 43, width: 576, height: 1024 }) },
  };
  const queue = new JobQueue((id) => processJob(deps, id));
  const service = new ImportService(repo, storage, (id) => queue.enqueue(id));
  const { jobId } = await service.startImport('u1', 'https://youtube.com/shorts/AbCdEfGhIjK?si=x');
  await queue.onIdle();
  const j = (await service.getJob('u1', jobId))!;
  assert.equal(j.status, 'COMPLETED');
  assert.equal(j.video!.platform, 'youtube');
  assert.deepEqual(j.video!.playback, { kind: 'file', embedUrl: null });
  assert.match(j.video!.videoUrl!, /^https:\/\/storage\.test\/social-videos\/u1\/video_.+\/video\.mp4/);
  assert.equal(j.video!.authorUsername, 'somechannel');
  assert.deepEqual(j.video!.media, { width: 576, height: 1024, codec: 'h264', fileSizeBytes: MP4.length });
  assert.equal(j.video!.stats.views, 1706);
  // same video via another spelling dedupes
  const again = await service.startImport('u1', 'https://youtu.be/AbCdEfGhIjK');
  assert.equal(again.status, 'COMPLETED');
  assert.equal(repo.videos.size, 1);
});
