import * as path from "path";
import { promises as fs, accessSync, readFileSync } from "fs";
import { execSync as cpExecSync, spawn } from "child_process";
import { TaskStatus, createLogger } from "@agents/shared";
import { taskStore, RuntimeTask, StageStatus, ApprovalResponse } from "./task-store";
import {
  runAgent,
  setupWorkspace,
  pushBranch,
  readCodingNotes,
  runLintCheck,
  buildContextBrief,
  AgentRunConfig,
  AgentRunResult,
} from "./agent-runner";
import { createCursorSessionRegistry, type CursorSessionRegistry } from "./cursor-session-registry";
import { loadOrBuildCache, getCacheBrief } from "./context-cache";
import { parseCodingNotes, shouldLoopOnFeedback } from "./feedback-criteria";
import {
  planWithBigBoss,
  bigBossSummarize,
  overseerPostDesignReview,
  overseerPostCodeReview,
  getBigBossModel,
  getMergeModel,
  MAX_OVERSEER_DESIGN_ITERATIONS,
  MAX_OVERSEER_CODE_ITERATIONS,
  MAX_LOVE_TEST_FIX_ITERATIONS,
  type BigBossResult,
} from "./bigboss-director";
import {
  generateRequirementsArtifact,
  appendRequirementsUserRevision,
  ensureDesignReferencesRequirements,
  runLoveSmokeChecklistOpenAI,
} from "./requirements-artifact";
import { bootstrapConstitutionFromTask } from "./constitution-artifact";
import { writeTasksMd } from "./tasks-artifact";
import { isArtefactSchemaV2 } from "./artefact-schema";
import { mergeSpecContributions } from "./spec-artifact";
import {
  mergePlanContributions,
  mergeResearchContributions,
  mergeDataModelContributions,
  collectContracts,
} from "./plan-artifact";
import { writeChecklistsMd } from "./checklists-artifact";
import { runClarifyStage } from "./clarify-stage";
import { runAnalyzeStage } from "./analyze-stage";
import { runChecklistStage } from "./checklist-stage";
import {
  FULL_STAGES,
  RELEASE_STAGE,
  stagesForMode,
  groupStages,
  resolveSkillsRoot,
  inferStackFromAgents,
  injectPostDesignGameArt,
  injectV2OverseerStages,
  type StageDefinition,
  type PipelineStack,
} from "./pipeline-stages";

/** Placeholder upstream row when a parallel designer is skipped on a targeted gaps re-run (file on disk retained). */
function syntheticRetainedDesignResult(agent: string): AgentRunResult {
  return {
    agent,
    success: true,
    output: "",
    parsed: {
      assistantMessage: "",
      filesWritten: [],
      shellCommands: [],
      errors: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    },
    filesModified: [],
    errors: [],
    durationMs: 0,
  };
}

/**
 * When Overseer gaps map to a non-empty proper subset of parallel designers, re-run only those agents.
 * Returns null if gapsByAgent is missing, invalid, or covers all designers (same as full re-run).
 */
function computePartialDesignRerunAgents(
  stageDefs: StageDefinition[],
  gapsByAgent: Record<string, string> | undefined,
): string[] | null {
  if (!gapsByAgent) return null;
  const keys = Object.keys(gapsByAgent).filter(
    (k) => typeof gapsByAgent[k] === "string" && gapsByAgent[k].trim().length > 0,
  );
  if (keys.length === 0) return null;
  const inGroup = new Set(stageDefs.map((s) => s.agent));
  if (!keys.every((k) => inGroup.has(k))) return null;
  if (keys.length >= inGroup.size) return null;
  return keys;
}

/** Remove upstream results for agents that will be re-run (parallel group is last N entries). */
function spliceParallelUpstreamForRerun(
  upstreamResults: AgentRunResult[],
  stageDefs: StageDefinition[],
  agentsToRerun: Set<string>,
): void {
  const n = stageDefs.length;
  const offset = upstreamResults.length - n;
  if (offset < 0 || n === 0) return;
  for (let i = n - 1; i >= 0; i--) {
    const agent = stageDefs[i].agent;
    if (agentsToRerun.has(agent)) {
      upstreamResults.splice(offset + i, 1);
    }
  }
}

function normaliseOverseerFocusPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim())
    .slice(0, 25);
}

function formatOverseerFocusPaths(paths: string[]): string {
  if (paths.length === 0) return "";
  const lines = paths.map((p) => `- ${p}`);
  return `\n\nPrefer edits under these paths (repo-relative):\n${lines.join("\n")}`;
}

function prependOriginalTaskToDesign(workDir: string, designContent: string, originalTask: string): string {
  const header = "## Original task (source of truth)\n\n" + originalTask.trim() + "\n\n---\n\n";
  return header + designContent;
}

async function mergeDesignOutputs(
  workDir: string,
  results: AgentRunResult[],
  sessionRegistry: CursorSessionRegistry,
  originalTask?: string,
  skillsRoot?: string,
  pipelineId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const designFiles: Array<{ agent: string; content: string }> = [];

  for (const r of results) {
    const agentDesignPath = path.join(workDir, ".pipeline", `${r.agent}-design.md`);
    try {
      const content = await fs.readFile(agentDesignPath, "utf-8");
      if (content.trim()) {
        designFiles.push({ agent: r.agent, content });
      }
    } catch {
      /* agent didn't produce a per-agent design file */
    }
  }

  if (designFiles.length === 0) {
    try {
      const content = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
      if (content.trim()) {
        designFiles.push({ agent: "design", content });
      }
    } catch {
      /* no design output at all */
    }
  }

  const writeDesign = async (content: string) => {
    const final = originalTask ? prependOriginalTaskToDesign(workDir, content, originalTask) : content;
    await fs.writeFile(path.join(workDir, "DESIGN.md"), final, "utf-8");
  };

  if (designFiles.length <= 1) {
    if (designFiles.length === 1) {
      await writeDesign(designFiles[0].content);
    }
    return;
  }

  if (skillsRoot && pipelineId && originalTask) {
    const bigBossSession = await sessionRegistry.getOrCreate("bigboss");
    const agentMerged = await mergeDesignWithAgent(
      workDir, designFiles, originalTask, skillsRoot, pipelineId, signal, bigBossSession,
    );
    if (agentMerged) return;
    createLogger("orchestrator").info("Agent-based merge failed, falling back to API merge", undefined, "flow");
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const inputs = designFiles.map((d) =>
        `## ${d.agent} design\n${d.content.slice(0, 16000)}`,
      ).join("\n\n---\n\n");

      const mergeModel = getMergeModel();
      const response = await client.chat.completions.create({
        model: mergeModel,
        messages: [
          {
            role: "system",
            content: "You are merging multiple design documents from parallel agents into a single unified DESIGN.md. Combine all sections, resolve conflicts by preferring the more specific/detailed version, and produce a coherent document. Maintain markdown formatting. Preserve every requirement from the source documents; do not drop items from requirements checklists or from bullet lists. If documents have a requirementsChecklist or similar section, include it in full in the merged DESIGN.md.",
          },
          { role: "user", content: inputs },
        ],
        max_tokens: 8192,
        temperature: 0.2,
      });

      const merged = response.choices[0]?.message?.content;
      if (merged) {
        await writeDesign(merged);
        createLogger("orchestrator").info(`Merged ${designFiles.length} design documents via OpenAI (${mergeModel})`, undefined, "flow");
        return;
      }
    } catch (err) {
      createLogger("orchestrator").warn("OpenAI merge failed, using concatenation", { err: String(err) });
    }
  }

  const concatenated = designFiles.map((d) =>
    `# ${d.agent} Design\n\n${d.content}`,
  ).join("\n\n---\n\n");
  await writeDesign(concatenated);
  createLogger("orchestrator").info(`Concatenated ${designFiles.length} design documents`, undefined, "flow");
}

async function readDesignPreview(workDir: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
    return content.slice(0, 8000);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Spec-kit Tier 2 PR1 — v2 artefact writers (gated by ARTEFACT_SCHEMA=v2)
// ---------------------------------------------------------------------------

/**
 * Run the v2 artefact writers (spec.md, plan.md, optional research.md /
 * data-model.md / contracts/, plus CHECKLISTS.md) in addition to today's
 * DESIGN.md. No-op when ARTEFACT_SCHEMA is unset or "v1".
 *
 * PR1 transition: when designers haven't been updated to write per-artefact
 * `.pipeline/<agent>-{spec,plan}.md` files yet, mergeSpecContributions /
 * mergePlanContributions fall back to deriving the body from the merged
 * DESIGN.md so the v2 artefacts still appear in the workspace. DESIGN.md is
 * NOT overwritten in PR1 — the compat shim (writeDesignCompatShim) is reserved
 * for a follow-up PR once at least one designer is producing per-artefact
 * outputs.
 */
async function runV2ArtefactWriters(
  taskId: string,
  workDir: string,
  agents: string[],
  originalTask: string,
  stack: PipelineStack,
): Promise<void> {
  if (!isArtefactSchemaV2()) return;
  const log = createLogger("artefact-v2");
  try {
    const specResult = await mergeSpecContributions(workDir, agents, originalTask);
    if (specResult.merged) {
      taskStore.emit_log(taskId, `Wrote spec.md (sources: ${specResult.sources.join(", ")}).`);
    }
    const planResult = await mergePlanContributions(workDir, agents);
    if (planResult.merged) {
      taskStore.emit_log(taskId, `Wrote plan.md (sources: ${planResult.sources.join(", ")}).`);
    }
    const researchWritten = await mergeResearchContributions(workDir, agents);
    if (researchWritten) taskStore.emit_log(taskId, "Wrote research.md.");
    const dataModelWritten = await mergeDataModelContributions(workDir, agents);
    if (dataModelWritten) taskStore.emit_log(taskId, "Wrote data-model.md.");
    const contractsCopied = await collectContracts(workDir, agents);
    if (contractsCopied > 0) {
      taskStore.emit_log(taskId, `Collected ${contractsCopied} contract file(s) into contracts/.`);
    }
    const checklists = await writeChecklistsMd({ workDir, stack, originalTask });
    taskStore.emit_log(
      taskId,
      `Wrote CHECKLISTS.md (${checklists.itemCount} items, ${checklists.usedOpenAI ? "openai" : "fallback"}).`,
    );
  } catch (err) {
    log.warn("v2 artefact writers failed (non-fatal)", { err: String(err) });
  }
}

// ---------------------------------------------------------------------------
// R3: Execution verification -- attempt to run the project and capture errors
// ---------------------------------------------------------------------------

interface ExecVerifyResult {
  passed: boolean;
  command: string;
  output: string;
}

const LOVE_RUNTIME_VERIFY_TIMEOUT_MS = 10_000;

async function loveRuntimeCheck(
  workDir: string,
  log: ReturnType<typeof createLogger>,
): Promise<ExecVerifyResult> {
  const loveCmd = "love";
  const runCmd = "love .";

  try {
    cpExecSync(`${loveCmd} --version`, { stdio: "pipe" });
  } catch {
    log.info("love not available, skipping runtime verify", undefined, "flow");
    return { passed: true, command: `${runCmd} (skipped)`, output: "" };
  }

  return new Promise<ExecVerifyResult>((resolve) => {
    let settled = false;
    const once = (result: ExecVerifyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(loveCmd, ["."], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      log.info(`Exec verify passed: ${runCmd} (no crash within ${LOVE_RUNTIME_VERIFY_TIMEOUT_MS / 1000}s)`, undefined, "flow");
      once({ passed: true, command: runCmd, output: "" });
    }, LOVE_RUNTIME_VERIFY_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        const output = (stderr + "\n" + stdout).trim().slice(0, 4000);
        log.warn(`Exec verify failed: ${runCmd}`, { output: output.slice(0, 200) }, "flow");
        once({ passed: false, command: runCmd, output });
      } else {
        log.info(`Exec verify passed: ${runCmd}`, undefined, "flow");
        once({ passed: true, command: runCmd, output: "" });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      const output = (err.message || String(err)).slice(0, 4000);
      log.warn(`Exec verify error: ${runCmd}`, { err: output.slice(0, 200) }, "flow");
      once({ passed: false, command: runCmd, output });
    });
  });
}

async function tryRunProject(workDir: string): Promise<ExecVerifyResult | null> {
  const log = createLogger("exec-verify");

  const hasFile = (name: string): boolean => {
    try { accessSync(path.join(workDir, name)); return true; } catch { return false; }
  };

  let command: string | null = null;
  const isLove = hasFile("main.lua") && hasFile("conf.lua");

  if (isLove) {
    const hasSrc = hasFile("src");
    if (process.platform === "win32") {
      command = hasSrc
        ? "luac -p main.lua && for /r src %f in (*.lua) do luac -p %f"
        : "luac -p main.lua";
    } else {
      command = hasSrc
        ? "luac -p main.lua && find src -name '*.lua' -exec luac -p {} +"
        : "luac -p main.lua";
    }
    try {
      cpExecSync("luac -v", { cwd: workDir, stdio: "pipe" });
    } catch {
      command = null;
      log.info("luac not available, skipping Lua syntax check", undefined, "flow");
    }
  } else if (hasFile("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(workDir, "package.json"), "utf-8"));
      if (pkg.scripts?.build) {
        command = "npm run build";
      } else if (pkg.scripts?.start) {
        command = "npm run start -- --help 2>&1 || true";
      }
    } catch {
      /* can't read package.json */
    }
  }

  if (!command) return null;

  try {
    const buf = cpExecSync(command, {
      cwd: workDir,
      stdio: "pipe",
      timeout: 30_000,
    });
    const output = buf.toString().slice(0, 4000);
    log.info(`Exec verify passed: ${command}`, undefined, "flow");

    if (isLove && process.env.LOVE_RUNTIME_VERIFY === "1") {
      const loveResult = await loveRuntimeCheck(workDir, log);
      if (!loveResult.passed) return loveResult;
    }

    return { passed: true, command, output };
  } catch (err: unknown) {
    const output = ((err as { stderr?: Buffer })?.stderr?.toString() || (err as Error)?.message || "").slice(0, 4000);
    log.warn(`Exec verify failed: ${command}`, { output: output.slice(0, 200) }, "flow");
    return { passed: false, command, output };
  }
}

const MAX_SUB_TASKS = 3;
const MAX_REQUIREMENTS_APPROVAL_LOOPS = 5;

async function decomposeTask(
  workDir: string,
  originalTask: string,
  stack: PipelineStack,
): Promise<string[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const log = createLogger("task-decomp");

  try {
    const designContent = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
    const designSlice = designContent.slice(0, 16000);
    let requirementsSlice = "";
    try {
      requirementsSlice = (await fs.readFile(path.join(workDir, "REQUIREMENTS.md"), "utf-8")).slice(0, 4000);
    } catch {
      /* optional */
    }

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();

    const loveSystem = `You decompose complex LÖVE2D / Lua game tasks into ${MAX_SUB_TASKS} sequential coding sub-tasks. Each sub-task builds on the previous one's output. The coder receives the full DESIGN.md (and REQUIREMENTS.md if present) on disk — specify what to implement each pass, do not paste the whole design.

Respond with JSON: { "subTasks": ["task 1 instructions", "task 2 instructions", "task 3 instructions"] }

LÖVE ordering (gameplay before chrome):
- Sub-task 1: Session/bootstrap (love.load/update/draw shell), persistence if REQUIREMENTS or task ask for cross-run scores (love.filesystem), minimal menu/scene flow, **primary input locomotion + aim** so the player character moves reliably before hybrid/extra schemes, one weapon or minimal combat stub — must be playable.
- Sub-task 2: Map / procedural rules, weapons, damage, turns or core loop, second-player input if required by design.
- Sub-task 3: HUD, polish, distinct readability for projectiles/characters (sprites, VFX, trails), extra input modes only after primary mode works.

Each sub-task must leave the game runnable. Reference DESIGN.md on disk for detail.`;

    const webSystem = `You decompose complex game/application tasks into ${MAX_SUB_TASKS} sequential coding sub-tasks. Each sub-task builds on the previous one's output. The coder receives the full DESIGN.md on disk, so do not repeat the design -- just specify what to implement in each pass.

Respond with JSON: { "subTasks": ["task 1 instructions", "task 2 instructions", "task 3 instructions"] }

Guidelines:
- Sub-task 1: Core structure, entry point, configuration, basic state machine/scene management
- Sub-task 2: Main gameplay/feature implementation, entities, game logic, UI screens  
- Sub-task 3: Polish -- audio, visual effects, edge cases, input handling refinement, final integration
- Each sub-task must be self-contained and produce working code
- Reference the DESIGN.md for details (the coder will read it from disk)`;

    const userParts = [`## Original task\n\n${originalTask.slice(0, 6000)}`, `## Design summary\n\n${designSlice}`];
    if (requirementsSlice.trim()) {
      userParts.push(`## REQUIREMENTS.md (excerpt)\n\n${requirementsSlice}`);
    }

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: stack === "love" ? loveSystem : webSystem,
        },
        {
          role: "user",
          content: userParts.join("\n\n"),
        },
      ],
      max_tokens: 2048,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.subTasks) || parsed.subTasks.length === 0) return null;
    log.info(`Decomposed into ${parsed.subTasks.length} sub-tasks`, undefined, "flow");
    return parsed.subTasks.slice(0, MAX_SUB_TASKS);
  } catch (err) {
    log.warn("Task decomposition failed", { err: String(err) }, "flow");
    return null;
  }
}

async function mergeDesignWithAgent(
  workDir: string,
  designFiles: Array<{ agent: string; content: string }>,
  originalTask: string,
  skillsRoot: string,
  pipelineId: string,
  signal?: AbortSignal,
  cursorSessionId?: string | null,
): Promise<boolean> {
  const log = createLogger("design-merge");

  const fileList = designFiles.map((d) => `.pipeline/${d.agent}-design.md`).join(", ");
  const agentPrompt = `Merge the following parallel design documents into a single unified DESIGN.md:
${fileList}

Read each file from disk using your filesystem tool. Combine all sections, resolve conflicts
by preferring the more specific/detailed version, and produce a coherent DESIGN.md file.

CRITICAL: Preserve EVERY requirement from ALL source documents. Do not drop items from
requirements checklists or bullet lists. If documents have a requirementsChecklist or
similar section, include ALL items in the merged output.

Write the merged result to DESIGN.md in the workspace root.

## Original task (include this at the top of DESIGN.md)

${originalTask}`;

  try {
    const config: AgentRunConfig = {
      agentType: "bigboss",
      category: "coding",
      prompt: agentPrompt,
      pipelineId,
      skillsRoot,
      baseBranch: "main",
      branch: "design-merge",
      workspaceReady: true,
      trivial: true,
      cursorSessionId,
    };

    log.info(`Running agent-based design merge for ${designFiles.length} files`, undefined, "flow");
    const result = await runAgent(config, workDir, undefined, signal);
    if (result.success) {
      try {
        const designPath = path.join(workDir, "DESIGN.md");
        let content = await fs.readFile(designPath, "utf-8");
        if (!content.startsWith("## Original task")) {
          content = prependOriginalTaskToDesign(workDir, content, originalTask);
          await fs.writeFile(designPath, content, "utf-8");
        }
        log.info("Agent-based design merge succeeded", undefined, "flow");
        return true;
      } catch {
        log.warn("Agent merge ran but DESIGN.md not found or unreadable", undefined, "flow");
        return false;
      }
    }
    log.warn("Agent-based design merge failed", undefined, "flow");
    return false;
  } catch (err) {
    log.warn("Agent-based design merge error", { err: String(err) }, "flow");
    return false;
  }
}

const MAX_DESIGN_LOOPS = 2;

export async function runPipeline(task: RuntimeTask): Promise<void> {
  const skillsRoot = resolveSkillsRoot();
  const upstreamResults: AgentRunResult[] = [];
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

  // Spec-kit-style per-project constitution. No-op when the file already exists or
  // when CONSTITUTION_BOOTSTRAP is not set. The loaded text is injected into every
  // agent prompt by agent-runner.buildFullPrompt() via formatConstitutionForPrompt().
  try {
    const bootstrap = await bootstrapConstitutionFromTask(workDir, task.prompt);
    if (bootstrap.written && bootstrap.pathRelative) {
      taskStore.emit_log(task.id, `Bootstrapped project constitution at ${bootstrap.pathRelative}.`);
    }
  } catch (err) {
    log.warn("Constitution bootstrap failed (non-fatal)", { err: String(err) });
  }

  let cacheBrief = "";
  try {
    const brief = buildContextBrief("planning", workDir);
    const cache = await loadOrBuildCache(workDir, brief.techStack);
    cacheBrief = getCacheBrief(cache);
    log.info(`Context cache: ${cache.files.length} files indexed`, { files: cache.files.length }, "status");
  } catch (err) {
    log.warn("Context cache build failed (non-fatal)", { err: String(err) });
  }

  const sessionRegistry = createCursorSessionRegistry(workDir, task.id, log);
  log.info("Cursor agent sessions", { mode: sessionRegistry.getMode() }, "flow");

  await generateRequirementsArtifact(workDir, task.prompt);
  taskStore.emit_log(task.id, "Generated REQUIREMENTS.md from the task prompt.");

  if (task.requireRequirementsApproval) {
    for (let reqLoop = 0; ; reqLoop++) {
      if (reqLoop >= MAX_REQUIREMENTS_APPROVAL_LOOPS) {
        taskStore.updateTaskStatus(task.id, TaskStatus.Failed, "Requirements approval: max revision rounds exceeded");
        taskStore.cleanupAbort(task.id);
        return;
      }
      let requirementsPreview = "";
      try {
        requirementsPreview = (await fs.readFile(path.join(workDir, "REQUIREMENTS.md"), "utf-8")).slice(0, 8000);
      } catch {
        requirementsPreview = "(REQUIREMENTS.md missing)";
      }
      const summary = "Review extracted requirements before design and coding. Approve to continue, request changes to append your notes to REQUIREMENTS.md, or reject to stop the pipeline.";
      const approval = await taskStore.requestApproval(task.id, summary, {
        approvalType: "requirements",
        requirementsPreview,
      });

      if (signal.aborted) {
        taskStore.cleanupAbort(task.id);
        return;
      }

      if (!approval.approved || approval.action === "reject") {
        taskStore.updateTaskStatus(task.id, TaskStatus.Failed, "Requirements rejected by user");
        taskStore.cleanupAbort(task.id);
        return;
      }

      if (approval.action === "revise" && approval.feedback?.trim()) {
        await appendRequirementsUserRevision(workDir, approval.feedback);
        taskStore.emit_log(task.id, "REQUIREMENTS.md updated from your revision notes.");
        continue;
      }

      break;
    }
  }

  let stages: StageDefinition[];
  let complexity: "trivial" | "moderate" | "complex" = "moderate";
  let agentBriefs: Record<string, string> = {};
  let planned: BigBossResult | null = null;

  if (task.pipelineMode === "auto") {
    planned = await planWithBigBoss(
      task.prompt,
      workDir,
      task.id,
      cacheBrief || undefined,
      task.pipelineMode,
      await sessionRegistry.getOrCreate("bigboss"),
    );
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

  stages = injectPostDesignGameArt(stages);
  if (stages.some((s) => s.agent === "game-art")) {
    log.info("Pipeline includes post-design game-art stage (LÖVE + OPENAI_API_KEY)", undefined, "flow");
  }

  // Spec-kit Tier 2 PR2 — promote the inline overseer reviews into discrete
  // `clarify` (post-design) and `analyze` (post-coding) stages when v2.
  // Idempotent and no-op for v1; CHECKLIST_STAGE waits for PR3.
  if (isArtefactSchemaV2()) {
    stages = injectV2OverseerStages(stages);
    if (stages.some((s) => s.category === "clarify" || s.category === "analyze")) {
      log.info("Pipeline includes spec-kit v2 overseer stages (clarify/analyze)", undefined, "flow");
    }
  }

  stages = [...stages, RELEASE_STAGE];

  const pipelineStack: PipelineStack = inferStackFromAgents(stages.map((s) => s.agent));

  const initialStages: StageStatus[] = stages.map((s) => ({
    name: s.name,
    agent: s.agent,
    status: "pending" as const,
  }));
  taskStore.setStages(task.id, initialStages);

  const parallelDesignForGroups = planned?.parallelDesign ?? false;
  let stageGroups = groupStages(stages, parallelDesignForGroups);
  const hasRelease = stageGroups.some((g) => g.stageDefs.some((s) => s.name === "release"));
  if (!hasRelease) {
    stageGroups = [...stageGroups, { name: "release", parallel: false, agents: [{ type: "release" }], stageDefs: [RELEASE_STAGE] }];
  }
  const isTrivial = complexity === "trivial";
  let designLoops = 0;
  let designFeedback: string | undefined;
  /** Overseer gaps routed to specific designer agent types (parallel re-run). */
  let designFeedbackByAgent: Record<string, string> | undefined;
  let designReviewIterations = 0;
  let codeReviewIterations = 0;
  let checklistFixUps = 0;
  let loveTestFixIterations = 0;
  /** Single-shot guard so the LOVE_SMOKE_CHECKLIST deprecation note is logged once per pipeline. */
  let loveSmokeDeprecationWarned = false;
  /** After Overseer design gaps: if non-null, next parallel design pass re-runs only these agent ids (subset of group). */
  let pendingPartialDesignRerun: string[] | null = null;
  let feedbackFingerprint: string | undefined;
  let groupIndex = 0;

  while (groupIndex < stageGroups.length) {
    if (signal.aborted) {
      log.warn("Pipeline cancelled by user", undefined, "status");
      taskStore.cleanupAbort(task.id);
      return;
    }

    const group = stageGroups[groupIndex];

    if (group.parallel && group.stageDefs.length > 1) {
      const agentsInGroup = group.stageDefs.map((s) => s.agent);
      let effectiveRerunAgents: string[];
      if (pendingPartialDesignRerun !== null) {
        const filtered = pendingPartialDesignRerun.filter((a) => agentsInGroup.includes(a));
        effectiveRerunAgents = filtered.length > 0 ? filtered : agentsInGroup;
        pendingPartialDesignRerun = null;
      } else {
        effectiveRerunAgents = agentsInGroup;
      }
      const rerunSet = new Set(effectiveRerunAgents);

      if (effectiveRerunAgents.length < agentsInGroup.length) {
        taskStore.emit_log(
          task.id,
          `Overseer design gaps: re-running only ${effectiveRerunAgents.join(", ")} (other designers’ .pipeline outputs kept).`,
        );
      }
      log.info(
        `Parallel group: ${group.stageDefs.map((s) => s.name).join(", ")}; executing ${effectiveRerunAgents.join(", ")}`,
        { agents: agentsInGroup },
        "status",
      );
      taskStore.emit_log(
        task.id,
        effectiveRerunAgents.length === agentsInGroup.length
          ? `Running ${agentsInGroup.length} agents in parallel: ${agentsInGroup.join(", ")}`
          : `Partial parallel run (${effectiveRerunAgents.length}/${agentsInGroup.length}): ${effectiveRerunAgents.join(", ")}`,
      );

      for (const s of group.stageDefs) {
        if (rerunSet.has(s.agent)) {
          taskStore.updateStage(task.id, s.name, { status: "running", startedAt: new Date().toISOString() });
        }
      }

      const isDesignGroup = group.stageDefs[0]?.category === "design";
      const stagesToRun = group.stageDefs.filter((s) => rerunSet.has(s.agent));

      const parallelPromises = stagesToRun.map(async (stage) => {
        let stagePrompt = task.prompt;
        if (stage.category === "design" && (designFeedback || designFeedbackByAgent)) {
          const scoped = designFeedbackByAgent?.[stage.agent];
          if (scoped) {
            stagePrompt += `\n\n## Overseer feedback for your role (${stage.agent})\n${scoped}`;
          } else if (designFeedback) {
            stagePrompt += `\n\n## Feedback to incorporate into your design\n${designFeedback}`;
          }
        }

        const briefKey = stage.agent;
        const cursorSessionId = await sessionRegistry.getOrCreate(stage.agent);
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
          cursorSessionId,
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

      const freshResults = await Promise.all(parallelPromises);

      if (signal.aborted) {
        log.warn("Cancelled during parallel stages", undefined, "status");
        taskStore.cleanupAbort(task.id);
        return;
      }

      const freshByAgent = new Map(stagesToRun.map((s, i) => [s.agent, freshResults[i]] as const));
      const parallelResultsOrdered: AgentRunResult[] = group.stageDefs.map((stage) => {
        const r = freshByAgent.get(stage.agent);
        return r ?? syntheticRetainedDesignResult(stage.agent);
      });

      for (const stage of group.stageDefs) {
        if (!rerunSet.has(stage.agent)) continue;
        const result = freshByAgent.get(stage.agent)!;
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
          taskStore.updateStage(task.id, stage.name, {
            status: "failed",
            completedAt: new Date().toISOString(),
            errors: result.errors,
            durationMs: result.durationMs,
          });
        }
      }

      let allSucceeded = true;
      for (const stage of stagesToRun) {
        const result = freshByAgent.get(stage.agent)!;
        if (!result.success) allSucceeded = false;
      }

      if (!allSucceeded) {
        const failedNames = stagesToRun.filter((s) => !freshByAgent.get(s.agent)!.success).map((s) => s.name);
        taskStore.updateTaskStatus(task.id, TaskStatus.Failed, `Parallel stages failed: ${failedNames.join(", ")}`);
        taskStore.cleanupAbort(task.id);
        return;
      }

      if (group.stageDefs[0]?.category === "design" && group.stageDefs.length > 1) {
        taskStore.emit_log(task.id, `Merging ${group.stageDefs.length} design documents…`);
        await mergeDesignOutputs(workDir, parallelResultsOrdered, sessionRegistry, task.prompt, skillsRoot, task.id, signal);
        taskStore.emit_log(task.id, `Merged ${group.stageDefs.length} design documents`);
        await ensureDesignReferencesRequirements(workDir);

        await runV2ArtefactWriters(
          task.id,
          workDir,
          group.stageDefs.map((s) => s.agent),
          task.prompt,
          pipelineStack,
        );

        try {
          const tasksResult = await writeTasksMd({
            workDir,
            originalTask: task.prompt,
            stages,
            stack: pipelineStack,
          });
          taskStore.emit_log(task.id, `Wrote TASKS.md (${tasksResult.taskCount} tasks).`);
        } catch (err) {
          log.warn("TASKS.md generation failed (non-fatal)", { err: String(err) });
        }

        // v2 splits this into a separate `clarify` stage (inserted by
        // injectV2OverseerStages); skip the inline review when v2 is on so the
        // overseer call only fires once per pipeline.
        if (isArtefactSchemaV2()) {
          // v2: design approval happens after the clarify stage so the user sees the
          // overseer's findings; nothing more to do here. Note the existing approval
          // block below is also gated on v1.
        } else {
        taskStore.emit_overseer_log(task.id, "BigBoss (Overseer): design review — comparing merged design to requirements…", {
          phase: "design-review",
          status: "running",
        });
        const designReview = await overseerPostDesignReview(
          workDir,
          task.prompt,
          skillsRoot,
          task.id,
          await sessionRegistry.getOrCreate("bigboss"),
          signal,
          { stack: pipelineStack },
        );
        taskStore.emit_overseer_log(
          task.id,
          designReview?.fit === "ok"
            ? "BigBoss (Overseer): design fits requirements."
            : designReview?.fit === "gaps"
              ? "BigBoss (Overseer): design gaps found; re-running affected designer(s)."
              : "BigBoss (Overseer): design review complete.",
          { phase: "design-review", status: "done", result: designReview?.fit === "ok" ? "ok" : designReview?.fit === "gaps" ? "gaps" : undefined },
        );
        if (designReview?.fit === "gaps" && designReviewIterations < MAX_OVERSEER_DESIGN_ITERATIONS) {
          designReviewIterations++;
          designFeedbackByAgent = undefined;
          let cleanedGapsByAgent: Record<string, string> | undefined;
          const rawByAgent = designReview.gapsByAgent;
          if (rawByAgent && typeof rawByAgent === "object") {
            const cleaned: Record<string, string> = {};
            for (const [k, v] of Object.entries(rawByAgent)) {
              if (typeof v === "string" && v.trim()) cleaned[k] = v.trim();
            }
            if (Object.keys(cleaned).length > 0) {
              designFeedbackByAgent = cleaned;
              cleanedGapsByAgent = cleaned;
            }
          }
          const partialAgents = computePartialDesignRerunAgents(group.stageDefs, cleanedGapsByAgent);
          pendingPartialDesignRerun = partialAgents;
          designFeedback = designReview.suggestedSubTask?.prompt
            ? `Overseer found design gaps; address these in your design:\n${designReview.suggestedSubTask.prompt}`
            : `Overseer found design gaps: ${(designReview.gaps || []).join("; ")}`;
          const gapList = (designReview.gaps || []).slice(0, 5).join("; ");
          const gapDetail = gapList ? ` Gaps: ${gapList}${(designReview.gaps?.length ?? 0) > 5 ? "…" : ""}` : "";
          const rerunLabel =
            partialAgents && partialAgents.length < group.stageDefs.length
              ? `Re-running designers: ${partialAgents.join(", ")}`
              : "Re-running all parallel designers";
          taskStore.emit_log(
            task.id,
            `Overseer design gaps (iteration ${designReviewIterations}). ${rerunLabel}.${gapDetail}`,
          );
          log.info("Overseer design gaps: scheduling designer re-run", { gaps: designReview.gaps, partialAgents }, "flow");
          const agentsToSplice = new Set(
            partialAgents && partialAgents.length > 0 ? partialAgents : group.stageDefs.map((s) => s.agent),
          );
          spliceParallelUpstreamForRerun(upstreamResults, group.stageDefs, agentsToSplice);
          for (const s of group.stageDefs) {
            if (agentsToSplice.has(s.agent)) {
              taskStore.updateStage(task.id, s.name, { status: "pending" as const });
            }
          }
          continue;
        } else if (designReview?.fit === "ok") {
          taskStore.emit_log(task.id, "Overseer design review: design fits requirements.");
        }

        if (task.requireDesignApproval) {
          const summary = await bigBossSummarize(workDir, "DESIGN.md", "design", skillsRoot);
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
            designFeedbackByAgent = undefined;
            designFeedback = approval.feedback || "User requested design changes.";
            taskStore.emit_log(task.id, `Design revision ${designLoops}: ${designFeedback}`);
            for (const s of group.stageDefs) {
              taskStore.updateStage(task.id, s.name, { status: "pending" as const });
            }
            continue;
          }
        }
        } // end of v1 inline overseer + approval block (gated by !isArtefactSchemaV2())
      }
    } else {
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

      // Spec-kit Tier 2 PR2 — `clarify` stage dispatch (v2 only). Replaces the
      // inline overseer-design-review block from the v1 design-merge branch.
      if (stage.category === "clarify") {
        const stageStart = new Date().toISOString();
        taskStore.updateStage(task.id, stage.name, { status: "running", startedAt: stageStart });

        const clarifyOutcome = await runClarifyStage({
          workDir,
          originalTask: task.prompt,
          skillsRoot,
          taskId: task.id,
          cursorSessionId: await sessionRegistry.getOrCreate("bigboss"),
          signal,
          stack: pipelineStack,
        });

        if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

        const clarifySummary = {
          fit: (clarifyOutcome.result?.fit ?? "ok") as "ok" | "gaps",
          gapCount: clarifyOutcome.result?.gaps?.length ?? 0,
          iteration: designReviewIterations,
          clarificationsAppended: clarifyOutcome.clarificationsAppended,
        };
        taskStore.updateStage(task.id, stage.name, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          notes: `Overseer clarify: ${clarifySummary.fit}${clarifySummary.gapCount ? ` (${clarifySummary.gapCount} gaps)` : ""}`,
          clarifyResult: clarifySummary,
        });

        if (clarifyOutcome.status === "gaps" && designReviewIterations < MAX_OVERSEER_DESIGN_ITERATIONS) {
          designReviewIterations++;
          designFeedbackByAgent = undefined;
          let cleanedGapsByAgent: Record<string, string> | undefined;
          const rawByAgent = clarifyOutcome.result?.gapsByAgent;
          if (rawByAgent && typeof rawByAgent === "object") {
            const cleaned: Record<string, string> = {};
            for (const [k, v] of Object.entries(rawByAgent)) {
              if (typeof v === "string" && v.trim()) cleaned[k] = v.trim();
            }
            if (Object.keys(cleaned).length > 0) {
              designFeedbackByAgent = cleaned;
              cleanedGapsByAgent = cleaned;
            }
          }
          designFeedback = clarifyOutcome.result?.suggestedSubTask?.prompt
            ? `Overseer found design gaps; address these in your design:\n${clarifyOutcome.result.suggestedSubTask.prompt}`
            : `Overseer found design gaps: ${(clarifyOutcome.result?.gaps || []).join("; ")}`;

          // Find the most recent design group and rewind to it. The design group
          // may be parallel (multiple stageDefs) or single — handle both.
          const designGroupIdx = stageGroups.findIndex(
            (g, i) => i < groupIndex && g.stageDefs.some((s) => s.category === "design"),
          );
          if (designGroupIdx >= 0) {
            const designGroup = stageGroups[designGroupIdx];
            const designAgents = designGroup.stageDefs.map((s) => s.agent);
            const partialAgents = computePartialDesignRerunAgents(designGroup.stageDefs, cleanedGapsByAgent);
            const agentsToSplice = new Set(
              partialAgents && partialAgents.length > 0 ? partialAgents : designAgents,
            );
            spliceParallelUpstreamForRerun(upstreamResults, designGroup.stageDefs, agentsToSplice);
            for (const s of designGroup.stageDefs) {
              if (agentsToSplice.has(s.agent)) {
                taskStore.updateStage(task.id, s.name, { status: "pending" as const });
              }
            }
            // Mark the just-completed clarify stage pending again so it re-runs after re-merge.
            taskStore.updateStage(task.id, stage.name, { status: "pending" as const });

            const gapList = (clarifyOutcome.result?.gaps || []).slice(0, 5).join("; ");
            const gapDetail = gapList ? ` Gaps: ${gapList}${(clarifyOutcome.result?.gaps?.length ?? 0) > 5 ? "…" : ""}` : "";
            const rerunLabel =
              partialAgents && partialAgents.length < designGroup.stageDefs.length
                ? `Re-running designers: ${partialAgents.join(", ")}`
                : "Re-running design group";
            taskStore.emit_log(
              task.id,
              `Overseer clarify: design gaps (iteration ${designReviewIterations}). ${rerunLabel}.${gapDetail}`,
            );
            log.info("Clarify gaps: rewinding to design group", { gaps: clarifyOutcome.result?.gaps, partialAgents }, "flow");
            groupIndex = designGroupIdx;
            continue;
          }
        }

        // Design approval gate — moved here from the design group when v2 is on, so the
        // user sees the spec/plan AFTER the overseer has reviewed and appended any
        // clarifications. Mirrors the v1 inline approval block.
        if (task.requireDesignApproval) {
          const summary = await bigBossSummarize(workDir, "DESIGN.md", "design", skillsRoot);
          const designPreview = await readDesignPreview(workDir);
          log.info("Design approval requested (post-clarify, v2)", undefined, "flow");

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
            designFeedbackByAgent = undefined;
            designFeedback = approval.feedback || "User requested design changes.";
            taskStore.emit_log(task.id, `Design revision ${designLoops}: ${designFeedback}`);
            const designGroupIdx = stageGroups.findIndex(
              (g, i) => i < groupIndex && g.stageDefs.some((s) => s.category === "design"),
            );
            if (designGroupIdx >= 0) {
              for (const s of stageGroups[designGroupIdx].stageDefs) {
                taskStore.updateStage(task.id, s.name, { status: "pending" as const });
              }
              taskStore.updateStage(task.id, stage.name, { status: "pending" as const });
              groupIndex = designGroupIdx;
              continue;
            }
          }
        }

        groupIndex++;
        continue;
      }

      // Spec-kit Tier 2 PR2 — `analyze` stage dispatch (v2 only). Replaces the
      // inline overseer-post-code-review + drift fix-up block from the v1
      // coding stage. The fix-up runner uses the most recent coding agent's
      // type (derived from the pipeline stack) and shares the existing
      // sessionRegistry / baseConfig.
      if (stage.category === "analyze") {
        const stageStart = new Date().toISOString();
        taskStore.updateStage(task.id, stage.name, { status: "running", startedAt: stageStart });

        const codingAgentType = pipelineStack === "love" ? "lua-coding" : "coding";
        const analyzeOutcome = await runAnalyzeStage({
          workDir,
          originalTask: task.prompt,
          skillsRoot,
          taskId: task.id,
          cursorSessionId: await sessionRegistry.getOrCreate("bigboss"),
          signal,
          stack: pipelineStack,
          initialIteration: codeReviewIterations,
          fixUpRunner: async (focusedPrompt) => {
            const fixUpSessionId = await sessionRegistry.getOrCreate(codingAgentType);
            const fixUpConfig: AgentRunConfig = {
              ...baseConfig,
              prompt: focusedPrompt,
              agentType: codingAgentType,
              category: "coding",
              workspaceReady: true,
              trivial: isTrivial,
              complexity,
              upstreamResults: [...upstreamResults],
              agentBrief: agentBriefs[codingAgentType] ?? null,
              cursorSessionId: fixUpSessionId,
            };
            return runAgent(fixUpConfig, workDir, undefined, signal);
          },
        });

        if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

        codeReviewIterations = analyzeOutcome.iterationsUsed;
        for (const r of analyzeOutcome.fixUpResults) upstreamResults.push(r);

        taskStore.updateStage(task.id, stage.name, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          notes:
            `Overseer analyze: ${analyzeOutcome.status}` +
            (analyzeOutcome.fixUpResults.length > 0
              ? ` (${analyzeOutcome.fixUpResults.length} fix-up${analyzeOutcome.fixUpResults.length > 1 ? "s" : ""})`
              : ""),
          analyzeResult: {
            fit: (analyzeOutcome.result?.fit ?? "ok") as "ok" | "drift",
            issueCount: analyzeOutcome.result?.missingOrWrong?.length ?? 0,
            iterationsUsed: analyzeOutcome.iterationsUsed,
            fixUpsRun: analyzeOutcome.fixUpResults.length,
            capReached: analyzeOutcome.capReached,
          },
        });

        groupIndex++;
        continue;
      }

      // Spec-kit Tier 2 PR3 — `checklist` stage dispatch (v2 only). Replaces
      // the legacy LOVE_SMOKE_CHECKLIST=1 env path with a stack-agnostic
      // read-only review of CHECKLISTS.md (PR1 artefact). On `incomplete`,
      // hands off to a single coding fix-up (cap MAX_CHECKLIST_FIX_ITERATIONS
      // = 1). When CHECKLIST_BLOCKING=1 is set and the final state is
      // `incomplete`, the pipeline is failed; otherwise advisory-only
      // (matches plan §12 Q4).
      if (stage.category === "checklist") {
        const stageStart = new Date().toISOString();
        taskStore.updateStage(task.id, stage.name, { status: "running", startedAt: stageStart });

        const codingAgentType = pipelineStack === "love" ? "lua-coding" : "coding";
        const checklistOutcome = await runChecklistStage({
          workDir,
          originalTask: task.prompt,
          taskId: task.id,
          signal,
          stack: pipelineStack,
          initialFixUps: checklistFixUps,
          fixUpRunner: async (focusedPrompt) => {
            const fixUpSessionId = await sessionRegistry.getOrCreate(codingAgentType);
            const fixUpConfig: AgentRunConfig = {
              ...baseConfig,
              prompt: focusedPrompt,
              agentType: codingAgentType,
              category: "coding",
              workspaceReady: true,
              trivial: isTrivial,
              complexity,
              upstreamResults: [...upstreamResults],
              agentBrief: agentBriefs[codingAgentType] ?? null,
              cursorSessionId: fixUpSessionId,
            };
            return runAgent(fixUpConfig, workDir, undefined, signal);
          },
        });

        if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

        checklistFixUps = checklistOutcome.fixUpsRun;
        for (const r of checklistOutcome.fixUpResults) upstreamResults.push(r);

        const passedCount = checklistOutcome.result?.items.filter((i) => i.status === "pass").length ?? 0;
        const failedCount = checklistOutcome.result?.failed.length ?? 0;
        taskStore.updateStage(task.id, stage.name, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          notes:
            `Overseer checklist: ${checklistOutcome.status}` +
            (failedCount > 0 ? ` (${failedCount} failed)` : "") +
            (checklistOutcome.fixUpResults.length > 0
              ? ` (${checklistOutcome.fixUpResults.length} fix-up)`
              : ""),
          checklistResult:
            checklistOutcome.result
              ? {
                  fit: checklistOutcome.result.fit,
                  passedCount,
                  failedCount,
                }
              : undefined,
        });

        if (checklistOutcome.shouldBlock) {
          taskStore.emit_log(
            task.id,
            `CHECKLIST_BLOCKING=1: ${failedCount} item(s) still failing after fix-up; failing pipeline.`,
          );
          taskStore.updateTaskStatus(
            task.id,
            TaskStatus.Failed,
            `Checklist blocking: ${failedCount} item(s) failed`,
          );
          taskStore.cleanupAbort(task.id);
          return;
        }

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
        if (stage.category === "design" && (designFeedback || designFeedbackByAgent)) {
          const scoped = designFeedbackByAgent?.[stage.agent];
          if (scoped) {
            stagePrompt += `\n\n## Overseer feedback for your role (${stage.agent})\n${scoped}`;
          } else if (designFeedback) {
            stagePrompt += `\n\n## Feedback on your previous design pass\nIncorporate into the revised design:\n${designFeedback}`;
          }
        }

        const briefKey = stage.agent;
        const releaseBrief = stage.category === "release"
          ? `Release stage = **merge-to-main** workflow: pipeline branch is \`${task.branch}\`; merge target (base) is \`${task.baseBranch}\`. Use \`git log ${task.baseBranch}..HEAD\`, \`gh pr create --base ${task.baseBranch}\`, then \`gh pr merge --squash --delete-branch\`, then checkout ${task.baseBranch}, pull, annotated tag \`v<version>\` on mainline, push tag. Run \`npm run build\` (or project build) after push and before PR. Do not stop at an open PR — complete merge and tag per \`skills/release/system-prompt.md\`.`
          : null;

        let subTasks: string[] | null = null;
        if (stage.category === "coding" && complexity === "complex") {
          subTasks = await decomposeTask(workDir, task.prompt, pipelineStack);
          if (subTasks) {
            taskStore.emit_log(task.id, `Complex task decomposed into ${subTasks.length} sub-tasks`);
          }
        }

        const cursorSessionId = await sessionRegistry.getOrCreate(stage.agent);
        const config: AgentRunConfig = {
          ...baseConfig,
          prompt: stagePrompt,
          agentType: stage.agent,
          category: stage.category,
          workspaceReady: true,
          trivial: isTrivial,
          complexity,
          upstreamResults: upstreamResults.length > 0
            ? [...upstreamResults]
            : undefined,
          agentBrief: releaseBrief ?? agentBriefs[briefKey] ?? agentBriefs[stage.agent] ?? null,
          cursorSessionId,
        };

        const progressCallback = (event: { type: string; elapsedSeconds?: number; filesEdited?: number }) => {
          const current = taskStore.getTask(task.id);
          if (!current) return;
          if (event.type === "progress") {
            taskStore.emitStageProgress(task.id, stage.name, {
              elapsedSeconds: event.elapsedSeconds ?? 0,
              filesEdited: event.filesEdited ?? 0,
            });
          } else {
            taskStore.updateStage(task.id, stage.name, { status: "running" });
          }
        };

        let result: AgentRunResult;

        let usedSubTasks = false;
        if (subTasks && subTasks.length > 1) {
          usedSubTasks = true;
          let lastResult: AgentRunResult | null = null;
          for (let i = 0; i < subTasks.length; i++) {
            if (signal.aborted) break;
            taskStore.emit_log(task.id, `Running sub-task ${i + 1}/${subTasks.length}: ${subTasks[i].slice(0, 100)}...`);
            const subSessionId = await sessionRegistry.getOrCreate(stage.agent);
            const subConfig: AgentRunConfig = {
              ...config,
              prompt: `${task.prompt}\n\n## Current sub-task (${i + 1} of ${subTasks.length})\n\n${subTasks[i]}`,
              workspaceReady: true,
              subTaskIndex: i,
              subTaskTotal: subTasks.length,
              upstreamResults: [...upstreamResults],
              cursorSessionId: subSessionId,
            };
            lastResult = await runAgent(subConfig, workDir, progressCallback, signal);
            upstreamResults.push(lastResult);
            taskStore.emit_log(task.id, `Sub-task ${i + 1} ${lastResult.success ? "completed" : "failed"}: ${lastResult.filesModified?.length ?? 0} files`);
            if (!lastResult.success) break;
          }
          result = lastResult || {
            agent: stage.agent, success: false, output: "No sub-tasks completed",
            parsed: { assistantMessage: "", filesWritten: [], shellCommands: [], errors: ["No sub-tasks ran"], tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
            filesModified: [], errors: ["No sub-tasks ran"], durationMs: 0,
          };
        } else {
          result = await runAgent(config, workDir, progressCallback, signal);
        }

        if (signal.aborted) {
          log.warn(`Cancelled during ${stage.name}`, undefined, "status");
          taskStore.cleanupAbort(task.id);
          return;
        }

        if (!usedSubTasks) {
          upstreamResults.push(result);
        }

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

          if (stage.category === "design" && result.success) {
            try {
              const designPath = path.join(workDir, "DESIGN.md");
              let content = await fs.readFile(designPath, "utf-8");
              if (content && !content.startsWith("## Original task")) {
                content = prependOriginalTaskToDesign(workDir, content, task.prompt);
                await fs.writeFile(designPath, content, "utf-8");
              }
            } catch {
              /* DESIGN.md may not exist yet */
            }
            await ensureDesignReferencesRequirements(workDir);

            await runV2ArtefactWriters(
              task.id,
              workDir,
              [stage.agent],
              task.prompt,
              pipelineStack,
            );

            try {
              const tasksResult = await writeTasksMd({
                workDir,
                originalTask: task.prompt,
                stages,
                stack: pipelineStack,
              });
              taskStore.emit_log(task.id, `Wrote TASKS.md (${tasksResult.taskCount} tasks).`);
            } catch (err) {
              log.warn("TASKS.md generation failed (non-fatal)", { err: String(err) });
            }
          }

          if (stage.category === "design" && task.requireDesignApproval) {
            const summary = await bigBossSummarize(workDir, "DESIGN.md", "design", skillsRoot);
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
              designFeedbackByAgent = undefined;
              designFeedback = approval.feedback || "User requested design changes.";
              log.info(`Design revision requested (loop ${designLoops})`, { feedback: designFeedback }, "flow");
              taskStore.emit_log(task.id, `Design revision ${designLoops}: ${designFeedback}`);
              taskStore.updateStage(task.id, stage.name, { status: "pending" as const });
              continue;
            }

            log.info("User approved design", undefined, "flow");
          }

          if (stage.category === "coding") {
            const lint = await runLintCheck(workDir);
            if (lint && !lint.passed) {
              log.warn("Lint/build failed, running fix-up pass...", { command: lint.command }, "status");
              taskStore.emit_log(task.id, `Lint check failed (${lint.command}), running fix-up pass...`);

              const fixSessionId = await sessionRegistry.getOrCreate(stage.agent);
              const fixConfig: AgentRunConfig = {
                ...baseConfig,
                agentType: stage.agent,
                category: "coding",
                workspaceReady: true,
                trivial: true,
                complexity,
                prompt: `${task.prompt}\n\nIMPORTANT: The previous coding pass produced lint/build errors. Fix them.\n\nCommand: ${lint.command}\nErrors:\n${lint.output}`,
                upstreamResults: [...upstreamResults],
                cursorSessionId: fixSessionId,
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

          if (stage.category === "coding" && result.success) {
            const execResult = await tryRunProject(workDir);
            if (execResult && !execResult.passed) {
              log.warn("Execution verification failed, running fix-up pass", { command: execResult.command }, "status");
              taskStore.emit_log(task.id, `Exec verification failed (${execResult.command}), running fix-up pass...`);

              const execFixSessionId = await sessionRegistry.getOrCreate(stage.agent);
              const execFixConfig: AgentRunConfig = {
                ...baseConfig,
                agentType: stage.agent,
                category: "coding",
                workspaceReady: true,
                trivial: true,
                complexity,
                prompt: `${task.prompt}\n\nIMPORTANT: The project failed execution verification. Fix the errors below.\n\nCommand: ${execResult.command}\nErrors:\n${execResult.output}`,
                upstreamResults: [...upstreamResults],
                cursorSessionId: execFixSessionId,
              };

              const execFixResult = await runAgent(execFixConfig, workDir, undefined, signal);
              upstreamResults.push(execFixResult);

              const retryExec = await tryRunProject(workDir);
              if (retryExec && !retryExec.passed) {
                log.warn("Exec verification still failing after fix-up", { output: retryExec.output.slice(0, 200) }, "status");
                taskStore.emit_log(task.id, `Exec verification still failing: ${retryExec.output.slice(0, 200)}`);
              } else {
                taskStore.emit_log(task.id, "Execution verification passed after fix-up.");
              }
            } else if (execResult?.passed) {
              log.info(`Execution verification passed (${execResult.command})`, undefined, "status");
              taskStore.emit_log(task.id, `Execution verification passed (${execResult.command}).`);
            }
          }

          // v2 splits this block into a discrete `analyze` stage (inserted by
          // injectV2OverseerStages); skip the inline review when v2 is on so the
          // overseer call only fires once per pipeline.
          if (!isArtefactSchemaV2() && stage.category === "coding" && result.success && codeReviewIterations < MAX_OVERSEER_CODE_ITERATIONS) {
            taskStore.emit_overseer_log(task.id, "BigBoss (Overseer): reviewing code against design and requirements…", {
              phase: "code-review",
              status: "running",
            });
            const codeReview = await overseerPostCodeReview(
              workDir,
              task.prompt,
              skillsRoot,
              task.id,
              await sessionRegistry.getOrCreate("bigboss"),
              signal,
              { stack: pipelineStack },
            );
            taskStore.emit_overseer_log(
              task.id,
              codeReview?.fit === "ok"
                ? "BigBoss (Overseer): implementation fits design and requirements."
                : codeReview?.fit === "drift"
                  ? "BigBoss (Overseer): code drift found; running coder fix-up pass."
                  : "BigBoss (Overseer): code review complete.",
              { phase: "code-review", status: "done", result: codeReview?.fit === "ok" ? "ok" : codeReview?.fit === "drift" ? "drift" : undefined },
            );
            if (codeReview?.fit === "drift" && codeReview.suggestedSubTask?.prompt) {
              codeReviewIterations++;
              taskStore.emit_log(
                task.id,
                `Overseer code review: code drift found. Running coder fix-up (${codeReviewIterations}/${MAX_OVERSEER_CODE_ITERATIONS}).`,
              );
              log.info("Overseer code review: re-running coder for drift", { missingOrWrong: codeReview.missingOrWrong }, "flow");
              const focusPaths = normaliseOverseerFocusPaths(codeReview.focusPaths);
              const focusBlock = formatOverseerFocusPaths(focusPaths);
              const overseerFixSessionId = await sessionRegistry.getOrCreate(stage.agent);
              const overseerConfig: AgentRunConfig = {
                ...baseConfig,
                prompt: `${task.prompt}\n\n## Overseer code review (code drift)${focusBlock}\n\n${codeReview.suggestedSubTask.prompt}`,
                agentType: stage.agent,
                category: "coding",
                workspaceReady: true,
                trivial: isTrivial,
                complexity,
                upstreamResults: [...upstreamResults],
                agentBrief: agentBriefs[stage.agent] ?? null,
                cursorSessionId: overseerFixSessionId,
              };
              const overseerResult = await runAgent(overseerConfig, workDir, undefined, signal);
              upstreamResults.push(overseerResult);
              if (overseerResult.success) {
                taskStore.emit_log(task.id, `Overseer code drift fix-up completed: ${overseerResult.filesModified?.length ?? 0} files.`);
              }

              if (overseerResult.success && codeReviewIterations < MAX_OVERSEER_CODE_ITERATIONS) {
                taskStore.emit_overseer_log(task.id, "BigBoss (Overseer): re-checking code after drift fix-up…", {
                  phase: "code-review",
                  status: "running",
                });
                const recheck = await overseerPostCodeReview(
                  workDir,
                  task.prompt,
                  skillsRoot,
                  task.id,
                  await sessionRegistry.getOrCreate("bigboss"),
                  signal,
                  { stack: pipelineStack },
                );
                taskStore.emit_overseer_log(
                  task.id,
                  recheck?.fit === "ok"
                    ? "BigBoss (Overseer): post-fix code review OK."
                    : recheck?.fit === "drift"
                      ? "BigBoss (Overseer): code drift remains after fix-up; second fix-up if budget allows."
                      : "BigBoss (Overseer): post-fix code review complete.",
                  { phase: "code-review", status: "done", result: recheck?.fit === "ok" ? "ok" : recheck?.fit === "drift" ? "drift" : undefined },
                );
                if (recheck?.fit === "drift" && recheck.suggestedSubTask?.prompt && codeReviewIterations < MAX_OVERSEER_CODE_ITERATIONS) {
                  codeReviewIterations++;
                  const recheckFocus = normaliseOverseerFocusPaths(recheck.focusPaths);
                  const recheckFocusBlock = formatOverseerFocusPaths(recheckFocus);
                  const secondFixSessionId = await sessionRegistry.getOrCreate(stage.agent);
                  const secondFixConfig: AgentRunConfig = {
                    ...baseConfig,
                    prompt: `${task.prompt}\n\n## Overseer code review (code drift, follow-up)${recheckFocusBlock}\n\n${recheck.suggestedSubTask.prompt}`,
                    agentType: stage.agent,
                    category: "coding",
                    workspaceReady: true,
                    trivial: isTrivial,
                    complexity,
                    upstreamResults: [...upstreamResults],
                    agentBrief: agentBriefs[stage.agent] ?? null,
                    cursorSessionId: secondFixSessionId,
                  };
                  taskStore.emit_log(
                    task.id,
                    `Overseer: second code drift fix-up (${codeReviewIterations}/${MAX_OVERSEER_CODE_ITERATIONS}).`,
                  );
                  const secondResult = await runAgent(secondFixConfig, workDir, undefined, signal);
                  upstreamResults.push(secondResult);
                  if (secondResult.success) {
                    taskStore.emit_log(
                      task.id,
                      `Second drift fix-up completed: ${secondResult.filesModified?.length ?? 0} files.`,
                    );
                  }
                }
              }
            } else if (codeReview?.fit === "ok") {
              taskStore.emit_log(task.id, "Overseer code review: implementation fits design and task.");
            }
          }

          // Spec-kit Tier 2 PR3 — LOVE_SMOKE_CHECKLIST is deprecated. v2 runs
          // the stack-agnostic `checklist` stage automatically (which inherits
          // OVERSEER_LOVE_CODE_CHECKLIST bullets for LÖVE). The legacy env
          // path remains here for v1 compat only; emits a deprecation warning
          // when set so users have time to migrate.
          if (
            stage.category === "coding" &&
            result.success &&
            pipelineStack === "love" &&
            process.env.LOVE_SMOKE_CHECKLIST === "1"
          ) {
            if (isArtefactSchemaV2()) {
              if (!loveSmokeDeprecationWarned) {
                loveSmokeDeprecationWarned = true;
                log.warn(
                  "LOVE_SMOKE_CHECKLIST is deprecated; CHECKLISTS.md is generated automatically when ARTEFACT_SCHEMA=v2. Skipping legacy LÖVE smoke pass.",
                  undefined,
                  "flow",
                );
                taskStore.emit_log(
                  task.id,
                  "LOVE_SMOKE_CHECKLIST is deprecated; the v2 `checklist` stage covers this and more. Unset the env var to silence this warning.",
                );
              }
            } else {
              const smoke = await runLoveSmokeChecklistOpenAI(workDir, task.prompt);
              if (smoke) {
                taskStore.emit_log(
                  task.id,
                  `LÖVE smoke checklist: ${JSON.stringify({
                    movementOk: smoke.movementOk,
                    persistenceOk: smoke.persistenceOk,
                    issues: smoke.issues,
                  })}`,
                );
              }
            }
          }

          if (stage.category === "coding") {
            const notes = await readCodingNotes(workDir);
            if (notes) {
              const atCap = designLoops >= MAX_DESIGN_LOOPS;

              if (task.requireDesignApproval) {
                if (!atCap) {
                  const feedbackSummary = await bigBossSummarize(workDir, "CODING_NOTES.md", "feedback", skillsRoot);
                  log.info("Presenting coding feedback for review", undefined, "flow");

                  const feedbackApproval: ApprovalResponse = await taskStore.requestApproval(
                    task.id, feedbackSummary,
                    { approvalType: "feedback", feedbackPreview: notes.slice(0, 600) },
                  );

                  if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

                  if (feedbackApproval.action === "redesign") {
                    designLoops++;
                    designFeedback = notes;
                    feedbackFingerprint = parseCodingNotes(notes).mustAddressContent;
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
                } else {
                  taskStore.updateStage(task.id, stage.name, {
                    feedbackLimitReached: true,
                    unaddressedFeedback: notes,
                  });
                  log.info("Feedback loop limit reached; unaddressed feedback recorded", undefined, "flow");
                  taskStore.emit_log(task.id, "Feedback loop limit reached. Unaddressed coding feedback recorded in stage notes.");
                }
              } else {
                const parsed = parseCodingNotes(notes);
                const criteriaSayLoop = shouldLoopOnFeedback(parsed, feedbackFingerprint);

                if (criteriaSayLoop && !atCap) {
                  designLoops++;
                  designFeedback = notes;
                  feedbackFingerprint = parsed.mustAddressContent;
                  log.info(`Auto loop: re-running design with coding feedback (loop ${designLoops})`, undefined, "flow");
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
                } else if (atCap && parsed.mustAddressContent.length >= 50) {
                  taskStore.updateStage(task.id, stage.name, {
                    feedbackLimitReached: true,
                    unaddressedFeedback: notes,
                  });
                  log.info("Feedback loop limit reached; unaddressed feedback recorded", undefined, "flow");
                  taskStore.emit_log(task.id, "Feedback loop limit reached. Unaddressed coding feedback recorded in stage notes and CODING_NOTES.md.");
                }
              }
            }
          }
        } else {
          if (
            stage.category === "validation" &&
            stage.agent === "love-testing" &&
            loveTestFixIterations < MAX_LOVE_TEST_FIX_ITERATIONS
          ) {
            const luaCoder = stages.find((s) => s.agent === "lua-coding");
            if (luaCoder) {
              loveTestFixIterations++;
              const tail = (result.output || "").slice(-6000);
              const errSnippet = [...(result.errors || []), tail].filter(Boolean).join("\n").slice(0, 12_000);
              taskStore.emit_log(
                task.id,
                `Love-testing stage failed (${loveTestFixIterations}/${MAX_LOVE_TEST_FIX_ITERATIONS}); running lua-coding fix-up, then retrying validation…`,
              );
              const last = upstreamResults[upstreamResults.length - 1];
              if (last?.agent === "love-testing" && !last.success) upstreamResults.pop();

              const fixSessionId = await sessionRegistry.getOrCreate(luaCoder.agent);
              const testFixConfig: AgentRunConfig = {
                ...baseConfig,
                agentType: luaCoder.agent,
                category: "coding",
                workspaceReady: true,
                trivial: true,
                complexity,
                prompt: `${task.prompt}\n\n## Validation / test failures\nFix implementation or tests so busted (and any LÖVE smoke checks) pass. Address:\n\n${errSnippet}`,
                upstreamResults: [...upstreamResults],
                agentBrief: agentBriefs[luaCoder.agent] ?? null,
                cursorSessionId: fixSessionId,
              };
              const fixResult = await runAgent(testFixConfig, workDir, progressCallback, signal);
              upstreamResults.push(fixResult);

              taskStore.updateStage(task.id, stage.name, {
                status: "pending" as const,
                startedAt: undefined,
                completedAt: undefined,
                errors: undefined,
              });
              continue;
            }
          }

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
