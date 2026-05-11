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

/** Post-design raster pass for LÖVE games (OpenAI DALL-E 3 via MCP); injected before lua-coding when applicable. */
export const GAME_ART_STAGE: StageDefinition = { name: "game-art", agent: "game-art", category: "game-art" };

export const RELEASE_STAGE: StageDefinition = { name: "release", agent: "release", category: "release" };

/**
 * Discrete Overseer sub-stages — inserted into the pipeline unconditionally by
 * `injectV2OverseerStages()`. Each is a single-stage group dispatched by
 * category in the orchestrator. The agent field is `"bigboss"` because the
 * underlying review is a BigBoss skill-pack call.
 */
export const CLARIFY_STAGE: StageDefinition = { name: "clarify", agent: "bigboss", category: "clarify" };
export const ANALYZE_STAGE: StageDefinition = { name: "analyze", agent: "bigboss", category: "analyze" };
export const CHECKLIST_STAGE: StageDefinition = { name: "checklist", agent: "bigboss", category: "checklist" };

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
  "game-art": GAME_ART_STAGE,
};

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
  if (set.has("game-art")) {
    return "love";
  }
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

/**
 * Inserts game-art after the last design stage before coding (LÖVE only), when skill + API key exist.
 * stageGroups must be rebuilt with groupStages(stages, parallelDesign) after calling this.
 */
export function injectPostDesignGameArt(stages: StageDefinition[]): StageDefinition[] {
  const stack = inferStackFromAgents(stages.map((s) => s.agent));
  if (stack !== "love") return stages;
  if (!skillPackExists("game-art")) return stages;
  if (!process.env.OPENAI_API_KEY?.trim()) {
    createLogger("orchestrator").info("Skipping game-art stage: OPENAI_API_KEY not set", undefined, "flow");
    return stages;
  }
  const codingIdx = stages.findIndex((s) => s.category === "coding");
  if (codingIdx === -1) return stages;
  const hasDesignBeforeCoding = stages.slice(0, codingIdx).some((s) => s.category === "design");
  if (!hasDesignBeforeCoding) return stages;
  if (stages.some((s) => s.agent === "game-art")) return stages;

  let lastDesignIdx = -1;
  for (let i = 0; i < codingIdx; i++) {
    if (stages[i].category === "design") lastDesignIdx = i;
  }
  if (lastDesignIdx === -1) return stages;

  const next = [...stages];
  next.splice(lastDesignIdx + 1, 0, { ...GAME_ART_STAGE });
  return next;
}

/**
 * Insert the named Overseer sub-stages into a stage list.
 *
 * - `CLARIFY_STAGE`   inserted immediately after the **last** design stage so
 *                     it sees the merged `spec.md` / `plan.md`.
 * - `ANALYZE_STAGE`   inserted immediately after the **last** coding stage so
 *                     it sees the implementation diff and any `CODING_NOTES.md`.
 * - `CHECKLIST_STAGE` inserted immediately after `ANALYZE_STAGE` so it
 *                     reads `CHECKLISTS.md` post-analyze and can hand off to a
 *                     single coding fix-up before validation runs.
 *
 * Idempotent: existing CLARIFY/ANALYZE/CHECKLIST entries are left in place.
 * Has no effect when the stage list contains no `design` or no `coding`
 * entries respectively (so single-category pipelines like `code-only` mode
 * are unaffected). CHECKLIST is only inserted when ANALYZE was also inserted
 * (or already present) — there's no point in a checklist pass without the
 * analyze stage that precedes it in the v2 lifecycle.
 *
 * Order of operations: insertions happen later-to-earlier so previously-
 * computed indices stay valid: CHECKLIST first (after coding+1), then
 * ANALYZE (after coding), then CLARIFY (after design — unchanged index
 * because everything new is post-coding).
 */
export function injectV2OverseerStages(stages: StageDefinition[]): StageDefinition[] {
  if (stages.length === 0) return stages;

  let lastDesignIdx = -1;
  let lastCodingIdx = -1;
  let hasClarify = false;
  let hasAnalyze = false;
  let hasChecklist = false;
  for (let i = 0; i < stages.length; i++) {
    const cat = stages[i].category;
    if (cat === "design") lastDesignIdx = i;
    if (cat === "coding") lastCodingIdx = i;
    if (cat === "clarify") hasClarify = true;
    if (cat === "analyze") hasAnalyze = true;
    if (cat === "checklist") hasChecklist = true;
  }

  const next = [...stages];
  if (lastCodingIdx !== -1 && !hasChecklist) {
    // Insert CHECKLIST_STAGE first (further from coding); ANALYZE_STAGE will
    // be spliced between coding and checklist immediately afterwards.
    next.splice(lastCodingIdx + 1, 0, { ...CHECKLIST_STAGE });
  }
  if (lastCodingIdx !== -1 && !hasAnalyze) {
    next.splice(lastCodingIdx + 1, 0, { ...ANALYZE_STAGE });
  }
  if (lastDesignIdx !== -1 && !hasClarify) {
    // ANALYZE + CHECKLIST were inserted after coding (later in the array);
    // the design index is unchanged, so we can splice CLARIFY at
    // lastDesignIdx + 1 without recomputing.
    next.splice(lastDesignIdx + 1, 0, { ...CLARIFY_STAGE });
  }
  return next;
}
