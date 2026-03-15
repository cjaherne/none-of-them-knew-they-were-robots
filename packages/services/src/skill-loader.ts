import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { AgentSkillPack, AgentConstraints } from "@agents/shared";

const s3 = new S3Client({});

const skillCache = new Map<string, AgentSkillPack>();

async function getS3Object(bucket: string, key: string): Promise<string> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  return await result.Body!.transformToString();
}

export async function loadSkill(
  agentType: string,
  skillsBucket: string
): Promise<AgentSkillPack> {
  const cacheKey = `${skillsBucket}:${agentType}`;
  if (skillCache.has(cacheKey)) {
    return skillCache.get(cacheKey)!;
  }

  const prefix = agentType;

  const systemPrompt = await getS3Object(
    skillsBucket,
    `${prefix}/system-prompt.md`
  );

  let constraints: AgentConstraints;
  try {
    const raw = await getS3Object(skillsBucket, `${prefix}/constraints.json`);
    constraints = JSON.parse(raw);
  } catch {
    constraints = {
      maxTokens: 4096,
      forbiddenActions: [],
      requiredOutputFields: [],
      timeoutMs: 120_000,
    };
  }

  let cursorRules: string | undefined;
  try {
    cursorRules = await getS3Object(skillsBucket, `${prefix}/cursor-rules.md`);
  } catch {
    cursorRules = undefined;
  }

  let mcpConfig: Record<string, unknown> | undefined;
  try {
    const raw = await getS3Object(skillsBucket, `${prefix}/mcp-config.json`);
    mcpConfig = JSON.parse(raw);
  } catch {
    mcpConfig = undefined;
  }

  const skill: AgentSkillPack = { systemPrompt, constraints, cursorRules, mcpConfig };
  skillCache.set(cacheKey, skill);
  return skill;
}
