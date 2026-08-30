// Pure Skill assembly: VLM draft + capture session -> a real Skill.
//
// Synchronous, zero I/O, fully unit-testable. This is the only place in
// the VLM path that ever emits id/schemaVersion/createdAt or ${...}
// parameter-reference syntax — the model is never trusted with any of
// that (see vlm-schema.ts), so a skillReferencesAreValid failure here
// would always be a bug in this file, never a model hallucination.
import { randomUUID } from "node:crypto";

import {
  paramRef,
  parameterIdFor,
  skillReferencesAreValid,
  SKILL_VERSION,
  type Skill,
  type SkillParameter,
  type SkillStep,
  type SkillSuccess,
} from "@teachreplay/core";

import type { VisualSession } from "./session.js";
import type { VlmSkillDraft, VlmSkillStepDraft } from "./vlm-schema.js";

export class SkillAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAssemblyError";
  }
}

export interface AssembleSkillInput {
  draft: VlmSkillDraft;
  session: VisualSession;
  now?: () => number;
}

const SCREENSHOT_RISK_DISCLOSURE =
  "This skill was compiled from periodic screenshots by a VLM, not a semantic accessibility-tree recording. " +
  "Regex-based text redaction can't catch secrets that were only ever visible as pixels (e.g. a password " +
  "manager overlay, other on-screen sensitive UI) — review the source screenshots and this skill's steps before replay.";

/** Same dedup-by-id-then-by-value scheme compileTrajectory uses
 * (packages/core/src/compiler.ts): reuse the id if the value matches, else
 * suffix with an incrementing number. */
function makeParamRegistry() {
  const parameters = new Map<string, SkillParameter>();
  const paramFor = (label: string, value: string): SkillParameter => {
    const baseId = parameterIdFor(label);
    let id = baseId;
    let n = 2;
    while (parameters.has(id) && parameters.get(id)!.default !== value) {
      id = `${baseId}-${n++}`;
    }
    const existing = parameters.get(id);
    if (existing) return existing;
    const parameter: SkillParameter = {
      id,
      label,
      default: value,
      description: `Captured from the ${label} field during the demonstration.`,
    };
    parameters.set(id, parameter);
    return parameter;
  };
  return { parameters, paramFor };
}

/** Same literal-substring -> ${param} substitution compileTrajectory
 * applies to shell commands, so a demonstrated value that also appears in
 * a shell step gets parameterized consistently with the fill step it came
 * from. */
function generalizeText(text: string, parameters: ReadonlyMap<string, SkillParameter>): string {
  let out = text;
  for (const parameter of parameters.values()) {
    if (parameter.default.length >= 4 && out.includes(parameter.default)) {
      out = out.split(parameter.default).join(paramRef(parameter.id));
    }
  }
  return out;
}

function assembleStep(step: VlmSkillStepDraft, index: number, registry: ReturnType<typeof makeParamRegistry>): SkillStep {
  const id = `s${index + 1}`;
  const base: SkillStep = { id, kind: step.kind, description: step.description };
  switch (step.kind) {
    case "navigate": {
      if (!step.url) throw new SkillAssemblyError(`step ${id} (navigate) is missing url`);
      return { ...base, url: step.url };
    }
    case "fill": {
      if (!step.role) throw new SkillAssemblyError(`step ${id} (fill) is missing role`);
      const literalValue = step.value ?? "";
      if (step.isParameter === false) {
        return { ...base, match: { role: step.role, ...(step.name ? { name: step.name } : {}) }, value: literalValue };
      }
      const label = step.parameterLabel || step.name || step.role;
      const parameter = registry.paramFor(label, literalValue);
      return {
        ...base,
        match: { role: step.role, ...(step.name ? { name: step.name } : {}) },
        value: paramRef(parameter.id),
        parameter: parameter.id,
      };
    }
    case "click": {
      if (!step.role) throw new SkillAssemblyError(`step ${id} (click) is missing role`);
      return { ...base, match: { role: step.role, ...(step.name ? { name: step.name } : {}) } };
    }
    case "press": {
      if (!step.keys) throw new SkillAssemblyError(`step ${id} (press) is missing keys`);
      return { ...base, keys: step.keys };
    }
    case "shell": {
      if (!step.command) throw new SkillAssemblyError(`step ${id} (shell) is missing command`);
      return {
        ...base,
        command: generalizeText(step.command, registry.parameters),
        ...(step.cwd ? { cwd: step.cwd } : {}),
      };
    }
  }
}

function assembleSuccess(draft: VlmSkillDraft["success"], registry: ReturnType<typeof makeParamRegistry>): SkillSuccess {
  return {
    kind: draft.kind,
    value: generalizeText(draft.value, registry.parameters),
    description: draft.description || (draft.kind === "url" ? "The page reached the final URL." : "The page shows the confirmation text."),
  };
}

/** Assembles a real, valid Skill from a VLM draft. Throws SkillAssemblyError
 * if skillReferencesAreValid finds a dangling ${param} reference — by
 * construction this file is the only place that syntax is ever emitted, so
 * this check is defense-in-depth, not a real failure mode. */
export function assembleSkillFromDraft(input: AssembleSkillInput): Skill {
  const { draft, session } = input;
  const now = input.now ?? Date.now;
  if (!draft.steps.length) throw new SkillAssemblyError("the draft contains no steps");

  const registry = makeParamRegistry();
  const steps = draft.steps.map((step, index) => assembleStep(step, index, registry));
  const success = assembleSuccess(draft.success, registry);
  const risks = [...(draft.risks ?? []), SCREENSHOT_RISK_DISCLOSURE];

  const skill: Skill = {
    schemaVersion: SKILL_VERSION,
    id: randomUUID(),
    name: draft.taskName?.trim() || `${session.name} workflow`,
    description:
      (draft.description?.trim() || `Workflow demonstrated on ${session.app}.`) +
      ` Compiled by a VLM from ${session.frames.length} screenshot(s)` +
      (session.shellEvents.length ? ` and ${session.shellEvents.length} shell command(s)` : "") +
      "; no underlying accessibility-tree recording is persisted for this skill.",
    sourceTrajectoryId: session.id,
    botId: session.botId,
    app: session.app,
    recordedVia: session.recordedVia,
    createdAt: now(),
    inputs: [...registry.parameters.values()],
    steps,
    success,
    risks,
  };

  const problems = skillReferencesAreValid(skill);
  if (problems.length) throw new SkillAssemblyError(`assembled skill is invalid: ${problems.join("; ")}`);
  return skill;
}
