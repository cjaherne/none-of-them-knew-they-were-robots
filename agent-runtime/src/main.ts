import { AgentConfig } from "./types";
import { executeAgentLifecycle } from "./lifecycle";

function loadConfig(): AgentConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing required env var: ${name}`);
    }
    return value;
  };

  const context: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CONTEXT_") && value) {
      const contextKey = key
        .slice("CONTEXT_".length)
        .toLowerCase()
        .replace(/_/g, "-");
      context[contextKey] = value;
    }
  }

  return {
    agentType: required("AGENT_TYPE"),
    category: required("AGENT_CATEGORY"),
    skillPack: required("SKILL_PACK"),
    pipelineRef: required("PIPELINE_REF"),
    taskName: required("TASK_NAME"),
    prompt: required("PROMPT"),
    repo: process.env.REPO || "",
    skillsBucket: required("SKILLS_BUCKET"),
    resultsTable: required("RESULTS_TABLE"),
    upstreamRefs: (process.env.UPSTREAM_REFS || "")
      .split(",")
      .filter(Boolean),
    cursorFlags: (process.env.CURSOR_FLAGS || "--force --trust --output-format stream-json")
      .split(" ")
      .filter(Boolean),
    context,
    contextBrief: process.env.CONTEXT_BRIEF || undefined,
    cursorApiKey: required("CURSOR_API_KEY"),
    githubToken: required("GITHUB_TOKEN"),
    gitUserName: required("GIT_USER_NAME"),
    gitUserEmail: required("GIT_USER_EMAIL"),
  };
}

async function main() {
  console.log("=== Agent Runtime Starting ===");

  try {
    const config = loadConfig();
    console.log(`Agent: ${config.agentType} (${config.category})`);
    console.log(`Pipeline: ${config.pipelineRef}`);

    const result = await executeAgentLifecycle(config);

    if (result.success) {
      console.log("=== Agent Runtime Completed Successfully ===");
      process.exit(0);
    } else {
      console.error("=== Agent Runtime Failed ===");
      console.error("Errors:", result.errors);
      process.exit(1);
    }
  } catch (err) {
    console.error("=== Agent Runtime Fatal Error ===");
    console.error(err);
    process.exit(1);
  }
}

main();
