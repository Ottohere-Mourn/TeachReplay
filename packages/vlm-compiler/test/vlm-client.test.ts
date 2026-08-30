import { describe, expect, it } from "vitest";

import { callVlmResponses, resolveApiKey, VlmHttpError, VlmParseError } from "../src/vlm-client.js";

function fakeFetch(handler: (input: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

const REQUEST = {
  instructions: "infer the steps",
  images: ["aaaa", "bbbb"],
  contextText: "Task: demo",
  jsonSchema: { name: "vlm_skill_draft", schema: {} },
};

describe("resolveApiKey", () => {
  it("prefers an explicit key over the environment", () => {
    expect(resolveApiKey("explicit-key")).toBe("explicit-key");
  });

  it("falls back to OPENAI_API_KEY", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-key";
    try {
      expect(resolveApiKey()).toBe("env-key");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("throws when no key is available", () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => resolveApiKey()).toThrow(/no API key/);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe("callVlmResponses", () => {
  it("parses a well-formed structured-output response", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe("https://vlm.example/responses");
      return new Response(JSON.stringify({ output_text: JSON.stringify({ ok: true }) }), { status: 200 });
    });
    const result = await callVlmResponses({ baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl }, REQUEST);
    expect(result).toEqual({ ok: true });
  });

  it("falls back to walking response.output[].content[] when output_text is absent", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ ok: 2 }) }] }] }),
          { status: 200 },
        ),
    );
    const result = await callVlmResponses({ baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl }, REQUEST);
    expect(result).toEqual({ ok: 2 });
  });

  it("throws VlmHttpError on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(() => new Response("server exploded", { status: 500 }));
    await expect(callVlmResponses({ baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl }, REQUEST)).rejects.toThrow(
      VlmHttpError,
    );
  });

  it("throws VlmParseError when the response body is not JSON", async () => {
    const fetchImpl = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(callVlmResponses({ baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl }, REQUEST)).rejects.toThrow(
      VlmParseError,
    );
  });

  it("throws VlmParseError when the structured output text is not JSON", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ output_text: "not json either" }), { status: 200 }));
    await expect(callVlmResponses({ baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl }, REQUEST)).rejects.toThrow(
      VlmParseError,
    );
  });

  it("strips a trailing slash from baseUrl and sends images as data URLs", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://vlm.example/responses");
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: JSON.stringify({ ok: true }) }), { status: 200 });
    });
    await callVlmResponses({ baseUrl: "https://vlm.example/", apiKey: "k", model: "m", fetchImpl }, REQUEST);
    const content = (capturedBody!.input as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    const imageParts = content.filter((part) => part.type === "input_image");
    expect(imageParts).toHaveLength(2);
    expect(imageParts[0]!.image_url).toBe("data:image/png;base64,aaaa");
  });
});
