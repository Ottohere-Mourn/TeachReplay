import { describe, expect, it } from "vitest";

import { parseVlmSkillDraft, VlmDraftValidationError, VLM_SKILL_DRAFT_JSON_SCHEMA } from "../src/vlm-schema.js";

const VALID_DRAFT = {
  taskName: "File monthly report",
  steps: [
    { kind: "navigate", description: "Open the report form", url: "http://demo.local/report" },
    { kind: "fill", description: "Fill month", role: "combobox", name: "Month", value: "August" },
    { kind: "click", description: "Submit", role: "button", name: "Submit report" },
  ],
  success: { kind: "text", value: "Submission successful" },
};

describe("parseVlmSkillDraft", () => {
  it("accepts a well-formed draft", () => {
    const draft = parseVlmSkillDraft(VALID_DRAFT);
    expect(draft.steps).toHaveLength(3);
    expect(draft.success.kind).toBe("text");
  });

  it("rejects a non-object value", () => {
    expect(() => parseVlmSkillDraft("nope")).toThrow(VlmDraftValidationError);
  });

  it("rejects a missing steps array", () => {
    expect(() => parseVlmSkillDraft({ success: VALID_DRAFT.success })).toThrow(/steps must be a non-empty array/);
  });

  it("rejects an empty steps array", () => {
    expect(() => parseVlmSkillDraft({ ...VALID_DRAFT, steps: [] })).toThrow(/non-empty array/);
  });

  it("rejects an unknown step kind", () => {
    const broken = { ...VALID_DRAFT, steps: [{ kind: "drag", description: "nope" }] };
    expect(() => parseVlmSkillDraft(broken)).toThrow(/steps\[0\]\.kind must be one of/);
  });

  it("rejects a missing success block", () => {
    expect(() => parseVlmSkillDraft({ steps: VALID_DRAFT.steps })).toThrow(/success must be an object/);
  });

  it("rejects an unknown success kind", () => {
    const broken = { ...VALID_DRAFT, success: { kind: "screenshot", value: "x" } };
    expect(() => parseVlmSkillDraft(broken)).toThrow(/success\.kind must be one of/);
  });

  it("rejects a non-string risks entry", () => {
    const broken = { ...VALID_DRAFT, risks: ["fine", 42] };
    expect(() => parseVlmSkillDraft(broken)).toThrow(/risks must be an array of strings/);
  });

  it("exposes a schema with the expected step/success enums", () => {
    const stepEnum = (VLM_SKILL_DRAFT_JSON_SCHEMA.properties.steps.items.properties.kind as { enum: string[] }).enum;
    expect(stepEnum).toEqual(["navigate", "fill", "click", "press", "shell"]);
    const successEnum = (VLM_SKILL_DRAFT_JSON_SCHEMA.properties.success.properties.kind as { enum: string[] }).enum;
    expect(successEnum).toEqual(["url", "text"]);
  });
});
