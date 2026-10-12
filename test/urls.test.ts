import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSocialUrl, isSupportedSocialUrl, SocialUrlError } from '../src/urls.js';

test('tiktok full url is normalized and id extracted', () => {
  const r = parseSocialUrl('  https://TikTok.com/@Some.User/video/123456?is_from_webapp=1#x ');
  assert.deepEqual(r, {
    platform: 'tiktok',
    contentId: '123456',
    normalizedUrl: 'https://www.tiktok.com/@some.user/video/123456',
  });
});

test('tiktok short links have no content id', () => {
  for (const host of ['vm.tiktok.com', 'vt.tiktok.com']) {
    const r = parseSocialUrl(`https://${host}/ZSabc123/?x=1`);
    assert.equal(r.contentId, null);
    assert.equal(r.normalizedUrl, `https://${host}/ZSabc123`);
  }
});

test('instagram reel and post', () => {
  assert.equal(parseSocialUrl('https://instagram.com/reel/Cabc_123-x?igsh=1').normalizedUrl, 'https://www.instagram.com/reel/Cabc_123-x/');
  assert.equal(parseSocialUrl('https://www.instagram.com/p/Cabc_123-x').platform, 'instagram');
});

test('same video via different spellings normalizes identically', () => {
  const a = parseSocialUrl('https://www.tiktok.com/@u/video/9/');
  const b = parseSocialUrl('https://tiktok.com/@U/video/9?foo=bar');
  assert.equal(a.normalizedUrl, b.normalizedUrl);
});

test('rejects empty, garbage, and oversized input as INVALID_URL', () => {
  for (const s of ['', '   ', 'not a url', 'a'.repeat(3000)]) {
    assert.throws(() => parseSocialUrl(s), (e) => e instanceof SocialUrlError && e.code === 'INVALID_URL');
  }
});

test('rejects SSRF-style and lookalike URLs', () => {
  const bad = [
    'http://www.tiktok.com/@u/video/1', // not https
    'https://www.tiktok.com.evil.com/@u/video/1',
    'https://evil.com/?u=https://www.tiktok.com/@u/video/1',
    'https://user:pw@www.tiktok.com/@u/video/1',
    'https://www.tiktok.com:8443/@u/video/1',
    'https://tiktok.com@evil.com/@u/video/1',
    'https://127.0.0.1/@u/video/1',
    'https://localhost/reel/abcde/',
    'https://[::1]/reel/abcde/',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://www.instagram.com/reel/abcde/',
  ];
  for (const s of bad) assert.equal(isSupportedSocialUrl(s), false, s);
});

test('rejects unsupported paths on supported hosts', () => {
  const bad = [
    'https://www.tiktok.com/@u',
    'https://www.tiktok.com/@u/video/abc',
    'https://www.tiktok.com/@u/video/',
    'https://www.instagram.com/stories/u/123/',
    'https://www.instagram.com/u/',
    'https://www.instagram.com/reel/ab/', // too short
    'https://www.instagram.com/reel/abcde/extra',
  ];
  for (const s of bad) {
    assert.throws(() => parseSocialUrl(s), (e) => e instanceof SocialUrlError && e.code === 'UNSUPPORTED_PLATFORM', s);
  }
});

test('facebook: reel, watch, video.php, page video, share and fb.watch normalize', () => {
  const cases: Array<[string, string, string | null]> = [
    ['https://www.facebook.com/reel/123456789?s=x&fs=y', 'https://www.facebook.com/reel/123456789', '123456789'],
    ['https://m.facebook.com/reel/123456789/', 'https://www.facebook.com/reel/123456789', '123456789'],
    ['https://facebook.com/watch/?v=987654321&ref=x', 'https://www.facebook.com/watch/?v=987654321', '987654321'],
    ['https://web.facebook.com/watch?v=987654321', 'https://www.facebook.com/watch/?v=987654321', '987654321'],
    ['https://www.facebook.com/video.php?v=555555&x=1', 'https://www.facebook.com/watch/?v=555555', '555555'],
    ['https://www.facebook.com/SomePage/videos/444444/', 'https://www.facebook.com/somepage/videos/444444', '444444'],
    ['https://www.facebook.com/SomePage/videos/a-title/444444', 'https://www.facebook.com/somepage/videos/444444', '444444'],
    ['https://www.facebook.com/share/v/AbC123xyz/', 'https://www.facebook.com/share/v/AbC123xyz/', null],
    ['https://www.facebook.com/share/r/AbC123xyz', 'https://www.facebook.com/share/r/AbC123xyz/', null],
    ['https://fb.watch/AbC_12-x/', 'https://fb.watch/AbC_12-x/', null],
  ];
  for (const [input, normalized, id] of cases) {
    const r = parseSocialUrl(input);
    assert.equal(r.platform, 'facebook', input);
    assert.equal(r.normalizedUrl, normalized, input);
    assert.equal(r.contentId, id, input);
  }
});

test('facebook: same video via reel / watch / video.php shares one content id (dedup)', () => {
  const ids = ['https://www.facebook.com/reel/123456', 'https://facebook.com/watch/?v=123456', 'https://www.facebook.com/video.php?v=123456']
    .map((u) => parseSocialUrl(u).contentId);
  assert.deepEqual(new Set(ids), new Set(['123456']));
});

test('facebook: rejects lookalikes, bad ids, and unsupported paths', () => {
  const bad = [
    'http://www.facebook.com/reel/123456',
    'https://www.facebook.com.evil.com/reel/123456',
    'https://facebook.com@evil.com/reel/123456',
    'https://user:pw@www.facebook.com/reel/123456',
    'https://www.facebook.com:444/reel/123456',
    'https://fb.watch.evil.com/AbC123/',
    'https://evilfb.watch/AbC123/',
    'https://www.facebook.com/reel/abc',
    'https://www.facebook.com/reel/1234', // too short
    'https://www.facebook.com/reel/' + '9'.repeat(26),
    'https://www.facebook.com/watch/',
    'https://www.facebook.com/watch/?v=abc',
    'https://www.facebook.com/watch/?v=12',
    'https://www.facebook.com/video.php',
    'https://www.facebook.com/photo.php?fbid=123456',
    'https://www.facebook.com/groups/123456/',
    'https://www.facebook.com/share/p/AbC123xyz/',
    'https://www.facebook.com/page/videos/',
    'https://www.facebook.com/page/videos/abc',
    'https://fb.watch/',
    'https://fb.watch/ab/',
    'https://fb.watch/AbC123/extra',
  ];
  for (const s of bad) assert.equal(isSupportedSocialUrl(s), false, s);
});
