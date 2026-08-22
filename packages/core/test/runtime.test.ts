// TeachRuntime + file stores: the orchestration both adapters share.
// Uses only core + mock — no harness.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MockComputer } from "@teachreplay/mock";

import { createTeachRuntime } from "../src/runtime.js";
import { FileSkillStore, FileTrajectoryStore } from "../src/stores.js";

const dirs: string[] = [];

function harness(computer = new MockComputer()) {
  const root = mkdtempSync(join(tmpdir(), "tr-core-"));
  dirs.push(root);
  const emitted: unknown[] = [];
  const runtime = createTeachRuntime({
    backend: computer,
    trajectoryStore: new FileTrajectoryStore(root),
    skillStore: new FileSkillStore(root),
    pollMs: 5,
    now: () => 1000,
    emit: (payload) => emitted.push(payload),
  });
  return { root, runtime, emitted, computer };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function demonstrate(computer: MockComputer) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
  await computer.fill("f-month", "August");
  await pause();
  await computer.fill("f-title", "August sales");
  await pause();
  await computer.fill("f-recipient", "reports@example.com");
  await pause();
  await computer.click("b-submit");
  await pause();
}

describe("TeachRuntime", () => {
  it("runs record → compile → parameterized replay → verify with only core+mock", async () => {
    const { root, runtime, computer, emitted } = harness();
    await runtime.startRecording("bot-1", "report demo");
    await demonstrate(computer);
    const stopped = await runtime.stopRecording();
    expect(stopped).not.toBeNull();
    expect(runtime.recordingStatus()).toBeNull();

    const skill = await runtime.compileRecording(stopped!.id, "File monthly report");
    expect(skill.inputs.map((parameter) => parameter.id)).toEqual(["month", "report-title", "recipient-email"]);

    const result = await runtime.replay(skill.id, {
      month: "November",
      "report-title": "November sales",
      "recipient-email": "cfo@example.com",
    });
    expect(result.status).toBe("success");
    expect(result.verification.ok).toBe(true);
    expect(computer.demoState().submitted.at(-1)!["f-month"]).toBe("November");

    // persisted forms survive a fresh runtime over the same stores
    const fresh = new MockComputer();
    const second = createTeachRuntime({
      backend: fresh,
      trajectoryStore: new FileTrajectoryStore(root),
      skillStore: new FileSkillStore(root),
    });
    const restored = await second.replay(skill.id, {});
    expect(restored.status).toBe("success");

    const kinds = emitted.map((frame) => (frame as Record<string, string>).kind);
    expect(kinds).toContain("teach.recording");
    expect(kinds).toContain("teach.recording.stopped");
    expect(kinds).toContain("teach.skill");
    expect(kinds).toContain("teach.replay");
  });

  it("records shell commands with real exit codes", async () => {
    const { root, runtime } = harness();
    await runtime.startRecording("bot-1", "shell demo");
    await runtime.recordShell("bot-1", { command: "process report", cwd: "/opt/teachreplay" });
    const stopped = await runtime.stopRecording();
    const trajectory = await new FileTrajectoryStore(root).getTrajectory(stopped!.id);
    const shell = trajectory!.events.find((event) => event.kind === "shell");
    expect(shell).toMatchObject({ command: "process report", cwd: "/opt/teachreplay", exitCode: 0 });
  });

  it("rejects replay of an unknown skill with status 404", async () => {
    const { runtime } = harness();
    await expect(runtime.replay("no-such-skill", {})).rejects.toMatchObject({ status: 404 });
  });
});

function dirAt(offset: number): string {
  return dirs[dirs.length + offset]!;
}
