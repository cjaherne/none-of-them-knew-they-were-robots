/**
 * BigBoss "director": planning, human-facing summaries, and Overseer reviews.
 * Single module for all BigBoss-shaped OpenAI/CLI calls; persona text comes from skills/bigboss/system-prompt.md.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";
import type { PipelineMode } from "./task-store";
import {
  runAgent,
  runPlanner,
  buildContextBrief,
  type AgentRunConfig,
} from "./agent-runner";
import { loadBigBossSystemPromptSync } from "./bigboss-prompt-loader";
import {
  AGENT_TYPE_TO_DEF,
  FULL_STAGES,
  type RuntimeStageGroup,
  type StageDefinition,
  getAvailableParallelDesigners,
  groupStages,
  resolveSkillsRoot,
  skillPackExists,
} from "./pipeline-stages";

export function getBigBossModel(): string {
  return process.env.BIGBOSS_MODEL || "gpt-4o-mini";
}

export function getMergeModel(): string {
  return process.env.MERGE_MODEL || getBigBossModel();
}

function skillContextBlock(skillsRoot: string): string {
  const md = loadBigBossSystemPromptSync(skillsRoot);
  if (!md) return "";
  const cap = 12000;
  const body = md.length > cap ? `${md.slice(0, cap)}\n\n[…skill pack truncated…]` : md;
  return `## BigBoss skill pack (canonical persona)\n\n${body}\n\n---\n\n`;
}

const BIGBOSS_ROUTING_PROMPT = `You are a pipeline planner. Given a task, decide which pipeline stages are needed and estimate complexity.
Respond with ONLY a JSON object: { "stages": ["design", "coding", "testing"], "complexity": "trivial" | "moderate" | "complex" }

Rules:
- "design" = architecture/planning needed (new features, complex changes)
- "coding" = implementation needed (code changes, file creation)
- "testing" = test creation/validation needed
- Simple fixes may only need "coding"
- Documentation tasks may only need "coding"
- Most new features need all three stages
- If unsure, include all three

Complexity guide:
- "trivial" = one-line fix, rename, typo, config change
- "moderate" = single-feature addition, small refactor
- "complex" = multi-file feature, architectural change, new system`;

const BIGBOSS_CONTEXT_BROKER_PROMPT = `You are BigBoss, a context broker for a multi-agent pipeline. You will receive a task description and a codebase summary. Your job is to produce a pipeline plan using the FULL stage/agent structure.

Respond with ONLY a JSON object:
{
  "stages": [
    {
      "name": "design",
      "parallel": true,
      "agents": [
        { "type": "agent-type", "context": { "focus": "1-3 sentences for this agent" } }
      ]
    },
    { "name": "coding", "parallel": false, "agents": [{ "type": "coding" or "lua-coding", "context": { "focus": "..." } }] },
    { "name": "validation", "parallel": false, "agents": [{ "type": "testing", "context": { "focus": "..." } }] }
  ],
  "complexity": "trivial" | "moderate" | "complex",
  "reasoning": "Brief explanation"
}

Allowed agent types: ux-designer, core-code-designer, graphics-designer, game-designer, coding, lua-coding, testing.

- **Web/UI tasks**: In the design stage (parallel: true) include ux-designer, core-code-designer, graphics-designer. Use coding for the coding stage.
- **Full videogame / Lua / LÖVE tasks**: Set complexity to "complex". In the design stage (parallel: true) include MULTIPLE designers: game-designer (mechanics, controls, Lua structure), core-code-designer (architecture, modules), ux-designer (menus, HUD, flows), graphics-designer (visual style, art direction). Use lua-coding (not coding) for the coding stage. Do not use only one designer for a full game.
- Designer agents run in parallel (parallel: true) when there are two or more in the same stage.
- Each agent must have context.focus with 1-3 sentences (under 300 chars). Reference the task or codebase where helpful.`;

export interface BigBossResult {
  stages: StageDefinition[];
  stageGroups: RuntimeStageGroup[];
  complexity: "trivial" | "moderate" | "complex";
  agentBriefs: Record<string, string>;
  parallelDesign: boolean;
}

export const MAX_OVERSEER_DESIGN_ITERATIONS = 2;
export const MAX_OVERSEER_CODE_ITERATIONS = 2;

export interface OverseerDesignReviewResult {
  fit: "ok" | "gaps";
  gaps?: string[];
  suggestedSubTask?: { prompt: string };
}

export interface OverseerCodeReviewResult {
  fit: "ok" | "drift";
  missingOrWrong?: string[];
  suggestedSubTask?: { prompt: string };
}

function buildBigBossUserMessage(prompt: string, workDir: string, archBrief?: string): string {
  const brief = buildContextBrief("planning", workDir);
  const parts: string[] = [`## Task\n${prompt}`];

  if (archBrief) {
    parts.push(`## Architecture Brief (cached)\n${archBrief.slice(0, 3000)}`);
  } else {
    if (brief.fileTree) parts.push(`## Codebase\nTech: ${brief.techStack}\n\`\`\`\n${brief.fileTree}\n\`\`\``);
    if (brief.projectFiles) parts.push(`## Project Files\n${brief.projectFiles}`);
  }
  if (brief.gitHistory) parts.push(`## Recent Commits\n\`\`\`\n${brief.gitHistory}\n\`\`\``);

  return parts.join("\n\n");
}

async function planWithOpenAI(
  prompt: string,
  workDir: string,
  archBrief: string | undefined,
  pipelineMode: PipelineMode,
  skillsRoot: string,
): Promise<BigBossResult | null> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const userMessage = buildBigBossUserMessage(prompt, workDir, archBrief);
    const hasContext = userMessage.includes("## Codebase") || userMessage.includes("## Architecture Brief");
    const useFullFormat = hasContext || pipelineMode === "auto";
    const instruction = useFullFormat ? BIGBOSS_CONTEXT_BROKER_PROMPT : BIGBOSS_ROUTING_PROMPT;
    const systemPrompt = `${skillContextBlock(skillsRoot)}${instruction}`;
    const maxTokens = useFullFormat ? 1024 : 128;

    const model = getBigBossModel();
    const start = Date.now();
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    createLogger("bigboss").info(`OpenAI ${useFullFormat ? "context broker" : "routing"} (${model}) in ${elapsed}s`, { stages: parsed.stages, complexity: parsed.complexity }, "flow");
    if (parsed.agentBriefs) {
      for (const [agent, brief] of Object.entries(parsed.agentBriefs)) {
        createLogger("bigboss").debug(`Agent brief for ${agent}: ${(brief as string).slice(0, 100)}...`);
      }
    }

    return parseBigBossResponse(parsed);
  } catch (err) {
    createLogger("bigboss").warn("OpenAI call failed", { err: String(err) }, "error");
    return null;
  }
}

async function planWithAgentCli(
  prompt: string,
  workDir: string,
  pipelineId: string,
  skillsRoot: string,
  cursorSessionId?: string | null,
): Promise<BigBossResult | null> {
  try {
    const fullPrompt = `${skillContextBlock(skillsRoot)}${BIGBOSS_ROUTING_PROMPT}\n\nTask:\n${prompt}`;
    const { text, timedOut } = await runPlanner(fullPrompt, workDir, pipelineId, 60_000, cursorSessionId);

    if (timedOut) {
      createLogger("bigboss").warn("CLI timed out, falling back to full pipeline", undefined, "status");
      return null;
    }

    const jsonMatch = text.match(/\{[\s\S]*"stages"[\s\S]*\}/);
    if (!jsonMatch) {
      createLogger("bigboss").warn("No JSON found in CLI output");
      return null;
    }

    return parseBigBossResponse(JSON.parse(jsonMatch[0]));
  } catch (err) {
    createLogger("bigboss").warn("CLI planning failed", { err: String(err) }, "error");
    return null;
  }
}

function parseFullFormatStages(parsed: Record<string, unknown>): BigBossResult | null {
  const rawStages = parsed.stages as Array<{ name?: string; parallel?: boolean; agents?: Array<{ type?: string; context?: { focus?: string } }> }>;
  if (!Array.isArray(rawStages) || rawStages.length === 0) return null;
  const first = rawStages[0];
  if (!first || !Array.isArray(first.agents) || first.agents.length === 0) return null;

  const complexity = (["trivial", "moderate", "complex"].includes(parsed.complexity as string)
    ? parsed.complexity
    : "moderate") as BigBossResult["complexity"];

  const stageGroups: RuntimeStageGroup[] = [];
  const ordered: StageDefinition[] = [];
  const agentBriefs: Record<string, string> = {};

  for (const stage of rawStages) {
    const agents = stage.agents;
    if (!Array.isArray(agents) || agents.length === 0) continue;

    const stageDefs: StageDefinition[] = [];
    for (const a of agents) {
      const type = a?.type;
      if (!type || typeof type !== "string") continue;
      const def = AGENT_TYPE_TO_DEF[type];
      if (!def || !skillPackExists(def.agent)) {
        if (def) createLogger("orchestrator").warn(`Skill pack not found for ${type}, skipping`);
        continue;
      }
      stageDefs.push(def);
      ordered.push(def);
      if (a?.context?.focus && typeof a.context.focus === "string") {
        agentBriefs[def.agent] = a.context.focus;
      }
    }
    if (stageDefs.length === 0) continue;

    const stageName = stage.name && typeof stage.name === "string" ? stage.name : stageDefs[0].name;
    const parallel = stage.parallel === true && stageDefs.length > 1;
    stageGroups.push({
      name: stageName,
      parallel,
      agents: stageDefs.map((d) => ({ type: d.agent })),
      stageDefs,
    });
  }

  const hasCoding = ordered.some((s) => s.category === "coding");
  if (!hasCoding && ordered.length > 0) {
    const codingDef = skillPackExists("lua-coding") ? AGENT_TYPE_TO_DEF["lua-coding"] : AGENT_TYPE_TO_DEF["coding"];
    if (codingDef && skillPackExists(codingDef.agent)) {
      ordered.push(codingDef);
      stageGroups.push({
        name: "coding",
        parallel: false,
        agents: [{ type: codingDef.agent }],
        stageDefs: [codingDef],
      });
    }
  }

  if (stageGroups.length === 0) return null;

  createLogger("bigboss").info(`BigBoss full format: ${ordered.map((s) => s.agent).join(" -> ")}`, { complexity, briefCount: Object.keys(agentBriefs).length }, "flow");
  return { stages: ordered, stageGroups, complexity, agentBriefs, parallelDesign: ordered.filter((s) => s.category === "design").length > 1 };
}

function parseBigBossResponse(parsed: Record<string, unknown>): BigBossResult | null {
  if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) return null;

  const first = parsed.stages[0];
  if (first && typeof first === "object" && first !== null && "agents" in first && Array.isArray((first as { agents?: unknown }).agents)) {
    const result = parseFullFormatStages(parsed);
    if (result) return result;
    createLogger("bigboss").info("Full format parse failed, falling back to simplified", undefined, "flow");
  }

  const validNames = new Set(["design", "coding", "testing"]);
  const stageNames = (parsed.stages as string[]).filter((s) => validNames.has(s));
  if (stageNames.length === 0) return null;

  if (!stageNames.includes("coding")) stageNames.push("coding");

  const complexity = (["trivial", "moderate", "complex"].includes(parsed.complexity as string)
    ? parsed.complexity
    : "moderate") as BigBossResult["complexity"];

  const parallelDesign = parsed.parallelDesign === true && complexity === "complex";

  let ordered: StageDefinition[];
  let effectiveParallel = parallelDesign;
  if (parallelDesign && stageNames.includes("design")) {
    const availableDesigners = getAvailableParallelDesigners();
    if (availableDesigners.length > 1) {
      ordered = [...availableDesigners, ...FULL_STAGES.filter((d) => d.category !== "design" && stageNames.includes(d.name === "validation" ? "testing" : d.name))];
    } else {
      createLogger("bigboss").info(`Only ${availableDesigners.length} designer(s) available, downgrading to sequential`, undefined, "flow");
      effectiveParallel = false;
      ordered = [];
      for (const def of FULL_STAGES) {
        const lookupName = def.name === "validation" ? "testing" : def.name;
        if (stageNames.includes(lookupName)) ordered.push(def);
      }
    }
  } else {
    ordered = [];
    for (const def of FULL_STAGES) {
      const lookupName = def.name === "validation" ? "testing" : def.name;
      if (stageNames.includes(lookupName)) ordered.push(def);
    }
  }

  const agentBriefs: Record<string, string> = {};
  if (parsed.agentBriefs && typeof parsed.agentBriefs === "object") {
    for (const [key, val] of Object.entries(parsed.agentBriefs as Record<string, unknown>)) {
      if (typeof val === "string") agentBriefs[key] = val;
    }
  }

  const stageGroups = groupStages(ordered, effectiveParallel);

  createLogger("bigboss").info(`BigBoss routed to stages: ${ordered.map((s) => s.name).join(" -> ")}`, { complexity, parallel: effectiveParallel, briefCount: Object.keys(agentBriefs).length }, "flow");
  return { stages: ordered, stageGroups, complexity, agentBriefs, parallelDesign: effectiveParallel };
}

export async function planWithBigBoss(
  prompt: string,
  workDir: string,
  pipelineId: string,
  archBrief: string | undefined,
  pipelineMode: PipelineMode,
  cursorSessionId?: string | null,
): Promise<BigBossResult | null> {
  const skillsRoot = resolveSkillsRoot();
  if (process.env.OPENAI_API_KEY) {
    const result = await planWithOpenAI(prompt, workDir, archBrief, pipelineMode, skillsRoot);
    if (result) return result;
    createLogger("bigboss").info("OpenAI failed, trying agent CLI fallback", undefined, "flow");
  }
  return planWithAgentCli(prompt, workDir, pipelineId, skillsRoot, cursorSessionId);
}

export async function bigBossSummarize(
  workDir: string,
  filename: string,
  purpose: "design" | "feedback",
  skillsRoot: string,
): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(path.join(workDir, filename), "utf-8");
  } catch {
    return `${filename} not found.`;
  }

  if (!content.trim()) return `${filename} is empty.`;

  const skillBlock = skillContextBlock(skillsRoot);

  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const taskLine = purpose === "design"
        ? "Summarize this design document in 2-3 spoken sentences for a human who will decide whether to approve it. Mention what will be built, roughly how many files/components, and key architectural choices. Be concise."
        : "Summarize these coding feedback notes in 1-2 spoken sentences for a human. Focus on deviations from the design and any issues found. Be concise.";

      const systemPrompt = `${skillBlock}You are BigBoss. ${taskLine}`;

      const model = getBigBossModel();
      const start = Date.now();
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: content.slice(0, 4000) },
        ],
        max_tokens: 256,
        temperature: 0.3,
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const summary = response.choices[0]?.message?.content?.trim();
      if (summary) {
        createLogger("bigboss").debug(`Summarized ${filename} in ${elapsed}s (${model})`);
        return summary;
      }
    } catch (err) {
      createLogger("bigboss").warn(`Summarization failed for ${filename}`, { err: String(err) });
    }
  }

  const lines = content.split("\n").filter((l) => l.trim());
  const preview = lines.slice(0, 6).join(" ").slice(0, 300);
  return purpose === "design"
    ? `Design document ready. ${preview}...`
    : `Coding feedback: ${preview}...`;
}

export function parseOverseerJson<T extends { fit: string }>(text: string, validFits: string[]): T | null {
  const jsonMatch = text.match(/\{[\s\S]*"fit"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as T;
    if (!validFits.includes(parsed.fit)) parsed.fit = validFits[0];
    return parsed;
  } catch {
    return null;
  }
}

export async function overseerPostDesignReview(
  workDir: string,
  originalTask: string,
  skillsRoot: string,
  pipelineId: string,
  cursorSessionId?: string | null,
  signal?: AbortSignal,
): Promise<OverseerDesignReviewResult | null> {
  const log = createLogger("overseer");
  const skillBlock = skillContextBlock(skillsRoot);

  const agentPrompt = `Review the DESIGN.md in this workspace against the original user task below.\n\n## Original task\n\n${originalTask}`;
  try {
    const config: AgentRunConfig = {
      agentType: "bigboss",
      category: "design-review",
      prompt: agentPrompt,
      pipelineId,
      skillsRoot,
      baseBranch: "main",
      branch: "overseer-review",
      workspaceReady: true,
      trivial: true,
      cursorSessionId,
    };

    log.info("Running Overseer design review as agent", undefined, "flow");
    const result = await runAgent(config, workDir, undefined, signal);
    const text = result.parsed.assistantMessage || result.output;
    const parsed = parseOverseerJson<OverseerDesignReviewResult>(text, ["ok", "gaps"]);
    if (parsed) {
      log.info(`Overseer design review (agent): fit=${parsed.fit}, gaps=${(parsed.gaps || []).length}`, undefined, "flow");
      return parsed;
    }
    log.warn("Could not parse Overseer agent JSON, falling back to API", undefined, "flow");
  } catch (err) {
    log.warn("Overseer agent design review failed, falling back to API", { err: String(err) }, "flow");
  }

  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const designContent = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
    const designSlice = designContent.slice(0, 32000);
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();
    const systemContent = `${skillBlock}You are BigBoss in Overseer mode. Review the design document against the user's original task. Decide if the design covers every requirement from the Original task section. Respond with JSON only: { "fit": "ok" | "gaps", "gaps": ["gap1", "gap2"] (if fit is gaps, list missing or underspecified requirements), "suggestedSubTask": { "prompt": "focused instructions for designers to address the gaps" } (optional, if fit is gaps) }. Be concise.`;
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: `## Original task\n\n${originalTask.slice(0, 8000)}\n\n## Design document\n\n${designSlice}` },
      ],
      max_tokens: 2048,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OverseerDesignReviewResult;
    if (parsed.fit !== "ok" && parsed.fit !== "gaps") parsed.fit = "ok";
    return parsed;
  } catch (err) {
    log.warn("Overseer post-design review (API fallback) failed", { err: String(err) }, "flow");
    return null;
  }
}

export async function overseerPostCodeReview(
  workDir: string,
  originalTask: string,
  skillsRoot: string,
  pipelineId: string,
  cursorSessionId?: string | null,
  signal?: AbortSignal,
): Promise<OverseerCodeReviewResult | null> {
  const log = createLogger("overseer");
  const skillBlock = skillContextBlock(skillsRoot);

  const agentPrompt = `Review the implementation in this workspace against the original user task and DESIGN.md.\n\n## Original task\n\n${originalTask}`;
  try {
    const config: AgentRunConfig = {
      agentType: "bigboss",
      category: "code-review",
      prompt: agentPrompt,
      pipelineId,
      skillsRoot,
      baseBranch: "main",
      branch: "overseer-review",
      workspaceReady: true,
      trivial: true,
      cursorSessionId,
    };

    log.info("Running Overseer code review as agent", undefined, "flow");
    const result = await runAgent(config, workDir, undefined, signal);
    const text = result.parsed.assistantMessage || result.output;
    const parsed = parseOverseerJson<OverseerCodeReviewResult>(text, ["ok", "drift"]);
    if (parsed) {
      log.info(`Overseer code review (agent): fit=${parsed.fit}, issues=${(parsed.missingOrWrong || []).length}`, undefined, "flow");
      return parsed;
    }
    log.warn("Could not parse Overseer agent JSON, falling back to API", undefined, "flow");
  } catch (err) {
    log.warn("Overseer agent code review failed, falling back to API", { err: String(err) }, "flow");
  }

  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const designContent = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
    const designSlice = designContent.slice(0, 32000);
    const brief = buildContextBrief("code-review", workDir);
    const fileTree = brief.fileTree || "(no file tree)";
    const sourceFiles = brief.architecturalFiles || "(no source files read)";

    let codingNotes = "";
    try {
      codingNotes = await fs.readFile(path.join(workDir, "CODING_NOTES.md"), "utf-8");
      codingNotes = codingNotes.slice(0, 4000);
    } catch {
      /* no coding notes */
    }

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();
    const systemContent = `${skillBlock}You are BigBoss in Overseer mode. Review implementation against the design and original task. You receive the design document, a file tree, AND the actual content of key source files. Verify that each requirement from the Original task is implemented in the source code, not just that a file exists. Respond with JSON only: { "fit": "ok" | "drift", "missingOrWrong": ["item1", "item2"] (if fit is drift), "suggestedSubTask": { "prompt": "focused instructions for the coder to add or fix these items" } (optional, if fit is drift) }. Be concise.`;
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `## Original task\n\n${originalTask.slice(0, 8000)}\n\n## Design\n\n${designSlice.slice(0, 12000)}\n\n## File tree\n\`\`\`\n${fileTree}\n\`\`\`\n\n## Key source files\n${sourceFiles}${codingNotes ? `\n\n## CODING_NOTES.md\n${codingNotes}` : ""}`,
        },
      ],
      max_tokens: 2048,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OverseerCodeReviewResult;
    if (parsed.fit !== "ok" && parsed.fit !== "drift") parsed.fit = "ok";
    return parsed;
  } catch (err) {
    log.warn("Overseer post-code review (API fallback) failed", { err: String(err) }, "flow");
    return null;
  }
}
