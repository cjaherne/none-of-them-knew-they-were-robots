/**
 * Generates TASKS.md — a spec-kit-style ordered, dependency-aware task list with
 * `[P]` parallel markers and target file paths. Written by the orchestrator after
 * design merge but before the coding stage; read by coding/lua-coding agents as
 * an executable plan that complements REQUIREMENTS.md (atomic items), spec.md
 * (what + why), and plan.md (architecture / how).
 *
 * TASKS.md is generated from BigBoss's planned stages + spec.md + plan.md +
 * REQUIREMENTS.md (when available). Coding agents read it but are not yet
 * required to tick `[X]` markers.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "@agents/shared";
import { getBigBossModel } from "./bigboss-director";
import type { StageDefinition, PipelineStack } from "./pipeline-stages";

export interface PlannedTaskInput {
  workDir: string;
  originalTask: string;
  stages: StageDefinition[];
  stack: PipelineStack;
}

const TASKS_FILE = "TASKS.md";

interface ExtractedTask {
  id: string;
  text: string;
  parallel: boolean;
  /** repo-relative target path(s) when the model can name them. */
  paths?: string[];
  /** REQUIREMENTS.md ids satisfied by this task, e.g. "R1, R3". */
  requirementIds?: string[];
  phase: string;
}

function header(): string {
  return [
    "# Tasks",
    "",
    "Executable task list derived from the BigBoss pipeline plan, spec.md, plan.md, and",
    "REQUIREMENTS.md. Mark `[X]` when complete. `[P]` = safe to run in parallel",
    "with siblings in the same phase. Each row may reference repo-relative paths",
    "and REQUIREMENTS.md ids (e.g. R1, R3).",
    "",
  ].join("\n");
}

function renderRow(task: ExtractedTask): string {
  const checkbox = "[ ]";
  const parallel = task.parallel ? " [P]" : "";
  const reqs = task.requirementIds && task.requirementIds.length > 0 ? ` (${task.requirementIds.join(", ")})` : "";
  const paths =
    task.paths && task.paths.length > 0
      ? ` → ${task.paths.map((p) => `\`${p}\``).join(", ")}`
      : "";
  return `- ${checkbox} ${task.id}${parallel}${reqs} ${task.text.trim()}${paths}`;
}

function renderTasks(tasks: ExtractedTask[]): string {
  if (tasks.length === 0) return "_(no tasks extracted)_\n";
  const phases = new Map<string, ExtractedTask[]>();
  for (const t of tasks) {
    const arr = phases.get(t.phase) ?? [];
    arr.push(t);
    phases.set(t.phase, arr);
  }
  const out: string[] = [];
  let phaseIdx = 1;
  for (const [phase, items] of phases) {
    out.push(`## Phase ${phaseIdx}: ${phase}`);
    out.push("");
    for (const t of items) out.push(renderRow(t));
    out.push("");
    phaseIdx++;
  }
  return out.join("\n");
}

function fallbackTasksFromStages(stages: StageDefinition[], stack: PipelineStack): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];
  let id = 1;

  const designStages = stages.filter((s) => s.category === "design");
  if (designStages.length > 0) {
    const phase = "Design";
    if (designStages.length === 1) {
      tasks.push({
        id: `T${id++}`,
        text: `Run ${designStages[0].agent} to produce spec.md and plan.md.`,
        parallel: false,
        paths: ["spec.md", "plan.md"],
        phase,
      });
    } else {
      for (const s of designStages) {
        tasks.push({
          id: `T${id++}`,
          text: `${s.agent}: contribute to spec.md / plan.md.`,
          parallel: true,
          paths: [`.pipeline/${s.agent}-spec.md`, `.pipeline/${s.agent}-plan.md`],
          phase,
        });
      }
      tasks.push({
        id: `T${id++}`,
        text: "Merge per-designer contributions into spec.md and plan.md.",
        parallel: false,
        paths: ["spec.md", "plan.md"],
        phase,
      });
    }
  }

  const codingStages = stages.filter((s) => s.category === "coding");
  if (codingStages.length > 0) {
    const phase = "Implementation";
    for (const s of codingStages) {
      tasks.push({
        id: `T${id++}`,
        text:
          stack === "love"
            ? `Run ${s.agent} to implement the LÖVE game per spec.md / plan.md (locomotion before polish).`
            : `Run ${s.agent} to implement features per spec.md / plan.md.`,
        parallel: false,
        paths: stack === "love" ? ["main.lua", "conf.lua", "src/"] : undefined,
        phase,
      });
    }
  }

  const validationStages = stages.filter((s) => s.category === "validation");
  if (validationStages.length > 0) {
    const phase = "Validation";
    for (const s of validationStages) {
      tasks.push({
        id: `T${id++}`,
        text:
          s.agent === "love-testing"
            ? `Run ${s.agent}: busted unit tests + LÖVE smoke (love .).`
            : `Run ${s.agent}: project test suite + lint.`,
        parallel: false,
        phase,
      });
    }
  }

  const releaseStages = stages.filter((s) => s.category === "release");
  for (const s of releaseStages) {
    tasks.push({
      id: `T${id++}`,
      text: `Run ${s.agent}: README/SemVer bump, build, PR, squash-merge, tag on main.`,
      parallel: false,
      phase: "Release",
    });
  }

  return tasks;
}

async function readSlice(workDir: string, file: string, max: number): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(workDir, file), "utf-8");
    return raw.slice(0, max);
  } catch {
    return "";
  }
}

async function extractTasksWithOpenAI(
  workDir: string,
  originalTask: string,
  stages: StageDefinition[],
  stack: PipelineStack,
): Promise<ExtractedTask[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const log = createLogger("tasks");
  const specSlice = await readSlice(workDir, "spec.md", 8000);
  const planSlice = await readSlice(workDir, "plan.md", 8000);
  if (!specSlice.trim() && !planSlice.trim()) {
    log.info("No spec.md or plan.md content yet; using stage-derived fallback", undefined, "flow");
    return null;
  }
  const requirementsSlice = await readSlice(workDir, "REQUIREMENTS.md", 4000);
  const stageSummary = stages.map((s) => `${s.name} (${s.agent}/${s.category})`).join(" → ");

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getBigBossModel();
    const system = `You decompose a software task into an ordered, dependency-aware task list.
Output JSON only:
{ "tasks": [
  { "id": "T1", "text": "concise imperative task", "parallel": false, "paths": ["src/foo.ts"], "requirementIds": ["R1"], "phase": "Implementation" }
] }
Rules:
- Use phases (in order): "Design", "Implementation", "Validation", "Release". Skip phases not in the pipeline plan.
- Ids T1, T2, … in dependency order.
- "parallel": true ONLY when the task has no dependency on a sibling in the same phase (safe to run concurrently).
- "paths": repo-relative file or directory paths the task creates/modifies (omit if unknown).
- "requirementIds": REQUIREMENTS.md ids (R1, R2, …) the task implements; omit when none apply.
- "text" is one short imperative sentence (≤ 120 chars). No prose explanations.
- Stack: ${stack === "love" ? "LÖVE2D / Lua game — order locomotion + bootstrap before polish; reference main.lua, conf.lua, src/scenes, src/systems, assets/." : "web/Node — reference src/, tests/, package.json scripts; do not invent paths."}.
- 5–12 tasks total. Skip trivial setup unless the task explicitly requires it.`;

    const userParts: string[] = [
      `## Original task\n${originalTask.slice(0, 4000)}`,
      `## Pipeline stages (BigBoss plan)\n${stageSummary}`,
    ];
    if (specSlice.trim()) {
      userParts.push(`## spec.md (excerpt)\n${specSlice}`);
    }
    if (planSlice.trim()) {
      userParts.push(`## plan.md (excerpt)\n${planSlice}`);
    }
    if (requirementsSlice.trim()) {
      userParts.push(`## REQUIREMENTS.md (excerpt)\n${requirementsSlice}`);
    }

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userParts.join("\n\n") },
      ],
      max_tokens: 1500,
      temperature: 0.15,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) return null;

    const out: ExtractedTask[] = [];
    for (const t of parsed.tasks) {
      if (!t || typeof t !== "object") continue;
      const obj = t as Record<string, unknown>;
      const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `T${out.length + 1}`;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) continue;
      const phase = typeof obj.phase === "string" && obj.phase.trim() ? obj.phase.trim() : "Implementation";
      const parallel = obj.parallel === true;
      const paths = Array.isArray(obj.paths)
        ? obj.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()).slice(0, 6)
        : undefined;
      const requirementIds = Array.isArray(obj.requirementIds)
        ? obj.requirementIds
            .filter((p): p is string => typeof p === "string" && /^R\d+$/i.test(p.trim()))
            .map((p) => p.trim().toUpperCase())
            .slice(0, 8)
        : undefined;
      out.push({ id, text, parallel, paths, requirementIds, phase });
    }
    if (out.length === 0) return null;
    log.info(`Extracted ${out.length} tasks via ${model}`, undefined, "flow");
    return out;
  } catch (err) {
    log.warn("Tasks extraction failed; falling back to stage-derived list", { err: String(err) }, "flow");
    return null;
  }
}

/**
 * Write `<workDir>/TASKS.md` from BigBoss's planned stages, spec.md, plan.md,
 * and REQUIREMENTS.md (when available). Always writes a file; uses an OpenAI
 * extraction when API key is set, otherwise falls back to a stage-derived skeleton.
 */
export async function writeTasksMd(input: PlannedTaskInput): Promise<{ path: string; taskCount: number }> {
  const log = createLogger("tasks");
  const outPath = path.join(input.workDir, TASKS_FILE);
  const extracted = await extractTasksWithOpenAI(input.workDir, input.originalTask, input.stages, input.stack);
  const tasks = extracted ?? fallbackTasksFromStages(input.stages, input.stack);
  const body = `${header()}\n${renderTasks(tasks)}`;
  await fs.writeFile(outPath, body, "utf-8");
  log.info(`Wrote ${TASKS_FILE} (${tasks.length} tasks${extracted ? "" : ", fallback"})`, undefined, "flow");
  return { path: outPath, taskCount: tasks.length };
}

/** Read TASKS.md if present (used by Overseer / UI / tests). */
export async function readTasksMd(workDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(workDir, TASKS_FILE), "utf-8");
  } catch {
    return "";
  }
}
