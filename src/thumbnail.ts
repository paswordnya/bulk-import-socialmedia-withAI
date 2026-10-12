import { execFile } from 'node:child_process';

export interface Thumbnailer {
  /** Writes a JPEG frame of the video to destPath. */
  fromVideo(videoPath: string, destPath: string, atSeconds: number): Promise<void>;
}

export class FfmpegThumbnailer implements Thumbnailer {
  constructor(private readonly binary = 'ffmpeg') {}

  fromVideo(videoPath: string, destPath: string, atSeconds: number): Promise<void> {
    const t = Number.isFinite(atSeconds) && atSeconds > 0 ? atSeconds : 0;
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', destPath],
        { timeout: 30_000, shell: false },
        (err) => (err ? reject(new Error('ffmpeg failed')) : resolve()),
      );
    });
  }
}
