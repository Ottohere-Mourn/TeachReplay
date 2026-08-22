// The DSH plugin half of the adapter: registers TeachReplay tools with
// the DeepSeek Harness. All logic lives in DshTeachSession + the core —
// this file only maps DSH tool calls onto the session and renders call
// cards. No core logic is duplicated here.
//
// Imports the real @deepseek-ai/cordis / @deepseek-ai/dsh-tools APIs
// (verified against dsh-v0.1.1-rc.2 / @deepseek-ai/dsh-tools@0.1.1-rc.2) —
// no local type shims.
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue } from "@deepseek-ai/dsh-session";

import { DshTeachSession, type DshTeachSessionOptions } from "./session.js";
import type { TeachBackend } from "@teachreplay/core";

export const name = "teachreplay";
export const inject = ["tools"];

export interface TeachReplayConfig {
  dataDir?: string;
  pollMs?: number;
  remote?: {
    host: string;
    port?: number;
    user?: string;
    keyFile?: string;
  };
  /** Bring your own computer backend (e.g. the mock demo computer, or a
   * DSH-provided ComputerBackend adapter). */
  backend?: { kind: "custom"; create: () => TeachBackend };
}

const textBlock = (text: string): ContentBlock[] => [{ type: "text", text }];

/** Round-trip through JSON so execute() results are JsonValue by
 * construction (skills, trajectories and replay results are all
 * JSON-serializable DTOs). */
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export function apply(ctx: Context, config: TeachReplayConfig = {}): void {
  const options: DshTeachSessionOptions = {
    dataDir: config.dataDir ?? "~/.dsh/teachreplay",
    ...(config.pollMs !== undefined ? { pollMs: config.pollMs } : {}),
  };
  if (config.remote) {
    options.backend = {
      kind: "remote",
      config: {
        host: config.remote.host,
        ...(config.remote.port !== undefined ? { port: config.remote.port } : {}),
        ...(config.remote.user !== undefined ? { user: config.remote.user } : {}),
        ...(config.remote.keyFile !== undefined ? { keyFile: config.remote.keyFile } : {}),
      },
    };
  } else if (config.backend) {
    options.backend = config.backend;
  }
  const session = new DshTeachSession(options);

  const start = defineTool({
    name: "teach_start",
    description:
      "Start recording a human demonstration on the configured computer. Every click, typed value, page change and shell command becomes part of a teachable trajectory. Call teach_stop when the demonstration is complete.",
    parameters: {
      name: { type: "string", required: true, description: "Short name for the task being taught." },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textBlock(JSON.stringify(value)),
    },
    execute: async (args) => {
      const status = await session.start(args.name);
      return asJson({ name: status.name, recordedVia: status.recordedVia, eventCount: status.eventCount });
    },
    presentCall: (args) => ({ card: "generic", title: `Teach: ${args.name}`, kind: "read", rawInput: args.name }),
  });

  const stop = defineTool({
    name: "teach_stop",
    description:
      "Stop the recording started by teach_start and persist the versioned trajectory. Returns the trajectory summary; pass its id to teach_compile.",
    parameters: {},
    output: {
      schema: { type: "json" },
      render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
    },
    execute: async () => {
      const summary = await session.stop();
      if (!summary) throw new Error("no recording in progress");
      return asJson(summary);
    },
    presentCall: () => ({ card: "generic", title: "Teach: stop recording", kind: "read", rawInput: "stop" }),
  });

  const compile = defineTool({
    name: "teach_compile",
    description:
      "Compile the most recent recorded trajectory into a reusable, parameterized skill. Demonstrated values become skill inputs with your values as defaults. Returns the skill definition; pass its id to teach_replay.",
    parameters: {
      name: { type: "string", description: "Optional name for the compiled skill." },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
    },
    execute: async (args) => {
      const skill = await session.compile(args.name);
      return asJson(skill);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Teach: compile skill${args.name !== undefined ? ` ${args.name}` : ""}`,
      kind: "read",
      rawInput: "compile",
    }),
  });

  const replay = defineTool({
    name: "teach_replay",
    description:
      "Replay a compiled skill with new inputs. Execution is deterministic — every step re-snapshots the computer, matches its target semantically, acts, and verifies the effect — and the result is an explicit success or failure with per-step checks.",
    parameters: {
      skillId: { type: "string", required: true, description: "Id of the compiled skill." },
      inputs: { type: "string", description: 'JSON object of parameter values, e.g. {"month":"October"}.' },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
    },
    execute: async (args) => {
      let inputs: Record<string, string> = {};
      if (typeof args.inputs === "string" && args.inputs.trim()) {
        const parsed: unknown = JSON.parse(args.inputs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          inputs = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
          );
        }
      }
      const result = await session.replay(args.skillId, inputs);
      return asJson(result);
    },
    presentCall: (args) => ({ card: "generic", title: `Teach: replay ${args.skillId.slice(0, 12)}`, kind: "read", rawInput: "replay" }),
  });

  const shell = defineTool({
    name: "teach_shell",
    description:
      "Record a shell command executed during an active demonstration — the CLI half of GUI+CLI workflows. The command runs for real on the recording computer and is stored with its real exit code.",
    parameters: {
      command: { type: "string", required: true, description: "The command to run and record." },
      cwd: { type: "string", description: "Working directory on the recording computer." },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
    },
    execute: async (args) => {
      await session.recordShell({
        command: args.command,
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      });
      return asJson({ recorded: true });
    },
    presentCall: (args) => ({ card: "generic", title: `Teach: shell ${args.command.slice(0, 60)}`, kind: "read", rawInput: args.command }),
  });

  ctx.tools.register(start);
  ctx.tools.register(stop);
  ctx.tools.register(compile);
  ctx.tools.register(replay);
  ctx.tools.register(shell);
}

export const plugin: Plugin.Object<TeachReplayConfig> = { name, inject, apply };
