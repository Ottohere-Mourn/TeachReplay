// DeepSeek Harness adapter demo — the teach_* flow through the adapter's
// session (the exact path the DSH tools call), on the mock demo computer.
//
//   teach_start → demonstrate → teach_stop → teach_compile
//   → change parameters → teach_replay → success
//
// Run from the repo root:  pnpm build && node examples/dsh-demo/main.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DshTeachSession } from "@teachreplay/adapter-dsh";
import { MockComputer } from "@teachreplay/mock";

const root = mkdtempSync(join(tmpdir(), "dsh-teach-demo-"));
const computer = new MockComputer();
const session = new DshTeachSession({
  dataDir: root,
  backend: { kind: "custom", create: () => computer },
  pollMs: 20,
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (label) => console.log(`\n■ ${label}`);

try {
  step("teach_start — recording begins (mock demo computer)");
  const status = await session.start("monthly report filing");
  console.log(`   recording: ${status.name} on the ${status.recordedVia} backend`);

  step("demonstrate — the person fills the report form");
  await computer.fill("f-month", "August"); await pause(60);
  await computer.fill("f-title", "August sales"); await pause(60);
  await computer.fill("f-recipient", "reports@example.com"); await pause(60);
  await computer.click("b-submit"); await pause(60);
  console.log("   page:", computer.demoState().url);

  step("teach_shell — a CLI step, recorded with its real exit code");
  await session.recordShell({ command: "process report", cwd: "/opt/teachreplay" });

  step("teach_stop — trajectory persisted");
  const stopped = await session.stop();
  console.log(`   ${stopped.eventCount} events saved`);

  step("teach_compile — parameterized skill");
  const skill = await session.compile("File monthly report");
  console.log("   inputs:", skill.inputs.map((p) => `${p.id}=${JSON.stringify(p.default)}`).join(", "));

  step("change parameters → teach_replay");
  const result = await session.replay(skill.id, {
    month: "November",
    "report-title": "November sales",
    "recipient-email": "cfo@example.com",
  });
  console.log(`   status: ${result.status.toUpperCase()} — ${result.stepsCompleted}/${result.totalSteps} steps`);
  for (const check of result.checks) console.log(`   [${check.ok ? "ok" : "FAIL"}] step ${check.step}: ${check.note}`);
  console.log(`   verification: ${result.verification.ok ? "ok" : "FAIL"} — ${result.verification.note}`);
  const submission = computer.demoState().submitted.at(-1);
  console.log(`   ground truth on the computer: ${submission["f-month"]} / ${submission["f-recipient"]}`);
  if (result.status !== "success" || submission["f-month"] !== "November") {
    console.error("DSH DEMO FAILED");
    process.exit(1);
  }
  console.log("\nDSH DEMO PASSED — the same flow the teach_* tools dispatch.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
