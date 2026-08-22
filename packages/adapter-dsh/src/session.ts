// DshTeachSession — the TeachReplay-side half of the DSH adapter.
//
// Complete and harness-agnostic: owns one TeachReplay Core runtime with a
// computer backend and file stores, exposes the same Record → Compile →
// Replay → Verify lifecycle the OpenMausBot adapter uses. The DSH plugin
// (dsh-teach-plugin.ts) is a thin tool-registration shell over this.

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

export class DshTeachSession {
  readonly runtime: TeachRuntime;
  readonly trajectoryStore: FileTrajectoryStore;
  readonly skillStore: FileSkillStore;
  private lastTrajectoryId: string | null = null;
  private recording = false;

  constructor(options: DshTeachSessionOptions) {
    this.trajectoryStore = new FileTrajectoryStore(options.dataDir);
    this.skillStore = new FileSkillStore(options.dataDir);
    const backend = this.resolveBackend(options);
    this.runtime = createTeachRuntime({
      backend,
      trajectoryStore: this.trajectoryStore,
      skillStore: this.skillStore,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
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
