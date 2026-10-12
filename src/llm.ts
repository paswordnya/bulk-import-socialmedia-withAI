export interface LlmRequest {
  model: string;
  system?: string;
  prompt: string;
  /** Base64 JPEG images, for vision models. */
  images?: string[];
  /** JSON Schema the answer must follow (structured output). */
  schema?: Record<string, unknown>;
  timeoutMs?: number;
}

/** Local LLM. Injectable so tests never need a running model. */
export interface LlmClient {
  /** Returns the model's answer as text (JSON when a schema is given). Throws on transport or HTTP failure. */
  chatJson(req: LlmRequest): Promise<string>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Client for any local server that speaks the OpenAI chat-completions API, such as LM Studio
 * (default http://127.0.0.1:1234). Images go as base64 data URLs; structured output uses a JSON schema.
 */
export class LocalLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly reasoningEffort: string | null;

  /**
   * `reasoningEffort` defaults to "none": reasoning models (for example Gemma 4) otherwise spend the whole token
   * budget thinking and return an empty answer. Pass null to leave the field out for servers that reject it.
   */
  constructor(opts: { baseUrl?: string; fetch?: FetchLike; reasoningEffort?: string | null } = {}) {
    const base = (opts.baseUrl ?? 'http://127.0.0.1:1234').replace(/\/+$/, '');
    const u = new URL(base); // throws on garbage so a bad LLM_URL fails at startup
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('LLM_URL must be http or https');
    this.baseUrl = base;
    this.reasoningEffort = opts.reasoningEffort === undefined ? 'none' : opts.reasoningEffort;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async chatJson(req: LlmRequest): Promise<string> {
    const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    const images = req.images ?? [];
    messages.push({
      role: 'user',
      content:
        images.length === 0
          ? req.prompt
          : [{ type: 'text', text: req.prompt }, ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))],
    });
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages,
        temperature: 0,
        max_tokens: 1000,
        stream: false,
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        ...(req.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: req.schema } } } : {}),
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
    });
    if (!res.ok) throw new Error(`llm http ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('llm returned no content');
    // Empty content with a 200 usually means a reasoning model used up max_tokens while thinking.
    if (content.trim() === '') throw new Error('llm returned empty content (reasoning may have used all tokens)');
    return content;
  }
}
