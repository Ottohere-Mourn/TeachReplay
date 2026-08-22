// Standalone TeachReplay demo — no OpenMausBot, no harness, no network.
//
//   demonstrate → record → compile → change parameters → replay → verify
//
// Runs the whole pipeline on the built-in demo computer with plain file
// persistence, using only @teachreplay/core + @teachreplay/mock.
//
// Run from the repo root:
//   pnpm build && pnpm demo
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTeachRuntime,
  FileSkillStore,
  FileTrajectoryStore,
} from "@teachreplay/core";
import { MockComputer } from "@teachreplay/mock";

const root = mkdtempSync(join(tmpdir(), "teachreplay-demo-"));
const computer = new MockComputer();
const runtime = createTeachRuntime({
  backend: computer,
  trajectoryStore: new FileTrajectoryStore(root),
  skillStore: new FileSkillStore(root),
  pollMs: 20,
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (label) => console.log(`\n■ ${label}`);

try {
  step("1 · start recording — the recorder begins watching");
  await runtime.startRecording("demo-bot", "monthly report filing");
  console.log("   recording on the demo computer (mock backend, no credentials)");

  step("2 · demonstrate — the person fills the report form while recording");
  await computer.fill("f-month", "August");
  await pause(60);
  await computer.fill("f-title", "August sales");
  await pause(60);
  await computer.fill("f-recipient", "reports@example.com");
  await pause(60);
  await computer.click("b-submit");
  await pause(60);
  console.log("   page:", computer.demoState().url, "—", computer.demoState().heading);
  const recorded = await runtime.stopRecording();
  console.log(`   trajectory ${recorded.id.slice(0, 8)}… — ${recorded.eventCount} events (${recorded.recordedVia} backend)`);

  step("3 · compile — trajectory becomes a parameterized skill");
  const skill = await runtime.compileRecording(recorded.id, "File monthly report");
  console.log("   inputs:", skill.inputs.map((p) => `${p.id}=${JSON.stringify(p.default)}`).join(", "));
  console.log("   steps:", skill.steps.map((s) => s.kind + (s.command ? `(${s.command})` : "")).join(" → "));
  console.log("   success condition:", skill.success.kind, JSON.stringify(skill.success.value));

  step("4 · change parameters — replay with new inputs");
  const result = await runtime.replay(skill.id, {
    month: "November",
    "report-title": "November sales",
    "recipient-email": "cfo@example.com",
  });
  console.log("   inputs: November / November sales / cfo@example.com");

  step("5 · replay → verify");
  console.log(`   status: ${result.status.toUpperCase()} — ${result.stepsCompleted}/${result.totalSteps} steps`);
  for (const check of result.checks) console.log(`   [${check.ok ? "ok" : "FAIL"}] step ${check.step}: ${check.note}`);
  console.log(`   verification: ${result.verification.ok ? "ok" : "FAIL"} — ${result.verification.note}`);
  const submission = computer.demoState().submitted.at(-1);
  console.log(`   ground truth on the computer: ${submission["f-month"]} / ${submission["f-title"]} / ${submission["f-recipient"]}`);
  if (result.status !== "success" || submission["f-month"] !== "November") {
    console.error("DEMO FAILED");
    process.exit(1);
  }
  console.log("\nDEMO PASSED — teach once, replay with new inputs, verified.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
