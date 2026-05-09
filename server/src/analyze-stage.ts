/**
 * Spec-kit Tier 2 PR2 — `analyze` stage runner.
 *
 * Wraps the inline overseer-post-code-review block from `orchestrator.ts`
 * lines ~1281–1389 (overseer call → drift fix-up coder pass → optional
 * recheck → optional second fix-up) into a discrete pipeline stage.
 *
 * Responsibilities:
 *   - Run `overseerPostCodeReview()` and emit the same overseer log lines.
 *   - When the response declares `fit === "drift"` and a `suggestedSubTask`
 *     is present, run a focused coding fix-up by invoking the caller-provided
 *     `fixUpRunner` callback. The orchestrator owns the AgentRunConfig (agent
 *     type, session, baseConfig, complexity, etc.); the stage just supplies
 *     the focused prompt.
 *   - Iterate up to `MAX_OVERSEER_CODE_ITERATIONS` total (cap inherited from
 *     bigboss-director.ts) — same behaviour as today's inline block.
 *   - Return aggregated outcome: final OverseerCodeReviewResult, the list of
 *     fix-up AgentRunResults to push onto upstreamResults, and the number of
 *     iterations consumed (so the orchestrator can update its counter).
 *
 * The `fixUpRunner` indirection keeps `agent-runner.ts` plumbing
 * (AgentRunConfig, sessionRegistry, agentBriefs) out of the stage module
 * and avoids leaking pipeline state across module boundaries.
 */
import { createLogger } from "@agents/shared";
import {
  overseerPostCodeReview,
  type OverseerCodeReviewResult,
  MAX_OVERSEER_CODE_ITERATIONS,
} from "./bigboss-director";
import type { PipelineStack } from "./pipeline-stages";
import type { AgentRunResult } from "./agent-runner";
import { taskStore } from "./task-store";

export interface AnalyzeStageInput {
  workDir: string;
  originalTask: string;
  skillsRoot: string;
  /** Pipeline / task id used as both BigBoss pipelineId and taskStore.taskId. */
  taskId: string;
  cursorSessionId?: string | null;
  signal: AbortSignal;
  stack: PipelineStack;
  /** Iterations already consumed by analyze for this task (typically 0 on first invocation). */
  initialIteration: number;
  /**
   * Run a focused coding fix-up with the given prompt. The orchestrator builds
   * AgentRunConfig (agent type, baseConfig, complexity, upstreamResults,
   * cursorSessionId, agentBrief, etc.) and returns the resulting AgentRunResult.
   * Used at most twice per analyze stage (initial fix-up + post-recheck).
   */
  fixUpRunner: (focusedPrompt: string) => Promise<AgentRunResult>;
}

export interface AnalyzeStageOutcome {
  /**
   * - "ok"     overseer fit === "ok"; orchestrator should advance.
   * - "drift"  overseer fit === "drift"; one or more fix-up passes ran.
   * - "noop"   overseer call returned null; orchestrator should advance.
   */
  status: "ok" | "drift" | "noop";
  result: OverseerCodeReviewResult | null;
  iterationsUsed: number;
  fixUpResults: AgentRunResult[];
  /**
   * True when the analyze stage hit `MAX_OVERSEER_CODE_ITERATIONS` and stopped
   * before the drift was resolved. The orchestrator can surface this to the UI.
   */
  capReached: boolean;
}

const STAGE_LABEL = "analyze";

function normaliseFocusPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim())
    .slice(0, 25);
}

function formatFocusPathsBlock(paths: string[]): string {
  if (paths.length === 0) return "";
  const lines = paths.map((p) => `- ${p}`);
  return `\n\nPrefer edits under these paths (repo-relative):\n${lines.join("\n")}`;
}

export async function runAnalyzeStage(input: AnalyzeStageInput): Promise<AnalyzeStageOutcome> {
  const log = createLogger(STAGE_LABEL);
  const fixUpResults: AgentRunResult[] = [];
  let iterations = input.initialIteration;
  let capReached = false;

  taskStore.emit_overseer_log(
    input.taskId,
    "BigBoss (Overseer): analyze — reviewing code against design and requirements…",
    { phase: "analyze", status: "running" },
  );

  let codeReview: OverseerCodeReviewResult | null = null;
  try {
    codeReview = await overseerPostCodeReview(
      input.workDir,
      input.originalTask,
      input.skillsRoot,
      input.taskId,
      input.cursorSessionId,
      input.signal,
      { stack: input.stack },
    );
  } catch (err) {
    log.warn("Overseer code review threw; treating as noop", { err: String(err) }, "flow");
  }

  taskStore.emit_overseer_log(
    input.taskId,
    codeReview?.fit === "ok"
      ? "BigBoss (Overseer): analyze — implementation fits design and requirements."
      : codeReview?.fit === "drift"
        ? "BigBoss (Overseer): analyze — code drift found; running coder fix-up pass."
        : "BigBoss (Overseer): analyze — review complete (no usable response).",
    {
      phase: "analyze",
      status: "done",
      result: codeReview?.fit === "ok" ? "ok" : codeReview?.fit === "drift" ? "drift" : undefined,
    },
  );

  if (!codeReview) {
    return { status: "noop", result: null, iterationsUsed: iterations, fixUpResults, capReached };
  }

  if (codeReview.fit === "ok") {
    taskStore.emit_log(input.taskId, "Overseer code review: implementation fits design and task.");
    return { status: "ok", result: codeReview, iterationsUsed: iterations, fixUpResults, capReached };
  }

  // codeReview.fit === "drift" — run the focused fix-up pass.
  if (!codeReview.suggestedSubTask?.prompt) {
    log.info("Drift reported but no suggestedSubTask; skipping fix-up", undefined, "flow");
    return { status: "drift", result: codeReview, iterationsUsed: iterations, fixUpResults, capReached };
  }

  if (iterations >= MAX_OVERSEER_CODE_ITERATIONS) {
    capReached = true;
    taskStore.emit_log(
      input.taskId,
      `Overseer drift reported but iteration cap (${MAX_OVERSEER_CODE_ITERATIONS}) already reached; skipping fix-up.`,
    );
    return { status: "drift", result: codeReview, iterationsUsed: iterations, fixUpResults, capReached };
  }

  iterations++;
  taskStore.emit_log(
    input.taskId,
    `Overseer code review: code drift found. Running coder fix-up (${iterations}/${MAX_OVERSEER_CODE_ITERATIONS}).`,
  );
  log.info("Re-running coder for drift", { missingOrWrong: codeReview.missingOrWrong }, "flow");

  const focusPaths = normaliseFocusPaths(codeReview.focusPaths);
  const focusBlock = formatFocusPathsBlock(focusPaths);
  const firstFixPrompt =
    `${input.originalTask}\n\n## Overseer code review (code drift)${focusBlock}\n\n${codeReview.suggestedSubTask.prompt}`;

  let firstFixResult: AgentRunResult;
  try {
    firstFixResult = await input.fixUpRunner(firstFixPrompt);
  } catch (err) {
    log.warn("Fix-up runner failed (first pass)", { err: String(err) }, "flow");
    return { status: "drift", result: codeReview, iterationsUsed: iterations, fixUpResults, capReached };
  }
  fixUpResults.push(firstFixResult);

  if (firstFixResult.success) {
    taskStore.emit_log(
      input.taskId,
      `Overseer code drift fix-up completed: ${firstFixResult.filesModified?.length ?? 0} files.`,
    );
  }

  if (!firstFixResult.success || iterations >= MAX_OVERSEER_CODE_ITERATIONS) {
    if (iterations >= MAX_OVERSEER_CODE_ITERATIONS) capReached = true;
    return { status: "drift", result: codeReview, iterationsUsed: iterations, fixUpResults, capReached };
  }

  // Recheck after first fix-up.
  taskStore.emit_overseer_log(
    input.taskId,
    "BigBoss (Overseer): analyze — re-checking code after drift fix-up…",
    { phase: "analyze", status: "running" },
  );

  let recheck: OverseerCodeReviewResult | null = null;
  try {
    recheck = await overseerPostCodeReview(
      input.workDir,
      input.originalTask,
      input.skillsRoot,
      input.taskId,
      input.cursorSessionId,
      input.signal,
      { stack: input.stack },
    );
  } catch (err) {
    log.warn("Overseer recheck threw; treating as drift unresolved", { err: String(err) }, "flow");
  }

  taskStore.emit_overseer_log(
    input.taskId,
    recheck?.fit === "ok"
      ? "BigBoss (Overseer): analyze — post-fix code review OK."
      : recheck?.fit === "drift"
        ? "BigBoss (Overseer): analyze — code drift remains after fix-up; second fix-up if budget allows."
        : "BigBoss (Overseer): analyze — post-fix code review complete (no usable response).",
    {
      phase: "analyze",
      status: "done",
      result: recheck?.fit === "ok" ? "ok" : recheck?.fit === "drift" ? "drift" : undefined,
    },
  );

  if (!recheck || recheck.fit !== "drift" || !recheck.suggestedSubTask?.prompt) {
    return {
      status: recheck?.fit === "ok" ? "ok" : "drift",
      result: recheck ?? codeReview,
      iterationsUsed: iterations,
      fixUpResults,
      capReached,
    };
  }

  if (iterations >= MAX_OVERSEER_CODE_ITERATIONS) {
    capReached = true;
    return { status: "drift", result: recheck, iterationsUsed: iterations, fixUpResults, capReached };
  }

  iterations++;
  const recheckFocus = normaliseFocusPaths(recheck.focusPaths);
  const recheckFocusBlock = formatFocusPathsBlock(recheckFocus);
  const secondFixPrompt =
    `${input.originalTask}\n\n## Overseer code review (code drift, follow-up)${recheckFocusBlock}\n\n${recheck.suggestedSubTask.prompt}`;
  taskStore.emit_log(
    input.taskId,
    `Overseer: second code drift fix-up (${iterations}/${MAX_OVERSEER_CODE_ITERATIONS}).`,
  );

  let secondFixResult: AgentRunResult;
  try {
    secondFixResult = await input.fixUpRunner(secondFixPrompt);
  } catch (err) {
    log.warn("Fix-up runner failed (second pass)", { err: String(err) }, "flow");
    return { status: "drift", result: recheck, iterationsUsed: iterations, fixUpResults, capReached };
  }
  fixUpResults.push(secondFixResult);

  if (secondFixResult.success) {
    taskStore.emit_log(
      input.taskId,
      `Second drift fix-up completed: ${secondFixResult.filesModified?.length ?? 0} files.`,
    );
  }

  if (iterations >= MAX_OVERSEER_CODE_ITERATIONS) capReached = true;
  return {
    status: "drift",
    result: recheck,
    iterationsUsed: iterations,
    fixUpResults,
    capReached,
  };
}
