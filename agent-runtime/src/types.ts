export interface AgentConfig {
  agentType: string;
  category: string;
  skillPack: string;
  pipelineRef: string;
  taskName: string;
  prompt: string;
  repo: string;
  skillsBucket: string;
  resultsTable: string;
  upstreamRefs: string[];
  cursorFlags: string[];
  context: Record<string, string>;
  /** Pre-built codebase context brief injected by the operator (via CONTEXT_BRIEF env var) */
  contextBrief?: string;
  cursorApiKey: string;
  githubToken: string;
  gitUserName: string;
  gitUserEmail: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface SkillPack {
  systemPrompt: string;
  constraints: AgentConstraints;
  cursorRules?: Record<string, string>;
  mcpConfig?: Record<string, unknown>;
  tools?: ToolDefinition[];
}

export interface AgentConstraints {
  maxTokens: number;
  forbiddenActions: string[];
  requiredOutputFields: string[];
  timeoutMs: number;
}

export interface AgentResult {
  agent: string;
  pipelineRef: string;
  taskName: string;
  success: boolean;
  output: Record<string, unknown>;
  filesModified: string[];
  errors: string[];
  durationMs: number;
  timestamp: string;
}

export interface RiskAssessment {
  isRisky: boolean;
  risks: { description: string; severity: "low" | "medium" | "high" }[];
}

export interface CursorStreamEvent {
  type: string;
  content?: string;
  tool_call?: {
    name: string;
    arguments: Record<string, unknown>;
  };
  error?: string;
}
