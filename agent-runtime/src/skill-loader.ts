import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SkillPack, AgentConstraints } from "./types";

const s3 = new S3Client({});

async function getS3Text(bucket: string, key: string): Promise<string> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  return await result.Body!.transformToString();
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

  let cursorRules: string | undefined;
  try {
    cursorRules = await getS3Text(skillsBucket, `${prefix}/cursor-rules.md`);
  } catch {
    cursorRules = undefined;
  }

  let mcpConfig: Record<string, unknown> | undefined;
  try {
    const raw = await getS3Text(skillsBucket, `${prefix}/mcp-config.json`);
    mcpConfig = JSON.parse(raw);
  } catch {
    mcpConfig = undefined;
  }

  return { systemPrompt, constraints, cursorRules, mcpConfig };
}
