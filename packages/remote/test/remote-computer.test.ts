// RemoteComputerBackend tests against a fake ssh binary — verifies
// connection-argument building, CDP-helper invocation, screenshot
// capture, and shell execution without a real remote machine.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RemoteComputerBackend } from "../src/remote-computer.ts";

const FAKE_SSH = join(dirname(fileURLToPath(import.meta.url)), "./fake-ssh.ts");

function backend(overrides: Partial<ConstructorParameters<typeof RemoteComputerBackend>[0]> = {}) {
  return new RemoteComputerBackend({
    host: "fake-host.example",
    port: 2222,
    user: "root",
    keyFile: "/tmp/fake-key",
    sshCommand: process.execPath,
    sshExtraArgs: ["--experimental-strip-types", FAKE_SSH],
    ...overrides,
  });
}

describe("RemoteComputerBackend", () => {
  it("builds the ssh connection arguments", async () => {
    const remote = backend();
    const result = await (remote as any).run("echo FLAGS");
    expect(result.code).toBe(0);
    const args = JSON.parse(result.stdout) as string[];
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/fake-key");
    // the connection argv ends with user@host (the command rides as the
    // final argument after it)
    expect(args[args.length - 1]).toBe("root@fake-host.example");
  });

  it("parses semantic snapshots from the CDP helper", async () => {
    const remote = backend();
    const snapshot = await remote.snapshot();
    expect(snapshot.url).toBe("http://fake.local/report");
    expect(snapshot.elements.map((element) => element.name)).toEqual(["Month", "Report title", "Submit report"]);
  });

  it("routes fill/click/text through the CDP helper", async () => {
    const remote = backend();
    await expect(remote.fill("b1", "August")).resolves.toBeUndefined();
    await expect(remote.click("b3")).resolves.toBeUndefined();
    const text = await remote.text();
    expect(text).toBe("Fake page\nMonth: August");
  });

  it("captures screenshots as base64", async () => {
    const remote = backend();
    const shot = await remote.screenshotBase64();
    expect(shot).toMatch(/^iVBORw0KGgo/);
  });

  it("executes shell commands and reports exit codes", async () => {
    const remote = backend();
    const ok = await remote.exec("echo EXEC hello");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("ran:");
    const failed = await remote.exec("echo EXEC fails");
    expect(failed.exitCode).toBe(3);
    expect(failed.stderr).toBe("boom");
  });
});
