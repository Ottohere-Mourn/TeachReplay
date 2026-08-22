// DshTeachSession — the TeachReplay-side half of the DSH adapter.
//
// Complete and harness-agnostic: owns one TeachReplay Core runtime with a
// computer backend and file stores, exposes the same Record → Compile →
// Replay → Verify lifecycle the OpenMausBot adapter uses. The DSH plugin
// (dsh-teach-plugin.ts) is a thin tool-registration shell over this.

import { homedir } from "node:os";
import { join } from "node:path";

import {
  createTeachRuntime,
  FileSkillStore,
  FileTrajectoryStore,
  type ModelBackend,
  type TeachBackend,
  type TeachRuntime,
} from "@teachreplay/core";
import { RemoteComputerBackend, type RemoteComputerConfig } from "@teachreplay/remote";

export interface DshTeachSessionOptions {
  /** Persistence root for trajectories + skills. */
  dataDir: string;
  /** SSH remote computer config, or a custom backend factory. */
  backend?:
    | { kind: "remote"; config: RemoteComputerConfig }
    | { kind: "custom"; create: () => TeachBackend };
  model?: ModelBackend;
  pollMs?: number;
}

/** `~` is never expanded by the OS for paths passed through code (only the
 * shell does that), so a bare "~/..." dataDir would otherwise create a
 * literal directory named "~" under the current working directory. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export class DshTeachSession {
  readonly trajectoryStore: FileTrajectoryStore;
  readonly skillStore: FileSkillStore;
  private readonly options: DshTeachSessionOptions;
  private runtimeInstance: TeachRuntime | null = null;
  private lastTrajectoryId: string | null = null;
  private recording = false;

  constructor(options: DshTeachSessionOptions) {
    this.options = options;
    const dataDir = expandHome(options.dataDir);
    this.trajectoryStore = new FileTrajectoryStore(dataDir);
    this.skillStore = new FileSkillStore(dataDir);
  }

  /** Lazy: a plugin with no backend configured yet (still to be patched in
   * via cordis.yml, or configured later) must still be able to load and
   * register its tools. Resolving the backend eagerly in the constructor
   * would make `apply()` throw before any tool registers — deferring it to
   * first use means only `teach_start` fails, with a clear error, exactly
   * when a backend is actually needed. */
  private get runtime(): TeachRuntime {
    if (!this.runtimeInstance) {
      const backend = this.resolveBackend(this.options);
      this.runtimeInstance = createTeachRuntime({
        backend,
        trajectoryStore: this.trajectoryStore,
        skillStore: this.skillStore,
        ...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
        ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      });
    }
    return this.runtimeInstance;
  }

  private resolveBackend(options: DshTeachSessionOptions): TeachBackend {
    if (options.backend?.kind === "remote") return new RemoteComputerBackend(options.backend.config);
    if (options.backend?.kind === "custom") return options.backend.create();
    throw new Error("dsh teach session needs a backend (remote SSH config or a custom factory)");
  }

  recordingStatus() {
    return this.recording ? this.runtime.recordingStatus() : null;
  }

  async start(name: string, botId = "dsh-session") {
    if (this.recording) throw new Error("a recording is already in progress");
    try {
      const status = await this.runtime.startRecording(botId, name);
      this.recording = true;
      return status;
    } catch (error) {
      this.recording = false;
      throw error;
    }
  }

  async stop() {
    this.recording = false;
    const summary = await this.runtime.stopRecording();
    if (summary) this.lastTrajectoryId = summary.id;
    return summary;
  }

  cancel() {
    this.recording = false;
    this.runtime.cancelRecording();
  }

  async recordShell(input: { command: string; cwd?: string }) {
    return this.runtime.recordShell("dsh-session", input);
  }

  async compile(name?: string) {
    if (!this.lastTrajectoryId) throw new Error("nothing recorded yet — teach a task first");
    return this.runtime.compileRecording(this.lastTrajectoryId, name);
  }

  async replay(skillId: string, inputs: Record<string, string>) {
    return this.runtime.replay(skillId, inputs);
  }

  async listSkills() {
    return this.skillStore.listSkills();
  }
}
