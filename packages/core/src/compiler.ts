// The skill compiler: raw trajectory → reusable parameterized skill.
//
// Pure and deterministic — no model call. The demonstration's literal
// values become parameter DEFAULTS; each distinct filled field becomes a
// skill input so a later replay can substitute new values. Grounding is
// semantic (role + element name), never screen coordinates.
//
// Output is a machine-readable skill plus a human-readable Markdown
// rendering, both persisted by the TeachManager.
import { randomUUID } from "node:crypto";

import { normalizeComparisonUrl } from "./computer.js";
import { SENSITIVE_VALUE, type TeachEvent, type Trajectory } from "./trajectory.js";

export const SKILL_VERSION = 1 as const;

export interface SkillParameter {
  id: string;
  label: string;
  /** Default value captured from the demonstration. */
  default: string;
  /** Human hint about where the value came from ("the Month field"). */
  description: string;
}

export interface SkillStep {
  id: string;
  kind: "navigate" | "fill" | "click" | "press" | "shell";
  description: string;
  /** Semantic grounding. name is optional so a later compiler could target
   * "the first textbox" when the page offers only one. */
  match?: { role: string; name?: string };
  /** For navigate: the URL, possibly containing ${param} references. */
  url?: string;
  /** For fill: either a literal value or a ${param} reference. */
  value?: string;
  parameter?: string;
  /** For press: the key chord. */
  keys?: string;
  /** For shell: the command (may contain ${param} references). */
  command?: string;
  cwd?: string;
}

export interface SkillSuccess {
  kind: "url" | "text";
  /** Literal value or a ${param}-style reference. */
  value: string;
  description: string;
}

export interface Skill {
  schemaVersion: typeof SKILL_VERSION;
  id: string;
  name: string;
  description: string;
  sourceTrajectoryId: string;
  botId: string;
  app: string;
  recordedVia: string;
  createdAt: number;
  inputs: SkillParameter[];
  steps: SkillStep[];
  success: SkillSuccess;
  /** Steps the compiler believes deserve a human look before replay. */
  risks: string[];
}

export interface SkillFile {
  version: 1;
  skill: Skill;
}

const PARAM_REF = /\$\{([a-z0-9-]+)\}/g;

export function paramRef(paramId: string): string {
  return `\${${paramId}}`;
}

/** Substitute parameter values into a skill's steps and success condition.
 * Missing inputs keep the default. Unknown references are an error — a
 * replay must not silently execute a half-substituted workflow. */
export function substituteSkill(skill: Skill, inputs: Record<string, string>): { steps: SkillStep[]; success: SkillSuccess; missing: string[] } {
  const values = new Map(skill.inputs.map((parameter) => [parameter.id, parameter.default]));
  for (const [id, value] of Object.entries(inputs)) {
    if (typeof value === "string" && value) values.set(id, value);
  }
  const resolve = (text: string): { value: string; missing: string[] } => {
    const missing: string[] = [];
    const value = text.replace(PARAM_REF, (match, id: string) => {
      const resolved = values.get(id);
      if (resolved === undefined) {
        missing.push(id);
        return match;
      }
      return resolved;
    });
    if (missing.length) return { value: text, missing: [...new Set(missing)] };
    return { value, missing: [] };
  };
  const steps: SkillStep[] = [];
  const missing: string[] = [];
  for (const step of skill.steps) {
    const next: SkillStep = { ...step };
    if (step.url) {
      const resolved = resolve(step.url);
      next.url = resolved.value;
      missing.push(...resolved.missing);
    }
    if (step.value) {
      const resolved = resolve(step.value);
      next.value = resolved.value;
      missing.push(...resolved.missing);
    }
    if (step.command) {
      const resolved = resolve(step.command);
      next.command = resolved.value;
      missing.push(...resolved.missing);
    }
    steps.push(next);
  }
  const success = { ...skill.success, value: resolve(skill.success.value).value };
  const deduped = [...new Set(missing)];
  return { steps, success, missing: deduped };
}

/** Turn a demonstrated value into a stable parameter id. */
export function parameterIdFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "value";
}

/** Human-readable skill rendering — the part a person reviews before
 * saving or replaying. */
export function renderSkillMarkdown(skill: Skill): string {
  const lines: string[] = [
    `# ${skill.name}`,
    "",
    skill.description || "No description.",
    "",
    "## Inputs",
  ];
  if (skill.inputs.length) {
    for (const input of skill.inputs) {
      lines.push(`- **${input.id}** (${input.label}) — default: \`${input.default}\``);
    }
  } else {
    lines.push("_None — this skill takes no inputs._");
  }
  lines.push("", "## Steps");
  for (const step of skill.steps) {
    const detail =
      step.kind === "navigate" ? `open \`${step.url ?? ""}\``
      : step.kind === "fill" ? `fill **${step.match?.name ?? step.match?.role ?? ""}** with \`${step.value ?? ""}\``
      : step.kind === "click" ? `click **${step.match?.name ?? step.match?.role ?? ""}**`
      : step.kind === "shell" ? `run \`${step.command ?? ""}\``
      : `press \`${step.keys ?? ""}\``;
    lines.push(`${skill.steps.indexOf(step) + 1}. ${step.description} — ${detail}`);
  }
  lines.push("", "## Success condition");
  lines.push(
    skill.success.kind === "url"
      ? `The page URL must match \`${skill.success.value}\`.`
      : `The page must show text containing: \`${skill.success.value}\``,
  );
  if (skill.risks.length) {
    lines.push("", "## Review before replay");
    for (const risk of skill.risks) lines.push(`- ${risk}`);
  }
  return lines.join("\n");
}

interface CompileOptions {
  name?: string;
  now?: () => number;
}

/** Coalesce consecutive fill events for the same field (typing arrives as
 * many small diffs); the last value is the one the demonstration left. */
function coalesceFills(events: TeachEvent[]): TeachEvent[] {
  const out: TeachEvent[] = [];
  for (const event of events) {
    if (event.kind !== "fill") {
      out.push(event);
      continue;
    }
    const previous = out[out.length - 1];
    if (previous?.kind === "fill" && previous.ref === event.ref) {
      out[out.length - 1] = event;
    } else {
      out.push(event);
    }
  }
  return out;
}

export function compileTrajectory(trajectory: Trajectory, options: CompileOptions = {}): Skill {
  const now = options.now ?? Date.now;
  const events = coalesceFills(trajectory.events);
  const session = events.find((event): event is Extract<TeachEvent, { kind: "session" }> => event.kind === "session");
  if (!session) throw new Error("trajectory has no session event");

  const parameters = new Map<string, SkillParameter>();
  const steps: SkillStep[] = [];
  const risks: string[] = [];
  let stepIndex = 0;

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

  for (const event of events) {
    switch (event.kind) {
      case "session":
        break;
      case "navigate": {
        steps.push({
          id: `s${++stepIndex}`,
          kind: "navigate",
          description: `Open ${event.url}`,
          url: event.url,
        });
        break;
      }
      case "fill": {
        if (event.sensitive || event.value === SENSITIVE_VALUE) {
          risks.push(`The ${event.name || event.role} field was filled but its value is stored masked — the replay will not fill it.`);
          continue;
        }
        const parameter = paramFor(event.name || event.role, event.value);
        steps.push({
          id: `s${++stepIndex}`,
          kind: "fill",
          description: `Fill ${event.name || event.role} with ${event.value === parameter.default ? paramRef(parameter.id) : event.value}`,
          match: { role: event.role, name: event.name || undefined },
          value: paramRef(parameter.id),
          parameter: parameter.id,
        });
        break;
      }
      case "click": {
        steps.push({
          id: `s${++stepIndex}`,
          kind: "click",
          description: `Click ${event.name || event.role}`,
          match: { role: event.role, name: event.name || undefined },
        });
        if (/submit|send|pay|purchase|delete|remove|approve|confirm/i.test(event.name)) {
          risks.push(`Clicks "${event.name || event.role}" — a submitting action.`);
        }
        break;
      }
      case "press": {
        steps.push({ id: `s${++stepIndex}`, kind: "press", description: `Press ${event.keys}`, keys: event.keys });
        break;
      }
      case "shell": {
        // Generalized when the command embeds a demonstrated fill value,
        // so a replayed input flows into the CLI step too.
        let command = event.command;
        for (const parameter of parameters.values()) {
          if (parameter.default.length >= 4 && command.includes(parameter.default)) {
            command = command.split(parameter.default).join(paramRef(parameter.id));
          }
        }
        if (event.exitCode !== null && event.exitCode !== 0) {
          risks.push(`The shell command "${event.command}" exited ${event.exitCode} during the demonstration.`);
        }
        steps.push({
          id: `s${++stepIndex}`,
          kind: "shell",
          description: `Run \`${event.command}\`${event.cwd ? ` in ${event.cwd}` : ""}`,
          command,
          cwd: event.cwd,
        });
        break;
      }
      case "observe":
        break;
    }
  }

  if (!steps.length) throw new Error("the demonstration contained no replayable steps");

  // Success condition: prefer the final page's visible text (it is what a
  // person would read to know it worked); fall back to the final URL.
  const lastObserve = [...events].reverse().find((event): event is Extract<TeachEvent, { kind: "observe" }> => event.kind === "observe");
  const lastNavigate = [...events].reverse().find((event): event is Extract<TeachEvent, { kind: "navigate" }> => event.kind === "navigate");
  const lastText = lastObserve?.text.trim() ?? "";
  const lastUrl = lastObserve?.url ?? lastNavigate?.url ?? null;
  let success: SkillSuccess;
  if (lastText) {
    // The full page text includes field values; the success condition should
    // be a STABLE fragment — prefer the longest line that contains none of
    // the demonstrated values (usually the confirmation heading). Only when
    // every line embeds a value, generalize the longest one.
    const parameterDefaults = new Set(
      [...parameters.values()].map((parameter) => parameter.default).filter((value) => value.length >= 4),
    );
    const containsParameter = (line: string) =>
      [...parameterDefaults].some((value) => line.includes(value));
    const lines = lastText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 6);
    const stable = lines.filter((line) => !containsParameter(line));
    let chosen = (stable.length ? stable : lines).sort((a, b) => b.length - a.length)[0] ?? lastText.slice(0, 60);
    for (const parameter of parameters.values()) {
      if (chosen.includes(parameter.default)) chosen = chosen.split(parameter.default).join(paramRef(parameter.id));
    }
    success = { kind: "text", value: chosen, description: "The page shows the confirmation text." };
  } else if (lastUrl) {
    success = { kind: "url", value: lastUrl, description: "The page reached the final URL." };
  } else {
    throw new Error("the demonstration ended without any verifiable state");
  }

  const name = options.name?.trim() || (session.app === "chrome" ? `${trajectory.name} workflow` : trajectory.name);

  return {
    schemaVersion: SKILL_VERSION,
    id: randomUUID(),
    name,
    description: `Workflow demonstrated on ${session.app} (recorded via ${session.recordedVia}).`,
    sourceTrajectoryId: trajectory.id,
    botId: trajectory.botId,
    app: session.app,
    recordedVia: session.recordedVia,
    createdAt: now(),
    inputs: [...parameters.values()],
    steps,
    success,
    risks,
  };
}

/** Strict validation on load, mirroring parseTrajectory. Accepts the
 * persisted file shape `{ version, skill }`. */
export function parseSkill(value: unknown): Skill {
  if (!value || typeof value !== "object") throw new Error("skill file must be an object");
  const file = value as Record<string, unknown>;
  if (file.version !== 1) throw new Error(`unsupported skill file version "${String(file.version)}"`);
  const raw = file.skill;
  if (!raw || typeof raw !== "object") throw new Error("skill file must contain a skill");
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== SKILL_VERSION) throw new Error(`unsupported skill schema version "${String(data.schemaVersion)}"`);
  const required = ["id", "name", "description", "sourceTrajectoryId", "botId", "app", "recordedVia", "createdAt", "inputs", "steps", "success"];
  for (const key of required) {
    if (!(key in data)) throw new Error(`skill is missing "${key}"`);
  }
  if (!Array.isArray(data.inputs) || !Array.isArray(data.steps)) throw new Error("skill inputs/steps must be arrays");
  const steps = data.steps as unknown[];
  if (!steps.every((step) => step && typeof step === "object" && typeof (step as Record<string, unknown>).kind === "string")) {
    throw new Error("skill has invalid steps");
  }
  return data as unknown as Skill;
}

export function serializeSkill(skill: Skill): string {
  return JSON.stringify({ version: 1, skill } satisfies SkillFile, null, 2);
}

/** Verify a compiled skill's parameter references are all declared. */
export function skillReferencesAreValid(skill: Skill): string[] {
  const declared = new Set(skill.inputs.map((parameter) => parameter.id));
  const problems: string[] = [];
  const check = (text: string, where: string) => {
    for (const match of text.matchAll(PARAM_REF)) {
      if (!declared.has(match[1])) problems.push(`${where} references undeclared parameter "${match[1]}"`);
    }
  };
  for (const step of skill.steps) {
    if (step.url) check(step.url, `step ${step.id}`);
    if (step.value) check(step.value, `step ${step.id}`);
    if (step.command) check(step.command, `step ${step.id}`);
  }
  check(skill.success.value, "success condition");
  return problems;
}

/** True when two URLs compare equal for verification purposes. */
export function urlsMatch(expected: string, actual: string): boolean {
  const left = normalizeComparisonUrl(expected);
  const right = normalizeComparisonUrl(actual);
  return left !== null && left === right;
}
