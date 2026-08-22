// The Teach Mode recorder.
//
// While the person demonstrates on the bot's computer, the recorder polls
// the computer's SEMANTIC state (page URL, visible text, element roles and
// values) and diffs successive snapshots into trajectory events:
//
//   URL changed                          → navigate
//   element value changed                → fill   (redacted on the way in)
//   clickable element disappeared        → click  (it did something)
//   checkbox/radio/switch toggled        → click
//   visible text changed                 → observe (verification material)
//
// Input events themselves are never observed — the recorder only sees the
// state the demonstration leaves behind, which is exactly what replay must
// reproduce. Password-shaped fields are stored without their value.
import { redactSecretsInText } from "./redact.js";
import type { ComputerSnapshot, TeachComputerBackend } from "./computer.js";
import {
  isMaskedValue,
  newTrajectoryId,
  redactFillValue,
  SENSITIVE_VALUE,
  TRAJECTORY_VERSION,
  type TeachEvent,
  type Trajectory,
} from "./trajectory.js";

const CLICKABLE_ROLES = new Set([
  "button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option",
]);

export interface RecorderOptions {
  backend: TeachComputerBackend;
  /** Application being recorded, e.g. "chrome". */
  app?: string;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Fires for every event as it is recorded (SSE + tests). */
  onEvent?: (event: TeachEvent) => void;
}

export interface RecordingStatus {
  recording: boolean;
  botId: string;
  name: string;
  app: string;
  recordedVia: string;
  startedAt: number;
  eventCount: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Recorder {
  private readonly options: Required<Omit<RecorderOptions, "onEvent">> & Pick<RecorderOptions, "onEvent">;
  private baseline: ComputerSnapshot | null = null;
  private trajectory: Trajectory | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** A clickable element seen vanishing last poll. Only becomes a click
   * when it is STILL gone on the next poll — a page reload makes every
   * element vanish for exactly one poll and must not record clicks. */
  private pendingVanish: { ref: string; role: string; name: string; checked?: boolean } | null = null;

  constructor(options: RecorderOptions) {
    this.options = {
      backend: options.backend,
      app: options.app ?? "chrome",
      pollMs: options.pollMs ?? 500,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
      onEvent: options.onEvent,
    };
  }

  status(): RecordingStatus | null {
    if (!this.trajectory) return null;
    return {
      recording: true,
      botId: this.trajectory.botId,
      name: this.trajectory.name,
      app: this.trajectory.app,
      recordedVia: this.trajectory.recordedVia,
      startedAt: this.trajectory.createdAt,
      eventCount: this.trajectory.events.length,
    };
  }

  /** Live view of the in-progress trajectory (never mutated by callers). */
  currentTrajectory(): Trajectory | null {
    return this.trajectory;
  }

  async start(botId: string, name: string): Promise<RecordingStatus> {
    if (this.trajectory) throw new Error("a recording is already in progress");
    this.baseline = null;
    this.trajectory = {
      schemaVersion: TRAJECTORY_VERSION,
      id: newTrajectoryId(),
      botId,
      name: name.trim() || "Untitled demonstration",
      app: this.options.app,
      recordedVia: this.options.backend.kind,
      createdAt: this.options.now(),
      events: [],
    };
    this.emit({
      kind: "session",
      startedAt: this.trajectory.createdAt,
      finishedAt: null,
      app: this.options.app,
      recordedVia: this.options.backend.kind,
    });
    // One immediate poll so the first snapshot is captured before the loop;
    // transient failures must not kill the recording before it starts.
    await this.pollOnce().catch(() => {});
    this.timer = setInterval(() => void this.pollOnce(), this.options.pollMs);
    this.timer.unref?.();
    return this.status()!;
  }

  async stop(): Promise<Trajectory | null> {
    const trajectory = this.trajectory;
    if (!trajectory) return null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Capture the final state, then close the session event.
    await this.pollOnce().catch(() => {});
    const session = trajectory.events[0];
    if (session?.kind === "session") {
      session.finishedAt = this.options.now();
      this.options.onEvent?.(session);
    }
    this.trajectory = null;
    this.baseline = null;
    return trajectory;
  }

  cancel(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.trajectory = null;
    this.baseline = null;
  }

  /** Record a shell command executed during the demonstration — the CLI
   * half of GUI+CLI workflows. The command really runs on the computer
   * (through backend.exec) so the recorded exit code is real. Output is
   * redacted before storage. */
  async recordShell(input: { command: string; cwd?: string }): Promise<void> {
    if (!this.trajectory) throw new Error("no recording in progress");
    const command = String(input.command ?? "").trim();
    if (!command) throw new Error("shell command must not be empty");
    const result = await this.options.backend.exec(command, input.cwd ? { cwd: input.cwd } : undefined);
    this.emit({
      kind: "shell",
      at: this.options.now(),
      command,
      cwd: input.cwd?.trim() || undefined,
      exitCode: result.exitCode,
      stdout: redactSecretsInText(result.stdout).slice(-4_000),
      stderr: redactSecretsInText(result.stderr).slice(-2_000),
    });
  }

  /** One snapshot diff. Exposed for tests; the interval loop calls it. */
  async pollOnce(): Promise<void> {
    if (!this.trajectory || this.polling) return;
    this.polling = true;
    try {
      const snapshot = await this.options.backend.snapshot();
      this.diff(snapshot);
    } catch {
      // The computer may be asleep or mid-paint; the next poll retries.
    } finally {
      this.polling = false;
    }
  }

  private diff(snapshot: ComputerSnapshot): void {
    const baseline = this.baseline;
    this.baseline = snapshot;
    if (!baseline) {
      if (snapshot.url) this.emit({ kind: "navigate", at: this.options.now(), url: snapshot.url, title: snapshot.title });
      if (snapshot.text) this.emitObserve(snapshot);
      return;
    }
    const urlChanged = snapshot.url !== baseline.url;
    // A blank snapshot is a page load/reload transition, not a state to
    // diff — diffing it records phantom clicks (everything "vanished")
    // and loses fill baselines. Navigation and text still track.
    if (snapshot.elements.length === 0) {
      this.pendingVanish = null;
      if (urlChanged && snapshot.url) {
        this.emit({ kind: "navigate", at: this.options.now(), url: snapshot.url, title: snapshot.title });
      }
      if (snapshot.text !== baseline.text) this.emitObserve(snapshot);
      return;
    }
    const previous = new Map(baseline.elements.map((element) => [element.ref, element]));
    const current = new Map(snapshot.elements.map((element) => [element.ref, element]));
    if (urlChanged) {
      // A wholesale navigation replaces every element ref, so "vanished"
      // alone proves nothing. Attribute the navigation to a click only when
      // exactly ONE button/link disappeared — the common submit case. Zero
      // means the URL was typed; several means ambiguous, record neither.
      const navTriggers = [...previous.values()].filter(
        (element) => !current.has(element.ref) && ["button", "link"].includes(element.role.toLowerCase()),
      );
      if (navTriggers.length === 1) {
        const trigger = navTriggers[0]!;
        this.emit({ kind: "click", at: this.options.now(), ref: trigger.ref, role: trigger.role, name: trigger.name });
      }
      if (snapshot.url) this.emit({ kind: "navigate", at: this.options.now(), url: snapshot.url, title: snapshot.title });
      this.emitObserve(snapshot);
      return;
    }
    // Clicked things disappear (a submit button that stays on the page) or
    // toggle (a checkbox). Two guards against phantom clicks:
    //   1. a disappearance must survive TWO polls (a reload blanks the
    //      page for exactly one);
    //   2. "disappeared" means the (role, name) pair is gone — a page
    //      reload renumbers every AX ref, so the same button with a fresh
    //      ref is a re-render, not a click.
    const sameNamed = (role: string, name: string) =>
      [...current.values()].some(
        (element) =>
          element.role.toLowerCase() === role.toLowerCase() &&
          element.name.trim().toLowerCase() === name.trim().toLowerCase(),
      );
    if (this.pendingVanish) {
      const pending = this.pendingVanish;
      if (!current.has(pending.ref) && !sameNamed(pending.role, pending.name)) {
        this.emit({ kind: "click", at: this.options.now(), ref: pending.ref, role: pending.role, name: pending.name, checked: pending.checked });
      }
      this.pendingVanish = null;
    }
    for (const [ref, before] of previous) {
      const after = current.get(ref);
      if (!after) {
        if (CLICKABLE_ROLES.has(before.role.toLowerCase()) && !this.pendingVanish && !sameNamed(before.role, before.name)) {
          this.pendingVanish = { ref, role: before.role, name: before.name, checked: before.checked };
        }
        continue;
      }
      if (before.checked !== undefined && after.checked !== before.checked) {
        this.emit({ kind: "click", at: this.options.now(), ref, role: after.role, name: after.name, checked: before.checked });
      }
    }
    for (const [ref, after] of current) {
      const before = previous.get(ref);
      const beforeValue = before?.value ?? "";
      const afterValue = after.value ?? "";
      if (!before || beforeValue === afterValue) continue;
      if (after.sensitive || isMaskedValue(afterValue)) {
        this.emit({ kind: "fill", at: this.options.now(), ref, role: after.role, name: after.name, value: SENSITIVE_VALUE, sensitive: true });
        continue;
      }
      const { value, redacted } = redactFillValue(afterValue);
      this.emit({
        kind: "fill",
        at: this.options.now(),
        ref,
        role: after.role,
        name: after.name,
        value,
        redacted: redacted ? true : undefined,
      });
    }
    if (snapshot.text !== baseline.text) {
      this.emitObserve(snapshot);
    }
  }

  /** Observe events carry the whole visible page text, which can include
   * whatever the person typed into a normal field — run the same content
   * redaction the transcript uses before the text is stored or streamed. */
  private emitObserve(snapshot: ComputerSnapshot): void {
    this.emit({
      kind: "observe",
      at: this.options.now(),
      url: snapshot.url,
      text: redactSecretsInText(snapshot.text),
    });
  }

  private emit(event: TeachEvent): void {
    this.trajectory!.events.push(event);
    this.options.onEvent?.(event);
  }
}
