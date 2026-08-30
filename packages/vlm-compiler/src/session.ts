// Local, package-scoped data types for the screenshot capture path.
//
// @teachreplay/core's Trajectory/TeachEvent are pixel-free by design — see
// the header comment in packages/core/src/trajectory.ts. This package adds
// a screenshot + shell-log capture alternative to the AX-tree recorder, so
// its data shapes stay entirely local instead of growing core's schema.
import type { ShellBackend } from "@teachreplay/core";

/** Duck-typed capability a backend needs for this package: the existing
 * ShellBackend contract, plus a screenshot method. RemoteComputerBackend
 * (@teachreplay/remote) already has screenshotBase64() and satisfies this
 * structurally — no import of @teachreplay/remote is needed here. */
export interface VisualCaptureBackend extends ShellBackend {
  readonly kind: string;
  screenshotBase64(): Promise<string | null>;
}

export interface CapturedFrame {
  seq: number;
  at: number;
  /** Raw base64 PNG, no "data:" prefix. */
  imageBase64: string;
}

export interface CapturedShellEvent {
  at: number;
  command: string;
  cwd?: string;
  exitCode: number | null;
  /** Already redacted via redactSecretsInText before storage. */
  stdout: string;
  stderr: string;
}

export type VisualStopReason = "manual" | "cancelled" | "max-duration" | "max-frames";

export interface VisualSession {
  id: string;
  botId: string;
  name: string;
  app: string;
  /** The capturing backend's kind, e.g. "remote". */
  recordedVia: string;
  startedAt: number;
  finishedAt: number | null;
  stopReason: VisualStopReason | null;
  frames: CapturedFrame[];
  shellEvents: CapturedShellEvent[];
}
