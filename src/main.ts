import { Pool } from 'pg';
import { HttpsDownloader } from './download.js';
import { FfprobeProber } from './ffprobe.js';
import { DEFAULT_MEDIA_LIMITS } from './media.js';
import { FfmpegThumbnailer } from './thumbnail.js';
import { PgRepo } from './pgRepo.js';
import { JobQueue } from './queue.js';
import { buildServer, devAuthVerifier } from './server.js';
import { ImportService } from './service.js';
import { S3Storage } from './storage.js';
import { processJob } from './worker.js';
import { parsePlaceAi, parseYoutubeMode } from './config.js';
import { PlaceEnricher, PlaceWorker } from './enrich.js';
import { FfmpegFrameExtractor } from './frames.js';
import { NominatimGeocoder } from './geocode.js';
import { LocalLlmClient } from './llm.js';
import { ThreadsEmbedProvider } from './threads.js';
import { YouTubeEmbedProvider } from './youtube.js';
import { YtDlpSocialVideoProvider } from './ytdlp.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

const pool = new Pool({ connectionString: required('DATABASE_URL') });
const repo = new PgRepo(pool);
const storage = new S3Storage({
  bucket: required('S3_BUCKET'),
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
  accessKeyId: required('S3_ACCESS_KEY_ID'),
  secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
});

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));

const youtubeMode = parseYoutubeMode(process.env.YOUTUBE_MODE);

const placeAi = parsePlaceAi(process.env);
const placeWorker = placeAi
  ? new PlaceWorker(
      new PlaceEnricher({
        geocoder: new NominatimGeocoder({ userAgent: placeAi.geocoderUserAgent, baseUrl: placeAi.geocoderUrl }),
        llm: new LocalLlmClient({ baseUrl: placeAi.llmUrl, reasoningEffort: placeAi.reasoningEffort }),
        textModel: placeAi.textModel,
        visionModel: placeAi.frames > 0 ? placeAi.visionModel ?? undefined : undefined,
        maxFrames: placeAi.frames,
        summary: placeAi.summary,
        log,
      }),
      repo,
      { log, storage },
    )
  : null;

const deps = {
  repo,
  providers: [
    // In embed mode YouTube is handled by the embed provider; in download mode yt-dlp takes it over.
    ...(youtubeMode === 'embed' ? [new YouTubeEmbedProvider({ apiKey: process.env.YOUTUBE_API_KEY || undefined })] : []),
    new ThreadsEmbedProvider(),
    new YtDlpSocialVideoProvider({ binaryPath: process.env.YTDLP_PATH, allowYoutube: youtubeMode === 'download' }),
  ],
  providerName: 'yt-dlp',
  downloader: new HttpsDownloader(),
  prober: new FfprobeProber(process.env.FFPROBE_PATH),
  thumbnailer: new FfmpegThumbnailer(process.env.FFMPEG_PATH),
  storage,
  limits: {
    maxBytes: positiveNumber('MAX_VIDEO_BYTES', DEFAULT_MEDIA_LIMITS.maxBytes),
    maxDurationSeconds: positiveNumber('MAX_VIDEO_SECONDS', DEFAULT_MEDIA_LIMITS.maxDurationSeconds),
  },
  log,
  ...(placeWorker && placeAi
    ? { frameExtractor: new FfmpegFrameExtractor(process.env.FFMPEG_PATH), enqueuePlaces: (j: Parameters<PlaceWorker['enqueue']>[0]) => placeWorker.enqueue(j), placeFrames: placeAi.frames }
    : {}),
};

const queue = new JobQueue((id) => processJob(deps, id), Number(process.env.WORKER_CONCURRENCY ?? 2));
const service = new ImportService(repo, storage, (id) => queue.enqueue(id), log);

if (process.env.AUTH_MODE !== 'dev') {
  throw new Error('Only AUTH_MODE=dev is implemented. Plug the project auth verifier into buildServer() before deploying.');
}
const app = buildServer(service, devAuthVerifier, log);

for (const j of await repo.listIncompleteJobs()) queue.enqueue(j.id); // resume after restart
// The enrichment queue is in-process, so anything still 'processing' lost its worker in the restart.
const staleEnrichment = await repo.finishStaleEnrichment();
if (staleEnrichment > 0) log({ msg: 'enrichment.stale_finished', count: staleEnrichment });

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
log({ msg: 'listening', port: process.env.PORT ?? 3000 });
