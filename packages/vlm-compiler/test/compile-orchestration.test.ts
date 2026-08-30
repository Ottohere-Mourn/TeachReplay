import { skillReferencesAreValid } from "@teachreplay/core";
import { describe, expect, it } from "vitest";

import { compileVisualSkill, VlmCompileError } from "../src/compile.js";
import type { VisualSession } from "../src/session.js";

function session(): VisualSession {
  return {
    id: "session-1",
    botId: "bot-1",
    name: "monthly report filing",
    app: "desktop",
    recordedVia: "remote",
    startedAt: 0,
    finishedAt: 1000,
    stopReason: "manual",
    frames: [{ seq: 0, at: 0, imageBase64: "aaaa" }],
    shellEvents: [],
  };
}

const VALID_DRAFT = {
  taskName: "File monthly report",
  steps: [{ kind: "click", description: "Submit", role: "button", name: "Submit report" }],
  success: { kind: "text", value: "Submission successful" },
};

function fakeFetch(responses: Array<Record<string, unknown> | string>): { fetchImpl: typeof fetch; callCount: () => number; bodies: string[] } {
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const response = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    const outputText = typeof response === "string" ? response : JSON.stringify(response);
    return new Response(JSON.stringify({ output_text: outputText }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, callCount: () => calls, bodies };
}

describe("compileVisualSkill", () => {
  it("compiles a valid first response with a single VLM call", async () => {
    const { fetchImpl, callCount } = fakeFetch([VALID_DRAFT]);
    const skill = await compileVisualSkill({
      session: session(),
      vlm: { baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl },
    });
    expect(callCount()).toBe(1);
    expect(skillReferencesAreValid(skill)).toEqual([]);
    expect(skill.name).toBe("File monthly report");
  });

  it("retries exactly once on an invalid first response, echoing the error, then succeeds", async () => {
    const { fetchImpl, callCount, bodies } = fakeFetch([{ steps: [] }, VALID_DRAFT]);
    const skill = await compileVisualSkill({
      session: session(),
      vlm: { baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl },
    });
    expect(callCount()).toBe(2);
    expect(bodies[1]).toContain("non-empty array");
    expect(skill.name).toBe("File monthly report");
  });

  it("fails explicitly after two invalid responses, never returning a partial skill", async () => {
    const { fetchImpl, callCount } = fakeFetch([{ steps: [] }, { steps: [] }]);
    await expect(
      compileVisualSkill({ session: session(), vlm: { baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl } }),
    ).rejects.toThrow(VlmCompileError);
    expect(callCount()).toBe(2);
  });

  it("throws immediately when the session has no frames", async () => {
    const { fetchImpl, callCount } = fakeFetch([VALID_DRAFT]);
    const empty = { ...session(), frames: [] };
    await expect(
      compileVisualSkill({ session: empty, vlm: { baseUrl: "https://vlm.example", apiKey: "k", model: "m", fetchImpl } }),
    ).rejects.toThrow(/no frames to compile/);
    expect(callCount()).toBe(0);
  });
});
