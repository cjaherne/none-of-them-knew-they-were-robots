/**
 * Spec-kit Tier 2 PR2 — `clarify` stage runner.
 *
 * Wraps the existing inline overseer-design-review block from
 * `orchestrator.ts` lines ~902–967 into a discrete, named pipeline stage.
 * The stage:
 *
 *   1. Emits the existing `BigBoss (Overseer)` log lines so the UI continues
 *      to render the same overseer chip.
 *   2. Calls `overseerPostDesignReview()` (unchanged JSON contract).
 *   3. When the response declares `fit === "gaps"`, appends a `## Clarifications`
 *      section to `spec.md` so the gaps become a permanent part of the
 *      specification (matching spec-kit). Falls back to gracefully-no-op when
 *      `spec.md` does not yet exist.
 *   4. Returns a structured outcome the orchestrator uses to decide whether
 *      to rewind to the design group (gaps + under iteration cap) or proceed
 *      to the next group (ok / cap reached / overseer no-op).
 *
 * Iteration cap, partial-rerun computation, splicing of upstream parallel
 * results, and stage-status emission remain the orchestrator's job — this
 * keeps the rewind logic in one place and avoids leaking pipeline state
 * (groupIndex, upstreamResults, designReviewIterations) into the stage
 * module.
 */
import { createLogger } from "@agents/shared";
import {
  overseerPostDesignReview,
  type OverseerDesignReviewResult,
} from "./bigboss-director";
import type { PipelineStack } from "./pipeline-stages";
import { appendClarifications } from "./spec-artifact";
import { taskStore } from "./task-store";

export interface ClarifyStageInput {
  workDir: string;
  originalTask: string;
  skillsRoot: string;
  /** Pipeline / task id used as both BigBoss pipelineId and taskStore.taskId. */
  taskId: string;
  cursorSessionId?: string | null;
  signal: AbortSignal;
  stack: PipelineStack;
}

export interface ClarifyStageOutcome {
  /**
   * - "ok"     overseer fit === "ok"; orchestrator should advance.
   * - "gaps"   overseer fit === "gaps"; orchestrator may rewind to design.
   * - "noop"   overseer call failed / returned null; orchestrator should advance.
   */
  status: "ok" | "gaps" | "noop";
  result: OverseerDesignReviewResult | null;
  /** Number of clarifications appended to spec.md (0 when none / on noop). */
  clarificationsAppended: number;
}

const STAGE_LABEL = "clarify";

/**
 * Synthesize a `clarifications[]` array from the overseer's `gaps[]` /
 * `gapsByAgent` when the prompt did not return one explicitly. Each gap
 * becomes an open question; per-agent gaps are tagged with `targetAgent`.
 */
function deriveClarificationsFromReview(
  review: OverseerDesignReviewResult,
): Array<{ question: string; answer?: string; targetAgent?: string }> {
  if (review.clarifications && review.clarifications.length > 0) {
    return review.clarifications.filter((c) => c?.question?.trim().length > 0);
  }
  const items: Array<{ question: string; answer?: string; targetAgent?: string }> = [];
  if (review.gapsByAgent) {
    for (const [agent, text] of Object.entries(review.gapsByAgent)) {
      if (typeof text === "string" && text.trim()) {
        items.push({ question: text.trim(), targetAgent: agent });
      }
    }
  }
  if (review.gaps) {
    for (const gap of review.gaps) {
      if (typeof gap === "string" && gap.trim()) {
        items.push({ question: gap.trim() });
      }
    }
  }
  return items;
}

export async function runClarifyStage(input: ClarifyStageInput): Promise<ClarifyStageOutcome> {
  const log = createLogger(STAGE_LABEL);

  taskStore.emit_overseer_log(
    input.taskId,
    "BigBoss (Overseer): clarify — comparing merged design to requirements…",
    { phase: "clarify", status: "running" },
  );

  let review: OverseerDesignReviewResult | null = null;
  try {
    review = await overseerPostDesignReview(
      input.workDir,
      input.originalTask,
      input.skillsRoot,
      input.taskId,
      input.cursorSessionId,
      input.signal,
      { stack: input.stack },
    );
  } catch (err) {
    log.warn("Overseer design review threw; treating as noop", { err: String(err) }, "flow");
  }

  const status: ClarifyStageOutcome["status"] =
    review?.fit === "ok" ? "ok" : review?.fit === "gaps" ? "gaps" : "noop";

  taskStore.emit_overseer_log(
    input.taskId,
    status === "ok"
      ? "BigBoss (Overseer): clarify — design fits requirements."
      : status === "gaps"
        ? "BigBoss (Overseer): clarify — design gaps found; clarifications appended to spec.md."
        : "BigBoss (Overseer): clarify — review complete (no usable response).",
    {
      phase: "clarify",
      status: "done",
      result: status === "ok" ? "ok" : status === "gaps" ? "gaps" : undefined,
    },
  );

  let clarificationsAppended = 0;
  if (review && status === "gaps") {
    const items = deriveClarificationsFromReview(review);
    if (items.length > 0) {
      try {
        await appendClarifications(input.workDir, items);
        clarificationsAppended = items.length;
      } catch (err) {
        log.warn("Failed to append clarifications to spec.md (non-fatal)", { err: String(err) }, "flow");
      }
    }
  }

  return { status, result: review, clarificationsAppended };
}
