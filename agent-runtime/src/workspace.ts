import { execSync } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { AgentConfig, SkillPack } from "./types";

const WORKSPACE_DIR = "/workspace";

export interface GitIdentity {
  token: string;
  userName: string;
  userEmail: string;
}

export async function setupWorkspace(
  config: AgentConfig,
  skillPack: SkillPack
): Promise<string> {
  const workDir = path.join(WORKSPACE_DIR, "repo");
  const git: GitIdentity = {
    token: config.githubToken,
    userName: config.gitUserName,
    userEmail: config.gitUserEmail,
  };

  if (config.repo) {
    await cloneRepo(config.repo, workDir, git);
  } else {
    await fs.mkdir(workDir, { recursive: true });
    execSync("git init", { cwd: workDir, stdio: "pipe" });
  }

  configureGitIdentity(workDir, git);

  if (skillPack.cursorRules && Object.keys(skillPack.cursorRules).length > 0) {
    await injectCursorRules(workDir, skillPack.cursorRules);
  }

  if (skillPack.mcpConfig) {
    await injectMcpConfig(workDir, resolveEnvVars(skillPack.mcpConfig));
  }

  return workDir;
}

function buildAuthenticatedUrl(repo: string, token: string): string {
  const url = new URL(repo.endsWith(".git") ? repo : `${repo}.git`);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

async function cloneRepo(
  repo: string,
  targetDir: string,
  git: GitIdentity
): Promise<void> {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  const authUrl = buildAuthenticatedUrl(repo, git.token);
  execSync(`git clone --depth 1 ${authUrl} ${targetDir}`, {
    encoding: "utf-8",
    timeout: 120_000,
    stdio: "pipe",
  });

  stripTokenFromRemote(targetDir, repo);
}

function stripTokenFromRemote(workDir: string, originalUrl: string): void {
  execSync(`git remote set-url origin ${originalUrl}`, {
    cwd: workDir,
    stdio: "pipe",
  });
}

function configureGitIdentity(workDir: string, git: GitIdentity): void {
  execSync(`git config user.name "${git.userName}"`, {
    cwd: workDir,
    stdio: "pipe",
  });
  execSync(`git config user.email "${git.userEmail}"`, {
    cwd: workDir,
    stdio: "pipe",
  });
  execSync(
    `git config credential.helper '!f() { echo "username=x-access-token"; echo "password=${git.token}"; }; f'`,
    { cwd: workDir, stdio: "pipe" }
  );
}

async function injectCursorRules(
  workDir: string,
  cursorRules: Record<string, string>
): Promise<void> {
  const rulesDir = path.join(workDir, ".cursor", "rules");
  await fs.mkdir(rulesDir, { recursive: true });
  for (const [filename, content] of Object.entries(cursorRules)) {
    await fs.writeFile(path.join(rulesDir, filename), content, "utf-8");
  }
}

async function injectMcpConfig(
  workDir: string,
  mcpConfig: Record<string, unknown>
): Promise<void> {
  const cursorDir = path.join(workDir, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });
  await fs.writeFile(
    path.join(cursorDir, "mcp.json"),
    JSON.stringify(mcpConfig, null, 2),
    "utf-8"
  );
}

function resolveEnvVars(obj: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(obj);
  const resolved = json.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}/g,
    (_, name) => process.env[name] || ""
  );
  return JSON.parse(resolved);
}

export async function collectModifiedFiles(workDir: string): Promise<string[]> {
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
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function commitAndPush(
  workDir: string,
  agentType: string,
  pipelineRef: string,
  branch: string
): { committed: boolean; pushed: boolean; commitSha?: string } {
  try {
    execSync("git add -A", { cwd: workDir, stdio: "pipe" });

    const status = execSync("git status --porcelain", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    if (!status) {
      return { committed: false, pushed: false };
    }

    const message = `[${agentType}] pipeline ${pipelineRef}`;
    execSync(`git commit -m "${message}"`, {
      cwd: workDir,
      stdio: "pipe",
    });

    const commitSha = execSync("git rev-parse HEAD", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    execSync(`git push origin HEAD:${branch}`, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: "pipe",
    });

    return { committed: true, pushed: true, commitSha };
  } catch (err) {
    console.error("commitAndPush failed:", err);
    return { committed: false, pushed: false };
  }
}
