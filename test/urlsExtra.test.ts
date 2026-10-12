import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedSocialUrl, parseSocialUrl } from '../src/urls.js';

type Case = [input: string, platform: string, normalized: string, contentId: string | null];

const accept: Case[] = [
  // X / Twitter
  ['https://x.com/SomeUser/status/1234567890123?s=20&t=abc', 'x', 'https://x.com/someuser/status/1234567890123', '1234567890123'],
  ['https://twitter.com/someuser/status/12345/video/1', 'x', 'https://x.com/someuser/status/12345', '12345'],
  ['https://mobile.twitter.com/a_b/status/99999/', 'x', 'https://x.com/a_b/status/99999', '99999'],
  ['https://www.x.com/i/status/55555', 'x', 'https://x.com/i/status/55555', '55555'],
  // Pinterest
  ['https://www.pinterest.com/pin/123456789/?utm=x', 'pinterest', 'https://www.pinterest.com/pin/123456789/', '123456789'],
  ['https://id.pinterest.com/pin/123456789', 'pinterest', 'https://www.pinterest.com/pin/123456789/', '123456789'],
  ['https://pinterest.com/pin/987654321/', 'pinterest', 'https://www.pinterest.com/pin/987654321/', '987654321'],
  ['https://pin.it/AbC123x', 'pinterest', 'https://pin.it/AbC123x', null],
  // Reddit
  ['https://www.reddit.com/r/Videos/comments/1abc2de/some_title_here/?utm_source=share', 'reddit', 'https://www.reddit.com/r/Videos/comments/1abc2de/', '1abc2de'],
  ['https://old.reddit.com/r/funny/comments/abc123', 'reddit', 'https://www.reddit.com/r/funny/comments/abc123/', 'abc123'],
  ['https://reddit.com/r/funny/s/AbCdE12345', 'reddit', 'https://www.reddit.com/r/funny/s/AbCdE12345', null],
  ['https://redd.it/abc123', 'reddit', 'https://redd.it/abc123', 'abc123'],
  // Threads
  ['https://www.threads.net/@Some.User/post/CxYz_12-ab?xmt=1', 'threads', 'https://www.threads.com/@some.user/post/CxYz_12-ab', 'CxYz_12-ab'],
  ['https://threads.com/@user/post/AbCdE12345/', 'threads', 'https://www.threads.com/@user/post/AbCdE12345', 'AbCdE12345'],
];

test('x / pinterest / reddit / threads: accepted forms normalize and extract ids', () => {
  for (const [input, platform, normalized, contentId] of accept) {
    const r = parseSocialUrl(input);
    assert.equal(r.platform, platform, input);
    assert.equal(r.normalizedUrl, normalized, input);
    assert.equal(r.contentId, contentId, input);
  }
});

test('x: twitter.com and x.com spellings of one post share a content id', () => {
  const a = parseSocialUrl('https://twitter.com/User/status/123456');
  const b = parseSocialUrl('https://x.com/user/status/123456?s=1');
  assert.equal(a.normalizedUrl, b.normalizedUrl);
  assert.equal(a.contentId, b.contentId);
});

test('new platforms: rejects lookalikes, wrong schemes, userinfo, ports, bad ids and unsupported paths', () => {
  const bad = [
    // X
    'http://x.com/u/status/123456',
    'https://x.com.evil.com/u/status/123456',
    'https://x.com@evil.com/u/status/123456',
    'https://evilx.com/u/status/123456',
    'https://t.co/AbCdEf', // redirectors are not followed
    'https://x.com/u',
    'https://x.com/u/status/abc',
    'https://x.com/u/status/1234', // too short
    'https://x.com/' + 'a'.repeat(16) + '/status/123456', // handle too long
    'https://x.com/u/status/123456/analytics',
    'https://x.com/home',
    // Pinterest
    'https://www.pinterest.com/pin/abc/',
    'https://www.pinterest.com/pin/1234/',
    'https://www.pinterest.com/someuser/board/',
    'https://pinterest.com.evil.com/pin/123456789/',
    'https://xx.evil.pinterest.com.attacker.io/pin/123456789/',
    'https://abc.pinterest.com/pin/123456789/', // only 2-letter country subdomains
    'https://pin.it/ab',
    'https://pin.it/AbC123/extra',
    // Reddit
    'https://www.reddit.com/r/funny/',
    'https://www.reddit.com/r/f/comments/abc123/', // subreddit too short
    'https://www.reddit.com/r/funny/comments/ABC123/', // ids are lowercase
    'https://www.reddit.com/r/funny/comments/abc/',
    'https://www.reddit.com/user/u/',
    'https://reddit.com.evil.com/r/funny/comments/abc123/',
    'https://i.redd.it/abc123.jpg',
    'https://redd.it/ab',
    'https://redd.it/abc123/extra',
    // Threads
    'https://www.threads.net/@user',
    'https://www.threads.net/@user/post/ab',
    'https://www.threads.net/user/post/AbCdE12345', // missing @
    'https://threads.net.evil.com/@user/post/AbCdE12345',
    'https://www.threads.net/@' + 'a'.repeat(31) + '/post/AbCdE12345',
    // generic
    'https://user:pw@www.reddit.com/r/funny/comments/abc123/',
    'https://www.reddit.com:8443/r/funny/comments/abc123/',
    'https://127.0.0.1/r/funny/comments/abc123/',
  ];
  for (const s of bad) assert.equal(isSupportedSocialUrl(s), false, s);
});
