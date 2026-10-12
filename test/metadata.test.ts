import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFacebookTitle, extractHashtags, extractLocations, safeProfileUrl, toCount } from '../src/metadata.js';

test('toCount accepts only non-negative safe integers', () => {
  assert.equal(toCount(0), 0);
  assert.equal(toCount(49600), 49600);
  assert.equal(toCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', null, undefined, {}, [], true]) {
    assert.equal(toCount(bad), null, String(bad));
  }
});

test('hashtags: unicode, dedupe case-insensitively, order, max, no bare #', () => {
  assert.deepEqual(extractHashtags('Hi #Timnas #timnas #beritaBola 😂 #日本語 #a_b #1'), ['Timnas', 'beritaBola', '日本語', 'a_b', '1']);
  assert.deepEqual(extractHashtags('no tags # here, # 5 and ##'), []);
  assert.deepEqual(extractHashtags(null), []);
  assert.deepEqual(extractHashtags(''), []);
  const many = Array.from({ length: 50 }, (_, i) => `#t${i}`).join(' ');
  assert.equal(extractHashtags(many).length, 30);
  assert.equal(extractHashtags(many, 3).length, 3);
  assert.equal(extractHashtags('#' + 'a'.repeat(150))[0]!.length, 100, 'tag capped at 100 chars');
});

test('facebook title: strips stats prefix, keeps real titles untouched', () => {
  assert.equal(cleanFacebookTitle('754K views · 10K reactions | Dari Bandung, ikut merayakan'), 'Dari Bandung, ikut merayakan');
  assert.equal(cleanFacebookTitle('1.2M views | 3,400 reactions | Title | Page Name'), 'Title | Page Name');
  assert.equal(cleanFacebookTitle('10 views · 2 comments | x'), 'x');
  assert.equal(cleanFacebookTitle('Just a normal title'), 'Just a normal title');
  assert.equal(cleanFacebookTitle('Title with | pipe inside'), 'Title with | pipe inside');
  assert.equal(cleanFacebookTitle('754K views · 10K reactions |'), null, 'nothing left after stripping');
  assert.equal(cleanFacebookTitle('754K views'), '754K views', 'no separator -> unchanged');
  assert.equal(cleanFacebookTitle(null), null);
  assert.equal(cleanFacebookTitle(''), '');
});

test('profile url: https on the platform domain only; query/fragment dropped', () => {
  assert.equal(safeProfileUrl('tiktok', 'https://www.tiktok.com/@user?lang=en#x'), 'https://www.tiktok.com/@user');
  assert.equal(safeProfileUrl('facebook', 'https://m.facebook.com/profile.php'), 'https://m.facebook.com/profile.php');
  assert.equal(safeProfileUrl('instagram', 'https://instagram.com/user/'), 'https://instagram.com/user/');
  const bad: Array<['tiktok' | 'facebook' | 'instagram', unknown]> = [
    ['tiktok', 'http://www.tiktok.com/@u'],
    ['tiktok', 'https://www.tiktok.com.evil.com/@u'],
    ['tiktok', 'https://evil.com/www.tiktok.com'],
    ['tiktok', 'https://user:pw@www.tiktok.com/@u'],
    ['tiktok', 'https://www.tiktok.com:8443/@u'],
    ['tiktok', 'https://www.facebook.com/u'], // wrong platform
    ['facebook', 'javascript:alert(1)'],
    ['facebook', 'not a url'],
    ['facebook', ''],
    ['facebook', 'https://facebook.com/' + 'a'.repeat(600)],
    ['facebook', null],
    ['facebook', 42],
  ];
  for (const [p, u] of bad) assert.equal(safeProfileUrl(p, u), null, String(u));
});

import { cleanInstagramTitle, instagramProfileUrl } from '../src/metadata.js';

test('instagram generic title is dropped, real titles kept', () => {
  assert.equal(cleanInstagramTitle('Video by persib'), null);
  assert.equal(cleanInstagramTitle('Reel by some.user'), null);
  assert.equal(cleanInstagramTitle('  Video by persib  '), null);
  assert.equal(cleanInstagramTitle('Video by someone who wrote a very long real caption about their trip to the mountains and more text'), 'Video by someone who wrote a very long real caption about their trip to the mountains and more text');
  assert.equal(cleanInstagramTitle('My video by the sea'), 'My video by the sea');
  assert.equal(cleanInstagramTitle(null), null);
});

test('instagram profile url only from a valid handle', () => {
  assert.equal(instagramProfileUrl('persib'), 'https://www.instagram.com/persib/');
  assert.equal(instagramProfileUrl('a.b_c9'), 'https://www.instagram.com/a.b_c9/');
  for (const bad of [null, '', 'has space', 'a/b', 'a?b', '../x', 'x'.repeat(31), 'ünï', '<script>']) {
    assert.equal(instagramProfileUrl(bad), null, String(bad));
  }
});

import { profileUrlFromHandle } from '../src/metadata.js';

test('profile urls from handles per platform, only for valid handles', () => {
  assert.equal(profileUrlFromHandle('x', 'some_user'), 'https://x.com/some_user');
  assert.equal(profileUrlFromHandle('pinterest', 'some_user'), 'https://www.pinterest.com/some_user/');
  assert.equal(profileUrlFromHandle('reddit', 'some-user_1'), 'https://www.reddit.com/user/some-user_1/');
  assert.equal(profileUrlFromHandle('threads', 'some.user'), 'https://www.threads.com/@some.user');
  assert.equal(profileUrlFromHandle('tiktok', 'x'), null, 'no rule for tiktok here');
  assert.equal(profileUrlFromHandle('instagram', 'persib'), 'https://www.instagram.com/persib/');
  const bad = [null, '', 'has space', 'a/b', '../x', '<s>', 'a?b', 'ünï', 'x'.repeat(40)];
  for (const p of ['x', 'pinterest', 'reddit', 'threads'] as const) {
    for (const h of bad) assert.equal(profileUrlFromHandle(p, h), null, `${p}:${String(h)}`);
  }
  assert.equal(profileUrlFromHandle('x', 'a'.repeat(16)), null, 'x handles max 15');
});

test('safeProfileUrl: new platform domains accepted, cross-platform and lookalikes rejected', () => {
  assert.equal(safeProfileUrl('x', 'https://twitter.com/user?ref=1'), 'https://twitter.com/user');
  assert.equal(safeProfileUrl('x', 'https://x.com/user'), 'https://x.com/user');
  assert.equal(safeProfileUrl('reddit', 'https://www.reddit.com/user/u/'), 'https://www.reddit.com/user/u/');
  assert.equal(safeProfileUrl('pinterest', 'https://id.pinterest.com/u/'), 'https://id.pinterest.com/u/');
  assert.equal(safeProfileUrl('threads', 'https://www.threads.net/@u'), 'https://www.threads.net/@u');
  assert.equal(safeProfileUrl('x', 'https://www.reddit.com/user/u/'), null);
  assert.equal(safeProfileUrl('reddit', 'https://reddit.com.evil.com/user/u/'), null);
  assert.equal(safeProfileUrl('threads', 'https://threads.net.evil.com/@u'), null);
});

import { cleanXTitle } from '../src/metadata.js';

test('x synthetic title "<name> - <text>" is dropped; other titles are kept', () => {
  assert.equal(cleanXTitle('Some Name - hello world', 'Some Name'), null);
  assert.equal(cleanXTitle('Some Name - ', 'Some Name'), null);
  assert.equal(cleanXTitle('A real title', 'Some Name'), 'A real title');
  assert.equal(cleanXTitle('Some Name-no space', 'Some Name'), 'Some Name-no space');
  assert.equal(cleanXTitle('Other - text', 'Some Name'), 'Other - text');
  assert.equal(cleanXTitle('Some Name - x', null), 'Some Name - x');
  assert.equal(cleanXTitle(null, 'Some Name'), null);
});

test('locations: places in caption order, deduped case-insensitively, capped', () => {
  assert.deepEqual(extractLocations('📍Ubud 📍Canggu\nLokasi: ubud\n📍Seminyak'), ['Ubud', 'Canggu', 'Seminyak']);
  const many = Array.from({ length: 9 }, (_, i) => `📍Place${i}`).join(' ');
  assert.equal(extractLocations(many).length, 5);
  assert.equal(extractLocations(many, 2).length, 2);
});

test('locations: pin emoji and labels, stops at hashtag, mention, emoji, newline', () => {
  assert.deepEqual(extractLocations('Sunset 📍Ubud, Bali #travel'), ['Ubud, Bali']);
  assert.deepEqual(extractLocations('📍 Pantai Kuta 🌴 enjoy'), ['Pantai Kuta']);
  assert.deepEqual(extractLocations('📍Kopi Kenangan @kopikenangan'), ['Kopi Kenangan']);
  assert.deepEqual(extractLocations('Lokasi: Jl. Braga No. 10, Bandung\nharga murah'), ['Jl. Braga No. 10, Bandung']);
  assert.deepEqual(extractLocations('LOCATION：Shibuya Tokyo.'), ['Shibuya Tokyo']);
  assert.deepEqual(extractLocations('loc : Gili Trawangan'), ['Gili Trawangan']);
  assert.deepEqual(extractLocations('\u{1F4CD}️Malioboro'), ['Malioboro']);
});

test('locations: ignores empty, too short, URL-like, symbol-only, and unrelated text', () => {
  for (const bad of [null, undefined, '', '📍', '📍 #tag', '📍 x', '📍 ...', '📍 https://example.com/x', 'Lokasi: www.example.com', 'allocation: 5 units', 'relocation: soon', 'no marker here, just Bali', 'location without colon Bali', '📌 Jakarta']) {
    assert.deepEqual(extractLocations(bad), [], String(bad));
  }
});

test('locations: place name is capped at 100 characters and trailing punctuation is dropped', () => {
  assert.equal(extractLocations('📍' + 'a'.repeat(300))[0]!.length, 100);
  assert.deepEqual(extractLocations('📍Ubud!!! '), ['Ubud']);
  assert.deepEqual(extractLocations('📍Ubud - '), ['Ubud']);
});

test('locations: max of zero or less returns nothing', () => {
  assert.deepEqual(extractLocations('📍Ubud', 0), []);
  assert.deepEqual(extractLocations('📍Ubud', -1), []);
});
