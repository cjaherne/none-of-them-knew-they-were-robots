import * as path from "path";
import { promises as fs } from "fs";
import { execSync } from "child_process";

interface FileSummary {
  path: string;
  lines: number;
  purpose: string;
}

interface ContextCache {
  version: 2;
  createdAt: string;
  updatedAt: string;
  gitSha: string;
  techStack: string;
  files: FileSummary[];
  architectureBrief: string;
}

const CACHE_DIR = ".pipeline";
const CACHE_FILE = "context-cache.json";
const BRIEF_FILE = "architecture-brief.md";

const SKIP_DIRS = new Set([".cursor", ".pipeline", ".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv", "coverage"]);
const SUMMARIZABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cs", ".html", ".css", ".scss", ".vue", ".svelte"]);

function getCurrentSha(workDir: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch { return "unknown"; }
}

function getChangedFilesSince(workDir: string, sha: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${sha}..HEAD`, {
      cwd: workDir, encoding: "utf-8", timeout: 5_000, stdio: "pipe",
    });
    return output.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch { return []; }
}

function listSourceFiles(workDir: string): string[] {
  try {
    const output = execSync("git ls-files", {
      cwd: workDir, encoding: "utf-8", timeout: 10_000, stdio: "pipe",
    });
    return output.split("\n").map((f) => f.trim()).filter(Boolean)
      .filter((f) => {
        const firstDir = f.split("/")[0];
        return !SKIP_DIRS.has(firstDir);
      });
  } catch { return []; }
}

function heuristicPurpose(filePath: string, firstLines: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);

  if (base === "package.json") return "Node.js project configuration and dependencies";
  if (base === "tsconfig.json") return "TypeScript compiler configuration";
  if (base === "README.md") return "Project documentation";
  if (base === "DESIGN.md") return "Design document for the current feature";
  if (/\.test\.|\.spec\./.test(base)) return `Tests for ${base.replace(/\.(test|spec)\./, ".")}`;
  if (base.startsWith("index.")) return `Entry point for ${dir === "." ? "the project" : dir}`;
  if (/types?\./.test(base)) return "Type definitions and interfaces";
  if (/models?\./.test(base)) return "Data models";
  if (/routes?\./.test(base) || /router\./.test(base)) return "Route definitions";
  if (/middleware/.test(base)) return "Middleware functions";
  if (/config/.test(base)) return "Configuration";
  if (/utils?\./.test(base) || /helpers?\./.test(base)) return "Utility functions";
  if (/server\./.test(base) || /app\./.test(base)) return "Application entry / server setup";
  if (/component/.test(dir) || ext === ".tsx" || ext === ".vue" || ext === ".svelte") return "UI component";
  if (/hooks?/.test(dir) || /^use[A-Z]/.test(base)) return "React hook";
  if (/store|redux|state/.test(base) || /store/.test(dir)) return "State management";
  if (/service/.test(base) || /service/.test(dir)) return "Service layer";
  if (/api/.test(dir)) return "API endpoint";

  const importMatch = firstLines.match(/(?:import|require|from)\s+['"]([^'"]+)['"]/);
  if (importMatch) return `Module using ${importMatch[1]}`;

  if (ext === ".css" || ext === ".scss") return "Styles";
  if (ext === ".html") return "HTML template";

  return `Source file (${ext || "unknown"})`;
}

async function summarizeWithOpenAI(
  files: Array<{ path: string; content: string }>,
): Promise<Record<string, string>> {
  if (!process.env.OPENAI_API_KEY) return {};

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const fileDescriptions = files.map((f) => {
      const preview = f.content.slice(0, 500);
      return `### ${f.path}\n\`\`\`\n${preview}\n\`\`\``;
    }).join("\n\n");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Describe the purpose of each source file in 1 short sentence. Respond as JSON: { \"<filepath>\": \"purpose\" }. Be specific about what the file does in the project, not generic.",
        },
        { role: "user", content: fileDescriptions },
      ],
      max_tokens: 1024,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (content) {
      try {
        return JSON.parse(content);
      } catch {
        console.warn("[context-cache] OpenAI returned invalid JSON, falling back to heuristics");
        return {};
      }
    }
  } catch (err) {
    console.warn("[context-cache] OpenAI summarization failed:", err);
  }
  return {};
}

async function generateArchitectureBrief(
  cache: ContextCache,
): Promise<string> {
  const lines: string[] = [];
  lines.push(`# Architecture Brief`);
  lines.push(`\nTech stack: ${cache.techStack}`);
  lines.push(`Files: ${cache.files.length}`);
  lines.push(`\n## File Map\n`);

  const byDir: Record<string, FileSummary[]> = {};
  for (const f of cache.files) {
    const dir = path.dirname(f.path);
    (byDir[dir] ??= []).push(f);
  }

  for (const dir of Object.keys(byDir).sort()) {
    lines.push(`### ${dir}/`);
    for (const f of byDir[dir]) {
      lines.push(`- **${path.basename(f.path)}** (${f.lines} lines) — ${f.purpose}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function loadOrBuildCache(workDir: string, techStack: string): Promise<ContextCache> {
  const cacheDir = path.join(workDir, CACHE_DIR);
  const cachePath = path.join(cacheDir, CACHE_FILE);

  let existing: ContextCache | null = null;
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    try {
      existing = JSON.parse(raw);
    } catch {
      console.warn("[context-cache] Corrupt cache file, rebuilding");
      existing = null;
    }
    if (existing && existing.version !== 2) existing = null;
  } catch { /* no cache file */ }

  const currentSha = getCurrentSha(workDir);
  const allFiles = listSourceFiles(workDir).filter((f) => {
    const ext = path.extname(f);
    return SUMMARIZABLE_EXTS.has(ext) || f === "package.json" || f === "README.md";
  });

  let filesToSummarize: string[];

  if (existing && existing.gitSha !== "unknown") {
    const changed = getChangedFilesSince(workDir, existing.gitSha);
    const changedSet = new Set(changed);
    const existingPaths = new Set(existing.files.map((f) => f.path));
    const newFiles = allFiles.filter((f) => !existingPaths.has(f));
    filesToSummarize = [...changed.filter((f) => existingPaths.has(f)), ...newFiles];

    if (filesToSummarize.length === 0 && newFiles.length === 0) {
      console.log(`[context-cache] Cache is current (sha: ${currentSha.slice(0, 8)})`);
      return existing;
    }
    console.log(`[context-cache] Incremental update: ${filesToSummarize.length} changed, ${newFiles.length} new`);
  } else {
    filesToSummarize = allFiles;
    console.log(`[context-cache] Full build: ${filesToSummarize.length} files`);
  }

  const fileContents: Array<{ path: string; content: string; lines: number }> = [];
  for (const f of filesToSummarize.slice(0, 60)) {
    try {
      const content = await fs.readFile(path.join(workDir, f), "utf-8");
      fileContents.push({ path: f, content, lines: content.split("\n").length });
    } catch { /* skip unreadable */ }
  }

  const aiSummaries = await summarizeWithOpenAI(
    fileContents.slice(0, 30).map((f) => ({ path: f.path, content: f.content })),
  );

  const newSummaries: FileSummary[] = fileContents.map((f) => ({
    path: f.path,
    lines: f.lines,
    purpose: aiSummaries[f.path] || heuristicPurpose(f.path, f.content.slice(0, 200)),
  }));

  let mergedFiles: FileSummary[];
  if (existing) {
    const updatedPaths = new Set(newSummaries.map((f) => f.path));
    mergedFiles = [
      ...existing.files.filter((f) => !updatedPaths.has(f.path) && allFiles.includes(f.path)),
      ...newSummaries,
    ];
  } else {
    mergedFiles = newSummaries;
  }

  const cache: ContextCache = {
    version: 2,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    gitSha: currentSha,
    techStack,
    files: mergedFiles,
    architectureBrief: "",
  };

  cache.architectureBrief = await generateArchitectureBrief(cache);

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  await fs.writeFile(path.join(cacheDir, BRIEF_FILE), cache.architectureBrief, "utf-8");

  console.log(`[context-cache] Saved: ${cache.files.length} files, sha ${currentSha.slice(0, 8)}`);
  return cache;
}

export function getCacheBrief(cache: ContextCache): string {
  return cache.architectureBrief;
}

export function getFilePurpose(cache: ContextCache, filePath: string): string | null {
  const entry = cache.files.find((f) => f.path === filePath);
  return entry?.purpose || null;
}
