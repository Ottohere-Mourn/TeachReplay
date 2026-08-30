// Zero-dependency HTTP client for an OpenAI Responses-API-shaped endpoint.
// Uses Node's built-in fetch — no SDK. baseUrl/apiKey/model are always
// caller/env-supplied; nothing is hardcoded here, and resolveApiKey() is
// the only place process.env is read.
//
// The exact request/response shape is a documented ASSUMPTION: a custom
// base_url may point at a proxy that doesn't perfectly match the official
// contract, which is why parseVlmSkillDraft (vlm-schema.ts) re-validates
// the response rather than trusting a "strict" flag blindly.
export interface VlmClientConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface VlmResponsesRequest {
  instructions: string;
  /** Base64 PNGs (no "data:" prefix), oldest first. */
  images: string[];
  contextText: string;
  jsonSchema: { name: string; schema: object; strict?: boolean };
}

export class VlmHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "VlmHttpError";
    this.status = status;
    this.body = body;
  }
}

export class VlmParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "VlmParseError";
    this.raw = raw;
  }
}

/** The only place process.env is read. explicit ?? env ?? throw — never a
 * hardcoded literal anywhere in this package. */
export function resolveApiKey(explicit?: string): string {
  const key = explicit ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("no API key: pass VlmClientConfig.apiKey or set OPENAI_API_KEY");
  return key;
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function extractOutputText(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text;
  const output = record.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (item == null || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block == null || typeof block !== "object") continue;
      const blockRecord = block as Record<string, unknown>;
      const text = blockRecord.text ?? blockRecord.output_text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return null;
}

/** POSTs one Responses-API-shaped request and returns the JSON.parse'd
 * structured output. Throws VlmHttpError on non-2xx, VlmParseError when the
 * response can't be parsed into an object. */
export async function callVlmResponses(config: VlmClientConfig, request: VlmResponsesRequest): Promise<unknown> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiKey = resolveApiKey(config.apiKey);
  const timeoutMs = config.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model: config.model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `${request.instructions}\n\n${request.contextText}` },
          ...request.images.map((imageBase64) => ({
            type: "input_image",
            image_url: `data:image/png;base64,${imageBase64}`,
          })),
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: request.jsonSchema.name,
        schema: request.jsonSchema.schema,
        strict: request.jsonSchema.strict ?? true,
      },
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(`${trimBaseUrl(config.baseUrl)}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  if (!response.ok) throw new VlmHttpError(`VLM endpoint returned ${response.status}`, response.status, raw);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new VlmParseError("VLM response was not valid JSON", raw);
  }

  const outputText = extractOutputText(payload) ?? raw;
  try {
    return JSON.parse(outputText);
  } catch {
    throw new VlmParseError("VLM structured output was not valid JSON", outputText);
  }
}
