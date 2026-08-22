// The DSH plugin half of the adapter: registers TeachReplay tools with
// the DeepSeek Harness. All logic lives in DshTeachSession + the core —
// this file only maps DSH tool calls onto the session and renders call
// cards. No core logic is duplicated here.
import { DshTeachSession, type DshTeachSessionOptions } from "./session.js";
import { defineTool, type DshContext, type DshPlugin } from "./dsh-types.js";

export const name = "teachreplay";
export const inject = ["tools"];

export interface TeachReplayConfig {
  dataDir?: string;
  remote?: {
    host: string;
    port?: number;
    user?: string;
    keyFile?: string;
  };
}

export function apply(ctx: DshContext, config: TeachReplayConfig = {}): void {
  const dataDir = config.dataDir ?? "~/.dsh/teachreplay";
  const options: DshTeachSessionOptions = { dataDir };
  if (config.remote) {
    options.backend = {
      kind: "remote",
      config: {
        host: config.remote.host,
        port: config.remote.port,
        user: config.remote.user,
        keyFile: config.remote.keyFile,
      },
    };
  }
  const session = new DshTeachSession(options);

  const start = defineTool({
    name: "teach_start",
    description:
      "Start recording a human demonstration on the configured computer. Every click, typed value, page change and shell command becomes part of a teachable trajectory. Call teach_stop when the demonstration is complete.",
    parameters: {
      name: { type: "string", required: true, description: "Short name for the task being taught." },
    },
    execute: (args) => session.start(String(args.name ?? "")),
    presentCall: (args) => ({ card: "generic", title: `Teach: ${String(args.name ?? "")}`, kind: "read", rawInput: String(args.name ?? "") }),
  });

  const stop = defineTool({
    name: "teach_stop",
    description:
      "Stop the recording started by teach_start and persist the versioned trajectory. Returns the trajectory summary; pass its id to teach_compile.",
    parameters: {},
    execute: async () => session.stop(),
    presentCall: () => ({ card: "generic", title: "Teach: stop recording", kind: "read", rawInput: "stop" }),
  });

  const compile = defineTool({
    name: "teach_compile",
    description:
      "Compile the most recent recorded trajectory into a reusable, parameterized skill. Demonstrated values become skill inputs with your values as defaults. Returns the skill definition; pass its id to teach_replay.",
    parameters: {
      name: { type: "string", required: false, description: "Optional name for the compiled skill." },
    },
    execute: (args) => session.compile(typeof args.name === "string" ? args.name : undefined),
    presentCall: (args) => ({ card: "generic", title: `Teach: compile skill${args.name ? ` ${args.name}` : ""}`, kind: "read", rawInput: "compile" }),
  });

  const replay = defineTool({
    name: "teach_replay",
    description:
      "Replay a compiled skill with new inputs. Execution is deterministic — every step re-snapshots the computer, matches its target semantically, acts, and verifies the effect — and the result is an explicit success or failure with per-step checks.",
    parameters: {
      skillId: { type: "string", required: true, description: "Id of the compiled skill." },
      inputs: { type: "string", required: false, description: "JSON object of parameter values, e.g. {\"month\":\"October\"}." },
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
      return session.replay(String(args.skillId ?? ""), inputs);
    },
    presentCall: (args) => ({ card: "generic", title: `Teach: replay ${String(args.skillId ?? "").slice(0, 12)}`, kind: "read", rawInput: "replay" }),
  });

  const shell = defineTool({
    name: "teach_shell",
    description:
      "Record a shell command executed during an active demonstration — the CLI half of GUI+CLI workflows. The command runs for real on the recording computer and is stored with its real exit code.",
    parameters: {
      command: { type: "string", required: true, description: "The command to run and record." },
      cwd: { type: "string", required: false, description: "Working directory on the recording computer." },
    },
    execute: (args) => session.recordShell({ command: String(args.command ?? ""), cwd: typeof args.cwd === "string" ? args.cwd : undefined }),
    presentCall: (args) => ({ card: "generic", title: `Teach: shell ${String(args.command ?? "").slice(0, 60)}`, kind: "read", rawInput: String(args.command ?? "") }),
  });

  ctx.tools.register(start);
  ctx.tools.register(stop);
  ctx.tools.register(compile);
  ctx.tools.register(replay);
  ctx.tools.register(shell);
}

export const plugin: DshPlugin = { name, inject, apply };
