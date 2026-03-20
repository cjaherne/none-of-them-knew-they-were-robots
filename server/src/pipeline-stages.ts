import * as path from "path";
import type { PipelineStage } from "@agents/shared";
import { createLogger } from "@agents/shared";
import type { PipelineMode } from "./task-store";

export interface StageDefinition {
  name: string;
  agent: string;
  category: string;
}

/** Default full pipeline for web / Node / UI work */
export const FULL_STAGES_WEB: StageDefinition[] = [
  { name: "design", agent: "core-code-designer", category: "design" },
  { name: "coding", agent: "coding", category: "coding" },
  { name: "validation", agent: "testing", category: "validation" },
];

/** Full pipeline for LÖVE2D / Lua game tasks */
export const FULL_STAGES_LOVE: StageDefinition[] = [
  { name: "design", agent: "game-designer", category: "design" },
  { name: "coding", agent: "lua-coding", category: "coding" },
  { name: "validation", agent: "love-testing", category: "validation" },
];

/** Alias: orchestrator defaults and mode helpers use the web stack */
export const FULL_STAGES: StageDefinition[] = FULL_STAGES_WEB;

export const STAGE_MAP: Record<string, StageDefinition> = {
  design: FULL_STAGES_WEB[0],
  coding: FULL_STAGES_WEB[1],
  testing: FULL_STAGES_WEB[2],
};

/** Parallel design specialists for web/UI tasks (no Lua/game — use love trio for LÖVE) */
export const PARALLEL_DESIGNERS: StageDefinition[] = [
  { name: "ux-design", agent: "ux-designer", category: "design" },
  { name: "core-design", agent: "core-code-designer", category: "design" },
  { name: "visual-design", agent: "graphics-designer", category: "design" },
];

/** Parallel design specialists for LÖVE / Lua games */
export const PARALLEL_LOVE_DESIGNERS: StageDefinition[] = [
  { name: "game-design", agent: "game-designer", category: "design" },
  { name: "love-architect", agent: "love-architect", category: "design" },
  { name: "love-ux", agent: "love-ux", category: "design" },
];

/** Maps BigBoss agent type string to StageDefinition (for full stages[].agents[] format) */
export const AGENT_TYPE_TO_DEF: Record<string, StageDefinition> = {
  "ux-designer": { name: "ux-design", agent: "ux-designer", category: "design" },
  "core-code-designer": { name: "core-design", agent: "core-code-designer", category: "design" },
  "graphics-designer": { name: "visual-design", agent: "graphics-designer", category: "design" },
  "game-designer": { name: "game-design", agent: "game-designer", category: "design" },
  "love-architect": { name: "love-architect", agent: "love-architect", category: "design" },
  "love-ux": { name: "love-ux", agent: "love-ux", category: "design" },
  coding: { name: "coding", agent: "coding", category: "coding" },
  "lua-coding": { name: "coding", agent: "lua-coding", category: "coding" },
  testing: { name: "validation", agent: "testing", category: "validation" },
  "love-testing": { name: "validation", agent: "love-testing", category: "validation" },
};

export const RELEASE_STAGE: StageDefinition = { name: "release", agent: "release", category: "release" };

export function resolveSkillsRoot(): string {
  return process.env.SKILLS_ROOT || path.resolve(__dirname, "..", "..", "skills");
}

export function skillPackExists(agent: string): boolean {
  const skillsRoot = resolveSkillsRoot();
  try {
    require("fs").accessSync(path.join(skillsRoot, agent, "system-prompt.md"));
    return true;
  } catch {
    return false;
  }
}

function filterParallelBySkillPacks(defs: StageDefinition[]): StageDefinition[] {
  return defs.filter((s) => {
    const exists = skillPackExists(s.agent);
    if (!exists) {
      createLogger("orchestrator").warn(`Skill pack not found for ${s.agent}, skipping`);
    }
    return exists;
  });
}

export function getWebParallelDesigners(): StageDefinition[] {
  return filterParallelBySkillPacks(PARALLEL_DESIGNERS);
}

export function getLoveParallelDesigners(): StageDefinition[] {
  return filterParallelBySkillPacks(PARALLEL_LOVE_DESIGNERS);
}

/** @deprecated Prefer getWebParallelDesigners — returns web/UI parallel designers only */
export function getAvailableParallelDesigners(): StageDefinition[] {
  return getWebParallelDesigners();
}

export type PipelineStack = "web" | "love";

export function getFullStagesForStack(stack: PipelineStack): StageDefinition[] {
  return stack === "love" ? FULL_STAGES_LOVE : FULL_STAGES_WEB;
}

/** Infer LÖVE vs web from agents already chosen (full-format BigBoss or injection). */
export function inferStackFromAgents(agentIds: string[]): PipelineStack {
  const set = new Set(agentIds);
  if (
    set.has("lua-coding") ||
    set.has("love-testing") ||
    set.has("love-architect") ||
    set.has("love-ux")
  ) {
    return "love";
  }
  const webDesigners = ["ux-designer", "core-code-designer", "graphics-designer"];
  if (webDesigners.some((w) => set.has(w))) return "web";
  if (set.has("game-designer")) return "love";
  return "web";
}

export function stagesForMode(mode: PipelineMode): StageDefinition[] {
  switch (mode) {
    case "code-test":
      return [STAGE_MAP.coding, STAGE_MAP.testing];
    case "code-only":
      return [STAGE_MAP.coding];
    case "full":
    default:
      return [...FULL_STAGES];
  }
}

/** Runtime pipeline stage -- extends shared PipelineStage with local StageDefinitions */
export interface RuntimeStageGroup extends PipelineStage {
  stageDefs: StageDefinition[];
}

export function groupStages(stages: StageDefinition[], parallelDesign: boolean): RuntimeStageGroup[] {
  const groups: RuntimeStageGroup[] = [];

  if (parallelDesign) {
    const designStages = stages.filter((s) => s.category === "design");
    const nonDesign = stages.filter((s) => s.category !== "design");

    if (designStages.length > 1) {
      groups.push({
        name: "design",
        parallel: true,
        agents: designStages.map((d) => ({ type: d.agent })),
        stageDefs: designStages,
      });
    } else if (designStages.length === 1) {
      groups.push({
        name: designStages[0].name,
        agents: [{ type: designStages[0].agent }],
        stageDefs: designStages,
      });
    }
    for (const s of nonDesign) {
      groups.push({
        name: s.name,
        agents: [{ type: s.agent }],
        stageDefs: [s],
      });
    }
  } else {
    for (const s of stages) {
      groups.push({
        name: s.name,
        agents: [{ type: s.agent }],
        stageDefs: [s],
      });
    }
  }

  return groups;
}
