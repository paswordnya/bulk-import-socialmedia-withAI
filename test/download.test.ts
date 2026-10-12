import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, safeLookup } from '../src/download.js';

test('private / loopback / link-local / metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', 'not-an-ip']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test('public addresses are allowed; range boundaries are exact', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('safeLookup refuses hosts that resolve to loopback', async () => {
  await assert.rejects(
    new Promise((res, rej) => safeLookup('localhost', {}, (e: Error | null, a: unknown) => (e ? rej(e) : res(a)))),
    /blocked address/,
  );
});

test('safeLookup returns an array when called with all:true (Node happy-eyeballs form)', async () => {
  // 'localhost' resolves to loopback, so it must be rejected in BOTH call styles.
  for (const opts of [{ all: true }, { all: false }, {}]) {
    await assert.rejects(
      new Promise((res, rej) => safeLookup('localhost', opts, (e: Error | null, a: unknown) => (e ? rej(e) : res(a)))),
      /blocked address/,
    );
  }
});

test('safeLookup passes public addresses through in array and single forms', async () => {
  // IP literals resolve without DNS; 8.8.8.8 is public.
  const arr = await new Promise<unknown>((res, rej) => safeLookup('8.8.8.8', { all: true }, (e: Error | null, a: unknown) => (e ? rej(e) : res(a))));
  assert.ok(Array.isArray(arr) && (arr as Array<{ address: string }>)[0]!.address === '8.8.8.8');
  const single = await new Promise<unknown>((res, rej) => safeLookup('8.8.8.8', {}, (e: Error | null, a: unknown) => (e ? rej(e) : res(a))));
  assert.equal(single, '8.8.8.8');
});
