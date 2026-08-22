// Generic SSH remote computer backend for Teach Mode.
//
// Any SSH-reachable Linux machine with the TeachReplay GUI stack becomes a
// recordable/replayable computer: an Xvfb virtual desktop, Chrome with
// loopback DevTools (port 9222), and the shared CDP helper
// (server/remote-computer.ts CDP_HELPER_SOURCE) for semantic
// snapshot/click/fill/text. Screenshots go through scrot; shell commands
// through the SSH channel — the CLI half of GUI+CLI workflows.
//
// Nothing here is provider-specific: the same backend drives a rented GPU box,
// box, a VPS, or an AWS instance. The Box cloud-computer backend stays
// untouched.
//
// Connection uses the system `ssh` CLI (key-based, BatchMode) so the
// existing OpenSSH config, agents, and known-hosts handling all apply.
import { spawn } from "node:child_process";

import { parseBrowserTargets, safeBrowserUrl, type BrowserTarget } from "./browser.js";
import type { ComputerSnapshot, TeachBackend } from "@teachreplay/core";

export interface RemoteComputerConfig {
  host: string;
  port?: number;
  user?: string;
  /** Private key file passed to `ssh -i`. */
  keyFile?: string;
  display?: string;
  debugPort?: number;
  /** Remote path of the deployed CDP helper. */
  helperPath?: string;
  /** Remote path for temporary screenshots. */
  shotPath?: string;
  chromeProfile?: string;
  /** Overridable for tests (a fake ssh binary). */
  sshCommand?: string;
  /** Extra leading argv for the ssh process (tests run the fake through
   * node --experimental-strip-types). */
  sshExtraArgs?: string[];
}

interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export class RemoteComputerBackend implements TeachBackend {
  readonly kind = "remote" as const;
  private readonly cfg: Required<Omit<RemoteComputerConfig, "sshCommand" | "keyFile" | "sshExtraArgs">> &
    Pick<RemoteComputerConfig, "sshCommand" | "keyFile" | "sshExtraArgs">;

  constructor(config: RemoteComputerConfig) {
    if (!config.host) throw new Error("remote computer needs a host");
    this.cfg = {
      host: config.host,
      port: config.port ?? 22,
      user: config.user ?? "root",
      keyFile: config.keyFile,
      display: config.display ?? ":99",
      debugPort: config.debugPort ?? 9222,
      helperPath: config.helperPath ?? "/opt/teachreplay/cdp.mjs",
      shotPath: config.shotPath ?? "/tmp/teachreplay-shot.png",
      chromeProfile: config.chromeProfile ?? "/opt/teachreplay/chrome-profile",
      sshCommand: config.sshCommand,
      sshExtraArgs: config.sshExtraArgs,
    };
  }

  private run(command: string, timeoutMs = 60_000): Promise<SshResult> {
    const args = [
      ...(this.cfg.sshExtraArgs ?? []),
      "-p", String(this.cfg.port),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `ConnectTimeout=${Math.max(5, Math.round(timeoutMs / 1000 / 4))}`,
      ...(this.cfg.keyFile ? ["-i", this.cfg.keyFile] : []),
      `${this.cfg.user}@${this.cfg.host}`,
      command,
    ];
    return new Promise((resolve) => {
      const child = spawn(this.cfg.sshCommand ?? "ssh", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: null, stdout, stderr: `${stderr}\n(ssh timed out after ${timeoutMs}ms)`.trim() });
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /** The CDP helper call, with the display exported so node and chrome
   * agree on the session. The helper path is per-deployment (the box
   * backend keeps its own /opt/ogb location). */
  private helper(action: "snapshot" | "click" | "fill" | "text" | "navigate", input: unknown, timeoutMs = 60_000): Promise<SshResult> {
    const encoded = Buffer.from(JSON.stringify(input ?? {})).toString("base64url");
    const command = [
      `export DISPLAY=${shellQuote(this.cfg.display)}`,
      `node ${shellQuote(this.cfg.helperPath)} ${action} ${shellQuote(encoded)}`,
    ].join("; ");
    return this.run(command, timeoutMs);
  }

  private async browserTargets(): Promise<BrowserTarget[]> {
    const out = await this.run("curl -sf --max-time 2 http://127.0.0.1:9222/json/list", 8_000);
    return out.code === 0 ? parseBrowserTargets(out.stdout) : [];
  }

  async snapshot(): Promise<ComputerSnapshot> {
    const out = await this.helper("snapshot", {}, 20_000);
    if (out.code === 0) {
      try {
        const parsed = JSON.parse(out.stdout) as {
          title: string;
          url: string;
          elements: Array<{ ref: string; role: string; name: string; disabled?: boolean; value?: string }>;
        };
        if (Array.isArray(parsed.elements) && typeof parsed.url === "string") {
          const text = await this.text();
          return {
            url: safeBrowserUrl(parsed.url) || parsed.url || null,
            title: String(parsed.title ?? "").slice(0, 200),
            text,
            elements: parsed.elements.map((element) => ({
              ref: String(element.ref ?? ""),
              role: String(element.role ?? ""),
              name: String(element.name ?? ""),
              disabled: element.disabled ? true : undefined,
              value: element.value,
            })),
          };
        }
      } catch {
        /* fall through to the degraded view */
      }
    }
    const targets = await this.browserTargets();
    const target = targets[0];
    return { url: target?.url ?? null, title: target?.title ?? "", text: "", elements: [] };
  }

  async navigate(url: string): Promise<void> {
    // Prefer navigating the existing Chrome tab (Page.navigate — no new
    // tabs, no focus races). Fall back to launching Chrome when no
    // debuggable page exists.
    const out = await this.helper("navigate", { url }, 30_000);
    if (out.code === 0) return;
    const command = [
      `export DISPLAY=${shellQuote(this.cfg.display)}`,
      `google-chrome --user-data-dir=${shellQuote(this.cfg.chromeProfile)} --password-store=basic --no-sandbox --no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=${this.cfg.debugPort} --window-size=1280,800 ${shellQuote(url)} >/dev/null 2>&1 &`,
    ].join("; ");
    const launch = await this.run(command, 30_000);
    if (launch.code !== 0) throw new Error(`could not open ${url}: ${launch.stderr.slice(0, 200)}`);
  }

  async fill(ref: string, value: string): Promise<void> {
    const out = await this.helper("fill", { ref, text: value }, 120_000);
    if (out.code !== 0) throw new Error(`fill failed: ${out.stderr.slice(0, 200)}`);
  }

  async click(ref: string): Promise<void> {
    const out = await this.helper("click", { ref }, 60_000);
    if (out.code !== 0) throw new Error(`click failed: ${out.stderr.slice(0, 200)}`);
  }

  async text(): Promise<string> {
    const out = await this.helper("text", {}, 20_000);
    if (out.code === 0) {
      try {
        const parsed = JSON.parse(out.stdout) as { ok?: boolean; text?: string };
        if (typeof parsed.text === "string") return parsed.text;
      } catch {
        /* older helper without the envelope — use the raw stdout */
      }
      if (out.stdout.trim()) return out.stdout.trim();
    }
    const targets = await this.browserTargets();
    return targets[0]?.title ?? "";
  }

  async exec(command: string, options?: { cwd?: string }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const prefix = options?.cwd ? `cd ${shellQuote(options.cwd)} && ` : "";
    const out = await this.run(`${prefix}${command}`, 120_000);
    return { exitCode: out.code, stdout: out.stdout, stderr: out.stderr };
  }

  /** Full-screen capture as base64 PNG — for evidence and future
   * vision-assisted steps. */
  async screenshotBase64(): Promise<string | null> {
    const out = await this.run(
      `export DISPLAY=${shellQuote(this.cfg.display)} && scrot -q 70 -o ${shellQuote(this.cfg.shotPath)} && base64 -w0 ${shellQuote(this.cfg.shotPath)}`,
      60_000,
    );
    if (out.code !== 0 || !out.stdout.trim()) return null;
    return out.stdout.trim();
  }
}
