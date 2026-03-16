import { EventEmitter } from "events";
import { v4 as uuid } from "uuid";
import { TaskStatus } from "@agents/shared";
import type { Task, TaskStreamEvent } from "@agents/shared";

export interface StageStatus {
  name: string;
  agent: string;
  status: "pending" | "running" | "succeeded" | "failed";
  startedAt?: string;
  completedAt?: string;
  filesModified?: string[];
  errors?: string[];
  durationMs?: number;
}

export interface MvpTask extends Task {
  workspace?: string;
  baseBranch: string;
  branch: string;
  stages: StageStatus[];
}

class TaskStore {
  private tasks = new Map<string, MvpTask>();
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  createTask(
    prompt: string,
    opts: { repo?: string; workspace?: string; baseBranch?: string; branch?: string } = {},
  ): MvpTask {
    const now = new Date().toISOString();
    const id = uuid();
    const branch = opts.branch || `agent/${id.slice(0, 8)}`;
    const task: MvpTask = {
      id,
      prompt,
      status: TaskStatus.Queued,
      repo: opts.repo,
      workspace: opts.workspace,
      baseBranch: opts.baseBranch || "main",
      branch,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [
        { name: "design", agent: "core-code-designer", status: "pending" },
        { name: "coding", agent: "coding", status: "pending" },
        { name: "validation", agent: "testing", status: "pending" },
      ],
    };
    this.tasks.set(task.id, task);
    this.emit(task.id, {
      taskId: task.id,
      type: "status_change",
      message: "Task created",
      data: { status: task.status, stages: task.stages },
      timestamp: now,
    });
    return task;
  }

  getTask(taskId: string): MvpTask | undefined {
    return this.tasks.get(taskId);
  }

  updateTaskStatus(taskId: string, status: TaskStatus, error?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (error) task.error = error;
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
