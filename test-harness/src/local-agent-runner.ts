import { spawn } from "child_process";
import { execSync } from "child_process";
import { promises as fs, access as accessCb } from "fs";
import * as path from "path";
import * as os from "os";
import { loadSkillPack, SkillPack } from "./local-skill-loader";

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

export type AgentEventCallback = (event: {
  type: "log" | "output" | "error";
  content: string;
}) => void;

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

Your job:
1. Analyse the user's request and produce a detailed design document.
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

If the workspace already contains source files (listed under "Existing Workspace"
above), your design should BUILD ON the existing codebase rather than starting
from scratch. Reference existing files by name and describe what should be added
or modified. Only propose new files for genuinely new functionality.

DO NOT create any implementation files (no .js, .ts, .html, .css, etc.).
ONLY produce the DESIGN.md file.
`.trim();

const PREAMBLE_CODING = `
You are running as a local CLI agent with full file-system access.
Your role in this pipeline is IMPLEMENTATION -- you receive a design document
and must build it.

Your job:
1. Read DESIGN.md in the workspace root to understand the architecture.
2. Implement the full application as specified in the design.
3. Use your file-write tools to create every file on disk.
4. Use your shell tool to run setup commands (npm init, install deps, etc.).
5. Create a complete, working implementation -- not a description of one.
6. Follow the file structure and patterns from the design document.
7. When you are done, every file should exist on disk in the workspace.
8. If you encounter issues with the design (contradictions, infeasible approaches,
   missing specifications, or areas where you deviated), document them in a file
   called CODING_NOTES.md in the workspace root. Structure it with these sections:
   ## Deviations   (where you diverged from the design and why)
   ## Issues Found  (problems in the design that should be flagged)
   ## Suggestions   (improvements for future design iterations)
   Only create this file if you actually have notes to record.

DO NOT skip files or leave stubs. Build the complete implementation.
`.trim();

const PREAMBLE_TESTING = `
You are running as a local CLI agent with full file-system access.
Your role in this pipeline is TESTING -- you receive implemented code and
must validate it.

Your job:
1. Read the existing source files in the workspace to understand what was built.
2. Read DESIGN.md (if present) to understand intended behaviour.
3. Create test files using an appropriate testing framework.
4. Use your shell tool to install test dependencies and run the tests.
5. Report on test results, coverage, and any issues found.

Write all test files to disk and execute them.
`.trim();

function getPreamble(category: string): string {
  switch (category) {
    case "planning": return PREAMBLE_PLANNING;
    case "design": return PREAMBLE_DESIGN;
    case "coding": return PREAMBLE_CODING;
    case "validation": return PREAMBLE_TESTING;
    default: return PREAMBLE_CODING;
  }
}

function getWorkspaceInventory(workDir: string): string | null {
  try {
    let files: string[];
    try {
      const output = execSync("git ls-files", {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: "pipe",
      });
      files = output.split("\n").map((f) => f.trim()).filter(Boolean);
    } catch {
      const output = execSync(
        process.platform === "win32" ? "dir /s /b /a-d" : "find . -type f -not -path './.git/*'",
        { cwd: workDir, encoding: "utf-8", timeout: 10_000, stdio: "pipe" },
      );
      files = output.split("\n").map((f) => f.trim()).filter(Boolean);
    }

    const sourceFiles = files.filter(
      (f) => !f.startsWith(".cursor/") && !f.startsWith(".pipeline/") && !f.startsWith(".git/"),
    );

    if (sourceFiles.length === 0) return null;

    const listing = sourceFiles.slice(0, 50).map((f) => {
      try {
        const stat = require("fs").statSync(path.join(workDir, f));
        const content = require("fs").readFileSync(path.join(workDir, f), "utf-8");
        const lineCount = content.split("\n").length;
        return `- ${f} (${lineCount} lines)`;
      } catch {
        return `- ${f}`;
      }
    });

    if (sourceFiles.length > 50) {
      listing.push(`- ... and ${sourceFiles.length - 50} more files`);
    }

    return listing.join("\n");
  } catch {
    return null;
  }
}

function getKeyFileContents(workDir: string): string | null {
  const summaryFiles = ["package.json", "README.md", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"];
  const sections: string[] = [];

  for (const name of summaryFiles) {
    try {
      const content = require("fs").readFileSync(path.join(workDir, name), "utf-8");
      if (content.trim()) {
        const preview = content.length > 1500 ? content.slice(0, 1500) + "\n... (truncated)" : content;
        sections.push(`### ${name}\n\`\`\`\n${preview}\n\`\`\``);
      }
    } catch {
      // file doesn't exist
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

function buildFullPrompt(
  config: AgentRunConfig,
  skillPack: SkillPack,
  workDir: string,
): string {
  const parts: string[] = [];

  parts.push(getPreamble(config.category));
  parts.push("");

  if (config.category === "design") {
    const inventory = getWorkspaceInventory(workDir);
    if (inventory) {
      parts.push("## Existing Workspace");
      parts.push("This workspace already contains the following files:");
      parts.push(inventory);
      parts.push("");

      const keyFiles = getKeyFileContents(workDir);
      if (keyFiles) {
        parts.push("## Key Project Files");
        parts.push(keyFiles);
        parts.push("");
      }
    }
  }

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

  if (config.upstreamResults && config.upstreamResults.length > 0) {
    parts.push("");
    parts.push("## Upstream agent results");
    for (const result of config.upstreamResults) {
      parts.push(`### ${result.agent}`);
      parts.push(`- Status: ${result.success ? "succeeded" : "failed"}`);
      parts.push(`- Files created: ${result.filesModified.join(", ") || "none"}`);
      if (result.parsed.assistantMessage) {
        const summary = result.parsed.assistantMessage.length > 2000
          ? result.parsed.assistantMessage.slice(0, 2000) + "\n... (truncated)"
          : result.parsed.assistantMessage;
        parts.push(`- Summary: ${summary}`);
      }
      parts.push(`- Handoff file: .pipeline/${result.agent}.handoff.md (read this for full details)`);
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
    : path.join(os.tmpdir(), `agent-mvp-${config.pipelineId}`);

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
      .filter((f) => !f.startsWith(INJECTED_PATH_PREFIX) && !f.startsWith(PIPELINE_PATH_PREFIX));
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
        .filter((f) => !f.startsWith(INJECTED_PATH_PREFIX) && !f.startsWith(PIPELINE_PATH_PREFIX));
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
): Promise<{ text: string; timedOut: boolean }> {
  const startTime = Date.now();
  console.log(`[planner] Starting (timeout: ${(timeoutMs / 1000).toFixed(0)}s)`);

  const result = await runAgentCli(prompt, workDir, timeoutMs);

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
    console.log(`[planner] Timed out after ${elapsed}s`);
  } else {
    console.log(`[planner] Completed in ${elapsed}s (exit ${result.exitCode})`);
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

  const cursorResult = await runAgentCli(
    fullPrompt,
    workDir,
    timeoutMs,
    onEvent,
    abortSignal,
  );

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

  const filesModified = collectModifiedFiles(workDir);
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

const LOG_DIR = path.join(os.tmpdir(), "agent-mvp-logs");

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
    console.log(`  [debug] Logs written to ${LOG_DIR}/${prefix}_*`);
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
  onEvent?: AgentEventCallback,
  abortSignal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = [
    ...AGENT.args,
    "-p",
    "--force",
    "--trust",
    "--workspace", workDir,
    "--output-format", "stream-json",
  ];

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
      clearTimeout(timer);
      reject(err);
    });
  });
}
