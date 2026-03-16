import * as path from "path";
import { promises as fs } from "fs";
import { TaskStatus } from "@agents/shared";
import { taskStore, MvpTask, PipelineMode, StageStatus, ApprovalResponse } from "./local-task-store";
import {
  runAgent,
  runPlanner,
  setupWorkspace,
  pushBranch,
  readCodingNotes,
  runLintCheck,
  AgentRunConfig,
  AgentRunResult,
} from "./local-agent-runner";

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

function resolveSkillsRoot(): string {
  return (
    process.env.SKILLS_ROOT ||
    path.resolve(__dirname, "..", "..", "skills")
  );
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

const BIGBOSS_SYSTEM_PROMPT = `You are a pipeline planner. Given a task, decide which pipeline stages are needed and estimate complexity.
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

interface BigBossResult {
  stages: StageDefinition[];
  complexity: "trivial" | "moderate" | "complex";
}

async function planWithOpenAI(prompt: string): Promise<BigBossResult | null> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const start = Date.now();
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: BIGBOSS_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 128,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    console.log(`[bigboss] OpenAI routing in ${elapsed}s: ${JSON.stringify(parsed)}`);

    return parseBigBossResponse(parsed);
  } catch (err) {
    console.warn("[bigboss] OpenAI call failed:", err);
    return null;
  }
}

async function planWithAgentCli(
  prompt: string,
  workDir: string,
  pipelineId: string,
): Promise<BigBossResult | null> {
  try {
    const fullPrompt = `${BIGBOSS_SYSTEM_PROMPT}\n\nTask:\n${prompt}`;
    const { text, timedOut } = await runPlanner(fullPrompt, workDir, pipelineId, 60_000);

    if (timedOut) {
      console.warn("[bigboss] CLI timed out, falling back to full pipeline");
      return null;
    }

    const jsonMatch = text.match(/\{[\s\S]*"stages"[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[bigboss] No JSON found in CLI output");
      return null;
    }

    return parseBigBossResponse(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.warn("[bigboss] CLI planning failed:", err);
    return null;
  }
}

function parseBigBossResponse(parsed: Record<string, unknown>): BigBossResult | null {
  if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) return null;

  const validNames = new Set(["design", "coding", "testing"]);
  const stageNames = (parsed.stages as string[]).filter((s) => validNames.has(s));
  if (stageNames.length === 0) return null;

  if (!stageNames.includes("coding")) stageNames.push("coding");

  const ordered: StageDefinition[] = [];
  for (const def of FULL_STAGES) {
    const lookupName = def.name === "validation" ? "testing" : def.name;
    if (stageNames.includes(lookupName)) ordered.push(def);
  }

  const complexity = (["trivial", "moderate", "complex"].includes(parsed.complexity as string)
    ? parsed.complexity
    : "moderate") as BigBossResult["complexity"];

  console.log(`[bigboss] Decided stages: ${ordered.map((s) => s.name).join(" -> ")} (complexity: ${complexity})`);
  return { stages: ordered, complexity };
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
        console.log(`[bigboss] Summarized ${filename} in ${elapsed}s`);
        return summary;
      }
    } catch (err) {
      console.warn(`[bigboss] Summarization failed for ${filename}:`, err);
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
    return content.slice(0, 600);
  } catch {
    return "";
  }
}

async function planWithBigBoss(
  prompt: string,
  workDir: string,
  pipelineId: string,
): Promise<BigBossResult | null> {
  if (process.env.OPENAI_API_KEY) {
    const result = await planWithOpenAI(prompt);
    if (result) return result;
    console.log("[bigboss] OpenAI failed, trying agent CLI fallback");
  }
  return planWithAgentCli(prompt, workDir, pipelineId);
}

const MAX_DESIGN_LOOPS = 2;

export async function runPipeline(task: MvpTask): Promise<void> {
  const skillsRoot = resolveSkillsRoot();
  const upstreamResults: AgentRunResult[] = [];
  const pid = task.id.slice(0, 8);

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
    console.log(`[pipeline ${pid}] workspace: ${workDir}, branch: ${task.branch}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    taskStore.updateTaskStatus(task.id, TaskStatus.Failed, `Workspace setup failed: ${message}`);
    taskStore.cleanupAbort(task.id);
    return;
  }

  let stages: StageDefinition[];
  let complexity: "trivial" | "moderate" | "complex" = "moderate";

  if (task.pipelineMode === "auto") {
    const planned = await planWithBigBoss(task.prompt, workDir, task.id);
    if (planned) {
      stages = planned.stages;
      complexity = planned.complexity;
    } else {
      stages = [...FULL_STAGES];
    }
    console.log(`[pipeline ${pid}] mode=auto, stages: ${stages.map((s) => s.name).join(" -> ")}, complexity: ${complexity}`);
  } else {
    stages = stagesForMode(task.pipelineMode);
    console.log(`[pipeline ${pid}] mode=${task.pipelineMode}, stages: ${stages.map((s) => s.name).join(" -> ")}`);
  }

  const initialStages: StageStatus[] = stages.map((s) => ({
    name: s.name,
    agent: s.agent,
    status: "pending" as const,
  }));
  taskStore.setStages(task.id, initialStages);

  const isTrivial = complexity === "trivial";
  let designLoops = 0;
  let designFeedback: string | undefined;
  let stageIndex = 0;

  while (stageIndex < stages.length) {
    if (signal.aborted) {
      console.log(`[pipeline ${pid}] Cancelled by user`);
      taskStore.cleanupAbort(task.id);
      return;
    }

    const stage = stages[stageIndex];

    taskStore.updateStage(task.id, stage.name, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    try {
      let stagePrompt = task.prompt;
      if (stage.category === "design" && designFeedback) {
        stagePrompt += `\n\n## Feedback from previous coding pass\nIncorporate these notes into the revised design:\n${designFeedback}`;
      }

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
      };

      const result = await runAgent(config, workDir, (event) => {
        const current = taskStore.getTask(task.id);
        if (!current) return;
        taskStore.updateStage(task.id, stage.name, { status: "running" });
      }, signal);

      if (signal.aborted) {
        console.log(`[pipeline ${pid}] Cancelled during ${stage.name}`);
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
            console.log(`[pipeline ${pid}] CODING_NOTES.md found (${notes.length} chars)`);
          }
        }

        taskStore.updateStage(task.id, stage.name, stageUpdate);

        // --- Design approval gate ---
        if (stage.category === "design" && task.requireDesignApproval) {
          const summary = await bigBossSummarize(workDir, "DESIGN.md", "design");
          const designPreview = await readDesignPreview(workDir);
          console.log(`[pipeline ${pid}] Waiting for design approval...`);

          const approval: ApprovalResponse = await taskStore.requestApproval(
            task.id,
            summary,
            { approvalType: "design", designPreview },
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
            console.log(`[pipeline ${pid}] Design revision requested (loop ${designLoops}): ${designFeedback}`);
            taskStore.emit_log(task.id, `Design revision ${designLoops}: ${designFeedback}`);
            taskStore.updateStage(task.id, stage.name, { status: "pending" as const });
            continue;
          }

          console.log(`[pipeline ${pid}] Design approved, continuing`);
        }

        // --- Coding: lint check ---
        if (stage.category === "coding") {
          const lint = await runLintCheck(workDir);
          if (lint && !lint.passed) {
            console.log(`[pipeline ${pid}] Lint/build failed, running fix-up pass...`);
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
              console.warn(`[pipeline ${pid}] Lint still failing after fix-up pass`);
              taskStore.emit_log(task.id, `Lint still failing after fix-up: ${retryLint.output.slice(0, 200)}`);
            } else {
              console.log(`[pipeline ${pid}] Lint/build clean after fix-up pass`);
              taskStore.emit_log(task.id, "Code compiles cleanly after fix-up pass.");
            }
          } else if (lint?.passed) {
            console.log(`[pipeline ${pid}] Lint/build passed (${lint.command})`);
            taskStore.emit_log(task.id, `Code compiles cleanly (${lint.command}).`);
          }
        }

        // --- Coding: feedback loop ---
        if (stage.category === "coding" && task.requireDesignApproval) {
          const notes = await readCodingNotes(workDir);
          if (notes && designLoops < MAX_DESIGN_LOOPS) {
            const feedbackSummary = await bigBossSummarize(workDir, "CODING_NOTES.md", "feedback");
            console.log(`[pipeline ${pid}] Presenting coding feedback for review...`);

            const feedbackApproval: ApprovalResponse = await taskStore.requestApproval(
              task.id,
              feedbackSummary,
              { approvalType: "feedback", feedbackPreview: notes.slice(0, 600) },
            );

            if (signal.aborted) { taskStore.cleanupAbort(task.id); return; }

            if (feedbackApproval.action === "redesign") {
              designLoops++;
              designFeedback = notes;
              console.log(`[pipeline ${pid}] Re-running design with coding feedback (loop ${designLoops})`);
              taskStore.emit_log(task.id, `Re-running design with coding feedback (loop ${designLoops})`);

              const designIdx = stages.findIndex((s) => s.category === "design");
              if (designIdx >= 0) {
                taskStore.updateStage(task.id, stages[designIdx].name, { status: "pending" as const });
                taskStore.updateStage(task.id, stage.name, { status: "pending" as const });
                stageIndex = designIdx;
                continue;
              }
            }
            console.log(`[pipeline ${pid}] Continuing to next stage (feedback acknowledged)`);
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

    stageIndex++;
  }

  if (task.repo) {
    const push = pushBranch(workDir, task.branch);
    if (push.pushed) {
      console.log(`[pipeline ${pid}] pushed ${task.branch} to origin`);
    } else {
      console.warn(`[pipeline ${pid}] push failed: ${push.error}`);
    }
  }

  taskStore.cleanupAbort(task.id);
  taskStore.updateTaskStatus(task.id, TaskStatus.Completed);
}
