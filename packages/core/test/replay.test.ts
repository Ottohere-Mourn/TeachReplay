import { describe, expect, it } from "vitest";

import { DONE_PAGE, MockComputer, REPORT_PAGE } from "@teachreplay/mock";
import { compileTrajectory } from "../src/compiler.ts";
import { replaySkill, type ReplayResult } from "../src/replay.ts";
import { TRAJECTORY_VERSION, type Trajectory } from "../src/trajectory.ts";

const SESSION = {
  kind: "session",
  startedAt: 1000,
  finishedAt: 2000,
  app: "openmausbot-demo-app",
  recordedVia: "mock",
} as const;

function demoSkill() {
  const trajectory: Trajectory = {
    schemaVersion: TRAJECTORY_VERSION,
    id: "t-1",
    botId: "bot-1",
    name: "report demo",
    app: "openmausbot-demo-app",
    recordedVia: "mock",
    createdAt: 1000,
    events: [
      SESSION,
      { kind: "navigate", at: 1100, url: REPORT_PAGE, title: "Monthly report" },
      { kind: "fill", at: 1200, ref: "f-month", role: "combobox", name: "Month", value: "August" },
      { kind: "fill", at: 1300, ref: "f-title", role: "textbox", name: "Report title", value: "August sales" },
      { kind: "fill", at: 1400, ref: "f-recipient", role: "textbox", name: "Recipient email", value: "reports@example.com" },
      { kind: "click", at: 1500, ref: "b-submit", role: "button", name: "Submit report" },
      { kind: "observe", at: 1600, url: DONE_PAGE, text: "Submission successful\nMonth: August" },
    ],
  };
  return compileTrajectory(trajectory, { now: () => 5000 });
}

async function replay(inputs: Record<string, string>, computer = new MockComputer()): Promise<{ result: ReplayResult; computer: MockComputer }> {
  const result = await replaySkill(demoSkill(), inputs, computer);
  return { result, computer };
}

describe("replaySkill", () => {
  it("replays a skill with substituted inputs and verifies success", async () => {
    const { result, computer } = await replay({ month: "October", "report-title": "October sales", "recipient-email": "billing@example.com" });
    expect(result.status).toBe("success");
    expect(result.stepsCompleted).toBe(result.totalSteps);
    expect(result.verification.ok).toBe(true);
    expect(result.verification.note).toContain("Submission successful");
    const submission = computer.demoState().submitted[0]!;
    expect(submission["f-month"]).toBe("October");
    expect(submission["f-title"]).toBe("October sales");
  });

  it("replays with demonstration defaults when no inputs are given", async () => {
    const { result, computer } = await replay({});
    expect(result.status).toBe("success");
    expect(computer.demoState().submitted[0]!["f-month"]).toBe("August");
  });

  it("fails explicitly when a required step cannot find its target", async () => {
    const computer = new MockComputer();
    // The month combobox is gone — replay must fail loudly, not guess.
    computer.perturb({ removeElement: { ref: "f-month" } });
    const { result } = await replay({}, computer);
    expect(result.status).toBe("failed");
    expect(result.stepsCompleted).toBeLessThan(result.totalSteps);
    expect(result.checks.some((check) => !check.ok && /could not find combobox/.test(check.note))).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it("recovers through the recovery hook when the UI drifted", async () => {
    const computer = new MockComputer();
    // The new label shares no substring with "Month", so semantic matching
    // alone cannot find it — only the recovery hook can.
    computer.perturb({ renameElement: { ref: "f-month", label: "Period selector" } });
    const result = await replaySkill(demoSkill(), {}, computer, {
      recover: async (step) => {
        if (step.match?.role === "combobox") return { role: "combobox", name: "Period selector" };
        return null;
      },
    });
    expect(result.status).toBe("success");
    expect(result.recovered).toBe(true);
    expect(computer.demoState().submitted[0]!["f-month"]).toBe("August");
  });

  it("fails when the success condition is not met even if steps ran", async () => {
    // A computer that accepts every action but never shows the confirmation
    // — the steps "complete" and the replay must still report failure.
    class LyingComputer extends MockComputer {
      override async snapshot() {
        const snapshot = await super.snapshot();
        return { ...snapshot, text: snapshot.text.replace("Submission successful", "Something went wrong") };
      }
    }
    const result = await replaySkill(demoSkill(), {}, new LyingComputer());
    expect(result.status).toBe("failed");
    expect(result.verification.ok).toBe(false);
    expect(result.verification.note).toContain("Something went wrong");
  });

  it("reports missing inputs without touching the computer", async () => {
    const skill = demoSkill();
    const broken = structuredClone(skill);
    broken.steps[1]!.value = "${not-declared}";
    const computer = new MockComputer();
    const result = await replaySkill(broken, {}, computer);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not-declared");
    expect(computer.demoState().submitted).toHaveLength(0);
  });

  it("reports failure when a step throws", async () => {
    const computer = new MockComputer();
    computer.perturb({ removeElement: { ref: "b-submit" } });
    const { result } = await replay({}, computer);
    expect(result.status).toBe("failed");
    expect(result.checks.some((check) => !check.ok)).toBe(true);
    expect(result.verification.ok).toBe(false);
  });
});

describe("shell step replay", () => {
  it("executes shell steps and verifies the exit code", async () => {
    const trajectory: Trajectory = {
      schemaVersion: TRAJECTORY_VERSION,
      id: "t-shell",
      botId: "bot-1",
      name: "shell demo",
      app: "openmausbot-demo-app",
      recordedVia: "mock",
      createdAt: 1000,
      events: [
        SESSION,
        { kind: "navigate", at: 1100, url: REPORT_PAGE },
        { kind: "fill", at: 1200, ref: "f-month", role: "combobox", name: "Month", value: "August" },
        { kind: "shell", at: 1300, command: "process report", exitCode: 0, stdout: "processed August" },
        { kind: "click", at: 1400, ref: "b-submit", role: "button", name: "Submit report" },
        { kind: "observe", at: 1500, url: DONE_PAGE, text: "Submission successful" },
      ],
    };
    const skill = compileTrajectory(trajectory, { now: () => 5000 });
    const result = await replaySkill(skill, {}, new MockComputer());
    expect(result.status).toBe("success");
    const shellCheck = result.checks.find((check) => /exit 0/.test(check.note));
    expect(shellCheck).toBeDefined();
  });

  it("fails explicitly when a shell step exits non-zero", async () => {
    class FailingShellComputer extends MockComputer {
      override async exec(command: string) {
        if (command.includes("broken")) return { exitCode: 2, stdout: "", stderr: "broken pipe" };
        return super.exec(command);
      }
    }
    const trajectory: Trajectory = {
      schemaVersion: TRAJECTORY_VERSION,
      id: "t-shell-fail",
      botId: "bot-1",
      name: "shell fail demo",
      app: "openmausbot-demo-app",
      recordedVia: "mock",
      createdAt: 1000,
      events: [
        SESSION,
        { kind: "navigate", at: 1100, url: REPORT_PAGE },
        { kind: "shell", at: 1200, command: "run broken command", exitCode: 0 },
        { kind: "observe", at: 1300, url: REPORT_PAGE, text: "Monthly report" },
      ],
    };
    const skill = compileTrajectory(trajectory, { now: () => 5000 });
    const result = await replaySkill(skill, {}, new FailingShellComputer());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exit 2");
  });
});
