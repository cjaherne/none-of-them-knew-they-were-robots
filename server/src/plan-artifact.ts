/**
 * plan.md writer (+ optional research.md, data-model.md, contracts/) — the
 * "how" artefacts in the spec-kit Tier 2 v2 schema. spec.md (sibling) carries
 * the "what + why".
 *
 * Designer contributions land in `.pipeline/<agent>-plan.md` (and optionally
 * `-research.md`, `-data-model.md`, `-contracts/`); this module merges them at
 * the end of the parallel-design step. When no per-designer plan files exist
 * yet (PR1 transition before designer prompts are updated), `mergePlanContri-
 * butions` falls back to deriving plan.md from the merged DESIGN.md so v2 still
 * produces a usable artefact pair.
 *
 * `research.md`, `data-model.md`, and `contracts/` are opt-in — only written
 * when at least one designer produces a `.pipeline/<agent>-research.md` etc.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";

const PLAN_FILE = "plan.md";
const RESEARCH_FILE = "research.md";
const DATA_MODEL_FILE = "data-model.md";
const CONTRACTS_DIR = "contracts";

export interface PlanContribution {
  agent: string;
  content: string;
}

function planHeader(): string {
  return [
    "# Plan",
    "",
    "Architecture, integration boundaries, and implementation strategy.",
    "Refer to **spec.md** for what is being built and why; refer to",
    "**TASKS.md** for the executable task list.",
    "",
    "---",
    "",
  ].join("\n");
}

async function readContribution(workDir: string, agent: string, suffix: string): Promise<string> {
  try {
    const p = path.join(workDir, ".pipeline", `${agent}-${suffix}`);
    const content = await fs.readFile(p, "utf-8");
    return content.trim();
  } catch {
    return "";
  }
}

async function readDesignFallback(workDir: string): Promise<string> {
  try {
    const design = await fs.readFile(path.join(workDir, "DESIGN.md"), "utf-8");
    return design.replace(/^## Original task[\s\S]*?\n---\n/, "").trim();
  } catch {
    return "";
  }
}

/** Write `<workDir>/plan.md` from a single body string. */
export async function writePlanMd(workDir: string, body: string): Promise<void> {
  const log = createLogger("plan");
  const outPath = path.join(workDir, PLAN_FILE);
  const content = planHeader() + body.trim() + "\n";
  await fs.writeFile(outPath, content, "utf-8");
  log.info(`Wrote ${PLAN_FILE} (${content.length} chars)`, undefined, "flow");
}

/**
 * Merge per-designer `.pipeline/<agent>-plan.md` files into plan.md. Falls back
 * to deriving the body from the merged DESIGN.md when no per-designer
 * contributions exist (PR1 transition).
 */
export async function mergePlanContributions(
  workDir: string,
  agents: string[],
): Promise<{ merged: boolean; sources: string[] }> {
  const log = createLogger("plan");
  const sources: string[] = [];
  const contributions: PlanContribution[] = [];

  for (const agent of agents) {
    const content = await readContribution(workDir, agent, "plan.md");
    if (content) {
      contributions.push({ agent, content });
      sources.push(`.pipeline/${agent}-plan.md`);
    }
  }

  let body: string;
  if (contributions.length > 0) {
    body = contributions.map((c) => `## ${c.agent}\n\n${c.content}`).join("\n\n---\n\n");
  } else {
    body = await readDesignFallback(workDir);
    if (body) sources.push("DESIGN.md (fallback)");
  }

  if (!body.trim()) {
    log.info("No plan contributions and no DESIGN.md fallback; plan.md not written", undefined, "flow");
    return { merged: false, sources };
  }

  await writePlanMd(workDir, body);
  log.info(`Merged plan contributions from ${sources.length} source(s): ${sources.join(", ")}`, undefined, "flow");
  return { merged: true, sources };
}

/**
 * Merge per-designer `.pipeline/<agent>-research.md` into research.md.
 * Returns false (no-op) when no contributions exist — this artefact is opt-in.
 */
export async function mergeResearchContributions(
  workDir: string,
  agents: string[],
): Promise<boolean> {
  const log = createLogger("plan");
  const parts: string[] = [];
  for (const agent of agents) {
    const content = await readContribution(workDir, agent, "research.md");
    if (content) parts.push(`## ${agent}\n\n${content}`);
  }
  if (parts.length === 0) return false;
  const body = `# Research\n\nLibrary, framework, and approach research from the design phase.\n\n---\n\n${parts.join("\n\n---\n\n")}\n`;
  await fs.writeFile(path.join(workDir, RESEARCH_FILE), body, "utf-8");
  log.info(`Wrote ${RESEARCH_FILE} (${parts.length} contributors)`, undefined, "flow");
  return true;
}

/** Merge per-designer `.pipeline/<agent>-data-model.md` into data-model.md. Opt-in. */
export async function mergeDataModelContributions(
  workDir: string,
  agents: string[],
): Promise<boolean> {
  const log = createLogger("plan");
  const parts: string[] = [];
  for (const agent of agents) {
    const content = await readContribution(workDir, agent, "data-model.md");
    if (content) parts.push(`## ${agent}\n\n${content}`);
  }
  if (parts.length === 0) return false;
  const body = `# Data model\n\nEntities, relationships, schemas. Implementation must honour these contracts.\n\n---\n\n${parts.join("\n\n---\n\n")}\n`;
  await fs.writeFile(path.join(workDir, DATA_MODEL_FILE), body, "utf-8");
  log.info(`Wrote ${DATA_MODEL_FILE} (${parts.length} contributors)`, undefined, "flow");
  return true;
}

/**
 * Copy per-designer `.pipeline/<agent>-contracts/*` into a top-level contracts/
 * directory. Opt-in: returns the copied file count (0 = no-op).
 */
export async function collectContracts(workDir: string, agents: string[]): Promise<number> {
  const log = createLogger("plan");
  let copied = 0;
  const targetDir = path.join(workDir, CONTRACTS_DIR);
  for (const agent of agents) {
    const sourceDir = path.join(workDir, ".pipeline", `${agent}-contracts`);
    let entries: string[];
    try {
      entries = await fs.readdir(sourceDir);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    await fs.mkdir(targetDir, { recursive: true });
    for (const entry of entries) {
      try {
        const src = path.join(sourceDir, entry);
        const stat = await fs.stat(src);
        if (!stat.isFile()) continue;
        const dst = path.join(targetDir, `${agent}__${entry}`);
        await fs.copyFile(src, dst);
        copied++;
      } catch (err) {
        log.warn(`Failed to copy ${entry} from ${agent} contracts`, { err: String(err) }, "flow");
      }
    }
  }
  if (copied > 0) {
    log.info(`Copied ${copied} contract file(s) into ${CONTRACTS_DIR}/`, undefined, "flow");
  }
  return copied;
}

export async function readPlanMd(workDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(workDir, PLAN_FILE), "utf-8");
  } catch {
    return "";
  }
}

// Note: an earlier draft exported `writeDesignCompatShim()` here that wrote a
// concatenated `DESIGN.md = spec.md + plan.md` for legacy readers. It was
// never wired into the orchestrator — the existing parallel-design merge
// already keeps DESIGN.md current for v1 callers — so the function was
// removed in Tier 2 PR4 to avoid dead code. If a future PR needs the shim
// (e.g. when designers stop writing DESIGN.md entirely), reintroduce it from
// the git history.
