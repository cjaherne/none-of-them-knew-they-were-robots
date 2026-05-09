/**
 * spec.md writer — the "what + why" artefact in the spec-kit Tier 2 v2 schema.
 *
 * Replaces the "Original task" + requirements traceability portion of DESIGN.md
 * with a dedicated file. The plan.md sibling carries the "how" (architecture).
 *
 * Per-designer contributions land in `.pipeline/<agent>-spec.md`; this module
 * merges them at the end of the parallel-design step, mirroring the existing
 * `mergeDesignOutputs()` flow but per artefact. Single-designer pipelines write
 * spec.md directly from the merged DESIGN.md as a transitional fallback so PR1
 * is useful even before designer skill prompts are updated to write per-artefact
 * outputs.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";

const SPEC_FILE = "spec.md";
const REQ_LINK_MARKER = "<!-- spec-requirements-linked -->";

export interface SpecContribution {
  agent: string;
  content: string;
}

function header(originalTask: string): string {
  return [
    "# Specification",
    "",
    "## Original task (source of truth)",
    "",
    originalTask.trim(),
    "",
    "---",
    "",
  ].join("\n");
}

function requirementsLinkBlock(): string {
  return [
    "## Requirements traceability",
    "",
    "Numbered requirements extracted from the user task: **[REQUIREMENTS.md](./REQUIREMENTS.md)**.",
    "Implementation must satisfy each item or document deferral in **CODING_NOTES.md**.",
    "",
    REQ_LINK_MARKER,
    "",
    "---",
    "",
  ].join("\n");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write or replace `<workDir>/spec.md` from the original task and the merged
 * design body. The body is the "what + why" portion — typically user stories,
 * acceptance criteria, and UX-facing flows. Architecture / "how" content
 * belongs in plan.md.
 *
 * If REQUIREMENTS.md exists, a traceability link block is inserted after the
 * Original task section.
 */
export async function writeSpecMd(
  workDir: string,
  originalTask: string,
  body: string,
): Promise<void> {
  const log = createLogger("spec");
  const outPath = path.join(workDir, SPEC_FILE);
  let content = header(originalTask);
  if (await fileExists(path.join(workDir, "REQUIREMENTS.md"))) {
    content += requirementsLinkBlock();
  }
  content += body.trim() + "\n";
  await fs.writeFile(outPath, content, "utf-8");
  log.info(`Wrote ${SPEC_FILE} (${content.length} chars)`, undefined, "flow");
}

/**
 * Append a `## Clarifications` section to spec.md (used by the Tier 2 PR2
 * `clarify` stage). Idempotent at the file level — appends a new dated block
 * each call so successive clarification rounds remain visible.
 */
export async function appendClarifications(
  workDir: string,
  items: Array<{ question: string; answer?: string; targetAgent?: string }>,
): Promise<void> {
  if (!items || items.length === 0) return;
  const log = createLogger("spec");
  const outPath = path.join(workDir, SPEC_FILE);
  if (!(await fileExists(outPath))) {
    log.warn("Cannot append clarifications: spec.md missing", undefined, "flow");
    return;
  }
  const stamp = new Date().toISOString();
  const lines: string[] = ["", "## Clarifications", "", `_Recorded ${stamp}._`, ""];
  for (const it of items) {
    if (!it?.question?.trim()) continue;
    const tag = it.targetAgent ? ` _(${it.targetAgent})_` : "";
    lines.push(`- **Q${tag}:** ${it.question.trim()}`);
    if (it.answer?.trim()) {
      lines.push(`  - **A:** ${it.answer.trim()}`);
    }
  }
  lines.push("");
  await fs.appendFile(outPath, lines.join("\n"), "utf-8");
  log.info(`Appended ${items.length} clarification(s) to ${SPEC_FILE}`, undefined, "flow");
}

/**
 * Merge per-designer `.pipeline/<agent>-spec.md` files into spec.md.
 * Falls back to using the merged DESIGN.md as the spec body when no per-designer
 * spec contributions exist (PR1 transition: designer prompts may not yet write
 * per-artefact files; in that case the v2 spec.md duplicates the design body).
 */
export async function mergeSpecContributions(
  workDir: string,
  agents: string[],
  originalTask: string,
): Promise<{ merged: boolean; sources: string[] }> {
  const log = createLogger("spec");
  const sources: string[] = [];
  const contributions: SpecContribution[] = [];

  for (const agent of agents) {
    const p = path.join(workDir, ".pipeline", `${agent}-spec.md`);
    try {
      const content = await fs.readFile(p, "utf-8");
      if (content.trim()) {
        contributions.push({ agent, content });
        sources.push(`.pipeline/${agent}-spec.md`);
      }
    } catch {
      /* designer hasn't produced a per-artefact file yet */
    }
  }

  let body: string;
  if (contributions.length > 0) {
    body = contributions
      .map((c) => `## ${c.agent}\n\n${c.content.trim()}`)
      .join("\n\n---\n\n");
  } else {
    // Transitional fallback: derive spec body from DESIGN.md if present.
    try {
      const design = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
      // Strip the existing "Original task" header — writeSpecMd will re-add it.
      const stripped = design.replace(/^## Original task[\s\S]*?\n---\n/, "").trim();
      body = stripped || design.trim();
      if (body) sources.push("DESIGN.md (fallback)");
    } catch {
      body = "";
    }
  }

  if (!body.trim()) {
    log.info("No spec contributions and no DESIGN.md fallback; spec.md not written", undefined, "flow");
    return { merged: false, sources };
  }

  await writeSpecMd(workDir, originalTask, body);
  log.info(`Merged spec contributions from ${sources.length} source(s): ${sources.join(", ")}`, undefined, "flow");
  return { merged: true, sources };
}

export async function readSpecMd(workDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(workDir, SPEC_FILE), "utf-8");
  } catch {
    return "";
  }
}
