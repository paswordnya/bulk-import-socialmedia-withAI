export type YoutubeMode = 'embed' | 'download';

/**
 * 'embed' (default): YouTube is only linked through the official embed player; nothing is downloaded.
 * 'download': yt-dlp downloads YouTube videos like the other platforms. This is a legal/business decision
 * (YouTube's terms restrict downloading) and must be opted into explicitly.
 */
export function parseYoutubeMode(raw: string | undefined): YoutubeMode {
  if (raw === undefined || raw === '') return 'embed';
  if (raw === 'embed' || raw === 'download') return raw;
  throw new Error('YOUTUBE_MODE must be "embed" or "download"');
}

export interface PlaceAiConfig {
  llmUrl: string;
  textModel: string;
  /** Unset disables frame analysis. A multimodal model (for example Gemma) can be both text and vision model. */
  visionModel: string | null;
  geocoderUrl: string | undefined;
  geocoderUserAgent: string;
  frames: number;
  /** Sent as reasoning_effort. null = do not send (for servers that reject the field). */
  reasoningEffort: string | null;
  /** Also write an AI title and key takeaways. AI_SUMMARY=off disables it. */
  summary: boolean;
}

/**
 * Place detection is off unless LOCATION_AI=on. When on, it sends place names (never captions or video) to the
 * geocoder, so Nominatim's policy applies and an identifying User-Agent is mandatory.
 */
export function parsePlaceAi(env: Record<string, string | undefined>): PlaceAiConfig | null {
  const flag = env.LOCATION_AI;
  if (flag === undefined || flag === '' || flag === 'off') return null;
  if (flag !== 'on') throw new Error('LOCATION_AI must be "on" or "off"');
  const userAgent = (env.GEOCODER_USER_AGENT ?? '').trim();
  if (!userAgent) throw new Error('GEOCODER_USER_AGENT is required when LOCATION_AI=on (e.g. "my-app/1.0 (contact@example.com)")');
  const frames = env.LOCATION_FRAMES === undefined || env.LOCATION_FRAMES === '' ? 16 : Number(env.LOCATION_FRAMES);
  if (!Number.isInteger(frames) || frames < 0 || frames > 16) throw new Error('LOCATION_FRAMES must be an integer from 0 to 16');
  const textModel = (env.LOCATION_TEXT_MODEL ?? '').trim();
  if (!textModel) throw new Error('LOCATION_TEXT_MODEL is required when LOCATION_AI=on (the model id as shown by your local LLM server)');
  return {
    llmUrl: env.LLM_URL || 'http://127.0.0.1:1234',
    textModel,
    visionModel: env.LOCATION_VISION_MODEL || null,
    geocoderUrl: env.GEOCODER_URL || undefined,
    geocoderUserAgent: userAgent,
    frames,
    reasoningEffort: env.LLM_REASONING_EFFORT === 'omit' ? null : env.LLM_REASONING_EFFORT || 'none',
    summary: env.AI_SUMMARY !== 'off',
  };
}
