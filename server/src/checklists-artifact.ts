/**
 * CHECKLISTS.md writer + ticker — stack-agnostic per-task quality checklist.
 *
 * Replaces the LÖVE-only `LOVE_SMOKE_CHECKLIST` env behaviour: every v2 task
 * gets a CHECKLISTS.md generated from spec.md (acceptance criteria), the
 * pipeline stack (smoke checks), and the constitution (governance checks).
 * The Tier 2 PR3 `checklist` stage will read this file, tick `[X]` items it
 * can confirm, and emit a structured pass/fail summary.
 *
 * Tier 2 PR1 ships only the writer + ticker; the consumer (checklist stage)
 * lands in PR3. With the writer in place, the file is visible in the workspace
 * and can be edited by humans or downstream tooling.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";
import {
  OVERSEER_LOVE_CODE_CHECKLIST,
  OVERSEER_LOVE_DESIGN_CHECKLIST,
} from "./overseer-love-checklists";
import { getBigBossModel } from "./bigboss-director";
import type { PipelineStack } from "./pipeline-stages";

const CHECKLISTS_FILE = "CHECKLISTS.md";

export interface ChecklistInput {
  workDir: string;
  stack: PipelineStack;
  originalTask: string;
}

export interface ChecklistTickResult {
  text: string;
  status: "pass" | "fail" | "unknown";
  note?: string;
}

const WEB_SMOKE_DEFAULTS: string[] = [
  "Project builds without errors (`npm run build` exit 0).",
  "No console errors on initial page render or process boot.",
  "Linter / type-checker passes on the changed files.",
];

function loveSmokeBullets(): string[] {
  // Reuse the existing LÖVE checklist content as smoke-check items.
  const both = `${OVERSEER_LOVE_DESIGN_CHECKLIST}\n${OVERSEER_LOVE_CODE_CHECKLIST}`;
  return both
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

function fallbackChecklists(stack: PipelineStack, originalTask: string): string {
  const smoke = stack === "love" ? loveSmokeBullets() : WEB_SMOKE_DEFAULTS;
  const tagline = originalTask.trim().slice(0, 200).replace(/\n+/g, " ");
  const lines: string[] = [
    "# Checklists",
    "",
    "Per-task quality checklist. Tick `[X]` when an item is verified;",
    "leave `[ ]` when not yet checked. The Tier 2 `checklist` stage (PR3)",
    "will tick items it can confirm automatically and surface failures.",
    "",
    "## Acceptance criteria (from spec.md)",
    "",
    `- [ ] Implementation satisfies the user task: _${tagline}_`,
    "- [ ] Each REQUIREMENTS.md item (R1, R2, …) is implemented or deferral is documented in CODING_NOTES.md.",
    "- [ ] DESIGN.md / spec.md / plan.md sections are reflected in code.",
    "",
    `## Smoke checks (stack: ${stack})`,
    "",
  ];
  for (const item of smoke) lines.push(`- [ ] ${item}`);
  lines.push(
    "",
    "## Constitution checks",
    "",
    "- [ ] Code matches the project constitution.md (audited by the analyze stage when present).",
    "- [ ] Destructive operations are flagged for approval.",
    "- [ ] No secrets, API keys, or credentials are committed.",
    "",
  );
  return lines.join("\n");
}

async function generateAcceptanceWithOpenAI(
  workDir: string,
  originalTask: string,
): Promise<string[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const log = createLogger("checklists");
  let specSlice = "";
  try {
    specSlice = (await fs.readFile(path.join(workDir, "spec.md"), "utf-8")).slice(0, 12000);
  } catch {
    /* spec.md may not exist yet */
  }
  let requirementsSlice = "";
  try {
    requirementsSlice = (await fs.readFile(path.join(workDir, "REQUIREMENTS.md"), "utf-8")).slice(0, 4000);
  } catch {
    /* optional */
  }
  if (!specSlice.trim() && !requirementsSlice.trim()) return null;

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: `Extract user-facing acceptance criteria from a software task. Output JSON only:
{ "items": ["short imperative criterion (<=120 chars)", ...] }
Rules:
- Each item is a single observable behaviour or outcome the user can verify.
- 4–10 items total. Be concrete: prefer "User can save a draft" over "Drafts work".
- Skip implementation/architecture details (those belong in plan.md).
- Reference specific R-numbered requirements when the spec maps cleanly.`,
        },
        {
          role: "user",
          content: [
            `## Original task\n${originalTask.slice(0, 3000)}`,
            specSlice ? `## spec.md\n${specSlice}` : "",
            requirementsSlice ? `## REQUIREMENTS.md\n${requirementsSlice}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      max_tokens: 700,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    const items = parsed.items
      .filter((it): it is string => typeof it === "string" && it.trim().length > 0)
      .map((it) => it.trim())
      .slice(0, 12);
    log.info(`Extracted ${items.length} acceptance criteria via ${model}`, undefined, "flow");
    return items;
  } catch (err) {
    log.warn("Acceptance extraction failed; using fallback", { err: String(err) }, "flow");
    return null;
  }
}

/**
 * Write `<workDir>/CHECKLISTS.md` from spec.md + REQUIREMENTS.md + the pipeline
 * stack. Always writes a file; uses an OpenAI extraction for the acceptance
 * section when available, otherwise falls back to a stack-default skeleton.
 */
export async function writeChecklistsMd(
  input: ChecklistInput,
): Promise<{ path: string; itemCount: number; usedOpenAI: boolean }> {
  const log = createLogger("checklists");
  const outPath = path.join(input.workDir, CHECKLISTS_FILE);
  const acceptance = await generateAcceptanceWithOpenAI(input.workDir, input.originalTask);
  const usedOpenAI = acceptance !== null && acceptance.length > 0;

  let body: string;
  if (usedOpenAI && acceptance) {
    const smoke = input.stack === "love" ? loveSmokeBullets() : WEB_SMOKE_DEFAULTS;
    const lines: string[] = [
      "# Checklists",
      "",
      "Per-task quality checklist. Tick `[X]` when an item is verified.",
      "",
      "## Acceptance criteria (from spec.md)",
      "",
    ];
    for (const item of acceptance) lines.push(`- [ ] ${item}`);
    lines.push("", `## Smoke checks (stack: ${input.stack})`, "");
    for (const item of smoke) lines.push(`- [ ] ${item}`);
    lines.push(
      "",
      "## Constitution checks",
      "",
      "- [ ] Code matches the project constitution.md (audited by the analyze stage when present).",
      "- [ ] Destructive operations are flagged for approval.",
      "- [ ] No secrets, API keys, or credentials are committed.",
      "",
    );
    body = lines.join("\n");
  } else {
    body = fallbackChecklists(input.stack, input.originalTask);
  }

  await fs.writeFile(outPath, body, "utf-8");
  const itemCount = (body.match(/^- \[ \]/gm) || []).length;
  log.info(`Wrote ${CHECKLISTS_FILE} (${itemCount} items, ${usedOpenAI ? "openai" : "fallback"})`, undefined, "flow");
  return { path: outPath, itemCount, usedOpenAI };
}

/**
 * Apply tick results to CHECKLISTS.md. Each result targets an item by exact
 * `text` match (line tail after the checkbox); pass → `[X]`, fail → `[!]`,
 * unknown → leave `[ ]`. Notes are appended in italics on the same line.
 *
 * Conservative on miss: if the text doesn't match a line, the result is logged
 * and skipped — never inserts new items.
 */
export async function tickChecklistItems(
  workDir: string,
  results: ChecklistTickResult[],
): Promise<{ updated: number; skipped: number }> {
  const log = createLogger("checklists");
  const outPath = path.join(workDir, CHECKLISTS_FILE);
  let body: string;
  try {
    body = await fs.readFile(outPath, "utf-8");
  } catch {
    log.warn("CHECKLISTS.md missing; cannot tick items", undefined, "flow");
    return { updated: 0, skipped: results.length };
  }

  let updated = 0;
  let skipped = 0;
  const lines = body.split("\n");
  for (const r of results) {
    if (!r?.text?.trim()) {
      skipped++;
      continue;
    }
    const target = r.text.trim();
    const idx = lines.findIndex(
      (l) => l.startsWith("- [ ]") && l.slice(5).trim().startsWith(target.slice(0, 60)),
    );
    if (idx === -1) {
      skipped++;
      continue;
    }
    const marker = r.status === "pass" ? "[X]" : r.status === "fail" ? "[!]" : "[ ]";
    const noteSuffix = r.note?.trim() ? `  _(${r.note.trim()})_` : "";
    lines[idx] = `- ${marker} ${lines[idx].slice(5).trim()}${noteSuffix}`;
    updated++;
  }

  await fs.writeFile(outPath, lines.join("\n"), "utf-8");
  log.info(`Ticked ${updated} item(s), skipped ${skipped}`, undefined, "flow");
  return { updated, skipped };
}

export async function readChecklistsMd(workDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(workDir, CHECKLISTS_FILE), "utf-8");
  } catch {
    return "";
  }
}
