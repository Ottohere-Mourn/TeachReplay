// The replay engine: executes a compiled skill against a computer backend
// and returns an EXPLICIT success/failure result.
//
// Execution is deterministic: every step re-snapshots the page, matches
// the target element semantically (role + name), acts, then verifies the
// expected effect. If a step cannot find its target, the engine takes one
// bounded retry against a fresh snapshot, then offers the optional
// recovery hook (an agent can inspect the current state and propose an
// alternative), then fails the replay explicitly. "The engine stopped" is
// never reported as success.
import { findElement, normalizeComparisonUrl, type ComputerSnapshot, type TeachComputerBackend } from "./computer.js";
import { substituteSkill, type Skill, type SkillSuccess } from "./compiler.js";

export type ReplayStatus = "success" | "failed";

export interface ReplayCheck {
  stepId: string;
  step: number;
  ok: boolean;
  note: string;
}

export interface ReplayResult {
  status: ReplayStatus;
  skillId: string;
  startedAt: number;
  finishedAt: number;
  stepsCompleted: number;
  totalSteps: number;
  /** True when the recovery hook resolved a failed step. */
  recovered: boolean;
  checks: ReplayCheck[];
  /** Final verification detail — the success condition itself. */
  verification: { ok: boolean; note: string };
  error?: string;
}

export interface ReplayOptions {
  /** Called when a step cannot locate its target after one retry. The hook
   * receives the step and the live snapshot and may return an alternative
   * semantic match (e.g. the button was renamed). Returning null means
   * "cannot recover" and the replay fails. */
  recover?: (step: { kind: string; match?: { role: string; name?: string }; description: string }, snapshot: ComputerSnapshot) => Promise<{ role: string; name?: string } | null>;
  now?: () => number;
}

const SETTLE_MS = 150;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The verifier: checks the skill's success condition against the live
 * page state. Explicit — "the engine stopped" never counts as success. */
export async function verifySkillOutcome(
  success: SkillSuccess,
  snapshot: ComputerSnapshot,
): Promise<{ ok: boolean; note: string }> {
  if (success.kind === "url") {
    const actual = normalizeComparisonUrl(snapshot.url ?? "");
    const expected = normalizeComparisonUrl(success.value);
    return actual !== null && actual === expected
      ? { ok: true, note: `URL matches ${success.value}` }
      : { ok: false, note: `expected URL ${success.value}, found ${snapshot.url ?? "none"}` };
  }
  const shown = snapshot.text.toLowerCase();
  const wanted = success.value.toLowerCase();
  const excerpt = snapshot.text.replace(/\s+/g, " ").trim().slice(0, 200);
  return shown.includes(wanted)
    ? { ok: true, note: `page shows "${success.value}"` }
    : { ok: false, note: `page does not show "${success.value}" — current page text: "${excerpt}"` };
}

/** Verify a step's expected effect is visible. */
function verifyStep(kind: string, before: ComputerSnapshot, after: ComputerSnapshot, value?: string): { ok: boolean; note: string } {
  if (kind === "fill") {
    const target = after.elements.find((element) => {
      const found = before.elements.find((b) => b.ref === element.ref);
      return found?.value !== element.value && element.value === value;
    });
    if (target) return { ok: true, note: `value "${value}" is visible in ${target.role} "${target.name}"` };
    const anyMatch = after.elements.find((element) => element.value === value);
    if (anyMatch) return { ok: true, note: `value "${value}" is visible in ${anyMatch.role} "${anyMatch.name}"` };
    return { ok: false, note: `no field shows the filled value "${value}"` };
  }
  if (kind === "navigate") {
    // The step's goal is being ON the target page — arriving early (the
    // computer already sits there) is success, not a failure to navigate.
    const target = normalizeComparisonUrl(value ?? "");
    const actual = normalizeComparisonUrl(after.url ?? "");
    return target !== null && actual === target
      ? { ok: true, note: `page is at ${after.url}` }
      : { ok: false, note: `expected to reach ${value}, page is at ${after.url ?? "none"}` };
  }
  // click: the page must have changed in some observable way.
  if (after.url !== before.url) return { ok: true, note: `page navigated to ${after.url}` };
  if (after.text !== before.text) return { ok: true, note: "visible text changed" };
  if (after.elements.length !== before.elements.length) return { ok: true, note: "page structure changed" };
  return { ok: false, note: "no observable change after the click" };
}

async function locateTarget(
  backend: TeachComputerBackend,
  match: { role: string; name?: string },
  options: ReplayOptions,
  step: { kind: string; match?: { role: string; name?: string }; description: string },
): Promise<{ ref: string; recovered: boolean } | { error: string }> {
  let snapshot = await backend.snapshot();
  let found = findElement(snapshot, match);
  if (found) return { ref: found.ref, recovered: false };
  // One bounded retry: the page may still be rendering.
  await sleep(SETTLE_MS);
  snapshot = await backend.snapshot();
  found = findElement(snapshot, match);
  if (found) return { ref: found.ref, recovered: false };
  // Agent-assisted recovery: give the current state to the recovery hook.
  if (options.recover) {
    const alternative = await options.recover(step, snapshot);
    if (alternative) {
      snapshot = await backend.snapshot();
      const recoveredElement = findElement(snapshot, alternative);
      if (recoveredElement) return { ref: recoveredElement.ref, recovered: true };
    }
  }
  return {
    error:
      `could not find ${match.role}${match.name ? ` "${match.name}"` : ""} on the page ` +
      `(current URL: ${snapshot.url ?? "none"}). The UI may have changed since the skill was recorded.`,
  };
}

export async function replaySkill(
  skill: Skill,
  inputs: Record<string, string>,
  backend: TeachComputerBackend,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { steps, success, missing } = substituteSkill(skill, inputs);
  const checks: ReplayCheck[] = [];
  let recovered = false;
  let stepsCompleted = 0;

  if (missing.length) {
    return {
      status: "failed",
      skillId: skill.id,
      startedAt,
      finishedAt: now(),
      stepsCompleted: 0,
      totalSteps: steps.length,
      recovered: false,
      checks,
      verification: { ok: false, note: "the replay could not start" },
      error: `missing inputs: ${missing.join(", ")}`,
    };
  }

  let stepNumber = 0;
  for (const step of steps) {
    stepNumber += 1;
    try {
      if (step.kind === "navigate") {
        await backend.navigate(step.url!);
        await sleep(SETTLE_MS);
        const after = await backend.snapshot();
        const verification = verifyStep("navigate", after, after, step.url);
        checks.push({ stepId: step.id, step: stepNumber, ok: verification.ok, note: verification.note });
        if (!verification.ok) break;
      } else if (step.kind === "fill") {
        const target = await locateTarget(backend, step.match!, options, step);
        if ("error" in target) {
          checks.push({ stepId: step.id, step: stepNumber, ok: false, note: target.error });
          break;
        }
        if (target.recovered) recovered = true;
        const before = await backend.snapshot();
        await backend.fill(target.ref, step.value!);
        await sleep(SETTLE_MS);
        const after = await backend.snapshot();
        const verification = verifyStep("fill", before, after, step.value);
        checks.push({ stepId: step.id, step: stepNumber, ok: verification.ok, note: verification.note });
        if (!verification.ok) break;
      } else if (step.kind === "click") {
        const target = await locateTarget(backend, step.match!, options, step);
        if ("error" in target) {
          checks.push({ stepId: step.id, step: stepNumber, ok: false, note: target.error });
          break;
        }
        if (target.recovered) recovered = true;
        const before = await backend.snapshot();
        await backend.click(target.ref);
        await sleep(SETTLE_MS);
        const after = await backend.snapshot();
        const verification = verifyStep("click", before, after);
        checks.push({ stepId: step.id, step: stepNumber, ok: verification.ok, note: verification.note });
        if (!verification.ok) break;
      } else if (step.kind === "shell") {
        const result = await backend.exec(step.command!, step.cwd ? { cwd: step.cwd } : undefined);
        const ok = result.exitCode === 0;
        const excerpt = (result.stderr || result.stdout || "(no output)").replace(/\s+/g, " ").trim().slice(-240);
        checks.push({
          stepId: step.id,
          step: stepNumber,
          ok,
          note: ok ? `exit 0 — ${excerpt}` : `exit ${result.exitCode ?? "?"} — ${excerpt}`,
        });
        if (!ok) break;
      } else {
        checks.push({ stepId: step.id, step: stepNumber, ok: false, note: `unsupported step kind "${step.kind}"` });
        break;
      }
      stepsCompleted = stepNumber;
    } catch (error) {
      checks.push({
        stepId: step.id,
        step: stepNumber,
        ok: false,
        note: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  const allStepsOk = stepsCompleted === steps.length;
  const verification = allStepsOk
    ? await verifySkillOutcome(success, await backend.snapshot())
    : { ok: false, note: "verification skipped: not all steps completed" };

  const status: ReplayStatus = allStepsOk && verification.ok ? "success" : "failed";
  return {
    status,
    skillId: skill.id,
    startedAt,
    finishedAt: now(),
    stepsCompleted,
    totalSteps: steps.length,
    recovered,
    checks,
    verification,
    error: status === "failed"
      ? (checks.find((check) => !check.ok)?.note ?? verification.note)
      : undefined,
  };
}
