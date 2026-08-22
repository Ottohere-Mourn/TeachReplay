# @teachreplay/adapter-dsh

DeepSeek Harness (DSH) adapter for TeachReplay Core — the same
Record → Compile → Replay → Verify engine as the OpenMausBot adapter,
registered as DSH tools:

| Tool | Purpose |
| --- | --- |
| `teach_start` | start recording a human demonstration on the configured computer |
| `teach_stop` | stop and persist the versioned trajectory |
| `teach_compile` | compile the trajectory into a parameterized skill |
| `teach_replay` | replay the skill with new inputs; explicit success/failure |
| `teach_shell` | record a shell command during the demonstration (GUI+CLI) |

No core logic is duplicated: `DshTeachSession` owns one TeachReplay Core
runtime; the plugin only maps DSH tool calls onto it.

## Status and integration notes

**Verified inside the real DSH workspace** (2026-08-22, release
`dsh-0.1.1-rc.2`, commit `b150a551b8`):

- the package builds as part of the DSH workspace (`tsc -b`,
  registered in the host aggregate under `packages/teachreplay/*`)
- the plugin loads in a real Cordis context with the real
  `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` APIs
  (the real-API plugin lives in the integration checkout; this
  standalone copy ships API shims so it still typechecks outside DSH)
- integration spec (`tests/teachreplay.spec.ts` in the integration
  checkout) runs the minimal **Teach → Compile → Replay → Verify
  through real `ctx.tools.execute` dispatch** — 6/6 replay steps,
  parameter substitution, explicit verification — 3/3 passing

To reproduce the integration: clone
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
copy `packages/teachreplay/*` into its workspace, import the real types
instead of the shims (see the integration checkout's
`packages/teachreplay/adapter/src/dsh-teach-plugin.ts`), and run
`vitest run packages/teachreplay/adapter/tests`.

- DSH is in **developer preview with compatibility-breaking changes** —
  re-verify against each release.
- Deployment: register via `dsh web --patch cordis.yml`; configure a
  remote SSH computer via `TeachReplayConfig.remote` (see
  @teachreplay/remote) or a custom `TeachBackend` factory.
