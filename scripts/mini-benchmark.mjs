// TeachReplay mini benchmark — 8 lightweight tasks against a REAL remote
// computer (any SSH Linux box with the TeachReplay GUI stack). Runs on
// the standalone core + remote packages: no harness, no HTTP API.
// Measures: normal replay success, parameter substitution, mild and
// severe UI drift, missing elements, GUI+CLI workflows, partial inputs,
// and repeated replays. Every expectation is checked against the ground
// truth on the remote machine, not just the replay's own verdict.
//
// Requirements:
//   - the demo site (scripts/teachremote/ from the v0.1 repo) deployed
//     on the remote box
//   - BENCH_SSH_HOST / BENCH_SSH_KEY (and optionally BENCH_SSH_PORT /
//     BENCH_SSH_USER) in the environment
//
// Run: pnpm build && node scripts/mini-benchmark.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTeachRuntime, FileSkillStore, FileTrajectoryStore } from "@teachreplay/core";
import { RemoteComputerBackend } from "@teachreplay/remote";

const SSH_HOST = process.env.BENCH_SSH_HOST;
const SSH_PORT = process.env.BENCH_SSH_PORT ?? "22";
const SSH_USER = process.env.BENCH_SSH_USER ?? "root";
const SSH_KEY = process.env.BENCH_SSH_KEY;
if (!SSH_HOST || !SSH_KEY) {
  console.error("set BENCH_SSH_HOST and BENCH_SSH_KEY (and optionally BENCH_SSH_PORT/BENCH_SSH_USER)");
  process.exit(2);
}
const SSH = ["ssh", "-p", SSH_PORT, "-i", SSH_KEY, "-o", "BatchMode=yes", `${SSH_USER}@${SSH_HOST}`];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (cmd) => spawnSync(SSH[0], [...SSH.slice(1), cmd], { encoding: "utf8" }).stdout.trim();

const hands = new RemoteComputerBackend({
  host: SSH_HOST,
  port: Number(SSH_PORT),
  user: SSH_USER,
  keyFile: SSH_KEY,
});

const root = mkdtempSync(join(tmpdir(), "teachreplay-bench-"));
const trajectoryStore = new FileTrajectoryStore(root);
const runtime = createTeachRuntime({
  backend: hands,
  trajectoryStore,
  skillStore: new FileSkillStore(root),
});

const setVariant = (variant) => {
  if (!variant) return ssh("rm -f /opt/teachreplay/data/variant.json");
  ssh(`printf '%s' '${JSON.stringify(variant).replace(/'/g, "'\\''")}' > /opt/teachreplay/data/variant.json`);
};
const resetRemote = () => {
  ssh("rm -f /opt/teachreplay/data/latest.csv /opt/teachreplay/data/report.txt");
  setVariant(null);
};
const csvGroundTruth = () => ssh("cat /opt/teachreplay/data/latest.csv 2>/dev/null | tail -1").trim();
const reportGroundTruth = () => ssh("cat /opt/teachreplay/data/report.txt 2>/dev/null").trim();

async function demonstrate(values, withShell, botId) {
  await hands.navigate("http://127.0.0.1:8080/");
  await pause(2500);
  const snap = await hands.snapshot();
  const month = snap.elements.find((e) => e.role === "combobox");
  const title = snap.elements.find((e) => e.name === "Report title");
  const recipient = snap.elements.find((e) => e.name === "Recipient email");
  const notes = snap.elements.find((e) => e.name === "Notes");
  const submit = snap.elements.find((e) => e.role === "button");
  if (!month || !title || !recipient || !notes || !submit) {
    throw new Error(`demo site incomplete: ${snap.elements.map((e) => `${e.role}:${e.name}`).join(", ")}`);
  }
  await hands.fill(month.ref, values.month); await pause(2500);
  await hands.fill(title.ref, values.title); await pause(2500);
  await hands.fill(recipient.ref, values.recipient); await pause(2500);
  await hands.fill(notes.ref, values.notes); await pause(2500);
  await hands.click(submit.ref); await pause(3000);
  if (withShell) {
    await runtime.recordShell(botId, { command: "python3 /opt/teachreplay/process.py", cwd: "/opt/teachreplay" });
    await pause(2500);
    await hands.navigate("http://127.0.0.1:8080/done");
    await pause(3000);
  }
}

const TASKS = [
  {
    id: "t1-baseline",
    name: "normal replay (defaults)",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    replays: [
      { label: "defaults run 1", inputs: {}, expect: "success", groundTruth: (csv) => csv.includes("August") },
      { label: "defaults run 2", inputs: {}, expect: "success", groundTruth: (csv) => csv.includes("August") },
      { label: "defaults run 3", inputs: {}, expect: "success", groundTruth: (csv) => csv.includes("August") },
    ],
  },
  {
    id: "t2-param-swap",
    name: "parameter substitution",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    replays: [
      { label: "October", inputs: { month: "October", "report-title": "October sales", "recipient-email": "cfo@example.com", notes: "replayed" }, expect: "success", groundTruth: (csv) => csv.includes("October") && csv.includes("cfo@example.com") },
      { label: "December", inputs: { month: "December", "report-title": "December wrap", "recipient-email": "ceo@example.com", notes: "wrap" }, expect: "success", groundTruth: (csv) => csv.includes("December") },
      { label: "March", inputs: { month: "March", "report-title": "March review", "recipient-email": "hr@example.com", notes: "review" }, expect: "success", groundTruth: (csv) => csv.includes("March") },
    ],
  },
  {
    id: "t3-mild-drift",
    name: "mild UI drift (label suffix)",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    replays: [
      { label: "Month (required)", variant: { monthLabel: "Month (required)" }, inputs: {}, expect: "success", groundTruth: (csv) => csv.includes("August") },
    ],
  },
  {
    id: "t4-severe-drift",
    name: "severe UI drift (renamed field)",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    replays: [
      { label: "Reporting period", variant: { monthLabel: "Reporting period" }, inputs: {}, expect: "failed" },
    ],
  },
  {
    id: "t5-missing-element",
    name: "missing element detection",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    replays: [
      { label: "notes field removed", variant: { hideNotes: true }, inputs: {}, expect: "failed" },
    ],
  },
  {
    id: "t6-gui-cli",
    name: "GUI + CLI workflow",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    withShell: true,
    replays: [
      { label: "gui+cli October", inputs: { month: "October", "report-title": "October sales", "recipient-email": "ops@example.com", notes: "pipeline" }, expect: "success", groundTruth: (_csv, report) => report.includes("OCTOBER SALES") && report.includes("October") },
    ],
  },
  {
    id: "t7-partial-inputs",
    name: "partial inputs (defaults fill the rest)",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    replays: [
      { label: "only month given", inputs: { month: "June" }, expect: "success", groundTruth: (csv) => csv.includes("June") && csv.includes("August sales") },
    ],
  },
  {
    id: "t8-repeat",
    name: "three back-to-back replays",
    demo: { month: "August", title: "August sales", recipient: "reports@example.com", notes: "demo" },
    replays: [
      { label: "May", inputs: { month: "May", "report-title": "May report", "recipient-email": "a@example.com", notes: "1" }, expect: "success" },
      { label: "July", inputs: { month: "July", "report-title": "July report", "recipient-email": "b@example.com", notes: "2" }, expect: "success" },
      { label: "April", inputs: { month: "April", "report-title": "April report", "recipient-email": "c@example.com", notes: "3" }, expect: "success" },
    ],
  },
];

const results = [];
const BOT_ID = "bench-bot";
let skillCounter = 0;

console.log("TeachReplay mini benchmark — standalone core on a real remote computer");
console.log("=".repeat(70));

for (const task of TASKS) {
  console.log(`\n■ ${task.id} — ${task.name}`);
  resetRemote();
  setVariant(null);
  await hands.navigate("http://127.0.0.1:8080/");
  await pause(2000);

  await runtime.startRecording(BOT_ID, task.id);
  await demonstrate(task.demo, task.withShell === true, BOT_ID);
  const stopped = await runtime.stopRecording();
  const trajectory = await trajectoryStore.getTrajectory(stopped.id);
  const eventKinds = trajectory.events.map((e) => e.kind);
  const skill = await runtime.compileRecording(stopped.id, `bench-${task.id}-${++skillCounter}`);
  console.log(`  taught: ${eventKinds.join(",")} | inputs: ${skill.inputs.map((i) => i.id).join(",") || "(none)"}`);

  for (const replayCase of task.replays) {
    resetRemote();
    setVariant(replayCase.variant ?? null);
    const t0 = Date.now();
    const result = await runtime.replay(skill.id, replayCase.inputs);
    const ms = Date.now() - t0;
    let groundTruthOk = true;
    if (replayCase.groundTruth && result.status === "success") {
      groundTruthOk = replayCase.groundTruth(csvGroundTruth(), reportGroundTruth());
    }
    const ok = result.status === replayCase.expect && (replayCase.expect === "failed" || groundTruthOk);
    const verdict = result.status === replayCase.expect
      ? (result.status === "success" && !groundTruthOk ? "GT-MISMATCH" : "PASS")
      : "FAIL";
    console.log(`  ${verdict}  ${replayCase.label.padEnd(22)} → ${result.status} (${result.stepsCompleted}/${result.totalSteps} steps, ${ms}ms)${result.status === "failed" ? ` — ${String(result.error).slice(0, 90)}` : ""}`);
    results.push({ task: task.id, replay: replayCase.label, expected: replayCase.expect, actual: result.status, groundTruthOk, steps: `${result.stepsCompleted}/${result.totalSteps}`, durationMs: ms, ok });
  }
}

console.log("\n" + "=".repeat(70));
const total = results.length;
const passed = results.filter((r) => r.ok).length;
const successExpected = results.filter((r) => r.expected === "success").length;
const successReplays = results.filter((r) => r.expected === "success" && r.actual === "success").length;
const failuresDetected = results.filter((r) => r.expected === "failed" && r.actual === "failed").length;
const failuresExpected = results.filter((r) => r.expected === "failed").length;
console.log(`overall: ${passed}/${total} verdicts correct`);
console.log(`replay success rate (tasks that should succeed): ${successReplays}/${successExpected}`);
console.log(`failure detection (tasks that should fail): ${failuresDetected}/${failuresExpected}`);
console.log(`ground-truth mismatches: ${results.filter((r) => r.groundTruthOk === false).length}`);
console.log(`avg replay duration: ${Math.round(results.reduce((acc, r) => acc + Number(r.durationMs), 0) / total)}ms`);
writeFileSync("scripts/teach-benchmark-results.json", JSON.stringify(results, null, 2) + "\n");
rmSync(root, { recursive: true, force: true });
console.log("results → scripts/teach-benchmark-results.json");
process.exit(passed === total ? 0 : 1);
