// Versioned trajectory schema for Teach-by-Demonstration recordings.
//
// A trajectory holds the SEMANTIC events observed while a person
// demonstrated a workflow on a bot's computer. Raw pixels are never part
// of the schema: events reference element roles/names/selectors and page
// state, so a recorded workflow stays replayable when the exact page
// layout changes. Recorded values pass through the same redaction pass
// used for transcripts, and fields that the computer
// itself reports as masked (e.g. password inputs) are stored without
// their value at all.
import { randomUUID } from "node:crypto";

import { redactSecretsInText } from "./redact.js";

export const TRAJECTORY_VERSION = 1 as const;

/** Field value the computer reports already masked (a password input) —
 * never stored verbatim, and never offered as a skill parameter. */
export const SENSITIVE_VALUE = "«masked by the computer»" as const;

export type TeachEvent =
  | {
      kind: "session";
      startedAt: number;
      finishedAt: number | null;
      app: string;
      /** Which computer was observed: the cloud box, the local demo
       * computer, or an SSH remote computer. */
      recordedVia: string;
    }
  | { kind: "navigate"; at: number; url: string; title?: string }
  | {
      kind: "fill";
      at: number;
      ref: string;
      role: string;
      name: string;
      value: string;
      /** True when the computer reports the value masked (password inputs). */
      sensitive?: boolean;
      /** True when redaction rewrote the stored value. */
      redacted?: boolean;
    }
  | {
      kind: "click";
      at: number;
      ref: string;
      role: string;
      name: string;
      /** Element state before the click (checkboxes/radios/switches). */
      checked?: boolean;
    }
  | { kind: "observe"; at: number; url: string | null; text: string }
  | { kind: "press"; at: number; keys: string }
  /** A shell command executed on the computer during the demonstration —
   * the CLI half of GUI+CLI workflows. Recorded at execution time with
   * the real exit code, never inferred from pixels. */
  | {
      kind: "shell";
      at: number;
      command: string;
      cwd?: string;
      exitCode: number | null;
      stdout?: string;
      stderr?: string;
    };

export interface Trajectory {
  schemaVersion: typeof TRAJECTORY_VERSION;
  id: string;
  botId: string;
  name: string;
  app: string;
  recordedVia: string;
  createdAt: number;
  events: TeachEvent[];
}

export interface TrajectoryFile {
  version: 1;
  trajectory: Trajectory;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eventFrom(raw: unknown): TeachEvent {
  check(raw && typeof raw === "object", "trajectory event must be an object");
  const event = raw as Record<string, unknown>;
  check(isString(event.kind), "trajectory event needs a kind");
  if (event.kind !== "session") {
    const at = Number(event.at);
    check(Number.isFinite(at), `trajectory event "${event.kind}" needs a numeric at`);
  }
  const at = Number(event.at);
  switch (event.kind) {
    case "session":
      check(isString(event.app), "session event needs an app");
      check(typeof event.recordedVia === "string" && Boolean(event.recordedVia), "session event needs recordedVia");
      return {
        kind: "session",
        startedAt: Number(event.startedAt),
        finishedAt: event.finishedAt == null ? null : Number(event.finishedAt),
        app: event.app,
        recordedVia: event.recordedVia,
      };
    case "navigate":
      check(isString(event.url), "navigate event needs a url");
      return { kind: "navigate", at, url: event.url, ...(isString(event.title) ? { title: event.title } : {}) };
    case "fill":
      check(isString(event.value), "fill event needs a value");
      return {
        kind: "fill",
        at,
        ref: String(event.ref ?? ""),
        role: String(event.role ?? ""),
        name: String(event.name ?? ""),
        value: event.value,
        ...(event.sensitive === true ? { sensitive: true as const } : {}),
        ...(event.redacted === true ? { redacted: true as const } : {}),
      };
    case "click":
      return {
        kind: "click",
        at,
        ref: String(event.ref ?? ""),
        role: String(event.role ?? ""),
        name: String(event.name ?? ""),
        ...(typeof event.checked === "boolean" ? { checked: event.checked } : {}),
      };
    case "observe":
      check(isString(event.text), "observe event needs text");
      return { kind: "observe", at, url: isString(event.url) ? event.url : null, text: event.text };
    case "press":
      check(isString(event.keys), "press event needs keys");
      return { kind: "press", at, keys: event.keys };
    case "shell":
      check(isString(event.command) && event.command, "shell event needs a command");
      return {
        kind: "shell",
        at,
        command: event.command,
        ...(isString(event.cwd) && event.cwd ? { cwd: event.cwd } : {}),
        exitCode: event.exitCode == null ? null : Number(event.exitCode),
        ...(isString(event.stdout) ? { stdout: event.stdout } : {}),
        ...(isString(event.stderr) ? { stderr: event.stderr } : {}),
      };
    default:
      throw new Error(`unknown trajectory event kind "${event.kind}"`);
  }
}

/** Strict validation on load: a hand-edited or corrupted file must fail
 * loudly instead of silently replaying a different workflow. Accepts the
 * persisted file shape `{ version, trajectory }`. */
export function parseTrajectory(value: unknown): Trajectory {
  check(value && typeof value === "object", "trajectory file must be an object");
  const file = value as Record<string, unknown>;
  check(file.version === 1, `unsupported trajectory file version "${String(file.version)}"`);
  const raw = file.trajectory;
  check(raw && typeof raw === "object", "trajectory file must contain a trajectory");
  const data = raw as Record<string, unknown>;
  check(data.schemaVersion === TRAJECTORY_VERSION, `unsupported trajectory schema version "${String(data.schemaVersion)}"`);
  check(isString(data.id) && data.id, "trajectory needs an id");
  check(isString(data.botId), "trajectory needs a botId");
  check(isString(data.name), "trajectory needs a name");
  check(isString(data.app), "trajectory needs an app");
  check(typeof data.recordedVia === "string" && Boolean(data.recordedVia), "trajectory needs recordedVia");
  check(Number.isFinite(Number(data.createdAt)), "trajectory needs a createdAt");
  check(Array.isArray(data.events), "trajectory needs events");
  const trajectory: Trajectory = {
    schemaVersion: TRAJECTORY_VERSION,
    id: data.id,
    botId: data.botId,
    name: data.name,
    app: data.app,
    recordedVia: data.recordedVia,
    createdAt: Number(data.createdAt),
    events: data.events.map(eventFrom),
  };
  check(
    trajectory.events.some((event) => event.kind === "session"),
    "trajectory needs a session event",
  );
  return trajectory;
}

export function serializeTrajectory(trajectory: Trajectory): string {
  return JSON.stringify({ version: 1, trajectory } satisfies TrajectoryFile, null, 2);
}

/** Record a fill value, redacting credential-shaped content. Returns the
 * stored value plus whether redaction changed it. */
export function redactFillValue(value: string): { value: string; redacted: boolean } {
  const redacted = redactSecretsInText(value);
  return { value: redacted, redacted: redacted !== value };
}

/** A value the computer already reports masked (bullet characters only):
 * the recorder never saw the real text, so the trajectory records the
 * field as sensitive and stores no value. */
export function isMaskedValue(value: string): boolean {
  return value.length > 0 && /^[•*●•\s]+$/.test(value.trim());
}

/** Trajectory id generator, separated so tests can pin ids if needed. */
export const newTrajectoryId = () => randomUUID();
