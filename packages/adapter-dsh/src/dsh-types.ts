// Minimal type shims for the DeepSeek Harness plugin API.
//
// Extracted from deepseek-ai/deepseek-harness (MIT) at the 2026-08-22
// master snapshot:
//   - plugins export `name`, `inject`, and `apply(ctx, config)`
//   - tools are built with defineTool({ name, description, parameters,
//     output, execute, presentCall }) and registered via ctx.tools.register
//   - `inject` lists service namespaces made available on the Context
//
// DSH is in developer preview with compatibility-breaking changes, and
// its packages resolve as `workspace:^` peers only INSIDE the DSH
// workspace. When building this adapter inside DSH, drop these shims and
// import the real types from @deepseek-ai/cordis / @deepseek-ai/dsh-tools
// (see README.md).
export interface DshContext {
  tools: {
    register(tool: unknown): void;
  };
  [service: string]: unknown;
}

export type DshToolParameters = Record<string, {
  type: string;
  required?: boolean;
  description?: string;
  enum?: string[];
}>;

export interface DshToolDefinition<Args extends Record<string, unknown>, Result> {
  name: string;
  description: string;
  parameters: DshToolParameters;
  execute(args: Args): Promise<Result>;
  presentCall?(args: Args): unknown;
}

/** Shape of defineTool from @deepseek-ai/dsh-tools. The real registry
 * accepts this definition plus optional output/presentCall fields. */
export function defineTool<Args extends Record<string, unknown>, Result>(
  definition: DshToolDefinition<Args, Result>,
): unknown {
  return definition;
}

export interface DshPlugin {
  name: string;
  inject: string[];
  apply(ctx: DshContext, config?: Record<string, unknown>): void;
}
