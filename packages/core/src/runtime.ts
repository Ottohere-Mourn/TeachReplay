// TeachRuntime — the harness-agnostic orchestration every adapter shares:
// Record → Compile → Replay → Verify. Adapters provide a backend, stores,
// and optional model-assisted recovery + an event sink; everything else
// (recorder lifecycle, persistence, compilation, replay) lives here, so
// no adapter duplicates core logic.
import { compileTrajectory, skillReferencesAreValid, type Skill } from "./compiler.js";
import { Recorder, type RecordingStatus } from "./recorder.js";
import { replaySkill, type ReplayResult } from "./replay.js";
import type { TrajectoryStore, SkillStore, TrajectorySummary } from "./stores.js";
import type { ComputerSnapshot, TeachBackend } from "./computer.js";
import type { Trajectory } from "./trajectory.js";

/** Optional model hooks. Today only recovery: when a replay step cannot
 * find its target, the model inspects the live page and may propose an
 * alternative semantic match. */
export interface ModelBackend {
  recover?: (
    skill: Skill,
    step: { kind: string; match?: { role: string; name?: string }; description: string },
    snapshot: ComputerSnapshot,
  ) => Promise<{ role: string; name?: string } | null>;
}

export interface RecoveryBackend {
  recover: NonNullable<ModelBackend["recover"]>;
}

export interface TeachRuntimeOptions {
  backend: TeachBackend;
  trajectoryStore: TrajectoryStore;
  skillStore: SkillStore;
  model?: ModelBackend;
  /** Event sink for lifecycle frames ({ kind, … }). Adapters map these
   * onto their own buses (SSE, logs, …). */
  emit?: (payload: Record<string, unknown>) => void;
  pollMs?: number;
  now?: () => number;
  app?: string;
}

export interface TeachRuntime {
  readonly backend: TeachBackend;
  recordingStatus(): RecordingStatus | null;
  startRecording(botId: string, name: string): Promise<RecordingStatus>;
  stopRecording(): Promise<TrajectorySummary | null>;
  cancelRecording(): void;
  recordShell(botId: string, input: { command: string; cwd?: string }): Promise<void>;
  currentTrajectory(botId: string): Trajectory | null;
  compileLastRecording(botId: string, name?: string): Promise<Skill>;
  compileRecording(trajectoryId: string, name?: string): Promise<Skill>;
  replay(skillId: string, inputs: Record<string, string>): Promise<ReplayResult>;
}

export function createTeachRuntime(options: TeachRuntimeOptions): TeachRuntime {
  const { backend, trajectoryStore, skillStore, model, emit } = options;
  const app = options.app ?? (backend.kind === "mock" ? "demo-app" : "chrome");
  let recorder: Recorder | null = null;
  let recordingBotId: string | null = null;
  let lastTrajectory: Trajectory | null = null;

  const trajectorySummary = (trajectory: Trajectory): TrajectorySummary => ({
    id: trajectory.id,
    name: trajectory.name,
    botId: trajectory.botId,
    app: trajectory.app,
    recordedVia: trajectory.recordedVia,
    createdAt: trajectory.createdAt,
    eventCount: trajectory.events.length,
  });

  return {
    backend,

    recordingStatus: () => recorder?.status() ?? null,

    async startRecording(botId, name) {
      if (recorder) throw new Error("a recording is already in progress");
      const next = new Recorder({
        backend,
        app,
        pollMs: options.pollMs,
        now: options.now,
        onEvent: (event) => emit?.({ kind: "teach.event", botId, event }),
      });
      const status = await next.start(botId, name);
      recorder = next;
      recordingBotId = botId;
      emit?.({ kind: "teach.recording", botId, recording: status });
      return status;
    },

    async stopRecording() {
      if (!recorder) return null;
      const trajectory = await recorder.stop();
      const botId = recordingBotId;
      recorder = null;
      recordingBotId = null;
      if (!trajectory) return null;
      await trajectoryStore.saveTrajectory(trajectory);
      lastTrajectory = trajectory;
      emit?.({ kind: "teach.recording.stopped", botId, trajectory: trajectorySummary(trajectory) });
      return trajectorySummary(trajectory);
    },

    cancelRecording() {
      if (!recorder) return;
      const botId = recordingBotId;
      recorder.cancel();
      recorder = null;
      recordingBotId = null;
      emit?.({ kind: "teach.recording.cancelled", botId });
    },

    async recordShell(botId, input) {
      if (recordingBotId !== botId || !recorder) {
        throw Object.assign(new Error("no recording in progress for this bot"), { status: 409 });
      }
      await recorder.recordShell(input);
    },

    currentTrajectory(botId) {
      if (recordingBotId !== botId || !recorder) return null;
      return recorder.currentTrajectory();
    },

    async compileLastRecording(botId, name) {
      const trajectory = recordingBotId === botId ? recorder?.currentTrajectory() ?? null : lastTrajectory;
      if (!trajectory) throw new Error("nothing recorded yet — teach a task first");
      return this.compileRecording(trajectory.id, name);
    },

    async compileRecording(trajectoryId, name) {
      const trajectory = await trajectoryStore.getTrajectory(trajectoryId);
      if (!trajectory) throw new Error("no such recording");
      const skill = compileTrajectory(trajectory, { name, now: options.now });
      const problems = skillReferencesAreValid(skill);
      if (problems.length) throw new Error(`compiled skill is invalid: ${problems.join("; ")}`);
      await skillStore.saveSkill(skill);
      emit?.({ kind: "teach.skill", botId: skill.botId, skill });
      return skill;
    },

    async replay(skillId, inputs) {
      const entry = await skillStore.getSkill(skillId);
      if (!entry) throw Object.assign(new Error("no such skill"), { status: 404 });
      const result = await replaySkill(entry.skill, inputs ?? {}, backend, {
        now: options.now,
        recover: model?.recover
          ? (step, snapshot) => model.recover!(entry.skill, step, snapshot)
          : undefined,
      });
      emit?.({ kind: "teach.replay", skillId, botId: entry.skill.botId, result });
      return result;
    },
  };
}
