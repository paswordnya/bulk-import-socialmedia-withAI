# Social Video Importer — backend

Imports public videos from TikTok, Instagram, Facebook, X, Pinterest, Reddit and Threads (downloaded and stored), and links YouTube videos through the official embed: `POST import -> job -> provider -> download -> validate -> S3 -> COMPLETED`.

## Architecture
```
client -> POST /v1/social-videos/import  (returns jobId immediately)
       -> JobQueue (in-process) -> processJob
            FETCHING    SocialVideoProvider.fetchVideo (yt-dlp, metadata + direct URL only)
            DOWNLOADING HttpsDownloader (https only, private IPs blocked at connect time, size cap)
            validate    mp4 magic bytes, size, ffprobe codec + duration
            STORING     S3/MinIO  social-videos/{userId}/{videoId}/video.mp4 + thumbnail.jpg
            COMPLETED   social_videos row; job links to it
client -> GET /v1/social-videos/import/{jobId}   (poll)
client -> GET /v1/social-videos/{videoId}
```
The client never learns which provider is used. Swap providers by implementing `SocialVideoProvider` (`src/provider.ts`) and changing the wiring in `src/main.ts`.

## Supported links
Strict allowlists in `src/urls.ts` and `src/urlsExtra.ts` (anything else is rejected; the mobile apps mirror these rules and the backend always re-validates):
- TikTok: `/@user/video/<id>`, `vm.`/`vt.tiktok.com/<id>`
- Instagram: `/reel/<id>/`, `/p/<id>/`
- Facebook: `/reel/<id>`, `/watch/?v=<id>`, `/video.php?v=<id>`, `/<page>/videos/<id>`, `/share/v|r/<token>`, `fb.watch/<token>`
- X / Twitter: `x.com` or `twitter.com` `/<user>/status/<id>`
- Pinterest: `/pin/<id>/` (incl. country subdomains), `pin.it/<token>`
- Reddit: `/r/<sub>/comments/<id>/...`, `/r/<sub>/s/<token>`, `redd.it/<id>`
- Threads: `/@<user>/post/<code>` on `threads.net` or `threads.com`
- YouTube: `/shorts/<id>`, `/watch?v=<id>`, `youtu.be/<id>` (11-character ids). Two modes via `YOUTUBE_MODE`: **`embed` (default)** links the video through the official embed player and nothing is downloaded or stored; **`download`** lets yt-dlp download it like the other platforms (merged H.264 mp4 + m4a up to 1080p). `download` is a legal/business decision: YouTube's terms restrict downloading, and YouTube may block automated downloads (bot checks, datacenter IPs). In `download` mode the optional `YOUTUBE_API_KEY` is unused because yt-dlp already returns views, likes, duration and dates. Metadata comes from the public oEmbed endpoint; with an optional `YOUTUBE_API_KEY` (YouTube Data API v3, sent in the `x-goog-api-key` header) the backend also fills views, likes, comments, duration, publish date and description. Videos whose owner disabled embedding fail with `EMBEDDING_DISABLED`. The response has `videoUrl: null` and `playback: {kind: "embed", embedUrl}` for these videos.
Not supported on purpose: arbitrary web pages, and URL shorteners/redirectors that would have to be followed (e.g. `t.co`).
Which platforms actually work for a given link depends on yt-dlp and on the content being public; X, Pinterest, Reddit and Threads are implemented and unit-tested but have not been verified against live links.

## API
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/social-videos/import` | body `{url}`. 202 new job, 200 existing job/video, 400 invalid URL, 401 |
| GET | `/v1/social-videos/import/{jobId}` | `status`, `progress`, `video` when COMPLETED, `errorCode`+`message` when FAILED |
| GET | `/v1/social-videos/{videoId}` | video with fresh signed URLs |
| DELETE | `/v1/social-videos/{videoId}` | deletes the user's video, its import jobs and its stored files (video, thumbnail, place photos). 204 ok, 404 not found or not yours (also when already deleted), 401 unauthorized |
| GET | `/v1/social-videos?limit=&cursor=` | newest first, `limit` 1-50 (default 20), `nextCursor` null at the end |

Video object: `id, platform, sourceUrl, authorUsername, authorDisplayName, authorId, authorUrl, title, description, hashtags[], locations[], places[], thumbnailUrl, videoUrl, duration, publishedAt, createdAt, stats{views,likes,comments,reposts,saves}, music{title,artist}|null, media{width,height,codec,fileSizeBytes}`.
Every metadata field may be null: availability depends on the platform (e.g. Facebook has no likes/comments/music via yt-dlp). Counts are validated non-negative integers; `authorUrl` is kept only for https links on the platform's own domain; Facebook titles have the "754K views · 10K reactions |" prefix removed; hashtags are parsed from the caption. `locations` are place names typed in the caption (after 📍 or `Location:`/`Lokasi:`/`Loc:`), TikTok and Instagram only; this is not the platform's own location tag. `media` comes from our own ffprobe of the stored file.

## Place detection (optional, off by default)
`LOCATION_AI=on` finds places for a video and returns them as `places: [{name, latitude, longitude, source, displayName}]` (`source` is `caption`, `text-ai` or `frame-ai`). It runs **after** the job is COMPLETED, in a separate one-at-a-time queue, so imports are not slowed; `places` is `[]` until it finishes and stays `[]` if nothing is found.
1. Names typed in the caption (📍, `Location:`/`Lokasi:`/`Loc:`) are taken as they are.
2. A local LLM served by LM Studio (or any OpenAI-compatible local server, `LLM_URL`, default `http://127.0.0.1:1234`; `LOCATION_TEXT_MODEL` is the model id from `GET /v1/models`, for example `google/gemma-4-12b-qat`) reads the caption, title and hashtags. Only names that literally appear in that text are kept, so invented places are dropped.
3. If `LOCATION_VISION_MODEL` is set (it can be the same multimodal model, such as Gemma), up to `LOCATION_FRAMES` frames (max and default 16: about one frame per 5 seconds of video, at least 3, from about the first second to about the last; titles and scenes are on screen only briefly, so 4 to 8 frames missed most places in real videos). The model may recognize landmarks as well as read written names; one-word subtitles are sometimes misread as places are shown to it. Frame results are guesses and are labeled `frame-ai`.
4. The LLM never supplies coordinates. Each name is looked up on OpenStreetMap Nominatim (`GEOCODER_URL`); names it cannot find are dropped, and places that resolve to the same spot are merged. Country-level and continent-level results (Nominatim `place_rank` ≤ 4 or `addresstype` country) are dropped as useless pins.

Notes: only place names are sent to Nominatim, never captions, frames or video. The public Nominatim server allows about one request per second and requires an identifying User-Agent, so `GEOCODER_USER_AGENT` is mandatory when the feature is on, requests are spaced and cached, and OSM attribution must be shown wherever the map is displayed. A name shared by several places (for example "Lembang") can resolve to the wrong one; `displayName` shows what was matched. Captions are untrusted input: the prompt tells the model to treat them as data, and the answer is validated, but a caption can still make the model return a place name that is written in that caption. Reasoning models (Gemma 4) are sent `reasoning_effort: "none"` by default (`LLM_REASONING_EFFORT`, `omit` to not send it): without it they spent the whole token budget thinking and returned an empty answer. Every failure (LLM server down, model not loaded, Nominatim error) degrades to "no places" and never fails an import. Migration `006` adds the `places` JSONB column.

Deleting: the database row (and the jobs pointing at it) goes first in one transaction, then the stored files. A storage failure only leaves logged orphan files (`delete.storage_failed`). Another user's video answers 404 like a missing one. If a video is deleted while place enrichment is running, the uploaded photos are cleaned up. The same link can be imported again afterwards.

Thumbnails: the platform cover image is used when it downloads as a real JPEG, otherwise a frame is extracted with ffmpeg. Thumbnails are best-effort and never fail an import.

Error codes: INVALID_URL, UNSUPPORTED_PLATFORM, PRIVATE_CONTENT, VIDEO_UNAVAILABLE, PROVIDER_ERROR, IMPORT_TIMEOUT, STORAGE_ERROR, INVALID_MEDIA, UNKNOWN_ERROR.

## Local development
Prereqs: Node 20+, Docker, `yt-dlp`, `ffmpeg` (provides `ffprobe` and thumbnail extraction).
```
docker compose up -d
cp .env.example .env && set -a && . ./.env && set +a
npm install && npm run migrate && npm start
```
Local auth (`AUTH_MODE=dev`): `Authorization: Bearer dev-<userId>`. The server refuses to start in any other mode until the project's real token verifier is plugged into `buildServer()`.

Try it (use a public video you are permitted to use):
```
curl -s -X POST localhost:3000/v1/social-videos/import -H 'Authorization: Bearer dev-me' \
  -H 'content-type: application/json' -d '{"url":"<public tiktok url>"}'
```
Phones need a reachable `S3_PUBLIC_ENDPOINT` (Android emulator `http://10.0.2.2:9000`, real device: your LAN IP) because signed URLs point at it.

## Tests
`npm test` (unit + in-memory integration: API -> queue -> worker -> storage -> completed). `npm run typecheck`.

## Known limitations
- Jobs interrupted by a restart are marked FAILED (user retries); no resume.
- In-process queue only; use a real queue before running multiple instances.
- No rate limiting yet. Add per-user limits before exposing publicly.
- Instagram usually requires login via yt-dlp; those fail as PRIVATE_CONTENT. Login/cookie bypass is intentionally not implemented.
- Confirm platform ToS allow this use before production.

## Troubleshooting
- `yt-dlp` crashes with `No module named expat` (Homebrew Python on macOS): `brew reinstall python@3.14` did not fix it on macOS 26 (the Python extension links to the older system `libexpat`); what worked was running `yt-dlp` with `DYLD_LIBRARY_PATH=/opt/homebrew/opt/expat/lib`. For the backend, point `YTDLP_PATH` at a wrapper script that exports `DYLD_LIBRARY_PATH=/opt/homebrew/opt/expat/lib` before running yt-dlp. (Exporting it in the shell that starts node does not work: macOS strips `DYLD_*` through `/usr/bin/env`.)
- `yt-dlp failed` for everything: `yt-dlp -U` (extractors break often) or set `YTDLP_PATH`.
- `ffprobe failed`: install ffmpeg or set `FFPROBE_PATH`.
- Video won't play on device: check `S3_PUBLIC_ENDPOINT` is reachable from the device.
