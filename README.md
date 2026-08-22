# TeachReplay Core

**The harness-agnostic Teach-by-Demonstration engine.**

```text
TeachReplay Core
Record → Compile → Replay → Verify
        |
   +----+----+
   |         |
OpenMausBot  DSH
 Adapter    Adapter
```

TeachReplay Core turns a human demonstration of a GUI/CLI workflow into a
structured, versioned trajectory, compiles it into a reusable
**parameterized skill** (demonstrated values become inputs with your values
as defaults), and replays it later with different inputs — ending in an
**explicit success or failure** every time.

It contains **no OpenMausBot dependency** (enforced by a test), and is the
engine behind both the OpenMausBot Teach Mode and the DeepSeek Harness
(DSH) adapter.

## Packages

| Package | Purpose |
| --- | --- |
| [`@teachreplay/core`](packages/core) | trajectory schema, recorder, parameterized skill compiler, parameter substitution, replay engine, verifier, file stores, `createTeachRuntime` orchestration |
| [`@teachreplay/remote`](packages/remote) | generic SSH Linux computer backend (Xvfb + Chrome DevTools) with GUI + shell channels — not AutoDL/Box-specific |
| [`@teachreplay/mock`](packages/mock) | deterministic in-memory demo computer for tests and local demos |
| [`@teachreplay/adapter-dsh`](packages/adapter-dsh) | DeepSeek Harness plugin registering `teach_*` tools (see its README for integration status) |

The OpenMausBot adapter lives in the [TeachReplay v0.1 repository](https://github.com/Ottohere-Mourn/TeachReplay)
(`server/teach/manager.ts` — a thin wrapper over `createTeachRuntime`).

## Core interfaces

```ts
// A computer Teach Mode can record against and replay through
interface ComputerBackend {
  readonly kind: string;
  snapshot(): Promise<ComputerSnapshot>;   // semantic: roles/names/values, never pixels-only
  navigate(url: string): Promise<void>;
  fill(ref: string, value: string): Promise<void>;
  click(ref: string): Promise<void>;
  text(): Promise<string>;
}

// The CLI half of GUI+CLI workflows
interface ShellBackend {
  exec(command: string, options?: { cwd?: string }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

type TeachBackend = ComputerBackend & ShellBackend;

// Persistence (file-based implementation included)
interface TrajectoryStore { saveTrajectory; getTrajectory; listTrajectories }
interface SkillStore { saveSkill; getSkill; listSkills; removeSkill }

// Optional model hooks — today: recovery proposals when a step's target
// cannot be found on the live page
interface ModelBackend { recover?(...): Promise<{ role: string; name?: string } | null> }
```

`createTeachRuntime({ backend, trajectoryStore, skillStore, model?, emit? })`
ties them together: `startRecording / stopRecording / cancelRecording /
recordShell / compileRecording / replay`. Adapters never duplicate core
logic — they only provide backends, stores, and event sinks.

## Standalone demo

No OpenMausBot, no harness, no network — just core + mock:

```sh
pnpm install
pnpm build
pnpm demo
```

```
■ 1 · start recording — the recorder begins watching
■ 2 · demonstrate — the person fills the report form while recording
■ 3 · compile — trajectory becomes a parameterized skill
   inputs: month="August", report-title="August sales", recipient-email="reports@example.com"
■ 4 · change parameters — replay with new inputs
   inputs: November / November sales / cfo@example.com
■ 5 · replay → verify
   status: SUCCESS — 6/6 steps
   verification: ok — page shows "…"
   ground truth on the computer: November / November sales / cfo@example.com
DEMO PASSED — teach once, replay with new inputs, verified.
```

## Tests and evaluation

```sh
pnpm typecheck   # all packages
pnpm test        # 50 tests: schema, recorder, compiler, replay, runtime,
                 # remote backend (fake ssh), DSH session, independence checks
```

`scripts/mini-benchmark.mjs` runs the 8-task / 14-replay evaluation
against a real remote Linux computer (SSH env-configured). The v0.1
results (14/14 verdicts, 12/12 replays, 2/2 failure detections, 0
ground-truth mismatches) live in the
[v0.1 repository](https://github.com/Ottohere-Mourn/TeachReplay/blob/main/scripts/teach-benchmark-results.json);
the ported benchmark is ready to re-run whenever a remote box is up.

## Licensing and attribution

Apache-2.0 (see [LICENSE](LICENSE)). TeachReplay Core was extracted from
TeachReplay v0.1, which was developed inside
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0) —
see [NOTICE](NOTICE) for the derived-work attributions, including the CDP
helper derived from OpenMausBot's computer-use tooling.
