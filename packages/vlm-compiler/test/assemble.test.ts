import { parseSkill, serializeSkill, skillReferencesAreValid } from "@teachreplay/core";
import { describe, expect, it } from "vitest";

import { assembleSkillFromDraft, SkillAssemblyError } from "../src/assemble.js";
import type { VisualSession } from "../src/session.js";
import type { VlmSkillDraft } from "../src/vlm-schema.js";

function session(overrides: Partial<VisualSession> = {}): VisualSession {
  return {
    id: "session-1",
    botId: "bot-1",
    name: "monthly report filing",
    app: "desktop",
    recordedVia: "remote",
    startedAt: 1_000,
    finishedAt: 5_000,
    stopReason: "manual",
    frames: [
      { seq: 0, at: 1_000, imageBase64: "aaaa" },
      { seq: 1, at: 4_000, imageBase64: "bbbb" },
    ],
    shellEvents: [],
    ...overrides,
  };
}

const DRAFT: VlmSkillDraft = {
  taskName: "File monthly report",
  steps: [
    { kind: "navigate", description: "Open the report form", url: "http://demo.local/report" },
    { kind: "fill", description: "Fill month", role: "combobox", name: "Month", value: "August" },
    { kind: "click", description: "Submit", role: "button", name: "Submit report" },
  ],
  success: { kind: "text", value: "Submission successful" },
};

describe("assembleSkillFromDraft", () => {
  it("produces a Skill that satisfies skillReferencesAreValid and round-trips through parseSkill", () => {
    const skill = assembleSkillFromDraft({ draft: DRAFT, session: session(), now: () => 42 });
    expect(skillReferencesAreValid(skill)).toEqual([]);
    expect(skill.createdAt).toBe(42);
    expect(skill.name).toBe("File monthly report");
    expect(skill.inputs).toHaveLength(1);
    expect(skill.inputs[0]!.default).toBe("August");
    expect(skill.steps[1]!.value).toBe("${month}");

    const roundTripped = parseSkill(JSON.parse(serializeSkill(skill)));
    expect(roundTripped.id).toBe(skill.id);
  });

  it("always appends the screenshot-secrets risk disclosure", () => {
    const skill = assembleSkillFromDraft({ draft: DRAFT, session: session() });
    expect(skill.risks.some((risk) => risk.includes("periodic screenshots"))).toBe(true);
  });

  it("preserves model-reported risks alongside the standing disclosure", () => {
    const skill = assembleSkillFromDraft({ draft: { ...DRAFT, risks: ["Clicks a submit button."] }, session: session() });
    expect(skill.risks).toContain("Clicks a submit button.");
    expect(skill.risks).toHaveLength(2);
  });

  it("generalizes a shell command that embeds a demonstrated fill value", () => {
    const draft: VlmSkillDraft = {
      steps: [
        { kind: "fill", description: "Fill month", role: "combobox", name: "Month", value: "August" },
        { kind: "shell", description: "Archive the report", command: "tar -czf August-report.tar.gz report.txt" },
      ],
      success: { kind: "text", value: "done" },
    };
    const skill = assembleSkillFromDraft({ draft, session: session() });
    const shellStep = skill.steps.find((step) => step.kind === "shell")!;
    expect(shellStep.command).toBe("tar -czf ${month}-report.tar.gz report.txt");
  });

  it("keeps a fill step literal when isParameter is false", () => {
    const draft: VlmSkillDraft = {
      steps: [{ kind: "fill", description: "Fill month", role: "combobox", name: "Month", value: "August", isParameter: false }],
      success: { kind: "text", value: "done" },
    };
    const skill = assembleSkillFromDraft({ draft, session: session() });
    expect(skill.steps[0]!.value).toBe("August");
    expect(skill.steps[0]!.parameter).toBeUndefined();
    expect(skill.inputs).toHaveLength(0);
  });

  it("throws SkillAssemblyError on an empty step list", () => {
    expect(() => assembleSkillFromDraft({ draft: { ...DRAFT, steps: [] }, session: session() })).toThrow(SkillAssemblyError);
  });

  it("throws SkillAssemblyError when a fill step is missing a role", () => {
    const draft: VlmSkillDraft = {
      steps: [{ kind: "fill", description: "Fill month", value: "August" }],
      success: { kind: "text", value: "done" },
    };
    expect(() => assembleSkillFromDraft({ draft, session: session() })).toThrow(/missing role/);
  });
});
