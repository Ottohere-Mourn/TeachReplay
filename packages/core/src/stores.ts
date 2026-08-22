// Harness-agnostic persistence for trajectories and skills, backed by a
// directory of versioned JSON files (the layout TeachReplay v0.1 used
// under ~/.openmausbot/teach). Adapters can point these at any writable
// directory, or implement their own stores over the same interfaces.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkill, renderSkillMarkdown, serializeSkill, type Skill } from "./compiler.js";
import { parseTrajectory, serializeTrajectory, type Trajectory } from "./trajectory.js";

export interface TrajectorySummary {
  id: string;
  name: string;
  botId: string;
  app: string;
  recordedVia: string;
  createdAt: number;
  eventCount: number;
}

export interface TrajectoryStore {
  saveTrajectory(trajectory: Trajectory): Promise<void>;
  getTrajectory(id: string): Promise<Trajectory | null>;
  listTrajectories(): Promise<TrajectorySummary[]>;
}

export interface SkillSummary {
  id: string;
  name: string;
  botId: string;
  app: string;
  recordedVia: string;
  createdAt: number;
  inputIds: string[];
  stepCount: number;
  riskCount: number;
  sourceTrajectoryId: string;
}

export interface SkillStore {
  saveSkill(skill: Skill): Promise<void>;
  getSkill(id: string): Promise<{ skill: Skill; humanReadable: string } | null>;
  listSkills(): Promise<SkillSummary[]>;
  removeSkill(id: string): Promise<boolean>;
}

function summaryOf(trajectory: Trajectory): TrajectorySummary {
  return {
    id: trajectory.id,
    name: trajectory.name,
    botId: trajectory.botId,
    app: trajectory.app,
    recordedVia: trajectory.recordedVia,
    createdAt: trajectory.createdAt,
    eventCount: trajectory.events.length,
  };
}

function skillSummaryOf(skill: Skill): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    botId: skill.botId,
    app: skill.app,
    recordedVia: skill.recordedVia,
    createdAt: skill.createdAt,
    inputIds: skill.inputs.map((parameter) => parameter.id),
    stepCount: skill.steps.length,
    riskCount: skill.risks.length,
    sourceTrajectoryId: skill.sourceTrajectoryId,
  };
}

function atomicWrite(file: string, content: string) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}

export class FileTrajectoryStore implements TrajectoryStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "recordings"), { recursive: true });
  }

  async saveTrajectory(trajectory: Trajectory): Promise<void> {
    atomicWrite(join(this.root, "recordings", `${trajectory.id}.json`), serializeTrajectory(trajectory));
  }

  async getTrajectory(id: string): Promise<Trajectory | null> {
    try {
      return parseTrajectory(JSON.parse(readFileSync(join(this.root, "recordings", `${id}.json`), "utf8")));
    } catch {
      return null;
    }
  }

  async listTrajectories(): Promise<TrajectorySummary[]> {
    const out: TrajectorySummary[] = [];
    for (const file of readdirSync(join(this.root, "recordings")).sort().reverse()) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(summaryOf(parseTrajectory(JSON.parse(readFileSync(join(this.root, "recordings", file), "utf8")))));
      } catch {
        /* skip corrupt files */
      }
    }
    return out;
  }
}

export class FileSkillStore implements SkillStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "skills"), { recursive: true });
  }

  async saveSkill(skill: Skill): Promise<void> {
    atomicWrite(join(this.root, "skills", `${skill.id}.json`), serializeSkill(skill));
    atomicWrite(join(this.root, "skills", `${skill.id}.md`), renderSkillMarkdown(skill));
  }

  async getSkill(id: string): Promise<{ skill: Skill; humanReadable: string } | null> {
    try {
      const skill = parseSkill(JSON.parse(readFileSync(join(this.root, "skills", `${id}.json`), "utf8")));
      const humanReadable = readFileSync(join(this.root, "skills", `${id}.md`), "utf8").trim() || renderSkillMarkdown(skill);
      return { skill, humanReadable };
    } catch {
      return null;
    }
  }

  async listSkills(): Promise<SkillSummary[]> {
    const out: SkillSummary[] = [];
    for (const file of readdirSync(join(this.root, "skills")).sort().reverse()) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(skillSummaryOf(parseSkill(JSON.parse(readFileSync(join(this.root, "skills", file), "utf8")))));
      } catch {
        /* skip corrupt files */
      }
    }
    return out;
  }

  async removeSkill(id: string): Promise<boolean> {
    let removed = false;
    for (const file of [join(this.root, "skills", `${id}.json`), join(this.root, "skills", `${id}.md`)]) {
      try {
        rmSync(file);
        removed = true;
      } catch {
        /* not there */
      }
    }
    return removed;
  }
}
