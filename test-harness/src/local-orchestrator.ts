import * as path from "path";
import { TaskStatus } from "@agents/shared";
import { taskStore, MvpTask } from "./local-task-store";
import {
  runAgent,
  setupWorkspace,
  pushBranch,
  AgentRunConfig,
  AgentRunResult,
} from "./local-agent-runner";

const MVP_STAGES: { name: string; agent: string; category: string }[] = [
  { name: "design", agent: "core-code-designer", category: "design" },
  { name: "coding", agent: "coding", category: "coding" },
  { name: "validation", agent: "testing", category: "validation" },
];

function resolveSkillsRoot(): string {
  return (
    process.env.SKILLS_ROOT ||
    path.resolve(__dirname, "..", "..", "skills")
  );
}

export async function runPipeline(task: MvpTask): Promise<void> {
  const skillsRoot = resolveSkillsRoot();
  const upstreamResults: AgentRunResult[] = [];

  taskStore.updateTaskStatus(task.id, TaskStatus.Running);

  const baseConfig: Pick<AgentRunConfig, "prompt" | "repo" | "pipelineId" | "skillsRoot" | "workspace" | "baseBranch" | "branch"> = {
    prompt: task.prompt,
    repo: task.repo,
    pipelineId: task.id,
    skillsRoot,
    workspace: task.workspace,
    baseBranch: task.baseBranch,
    branch: task.branch,
  };

  // Prepare workspace once -- clone, checkout base, create work branch
  let workDir: string;
  try {
    workDir = await setupWorkspace(baseConfig as AgentRunConfig);
    console.log(`[pipeline ${task.id.slice(0, 8)}] workspace: ${workDir}, branch: ${task.branch}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    taskStore.updateTaskStatus(task.id, TaskStatus.Failed, `Workspace setup failed: ${message}`);
    return;
  }

  for (const stage of MVP_STAGES) {
    taskStore.updateStage(task.id, stage.name, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    try {
      const config: AgentRunConfig = {
        ...baseConfig,
        agentType: stage.agent,
        category: stage.category,
        workspaceReady: true,
        upstreamResults: upstreamResults.length > 0
          ? [...upstreamResults]
          : undefined,
      };

      const result = await runAgent(config, workDir, (event) => {
        const current = taskStore.getTask(task.id);
        if (!current) return;
        taskStore.updateStage(task.id, stage.name, {
          status: "running",
        });
      });

      upstreamResults.push(result);

      if (result.success) {
        taskStore.updateStage(task.id, stage.name, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          filesModified: result.filesModified,
          durationMs: result.durationMs,
        });
      } else {
        taskStore.updateStage(task.id, stage.name, {
          status: "failed",
          completedAt: new Date().toISOString(),
          errors: result.errors,
          durationMs: result.durationMs,
        });

        taskStore.updateTaskStatus(
          task.id,
          TaskStatus.Failed,
          `Stage "${stage.name}" failed: ${result.errors.join("; ")}`,
        );
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      taskStore.updateStage(task.id, stage.name, {
        status: "failed",
        completedAt: new Date().toISOString(),
        errors: [message],
      });
      taskStore.updateTaskStatus(
        task.id,
        TaskStatus.Failed,
        `Stage "${stage.name}" threw: ${message}`,
      );
      return;
    }
  }

  // Push the work branch once after all stages succeed
  if (task.repo) {
    const push = pushBranch(workDir, task.branch);
    if (push.pushed) {
      console.log(`[pipeline ${task.id.slice(0, 8)}] pushed ${task.branch} to origin`);
    } else {
      console.warn(`[pipeline ${task.id.slice(0, 8)}] push failed: ${push.error}`);
    }
  }

  taskStore.updateTaskStatus(task.id, TaskStatus.Completed);
}
