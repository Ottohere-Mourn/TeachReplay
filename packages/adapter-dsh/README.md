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

- The TeachReplay side (session + tools) is complete and typechecked
  standalone against API shims extracted from
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  (MIT) at the 2026-08-22 master snapshot
  (`defineTool` + `ctx.tools.register` plugin pattern).
- DSH is in **developer preview with compatibility-breaking changes**, and
  its packages are `workspace:^` peers that resolve only inside the DSH
  workspace. To finish the wiring:

  1. Clone DSH and add this package to its pnpm workspace.
  2. Drop `src/dsh-types.ts` shims; import the real
     `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` types in
     `dsh-teach-plugin.ts`.
  3. Register the plugin: `dsh web --patch packages/adapter-dsh/cordis.yml`
     (or merge the insert into the shipped composition).
  4. Configure the computer: a remote SSH box via `TeachReplayConfig.remote`
     (see @teachreplay/remote), or pass a custom `TeachBackend` factory.
  5. Re-verify against each DSH release — the preview API drifts.
