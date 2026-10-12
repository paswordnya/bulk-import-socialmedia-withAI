import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, selectProvider, type SocialVideoProvider } from '../src/provider.js';
import { YtDlpSocialVideoProvider, type Exec } from '../src/ytdlp.js';

const TT = 'https://www.tiktok.com/@creator/video/111';
const IG = 'https://www.instagram.com/reel/Cabc_123/';

// Synthetic yt-dlp-shaped output; not real creator content.
const info = (over: Record<string, unknown> = {}) => ({
  id: '111',
  url: 'https://cdn.example.com/v.mp4',
  ext: 'mp4',
  uploader: 'creator\u0000',
  uploader_id: '6971970295037576194',
  channel: 'Creator Name',
  title: 'A title\u0000',
  description: 'hi\nthere #One #two #ONE',
  thumbnail: 'https://cdn.example.com/t.jpg',
  duration: 31.6,
  timestamp: 1700000000,
  view_count: 443600,
  like_count: 49600,
  comment_count: 406,
  repost_count: 665,
  save_count: 2013,
  track: 'original sound',
  artist: 'Some Artist',
  uploader_url: 'https://www.tiktok.com/@creator',
  http_headers: { 'User-Agent': 'UA', Cookie: 'secret=1', Referer: 'https://www.tiktok.com/' },
  ...over,
});

const ok = (o?: Record<string, unknown>): Exec => async () => ({ stdout: JSON.stringify(info(o)) });
const fail = (message: string, killed = false): Exec => async () => { throw Object.assign(new Error(message), { killed }); };
const code = (c: string) => (e: unknown) => e instanceof ProviderError && e.code === c;

test('maps and sanitizes metadata; drops sensitive headers', async () => {
  const r = await new YtDlpSocialVideoProvider({ exec: ok() }).fetchVideo(TT);
  assert.equal(r.contentId, '111');
  assert.equal(r.authorUsername, 'creator');
  assert.equal(r.authorDisplayName, 'Creator Name');
  assert.equal(r.description, 'hi there #One #two #ONE');
  assert.deepEqual(r.hashtags, ['One', 'two']);
  assert.deepEqual([r.viewCount, r.likeCount, r.commentCount, r.repostCount, r.saveCount], [443600, 49600, 406, 665, 2013]);
  assert.equal(r.musicTitle, 'original sound');
  assert.equal(r.musicArtist, 'Some Artist');
  assert.equal(r.authorId, '6971970295037576194');
  assert.equal(r.authorUrl, 'https://www.tiktok.com/@creator');
  assert.equal(r.title, 'A title');
  assert.equal(r.duration, 32);
  assert.equal(r.publishedAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(Object.keys(r.downloadHeaders ?? {}).sort(), ['Referer', 'User-Agent']);
});

test('URL is normalized and passed after "--" as one argv entry, no shell', async () => {
  let args: string[] = [];
  const exec: Exec = async (a) => { args = a; return { stdout: JSON.stringify(info()) }; };
  await new YtDlpSocialVideoProvider({ exec }).fetchVideo('https://tiktok.com/@Creator/video/111?x=1');
  assert.equal(args.at(-1), 'https://www.tiktok.com/@creator/video/111');
  assert.equal(args.at(-2), '--');
  assert.ok(args.includes('--no-playlist'));
});

test('rejects unsupported URLs without spawning', async () => {
  let called = 0;
  const exec: Exec = async () => { called++; return { stdout: '{}' }; };
  const p = new YtDlpSocialVideoProvider({ exec });
  for (const u of ['https://evil.com/x', '--exec=rm', 'http://127.0.0.1/reel/abcde/']) {
    await assert.rejects(p.fetchVideo(u));
  }
  assert.equal(called, 0);
});

test('falls back to url content id (instagram) when info.id missing', async () => {
  const r = await new YtDlpSocialVideoProvider({ exec: ok({ id: undefined }) }).fetchVideo(IG);
  assert.equal(r.contentId, 'Cabc_123');
});

test('no id anywhere (tiktok short link) -> PROVIDER_ERROR', async () => {
  await assert.rejects(
    new YtDlpSocialVideoProvider({ exec: ok({ id: undefined }) }).fetchVideo('https://vm.tiktok.com/ZSabc123'),
    code('PROVIDER_ERROR'),
  );
});

test('missing / non-https / non-mp4 media -> typed errors', async () => {
  for (const url of [undefined, '', 'http://cdn/v.mp4', 'file:///etc/passwd']) {
    await assert.rejects(new YtDlpSocialVideoProvider({ exec: ok({ url }) }).fetchVideo(TT), code('VIDEO_UNAVAILABLE'));
  }
  await assert.rejects(new YtDlpSocialVideoProvider({ exec: ok({ ext: 'm3u8' }) }).fetchVideo(TT), code('INVALID_MEDIA'));
});

test('invalid duration values become null', async () => {
  for (const duration of [0, -5, 'x', undefined]) {
    const r = await new YtDlpSocialVideoProvider({ exec: ok({ duration }) }).fetchVideo(TT);
    assert.equal(r.duration, null);
  }
});

test('failure classification without leaking stderr', async () => {
  const cases: Array<[string, boolean, string]> = [
    ['ERROR: Private video. Login required', false, 'PRIVATE_CONTENT'],
    ['ERROR: This video has been removed', false, 'VIDEO_UNAVAILABLE'],
    ['HTTP Error 404: Not Found', false, 'VIDEO_UNAVAILABLE'],
    ['whatever', true, 'IMPORT_TIMEOUT'],
    ['segfault at /home/secret/path', false, 'PROVIDER_ERROR'],
  ];
  for (const [msg, killed, c] of cases) {
    await assert.rejects(
      new YtDlpSocialVideoProvider({ exec: fail(msg, killed) }).fetchVideo(TT),
      (e) => code(c)(e) && !/secret/.test((e as Error).message),
    );
  }
});

test('garbage / non-object stdout -> PROVIDER_ERROR', async () => {
  for (const stdout of ['', 'not json', '[]', 'null', '42']) {
    await assert.rejects(new YtDlpSocialVideoProvider({ exec: async () => ({ stdout }) }).fetchVideo(TT), code('PROVIDER_ERROR'));
  }
});

test('selectProvider picks first handler, errors when none', () => {
  const no: SocialVideoProvider = { canHandle: () => false, fetchVideo: async () => { throw new Error(); } };
  const yes: SocialVideoProvider = { canHandle: () => true, fetchVideo: async () => { throw new Error(); } };
  assert.equal(selectProvider([no, yes], TT), yes);
  assert.throws(() => selectProvider([no], TT), code('UNSUPPORTED_PLATFORM'));
  assert.throws(() => selectProvider([], TT), ProviderError);
});

test('downloadVideo: validated URL after "--", size cap and output path passed, % escaped, errors classified', async () => {
  let args: string[] = [];
  const exec: Exec = async (a) => { args = a; return { stdout: '' }; };
  const p = new YtDlpSocialVideoProvider({ exec });
  await p.downloadVideo('https://tiktok.com/@Creator/video/111?x=1', '/tmp/a%b/video.mp4', 1234);
  assert.equal(args.at(-1), 'https://www.tiktok.com/@creator/video/111');
  assert.equal(args.at(-2), '--');
  assert.equal(args[args.indexOf('--max-filesize') + 1], '1234');
  assert.equal(args[args.indexOf('-o') + 1], '/tmp/a%%b/video.mp4');

  await assert.rejects(p.downloadVideo('https://evil.com/x', '/tmp/v.mp4', 1), /./);
  await assert.rejects(
    new YtDlpSocialVideoProvider({ exec: fail('File is larger than max-filesize') }).downloadVideo(TT, '/tmp/v.mp4', 1),
    code('PROVIDER_ERROR'),
  );
  await assert.rejects(
    new YtDlpSocialVideoProvider({ exec: fail('x', true) }).downloadVideo(TT, '/tmp/v.mp4', 1),
    code('IMPORT_TIMEOUT'),
  );
});

test('metadata edge cases: bad counts, hostile profile url, artists fallback, facebook title cleanup', async () => {
  const r = await new YtDlpSocialVideoProvider({
    exec: ok({ view_count: -5, like_count: '12', comment_count: 1.5, repost_count: null, save_count: undefined, uploader_url: 'https://evil.com/@x', channel_url: 'http://www.tiktok.com/@x', track: undefined, artist: undefined, artists: ['First', 'Second'], description: undefined }),
  }).fetchVideo(TT);
  assert.deepEqual([r.viewCount, r.likeCount, r.commentCount, r.repostCount, r.saveCount], [null, null, null, null, null]);
  assert.equal(r.authorUrl, null);
  assert.equal(r.musicTitle, null);
  assert.equal(r.musicArtist, 'First');

  const fb = await new YtDlpSocialVideoProvider({
    exec: ok({ id: '1770153004205987', title: '754K views · 10K reactions | Dari Bandung', uploader_url: undefined, uploader_id: '100044' }),
  }).fetchVideo('https://www.facebook.com/reel/1770153004205987');
  assert.equal(fb.title, 'Dari Bandung');
  assert.equal(fb.authorId, '100044');
  const tt = await new YtDlpSocialVideoProvider({ exec: ok({ title: '10K views | keep me' }) }).fetchVideo(TT);
  assert.equal(tt.title, '10K views | keep me', 'cleanup is facebook-only');
});

test('downloadVideo: yt-dlp exiting 0 with a max-filesize message becomes a TOO_LARGE media error', async () => {
  const { InvalidMediaError } = await import('../src/media.js');
  const exec: Exec = async () => ({ stdout: '[download] File is larger than max-filesize (72000000 bytes > 1000 bytes). Aborting.' });
  await assert.rejects(
    new YtDlpSocialVideoProvider({ exec }).downloadVideo(TT, '/tmp/v.mp4', 1000),
    (e) => e instanceof InvalidMediaError && e.reason === 'TOO_LARGE',
  );
  await new YtDlpSocialVideoProvider({ exec: async () => ({ stdout: '[download] 100% of 1MiB' }) }).downloadVideo(TT, '/tmp/v.mp4', 1000);
});

test('instagram mapping: handle/display roles, generic title dropped, profile url derived', async () => {
  const IGU = 'https://www.instagram.com/reel/Cabc_123/';
  const r = await new YtDlpSocialVideoProvider({
    exec: ok({ id: 'Cabc_123', uploader: 'PERSIB', channel: 'persib', uploader_id: '790222745', title: 'Video by persib', uploader_url: undefined, description: 'Cap #tag' }),
  }).fetchVideo(IGU);
  assert.equal(r.authorUsername, 'persib');
  assert.equal(r.authorDisplayName, 'PERSIB');
  assert.equal(r.title, null);
  assert.equal(r.authorUrl, 'https://www.instagram.com/persib/');
  assert.deepEqual(r.hashtags, ['tag']);
  const bad = await new YtDlpSocialVideoProvider({ exec: ok({ id: 'Cabc_123', channel: 'not a handle!', uploader: 'X', uploader_url: undefined }) }).fetchVideo(IGU);
  assert.equal(bad.authorUrl, null);
  // tiktok roles unchanged
  const tt = await new YtDlpSocialVideoProvider({ exec: ok({ uploader: 'handle', channel: 'Display Name' }) }).fetchVideo(TT);
  assert.equal(tt.authorUsername, 'handle');
  assert.equal(tt.authorDisplayName, 'Display Name');
});

test('per-platform author roles and profile urls (x, pinterest, reddit)', async () => {
  const run = (url: string, o: Record<string, unknown>) => new YtDlpSocialVideoProvider({ exec: ok(o) }).fetchVideo(url);

  const x = await run('https://x.com/someuser/status/123456', { id: '123456', uploader: 'Some Name', uploader_id: 'someuser', uploader_url: undefined, like_count: 5, repost_count: 2, comment_count: 1 });
  assert.deepEqual([x.authorUsername, x.authorDisplayName, x.authorUrl], ['someuser', 'Some Name', 'https://x.com/someuser']);
  assert.deepEqual([x.likeCount, x.repostCount, x.commentCount], [5, 2, 1]);

  const pin = await run('https://www.pinterest.com/pin/123456789/', { id: '123456789', uploader: 'Pin Person', uploader_id: 'pinperson', uploader_url: undefined });
  assert.deepEqual([pin.authorUsername, pin.authorDisplayName, pin.authorUrl], ['pinperson', 'Pin Person', 'https://www.pinterest.com/pinperson/']);

  const rd = await run('https://www.reddit.com/r/funny/comments/abc123/', { id: 'abc123', uploader: 'redditor_1', uploader_id: undefined, uploader_url: undefined, title: 'A post title' });
  assert.deepEqual([rd.authorUsername, rd.authorDisplayName, rd.authorUrl, rd.title], ['redditor_1', null, 'https://www.reddit.com/user/redditor_1/', 'A post title']);


  // hostile handles never become links
  const evil = await run('https://x.com/someuser/status/123456', { id: '123456', uploader: 'N', uploader_id: 'a/b?x', uploader_url: 'https://evil.com/x' });
  assert.equal(evil.authorUrl, null);
});

test('merged video+audio formats: media url comes from requested_formats when url is absent', async () => {
  const r = await new YtDlpSocialVideoProvider({
    exec: ok({ id: 'abc123', url: undefined, requested_formats: [{ url: 'https://v.redd.it/x/video.mp4' }, { url: 'https://v.redd.it/x/audio.mp4' }] }),
  }).fetchVideo('https://www.reddit.com/r/funny/comments/abc123/');
  assert.equal(r.videoUrl, 'https://v.redd.it/x/video.mp4');
  await assert.rejects(
    new YtDlpSocialVideoProvider({ exec: ok({ id: 'abc123', url: undefined, requested_formats: [{ url: 'http://insecure/v.mp4' }] }) }).fetchVideo('https://www.reddit.com/r/funny/comments/abc123/'),
    code('VIDEO_UNAVAILABLE'),
  );
});

test('fetch and download pass the merge-capable format selector and mp4 container', async () => {
  const seen: string[][] = [];
  const exec: Exec = async (a) => { seen.push(a); return { stdout: JSON.stringify(info()) }; };
  const p = new YtDlpSocialVideoProvider({ exec });
  await p.fetchVideo(TT);
  await p.downloadVideo(TT, '/tmp/v.mp4', 1000);
  for (const a of seen) {
    assert.ok(a[a.indexOf('-f') + 1]!.startsWith('best[ext=mp4][protocol=https]/'), 'progressive mp4 stays first choice');
    assert.equal(a[a.indexOf('--merge-output-format') + 1], 'mp4');
  }
});

test('downloadVideo: retries once with any format (HLS) when the first attempt fails', async () => {
  const selectors: string[] = [];
  const exec: Exec = async (a) => {
    selectors.push(a[a.indexOf('-f') + 1]!);
    if (selectors.length === 1) throw new Error('ERROR: unable to download video data: HTTP Error 404: Not Found');
    return { stdout: '[download] 100% of 10MiB' };
  };
  await new YtDlpSocialVideoProvider({ exec }).downloadVideo(TT, '/tmp/v.mp4', 1000);
  assert.equal(selectors.length, 2);
  assert.ok(selectors[0]!.startsWith('best[ext=mp4][protocol=https]/'));
  assert.equal(selectors[1], 'best');
});

test('downloadVideo: no retry for timeout or private content; both attempts failing is classified once', async () => {
  for (const [err, expected] of [[Object.assign(new Error('x'), { killed: true }), 'IMPORT_TIMEOUT'], [new Error('Private video. Login required'), 'PRIVATE_CONTENT']] as const) {
    let calls = 0;
    const exec: Exec = async () => { calls++; throw err; };
    await assert.rejects(new YtDlpSocialVideoProvider({ exec }).downloadVideo(TT, '/tmp/v.mp4', 1000), code(expected));
    assert.equal(calls, 1, expected);
  }
  let calls = 0;
  const exec: Exec = async () => { calls++; throw new Error('HTTP Error 404: Not Found'); };
  await assert.rejects(new YtDlpSocialVideoProvider({ exec }).downloadVideo(TT, '/tmp/v.mp4', 1000), code('VIDEO_UNAVAILABLE'));
  assert.equal(calls, 2, 'exactly one retry');
});

test('x: content id comes from the pasted tweet url, not the media id yt-dlp reports', async () => {
  const X = 'https://x.com/badboysbdg_/status/2107154024835534864';
  const r = await new YtDlpSocialVideoProvider({ exec: ok({ id: '913005321810886662', uploader: 'Name', uploader_id: 'badboysbdg_' }) }).fetchVideo(X);
  assert.equal(r.contentId, '2107154024835534864');
  assert.equal(r.authorUsername, 'badboysbdg_');
  // other platforms still trust yt-dlp's id
  const t = await new YtDlpSocialVideoProvider({ exec: ok({ id: '999' }) }).fetchVideo('https://vm.tiktok.com/ZSabc123');
  assert.equal(t.contentId, '999');
});

test('x mapping drops the synthetic "<name> - <text>" title but keeps the description', async () => {
  const r = await new YtDlpSocialVideoProvider({
    exec: ok({ uploader: 'Some Name', uploader_id: 'someuser', title: 'Some Name - tweet text here', description: 'tweet text here' }),
  }).fetchVideo('https://x.com/someuser/status/123456');
  assert.equal(r.title, null);
  assert.equal(r.description, 'tweet text here');
});

test('yt-dlp "Unsupported URL" is reported as unsupported, not as a retryable provider error; no retry', async () => {
  const THREADS = 'https://www.pinterest.com/pin/123456789/';
  let calls = 0;
  const exec: Exec = async () => { calls++; throw new Error(`ERROR: Unsupported URL: ${THREADS}`); };
  await assert.rejects(new YtDlpSocialVideoProvider({ exec }).fetchVideo(THREADS), code('UNSUPPORTED_PLATFORM'));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(new YtDlpSocialVideoProvider({ exec }).downloadVideo(THREADS, '/tmp/v.mp4', 1000), code('UNSUPPORTED_PLATFORM'));
  assert.equal(calls, 1, 'not retried');
});

test('locations from caption: tiktok and instagram only; other platforms stay empty', async () => {
  const caption = 'Sunset 📍Ubud, Bali #travel';
  const tt = await new YtDlpSocialVideoProvider({ exec: ok({ description: caption }) }).fetchVideo(TT);
  assert.deepEqual(tt.locations, ['Ubud, Bali']);
  const ig = await new YtDlpSocialVideoProvider({ exec: ok({ id: 'Cabc_123', description: 'Lokasi: Kopi Tuku\n#cafe' }) }).fetchVideo(IG);
  assert.deepEqual(ig.locations, ['Kopi Tuku']);
  const fb = await new YtDlpSocialVideoProvider({ exec: ok({ id: '1770153004205987', description: caption }) }).fetchVideo('https://www.facebook.com/reel/1770153004205987');
  assert.deepEqual(fb.locations, []);
  const none = await new YtDlpSocialVideoProvider({ exec: ok({ description: 'no place here' }) }).fetchVideo(TT);
  assert.deepEqual(none.locations, []);
  // TikTok captions can arrive as the title when there is no description.
  const viaTitle = await new YtDlpSocialVideoProvider({ exec: ok({ description: undefined, title: '📍Braga' }) }).fetchVideo(TT);
  assert.deepEqual(viaTitle.locations, ['Braga']);
});
