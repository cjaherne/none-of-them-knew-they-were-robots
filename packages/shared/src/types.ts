// --- Task lifecycle ---

export enum TaskStatus {
  Queued = "queued",
  Running = "running",
  AwaitingApproval = "awaiting_approval",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  repo?: string;
  requiresApproval: boolean;
  pipelineName?: string;
  resultSummary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Agent registry (extensible, config-driven) ---

export enum AgentCategory {
  Analysis = "analysis",
  Design = "design",
  Coding = "coding",
  Validation = "validation",
}

export interface AgentRegistryEntry {
  type: string;
  displayName: string;
  category: AgentCategory;
  skillPack: string;
  resources: AgentResourceRequirements;
  cursorFlags?: string[];
}

export interface AgentResourceRequirements {
  memory: string;
  cpu: string;
}

export interface AgentCategoryDefinition {
  name: AgentCategory;
  order: number;
  description: string;
}

export interface AgentRegistry {
  categories: AgentCategoryDefinition[];
  agents: AgentRegistryEntry[];
}

// --- CRD-aligned types (mirror the K8s custom resources in TypeScript) ---

export interface PipelineStageAgent {
  type: string;
  context?: Record<string, unknown>;
}

export interface PipelineStage {
  name: string;
  parallel?: boolean;
  agents: PipelineStageAgent[];
}

export enum PipelinePhase {
  Pending = "Pending",
  Planning = "Planning",
  Running = "Running",
  AwaitingApproval = "AwaitingApproval",
  Completed = "Completed",
  Failed = "Failed",
}

export interface AgentPipelineSpec {
  taskId: string;
  prompt: string;
  repo?: string;
  requiresApproval: boolean;
  stages: PipelineStage[];
}

export interface AgentPipelineStatus {
  phase: PipelinePhase;
  currentStage?: string;
  stageResults?: Record<string, AgentTaskResult[]>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export enum AgentTaskPhase {
  Pending = "Pending",
  Running = "Running",
  AwaitingApproval = "AwaitingApproval",
  Succeeded = "Succeeded",
  Failed = "Failed",
}

export interface AgentTaskSpec {
  pipelineRef: string;
  agentType: string;
  category: AgentCategory;
  prompt: string;
  context?: Record<string, unknown>;
  upstreamResults?: AgentTaskResult[];
  skillPack: string;
  resources: AgentResourceRequirements;
  cursorFlags?: string[];
}

export interface AgentTaskResult {
  agent: string;
  taskId: string;
  success: boolean;
  output: Record<string, unknown>;
  filesModified?: string[];
  errors?: string[];
  durationMs: number;
  timestamp: string;
}

export interface AgentTaskStatus {
  phase: AgentTaskPhase;
  jobName?: string;
  result?: AgentTaskResult;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

// --- Approval ---

export interface ApprovalRequest {
  id: string;
  taskId: string;
  pipelineName?: string;
  agentTaskName?: string;
  action: string;
  detail: string;
  diffPreview?: string;
  approved?: boolean;
  respondedAt?: string;
  createdAt: string;
}

// --- Voice interface ---

export interface VoiceCommandRequest {
  audioBase64?: string;
  audioUrl?: string;
  text?: string;
}

export interface VoiceCommandResponse {
  taskId: string;
  pipelineName: string;
  status: TaskStatus;
}

export interface TaskStreamEvent {
  taskId: string;
  agent?: string;
  type: "status_change" | "log" | "approval_required" | "result";
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

// --- Intent parsing ---

export interface ParsedIntent {
  action: "cursor_task" | "status_query" | "approval_response";
  prompt: string;
  repo: string;
  requiresApproval: boolean;
  metadata?: Record<string, unknown>;
}

// --- Skill packs ---

export interface AgentSkillPack {
  systemPrompt: string;
  constraints: AgentConstraints;
  cursorRules?: string;
  mcpConfig?: Record<string, unknown>;
}

export interface AgentConstraints {
  maxTokens: number;
  forbiddenActions: string[];
  requiredOutputFields: string[];
  timeoutMs: number;
}

// --- GitHub integration (single-user, self-hosted) ---

export interface GitHubConfig {
  username: string;
  email: string;
  token: string;
}

export interface SetupStatus {
  github: {
    configured: boolean;
    username?: string;
    email?: string;
    tokenSet: boolean;
  };
  cursor: {
    configured: boolean;
    tokenSet: boolean;
  };
}

export interface SetupGitHubRequest {
  token: string;
  username: string;
  email: string;
}

export interface SetupGitHubResponse {
  success: boolean;
  username: string;
  email: string;
  scopes?: string[];
  error?: string;
}
