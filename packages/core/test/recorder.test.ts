import { describe, expect, it } from "vitest";

import { MockComputer } from "@teachreplay/mock";
import { Recorder } from "../src/recorder.ts";
import { SENSITIVE_VALUE, type TeachEvent } from "../src/trajectory.ts";

describe("Recorder", () => {
  it("records a demonstration as semantic events", async () => {
    const computer = new MockComputer();
    const events: TeachEvent[] = [];
    const recorder = new Recorder({ backend: computer, pollMs: 60_000, onEvent: (event) => events.push(event) });
    await recorder.start("bot-1", "report demo");

    // Each demonstrated action lands between manual polls.
    await computer.navigate("http://demo.local/report");
    await recorder.pollOnce();
    await computer.fill("f-month", "August");
    await recorder.pollOnce();
    await computer.fill("f-title", "August sales");
    await recorder.pollOnce();
    await computer.click("b-submit");
    await recorder.pollOnce();

    const trajectory = await recorder.stop();
    expect(trajectory).not.toBeNull();
    const kinds = trajectory!.events.map((event) => event.kind);
    expect(kinds[0]).toBe("session");
    expect(kinds).toContain("navigate");
    expect(kinds.filter((kind) => kind === "fill")).toHaveLength(2);
    expect(kinds).toContain("click");
    expect(kinds).toContain("observe");

    const fill = trajectory!.events.find((event) => event.kind === "fill") as Extract<TeachEvent, { kind: "fill" }>;
    expect(fill.role).toBe("combobox");
    expect(fill.name).toBe("Month");
    expect(fill.value).toBe("August");
    const click = trajectory!.events.find((event) => event.kind === "click") as Extract<TeachEvent, { kind: "click" }>;
    expect(click.name).toBe("Submit report");
  });

  it("stores password-shaped fields without their value", async () => {
    const computer = new MockComputer();
    const recorder = new Recorder({ backend: computer, pollMs: 60_000 });
    await recorder.start("bot-1", "secret demo");
    await computer.fill("f-secret", "hunter2");
    await recorder.pollOnce();
    const trajectory = await recorder.stop();
    const fill = trajectory!.events.find((event) => event.kind === "fill" && event.ref === "f-secret") as
      | Extract<TeachEvent, { kind: "fill" }>
      | undefined;
    expect(fill).toBeDefined();
    expect(fill!.sensitive).toBe(true);
    expect(fill!.value).toBe(SENSITIVE_VALUE);
    expect(fill!.value).not.toContain("hunter2");
    expect(JSON.stringify(trajectory)).not.toContain("hunter2");
  });

  it("redacts credential-shaped values typed into ordinary fields", async () => {
    const computer = new MockComputer();
    const recorder = new Recorder({ backend: computer, pollMs: 60_000 });
    await recorder.start("bot-1", "key demo");
    await computer.fill("f-notes", "key: sk-ant-api03-ABCDEFGHIJKLMNOP1234567890");
    await recorder.pollOnce();
    const trajectory = await recorder.stop();
    const json = JSON.stringify(trajectory);
    expect(json).not.toContain("ABCDEFGH");
    expect(json).toContain("«redacted");
  });

  it("runs the poll loop automatically and reports status", async () => {
    const computer = new MockComputer();
    let now = 0;
    const recorder = new Recorder({
      backend: computer,
      pollMs: 10,
      now: () => ++now,
      sleep: () => Promise.resolve(),
    });
    const status = await recorder.start("bot-1", "loop demo");
    expect(status.recording).toBe(true);
    expect(status.recordedVia).toBe("mock");
    await computer.fill("f-title", "typed while polling");
    // Let the interval fire several times.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const trajectory = await recorder.stop();
    expect(trajectory!.events.some((event) => event.kind === "fill" && event.value === "typed while polling")).toBe(true);
    expect(recorder.status()).toBeNull();
  });

  it("does not record clicks for elements that merely appear and vanish", async () => {
    // A field value change must never be mistaken for a click.
    const computer = new MockComputer();
    const recorder = new Recorder({ backend: computer, pollMs: 60_000 });
    await recorder.start("bot-1", "no click demo");
    await computer.fill("f-month", "September");
    await recorder.pollOnce();
    const trajectory = await recorder.stop();
    expect(trajectory!.events.filter((event) => event.kind === "click")).toHaveLength(0);
  });
});

describe("Recorder shell events", () => {
  it("records a real shell command with its exit code", async () => {
    const computer = new MockComputer();
    const recorder = new Recorder({ backend: computer, pollMs: 60_000 });
    await recorder.start("bot-1", "shell demo");
    await recorder.recordShell({ command: "process report", cwd: "/opt/teachreplay" });
    const trajectory = await recorder.stop();
    const shell = trajectory!.events.find((event) => event.kind === "shell") as Extract<TeachEvent, { kind: "shell" }>;
    expect(shell.command).toBe("process report");
    expect(shell.cwd).toBe("/opt/teachreplay");
    expect(shell.exitCode).toBe(0);
  });

  it("redacts secrets from shell output", async () => {
    class LeakyComputer extends MockComputer {
      override async exec() {
        return { exitCode: 0, stdout: "token sk-ant-api03-ABCDEFGHIJKLMNOP1234567890 leaked", stderr: "" };
      }
    }
    const recorder = new Recorder({ backend: new LeakyComputer(), pollMs: 60_000 });
    await recorder.start("bot-1", "leak demo");
    await recorder.recordShell({ command: "cat secrets" });
    const trajectory = await recorder.stop();
    const json = JSON.stringify(trajectory);
    expect(json).not.toContain("ABCDEFGH");
    expect(json).toContain("«redacted");
  });

  it("refuses to record when no recording is active", async () => {
    const recorder = new Recorder({ backend: new MockComputer(), pollMs: 60_000 });
    await expect(recorder.recordShell({ command: "ls" })).rejects.toThrow(/no recording in progress/);
  });
});

describe("Recorder vanish confirmation", () => {
  class ScriptedBackend extends MockComputer {
    script: Array<() => Promise<void>> = [];
    override async snapshot() {
      const next = this.script.shift();
      if (next) await next();
      return super.snapshot();
    }
  }

  it("ignores a clickable that vanishes for only one poll (page reload)", async () => {
    const computer = new ScriptedBackend();
    const recorder = new Recorder({ backend: computer, pollMs: 60_000 });
    await recorder.start("bot-1", "reload demo");
    // Poll 1: button present. Poll 2: everything gone (reload blank).
    // Poll 3: button back — no click may be recorded.
    computer.script.push(async () => {
      computer.perturb({ removeElement: { ref: "b-submit" } });
    });
    await recorder.pollOnce();
    computer.reset();
    await recorder.pollOnce();
    const trajectory = await recorder.stop();
    expect(trajectory!.events.filter((event) => event.kind === "click")).toHaveLength(0);
  });

  it("records a click when the element stays gone for two polls", async () => {
    const computer = new ScriptedBackend();
    const recorder = new Recorder({ backend: computer, pollMs: 60_000 });
    await recorder.start("bot-1", "modal demo");
    computer.perturb({ removeElement: { ref: "b-submit" } });
    await recorder.pollOnce();
    await recorder.pollOnce();
    const trajectory = await recorder.stop();
    const clicks = trajectory!.events.filter((event) => event.kind === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ name: "Submit report" });
  });
});
