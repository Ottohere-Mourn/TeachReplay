// Screenshot-interval capture — the visual counterpart to
// @teachreplay/core's AX-tree Recorder. Instead of diffing accessibility
// snapshots, this polls the backend's screenshot at a fixed interval and
// stores the raw frames for a VLM to interpret later (see compile.ts).
//
// Every sample here is an SSH round trip producing a base64 PNG that
// becomes billed VLM input tokens once sent — an order of magnitude more
// expensive per sample than a local accessibility read, hence the much
// slower default interval and the hard duration/frame caps below (core's
// Recorder has neither, because its 500ms poll is a cheap local read).
import { randomUUID } from "node:crypto";

import { redactSecretsInText } from "@teachreplay/core";

import type { CapturedFrame, CapturedShellEvent, VisualCaptureBackend, VisualSession, VisualStopReason } from "./session.js";

export interface FrameRecorderOptions {
  backend: VisualCaptureBackend;
  app?: string;
  /** Milliseconds between screenshots. Default 3000 — see file header. */
  intervalMs?: number;
  /** Hard wall-clock cap. Default 180_000 (3 min). */
  maxDurationMs?: number;
  /** Hard frame-count cap. Default 60 (redundant with the duration cap by
   * design: lowering intervalMs can't blow the frame budget, raising
   * maxFrames can't blow the wall-clock/API-spend budget). */
  maxFrames?: number;
  /** Skip appending a frame byte-identical to the previous one — cheap
   * protection against billing for a genuinely idle interval. Default true. */
  dedupeIdenticalFrames?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onFrame?: (frame: CapturedFrame) => void;
  /** Fires once when a hard cap auto-stops the recording. */
  onAutoStop?: (session: VisualSession) => void;
}

export interface VisualRecordingStatus {
  recording: boolean;
  botId: string;
  name: string;
  app: string;
  recordedVia: string;
  startedAt: number;
  frameCount: number;
  shellEventCount: number;
  elapsedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FrameRecorder {
  private readonly options: Required<Omit<FrameRecorderOptions, "onFrame" | "onAutoStop">> & {
    onFrame?: FrameRecorderOptions["onFrame"];
    onAutoStop?: FrameRecorderOptions["onAutoStop"];
  };
  private session: VisualSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private capturing = false;
  private lastFrameImage: string | null = null;
  private autoStopped = false;

  constructor(options: FrameRecorderOptions) {
    this.options = {
      backend: options.backend,
      app: options.app ?? "desktop",
      intervalMs: options.intervalMs ?? 3_000,
      maxDurationMs: options.maxDurationMs ?? 180_000,
      maxFrames: options.maxFrames ?? 60,
      dedupeIdenticalFrames: options.dedupeIdenticalFrames ?? true,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
      onFrame: options.onFrame,
      onAutoStop: options.onAutoStop,
    };
  }

  status(): VisualRecordingStatus | null {
    const session = this.session;
    if (!session) return null;
    return {
      recording: true,
      botId: session.botId,
      name: session.name,
      app: session.app,
      recordedVia: session.recordedVia,
      startedAt: session.startedAt,
      frameCount: session.frames.length,
      shellEventCount: session.shellEvents.length,
      elapsedMs: this.options.now() - session.startedAt,
    };
  }

  currentSession(): VisualSession | null {
    return this.session;
  }

  async start(botId: string, name: string): Promise<VisualRecordingStatus> {
    if (this.session) throw new Error("a visual recording is already in progress");
    const startedAt = this.options.now();
    this.session = {
      id: randomUUID(),
      botId,
      name: name.trim() || "Untitled demonstration",
      app: this.options.app,
      recordedVia: this.options.backend.kind,
      startedAt,
      finishedAt: null,
      stopReason: null,
      frames: [],
      shellEvents: [],
    };
    this.lastFrameImage = null;
    this.autoStopped = false;
    // One immediate capture so the first frame is in hand before the
    // interval loop starts; a transient failure must not kill the
    // recording before it begins.
    await this.captureNow().catch(() => {});
    this.timer = setInterval(() => void this.captureNow(), this.options.intervalMs);
    this.timer.unref?.();
    return this.status()!;
  }

  /** One screenshot capture. Exposed for tests; the interval loop calls it.
   * Also checks the hard caps and auto-stops when either is exceeded. */
  async captureNow(): Promise<void> {
    const session = this.session;
    if (!session || this.capturing || this.autoStopped) return;
    this.capturing = true;
    try {
      const at = this.options.now();
      if (at - session.startedAt >= this.options.maxDurationMs) {
        await this.autoStop("max-duration");
        return;
      }
      if (session.frames.length >= this.options.maxFrames) {
        await this.autoStop("max-frames");
        return;
      }
      const imageBase64 = await this.options.backend.screenshotBase64();
      if (imageBase64 == null) return;
      if (this.options.dedupeIdenticalFrames && imageBase64 === this.lastFrameImage) return;
      this.lastFrameImage = imageBase64;
      const frame: CapturedFrame = { seq: session.frames.length, at, imageBase64 };
      session.frames.push(frame);
      this.options.onFrame?.(frame);
      if (session.frames.length >= this.options.maxFrames) {
        await this.autoStop("max-frames");
      }
    } catch {
      // The computer may be asleep or mid-paint; the next capture retries.
    } finally {
      this.capturing = false;
    }
  }

  private async autoStop(reason: VisualStopReason): Promise<void> {
    if (this.autoStopped) return;
    this.autoStopped = true;
    const session = this.session;
    if (!session) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    session.finishedAt = this.options.now();
    session.stopReason = reason;
    this.options.onAutoStop?.(session);
  }

  /** Stop the recording and return the finalized session. Idempotent after
   * an auto-stop already finalized it — a caller-initiated stop() following
   * a cap never throws, it just returns what was already captured. */
  async stop(): Promise<VisualSession | null> {
    const session = this.session;
    if (!session) return null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (session.finishedAt == null) {
      session.finishedAt = this.options.now();
      session.stopReason = "manual";
    }
    this.session = null;
    this.autoStopped = false;
    return session;
  }

  cancel(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.session = null;
    this.autoStopped = false;
  }

  /** Record a shell command executed during the demonstration. The command
   * really runs on the computer (through backend.exec) so the recorded exit
   * code is real; output is redacted before storage — same contract as
   * @teachreplay/core's Recorder.recordShell. */
  async recordShell(input: { command: string; cwd?: string }): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("no visual recording in progress");
    const command = String(input.command ?? "").trim();
    if (!command) throw new Error("shell command must not be empty");
    const result = await this.options.backend.exec(command, input.cwd ? { cwd: input.cwd } : undefined);
    const event: CapturedShellEvent = {
      at: this.options.now(),
      command,
      ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
      exitCode: result.exitCode,
      stdout: redactSecretsInText(result.stdout).slice(-4_000),
      stderr: redactSecretsInText(result.stderr).slice(-2_000),
    };
    session.shellEvents.push(event);
  }
}
