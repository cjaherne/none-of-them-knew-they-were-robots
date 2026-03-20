/**
 * Generates REQUIREMENTS.md — numbered traceability from the user prompt for design/coding/review.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";
import { getBigBossModel } from "./bigboss-director";

const REQ_MARKER = "<!-- requirements-traceability-linked -->";

export interface SmokeChecklistResult {
  movementOk: boolean;
  persistenceOk: boolean;
  issues: string[];
}

function fallbackRequirementsMarkdown(prompt: string): string {
  const lines = prompt
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const bullets = lines.length > 0 ? lines : [prompt.trim()];
  const body = bullets
    .map((text, i) => `${i + 1}. ${text}`)
    .join("\n");
  return `# Extracted requirements\n\n${body}\n\n## Categories (fallback)\n\nAssign mentally: persistence, input, combat, presentation, meta — refine after OpenAI extraction when available.\n`;
}

export async function generateRequirementsArtifact(workDir: string, userPrompt: string): Promise<void> {
  const outPath = path.join(workDir, "REQUIREMENTS.md");
  const log = createLogger("requirements");

  if (!process.env.OPENAI_API_KEY) {
    await fs.writeFile(outPath, fallbackRequirementsMarkdown(userPrompt), "utf-8");
    log.info("Wrote REQUIREMENTS.md (fallback, no OPENAI_API_KEY)", undefined, "flow");
    return;
  }

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: `You extract discrete, testable requirements from the user's task. Output JSON only:
{ "items": [ { "id": "R1", "text": "concise requirement", "category": "persistence" | "input" | "combat" | "presentation" | "meta" } ] }
Rules:
- One row per distinct user ask (split compound sentences).
- Use category persistence for scores/saves across runs, settings files, love.filesystem.
- Use input for keyboard, mouse, gamepad, local multiplayer controls.
- Use combat for weapons, damage, turns, teams, procedural maps, game rules.
- Use presentation for art, UI theme, readability, animations, sfx.
- Use meta for tech stack, performance, testing.
- ids R1, R2, ... in order.`,
        },
        { role: "user", content: userPrompt.slice(0, 12000) },
      ],
      max_tokens: 2048,
      temperature: 0.15,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error("empty response");
    const parsed = JSON.parse(raw) as { items?: Array<{ id?: string; text?: string; category?: string }> };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if (items.length === 0) throw new Error("no items");

    const lines: string[] = ["# Requirements", "", "Extracted from the user task for traceability (design, coding, review).", ""];
    for (const it of items) {
      const id = typeof it.id === "string" ? it.id : `R${lines.length}`;
      const text = typeof it.text === "string" ? it.text : "";
      const cat = typeof it.category === "string" ? it.category : "meta";
      if (text.trim()) lines.push(`- **${id}** (${cat}): ${text.trim()}`);
    }
    lines.push("");
    await fs.writeFile(outPath, lines.join("\n"), "utf-8");
    log.info(`Wrote REQUIREMENTS.md (${items.length} items)`, undefined, "flow");
  } catch (err) {
    log.warn("Requirements extraction failed, using fallback", { err: String(err) }, "flow");
    await fs.writeFile(outPath, fallbackRequirementsMarkdown(userPrompt), "utf-8");
  }
}

export async function appendRequirementsUserRevision(workDir: string, feedback: string): Promise<void> {
  const outPath = path.join(workDir, "REQUIREMENTS.md");
  const block = `\n\n## User revision (pipeline approval)\n\n${feedback.trim()}\n`;
  await fs.appendFile(outPath, block, "utf-8");
}

/**
 * If REQUIREMENTS.md exists and DESIGN.md does not yet link it, insert a traceability section after the Original task header block.
 */
export async function ensureDesignReferencesRequirements(workDir: string): Promise<void> {
  const reqPath = path.join(workDir, "REQUIREMENTS.md");
  const designPath = path.join(workDir, "DESIGN.md");
  try {
    await fs.access(reqPath);
  } catch {
    return;
  }
  let design: string;
  try {
    design = await fs.readFile(designPath, "utf-8");
  } catch {
    return;
  }
  if (design.includes(REQ_MARKER)) return;

  const insert = `\n\n## Requirements traceability\n\nNumbered requirements extracted from the user task: **[REQUIREMENTS.md](./REQUIREMENTS.md)**. Implementation must satisfy each item or document deferral in **CODING_NOTES.md**.\n\n${REQ_MARKER}\n\n---\n\n`;

  if (design.startsWith("## Original task")) {
    const idx = design.indexOf("\n---\n");
    if (idx !== -1) {
      const after = idx + "\n---\n".length;
      const next = design.slice(0, after) + insert + design.slice(after);
      await fs.writeFile(designPath, next, "utf-8");
      return;
    }
  }
  await fs.writeFile(designPath, insert + design, "utf-8");
}

export async function runLoveSmokeChecklistOpenAI(
  workDir: string,
  userPrompt: string,
): Promise<SmokeChecklistResult | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const log = createLogger("love-smoke");

  let fileSnippet = "";
  try {
    const main = await fs.readFile(path.join(workDir, "main.lua"), "utf-8").catch(() => "");
    const tree = await fs.readFile(path.join(workDir, "README.md"), "utf-8").catch(() => "");
    fileSnippet = `main.lua (first 2000 chars):\n${main.slice(0, 2000)}\n\nREADME (first 1500 chars):\n${tree.slice(0, 1500)}`;
  } catch {
    /* ignore */
  }

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: `You assess a LÖVE game repo for two risks: (1) player movement — is there clear handling of keyboard/gamepad to move the active character? (2) persistence — if the user asked for scores/stats across launches/sessions, is love.filesystem (or equivalent) used?
Respond JSON only: { "movementOk": true|false, "persistenceOk": true|false, "issues": ["short strings"] }
If the prompt does not ask for cross-session persistence, set persistenceOk true when in doubt.`,
        },
        {
          role: "user",
          content: `## User task\n${userPrompt.slice(0, 4000)}\n\n## Repo snippet\n${fileSnippet}`,
        },
      ],
      max_tokens: 512,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const p = JSON.parse(raw) as SmokeChecklistResult;
    const issues = Array.isArray(p.issues) ? p.issues.filter((x): x is string => typeof x === "string") : [];
    log.info("Love smoke checklist", { movementOk: p.movementOk, persistenceOk: p.persistenceOk }, "flow");
    return {
      movementOk: !!p.movementOk,
      persistenceOk: !!p.persistenceOk,
      issues,
    };
  } catch (err) {
    log.warn("Love smoke checklist failed", { err: String(err) }, "flow");
    return null;
  }
}
