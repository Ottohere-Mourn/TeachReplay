// The TeachReplay side of the DSH adapter is harness-agnostic and fully
// testable without DSH: the session runs the whole pipeline on the core.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MockComputer } from "@teachreplay/mock";

import { DshTeachSession } from "../src/session.js";

const dirs: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "dsh-teach-"));
  dirs.push(root);
  const computer = new MockComputer();
  const s = new DshTeachSession({
    dataDir: root,
    backend: { kind: "custom", create: () => computer },
    pollMs: 5,
  });
  return { s, computer };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DshTeachSession", () => {
  it("runs teach → compile → parameterized replay → verify on the core", async () => {
    const { s, computer } = session();
    await s.start("monthly report");
    const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
    await computer.fill("f-month", "August"); await pause();
    await computer.fill("f-title", "August sales"); await pause();
    await computer.fill("f-recipient", "reports@example.com"); await pause();
    await computer.click("b-submit"); await pause();
    await s.recordShell({ command: "process report", cwd: "/opt/teachreplay" });
    const stopped = await s.stop();
    expect(stopped).not.toBeNull();

    const skill = await s.compile("File monthly report");
    expect(skill.inputs.map((parameter) => parameter.id)).toEqual(["month", "report-title", "recipient-email"]);

    const result = await s.replay(skill.id, { month: "November", "report-title": "November sales", "recipient-email": "cfo@example.com" });
    expect(result.status).toBe("success");
    expect(computer.demoState().submitted.at(-1)!["f-month"]).toBe("November");
    expect((await s.listSkills())[0]).toMatchObject({ id: skill.id, name: "File monthly report" });
  });

  it("rejects concurrent recordings and compiling before a recording", async () => {
    const { s } = session();
    await s.start("one");
    await expect(s.start("two")).rejects.toThrow(/already in progress/);
    await s.cancel();
    await expect(s.compile()).rejects.toThrow(/nothing recorded/);
  });
});
