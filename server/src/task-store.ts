import { EventEmitter } from "events";
import { v4 as uuid } from "uuid";
import { TaskStatus } from "@agents/shared";
import type { Task, TaskStreamEvent } from "@agents/shared";
import { saveTaskHistory } from "./log-store";

export interface StageStatus {
  name: string;
  agent: string;
  status: "pending" | "running" | "succeeded" | "failed";
  startedAt?: string;
  completedAt?: string;
  filesModified?: string[];
  errors?: string[];
  durationMs?: number;
  notes?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  estimatedCost?: number;
  /** True when feedback loop limit reached but CODING_NOTES.md had unaddressed feedback */
  feedbackLimitReached?: boolean;
  /** Content of unaddressed feedback when feedbackLimitReached is true */
  unaddressedFeedback?: string;
  /**
   * Spec-kit Tier 2 PR2 — display-friendly summaries of the named Overseer
   * sub-stages. UI uses these to render per-stage status chips + drill-down.
   * The full overseer JSON is also emitted via overseer log events; these are
   * just the bits the UI needs without parsing the log stream.
   */
  clarifyResult?: {
    fit: "ok" | "gaps";
    gapCount: number;
    iteration: number;
    clarificationsAppended: number;
  };
  analyzeResult?: {
    fit: "ok" | "drift";
    issueCount: number;
    iterationsUsed: number;
    fixUpsRun: number;
    capReached: boolean;
  };
  /** Reserved for Tier 2 PR3 (`checklist` stage). */
  checklistResult?: {
    fit: "ok" | "incomplete";
    passedCount: number;
    failedCount: number;
    /**
     * Set to true when the user accepted the checklist approval banner with
     * the "Override and continue" action. Surfaced by the UI as an "(overridden)"
     * badge so reviewers can see that the failing items were waived rather
     * than satisfied.
     */
    userOverridden?: boolean;
  };
}

export type PipelineMode = "auto" | "full" | "code-test" | "code-only";

export interface ApprovalResponse {
  approved: boolean;
  action: "approve" | "reject" | "revise" | "continue" | "redesign";
  feedback?: string;
}

export interface RuntimeTask extends Task {
  workspace?: string;
  baseBranch: string;
  branch: string;
  pipelineMode: PipelineMode;
  requireDesignApproval: boolean;
  /** Pause after REQUIREMENTS.md is written so the user can approve or revise before design/coding. */
  requireRequirementsApproval: boolean;
  /**
   * Resolved workspace directory after setupWorkspace() runs. Distinct from
   * `workspace` (the user-supplied path, which may be undefined for ephemeral
   * tasks). The artefacts endpoint reads files relative to this path; nothing
   * else does. Set by the orchestrator immediately after setupWorkspace.
   */
  workDir?: string;
  stages: StageStatus[];
}

class TaskStore {
  private tasks = new Map<string, RuntimeTask>();
  private emitter = new EventEmitter();
  private approvalResolvers = new Map<string, (response: ApprovalResponse) => void>();
  private abortControllers = new Map<string, AbortController>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  createTask(
    prompt: string,
    opts: {
      repo?: string;
      workspace?: string;
      baseBranch?: string;
      branch?: string;
      pipelineMode?: PipelineMode;
      requireApproval?: boolean;
      requireRequirementsApproval?: boolean;
    } = {},
  ): RuntimeTask {
    const now = new Date().toISOString();
    const id = uuid();
    const branch = opts.branch || `agent/${id.slice(0, 8)}`;
    const pipelineMode = opts.pipelineMode || "full";
    const task: RuntimeTask = {
      id,
      prompt,
      status: TaskStatus.Queued,
      repo: opts.repo,
      workspace: opts.workspace,
      baseBranch: opts.baseBranch || "main",
      branch,
      pipelineMode,
      requireDesignApproval: opts.requireApproval ?? false,
      requireRequirementsApproval: opts.requireRequirementsApproval ?? false,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [],
    };
    this.tasks.set(task.id, task);
    saveTaskHistory(task);
    this.emit(task.id, {
      taskId: task.id,
      type: "status_change",
      message: "Task created",
      data: { status: task.status, stages: task.stages },
      timestamp: now,
    });
    return task;
  }

  getTask(taskId: string): RuntimeTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Stamp the resolved workspace directory on the task so the artefacts
   * endpoint can serve files from it. Called by the orchestrator immediately
   * after setupWorkspace() returns. No-op when the task is unknown.
   */
  setWorkDir(taskId: string, workDir: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.workDir = workDir;
    task.updatedAt = new Date().toISOString();
  }

  setStages(taskId: string, stages: StageStatus[]): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.stages = stages;
    task.updatedAt = new Date().toISOString();
    this.emit(taskId, {
      taskId,
      type: "status_change",
      message: `Pipeline stages set: ${stages.map((s) => s.name).join(" → ")}`,
      data: { status: task.status, stages: task.stages },
      timestamp: task.updatedAt,
    });
  }

  updateTaskStatus(taskId: string, status: TaskStatus, error?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (error) task.error = error;
    saveTaskHistory(task);
    this.emit(taskId, {
      taskId,
      type: "status_change",
      message: `Task ${status}`,
      data: { status, error, stages: task.stages },
      timestamp: task.updatedAt,
    });
  }

  updateStage(
    taskId: string,
    stageName: string,
    update: Partial<StageStatus>,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const stage = task.stages.find((s) => s.name === stageName);
    if (!stage) return;
    Object.assign(stage, update);
    task.updatedAt = new Date().toISOString();
    saveTaskHistory(task);
    this.emit(taskId, {
      taskId,
      agent: stage.agent,
      type: update.status === "succeeded" || update.status === "failed"
        ? "result"
        : "log",
      message: `[${stage.agent}] Stage "${stageName}" ${update.status ?? "updated"}`,
      data: { stage: { ...stage }, stages: task.stages },
      timestamp: task.updatedAt,
    });
  }

  requestApproval(
    taskId: string,
    summary: string,
    extra?: Record<string, unknown>,
  ): Promise<ApprovalResponse> {
    this.emit(taskId, {
      taskId,
      type: "approval_required" as TaskStreamEvent["type"],
      message: summary,
      data: { summary, stages: this.tasks.get(taskId)?.stages, ...extra },
      timestamp: new Date().toISOString(),
    });

    return new Promise<ApprovalResponse>((resolve) => {
      this.approvalResolvers.set(taskId, resolve);
    });
  }

  resolveApproval(taskId: string, response: ApprovalResponse): void {
    const resolver = this.approvalResolvers.get(taskId);
    if (resolver) {
      resolver(response);
      this.approvalResolvers.delete(taskId);
    }
  }

  registerAbort(taskId: string, controller: AbortController): void {
    this.abortControllers.set(taskId, controller);
  }

  cancelTask(taskId: string): boolean {
    const controller = this.abortControllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    this.abortControllers.delete(taskId);

    const pending = this.approvalResolvers.get(taskId);
    if (pending) {
      pending({ approved: false, action: "reject" });
      this.approvalResolvers.delete(taskId);
    }

    this.updateTaskStatus(taskId, TaskStatus.Cancelled, "Cancelled by user");
    return true;
  }

  cleanupAbort(taskId: string): void {
    this.abortControllers.delete(taskId);
  }

  emit_log(taskId: string, message: string): void {
    this.emit(taskId, {
      taskId,
      type: "log",
      message,
      data: { stages: this.tasks.get(taskId)?.stages },
      timestamp: new Date().toISOString(),
    });
  }

  /** Emit a log event with optional overseer metadata for UI visualization. */
  emit_overseer_log(
    taskId: string,
    message: string,
    meta: {
      phase: "design-review" | "code-review" | "clarify" | "analyze" | "checklist";
      status: "running" | "done";
      result?: "ok" | "gaps" | "drift" | "incomplete";
    },
  ): void {
    const task = this.tasks.get(taskId);
    this.emit(taskId, {
      taskId,
      type: "log",
      message,
      data: {
        overseer: true,
        phase: meta.phase,
        status: meta.status,
        result: meta.result,
        stages: task?.stages,
      },
      timestamp: new Date().toISOString(),
    });
  }

  emitStageProgress(
    taskId: string,
    stageName: string,
    progress: { elapsedSeconds: number; filesEdited: number },
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const stage = task.stages.find((s) => s.name === stageName);
    if (!stage) return;
    this.emit(taskId, {
      taskId,
      agent: stage.agent,
      type: "stage_progress",
      message: `Stage "${stageName}" progress`,
      data: {
        stageName,
        elapsedSeconds: progress.elapsedSeconds,
        filesEdited: progress.filesEdited,
      },
      timestamp: new Date().toISOString(),
    });
  }

  subscribe(
    taskId: string,
    listener: (event: TaskStreamEvent) => void,
  ): () => void {
    const channel = `task:${taskId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  private emit(taskId: string, event: TaskStreamEvent): void {
    this.emitter.emit(`task:${taskId}`, event);
  }
}

export const taskStore = new TaskStore();
