// TeachReplay Core — the harness-agnostic Teach-by-Demonstration engine:
// Record → Compile → Replay → Verify.
//
// Zero OpenMausBot (or any other harness) dependencies: adapters provide
// a TeachBackend, stores, and optional model hooks; everything below is
// pure TeachReplay logic.
export {
  isMaskedValue,
  newTrajectoryId,
  parseTrajectory,
  redactFillValue,
  SENSITIVE_VALUE,
  serializeTrajectory,
  TRAJECTORY_VERSION,
  type TeachEvent,
  type Trajectory,
  type TrajectoryFile,
} from "./trajectory.js";
export { redactSecretsInText } from "./redact.js";
export {
  findElement,
  normalizeComparisonUrl,
  type ComputerBackend,
  type ComputerElement,
  type ComputerSnapshot,
  type ShellBackend,
  type TeachBackend,
  type TeachComputerBackend,
} from "./computer.js";
export {
  Recorder,
  type RecorderOptions,
  type RecordingStatus,
} from "./recorder.js";
export {
  compileTrajectory,
  paramRef,
  parameterIdFor,
  parseSkill,
  renderSkillMarkdown,
  serializeSkill,
  skillReferencesAreValid,
  substituteSkill,
  urlsMatch,
  SKILL_VERSION,
  type Skill,
  type SkillFile,
  type SkillParameter,
  type SkillStep,
  type SkillSuccess,
} from "./compiler.js";
export {
  replaySkill,
  verifySkillOutcome,
  type ReplayCheck,
  type ReplayOptions,
  type ReplayResult,
  type ReplayStatus,
} from "./replay.js";
export {
  FileSkillStore,
  FileTrajectoryStore,
  type SkillStore,
  type SkillSummary,
  type TrajectoryStore,
  type TrajectorySummary,
} from "./stores.js";
export {
  createTeachRuntime,
  type ModelBackend,
  type RecoveryBackend,
  type TeachRuntime,
  type TeachRuntimeOptions,
} from "./runtime.js";
