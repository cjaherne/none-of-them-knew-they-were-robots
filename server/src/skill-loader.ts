import { promises as fs } from "fs";
import * as path from "path";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface AgentConstraints {
  maxTokens: number;
  forbiddenActions: string[];
  requiredOutputFields: string[];
  timeoutMs: number;
}

export interface SkillPack {
  systemPrompt: string;
  constraints: AgentConstraints;
  cursorRules?: Record<string, string>;
  mcpConfig?: Record<string, unknown>;
  tools?: ToolDefinition[];
}

const DEFAULT_CONSTRAINTS: AgentConstraints = {
  maxTokens: 4096,
  forbiddenActions: [],
  requiredOutputFields: [],
  timeoutMs: 300_000,
};

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function tryReadJson<T>(filePath: string): Promise<T | null> {
  const content = await tryReadFile(filePath);
  if (!content) return null;
  return JSON.parse(content) as T;
}

async function loadCursorRules(
  skillDir: string,
): Promise<Record<string, string> | undefined> {
  const rulesDir = path.join(skillDir, "rules");

  try {
    const entries = await fs.readdir(rulesDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));

    if (mdFiles.length > 0) {
      const rules: Record<string, string> = {};
      for (const file of mdFiles) {
        rules[file] = await fs.readFile(path.join(rulesDir, file), "utf-8");
      }
      return rules;
    }
  } catch {
    // rules/ directory doesn't exist, try single file fallback
  }

  const single = await tryReadFile(path.join(skillDir, "cursor-rules.md"));
  if (single) {
    return { "agent.md": single };
  }

  return undefined;
}

export async function loadSkillPack(
  agentType: string,
  skillsRoot: string,
): Promise<SkillPack> {
  const skillDir = path.join(skillsRoot, agentType);

  const systemPrompt = await tryReadFile(
    path.join(skillDir, "system-prompt.md"),
  );
  if (!systemPrompt) {
    throw new Error(
      `Missing system-prompt.md for agent type "${agentType}" in ${skillDir}`,
    );
  }

  const constraints =
    (await tryReadJson<AgentConstraints>(
      path.join(skillDir, "constraints.json"),
    )) ?? DEFAULT_CONSTRAINTS;

  const cursorRules = await loadCursorRules(skillDir);

  const mcpConfig = await tryReadJson<Record<string, unknown>>(
    path.join(skillDir, "mcp-config.json"),
  );

  const tools = await tryReadJson<ToolDefinition[]>(
    path.join(skillDir, "tools.json"),
  );

  return {
    systemPrompt,
    constraints,
    cursorRules: cursorRules ?? undefined,
    mcpConfig: mcpConfig ?? undefined,
    tools: tools ?? undefined,
  };
}
