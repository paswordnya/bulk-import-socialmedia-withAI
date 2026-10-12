export interface MediaLimits {
  maxBytes: number;
  maxDurationSeconds: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxBytes: 200 * 1024 * 1024,
  maxDurationSeconds: 10 * 60,
};

export interface ProbeResult {
  container: string;
  videoCodec: string | null;
  durationSeconds: number;
  width?: number | null;
  height?: number | null;
}

/** Implemented with ffprobe in production; injectable so it can be faked in unit tests. */
export interface MediaProber {
  probe(filePath: string): Promise<ProbeResult>;
}

export type InvalidMediaReason = 'INVALID' | 'TOO_LONG' | 'TOO_LARGE';

export class InvalidMediaError extends Error {
  constructor(
    message: string,
    public readonly reason: InvalidMediaReason = 'INVALID',
  ) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

const ALLOWED_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1']);

/** ISO-BMFF (mp4/mov) files carry "ftyp" at bytes 4..8. Never trust extension or Content-Type. */
export function looksLikeMp4(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
}

export function validateDownload(
  head: Uint8Array,
  sizeBytes: number,
  limits: MediaLimits = DEFAULT_MEDIA_LIMITS,
): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new InvalidMediaError('empty file');
  if (sizeBytes > limits.maxBytes) throw new InvalidMediaError('file too large', 'TOO_LARGE');
  if (!looksLikeMp4(head)) throw new InvalidMediaError('not an mp4 container');
}

export function validateProbe(probe: ProbeResult, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): void {
  if (!probe.videoCodec) throw new InvalidMediaError('no video stream');
  if (!ALLOWED_CODECS.has(probe.videoCodec.toLowerCase())) {
    throw new InvalidMediaError(`unsupported codec ${probe.videoCodec}`);
  }
  if (!(probe.durationSeconds > 0)) throw new InvalidMediaError('invalid duration');
  if (probe.durationSeconds > limits.maxDurationSeconds) throw new InvalidMediaError('video too long', 'TOO_LONG');
}
