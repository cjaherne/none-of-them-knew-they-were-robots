import * as path from "path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });

import express from "express";
import { readArtefact } from "./artefact-endpoint";
import { createLogger, addGlobalTransport, setGlobalLogLevel, getGlobalLogLevel } from "@agents/shared";
import type { LogLevel, LogEntry } from "@agents/shared";
import { SqliteTransport, getLogs, getTaskHistory, getTaskById, getLogsForTask } from "./log-store";
import type { LogTransport } from "@agents/shared";
import { taskStore } from "./task-store";
import { runPipeline } from "./orchestrator";

addGlobalTransport(new SqliteTransport());
if (process.env.LOG_LEVEL) {
  setGlobalLogLevel(process.env.LOG_LEVEL.toUpperCase() as LogLevel);
}
const log = createLogger("server");

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const webRoot = path.resolve(__dirname, "..", "..", "web");
app.use(express.static(webRoot));

// --- POST /voice-command ---
app.post("/voice-command", async (req, res) => {
  try {
    const { text, audioBase64, repo, workspace, baseBranch, branch, pipelineMode, requireApproval, requireRequirementsApproval } = req.body;

    let prompt: string | undefined;
    let transcript: string | undefined;

    if (text && typeof text === "string") {
      prompt = text.trim();
    } else if (audioBase64 && typeof audioBase64 === "string") {
      if (!process.env.OPENAI_API_KEY) {
        res.status(400).json({ error: "Voice input requires OPENAI_API_KEY for Whisper transcription. Use the browser SpeechRecognition (Chrome/Edge) or add your key to .env.local." });
        return;
      }
      try {
        transcript = await transcribeWithWhisper(audioBase64);
        prompt = transcript;
        log.info(`Whisper transcribed: "${transcript}"`, undefined, "input");
      } catch (err) {
        log.error("Whisper transcription failed", { err: String(err) }, "error");
        res.status(500).json({ error: "Transcription failed. Check your OPENAI_API_KEY." });
        return;
      }
    }

    if (!prompt) {
      res.status(400).json({ error: "Provide a text field or audioBase64" });
      return;
    }

    if (process.env.OPENAI_API_KEY) {
      try {
        const parsed = await parseIntentWithOpenAI(prompt);
        prompt = parsed.prompt;
      } catch (err) {
        log.warn("Intent parsing failed, using raw text", { err: String(err) });
      }
    }

    const task = taskStore.createTask(prompt, {
      repo,
      workspace,
      baseBranch,
      branch,
      pipelineMode,
      requireApproval: !!requireApproval,
      requireRequirementsApproval: !!requireRequirementsApproval,
    });

    log.info(`Task received: ${prompt.slice(0, 120)}`, { taskId: task.id }, "input");

    runPipeline(task).catch((err) => {
      log.error(`Pipeline error for task ${task.id}`, { err: String(err), taskId: task.id }, "error");
    });

    res.status(201).json({
      taskId: task.id,
      status: task.status,
      transcript,
    });
  } catch (err) {
    log.error("Voice command error", { err: String(err) }, "error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- POST /tasks/:id/approve ---
app.post("/tasks/:id/approve", (req, res) => {
  const task = taskStore.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const { approved, action, feedback } = req.body;
  const response = {
    approved: approved !== false,
    action: action || (approved !== false ? "approve" : "reject"),
    feedback: feedback || undefined,
  };
  taskStore.resolveApproval(req.params.id, response);
  res.json({ ok: true, ...response });
});

// --- POST /tasks/:id/cancel ---
app.post("/tasks/:id/cancel", (_req, res) => {
  const cancelled = taskStore.cancelTask(_req.params.id);
  if (!cancelled) {
    res.status(404).json({ error: "Task not found or not cancellable" });
    return;
  }
  res.json({ ok: true, cancelled: true });
});

// --- GET /tasks/history (must be before :id param routes) ---
app.get("/tasks/history", (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
  res.json(getTaskHistory(limit, offset));
});

// --- GET /tasks/:id ---
app.get("/tasks/:id", (req, res) => {
  const task = taskStore.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(task);
});

// --- GET /tasks/:id/stream (SSE) ---
app.get("/tasks/:id/stream", (req, res) => {
  const task = taskStore.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send current state immediately
  res.write(
    `data: ${JSON.stringify({ type: "snapshot", task })}\n\n`,
  );

  if (!sseClients.has(task.id)) sseClients.set(task.id, new Set());
  sseClients.get(task.id)!.add(res);

  const unsubscribe = taskStore.subscribe(task.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    const terminal = event.data?.status === "completed"
      || event.data?.status === "failed"
      || event.data?.status === "cancelled";
    if (event.type === "status_change" && terminal) {
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    }
  });

  req.on("close", () => {
    unsubscribe();
    sseClients.get(task.id)?.delete(res);
  });
});

// --- SSE log broadcast transport ---
const sseClients = new Map<string, Set<express.Response>>();

class SseBroadcastTransport implements LogTransport {
  write(entry: LogEntry): void {
    if (!entry.taskId) return;
    const clients = sseClients.get(entry.taskId);
    if (!clients || clients.size === 0) return;
    const data = JSON.stringify({ type: "log_entry", ...entry });
    for (const res of clients) {
      try { res.write(`data: ${data}\n\n`); } catch { /* client gone */ }
    }
  }
}
addGlobalTransport(new SseBroadcastTransport());

// --- GET /logs ---
app.get("/logs", (req, res) => {
  const { taskId, level, category, limit, offset } = req.query;
  const rows = getLogs({
    taskId: taskId as string | undefined,
    level: level as LogLevel | undefined,
    category: category as any,
    limit: limit ? parseInt(limit as string, 10) : undefined,
    offset: offset ? parseInt(offset as string, 10) : undefined,
  });
  res.json(rows);
});

// --- GET /tasks/:id/artefacts/:file ---
// Serve a whitelisted markdown artefact from the task's resolved workspace.
// Pure file-resolution + whitelist + path-traversal logic lives in
// ./artefact-endpoint so it can be unit-tested without spinning up the
// server. Returns 404 when the file hasn't been written yet (common during
// early stages) so the UI can disable the tab.
app.get("/tasks/:id/artefacts/:file", (req, res) => {
  const { id, file } = req.params;
  const task = taskStore.getTask(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const result = readArtefact(task.workDir ?? "", file);
  if (!result.ok) {
    if (result.status >= 500) {
      log.error("Artefact read failed", { error: result.error, id, file }, "error");
    }
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.type("text/markdown; charset=utf-8").send(result.content);
});

// --- GET /tasks/:id/detail ---
app.get("/tasks/:id/detail", (req, res) => {
  const task = getTaskById(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const logs = getLogsForTask(req.params.id, {
    level: req.query.level as LogLevel | undefined,
    category: req.query.category as any,
  });
  res.json({ task, logs });
});

// --- POST /config/log-level ---
app.post("/config/log-level", (req, res) => {
  const { level } = req.body;
  const valid: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];
  if (!level || !valid.includes(level)) {
    res.status(400).json({ error: `Invalid level. Must be one of: ${valid.join(", ")}` });
    return;
  }
  setGlobalLogLevel(level);
  log.info(`Log level changed to ${level}`, undefined, "system");
  res.json({ ok: true, level });
});

// --- GET /config/log-level ---
app.get("/config/log-level", (_req, res) => {
  res.json({ level: getGlobalLogLevel() });
});

// --- Whisper transcription (requires OPENAI_API_KEY) ---
async function transcribeWithWhisper(base64Audio: string): Promise<string> {
  const { default: OpenAI, toFile } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const audioBuffer = Buffer.from(base64Audio, "base64");
  const file = await toFile(audioBuffer, "recording.webm", { type: "audio/webm" });

  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file,
    language: "en",
  });

  return response.text.trim();
}

// --- Intent parsing (optional, if OPENAI_API_KEY is set) ---
async function parseIntentWithOpenAI(
  rawText: string,
): Promise<{ prompt: string; repo: string }> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are an intent parser. Given a natural language command, extract a clean task prompt and optional repo name. Respond with JSON: { "prompt": "...", "repo": "current" }. Default repo to "current".`,
      },
      { role: "user", content: rawText },
    ],
    max_tokens: 256,
    temperature: 0.1,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from intent parser");
  return JSON.parse(content);
}

app.listen(PORT, () => {
  const hasKey = !!process.env.OPENAI_API_KEY;
  log.info(`MVP Test Harness running at http://localhost:${PORT}`, {
    webRoot,
    openai: hasKey ? "enabled" : "disabled",
    skillsRoot: process.env.SKILLS_ROOT || path.resolve(__dirname, "..", "..", "skills"),
  }, "system");
  if (!hasKey) {
    log.info("Copy .env.local.example to .env.local and add OPENAI_API_KEY to enable OpenAI", undefined, "system");
  }
});
