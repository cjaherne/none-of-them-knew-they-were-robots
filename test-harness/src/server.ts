import express from "express";
import * as path from "path";
import { taskStore } from "./local-task-store";
import { runPipeline } from "./local-orchestrator";

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = express();

app.use(express.json());
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
    const { text, repo, workspace, baseBranch, branch } = req.body;

    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Provide a text field" });
      return;
    }

    let prompt = text.trim();

    if (process.env.OPENAI_API_KEY) {
      try {
        const parsed = await parseIntentWithOpenAI(prompt);
        prompt = parsed.prompt;
      } catch (err) {
        console.warn("Intent parsing failed, using raw text:", err);
      }
    }

    const task = taskStore.createTask(prompt, { repo, workspace, baseBranch, branch });

    // Run pipeline asynchronously -- don't await
    runPipeline(task).catch((err) => {
      console.error(`Pipeline error for task ${task.id}:`, err);
    });

    res.status(201).json({
      taskId: task.id,
      status: task.status,
    });
  } catch (err) {
    console.error("Voice command error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
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

    if (
      event.type === "status_change" &&
      (event.data?.status === "completed" || event.data?.status === "failed")
    ) {
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    }
  });

  req.on("close", () => {
    unsubscribe();
  });
});

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
  console.log(`\n  MVP Test Harness running at http://localhost:${PORT}`);
  console.log(`  Serving UI from ${webRoot}`);
  console.log(
    `  Intent parsing: ${process.env.OPENAI_API_KEY ? "enabled" : "disabled (set OPENAI_API_KEY to enable)"}`,
  );
  console.log(`  Skills root: ${process.env.SKILLS_ROOT || path.resolve(__dirname, "..", "..", "skills")}`);
  console.log(`  Agent debug logs: ${path.join(require("os").tmpdir(), "agent-mvp-logs")}\n`);
});
