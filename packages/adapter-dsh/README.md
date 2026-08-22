# @teachreplay/adapter-dsh

**TeachReplay for DeepSeek Harness** — teach-by-demonstration tools for DSH agents.

Registers five tools backed by the TeachReplay Core (the same
`Record → Compile → Replay → Verify` engine as the OpenMausBot adapter —
no core logic duplicated):

| Tool | Purpose |
| --- | --- |
| `teach_start` | start recording a human demonstration on the configured computer |
| `teach_stop` | stop and persist the versioned trajectory |
| `teach_compile` | compile the trajectory into a reusable, parameterized skill |
| `teach_replay` | replay the skill with new inputs; explicit success/failure |
| `teach_shell` | record a shell command during the demonstration (GUI+CLI workflows) |

## What this adds to DSH

An agent gains a memory of workflows: a person demonstrates a task once
(fills a form, submits, runs a shell command), and the agent can later
re-run the same workflow with different parameters — deterministically,
with per-step verification, on real GUI+CLI computers.

## Supported version

Targets the real `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` plugin API
directly — no type shims. Verified two ways against **DeepSeek Harness
`dsh-v0.1.1-rc.2`** (commit `b150a551b8`):

- **In this package's own build**: `@deepseek-ai/cordis@4.0.1` /
  `@deepseek-ai/dsh-tools@0.1.1-rc.2` — the exact pair DSH resolves at that
  tag — are `devDependencies` here, so `pnpm build`/`pnpm typecheck` in this
  repo compile `dsh-teach-plugin.ts` against the real `defineTool` and
  `Plugin.Object` types, not a stand-in. A registration probe against a
  guard replicating the real `ToolRuntime.register()` (which requires every
  tool to declare `output: { schema, render }`) confirms all five tools
  pass.
- **Inside a full DSH workspace checkout**: plugin registration and all five
  tools exercised through the real DSH tool runtime (`ctx.tools.execute`) —
  see the verification fork linked below.

> ⚠️ DSH is in **developer preview with compatibility-breaking changes**.
> Re-verify this adapter — and the pinned `@deepseek-ai/*` versions above —
> against every DSH release you adopt.

## Installation

`@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are `peerDependencies`
(`>=4.0.1` / `>=0.1.1-rc.2`) — this package expects the host DSH install to
provide them, the same way a React component library expects `react` as a
peer rather than bundling its own copy. DSH's sub-packages are published to
npm under the `next` dist-tag while DSH is in developer preview (`latest`
trails behind; pin the `next` version matching your DSH release).

```sh
pnpm add @teachreplay/adapter-dsh
```

Building from source inside a full DSH workspace checkout (e.g. to test
against an unreleased DSH commit) still works — copy `packages/{core,mock,
remote,adapter-dsh}` into the workspace as `packages/teachreplay/*`, switch
the four packages' cross-deps to `workspace:*`, and adjust each copied
package's `tsconfig.json` `extends` path by one level (`packages/<name>` →
`packages/teachreplay/<name>` moves it one directory deeper, so
`"../../tsconfig.base.json"` must become `"../../../tsconfig.base.json"` to
keep resolving to the repo root).

**Upstream contribution status**: DeepSeek Harness's own `CONTRIBUTING.md`
states the project does not accept external pull requests while in
developer preview, and points contributors toward publishing independent
plugins instead (tagged with the `dsh-plugin` GitHub topic) rather than
merging into the harness repository — this is stated project policy, not a
temporarily-disabled API. A verification fork,
`Ottohere-Mourn/deepseek-harness` (`integrations/teachreplay-plugin`),
holds an earlier snapshot of this plugin verified inside a full DSH
workspace, for reference:

https://github.com/deepseek-ai/deepseek-harness/compare/master...Ottohere-Mourn:integrations/teachreplay-plugin

## Configuration (`cordis.yml`)

```yaml
# patch the shipped web composition
- insert:
    - id: teachreplay
      name: '@teachreplay/adapter-dsh'
      config:
        dataDir: '~/.dsh/teachreplay'
        # optional remote computer (any SSH Linux box with the TeachReplay
        # GUI stack — see @teachreplay/remote)
        # remote:
        #   host: <remote-host>
        #   user: root
        #   keyFile: '~/.ssh/your_key'
        # or a custom backend factory:
        # backend: { kind: 'custom', create: () => myComputerBackend }
```

Run: `dsh web --patch cordis.yml`

Without a backend configured, `apply()` still registers all five tools —
the backend is only resolved on first use, so `teach_start` is the one that
fails, with a clear error, if `remote` or a custom `backend` isn't set by
then.

`dataDir` accepts a leading `~` (expanded against the real home directory,
not a literal `~` folder under the process's working directory).

## Minimal example (through the session, no DSH needed)

```js
import { DshTeachSession } from '@teachreplay/adapter-dsh'
import { MockComputer } from '@teachreplay/mock'

const computer = new MockComputer()
const session = new DshTeachSession({
  dataDir: '/tmp/teachreplay-demo',
  backend: { kind: 'custom', create: () => computer },
  pollMs: 20,
})

await session.start('monthly report filing')        // teach_start
await computer.fill('f-month', 'August')            // demonstrate …
await computer.fill('f-title', 'August sales')
await computer.fill('f-recipient', 'reports@example.com')
await computer.click('b-submit')
await session.stop()                                // teach_stop
const skill = await session.compile('File monthly report')  // teach_compile
const result = await session.replay(skill.id, {     // teach_replay
  month: 'November', 'report-title': 'November sales', 'recipient-email': 'cfo@example.com',
})
console.log(result.status)                          // 'success', verified
```

See [`examples/dsh-demo`](../../examples/dsh-demo) for the runnable version.
