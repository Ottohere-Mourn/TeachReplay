// Orchestration: capture session -> VLM call -> assemble -> validate.
//
// One bounded corrective retry on invalid structured output (echoing the
// previous output and the validation error back to the model verbatim),
// then explicit failure — mirroring replay.ts's "bounded retry, then
// explicit failure" ethos rather than ever returning a partially-valid
// skill.
import type { Skill } from "@teachreplay/core";

import { assembleSkillFromDraft } from "./assemble.js";
import type { VisualSession } from "./session.js";
import { parseVlmSkillDraft, VlmDraftValidationError, VLM_SKILL_DRAFT_JSON_SCHEMA } from "./vlm-schema.js";
import { callVlmResponses, type VlmClientConfig } from "./vlm-client.js";

export class VlmCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VlmCompileError";
  }
}

export interface CompileVisualSkillOptions {
  session: VisualSession;
  vlm: VlmClientConfig;
  taskDescription?: string;
  now?: () => number;
}

const INSTRUCTIONS = [
  "You are watching a screen-recording of a person demonstrating a computer task, given as an",
  "ordered sequence of screenshots plus a log of shell commands they ran. Infer the sequence of",
  "steps needed to reproduce the task, which of the demonstrated values should become reusable",
  "parameters, and how to tell the task succeeded.",
  "",
  "Only describe: step kind (navigate/fill/click/press/shell), a short description, the semantic",
  "target (role + visible name, e.g. role=\"button\" name=\"Submit report\"), and the literal value",
  "involved. Do NOT invent an id, a schema version, a timestamp, or any \"${...}\" placeholder",
  "syntax — those are assigned separately. For each fill step, set isParameter=true (default) and",
  "parameterLabel to a short human label unless the value should stay a fixed literal.",
].join("\n");

function buildContextText(session: VisualSession, taskDescription: string | undefined): string {
  const lines: string[] = [`Task: ${session.name}`];
  if (taskDescription) lines.push(taskDescription);
  if (session.shellEvents.length) {
    lines.push("", "Shell commands run during the demonstration:");
    for (const event of session.shellEvents) {
      lines.push(`$ ${event.command}${event.cwd ? ` (in ${event.cwd})` : ""}`);
      lines.push(`  exit ${event.exitCode ?? "?"}`);
      if (event.stdout) lines.push(`  stdout: ${event.stdout}`);
      if (event.stderr) lines.push(`  stderr: ${event.stderr}`);
    }
  }
  return lines.join("\n");
}

async function requestDraft(options: CompileVisualSkillOptions, correction?: { previousOutput: string; error: string }) {
  const instructions = correction
    ? `${INSTRUCTIONS}\n\nYour previous output was invalid: ${correction.error}\nPrevious output: ${correction.previousOutput}\nCorrect it and reply again with valid structured output only.`
    : INSTRUCTIONS;
  const raw = await callVlmResponses(options.vlm, {
    instructions,
    images: options.session.frames.map((frame) => frame.imageBase64),
    contextText: buildContextText(options.session, options.taskDescription),
    jsonSchema: { name: "vlm_skill_draft", schema: VLM_SKILL_DRAFT_JSON_SCHEMA, strict: true },
  });
  return raw;
}

/** Compiles a VisualSession into a real Skill by calling the VLM once,
 * validating its structured output, and — on failure — issuing exactly one
 * corrective retry before failing explicitly. Never returns a
 * partially-valid skill. */
export async function compileVisualSkill(options: CompileVisualSkillOptions): Promise<Skill> {
  if (!options.session.frames.length) throw new VlmCompileError("the capture session has no frames to compile");

  let raw: unknown;
  try {
    raw = await requestDraft(options);
  } catch (error) {
    throw new VlmCompileError(`VLM request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const draft = parseVlmSkillDraft(raw);
    return assembleSkillFromDraft({ draft, session: options.session, ...(options.now ? { now: options.now } : {}) });
  } catch (firstError) {
    if (!(firstError instanceof VlmDraftValidationError)) throw firstError;
    let retryRaw: unknown;
    try {
      retryRaw = await requestDraft(options, { previousOutput: JSON.stringify(raw), error: firstError.message });
    } catch (error) {
      throw new VlmCompileError(
        `VLM output was invalid (${firstError.message}) and the corrective retry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const draft = parseVlmSkillDraft(retryRaw);
      return assembleSkillFromDraft({ draft, session: options.session, ...(options.now ? { now: options.now } : {}) });
    } catch (secondError) {
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new VlmCompileError(`VLM output was invalid twice — first: ${firstError.message}; after retry: ${secondMessage}`);
    }
  }
}
