import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { SkillPack, AgentConstraints, ToolDefinition } from "./types";

const s3 = new S3Client({});

async function getS3Text(bucket: string, key: string): Promise<string> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  return await result.Body!.transformToString();
}

async function listS3Keys(
  bucket: string,
  prefix: string
): Promise<string[]> {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
  );
  return (result.Contents || [])
    .map((obj) => obj.Key!)
    .filter(Boolean);
}

const DEFAULT_CONSTRAINTS: AgentConstraints = {
  maxTokens: 4096,
  forbiddenActions: [],
  requiredOutputFields: [],
  timeoutMs: 300_000,
};

export async function loadSkillPack(
  skillPackName: string,
  skillsBucket: string
): Promise<SkillPack> {
  const prefix = skillPackName;

  const systemPrompt = await getS3Text(
    skillsBucket,
    `${prefix}/system-prompt.md`
  );

  let constraints: AgentConstraints;
  try {
    const raw = await getS3Text(skillsBucket, `${prefix}/constraints.json`);
    constraints = JSON.parse(raw);
  } catch {
    constraints = DEFAULT_CONSTRAINTS;
  }

  const cursorRules = await loadCursorRules(skillsBucket, prefix);

  let mcpConfig: Record<string, unknown> | undefined;
  try {
    const raw = await getS3Text(skillsBucket, `${prefix}/mcp-config.json`);
    mcpConfig = JSON.parse(raw);
  } catch {
    mcpConfig = undefined;
  }

  let tools: ToolDefinition[] | undefined;
  try {
    const raw = await getS3Text(skillsBucket, `${prefix}/tools.json`);
    tools = JSON.parse(raw);
  } catch {
    tools = undefined;
  }

  return { systemPrompt, constraints, cursorRules, mcpConfig, tools };
}

async function loadCursorRules(
  bucket: string,
  prefix: string
): Promise<Record<string, string> | undefined> {
  const rulesPrefix = `${prefix}/rules/`;
  const keys = await listS3Keys(bucket, rulesPrefix);
  const mdKeys = keys.filter((k) => k.endsWith(".md"));

  if (mdKeys.length > 0) {
    const rules: Record<string, string> = {};
    for (const key of mdKeys) {
      const filename = key.slice(rulesPrefix.length);
      rules[filename] = await getS3Text(bucket, key);
    }
    return Object.keys(rules).length > 0 ? rules : undefined;
  }

  try {
    const single = await getS3Text(bucket, `${prefix}/cursor-rules.md`);
    return { "agent.md": single };
  } catch {
    return undefined;
  }
}
