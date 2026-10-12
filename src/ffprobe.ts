import { execFile } from 'node:child_process';
import type { MediaProber, ProbeResult } from './media.js';

export class FfprobeProber implements MediaProber {
  constructor(private readonly binary = 'ffprobe') {}

  probe(filePath: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath],
        { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, shell: false },
        (err, stdout) => {
          if (err) return reject(new Error('ffprobe failed'));
          try {
            const j = JSON.parse(String(stdout)) as {
              format?: { format_name?: string; duration?: string };
              streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
            };
            const v = j.streams?.find((s) => s.codec_type === 'video');
            resolve({
              container: j.format?.format_name ?? '',
              videoCodec: v?.codec_name ?? null,
              durationSeconds: Number(j.format?.duration ?? 0),
              width: v?.width ?? null,
              height: v?.height ?? null,
            });
          } catch {
            reject(new Error('ffprobe output unparseable'));
          }
        },
      );
    });
  }
}
