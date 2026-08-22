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

Verified against **DeepSeek Harness `dsh-v0.1.1-rc.2`** (commit
`b150a551b8`) — plugin registration and all five tools exercised through
the real DSH tool runtime (`ctx.tools.execute`) in an official workspace
checkout.

> ⚠️ DSH is in **developer preview with compatibility-breaking changes**.
> Re-verify this adapter against every DSH release you adopt.

## Installation (source/workspace method)

DSH's sub-packages are `workspace:^` peers that resolve only inside the
DSH workspace (npm currently publishes only the `dsh` CLI bundle, not the
current sub-packages), so the supported installation is to add the
TeachReplay packages to the workspace:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout dsh-v0.1.1-rc.2

# copy the four packages into the workspace
mkdir -p packages/teachreplay
cp -r <teachreplay-checkout>/packages/{core,remote,mock} packages/teachreplay/
cp -r <teachreplay-checkout>/packages/adapter-dsh packages/teachreplay/adapter

pnpm install
pnpm exec tsc -b packages/teachreplay/adapter   # build check
pnpm exec vitest run packages/teachreplay/adapter/tests   # 3/3
```

Notes for the workspace copy:

- switch cross-deps to `workspace:*` (`@teachreplay/core`, `@teachreplay/remote`)
- the adapter imports the real `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools`
  APIs — replace the standalone type shims (`src/dsh-types.ts`) with the
  workspace types (see the integration checkout for the ready-made
  real-API `dsh-teach-plugin.ts`, `invariant.ts`, and spec)

A ready-made integration checkout with everything wired (plugin, invariant
companion, and the 3-test spec) is what this repository was verified with;
the upstream PR carries the same content.

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

Without a backend configured, tools register but `teach_start` fails with
a clear error — configure `remote` or a custom `TeachBackend` first.

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
