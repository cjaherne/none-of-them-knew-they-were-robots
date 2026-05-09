/**
 * Per-project governance document loader. Inspired by spec-kit's `.specify/memory/constitution.md`.
 *
 * Resolution order (first match wins):
 *   1. <workDir>/.specify/memory/constitution.md  (spec-kit convention)
 *   2. <workDir>/CONSTITUTION.md                  (root-level convention)
 *
 * The loaded text is injected into every specialist + Overseer prompt by
 * `agent-runner.buildFullPrompt()` so all agents share the same governing principles.
 *
 * Bootstrap: when `CONSTITUTION_BOOTSTRAP=1` is set and no constitution file exists,
 * the orchestrator can call `bootstrapConstitutionFromTask` once per workspace to draft
 * an initial document from the user's task prompt. Bootstrap is opt-in to avoid
 * surprising users by writing files into their existing repos.
 */
import { promises as fs, readFileSync, existsSync } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";
import { getBigBossModel } from "./bigboss-director";

/** Cap injected into prompts to bound token use; mirrors the BigBoss skill-pack truncation. */
const CONSTITUTION_PROMPT_CAP_CHARS = 8000;

const SPEC_KIT_PATH = path.join(".specify", "memory", "constitution.md");
const ROOT_PATH = "CONSTITUTION.md";

function resolveConstitutionPath(workDir: string): string | null {
  const candidates = [path.join(workDir, SPEC_KIT_PATH), path.join(workDir, ROOT_PATH)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Sync loader for `agent-runner.buildFullPrompt`; returns "" when absent. */
export function loadConstitutionSync(workDir: string): string {
  const found = resolveConstitutionPath(workDir);
  if (!found) return "";
  try {
    return readFileSync(found, "utf-8").trim();
  } catch {
    return "";
  }
}

/** Format the constitution as a system-prompt block (truncated). Returns "" when absent. */
export function formatConstitutionForPrompt(workDir: string): string {
  const raw = loadConstitutionSync(workDir);
  if (!raw) return "";
  const body =
    raw.length > CONSTITUTION_PROMPT_CAP_CHARS
      ? `${raw.slice(0, CONSTITUTION_PROMPT_CAP_CHARS)}\n\n[…constitution truncated — read the full file from disk if needed…]`
      : raw;
  return `## Project constitution (governing principles — apply to every decision)\n\n${body}\n\n---\n\n`;
}

/** Async existence check that does not throw. */
export async function constitutionExists(workDir: string): Promise<boolean> {
  return resolveConstitutionPath(workDir) !== null;
}

function fallbackConstitution(prompt: string): string {
  const trimmed = prompt.trim().slice(0, 600);
  return `# Project constitution

Initial draft generated from the first task prompt. Edit this file at any time;
it is loaded into every agent's prompt and treated as the source of truth for
project-wide governance.

## Origin task

> ${trimmed.replace(/\n+/g, "\n> ")}

## Principles (edit these)

1. **Code quality** — favour small, well-named, tested units; avoid speculative
   abstraction; comment only non-obvious intent.
2. **Testing** — every behaviour-changing pull request should ship with a
   test that fails before the change and passes after.
3. **User experience** — keep the user in the loop on destructive actions;
   prefer reversible operations.
4. **Performance** — measure before optimising; document any non-trivial
   performance contract in the spec.
5. **Security** — never commit secrets; validate inputs at trust boundaries;
   prefer parameterised queries.

## Governance

- Changes to this file require a commit on the default branch.
- Specs and plans MUST honour every principle above; deviations MUST be
  documented under "Deviations" in CODING_NOTES.md.
`;
}

/**
 * Generate a draft constitution from the first task prompt and write it to
 * `<workDir>/.specify/memory/constitution.md`. No-op when the file already exists.
 * Opt-in: only runs when `CONSTITUTION_BOOTSTRAP=1` is set.
 */
export async function bootstrapConstitutionFromTask(
  workDir: string,
  prompt: string,
): Promise<{ written: boolean; pathRelative?: string; reason?: string }> {
  if (process.env.CONSTITUTION_BOOTSTRAP !== "1") {
    return { written: false, reason: "CONSTITUTION_BOOTSTRAP not set" };
  }
  if (await constitutionExists(workDir)) {
    return { written: false, reason: "constitution already present" };
  }

  const log = createLogger("constitution");
  const targetDir = path.join(workDir, ".specify", "memory");
  const targetPath = path.join(targetDir, "constitution.md");

  let body: string | null = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const model = getBigBossModel();
      const response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: `You draft a per-project constitution.md (governance for AI agents working on the project).
Output **markdown only** with these top-level sections in order:
# Project constitution
## Origin task (quote the user task as a blockquote, max 6 lines)
## Principles (5–8 numbered items: code quality, testing, UX consistency, performance, security; tailor names/wording to the project type)
## Governance (3–5 bullets: how the constitution is updated, how deviations are documented)
Keep the document under 1500 words. Be concrete and project-specific. Reference the task type (web, LÖVE game, CLI, etc.) where it changes the principle wording.`,
          },
          { role: "user", content: prompt.slice(0, 4000) },
        ],
        max_tokens: 1500,
        temperature: 0.2,
      });
      const raw = response.choices[0]?.message?.content?.trim();
      if (raw) body = raw;
    } catch (err) {
      log.warn("Constitution bootstrap via OpenAI failed; using fallback", { err: String(err) }, "flow");
    }
  }

  const finalContent = body ?? fallbackConstitution(prompt);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, finalContent, "utf-8");
  log.info(`Wrote ${SPEC_KIT_PATH} (bootstrap, ${finalContent.length} chars)`, undefined, "flow");
  return { written: true, pathRelative: SPEC_KIT_PATH };
}
