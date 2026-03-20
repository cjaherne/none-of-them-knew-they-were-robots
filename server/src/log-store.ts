import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import type { LogEntry, LogLevel, LogCategory } from "@agents/shared";
import type { LogTransport } from "@agents/shared";
import type { RuntimeTask } from "./task-store";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "logs.db");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  ensureDir(DATA_DIR);
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      pipeline_mode TEXT,
      workspace TEXT,
      stages_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_history_created ON task_history(created_at);

    CREATE TABLE IF NOT EXISTS log_entries (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      category TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_entries_task_ts ON log_entries(task_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries(level, timestamp);
  `);
  return _db;
}

// -- SqliteTransport (plugs into the shared Logger) --

export class SqliteTransport implements LogTransport {
  write(entry: LogEntry): void {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO log_entries (id, task_id, timestamp, level, source, message, metadata_json, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.taskId ?? null,
      entry.timestamp,
      entry.level,
      entry.source,
      entry.message,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.category ?? null,
    );
  }
}

// -- Task history persistence --

export function saveTaskHistory(task: RuntimeTask): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_history (id, prompt, status, pipeline_mode, workspace, stages_json, created_at, updated_at, completed_at, result_summary, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      stages_json = excluded.stages_json,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      result_summary = excluded.result_summary,
      error = excluded.error
  `).run(
    task.id,
    task.prompt,
    task.status,
    task.pipelineMode ?? null,
    task.workspace ?? null,
    task.stages ? JSON.stringify(task.stages) : null,
    task.createdAt,
    task.updatedAt,
    null,
    task.resultSummary ?? null,
    task.error ?? null,
  );
}

// -- Query functions --

export interface TaskHistoryRow {
  id: string;
  prompt: string;
  status: string;
  pipeline_mode: string | null;
  workspace: string | null;
  stages_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_summary: string | null;
  error: string | null;
}

export function getTaskHistory(limit = 50, offset = 0): TaskHistoryRow[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM task_history ORDER BY created_at DESC LIMIT ? OFFSET ?",
  ).all(limit, offset) as TaskHistoryRow[];
}

export function getTaskById(taskId: string): TaskHistoryRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM task_history WHERE id = ?").get(taskId) as TaskHistoryRow | undefined;
}

export interface LogEntryRow {
  id: string;
  task_id: string | null;
  timestamp: string;
  level: string;
  source: string;
  message: string;
  metadata_json: string | null;
  category: string | null;
}

export function getLogsForTask(
  taskId: string,
  opts: { level?: LogLevel; category?: LogCategory; limit?: number; offset?: number } = {},
): LogEntryRow[] {
  const db = getDb();
  const conditions = ["task_id = ?"];
  const params: unknown[] = [taskId];

  if (opts.level) {
    conditions.push("level = ?");
    params.push(opts.level);
  }
  if (opts.category) {
    conditions.push("category = ?");
    params.push(opts.category);
  }

  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  return db.prepare(
    `SELECT * FROM log_entries WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
  ).all(...params) as LogEntryRow[];
}

export function getLogs(
  opts: { taskId?: string; level?: LogLevel; category?: LogCategory; limit?: number; offset?: number } = {},
): LogEntryRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.taskId) {
    conditions.push("task_id = ?");
    params.push(opts.taskId);
  }
  if (opts.level) {
    conditions.push("level = ?");
    params.push(opts.level);
  }
  if (opts.category) {
    conditions.push("category = ?");
    params.push(opts.category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  return db.prepare(
    `SELECT * FROM log_entries ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
  ).all(...params) as LogEntryRow[];
}
