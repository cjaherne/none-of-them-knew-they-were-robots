export interface AppConfig {
  region: string;
  stage: string;
  tasksTableName: string;
  approvalsTableName: string;
  agentResultsTableName: string;
  skillsBucketName: string;
  audioBucketName: string;
  websocketApiEndpoint: string;
  openaiApiKeySecretArn: string;
  anthropicApiKeySecretArn: string;
  eksClusterName: string;
  agentNamespace: string;
  agentImageUri: string;
}

export function getConfig(): AppConfig {
  return {
    region: requiredEnv("AWS_REGION"),
    stage: requiredEnv("STAGE"),
    tasksTableName: requiredEnv("TASKS_TABLE"),
    approvalsTableName: requiredEnv("APPROVALS_TABLE"),
    agentResultsTableName: requiredEnv("AGENT_RESULTS_TABLE"),
    skillsBucketName: requiredEnv("SKILLS_BUCKET"),
    audioBucketName: requiredEnv("AUDIO_BUCKET"),
    websocketApiEndpoint: requiredEnv("WEBSOCKET_API_ENDPOINT"),
    openaiApiKeySecretArn: requiredEnv("OPENAI_API_KEY_SECRET_ARN"),
    anthropicApiKeySecretArn: requiredEnv("ANTHROPIC_API_KEY_SECRET_ARN"),
    eksClusterName: requiredEnv("EKS_CLUSTER_NAME"),
    agentNamespace: process.env.AGENT_NAMESPACE || "agent-system",
    agentImageUri: requiredEnv("AGENT_IMAGE_URI"),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
