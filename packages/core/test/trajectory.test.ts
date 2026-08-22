import { describe, expect, it } from "vitest";

import {
  isMaskedValue,
  parseTrajectory,
  redactFillValue,
  SENSITIVE_VALUE,
  serializeTrajectory,
  TRAJECTORY_VERSION,
  type Trajectory,
} from "../src/trajectory.ts";

function trajectory(events: Trajectory["events"]): Trajectory {
  return {
    schemaVersion: TRAJECTORY_VERSION,
    id: "t-1",
    botId: "bot-1",
    name: "demo",
    app: "openmausbot-demo-app",
    recordedVia: "mock",
    createdAt: 1000,
    events,
  };
}

const SESSION = {
  kind: "session",
  startedAt: 1000,
  finishedAt: null,
  app: "openmausbot-demo-app",
  recordedVia: "mock",
} as const;

describe("trajectory schema", () => {
  it("round-trips through serialization", () => {
    const original = trajectory([
      SESSION,
      { kind: "navigate", at: 1100, url: "http://demo.local/report", title: "Monthly report" },
      { kind: "fill", at: 1200, ref: "f-month", role: "combobox", name: "Month", value: "August" },
      { kind: "click", at: 1300, ref: "b-submit", role: "button", name: "Submit report" },
      { kind: "observe", at: 1400, url: "http://demo.local/done", text: "Submission successful" },
    ]);
    const parsed = parseTrajectory(JSON.parse(serializeTrajectory(original)));
    expect(parsed).toEqual(original);
  });

  it("rejects an unsupported schema version", () => {
    const file = JSON.parse(serializeTrajectory(trajectory([SESSION])));
    file.trajectory.schemaVersion = 99;
    expect(() => parseTrajectory(file)).toThrow(/unsupported trajectory schema version/);
  });

  it("rejects a trajectory without a session event", () => {
    const file = JSON.parse(serializeTrajectory(trajectory([SESSION])));
    file.trajectory.events = [];
    expect(() => parseTrajectory(file)).toThrow(/session event/);
  });

  it("rejects malformed events", () => {
    const file = JSON.parse(serializeTrajectory(trajectory([SESSION])));
    file.trajectory.events.push({ kind: "navigate", at: "soon" });
    expect(() => parseTrajectory(file)).toThrow(/numeric at/);
  });

  it("rejects unknown event kinds", () => {
    const file = JSON.parse(serializeTrajectory(trajectory([SESSION])));
    file.trajectory.events.push({ kind: "teleport", at: 1 });
    expect(() => parseTrajectory(file)).toThrow(/unknown trajectory event kind/);
  });
});

describe("redaction", () => {
  it("rewrites credential-shaped values and reports it", () => {
    const result = redactFillValue("sk-ant-api03-ABCDEFGHIJKLMNOP1234567890");
    expect(result.redacted).toBe(true);
    expect(result.value).not.toContain("ABCDEFGH");
    expect(result.value).toContain("«redacted");
  });

  it("leaves ordinary values untouched", () => {
    const result = redactFillValue("August 2026 report");
    expect(result).toEqual({ value: "August 2026 report", redacted: false });
  });

  it("detects masked values the computer reports for password inputs", () => {
    expect(isMaskedValue("••••••")).toBe(true);
    expect(isMaskedValue("****")).toBe(true);
    expect(isMaskedValue("password123")).toBe(false);
    expect(isMaskedValue("")).toBe(false);
  });

  it("exposes the sensitive sentinel for masked fields", () => {
    expect(SENSITIVE_VALUE).toContain("masked");
  });
});
