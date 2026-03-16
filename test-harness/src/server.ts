import * as path from "path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });

import express from "express";
import { taskStore } from "./local-task-store";
import { runPipeline } from "./local-orchestrator";

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const webRoot = path.resolve(__dirname, "..", "..", "client", "web");
app.use(express.static(webRoot));

// --- POST /voice-command ---
app.post("/voice-command", async (req, res) => {
  try {
    const { text, audioBase64, repo, workspace, baseBranch, branch, pipelineMode, requireApproval } = req.body;

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
        console.log(`[whisper] Transcribed: "${transcript}"`);
      } catch (err) {
        console.error("Whisper transcription failed:", err);
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
        console.warn("Intent parsing failed, using raw text:", err);
      }
    }

    const task = taskStore.createTask(prompt, { repo, workspace, baseBranch, branch, pipelineMode, requireApproval: !!requireApproval });

    runPipeline(task).catch((err) => {
      console.error(`Pipeline error for task ${task.id}:`, err);
    });

    res.status(201).json({
      taskId: task.id,
      status: task.status,
      transcript,
    });
  } catch (err) {
    console.error("Voice command error:", err);
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
  });
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
  console.log(`\n  MVP Test Harness running at http://localhost:${PORT}`);
  console.log(`  Serving UI from ${webRoot}`);
  console.log(`  OpenAI integration: ${hasKey ? "enabled (intent parsing + lightweight BigBoss)" : "disabled"}`);
  if (!hasKey) {
    console.log(`  → Copy .env.local.example to .env.local and add OPENAI_API_KEY to enable`);
  }
  console.log(`  Skills root: ${process.env.SKILLS_ROOT || path.resolve(__dirname, "..", "..", "skills")}`);
  console.log(`  Agent debug logs: ${path.join(require("os").tmpdir(), "agent-mvp-logs")}\n`);
});
