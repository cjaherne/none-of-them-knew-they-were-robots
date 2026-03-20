import { spawn } from "child_process";
import { execSync } from "child_process";
import { promises as fs, access as accessCb } from "fs";
import * as path from "path";
import * as os from "os";
import { createLogger } from "@agents/shared";
import { loadSkillPack, SkillPack } from "./skill-loader";
import { loadBigBossSystemPromptSync } from "./bigboss-prompt-loader";
import { OVERSEER_LOVE_CODE_CHECKLIST, OVERSEER_LOVE_DESIGN_CHECKLIST } from "./overseer-love-checklists";
import { getCursorAgentSessionsMode } from "./cursor-session-policy";

const log = createLogger("agent-runner");

interface ResolvedAgent {
  bin: string;
  args: string[];
  direct: boolean;
}

function resolveAgent(): ResolvedAgent {
  if (process.env.CURSOR_CLI) {
    return { bin: process.env.CURSOR_CLI, args: [], direct: false };
  }

  // Prefer calling the agent's node binary directly -- avoids cmd.exe and
  // PowerShell wrappers that break stdin piping and process tree kills on Windows.
  if (process.platform === "win32") {
    const versionsDir = path.join(os.homedir(), "AppData", "Local", "cursor-agent", "versions");
    try {
      const versions = require("fs").readdirSync(versionsDir).sort().reverse();
      for (const ver of versions) {
        const nodeExe = path.join(versionsDir, ver, "node.exe");
        const indexJs = path.join(versionsDir, ver, "index.js");
        try {
          require("fs").accessSync(nodeExe);
          require("fs").accessSync(indexJs);
          return { bin: nodeExe, args: [indexJs], direct: true };
        } catch { /* try next version */ }
      }
    } catch { /* versions dir missing */ }
  }

  // Fallback: .cmd wrapper (unix doesn't have the same issues)
  const candidates = [
    path.join(os.homedir(), "AppData", "Local", "cursor-agent", "agent.cmd"),
    path.join(os.homedir(), ".cursor", "bin", "agent"),
    path.join(os.homedir(), ".cursor", "bin", "agent.cmd"),
  ];

  for (const candidate of candidates) {
    try {
      require("fs").accessSync(candidate);
      return { bin: candidate, args: [], direct: false };
    } catch { /* try next */ }
  }

  return { bin: "agent", args: [], direct: false };
}

const AGENT = resolveAgent();

const CHAT_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Runs `agent create-chat` and returns the new chat UUID, or null on failure.
 * Does not consult env; use {@link createCursorAgentSession} or {@link CursorSessionRegistry} for policy.
 */
export function spawnCursorAgentCreateChat(workDir: string): Promise<string | null> {
  const args = [...AGENT.args, "create-chat"];
  const useShell = !AGENT.direct && process.platform === "win32";

  return new Promise((resolve) => {
    const proc = spawn(AGENT.bin, args, {
      cwd: workDir,
      env: { ...process.env, CURSOR_INVOKED_AS: "agent" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, 45_000);

    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.warn("create-chat failed", { code, stderr: stderr.slice(0, 500) });
        resolve(null);
        return;
      }
      const m = stdout.match(CHAT_ID_RE);
      if (!m) {
        log.warn("create-chat: no chat id in output", { stdout: stdout.slice(0, 200) });
        resolve(null);
        return;
      }
      log.debug(`Cursor agent session created: ${m[0]}`);
      resolve(m[0]);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.warn("create-chat spawn error", { err: String(err) });
      resolve(null);
    });
  });
}

/** @deprecated Prefer `createCursorSessionRegistry` from `cursor-session-registry.ts` in the orchestrator. */
export function createCursorAgentSession(workDir: string): Promise<string | null> {
  if (getCursorAgentSessionsMode() === "off") {
    return Promise.resolve(null);
  }
  return spawnCursorAgentCreateChat(workDir);
}

export interface AgentRunConfig {
  agentType: string;
  category: string;
  prompt: string;
  repo?: string;
  pipelineId: string;
  skillsRoot: string;
  workspace?: string;
  baseBranch: string;
  branch: string;
  /** When set, setupWorkspace is skipped (workspace already prepared by orchestrator) */
  workspaceReady?: boolean;
  /** Trivial tasks get reduced timeouts and skip handoff files */
  trivial?: boolean;
  upstreamResults?: AgentRunResult[];
  /** Per-agent context brief from BigBoss context broker */
  agentBrief?: string | null;
  /** When true, design agents write to .pipeline/<agentType>-design.md instead of DESIGN.md */
  parallelDesign?: boolean;
  /** Task complexity from BigBoss ("trivial" | "moderate" | "complex") */
  complexity?: "trivial" | "moderate" | "complex";
  /** When set, this is a sub-task prompt within a decomposed coding run */
  subTaskIndex?: number;
  subTaskTotal?: number;
  /** Cursor Agent server-side chat id (`agent create-chat` + `--resume`). */
  cursorSessionId?: string | null;
  /** When set (love), Overseer review preambles include a LÖVE-specific checklist. */
  overseerStack?: "web" | "love";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface ParsedOutput {
  assistantMessage: string;
  filesWritten: string[];
  shellCommands: string[];
  errors: string[];
  tokenUsage: TokenUsage;
}

export interface AgentRunResult {
  agent: string;
  success: boolean;
  output: string;
  parsed: ParsedOutput;
  filesModified: string[];
  errors: string[];
  durationMs: number;
  commitSha?: string;
  branch?: string;
  tokenUsage?: TokenUsage;
  estimatedCost?: number;
}

function estimateCost(usage: TokenUsage): number {
  // Claude Sonnet pricing: $3/M input, $15/M output, $0.30/M cache read
  const inputCost = (usage.inputTokens / 1_000_000) * 3;
  const outputCost = (usage.outputTokens / 1_000_000) * 15;
  const cacheCost = (usage.cacheReadTokens / 1_000_000) * 0.3;
  return Math.round((inputCost + outputCost + cacheCost) * 10000) / 10000;
}

function parseAgentOutput(stdout: string): ParsedOutput {
  const assistantMessages: string[] = [];
  const filesWritten: string[] = [];
  const shellCommands: string[] = [];
  const errors: string[] = [];
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);

      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            assistantMessages.push(block.text);
          }
        }
      }

      if (event.type === "tool_call" && event.subtype === "completed") {
        const tc = event.tool_call;
        if (tc?.editToolCall?.result?.success?.path) {
          filesWritten.push(tc.editToolCall.result.success.path);
        }
        if (tc?.shellToolCall?.result) {
          const cmd = tc.shellToolCall.args?.command;
          if (cmd) shellCommands.push(cmd);
        }
      }

      if (event.type === "usage") {
        if (event.inputTokens) tokenUsage.inputTokens += event.inputTokens;
        if (event.outputTokens) tokenUsage.outputTokens += event.outputTokens;
        if (event.cacheReadTokens) tokenUsage.cacheReadTokens += event.cacheReadTokens;
      }

      if (event.type === "error") {
        errors.push(event.message || JSON.stringify(event));
      }
    } catch {
      // not JSON -- ignore
    }
  }

  return {
    assistantMessage: assistantMessages.join("\n\n"),
    filesWritten,
    shellCommands,
    errors,
    tokenUsage,
  };
}

export type AgentEventCallback = (event:
  | { type: "log" | "output" | "error"; content: string }
  | { type: "progress"; elapsedSeconds: number; filesEdited: number }
) => void;

export interface RunAgentCliOptions {
  onEvent?: AgentEventCallback;
  abortSignal?: AbortSignal;
  cursorSessionId?: string | null;
}

const INJECTED_PATH_PREFIX = ".cursor/";
const PIPELINE_PATH_PREFIX = ".pipeline/";

const PREAMBLE_PLANNING = `
You are running as a local CLI agent. Your role is PIPELINE PLANNING ONLY.
You must NOT write any files, run any commands, or make any changes to the workspace.
Analyse the task provided and respond with ONLY the requested JSON output.
Keep your response concise and focused on the planning decision.
`.trim();

const PREAMBLE_DESIGN = `
You are running as a local CLI agent with full file-system access.
Your role in this pipeline is DESIGN ONLY -- you must NOT write implementation code.

You have been provided with comprehensive codebase context below, including
the file tree, tech stack, git history, project configuration files, and key
source files. USE THIS CONTEXT to produce an informed, specific design.

Your job:
1. Analyse the user's request AND the provided codebase context.
2. Write the design to a file called DESIGN.md in the workspace root.
3. The design document should include:
   - High-level architecture and approach
   - File/directory structure for the implementation
   - Key data models, interfaces, or schemas
   - Component breakdown with responsibilities
   - Dependencies and technology choices with rationale
   - Any important implementation notes for the Coding Agent
4. Be specific and actionable -- the Coding Agent will use this document
   as its sole blueprint. Include code snippets or pseudocode where helpful.

If the workspace already contains source files (shown in the Workspace File Tree),
your design MUST BUILD ON the existing codebase. Reference existing files by name.
Describe what should be added or modified. Only propose new files for genuinely
new functionality. Match existing code style and patterns.

DO NOT create any implementation files (no .js, .ts, .html, .css, etc.).
ONLY produce the DESIGN.md file.
`.trim();

const PREAMBLE_DESIGN_PARALLEL = `
You are running as a local CLI agent with full file-system access.
Your role in this pipeline is DESIGN ONLY -- you must NOT write implementation code.
You are ONE OF SEVERAL design agents running IN PARALLEL on this task.

You have been provided with comprehensive codebase context below, including
the file tree, tech stack, git history, project configuration files, and key
source files. USE THIS CONTEXT to produce an informed, specific design.

Your job:
1. Analyse the user's request AND the provided codebase context.
2. Write your design to: .pipeline/AGENT_TYPE-design.md
   (where AGENT_TYPE is your agent name, provided in the prompt below).
   DO NOT write to DESIGN.md -- the orchestrator will merge all parallel designs.
3. The design document should include:
   - High-level architecture and approach (from your specialization's perspective)
   - File/directory structure for the implementation
   - Key data models, interfaces, or schemas
   - Component breakdown with responsibilities
   - Dependencies and technology choices with rationale
   - Any important implementation notes for the Coding Agent
4. Be specific and actionable -- the Coding Agent will use the merged document
   as its sole blueprint. Include code snippets or pseudocode where helpful.

If the workspace already contains source files (shown in the Workspace File Tree),
your design MUST BUILD ON the existing codebase. Reference existing files by name.
Describe what should be added or modified. Only propose new files for genuinely
new functionality. Match existing code style and patterns.

DO NOT create any implementation files (no .js, .ts, .html, .css, etc.).
`.trim();

const PREAMBLE_CODING = `
You are running as a local CLI agent with full file-system access.
Your role in this pipeline is IMPLEMENTATION -- you receive a design document
and must build it.

A PREVIEW of DESIGN.md is included below for quick orientation. However, the
preview may be truncated. Use your filesystem tool to READ the full DESIGN.md
from the workspace root before you start implementing. The full document on
disk is the authoritative source.

DESIGN.md begins with an "Original task (source of truth)" section: that is
the user's full requirement list. If the rest of DESIGN.md omits a requirement
from the Original task (e.g. top-down view, character selection, split screen),
you MUST implement it from the Original task and note the addition in CODING_NOTES.md.

Upstream agent handoff files are in .pipeline/*.handoff.md -- read them with
your filesystem tool if you need additional context from prior stages.

Your job:
1. READ the full DESIGN.md from disk using your filesystem tool.
2. Read the "Original task" section carefully, sentence by sentence.
3. Implement the full application as specified in the design and the Original task.
4. Use your file-write tools to create every file on disk.
5. Use your shell tool to run setup commands (npm init, install deps, etc.).
6. Create a complete, working implementation -- not a description of one.
7. Follow the file structure and patterns from the design document.
8. When you are done, every file should exist on disk in the workspace.
9. If you encounter issues with the design (contradictions, infeasible approaches,
   missing specifications, or areas where you deviated), document them in a file
   called CODING_NOTES.md in the workspace root. Structure it with these sections:
   ## Deviations   (where you diverged from the design and why)
   ## Issues Found  (problems in the design that should be flagged)
   ## Suggestions   (improvements for future design iterations)
   Only create this file if you actually have notes to record.

BEFORE YOU FINISH -- self-verification checklist:
- Re-read the "Original task" section from DESIGN.md and tick off every requirement.
- For each file you created, verify it has no syntax errors.
- For Lua/LÖVE projects: verify main.lua has love.load, love.update, and love.draw callbacks.
- For Node/web projects: verify the project builds (npm run build or equivalent).
- If you find any missing requirements, implement them before finishing.

DO NOT skip files or leave stubs. Build the complete implementation.
`.trim();

const PREAMBLE_TESTING = `
You are running as a local CLI agent with full file-system access.
Your role in this pipeline is TESTING -- you receive implemented code and
must validate it.

A preview of DESIGN.md and upstream context is included below for orientation.
For the full design, READ DESIGN.md from the workspace root using your
filesystem tool. Upstream handoff files are in .pipeline/*.handoff.md.

Your job:
1. Read the full DESIGN.md from disk to understand what was designed.
2. Examine the source files in the workspace to understand what was built.
3. Create test files using an appropriate testing framework.
4. Use your shell tool to install test dependencies and run the tests.
5. Report on test results, coverage, and any issues found.

If existing test patterns are provided below, follow the same testing style
and framework. Check the available npm scripts for existing test commands.

Write all test files to disk and execute them.
`.trim();

const PREAMBLE_LOVE_TESTING = `
You are running as a local CLI agent with full file-system access.
Your role in this pipeline is TESTING for a LÖVE2D / Lua project.

A preview of DESIGN.md and upstream context is included below. READ the full
DESIGN.md from the workspace root. Upstream handoff files are in .pipeline/*.handoff.md.

Your job:
1. Prefer **busted** for pure Lua modules (game logic, utilities): add spec files
   under spec/ or *_spec.lua as appropriate; document how to run tests (e.g. busted).
2. Test logic without the LÖVE runtime where possible; mock or isolate modules that
   call love.* when needed.
3. When useful, run \`love .\` briefly to catch startup/runtime errors and report them.
4. Use your shell tool to install busted or other Lua test tooling if missing.

Write tests to disk and execute them; summarize results and gaps.
`.trim();

const PREAMBLE_RELEASE = `
You are running as a local CLI agent with full file-system and git access.
Your role in this pipeline is RELEASE PREP — prepare the branch for a Pull Request.

You must:
1. Update the README based on the branch's changes
2. Bump the version in the appropriate version file (package.json, pom.xml, Cargo.toml, pyproject.toml, Chart.yaml, or build.gradle) using SemVer
3. Commit all changes with a conventional commit message
4. Push the branch
5. Create and push a tag for the new version after pushing the branch
6. Create a PR to the base branch using \`gh pr create\`

The BASE_BRANCH for the PR is provided in the task context below. Use it for \`git log <BASE_BRANCH>..HEAD\` and \`gh pr create --base <BASE_BRANCH>\`.

Do NOT merge the PR. Create and push a tag for the new version after pushing the branch.
`.trim();

const PREAMBLE_DESIGN_REVIEW = `
You are running as the BigBoss Overseer agent with full file-system access.
Your role is DESIGN REVIEW -- compare the design document against the original
user task and identify any gaps or missing requirements.

Your job:
1. Read DESIGN.md in full from the workspace using your filesystem tool.
2. The "Original task (source of truth)" section at the top of DESIGN.md
   contains every requirement the user stated. Go through it sentence by sentence.
3. For each requirement, check that the design document addresses it with
   a concrete design element (not just a passing mention).
4. For games: verify visual perspective, player count, character selection,
   game modes, screen layout, input methods, and sound requirements.
5. Respond with ONLY a JSON object on a single line:
   { "fit": "ok" | "gaps", "gaps": ["gap1", ...],
     "gapsByAgent": { "agent-type": "instructions for that designer only" } (optional),
     "suggestedSubTask": { "prompt": "shared instructions when gaps span roles" } }
   Agent-type keys must match pipeline agents (e.g. game-designer, love-architect, love-ux, ux-designer, core-code-designer, graphics-designer).
   If fit is "ok", optional fields may be omitted.
   If fit is "gaps", list gaps; use gapsByAgent when a gap clearly belongs to one designer; use suggestedSubTask for cross-cutting gaps.

DO NOT modify any files. This is a read-only review.
`.trim();

const PREAMBLE_CODE_REVIEW = `
You are running as the BigBoss Overseer agent with full file-system access.
Your role is CODE REVIEW -- compare the implemented code against the original
user task and design document to identify drift or missing features.

Your job:
1. Read DESIGN.md in full from the workspace using your filesystem tool.
2. Read ALL source files in the workspace (not just the file tree -- actually
   open and read the contents of main.lua, conf.lua, every file in src/, etc.).
   You must verify what was actually implemented, not assume from filenames.
3. The "Original task (source of truth)" section in DESIGN.md contains the
   user's full requirement list. Verify each requirement is implemented in code.
4. For games: check that love.load/love.update/love.draw exist and contain
   the expected logic, that scenes listed in the design have corresponding files,
   that input handling covers keyboard + gamepad, and that stated features
   (character selection, split-screen, specific game modes, etc.) are present.
5. Read CODING_NOTES.md if it exists to understand any deviations the coder made.
6. Respond with ONLY a JSON object on a single line:
   { "fit": "ok" | "drift", "missingOrWrong": ["item1", ...], "suggestedSubTask": { "prompt": "instructions" } }
   If fit is "ok", missingOrWrong and suggestedSubTask are optional.
   If fit is "drift", list every missing or incorrectly implemented feature,
   and provide focused coder instructions in suggestedSubTask.prompt.

DO NOT modify any files. This is a read-only review.
`.trim();

function getPreamble(category: string, parallelDesign?: boolean, agentType?: string): string {
  if (category === "validation" && agentType === "love-testing") {
    return PREAMBLE_LOVE_TESTING;
  }
  switch (category) {
    case "planning": return PREAMBLE_PLANNING;
    case "design": return parallelDesign ? PREAMBLE_DESIGN_PARALLEL : PREAMBLE_DESIGN;
    case "coding": return PREAMBLE_CODING;
    case "validation": return PREAMBLE_TESTING;
    case "release": return PREAMBLE_RELEASE;
    case "design-review": return PREAMBLE_DESIGN_REVIEW;
    case "code-review": return PREAMBLE_CODE_REVIEW;
    default: return PREAMBLE_CODING;
  }
}

// ---------------------------------------------------------------------------
// Context brief builder -- role-specific codebase context for each agent
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([".cursor", ".pipeline", ".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv"]);
const PROJECT_FILES = ["package.json", "README.md", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "tsconfig.json"];
const ARCH_EXTENSIONS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".cs", ".lua"]);

function listSourceFiles(workDir: string): string[] {
  try {
    const output = execSync("git ls-files", {
      cwd: workDir, encoding: "utf-8", timeout: 10_000, stdio: "pipe",
    });
    return output.split("\n").map((f) => f.trim()).filter(Boolean)
      .filter((f) => !f.startsWith(".cursor/") && !f.startsWith(".pipeline/") && !f.startsWith(".git/"));
  } catch {
    try {
      const cmd = process.platform === "win32" ? "dir /s /b /a-d" : "find . -type f -not -path './.git/*'";
      const output = execSync(cmd, { cwd: workDir, encoding: "utf-8", timeout: 10_000, stdio: "pipe" });
      return output.split("\n").map((f) => f.trim()).filter(Boolean)
        .filter((f) => !SKIP_DIRS.has(f.split("/")[0]) && !SKIP_DIRS.has(f.split("\\")[0]));
    } catch { return []; }
  }
}

function getFileTree(workDir: string): string | null {
  const files = listSourceFiles(workDir);
  if (files.length === 0) return null;

  const groups: Record<string, string[]> = {};
  for (const f of files) {
    const dir = f.includes("/") ? f.split("/").slice(0, -1).join("/") : "(root)";
    (groups[dir] ??= []).push(f.split("/").pop()!);
  }

  const lines: string[] = [];
  const sortedDirs = Object.keys(groups).sort();
  for (const dir of sortedDirs.slice(0, 30)) {
    lines.push(`${dir}/`);
    for (const file of groups[dir].slice(0, 15)) {
      lines.push(`  ${file}`);
    }
    if (groups[dir].length > 15) lines.push(`  ... +${groups[dir].length - 15} more`);
  }
  if (sortedDirs.length > 30) lines.push(`... +${sortedDirs.length - 30} more directories`);
  lines.push(`\nTotal: ${files.length} files`);
  return lines.join("\n");
}

function getGitHistory(workDir: string): string | null {
  try {
    return execSync("git log --oneline -15", {
      cwd: workDir, encoding: "utf-8", timeout: 5_000, stdio: "pipe",
    }).trim() || null;
  } catch { return null; }
}

function getGitDiffStat(workDir: string, baseBranch?: string): string | null {
  const ref = baseBranch || "main";
  try {
    return execSync(`git diff ${ref}..HEAD --stat`, {
      cwd: workDir, encoding: "utf-8", timeout: 5_000, stdio: "pipe",
    }).trim() || null;
  } catch { return null; }
}

function detectTechStack(workDir: string): string {
  const parts: string[] = [];
  const fsSync = require("fs");
  const check = (file: string) => { try { fsSync.accessSync(path.join(workDir, file)); return true; } catch { return false; } };

  if (check("package.json")) {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(path.join(workDir, "package.json"), "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const frameworks: string[] = [];
      if (deps["react"]) frameworks.push("React");
      if (deps["vue"]) frameworks.push("Vue");
      if (deps["svelte"]) frameworks.push("Svelte");
      if (deps["next"]) frameworks.push("Next.js");
      if (deps["express"]) frameworks.push("Express");
      if (deps["typescript"]) frameworks.push("TypeScript");
      parts.push(`Node.js${frameworks.length ? ` (${frameworks.join(", ")})` : ""}`);
    } catch { parts.push("Node.js"); }
  }
  if (check("go.mod")) parts.push("Go");
  if (check("Cargo.toml")) parts.push("Rust");
  if (check("pyproject.toml") || check("requirements.txt")) parts.push("Python");
  if (check("pom.xml") || check("build.gradle")) parts.push("Java");
  return parts.join(", ") || "Unknown";
}

function readFileSafe(filePath: string, maxChars = 3000): string | null {
  try {
    const content = require("fs").readFileSync(filePath, "utf-8");
    if (!content.trim()) return null;
    return content.length > maxChars ? content.slice(0, maxChars) + "\n... (truncated)" : content;
  } catch { return null; }
}

function getProjectFiles(workDir: string, maxPerFile = 2000): string | null {
  const sections: string[] = [];
  for (const name of PROJECT_FILES) {
    const content = readFileSafe(path.join(workDir, name), maxPerFile);
    if (content) sections.push(`### ${name}\n\`\`\`\n${content}\n\`\`\``);
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function getArchitecturalFiles(workDir: string, maxTotal = 10000): string | null {
  const files = listSourceFiles(workDir);
  const entryPatterns = [/index\.[tj]sx?$/, /main\.[tj]sx?$/, /main\.lua$/, /conf\.lua$/, /app\.[tj]sx?$/, /server\.[tj]sx?$/, /^src\/[^/]+\.[tj]sx?$/, /^src\/[^/]+\.lua$/];
  const typePatterns = [/types?\.[tj]s$/, /interfaces?\.[tj]s$/, /models?\.[tj]s$/, /schema\.[tj]s$/];

  const candidates = files.filter((f) => {
    const ext = path.extname(f);
    if (!ARCH_EXTENSIONS.has(ext)) return false;
    const base = path.basename(f);
    return entryPatterns.some((p) => p.test(f)) || typePatterns.some((p) => p.test(base));
  });

  const sections: string[] = [];
  let totalChars = 0;
  for (const f of candidates.slice(0, 8)) {
    const content = readFileSafe(path.join(workDir, f), 2000);
    if (content && totalChars + content.length < maxTotal) {
      sections.push(`### ${f}\n\`\`\`\n${content}\n\`\`\``);
      totalChars += content.length;
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function getDesignDoc(workDir: string, maxChars = 8000): string | null {
  return readFileSafe(path.join(workDir, "DESIGN.md"), maxChars);
}

function getHandoffContent(workDir: string, agentType: string, maxChars = 4000): string | null {
  return readFileSafe(path.join(workDir, ".pipeline", `${agentType}.handoff.md`), maxChars);
}

function getTestPatterns(workDir: string): string | null {
  const files = listSourceFiles(workDir);
  const testFiles = files.filter((f) =>
    /\.(test|spec)\.[tj]sx?$/.test(f) || f.includes("__tests__/") ||
    f.endsWith("_spec.lua") || (f.includes("spec/") && f.endsWith(".lua")),
  );
  if (testFiles.length === 0) return null;

  const sections: string[] = [];
  sections.push(`Found ${testFiles.length} existing test file(s):`);
  for (const f of testFiles.slice(0, 5)) {
    const content = readFileSafe(path.join(workDir, f), 1500);
    if (content) {
      sections.push(`### ${f}\n\`\`\`\n${content}\n\`\`\``);
    } else {
      sections.push(`- ${f}`);
    }
  }
  if (testFiles.length > 5) sections.push(`... and ${testFiles.length - 5} more test files`);
  return sections.join("\n\n");
}

function getPackageScripts(workDir: string): string | null {
  try {
    const pkg = JSON.parse(require("fs").readFileSync(path.join(workDir, "package.json"), "utf-8"));
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      return Object.entries(pkg.scripts).map(([k, v]) => `- \`npm run ${k}\` → \`${v}\``).join("\n");
    }
  } catch { /* no package.json */ }
  return null;
}

export interface ContextBrief {
  fileTree: string | null;
  techStack: string;
  gitHistory: string | null;
  gitDiff: string | null;
  projectFiles: string | null;
  architecturalFiles: string | null;
  designDoc: string | null;
  handoffContent: Record<string, string>;
  testPatterns: string | null;
  packageScripts: string | null;
  /** Per-agent focus hints from BigBoss context broker */
  agentBrief: string | null;
}

export function buildContextBrief(
  category: string,
  workDir: string,
  upstreamResults?: AgentRunResult[],
  baseBranch?: string,
  agentBrief?: string | null,
  agentType?: string,
): ContextBrief {
  const brief: ContextBrief = {
    fileTree: null,
    techStack: "Unknown",
    gitHistory: null,
    gitDiff: null,
    projectFiles: null,
    architecturalFiles: null,
    designDoc: null,
    handoffContent: {},
    testPatterns: null,
    packageScripts: null,
    agentBrief: agentBrief || null,
  };

  brief.techStack = detectTechStack(workDir);

  switch (category) {
    case "planning":
      brief.fileTree = getFileTree(workDir);
      brief.gitHistory = getGitHistory(workDir);
      brief.projectFiles = getProjectFiles(workDir, 1500);
      break;

    case "design":
      brief.fileTree = getFileTree(workDir);
      brief.gitHistory = getGitHistory(workDir);
      brief.gitDiff = getGitDiffStat(workDir, baseBranch);
      brief.projectFiles = getProjectFiles(workDir, 2000);
      brief.architecturalFiles = getArchitecturalFiles(workDir, 8000);
      brief.designDoc = getDesignDoc(workDir);
      break;

    case "coding":
      brief.fileTree = getFileTree(workDir);
      brief.designDoc = getDesignDoc(workDir, agentType === "lua-coding" ? 24000 : 12000);
      brief.projectFiles = getProjectFiles(workDir, 1500);
      if (upstreamResults) {
        for (const r of upstreamResults) {
          const content = getHandoffContent(workDir, r.agent);
          if (content) brief.handoffContent[r.agent] = content;
        }
      }
      break;

    case "validation":
      brief.fileTree = getFileTree(workDir);
      brief.designDoc = getDesignDoc(
        workDir,
        upstreamResults?.some((r) => r.agent === "lua-coding" || r.agent === "love-testing") || agentType === "love-testing"
          ? 24000
          : 6000,
      );
      brief.testPatterns = getTestPatterns(workDir);
      brief.packageScripts = getPackageScripts(workDir);
      if (upstreamResults) {
        for (const r of upstreamResults) {
          const content = getHandoffContent(workDir, r.agent);
          if (content) brief.handoffContent[r.agent] = content;
        }
      }
      break;

    case "design-review":
      brief.fileTree = getFileTree(workDir);
      brief.designDoc = getDesignDoc(workDir, 32000);
      break;

    case "code-review":
      brief.fileTree = getFileTree(workDir);
      brief.designDoc = getDesignDoc(workDir, 32000);
      brief.architecturalFiles = getArchitecturalFiles(workDir, 12000);
      break;
  }

  return brief;
}

function buildFullPrompt(
  config: AgentRunConfig,
  skillPack: SkillPack,
  workDir: string,
): string {
  const parts: string[] = [];
  const brief = buildContextBrief(
    config.category, workDir, config.upstreamResults, config.baseBranch, config.agentBrief, config.agentType,
  );

  let preamble = getPreamble(config.category, config.parallelDesign, config.agentType);
  if (
    config.agentType === "bigboss" &&
    (config.category === "design-review" || config.category === "code-review")
  ) {
    const skillMd = loadBigBossSystemPromptSync(config.skillsRoot);
    if (skillMd) {
      const cap = 12000;
      const body = skillMd.length > cap ? `${skillMd.slice(0, cap)}\n\n[…truncated…]` : skillMd;
      preamble = `${body}\n\n---\n\n${preamble}`;
    }
  }
  if (
    config.overseerStack === "love" &&
    (config.category === "design-review" || config.category === "code-review")
  ) {
    preamble += `\n\n---\n\n${
      config.category === "design-review" ? OVERSEER_LOVE_DESIGN_CHECKLIST : OVERSEER_LOVE_CODE_CHECKLIST
    }`;
  }
  parts.push(preamble);
  if (config.parallelDesign && config.category === "design") {
    parts.push(`\nYour agent type is: ${config.agentType}`);
    parts.push(`Write your design output to: .pipeline/${config.agentType}-design.md`);
  }
  parts.push("");

  // --- Codebase context (role-specific) ---
  if (brief.agentBrief) {
    parts.push("## BigBoss Context Brief");
    parts.push("BigBoss has analyzed the codebase and prepared this guidance for you:");
    parts.push(brief.agentBrief);
    parts.push("");
  }

  if (brief.fileTree) {
    parts.push("## Workspace File Tree");
    parts.push(`Tech stack: ${brief.techStack}`);
    parts.push("```");
    parts.push(brief.fileTree);
    parts.push("```");
    parts.push("");
  }

  if (brief.gitHistory) {
    parts.push("## Recent Git History");
    parts.push("```");
    parts.push(brief.gitHistory);
    parts.push("```");
    parts.push("");
  }

  if (brief.gitDiff) {
    parts.push("## Changes on This Branch");
    parts.push("```");
    parts.push(brief.gitDiff);
    parts.push("```");
    parts.push("");
  }

  if (brief.projectFiles) {
    parts.push("## Project Configuration Files");
    parts.push(brief.projectFiles);
    parts.push("");
  }

  if (brief.architecturalFiles) {
    parts.push("## Key Source Files");
    parts.push("These are the main entry points, types, and interfaces in the codebase:");
    parts.push(brief.architecturalFiles);
    parts.push("");
  }

  const useDiskBasedContext = config.category === "coding" || config.category === "validation";

  if (brief.designDoc) {
    if (useDiskBasedContext) {
      const preview = brief.designDoc.slice(0, 3000);
      const truncated = brief.designDoc.length > 3000;
      parts.push("## DESIGN.md (preview)");
      parts.push("This is a PREVIEW of the design document. Read the full DESIGN.md from disk for complete details.");
      parts.push("```markdown");
      parts.push(preview);
      if (truncated) parts.push("\n... (truncated -- read full DESIGN.md from disk using your filesystem tool)");
      parts.push("```");
    } else {
      parts.push("## DESIGN.md");
      parts.push("The design document for this task (produced by the Design agent):");
      parts.push("```markdown");
      parts.push(brief.designDoc);
      parts.push("```");
    }
    parts.push("");
  }

  if (Object.keys(brief.handoffContent).length > 0) {
    if (useDiskBasedContext) {
      parts.push("## Upstream Agent Handoffs");
      parts.push("Handoff files from upstream agents are available on disk:");
      for (const agent of Object.keys(brief.handoffContent)) {
        parts.push(`- .pipeline/${agent}.handoff.md`);
      }
      parts.push("Read them with your filesystem tool if you need additional context.");
    } else {
      parts.push("## Upstream Agent Handoffs");
      for (const [agent, content] of Object.entries(brief.handoffContent)) {
        parts.push(`### ${agent} handoff`);
        parts.push(content);
        parts.push("");
      }
    }
    parts.push("");
  }

  if (brief.testPatterns) {
    parts.push("## Existing Test Patterns");
    parts.push(brief.testPatterns);
    parts.push("");
  }

  if (brief.packageScripts) {
    parts.push("## Available npm Scripts");
    parts.push(brief.packageScripts);
    parts.push("");
  }

  // --- Complexity-aware guidance (R6) ---
  if (config.complexity && config.category === "coding") {
    parts.push("## Task Complexity");
    switch (config.complexity) {
      case "trivial":
        parts.push("This is a TRIVIAL task. Implement straightforwardly without over-engineering.");
        break;
      case "moderate":
        parts.push("This is a MODERATE task. Follow the design carefully and implement all features.");
        break;
      case "complex":
        parts.push("This is a COMPLEX task with many interconnected requirements.");
        parts.push("Take extra care to:");
        parts.push("- Read the full DESIGN.md from disk multiple times as you work.");
        parts.push("- Implement incrementally: core structure first, then features one by one.");
        parts.push("- After implementing each major feature, re-read the Original task to verify nothing was missed.");
        parts.push("- Pay special attention to cross-cutting concerns (input handling, state management, UI layout).");
        break;
    }
    parts.push("");
  }

  // --- Sub-task context (R2: task decomposition) ---
  if (config.subTaskIndex !== undefined && config.subTaskTotal !== undefined) {
    parts.push("## Sub-Task Progress");
    parts.push(`This is sub-task ${config.subTaskIndex + 1} of ${config.subTaskTotal}.`);
    parts.push("Previous sub-tasks have already created files in the workspace.");
    parts.push("Do NOT delete or overwrite existing files unless specifically instructed.");
    parts.push("Build upon and extend the existing code.");
    parts.push("");
  }

  // --- Expertise + Task ---
  parts.push("## Your expertise (for context)");
  parts.push(skillPack.systemPrompt);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("## Task");
  parts.push(config.prompt);

  if (skillPack.tools && skillPack.tools.length > 0) {
    parts.push("");
    parts.push("## Preferred tools");
    for (const tool of skillPack.tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`);
    }
  }

  // Upstream result summaries (lightweight, in addition to injected handoffs)
  if (config.upstreamResults && config.upstreamResults.length > 0) {
    parts.push("");
    parts.push("## Upstream agent results");
    for (const result of config.upstreamResults) {
      parts.push(`### ${result.agent}`);
      parts.push(`- Status: ${result.success ? "succeeded" : "failed"}`);
      parts.push(`- Files modified: ${result.filesModified.join(", ") || "none"}`);
      if (result.errors.length > 0) {
        parts.push(`- Errors: ${result.errors.join("; ")}`);
      }
    }
  }

  return parts.join("\n");
}

/**
 * Prepares the workspace directory, cloning if needed, and checks out
 * the work branch from the specified base branch.
 *
 * Called once by the orchestrator before the first stage runs.
 */
export async function setupWorkspace(config: AgentRunConfig): Promise<string> {
  const workDir = config.workspace
    ? config.workspace
    : path.join(os.tmpdir(), `agents-robots-${config.pipelineId}`);

  await fs.mkdir(workDir, { recursive: true });

  const hasGit = await fs
    .access(path.join(workDir, ".git"))
    .then(() => true)
    .catch(() => false);

  if (!hasGit && config.repo) {
    execSync(`git clone ${config.repo} .`, {
      cwd: workDir,
      stdio: "pipe",
      timeout: 120_000,
    });
  } else if (!hasGit) {
    execSync("git init", { cwd: workDir, stdio: "pipe" });
    execSync("git commit --allow-empty -m init", { cwd: workDir, stdio: "pipe" });
  }

  if (hasGit && config.repo) {
    execSync("git fetch origin", { cwd: workDir, stdio: "pipe", timeout: 60_000 });
  }

  // Ensure we're on the base branch before creating the work branch
  try {
    execSync(`git checkout ${config.baseBranch}`, { cwd: workDir, stdio: "pipe" });
    if (config.repo) {
      try {
        execSync(`git pull origin ${config.baseBranch}`, { cwd: workDir, stdio: "pipe", timeout: 60_000 });
      } catch { /* non-fatal */ }
    }
  } catch {
    // baseBranch may not exist yet in a bare repo -- that's okay
  }

  // Create or checkout the work branch.
  // If the branch already exists locally, delete and recreate it from the
  // current base so this pipeline run starts from a clean base branch tip.
  const localBranchExists = (() => {
    try {
      execSync(`git rev-parse --verify ${config.branch}`, { cwd: workDir, stdio: "pipe" });
      return true;
    } catch { return false; }
  })();

  if (localBranchExists) {
    execSync(`git branch -D ${config.branch}`, { cwd: workDir, stdio: "pipe" });
  }
  execSync(`git checkout -b ${config.branch}`, { cwd: workDir, stdio: "pipe" });

  return workDir;
}

/**
 * Injects skill pack files (.cursor/rules, mcp.json) and commits them
 * so they don't show up in the agent's "modified files" diff.
 */
async function injectSkillPack(
  workDir: string,
  skillPack: SkillPack,
): Promise<void> {
  if (skillPack.cursorRules && Object.keys(skillPack.cursorRules).length > 0) {
    const rulesDir = path.join(workDir, ".cursor", "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    for (const [filename, content] of Object.entries(skillPack.cursorRules)) {
      await fs.writeFile(path.join(rulesDir, filename), content, "utf-8");
    }
  }

  if (skillPack.mcpConfig) {
    const cursorDir = path.join(workDir, ".cursor");
    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify(skillPack.mcpConfig, null, 2),
      "utf-8",
    );
  }

  try {
    execSync("git add -A", { cwd: workDir, stdio: "pipe" });
    const status = execSync("git status --porcelain", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (status) {
      execSync('git commit -m "skill pack setup" --allow-empty', {
        cwd: workDir,
        stdio: "pipe",
      });
    }
  } catch {
    // non-fatal
  }
}

/** Excludes .pipeline paths from modified-file count except design outputs (*-design.md). */
function isExcludedPipelinePath(filePath: string): boolean {
  if (!filePath.startsWith(PIPELINE_PATH_PREFIX)) return false;
  return !filePath.endsWith("-design.md");
}

function collectModifiedFiles(workDir: string): string[] {
  try {
    const output = execSync("git diff --name-only HEAD", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
    });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith(INJECTED_PATH_PREFIX) && !isExcludedPipelinePath(f));
  } catch {
    try {
      const output = execSync("git status --porcelain", {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: "pipe",
      });
      return output
        .split("\n")
        .map((line) => line.trim().replace(/^[A-Z?]+\s+/, ""))
        .filter(Boolean)
        .filter((f) => !f.startsWith(INJECTED_PATH_PREFIX) && !isExcludedPipelinePath(f));
    } catch {
      return [];
    }
  }
}

/**
 * Commits staged + unstaged changes to the current branch.
 * Does NOT push -- the orchestrator calls pushBranch once after all stages.
 */
function commitChanges(
  workDir: string,
  agentType: string,
  promptSummary: string,
): { committed: boolean; commitSha?: string } {
  try {
    execSync("git add -A", { cwd: workDir, stdio: "pipe" });

    const status = execSync("git status --porcelain", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    if (!status) return { committed: false };

    const summary = promptSummary.length > 72
      ? promptSummary.slice(0, 69) + "..."
      : promptSummary;
    const message = `[${agentType}] ${summary}`;
    execSync(`git commit -m "${message}"`, { cwd: workDir, stdio: "pipe" });

    const commitSha = execSync("git rev-parse HEAD", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    return { committed: true, commitSha };
  } catch {
    return { committed: false };
  }
}

/**
 * Lightweight agent invocation for planning-only tasks (e.g. BigBoss routing).
 * Skips skill pack injection, commits, and handoff files.
 * Uses a short timeout (default 60s) and returns only parsed text.
 */
export async function runPlanner(
  prompt: string,
  workDir: string,
  pipelineId: string,
  timeoutMs = 60_000,
  cursorSessionId?: string | null,
): Promise<{ text: string; timedOut: boolean }> {
  const startTime = Date.now();
  log.debug(`Planner starting (timeout: ${(timeoutMs / 1000).toFixed(0)}s)`);

  const result = await runAgentCli(prompt, workDir, timeoutMs, { cursorSessionId });

  await writeDebugLog("bigboss-planner", pipelineId, {
    prompt,
    args: ["-p", "--force", "--trust", "--workspace", workDir, "--output-format", "stream-json"],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const timedOut = result.exitCode === 124;

  if (timedOut) {
    log.warn(`Planner timed out after ${elapsed}s`);
  } else {
    log.debug(`Planner completed in ${elapsed}s (exit ${result.exitCode})`);
  }

  const parsed = parseAgentOutput(result.stdout);
  const text = parsed.assistantMessage || result.stdout;

  return { text, timedOut };
}

export interface LintResult {
  passed: boolean;
  command: string;
  output: string;
}

export async function runLintCheck(workDir: string): Promise<LintResult | null> {
  let lintCmd: string | null = null;

  try {
    const pkgPath = path.join(workDir, "package.json");
    const pkgContent = require("fs").readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    const scripts = pkg.scripts || {};

    if (scripts["typecheck"]) lintCmd = "npm run typecheck";
    else if (scripts["build"]) lintCmd = "npm run build";
    else if (scripts["lint"]) lintCmd = "npm run lint";
    else if (scripts["check"]) lintCmd = "npm run check";
  } catch {
    // no package.json or parsing error
  }

  if (!lintCmd) return null;

  try {
    const output = execSync(lintCmd, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: "pipe",
    });
    return { passed: true, command: lintCmd, output: output.slice(-500) };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    const output = (error.stderr || error.stdout || String(err)).slice(-1000);
    return { passed: false, command: lintCmd, output };
  }
}

export async function readCodingNotes(workDir: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(workDir, "CODING_NOTES.md"), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pushes the work branch to origin. Called once by the orchestrator
 * after all stages have completed.
 */
export function pushBranch(
  workDir: string,
  branch: string,
): { pushed: boolean; error?: string } {
  try {
    execSync(`git push -u origin ${branch}`, {
      cwd: workDir,
      stdio: "pipe",
      timeout: 60_000,
    });
    return { pushed: true };
  } catch (err) {
    return {
      pushed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function writeHandoffFile(
  workDir: string,
  stageName: string,
  agentType: string,
  parsed: ParsedOutput,
  filesModified: string[],
  errors: string[],
): Promise<void> {
  const pipeDir = path.join(workDir, ".pipeline");
  await fs.mkdir(pipeDir, { recursive: true });

  const lines: string[] = [];
  lines.push(`# Stage: ${stageName} (${agentType})`);
  lines.push("");
  lines.push("## Summary");
  lines.push(parsed.assistantMessage || "(no summary captured)");
  lines.push("");
  lines.push("## Files Created/Modified");
  if (filesModified.length > 0) {
    for (const f of filesModified) lines.push(`- ${f}`);
  } else {
    lines.push("- (none)");
  }
  if (parsed.shellCommands.length > 0) {
    lines.push("");
    lines.push("## Shell Commands Run");
    for (const cmd of parsed.shellCommands) lines.push(`- \`${cmd}\``);
  }
  if (errors.length > 0 || parsed.errors.length > 0) {
    lines.push("");
    lines.push("## Errors/Warnings");
    for (const e of [...errors, ...parsed.errors]) lines.push(`- ${e}`);
  }
  lines.push("");

  const handoffPath = path.join(pipeDir, `${agentType}.handoff.md`);
  await fs.writeFile(handoffPath, lines.join("\n"), "utf-8");

  try {
    execSync("git add -A .pipeline", { cwd: workDir, stdio: "pipe" });
    execSync('git commit -m "pipeline: update handoff files" --allow-empty', {
      cwd: workDir,
      stdio: "pipe",
    });
  } catch {
    // non-fatal
  }
}

export async function runAgent(
  config: AgentRunConfig,
  workDir: string,
  onEvent?: AgentEventCallback,
  abortSignal?: AbortSignal,
): Promise<AgentRunResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  onEvent?.({ type: "log", content: `Loading skill pack: ${config.agentType}` });
  const skillPack = await loadSkillPack(config.agentType, config.skillsRoot);

  skillPack.constraints.forbiddenActions = [];
  const baseTimeout = config.trivial ? 120_000 : 1_200_000;
  const timeoutMs = Math.max(skillPack.constraints.timeoutMs, baseTimeout);

  await injectSkillPack(workDir, skillPack);

  const fullPrompt = buildFullPrompt(config, skillPack, workDir);
  onEvent?.({ type: "log", content: `Running agent in ${workDir}` });

  const cursorResult = await runAgentCli(fullPrompt, workDir, timeoutMs, {
    onEvent,
    abortSignal,
    cursorSessionId: config.cursorSessionId,
  });

  await writeDebugLog(config.agentType, config.pipelineId, {
    prompt: fullPrompt,
    args: ["-p", "--force", "--trust", "--workspace", workDir, "--output-format", "stream-json"],
    stdout: cursorResult.stdout,
    stderr: cursorResult.stderr,
    exitCode: cursorResult.exitCode,
  });

  const wasTimeout = cursorResult.exitCode === 124;
  const wasCancelled = cursorResult.exitCode === 125;

  if (cursorResult.exitCode !== 0 && !wasTimeout && !wasCancelled) {
    errors.push(`Agent CLI exited with code ${cursorResult.exitCode}`);
    if (cursorResult.stderr) {
      errors.push(cursorResult.stderr.slice(0, 1000));
    }
  }

  if (cursorResult.exitCode === 0 && !cursorResult.stdout.trim()) {
    errors.push("Agent CLI produced no output -- likely did not execute");
  }

  const parsed = parseAgentOutput(cursorResult.stdout);

  let filesModified = collectModifiedFiles(workDir);
  // Parallel design agents write to .pipeline/<agentType>-design.md; git may not report it (e.g. no repo, or .pipeline ignored). Count it if present.
  if (config.parallelDesign && config.category === "design") {
    const designPath = path.join(workDir, ".pipeline", `${config.agentType}-design.md`);
    try {
      await fs.access(designPath);
      const relPath = `.pipeline/${config.agentType}-design.md`;
      if (!filesModified.includes(relPath)) {
        filesModified = [...filesModified, relPath];
      }
    } catch {
      // file not present; keep filesModified as-is
    }
  }
  onEvent?.({
    type: "log",
    content: `Files modified: ${filesModified.length}${wasTimeout ? " (agent timed out but produced files)" : ""}`,
  });

  let commitSha: string | undefined;
  if (filesModified.length > 0) {
    const result = commitChanges(workDir, config.agentType, config.prompt);
    commitSha = result.commitSha;
    if (result.committed) {
      onEvent?.({ type: "log", content: `Committed on ${config.branch}` });
    }
  }

  if (!config.trivial) {
    await writeHandoffFile(workDir, config.category, config.agentType, parsed, filesModified, errors);
  }

  if (wasCancelled) {
    errors.push("Agent cancelled by user");
  }

  const success = wasCancelled
    ? false
    : wasTimeout
      ? filesModified.length > 0
      : cursorResult.exitCode === 0 && errors.length === 0;

  if (wasTimeout) {
    onEvent?.({
      type: "log",
      content: filesModified.length > 0
        ? `Agent timed out after ${(timeoutMs / 1000).toFixed(0)}s but created ${filesModified.length} file(s) -- continuing`
        : `Agent timed out after ${(timeoutMs / 1000).toFixed(0)}s with no files created`,
    });
    if (filesModified.length === 0) {
      errors.push(`Agent timed out after ${timeoutMs}ms with no files created`);
    }
  }

  const cost = estimateCost(parsed.tokenUsage);

  return {
    agent: config.agentType,
    success,
    output: cursorResult.stdout,
    parsed,
    filesModified,
    errors,
    durationMs: Date.now() - startTime,
    commitSha,
    branch: config.branch,
    tokenUsage: parsed.tokenUsage,
    estimatedCost: cost,
  };
}

const LOG_DIR = path.join(os.tmpdir(), "agents-robots-logs");

async function writeDebugLog(
  agentType: string,
  pipelineId: string,
  data: { prompt: string; args: string[]; stdout: string; stderr: string; exitCode: number },
): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = `${ts}_${agentType}_${pipelineId.slice(0, 8)}`;
    await fs.writeFile(path.join(LOG_DIR, `${prefix}_prompt.txt`), data.prompt, "utf-8");
    await fs.writeFile(path.join(LOG_DIR, `${prefix}_args.json`), JSON.stringify(data.args, null, 2), "utf-8");
    await fs.writeFile(path.join(LOG_DIR, `${prefix}_stdout.txt`), data.stdout, "utf-8");
    await fs.writeFile(path.join(LOG_DIR, `${prefix}_stderr.txt`), data.stderr, "utf-8");
    await fs.writeFile(path.join(LOG_DIR, `${prefix}_exit.txt`), String(data.exitCode), "utf-8");
    log.debug(`Debug logs written to ${LOG_DIR}/${prefix}_*`);
  } catch {
    // non-fatal
  }
}

/**
 * Runs the standalone Cursor Agent CLI in non-interactive print mode.
 *
 * On Windows, calls the agent's node binary directly (bypassing the .cmd
 * and PowerShell wrappers) so that:
 *   - stdin piping works reliably for prompt delivery
 *   - process kill actually terminates the agent (not just cmd.exe)
 *   - no cmd.exe escaping issues with special characters
 */
function runAgentCli(
  prompt: string,
  workDir: string,
  timeoutMs: number,
  options?: RunAgentCliOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const onEvent = options?.onEvent;
  const abortSignal = options?.abortSignal;
  const cursorSessionId = options?.cursorSessionId;

  const model = process.env.CURSOR_AGENT_MODEL || "auto";
  const args = [
    ...AGENT.args,
    "-p",
    "--force",
    "--trust",
    "--model", model,
    "--workspace", workDir,
    "--output-format", "stream-json",
  ];
  if (cursorSessionId) {
    args.push("--resume", cursorSessionId);
  }

  const useShell = !AGENT.direct && process.platform === "win32";

  return new Promise((resolve, reject) => {
    const proc = spawn(AGENT.bin, args, {
      cwd: workDir,
      env: { ...process.env, CURSOR_INVOKED_AS: "agent" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    const startTime = Date.now();
    let filesEdited = 0;

    const emitProgress = () => {
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      onEvent?.({ type: "progress", elapsedSeconds, filesEdited });
    };

    const progressInterval = setInterval(emitProgress, 1000);

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.content) {
            onEvent?.({ type: "output", content: event.content });
          }
          if (event.type === "tool_call" && event.subtype === "completed") {
            const tc = event.tool_call;
            if (tc?.editToolCall?.result?.success?.path) {
              filesEdited++;
              emitProgress();
            }
          }
        } catch {
          onEvent?.({ type: "output", content: trimmed });
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onEvent?.({ type: "error", content: text });
    });

    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    if (abortSignal) {
      const onAbort = () => {
        cancelled = true;
        proc.kill("SIGTERM");
      };
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    proc.on("close", (code) => {
      clearInterval(progressInterval);
      clearTimeout(timer);
      if (cancelled) {
        stderr += `\n[harness] Agent CLI cancelled by user`;
      } else if (timedOut) {
        stderr += `\n[harness] Agent CLI timed out after ${timeoutMs}ms`;
      }
      const exitCode = cancelled ? 125 : timedOut ? 124 : (code ?? 1);
      resolve({ exitCode, stdout, stderr });
    });

    proc.on("error", (err) => {
      clearInterval(progressInterval);
      clearTimeout(timer);
      reject(err);
    });
  });
}
