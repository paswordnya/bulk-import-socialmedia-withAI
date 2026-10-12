import { execFile } from 'node:child_process';

export interface FrameExtractor {
  /** Up to `count` JPEG frames spread across the video. Frames that fail are skipped. */
  extract(videoPath: string, durationSeconds: number, count: number): Promise<Buffer[]>;
}

/**
 * Seek times for `count` frames: the first about 1 second in and the last about 1 second before the end, evenly spaced between.
 * Titles are often on screen only in the first seconds, so frames at 1/(n+1) of the duration would miss them.
 * An unknown duration gives a single frame at 0.
 */
export function frameTimes(durationSeconds: number, count: number): number[] {
  const n = Math.max(0, Math.min(Math.floor(count), 32));
  if (n === 0) return [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0];
  if (n === 1) return [durationSeconds / 2];
  const edge = Math.min(1, durationSeconds * 0.05);
  const first = edge;
  const last = durationSeconds - edge;
  return Array.from({ length: n }, (_, i) => first + (i * (last - first)) / (n - 1));
}

export class FfmpegFrameExtractor implements FrameExtractor {
  constructor(private readonly binary = 'ffmpeg') {}

  async extract(videoPath: string, durationSeconds: number, count: number): Promise<Buffer[]> {
    const frames: Buffer[] = [];
    for (const t of frameTimes(durationSeconds, count)) {
      const f = await this.one(videoPath, t).catch(() => null);
      if (f) frames.push(f);
    }
    return frames;
  }

  private one(videoPath: string, at: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ['-v', 'error', '-ss', at.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
        { timeout: 30_000, shell: false, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          const buf = stdout as unknown as Buffer;
          if (err || !buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) reject(new Error('ffmpeg frame failed'));
          else resolve(buf);
        },
      );
    });
  }
}
