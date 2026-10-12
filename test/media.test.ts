import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDownload, validateProbe, looksLikeMp4, InvalidMediaError, DEFAULT_MEDIA_LIMITS } from '../src/media.js';

const mp4Head = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const htmlHead = new TextEncoder().encode('<!DOCTYPE html><html>');

test('accepts mp4 magic within size limit', () => {
  assert.doesNotThrow(() => validateDownload(mp4Head, 1024));
  assert.doesNotThrow(() => validateDownload(mp4Head, DEFAULT_MEDIA_LIMITS.maxBytes));
});

test('rejects html served as video, truncated heads, empty and oversize files', () => {
  assert.equal(looksLikeMp4(htmlHead), false);
  assert.equal(looksLikeMp4(mp4Head.slice(0, 8)), false);
  assert.throws(() => validateDownload(htmlHead, 1024), InvalidMediaError);
  assert.throws(() => validateDownload(mp4Head, 0), InvalidMediaError);
  assert.throws(() => validateDownload(mp4Head, -1), InvalidMediaError);
  assert.throws(() => validateDownload(mp4Head, NaN), InvalidMediaError);
  assert.throws(() => validateDownload(mp4Head, DEFAULT_MEDIA_LIMITS.maxBytes + 1), InvalidMediaError);
});

test('probe: codec and duration boundaries', () => {
  const ok = { container: 'mp4', videoCodec: 'h264', durationSeconds: 30 };
  assert.doesNotThrow(() => validateProbe(ok));
  assert.doesNotThrow(() => validateProbe({ ...ok, durationSeconds: DEFAULT_MEDIA_LIMITS.maxDurationSeconds }));
  assert.throws(() => validateProbe({ ...ok, durationSeconds: DEFAULT_MEDIA_LIMITS.maxDurationSeconds + 0.1 }), InvalidMediaError);
  assert.throws(() => validateProbe({ ...ok, durationSeconds: 0 }), InvalidMediaError);
  assert.throws(() => validateProbe({ ...ok, durationSeconds: NaN }), InvalidMediaError);
  assert.throws(() => validateProbe({ ...ok, videoCodec: null }), InvalidMediaError);
  assert.throws(() => validateProbe({ ...ok, videoCodec: 'mjpeg' }), InvalidMediaError);
  assert.doesNotThrow(() => validateProbe({ ...ok, videoCodec: 'HEVC' }));
});

test('media errors carry a reason: TOO_LARGE, TOO_LONG, INVALID', () => {
  const reason = (fn: () => void) => { try { fn(); } catch (e) { return (e as InvalidMediaError).reason; } return null; };
  assert.equal(reason(() => validateDownload(mp4Head, DEFAULT_MEDIA_LIMITS.maxBytes + 1)), 'TOO_LARGE');
  assert.equal(reason(() => validateDownload(htmlHead, 1024)), 'INVALID');
  assert.equal(reason(() => validateProbe({ container: 'mp4', videoCodec: 'h264', durationSeconds: DEFAULT_MEDIA_LIMITS.maxDurationSeconds + 1 })), 'TOO_LONG');
  assert.equal(reason(() => validateProbe({ container: 'mp4', videoCodec: 'mjpeg', durationSeconds: 5 })), 'INVALID');
});
