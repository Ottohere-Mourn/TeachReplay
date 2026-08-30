// The VLM's narrow structured-output contract.
//
// The model is asked to infer the step sequence, parameters, and success
// condition only — never an id, schemaVersion, createdAt, or ${...}
// parameter-reference syntax. Those are always assigned by local,
// deterministic code (assemble.ts), so nothing that needs to be
// syntactically exact is ever trusted from model output.
const STEP_KINDS = ["navigate", "fill", "click", "press", "shell"] as const;
const SUCCESS_KINDS = ["url", "text"] as const;

export interface VlmSkillStepDraft {
  kind: (typeof STEP_KINDS)[number];
  description: string;
  role?: string;
  name?: string;
  url?: string;
  value?: string;
  isParameter?: boolean;
  parameterLabel?: string;
  keys?: string;
  command?: string;
  cwd?: string;
}

export interface VlmSkillDraft {
  taskName?: string;
  description?: string;
  steps: VlmSkillStepDraft[];
  success: { kind: (typeof SUCCESS_KINDS)[number]; value: string; description?: string };
  risks?: string[];
}

/** Strict JSON Schema sent to the model as a structured-output constraint.
 * A schema hint on the request does not guarantee a compatible endpoint
 * honors it, which is exactly why parseVlmSkillDraft (below) re-validates
 * the response rather than trusting it blindly.
 *
 * Every property is listed in `required` and optional fields use a
 * `["type", "null"]` union instead of omission — real strict-mode
 * structured output (OpenAI's Responses API, and proxies that forward to
 * it) requires every property to be present in `required`; a property
 * that's merely absent from `required` while still listed in `properties`
 * is rejected. Confirmed against a live endpoint: the same schema with
 * optional-by-omission fields returned a 502 from the provider once the
 * schema grew past a couple of fields; switching to required+nullable
 * fixed it. parseVlmSkillDraft treats an explicit `null` the same as an
 * absent field. */
export const VLM_SKILL_DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskName", "description", "steps", "success", "risks"],
  properties: {
    taskName: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "description", "role", "name", "url", "value", "isParameter", "parameterLabel", "keys", "command", "cwd"],
        properties: {
          kind: { type: "string", enum: [...STEP_KINDS] },
          description: { type: "string" },
          role: { type: ["string", "null"] },
          name: { type: ["string", "null"] },
          url: { type: ["string", "null"] },
          value: { type: ["string", "null"] },
          isParameter: { type: ["boolean", "null"] },
          parameterLabel: { type: ["string", "null"] },
          keys: { type: ["string", "null"] },
          command: { type: ["string", "null"] },
          cwd: { type: ["string", "null"] },
        },
      },
    },
    success: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "value", "description"],
      properties: {
        kind: { type: "string", enum: [...SUCCESS_KINDS] },
        value: { type: "string" },
        description: { type: ["string", "null"] },
      },
    },
    risks: { type: ["array", "null"], items: { type: "string" } },
  },
} as const;

export class VlmDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VlmDraftValidationError";
  }
}

function fail(message: string): never {
  throw new VlmDraftValidationError(message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

// The model is required (by the strict-mode schema above) to include every
// optional field, using an explicit `null` in place of omission — treat
// null the same as undefined ("absent") everywhere below.
function asOptionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${where} must be a string or null`);
  return value;
}

function asOptionalBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(`${where} must be a boolean or null`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  return value;
}

function parseStep(value: unknown, index: number): VlmSkillStepDraft {
  const where = `steps[${index}]`;
  const raw = asRecord(value, where);
  const kind = asString(raw.kind, `${where}.kind`);
  if (!(STEP_KINDS as readonly string[]).includes(kind)) {
    fail(`${where}.kind must be one of ${STEP_KINDS.join("|")}, got "${kind}"`);
  }
  const step: VlmSkillStepDraft = {
    kind: kind as VlmSkillStepDraft["kind"],
    description: asString(raw.description, `${where}.description`),
  };
  const role = asOptionalString(raw.role, `${where}.role`);
  if (role !== undefined) step.role = role;
  const name = asOptionalString(raw.name, `${where}.name`);
  if (name !== undefined) step.name = name;
  const url = asOptionalString(raw.url, `${where}.url`);
  if (url !== undefined) step.url = url;
  const value_ = asOptionalString(raw.value, `${where}.value`);
  if (value_ !== undefined) step.value = value_;
  const isParameter = asOptionalBoolean(raw.isParameter, `${where}.isParameter`);
  if (isParameter !== undefined) step.isParameter = isParameter;
  const parameterLabel = asOptionalString(raw.parameterLabel, `${where}.parameterLabel`);
  if (parameterLabel !== undefined) step.parameterLabel = parameterLabel;
  const keys = asOptionalString(raw.keys, `${where}.keys`);
  if (keys !== undefined) step.keys = keys;
  const command = asOptionalString(raw.command, `${where}.command`);
  if (command !== undefined) step.command = command;
  const cwd = asOptionalString(raw.cwd, `${where}.cwd`);
  if (cwd !== undefined) step.cwd = cwd;
  return step;
}

/** Real structural validation on the way back in — distinct from the JSON
 * Schema sent as a request hint. Throws VlmDraftValidationError with a
 * specific, quotable message; that message is what compile.ts echoes back
 * to the model on its one corrective retry. */
export function parseVlmSkillDraft(value: unknown): VlmSkillDraft {
  const raw = asRecord(value, "draft");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail("draft.steps must be a non-empty array");
  const steps = raw.steps.map((step, index) => parseStep(step, index));

  const successRaw = asRecord(raw.success, "draft.success");
  const successKind = asString(successRaw.kind, "draft.success.kind");
  if (!(SUCCESS_KINDS as readonly string[]).includes(successKind)) {
    fail(`draft.success.kind must be one of ${SUCCESS_KINDS.join("|")}, got "${successKind}"`);
  }
  const success: VlmSkillDraft["success"] = {
    kind: successKind as VlmSkillDraft["success"]["kind"],
    value: asString(successRaw.value, "draft.success.value"),
  };
  const successDescription = asOptionalString(successRaw.description, "draft.success.description");
  if (successDescription !== undefined) success.description = successDescription;

  const draft: VlmSkillDraft = { steps, success };
  const taskName = asOptionalString(raw.taskName, "draft.taskName");
  if (taskName !== undefined) draft.taskName = taskName;
  const description = asOptionalString(raw.description, "draft.description");
  if (description !== undefined) draft.description = description;
  if (raw.risks !== undefined && raw.risks !== null) {
    if (!Array.isArray(raw.risks) || !raw.risks.every((risk) => typeof risk === "string")) {
      fail("draft.risks must be an array of strings");
    }
    draft.risks = raw.risks as string[];
  }
  return draft;
}
