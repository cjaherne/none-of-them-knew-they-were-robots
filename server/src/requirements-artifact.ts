/**
 * Generates REQUIREMENTS.md — numbered traceability from the user prompt for design/coding/review.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";
import { getBigBossModel } from "./bigboss-director";

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
