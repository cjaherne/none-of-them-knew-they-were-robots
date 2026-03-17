import * as path from "path";
import { promises as fs } from "fs";
import { TaskStatus, PipelineStage, PipelineStageAgent, createLogger } from "@agents/shared";
import { taskStore, MvpTask, PipelineMode, StageStatus, ApprovalResponse } from "./local-task-store";
import {
  runAgent,
  runPlanner,
  setupWorkspace,
  pushBranch,
  readCodingNotes,
  runLintCheck,
  buildContextBrief,
  AgentRunConfig,
  AgentRunResult,
} from "./local-agent-runner";
import { loadOrBuildCache, getCacheBrief } from "./context-cache";

interface StageDefinition {
  name: string;
  agent: string;
  category: string;
}

const FULL_STAGES: StageDefinition[] = [
  { name: "design", agent: "core-code-designer", category: "design" },
  { name: "coding", agent: "coding", category: "coding" },
  { name: "validation", agent: "testing", category: "validation" },
];

const STAGE_MAP: Record<string, StageDefinition> = {
  design: FULL_STAGES[0],
  coding: FULL_STAGES[1],
  testing: FULL_STAGES[2],
};

const PARALLEL_DESIGNERS: StageDefinition[] = [
  { name: "ux-design", agent: "ux-designer", category: "design" },
  { name: "core-design", agent: "core-code-designer", category: "design" },
  { name: "visual-design", agent: "graphics-designer", category: "design" },
];

const RELEASE_STAGE: StageDefinition = { name: "release", agent: "release", category: "release" };

function resolveSkillsRoot(): string {
  return (
    process.env.SKILLS_ROOT ||
    path.resolve(__dirname, "..", "..", "skills")
  );
}

function skillPackExists(agent: string): boolean {
  const skillsRoot = resolveSkillsRoot();
  try {
    require("fs").accessSync(path.join(skillsRoot, agent, "system-prompt.md"));
    return true;
  } catch {
    return false;
  }
}

function getAvailableParallelDesigners(): StageDefinition[] {
  const available = PARALLEL_DESIGNERS.filter((s) => {
    const exists = skillPackExists(s.agent);
    if (!exists) {
      createLogger("orchestrator").warn(`Skill pack not found for ${s.agent}, skipping`);
    }
    return exists;
  });
  return available;
}

function stagesForMode(mode: PipelineMode): StageDefinition[] {
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

const BIGBOSS_CONTEXT_BROKER_PROMPT = `You are BigBoss, a context broker for a multi-agent pipeline. You will receive a task description and a codebase summary. Your job is to:
1. Decide which stages are needed and estimate complexity (same as routing).
2. Produce a focused context brief for EACH agent that will run, telling them exactly what to focus on.

Respond with ONLY a JSON object:
{
  "stages": ["design", "coding", "testing"],
  "complexity": "trivial" | "moderate" | "complex",
  "agentBriefs": {
    "design": "1-3 sentences telling the design agent which existing files/patterns to consider, what architectural constraints exist, and what the key design decisions are.",
    "coding": "1-3 sentences telling the coding agent which files to modify/create, what patterns to follow, and any gotchas.",
    "testing": "1-3 sentences telling the testing agent what to test, what framework to use, and what edge cases matter."
  }
}

Rules for agent briefs:
- Reference specific files and directories from the codebase summary
- Mention existing patterns the agent should follow
- Flag potential conflicts or dependencies
- Keep each brief under 300 chars -- be precise, not verbose
- Only include briefs for stages that are in the "stages" array`;

interface BigBossResult {
  stages: StageDefinition[];
  stageGroups: RuntimeStageGroup[];
  complexity: "trivial" | "moderate" | "complex";
  agentBriefs: Record<string, string>;
  parallelDesign: boolean;
}

/** Runtime pipeline stage -- extends shared PipelineStage with local StageDefinitions */
interface RuntimeStageGroup extends PipelineStage {
  stageDefs: StageDefinition[];
}

function groupStages(stages: StageDefinition[], parallelDesign: boolean): RuntimeStageGroup[] {
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

async function mergeDesignOutputs(
  workDir: string,
  results: AgentRunResult[],
): Promise<void> {
  const designFiles: Array<{ agent: string; content: string }> = [];

  for (const r of results) {
    const agentDesignPath = path.join(workDir, ".pipeline", `${r.agent}-design.md`);
    try {
      const content = await fs.readFile(agentDesignPath, "utf-8");
      if (content.trim()) {
        designFiles.push({ agent: r.agent, content });
      }
    } catch { /* agent didn't produce a per-agent design file */ }
  }

  // Fallback: if no per-agent files found, read DESIGN.md once
  if (designFiles.length === 0) {
    try {
      const content = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
      if (content.trim()) {
        designFiles.push({ agent: "design", content });
      }
    } catch { /* no design output at all */ }
  }

  if (designFiles.length <= 1) {
    if (designFiles.length === 1) {
      await fs.writeFile(path.join(workDir, "DESIGN.md"), designFiles[0].content, "utf-8");
    }
    return;
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const inputs = designFiles.map((d) =>
        `## ${d.agent} design\n${d.content.slice(0, 3000)}`,
      ).join("\n\n---\n\n");

      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are merging multiple design documents from parallel agents into a single unified DESIGN.md. Combine all sections, resolve conflicts by preferring the more specific/detailed version, and produce a coherent document. Maintain markdown formatting.",
          },
          { role: "user", content: inputs },
        ],
        max_tokens: 4096,
        temperature: 0.2,
      });

      const merged = response.choices[0]?.message?.content;
      if (merged) {
        await fs.writeFile(path.join(workDir, "DESIGN.md"), merged, "utf-8");
        createLogger("orchestrator").info(`Merged ${designFiles.length} design documents via OpenAI`, undefined, "flow");
        return;
      }
    } catch (err) {
      createLogger("orchestrator").warn("OpenAI merge failed, using concatenation", { err: String(err) });
    }
  }

  const concatenated = designFiles.map((d) =>
    `# ${d.agent} Design\n\n${d.content}`,
  ).join("\n\n---\n\n");
  await fs.writeFile(path.join(workDir, "DESIGN.md"), concatenated, "utf-8");
  createLogger("orchestrator").info(`Concatenated ${designFiles.length} design documents`, undefined, "flow");
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

async function planWithOpenAI(prompt: string, workDir: string, archBrief?: string): Promise<BigBossResult | null> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const userMessage = buildBigBossUserMessage(prompt, workDir, archBrief);
    const hasContext = userMessage.includes("## Codebase");
    const systemPrompt = hasContext ? BIGBOSS_CONTEXT_BROKER_PROMPT : BIGBOSS_ROUTING_PROMPT;
    const maxTokens = hasContext ? 512 : 128;

    const start = Date.now();
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
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
    createLogger("bigboss").info(`OpenAI ${hasContext ? "context broker" : "routing"} in ${elapsed}s`, { stages: parsed.stages, complexity: parsed.complexity }, "flow");
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
): Promise<BigBossResult | null> {
  try {
    const fullPrompt = `${BIGBOSS_ROUTING_PROMPT}\n\nTask:\n${prompt}`;
    const { text, timedOut } = await runPlanner(fullPrompt, workDir, pipelineId, 60_000);

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

function parseBigBossResponse(parsed: Record<string, unknown>): BigBossResult | null {
  if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) return null;

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

async function bigBossSummarize(
  workDir: string,
  filename: string,
  purpose: "design" | "feedback",
): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(path.join(workDir, filename), "utf-8");
  } catch {
    return `${filename} not found.`;
  }

  if (!content.trim()) return `${filename} is empty.`;

  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const systemPrompt = purpose === "design"
        ? "You are BigBoss, a pipeline orchestrator. Summarize this design document in 2-3 spoken sentences for a human who will decide whether to approve it. Mention what will be built, roughly how many files/components, and key architectural choices. Be concise."
        : "You are BigBoss, a pipeline orchestrator. Summarize these coding feedback notes in 1-2 spoken sentences for a human. Focus on deviations from the design and any issues found. Be concise.";

      const start = Date.now();
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
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
        createLogger("bigboss").debug(`Summarized ${filename} in ${elapsed}s`);
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

async function readDesignPreview(workDir: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
    return content.slice(0, 8000);
  } catch {
    return "";
  }
}

async function planWithBigBoss(
  prompt: string,
  workDir: string,
  pipelineId: string,
  archBrief?: string,
): Promise<BigBossResult | null> {
  if (process.env.OPENAI_API_KEY) {
    const result = await planWithOpenAI(prompt, workDir, archBrief);
    if (result) return result;
    createLogger("bigboss").info("OpenAI failed, trying agent CLI fallback", undefined, "flow");
  }
  return planWithAgentCli(prompt, workDir, pipelineId);
}

const MAX_DESIGN_LOOPS = 2;

export async function runPipeline(task: MvpTask): Promise<void> {
  const skillsRoot = resolveSkillsRoot();
  const upstreamResults: AgentRunResult[] = [];
  const pid = task.id.slice(0, 8);
  const log = createLogger("orchestrator", task.id);

  const abortController = new AbortController();
  taskStore.registerAbort(task.id, abortController);
  const signal = abortController.signal;

  taskStore.updateTaskStatus(task.id, TaskStatus.Running);

  const baseConfig: Pick<AgentRunConfig, "prompt" | "repo" | "pipelineId" | "skillsRoot" | "workspace" | "baseBranch" | "branch"> = {
    prompt: task.prompt,
    repo: task.repo,
    pipelineId: task.id,
    skillsRoot,
    workspace: task.workspace,
    baseBranch: task.baseBranch,
    branch: task.branch,
  };

  let workDir: string;
  try {
    workDir = await setupWorkspace(baseConfig as AgentRunConfig);
    log.info(`Workspace ready: ${workDir}, branch: ${task.branch}`, { workDir, branch: task.branch }, "status");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    taskStore.updateTaskStatus(task.id, TaskStatus.Failed, `Workspace setup failed: ${message}`);
    taskStore.cleanupAbort(task.id);
    return;
  }

  // Build / refresh the codebase summary cache
  let cacheBrief = "";
  try {
    const brief = buildContextBrief("planning", workDir);
    const cache = await loadOrBuildCache(workDir, brief.techStack);
    cacheBrief = getCacheBrief(cache);
    log.info(`Context cache: ${cache.files.length} files indexed`, { files: cache.files.length }, "status");
  } catch (err) {
    log.warn("Context cache build failed (non-fatal)", { err: String(err) });
  }

  let stages: StageDefinition[];
  let complexity: "trivial" | "moderate" | "complex" = "moderate";
  let agentBriefs: Record<string, string> = {};
  let planned: BigBossResult | null = null;

  if (task.pipelineMode === "auto") {
    planned = await planWithBigBoss(task.prompt, workDir, task.id, cacheBrief || undefined);
    if (planned) {
      stages = planned.stages;
      complexity = planned.complexity;
      agentBriefs = planned.agentBriefs;
    } else {
      stages = [...FULL_STAGES];
    }
    log.info(`BigBoss routed to stages: ${stages.map((s) => s.name).join(" -> ")}`, { mode: "auto", complexity }, "flow");
  } else {
    stages = stagesForMode(task.pipelineMode);
    log.info(`Pipeline stages: ${stages.map((s) => s.name).join(" -> ")}`, { mode: task.pipelineMode }, "flow");
  }

  stages = [...stages, RELEASE_STAGE];

  const initialStages: StageStatus[] = stages.map((s) => ({
    name: s.name,
    agent: s.agent,
    status: "pending" as const,
  }));
  taskStore.setStages(task.id, initialStages);

  let stageGroups = planned?.stageGroups || groupStages(stages, false);
  const hasRelease = stageGroups.some((g) => g.stageDefs.some((s) => s.name === "release"));
  if (!hasRelease) {
    stageGroups = [...stageGroups, { name: "release", parallel: false, agents: [{ type: "release" }], stageDefs: [RELEASE_STAGE] }];
  }
  const isTrivial = complexity === "trivial";
  let designLoops = 0;
  let designFeedback: string | undefined;
  let groupIndex = 0;

  while (groupIndex < stageGroups.length) {
    if (signal.aborted) {
      log.warn("Pipeline cancelled by user", undefined, "status");
      taskStore.cleanupAbort(task.id);
      return;
    }

    const group = stageGroups[groupIndex];

    if (group.parallel && group.stageDefs.length > 1) {
      // --- Parallel stage execution ---
      log.info(`Running ${group.stageDefs.length} stages in parallel: ${group.stageDefs.map((s) => s.name).join(", ")}`, { agents: group.stageDefs.map((s) => s.agent) }, "status");
      taskStore.emit_log(task.id, `Running ${group.stageDefs.length} agents in parallel: ${group.stageDefs.map((s) => s.agent).join(", ")}`);

      for (const s of group.stageDefs) {
        taskStore.updateStage(task.id, s.name, { status: "running", startedAt: new Date().toISOString() });
      }

      const isDesignGroup = group.stageDefs[0]?.category === "design";
      const parallelPromises = group.stageDefs.map(async (stage) => {
        let stagePrompt = task.prompt;
        if (stage.category === "design" && designFeedback) {
          stagePrompt += `\n\n## Feedback from previous coding pass\n${designFeedback}`;
        }

        const briefKey = stage.agent;
        const config: AgentRunConfig = {
          ...baseConfig,
          prompt: stagePrompt,
          agentType: stage.agent,
          category: stage.category,
          workspaceReady: true,
          trivial: isTrivial,
          upstreamResults: upstreamResults.length > 0 ? [...upstreamResults] : undefined,
          agentBrief: agentBriefs[briefKey] || agentBriefs[stage.name] || null,
          parallelDesign: isDesignGroup || undefined,
        };

        return runAgent(config, workDir, (event) => {
          if (event.type === "progress") {
            taskStore.emitStageProgress(task.id, stage.name, {
              elapsedSeconds: event.elapsedSeconds,
              filesEdited: event.filesEdited,
            });
          } else {
            taskStore.updateStage(task.id, stage.name, { status: "running" });
          }
        }, signal);
      });

      const parallelResults = await Promise.all(parallelPromises);

      if (signal.aborted) {
        log.warn("Cancelled during parallel stages", undefined, "status");
        taskStore.cleanupAbort(task.id);
        return;
      }

      let allSucceeded = true;
      for (let i = 0; i < group.stageDefs.length; i++) {
        const stage = group.stageDefs[i];
        const result = parallelResults[i];
        upstreamResults.push(result);

        if (result.success) {
          taskStore.updateStage(task.id, stage.name, {
            status: "succeeded",
            completedAt: new Date().toISOString(),
            filesModified: result.filesModified,
            durationMs: result.durationMs,
            tokenUsage: result.tokenUsage,
            estimatedCost: result.estimatedCost,
          });
        } else {
          allSucceeded = false;
          taskStore.updateStage(task.id, stage.name, {
            status: "failed",
            completedAt: new Date().toISOString(),
            errors: result.errors,
            durationMs: result.durationMs,
          });
        }
      }

      if (!allSucceeded) {
        const failedNames = group.stageDefs.filter((_, i) => !parallelResults[i].success).map((s) => s.name);
        taskStore.updateTaskStatus(task.id, TaskStatus.Failed, `Parallel stages failed: ${failedNames.join(", ")}`);
        taskStore.cleanupAbort(task.id);
        return;
      }

      // Merge parallel design outputs if this was a design group
      if (group.stageDefs[0]?.category === "design" && group.stageDefs.length > 1) {
        await mergeDesignOutputs(workDir, parallelResults);
        taskStore.emit_log(task.id, `Merged ${group.stageDefs.length} design documents`);

        // Design approval after merge
        if (task.requireDesignApproval) {
          const summary = await bigBossSummarize(workDir, "DESIGN.md", "design");
          const designPreview = await readDesignPreview(workDir);
          log.info("Design approval requested (post-merge)", undefined, "flow");

          const approval: ApprovalResponse = await taskStore.requestApproval(
            task.id, summary, { approvalType: "design", designPreview },
          );

          if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

          if (approval.action === "reject") {
            taskStore.updateTaskStatus(task.id, TaskStatus.Failed, "Design rejected by user");
            taskStore.cleanupAbort(task.id);
            return;
          }

          if (approval.action === "revise" && designLoops < MAX_DESIGN_LOOPS) {
            designLoops++;
            designFeedback = approval.feedback || "User requested design changes.";
            taskStore.emit_log(task.id, `Design revision ${designLoops}: ${designFeedback}`);
            for (const s of group.stageDefs) {
              taskStore.updateStage(task.id, s.name, { status: "pending" as const });
            }
            continue;
          }
        }
      }
    } else {
      // --- Sequential stage execution (single stage in group) ---
      const stage = group.stageDefs[0];

      if (stage.category === "release" && !task.repo) {
        log.info("Release stage skipped (no repo configured)", undefined, "status");
        taskStore.emit_log(task.id, "Release skipped (no repo configured)");
        taskStore.updateStage(task.id, stage.name, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          notes: "Skipped (no repo configured)",
        });
        upstreamResults.push({
          agent: "release",
          success: true,
          output: "",
          parsed: { assistantMessage: "", filesWritten: [], shellCommands: [], errors: [], tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
          filesModified: [],
          errors: [],
          durationMs: 0,
        });
        groupIndex++;
        continue;
      }

      log.info(`Stage ${stage.name} started (agent: ${stage.agent})`, { stage: stage.name, agent: stage.agent }, "status");

      taskStore.updateStage(task.id, stage.name, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      try {
        let stagePrompt = task.prompt;
        if (stage.category === "design" && designFeedback) {
          stagePrompt += `\n\n## Feedback from previous coding pass\nIncorporate these notes into the revised design:\n${designFeedback}`;
        }

        const briefKey = stage.name === "validation" ? "testing" : stage.name;
        const releaseBrief = stage.category === "release"
          ? `Target base branch for PR: ${task.baseBranch}. Use this for \`git log ${task.baseBranch}..HEAD\` and \`gh pr create --base ${task.baseBranch}\`.`
          : null;
        const config: AgentRunConfig = {
          ...baseConfig,
          prompt: stagePrompt,
          agentType: stage.agent,
          category: stage.category,
          workspaceReady: true,
          trivial: isTrivial,
          upstreamResults: upstreamResults.length > 0
            ? [...upstreamResults]
            : undefined,
          agentBrief: releaseBrief ?? agentBriefs[briefKey] ?? agentBriefs[stage.agent] ?? null,
        };

        const result = await runAgent(config, workDir, (event) => {
          const current = taskStore.getTask(task.id);
          if (!current) return;
          if (event.type === "progress") {
            taskStore.emitStageProgress(task.id, stage.name, {
              elapsedSeconds: event.elapsedSeconds,
              filesEdited: event.filesEdited,
            });
          } else {
            taskStore.updateStage(task.id, stage.name, { status: "running" });
          }
        }, signal);

        if (signal.aborted) {
          log.warn(`Cancelled during ${stage.name}`, undefined, "status");
          taskStore.cleanupAbort(task.id);
          return;
        }

        upstreamResults.push(result);

        if (result.success) {
          const stageUpdate: Partial<StageStatus> = {
            status: "succeeded",
            completedAt: new Date().toISOString(),
            filesModified: result.filesModified,
            durationMs: result.durationMs,
            tokenUsage: result.tokenUsage,
            estimatedCost: result.estimatedCost,
          };

          if (stage.category === "coding") {
            const notes = await readCodingNotes(workDir);
            if (notes) {
              stageUpdate.notes = notes;
              log.debug(`CODING_NOTES.md found (${notes.length} chars)`);
            }
          }

          taskStore.updateStage(task.id, stage.name, stageUpdate);
          log.info(`Stage ${stage.name} completed: ${result.filesModified?.length ?? 0} files, ${(result.durationMs / 1000).toFixed(1)}s, $${result.estimatedCost?.toFixed(4) ?? "N/A"}`, { stage: stage.name, files: result.filesModified?.length ?? 0, durationMs: result.durationMs, cost: result.estimatedCost }, "output");

          // --- Design approval gate ---
          if (stage.category === "design" && task.requireDesignApproval) {
            const summary = await bigBossSummarize(workDir, "DESIGN.md", "design");
            const designPreview = await readDesignPreview(workDir);
            log.info("Design approval requested", undefined, "flow");

            const approval: ApprovalResponse = await taskStore.requestApproval(
              task.id, summary, { approvalType: "design", designPreview },
            );

            if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

            if (approval.action === "reject") {
              taskStore.updateTaskStatus(task.id, TaskStatus.Failed, "Design rejected by user");
              taskStore.cleanupAbort(task.id);
              return;
            }

            if (approval.action === "revise" && designLoops < MAX_DESIGN_LOOPS) {
              designLoops++;
              designFeedback = approval.feedback || "User requested design changes.";
              log.info(`Design revision requested (loop ${designLoops})`, { feedback: designFeedback }, "flow");
              taskStore.emit_log(task.id, `Design revision ${designLoops}: ${designFeedback}`);
              taskStore.updateStage(task.id, stage.name, { status: "pending" as const });
              continue;
            }

            log.info("User approved design", undefined, "flow");
          }

          // --- Coding: lint check ---
          if (stage.category === "coding") {
            const lint = await runLintCheck(workDir);
            if (lint && !lint.passed) {
              log.warn("Lint/build failed, running fix-up pass...", { command: lint.command }, "status");
              taskStore.emit_log(task.id, `Lint check failed (${lint.command}), running fix-up pass...`);

              const fixConfig: AgentRunConfig = {
                ...baseConfig,
                agentType: stage.agent,
                category: "coding",
                workspaceReady: true,
                trivial: true,
                prompt: `${task.prompt}\n\nIMPORTANT: The previous coding pass produced lint/build errors. Fix them.\n\nCommand: ${lint.command}\nErrors:\n${lint.output}`,
                upstreamResults: [...upstreamResults],
              };

              const fixResult = await runAgent(fixConfig, workDir, undefined, signal);
              upstreamResults.push(fixResult);

              const retryLint = await runLintCheck(workDir);
              if (retryLint && !retryLint.passed) {
                log.warn("Lint still failing after fix-up pass", { output: retryLint.output.slice(0, 200) }, "status");
                taskStore.emit_log(task.id, `Lint still failing after fix-up: ${retryLint.output.slice(0, 200)}`);
              } else {
                log.info("Lint/build clean after fix-up pass", undefined, "status");
                taskStore.emit_log(task.id, "Code compiles cleanly after fix-up pass.");
              }
            } else if (lint?.passed) {
              log.info(`Lint/build passed (${lint.command})`, undefined, "status");
              taskStore.emit_log(task.id, `Code compiles cleanly (${lint.command}).`);
            }
          }

          // --- Coding: feedback loop ---
          if (stage.category === "coding" && task.requireDesignApproval) {
            const notes = await readCodingNotes(workDir);
            if (notes && designLoops < MAX_DESIGN_LOOPS) {
              const feedbackSummary = await bigBossSummarize(workDir, "CODING_NOTES.md", "feedback");
              log.info("Presenting coding feedback for review", undefined, "flow");

              const feedbackApproval: ApprovalResponse = await taskStore.requestApproval(
                task.id, feedbackSummary,
                { approvalType: "feedback", feedbackPreview: notes.slice(0, 600) },
              );

              if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

              if (feedbackApproval.action === "redesign") {
                designLoops++;
                designFeedback = notes;
                log.info(`Re-running design with coding feedback (loop ${designLoops})`, undefined, "flow");
                taskStore.emit_log(task.id, `Re-running design with coding feedback (loop ${designLoops})`);

                const designGroupIdx = stageGroups.findIndex((g) => g.stageDefs.some((s) => s.category === "design"));
                if (designGroupIdx >= 0) {
                  for (const s of stageGroups[designGroupIdx].stageDefs) {
                    taskStore.updateStage(task.id, s.name, { status: "pending" as const });
                  }
                  taskStore.updateStage(task.id, stage.name, { status: "pending" as const });
                  groupIndex = designGroupIdx;
                  continue;
                }
              }
              log.info("Continuing to next stage (feedback acknowledged)", undefined, "flow");
            }
          }
        } else {
          taskStore.updateStage(task.id, stage.name, {
            status: "failed",
            completedAt: new Date().toISOString(),
            errors: result.errors,
            durationMs: result.durationMs,
          });

          taskStore.updateTaskStatus(
            task.id,
            TaskStatus.Failed,
            `Stage "${stage.name}" failed: ${result.errors.join("; ")}`,
          );
          taskStore.cleanupAbort(task.id);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        taskStore.updateStage(task.id, stage.name, {
          status: "failed",
          completedAt: new Date().toISOString(),
          errors: [message],
        });
        taskStore.updateTaskStatus(
          task.id,
          TaskStatus.Failed,
          `Stage "${stage.name}" threw: ${message}`,
        );
        taskStore.cleanupAbort(task.id);
        return;
      }
    }

    groupIndex++;
  }

  if (task.repo) {
    const push = pushBranch(workDir, task.branch);
    if (push.pushed) {
      log.info(`Pushed ${task.branch} to origin`, undefined, "output");
    } else {
      log.warn(`Push failed: ${push.error}`, undefined, "error");
    }
  }

  const totalFiles = upstreamResults.reduce((n, r) => n + (r.filesModified?.length ?? 0), 0);
  const totalMs = upstreamResults.reduce((n, r) => n + r.durationMs, 0);
  log.info(`Pipeline complete: ${totalFiles} files modified, ${(totalMs / 1000).toFixed(1)}s total`, { totalFiles, totalMs }, "output");

  taskStore.cleanupAbort(task.id);
  taskStore.updateTaskStatus(task.id, TaskStatus.Completed);
}
