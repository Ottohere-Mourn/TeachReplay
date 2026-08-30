// Standalone, offline demo for @teachreplay/vlm-compiler — no real SSH
// host, no real VLM endpoint, no network beyond localhost.
//
//   capture (screenshots + a shell command) -> compile via VLM -> save ->
//   replay -> verify
//
// Run from the repo root:
//   pnpm build && node examples/vlm-demo/main.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSkillStore, replaySkill } from "@teachreplay/core";
import { RemoteComputerBackend } from "@teachreplay/remote";
import { compileVisualSkill, FrameRecorder } from "@teachreplay/vlm-compiler";

const here = dirname(fileURLToPath(import.meta.url));
const fakeSshPath = join(here, "fake-ssh.mjs");

// What the fake VLM endpoint returns for every request — a fixed,
// schema-valid draft. A real endpoint would infer this from the actual
// captured screenshots; this demo only needs to prove the pipeline wiring.
const CANNED_DRAFT = {
  taskName: "Submit monthly report",
  description: "Fill in the month and submit the report",
  steps: [
    { kind: "navigate", description: "Open the report form", url: "http://demo.local/report" },
    { kind: "fill", description: "Fill in the month", role: "combobox", name: "Month", value: "August", parameterLabel: "Month" },
    { kind: "click", description: "Submit the report", role: "button", name: "Submit report" },
  ],
  success: { kind: "text", value: "Submission successful" },
};

const step = (label) => console.log(`\n■ ${label}`);
const root = mkdtempSync(join(tmpdir(), "teachreplay-vlm-demo-"));
const statePath = join(root, "demo-state.json");
writeFileSync(statePath, JSON.stringify({ month: "", submitted: false }));

const vlmServer = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output_text: JSON.stringify(CANNED_DRAFT) }));
  });
});

try {
  await new Promise((resolve) => vlmServer.listen(0, "127.0.0.1", resolve));
  const vlmPort = vlmServer.address().port;

  step("1 · capture — a fake remote desktop, driven entirely by an env-configured fake ssh");
  process.env.VLM_DEMO_STATE_PATH = statePath;
  const backend = new RemoteComputerBackend({
    host: "demo.local",
    sshCommand: process.execPath,
    sshExtraArgs: [fakeSshPath],
  });

  const recorder = new FrameRecorder({ backend, intervalMs: 60_000 });
  await recorder.start("demo-bot", "monthly report filing");
  await recorder.captureNow();
  await recorder.recordShell({ command: "echo capturing demo context" });
  await recorder.captureNow();
  const session = await recorder.stop();
  console.log(`   captured ${session.frames.length} frame(s), ${session.shellEvents.length} shell command(s) (backend: ${session.recordedVia})`);

  step("2 · compile — a VLM turns the capture session into a parameterized skill");
  const skill = await compileVisualSkill({
    session,
    vlm: { baseUrl: `http://127.0.0.1:${vlmPort}`, apiKey: "demo-key", model: "demo-vlm" },
  });
  console.log("   inputs:", skill.inputs.map((p) => `${p.id}=${JSON.stringify(p.default)}`).join(", "));
  console.log("   steps:", skill.steps.map((s) => s.kind).join(" → "));
  console.log("   success condition:", skill.success.kind, JSON.stringify(skill.success.value));
  console.log("   risks flagged:", skill.risks.length);

  step("3 · save — the skill is an ordinary Skill, so the existing FileSkillStore just works");
  const skillStore = new FileSkillStore(root);
  await skillStore.saveSkill(skill);

  step("4 · replay — the existing, unmodified replaySkill() runs it");
  const result = await replaySkill(skill, { month: "November" }, backend);
  for (const check of result.checks) console.log(`   [${check.ok ? "ok" : "FAIL"}] step ${check.step}: ${check.note}`);
  console.log(`   verification: ${result.verification.ok ? "ok" : "FAIL"} — ${result.verification.note}`);
  console.log(`   status: ${result.status.toUpperCase()} — ${result.stepsCompleted}/${result.totalSteps} steps`);

  if (result.status !== "success") {
    console.error("DEMO FAILED");
    process.exit(1);
  }
  console.log("\nDEMO PASSED — screenshots + shell log, compiled by a VLM, replayed by the existing deterministic engine.");
} finally {
  vlmServer.close();
  delete process.env.VLM_DEMO_STATE_PATH;
  rmSync(root, { recursive: true, force: true });
}
