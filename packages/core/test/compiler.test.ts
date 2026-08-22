import { describe, expect, it } from "vitest";

import {
  compileTrajectory,
  paramRef,
  renderSkillMarkdown,
  serializeSkill,
  skillReferencesAreValid,
  substituteSkill,
  urlsMatch,
  type Skill,
} from "../src/compiler.ts";
import { TRAJECTORY_VERSION, type Trajectory } from "../src/trajectory.ts";

function demoTrajectory(events: Trajectory["events"]): Trajectory {
  return {
    schemaVersion: TRAJECTORY_VERSION,
    id: "t-demo",
    botId: "bot-1",
    name: "report demo",
    app: "openmausbot-demo-app",
    recordedVia: "mock",
    createdAt: 1000,
    events,
  };
}

const SESSION = {
  kind: "session",
  startedAt: 1000,
  finishedAt: 2000,
  app: "openmausbot-demo-app",
  recordedVia: "mock",
} as const;

const REPORT_EVENTS: Trajectory["events"] = [
  SESSION,
  { kind: "navigate", at: 1100, url: "http://demo.local/report", title: "Monthly report" },
  { kind: "fill", at: 1200, ref: "f-month", role: "combobox", name: "Month", value: "August" },
  { kind: "fill", at: 1250, ref: "f-month", role: "combobox", name: "Month", value: "August" },
  { kind: "fill", at: 1300, ref: "f-title", role: "textbox", name: "Report title", value: "August sales" },
  { kind: "fill", at: 1400, ref: "f-recipient", role: "textbox", name: "Recipient email", value: "reports@example.com" },
  { kind: "click", at: 1500, ref: "b-submit", role: "button", name: "Submit report" },
  {
    kind: "observe",
    at: 1600,
    url: "http://demo.local/done",
    text: "Submission successful\nMonth: August\nTitle: August sales\nRecipient: reports@example.com",
  },
];

describe("compileTrajectory", () => {
  it("turns a demonstration into a parameterized skill", () => {
    const skill = compileTrajectory(demoTrajectory(REPORT_EVENTS), { now: () => 5000 });
    expect(skill.schemaVersion).toBe(1);
    expect(skill.sourceTrajectoryId).toBe("t-demo");
    expect(skill.inputs.map((parameter) => parameter.id)).toEqual(["month", "report-title", "recipient-email"]);
    expect(skill.inputs[0]!.default).toBe("August");

    const kinds = skill.steps.map((step) => step.kind);
    expect(kinds).toEqual(["navigate", "fill", "fill", "fill", "click"]);
    // The duplicate fill coalesced into one step.
    expect(skill.steps.filter((step) => step.kind === "fill")).toHaveLength(3);

    const monthStep = skill.steps[1]!;
    expect(monthStep.value).toBe(paramRef("month"));
    expect(monthStep.match).toEqual({ role: "combobox", name: "Month" });

    const clickStep = skill.steps[4]!;
    expect(clickStep.match).toEqual({ role: "button", name: "Submit report" });

    expect(skill.success.kind).toBe("text");
    // The stable confirmation heading is chosen over receipt lines that
    // embed demonstrated values.
    expect(skill.success.value).toBe("Submission successful");
    expect(skill.risks.some((risk) => /submit/i.test(risk))).toBe(true);
    expect(skillReferencesAreValid(skill)).toEqual([]);
  });

  it("excludes masked fields from replayable steps and flags the risk", () => {
    const trajectory = demoTrajectory([
      SESSION,
      { kind: "navigate", at: 1100, url: "http://demo.local/report" },
      { kind: "fill", at: 1200, ref: "f-secret", role: "textbox", name: "Access code", value: "«masked by the computer»", sensitive: true },
      { kind: "fill", at: 1300, ref: "f-title", role: "textbox", name: "Report title", value: "hello" },
      { kind: "observe", at: 1400, url: "http://demo.local/report", text: "Monthly report\nAccess code: «masked»\nReport title: hello" },
    ]);
    const skill = compileTrajectory(trajectory);
    expect(skill.steps.every((step) => step.match?.name !== "Access code")).toBe(true);
    expect(skill.inputs.map((parameter) => parameter.id)).not.toContain("access-code");
    expect(skill.risks.some((risk) => /Access code/i.test(risk))).toBe(true);
  });

  it("falls back to a URL success condition when there is no final text", () => {
    const trajectory = demoTrajectory([
      SESSION,
      { kind: "navigate", at: 1100, url: "http://demo.local/report" },
      { kind: "click", at: 1200, ref: "b-submit", role: "button", name: "Submit report" },
      { kind: "navigate", at: 1300, url: "http://demo.local/done", title: "Submission successful" },
    ]);
    const skill = compileTrajectory(trajectory);
    expect(skill.success.kind).toBe("url");
    expect(skill.success.value).toBe("http://demo.local/done");
  });

  it("rejects a trajectory with no replayable steps", () => {
    expect(() => compileTrajectory(demoTrajectory([SESSION]))).toThrow(/no replayable steps/);
  });

  it("serializes to a versioned file and renders readable markdown", () => {
    const skill = compileTrajectory(demoTrajectory(REPORT_EVENTS), { name: "Monthly report filing", now: () => 5000 });
    const file = JSON.parse(serializeSkill(skill));
    expect(file.version).toBe(1);
    expect(file.skill.name).toBe("Monthly report filing");
    const markdown = renderSkillMarkdown(skill);
    expect(markdown).toContain("# Monthly report filing");
    expect(markdown).toContain("Fill Month with ${month}");
    expect(markdown).toContain("Submit report");
    expect(markdown).toContain("Review before replay");
  });
});

describe("substituteSkill", () => {
  const skill = compileTrajectory(demoTrajectory(REPORT_EVENTS), { now: () => 5000 });

  it("substitutes new inputs into steps and the success condition", () => {
    const { steps, success, missing } = substituteSkill(skill, { month: "October" });
    expect(missing).toEqual([]);
    const monthStep = steps.find((step) => step.parameter === "month")!;
    expect(monthStep.value).toBe("October");
    // The stable success condition contains no parameters and stays as-is.
    expect(success.value).toBe("Submission successful");
    // Unsubstituted parameters keep their demonstrated defaults.
    expect(steps.find((step) => step.parameter === "report-title")!.value).toBe("August sales");
  });

  it("reports undeclared parameter references", () => {
    const broken: Skill = structuredClone(skill);
    broken.steps[1]!.value = "${does-not-exist}";
    const { missing } = substituteSkill(broken, {});
    expect(missing).toContain("does-not-exist");
  });
});

describe("urlsMatch", () => {
  it("ignores trailing slashes and credentials", () => {
    expect(urlsMatch("http://demo.local/done", "http://demo.local/done/")).toBe(true);
    expect(urlsMatch("http://user:pw@demo.local/done", "http://demo.local/done")).toBe(true);
    expect(urlsMatch("http://demo.local/done", "http://demo.local/report")).toBe(false);
  });
});

describe("shell step compilation", () => {
  it("compiles shell events into steps and parameterizes commands", () => {
    const trajectory = demoTrajectory([
      SESSION,
      { kind: "navigate", at: 1100, url: "http://demo.local/report" },
      { kind: "fill", at: 1200, ref: "f-month", role: "combobox", name: "Month", value: "August" },
      { kind: "shell", at: 1300, command: "python3 process.py --month August", cwd: "/opt/teachreplay", exitCode: 0, stdout: "processed" },
      { kind: "observe", at: 1400, url: "http://demo.local/report", text: "Processed report\nMonth: August" },
    ]);
    const skill = compileTrajectory(trajectory);
    const shell = skill.steps.find((step) => step.kind === "shell")!;
    expect(shell.command).toBe("python3 process.py --month ${month}");
    expect(shell.cwd).toBe("/opt/teachreplay");
    const { steps } = substituteSkill(skill, { month: "October" });
    expect(steps.find((step) => step.kind === "shell")!.command).toBe("python3 process.py --month October");
  });

  it("flags commands that failed during the demonstration", () => {
    const trajectory = demoTrajectory([
      SESSION,
      { kind: "navigate", at: 1100, url: "http://demo.local/report" },
      { kind: "fill", at: 1200, ref: "f-month", role: "combobox", name: "Month", value: "August" },
      { kind: "shell", at: 1300, command: "broken-cmd", exitCode: 2, stderr: "nope" },
      { kind: "observe", at: 1400, url: "http://demo.local/report", text: "Monthly report" },
    ]);
    const skill = compileTrajectory(trajectory);
    expect(skill.risks.some((risk) => /broken-cmd/.test(risk))).toBe(true);
  });
});
