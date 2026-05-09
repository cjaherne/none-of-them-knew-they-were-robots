/**
 * Spec-kit Tier 2 PR3 — `checklist` stage runner.
 *
 * Replaces the LÖVE-only `LOVE_SMOKE_CHECKLIST=1` env behaviour with a
 * stack-agnostic, read-only review pass that consumes `CHECKLISTS.md`
 * (written by PR1's `writeChecklistsMd`) and emits a structured
 * `ChecklistStageResult`.
 *
 * Behaviour:
 *   1. Read CHECKLISTS.md. If missing or empty → noop (orchestrator
 *      advances to validation).
 *   2. Run a single OpenAI pass seeded with the checklist + workspace
 *      context (file tree, key source files, spec.md/plan.md/REQUIREMENTS.md
 *      previews) asking the model to tick each unchecked item as
 *      pass/fail/unknown.
 *   3. Apply the ticks to CHECKLISTS.md via PR1's `tickChecklistItems`.
 *   4. On `incomplete`, hand off to a SINGLE focused coding fix-up
 *      (capped by MAX_CHECKLIST_FIX_ITERATIONS=1 in bigboss-director.ts);
 *      the focused prompt lists the failed items + any path hints we can
 *      extract from their text.
 *   5. Return outcome. The orchestrator decides whether to fail the
 *      pipeline (when CHECKLIST_BLOCKING=1) or proceed advisory-only
 *      (default — matches plan §12 Q4).
 *
 * Read-only by design: the OpenAI call writes nothing to disk; tick marks
 * are applied by `tickChecklistItems` which is conservative on miss
 * (never inserts new items).
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";
import { getBigBossModel, MAX_CHECKLIST_FIX_ITERATIONS } from "./bigboss-director";
import { tickChecklistItems } from "./checklists-artifact";
import { buildContextBrief, type AgentRunResult } from "./agent-runner";
import type { PipelineStack } from "./pipeline-stages";
import { taskStore } from "./task-store";

const STAGE_LABEL = "checklist";

export interface ChecklistItemResult {
  text: string;
  status: "pass" | "fail" | "unknown";
  note?: string;
}

export interface ChecklistStageResult {
  fit: "ok" | "incomplete";
  items: ChecklistItemResult[];
  failed: string[];
}

export interface ChecklistStageInput {
  workDir: string;
  originalTask: string;
  taskId: string;
  signal: AbortSignal;
  stack: PipelineStack;
  /** Number of checklist-triggered fix-up passes already consumed (0 on first run). */
  initialFixUps: number;
  /**
   * Run a focused coding fix-up with the given prompt. Used at most once per
   * checklist stage when fit === "incomplete" and budget allows. The
   * orchestrator owns AgentRunConfig + sessionRegistry and just returns the
   * AgentRunResult.
   */
  fixUpRunner: (focusedPrompt: string) => Promise<AgentRunResult>;
}

export interface ChecklistStageOutcome {
  /**
   * - "ok"          fit === "ok"; orchestrator should advance.
   * - "incomplete"  fit === "incomplete"; one fix-up pass may have run.
   * - "noop"        CHECKLISTS.md missing/empty or OpenAI failed.
   */
  status: "ok" | "incomplete" | "noop";
  result: ChecklistStageResult | null;
  fixUpsRun: number;
  fixUpResults: AgentRunResult[];
  capReached: boolean;
  /**
   * True when CHECKLIST_BLOCKING=1 is set and final status is "incomplete"
   * (after any fix-ups). The orchestrator uses this to decide whether to
   * fail the pipeline.
   */
  shouldBlock: boolean;
}

/**
 * Heuristic: extract repo-relative path-like substrings from failed item
 * text. Matches forward-slash paths with file extensions covering source code
 * (ts/lua/py/etc), data (json/yaml/toml), markup (md/html/css), and common
 * game/web assets (png/jpg/wav/ttf/etc). Conservative — only well-formed
 * paths so the coder's focusPaths block doesn't fill with garbage.
 *
 * URLs are stripped from the input first so paths embedded in URLs (e.g.
 * `https://example.com/api/users.json`) don't leak into the result.
 *
 * Exported for unit testing; not part of the stable orchestrator surface.
 * @internal
 */
export function deriveFocusPathsFromFailed(failed: string[]): string[] {
  const paths = new Set<string>();
  const URL_RE = /\bhttps?:\/\/\S+/gi;
  const pathRe =
    /(?:\b|`)([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|lua|py|go|rs|java|cs|md|json|yaml|yml|toml|html|css|scss|png|jpg|jpeg|gif|webp|svg|wav|ogg|mp3|ttf|otf))\b/g;
  for (const f of failed) {
    const cleaned = f.replace(URL_RE, " ");
    let m: RegExpExecArray | null;
    while ((m = pathRe.exec(cleaned)) !== null) {
      const candidate = m[1].trim();
      if (candidate.length > 0 && candidate.length <= 200) {
        paths.add(candidate);
      }
    }
  }
  return Array.from(paths).slice(0, 25);
}

function formatFocusPathsBlock(paths: string[]): string {
  if (paths.length === 0) return "";
  const lines = paths.map((p) => `- ${p}`);
  return `\n\nPrefer edits under these paths (repo-relative):\n${lines.join("\n")}`;
}

async function runChecklistOpenAI(
  workDir: string,
  checklistContent: string,
  originalTask: string,
  stack: PipelineStack,
): Promise<ChecklistStageResult | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const log = createLogger(STAGE_LABEL);

  const brief = buildContextBrief("code-review", workDir);
  const fileTree = brief.fileTree || "(no file tree)";
  const sourceFiles = brief.architecturalFiles || "(no source files read)";

  let specSlice = "";
  try {
    specSlice = (await fs.readFile(path.join(workDir, "spec.md"), "utf-8")).slice(0, 8000);
  } catch {
    /* spec.md may not exist (v1 task); fall back to DESIGN.md preview from buildContextBrief */
  }
  let requirementsSlice = "";
  try {
    requirementsSlice = (await fs.readFile(path.join(workDir, "REQUIREMENTS.md"), "utf-8")).slice(0, 4000);
  } catch {
    /* optional */
  }

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();

    const systemContent = `You are BigBoss in Checklist Reviewer mode. Read the project's CHECKLISTS.md and the workspace, then decide pass/fail/unknown for each unchecked item.

Stack: ${stack === "love" ? "LÖVE2D / Lua game — verify love.load/love.update/love.draw exist, input bindings work, and persistence (love.filesystem) is wired when the spec asks for it." : "web / Node — verify build artefacts, console-clean first render, and that test scripts in package.json execute."}

Rules:
- "pass"     = you can confirm the item from the source files / file tree shown.
- "fail"     = you can confirm the item is NOT satisfied (missing implementation, contradicting code, etc.).
- "unknown"  = you cannot tell from the materials provided. Default to "unknown" rather than guessing.
- Do NOT invent items not in CHECKLISTS.md.
- "text" must echo the item exactly as written in CHECKLISTS.md (after the checkbox).
- Keep "note" under 120 chars; cite the file/line you used to decide where useful.

Respond with JSON only:
{
  "fit": "ok" | "incomplete",
  "items": [{ "text": "exact checklist item text", "status": "pass" | "fail" | "unknown", "note": "..." }],
  "failed": ["text of each failed item"]
}
"fit" is "ok" when no items have status "fail"; otherwise "incomplete".`;

    const userParts: string[] = [
      `## Original task\n${originalTask.slice(0, 4000)}`,
      `## CHECKLISTS.md\n${checklistContent.slice(0, 12000)}`,
    ];
    if (specSlice.trim()) userParts.push(`## spec.md (preview)\n${specSlice}`);
    if (requirementsSlice.trim()) userParts.push(`## REQUIREMENTS.md (preview)\n${requirementsSlice}`);
    userParts.push(`## File tree\n\`\`\`\n${fileTree}\n\`\`\``);
    userParts.push(`## Key source files\n${sourceFiles}`);

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userParts.join("\n\n") },
      ],
      max_tokens: 2048,
      temperature: 0.15,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { fit?: unknown; items?: unknown; failed?: unknown };

    if (!Array.isArray(parsed.items)) return null;
    const items: ChecklistItemResult[] = [];
    for (const it of parsed.items) {
      if (!it || typeof it !== "object") continue;
      const obj = it as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      const status =
        obj.status === "pass" || obj.status === "fail" || obj.status === "unknown"
          ? obj.status
          : "unknown";
      if (!text) continue;
      const note = typeof obj.note === "string" && obj.note.trim() ? obj.note.trim().slice(0, 200) : undefined;
      items.push({ text, status, note });
    }
    if (items.length === 0) return null;

    let failed = Array.isArray(parsed.failed)
      ? parsed.failed.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
      : [];
    if (failed.length === 0) {
      failed = items.filter((it) => it.status === "fail").map((it) => it.text);
    }

    const hasFail = items.some((it) => it.status === "fail");
    const fit: "ok" | "incomplete" =
      parsed.fit === "incomplete" || hasFail ? "incomplete" : "ok";

    log.info(
      `Checklist review: fit=${fit}, ${items.length} items (${items.filter((i) => i.status === "pass").length} pass, ${failed.length} fail)`,
      undefined,
      "flow",
    );
    return { fit, items, failed };
  } catch (err) {
    log.warn("Checklist OpenAI pass failed (non-fatal)", { err: String(err) }, "flow");
    return null;
  }
}

export async function runChecklistStage(input: ChecklistStageInput): Promise<ChecklistStageOutcome> {
  const log = createLogger(STAGE_LABEL);
  let checklistContent = "";
  try {
    checklistContent = await fs.readFile(path.join(input.workDir, "CHECKLISTS.md"), "utf-8");
  } catch {
    /* no CHECKLISTS.md — orchestrator should advance */
  }
  if (!checklistContent.trim()) {
    log.info("CHECKLISTS.md missing/empty; skipping checklist stage", undefined, "flow");
    return {
      status: "noop",
      result: null,
      fixUpsRun: 0,
      fixUpResults: [],
      capReached: false,
      shouldBlock: false,
    };
  }

  taskStore.emit_overseer_log(
    input.taskId,
    "BigBoss (Overseer): checklist — verifying acceptance criteria + smoke checks…",
    { phase: "checklist", status: "running" },
  );

  const review = await runChecklistOpenAI(input.workDir, checklistContent, input.originalTask, input.stack);

  if (!review) {
    taskStore.emit_overseer_log(
      input.taskId,
      "BigBoss (Overseer): checklist — review complete (no usable response).",
      { phase: "checklist", status: "done" },
    );
    return {
      status: "noop",
      result: null,
      fixUpsRun: 0,
      fixUpResults: [],
      capReached: false,
      shouldBlock: false,
    };
  }

  // Apply the model's tick marks to CHECKLISTS.md (conservative — never inserts).
  try {
    await tickChecklistItems(
      input.workDir,
      review.items.map((it) => ({ text: it.text, status: it.status, note: it.note })),
    );
  } catch (err) {
    log.warn("Failed to apply checklist ticks (non-fatal)", { err: String(err) }, "flow");
  }

  const passedCount = review.items.filter((i) => i.status === "pass").length;
  const failedCount = review.failed.length;

  taskStore.emit_overseer_log(
    input.taskId,
    review.fit === "ok"
      ? `BigBoss (Overseer): checklist — all items satisfied (${passedCount} pass).`
      : `BigBoss (Overseer): checklist — ${failedCount} item(s) failed; ${input.initialFixUps < MAX_CHECKLIST_FIX_ITERATIONS ? "running coder fix-up" : "fix-up budget exhausted"}.`,
    {
      phase: "checklist",
      status: "done",
      result: review.fit === "ok" ? "ok" : "incomplete",
    },
  );

  const blocking = process.env.CHECKLIST_BLOCKING === "1";

  if (review.fit === "ok") {
    return {
      status: "ok",
      result: review,
      fixUpsRun: input.initialFixUps,
      fixUpResults: [],
      capReached: input.initialFixUps >= MAX_CHECKLIST_FIX_ITERATIONS,
      shouldBlock: false,
    };
  }

  // fit === "incomplete" — try a single fix-up pass when budget allows.
  if (input.initialFixUps >= MAX_CHECKLIST_FIX_ITERATIONS) {
    return {
      status: "incomplete",
      result: review,
      fixUpsRun: input.initialFixUps,
      fixUpResults: [],
      capReached: true,
      shouldBlock: blocking,
    };
  }

  const focusPaths = deriveFocusPathsFromFailed(review.failed);
  const focusBlock = formatFocusPathsBlock(focusPaths);
  const failedBullets = review.failed.slice(0, 12).map((f) => `- ${f}`).join("\n");
  const fixUpPrompt =
    `${input.originalTask}\n\n## Checklist failures (${input.stack} stack)${focusBlock}\n\nThe checklist stage flagged these items as not satisfied. Address each one or document deferral under **Deviations** in CODING_NOTES.md (with rationale):\n\n${failedBullets}\n\nDo NOT remove items from CHECKLISTS.md — the next checklist pass will re-tick them.`;

  taskStore.emit_log(
    input.taskId,
    `Checklist fix-up (1/${MAX_CHECKLIST_FIX_ITERATIONS}): ${failedCount} failed item(s), ${focusPaths.length} focus path(s).`,
  );

  let fixUpResult: AgentRunResult;
  try {
    fixUpResult = await input.fixUpRunner(fixUpPrompt);
  } catch (err) {
    log.warn("Checklist fix-up runner failed", { err: String(err) }, "flow");
    return {
      status: "incomplete",
      result: review,
      fixUpsRun: input.initialFixUps,
      fixUpResults: [],
      capReached: true,
      shouldBlock: blocking,
    };
  }

  if (fixUpResult.success) {
    taskStore.emit_log(
      input.taskId,
      `Checklist fix-up completed: ${fixUpResult.filesModified?.length ?? 0} files.`,
    );
  }

  // Note: we do NOT re-run the checklist after the fix-up. PR3 ships a single
  // pass + single fix-up to keep latency bounded; a recheck loop is reserved
  // for a follow-up if real-world goldens show the fix-up regularly clears
  // failures (in which case the recheck would surface the win to the UI).
  return {
    status: "incomplete",
    result: review,
    fixUpsRun: input.initialFixUps + 1,
    fixUpResults: [fixUpResult],
    capReached: true,
    shouldBlock: blocking,
  };
}
