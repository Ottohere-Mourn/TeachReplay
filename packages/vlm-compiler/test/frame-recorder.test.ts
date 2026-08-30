import { describe, expect, it } from "vitest";

import { FrameRecorder } from "../src/frame-recorder.js";
import type { VisualCaptureBackend, VisualSession } from "../src/session.js";

function fakeBackend(images: Array<string | null>): VisualCaptureBackend & { execCalls: string[] } {
  let index = 0;
  return {
    kind: "fake",
    execCalls: [],
    async screenshotBase64() {
      const image = images[Math.min(index, images.length - 1)] ?? null;
      index += 1;
      return image;
    },
    async exec(command: string) {
      (this as unknown as { execCalls: string[] }).execCalls.push(command);
      return { exitCode: 0, stdout: `ran ${command}`, stderr: "" };
    },
  };
}

describe("FrameRecorder", () => {
  it("captures frames on demand and reports status", async () => {
    const backend = fakeBackend(["frame-1", "frame-2", "frame-3"]);
    const recorder = new FrameRecorder({ backend, intervalMs: 60_000 });
    await recorder.start("bot-1", "demo task");
    await recorder.captureNow();
    await recorder.captureNow();
    const status = recorder.status()!;
    expect(status.recording).toBe(true);
    expect(status.frameCount).toBe(3); // one immediate capture on start() + two explicit calls
    const session = await recorder.stop();
    expect(session!.stopReason).toBe("manual");
    expect(session!.frames.map((frame) => frame.imageBase64)).toEqual(["frame-1", "frame-2", "frame-3"]);
  });

  it("dedupes an identical consecutive frame by default", async () => {
    const backend = fakeBackend(["same", "same", "different"]);
    const recorder = new FrameRecorder({ backend, intervalMs: 60_000 });
    await recorder.start("bot-1", "demo task");
    await recorder.captureNow();
    await recorder.captureNow();
    const session = await recorder.stop();
    expect(session!.frames.map((frame) => frame.imageBase64)).toEqual(["same", "different"]);
  });

  it("does not dedupe when dedupeIdenticalFrames is false", async () => {
    const backend = fakeBackend(["same", "same"]);
    const recorder = new FrameRecorder({ backend, intervalMs: 60_000, dedupeIdenticalFrames: false });
    await recorder.start("bot-1", "demo task");
    await recorder.captureNow();
    const session = await recorder.stop();
    expect(session!.frames).toHaveLength(2);
  });

  it("records a shell command with redaction and a real exit code", async () => {
    const backend = fakeBackend(["frame-1"]);
    const recorder = new FrameRecorder({ backend, intervalMs: 60_000 });
    await recorder.start("bot-1", "demo task");
    await recorder.recordShell({ command: "echo hi" });
    const session = await recorder.stop();
    expect(session!.shellEvents).toHaveLength(1);
    expect(session!.shellEvents[0]!.exitCode).toBe(0);
    expect(backend.execCalls).toEqual(["echo hi"]);
  });

  it("auto-stops on maxFrames and makes a later stop() idempotent", async () => {
    const backend = fakeBackend(["a", "b", "c", "d"]);
    let autoStopped: VisualSession | null = null;
    const recorder = new FrameRecorder({
      backend,
      intervalMs: 60_000,
      dedupeIdenticalFrames: false,
      maxFrames: 2,
      onAutoStop: (session) => (autoStopped = session),
    });
    await recorder.start("bot-1", "demo task"); // 1 frame from the initial capture
    await recorder.captureNow(); // 2nd frame -> hits maxFrames, auto-stops
    await recorder.captureNow(); // no-op, already auto-stopped
    expect(autoStopped).not.toBeNull();
    expect(autoStopped!.stopReason).toBe("max-frames");
    expect(autoStopped!.frames).toHaveLength(2);
    const stopped = await recorder.stop();
    expect(stopped).toBe(autoStopped);
  });

  it("auto-stops on maxDurationMs", async () => {
    let now = 0;
    const backend = fakeBackend(["a", "b", "c"]);
    let autoStopped: VisualSession | null = null;
    const recorder = new FrameRecorder({
      backend,
      intervalMs: 60_000,
      dedupeIdenticalFrames: false,
      maxDurationMs: 100,
      now: () => now,
      onAutoStop: (session) => (autoStopped = session),
    });
    await recorder.start("bot-1", "demo task");
    now = 200;
    await recorder.captureNow();
    expect(autoStopped).not.toBeNull();
    expect(autoStopped!.stopReason).toBe("max-duration");
  });

  it("cancel() discards the in-progress session", async () => {
    const backend = fakeBackend(["a"]);
    const recorder = new FrameRecorder({ backend, intervalMs: 60_000 });
    await recorder.start("bot-1", "demo task");
    recorder.cancel();
    expect(recorder.currentSession()).toBeNull();
    expect(recorder.status()).toBeNull();
  });

  it("rejects a second start() while a recording is in progress", async () => {
    const backend = fakeBackend(["a"]);
    const recorder = new FrameRecorder({ backend, intervalMs: 60_000 });
    await recorder.start("bot-1", "demo task");
    await expect(recorder.start("bot-1", "again")).rejects.toThrow(/already in progress/);
  });
});
