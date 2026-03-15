import { spawn, ChildProcess } from "child_process";
import { CursorStreamEvent } from "./types";

export interface CursorRunOptions {
  prompt: string;
  workDir: string;
  flags: string[];
  cursorApiKey: string;
  timeoutMs: number;
  onEvent?: (event: CursorStreamEvent) => void;
}

export interface CursorRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  events: CursorStreamEvent[];
}

export async function runCursor(options: CursorRunOptions): Promise<CursorRunResult> {
  const {
    prompt,
    workDir,
    flags,
    cursorApiKey,
    timeoutMs,
    onEvent,
  } = options;

  const args = ["-p", ...flags, prompt];

  return new Promise((resolve, reject) => {
    const proc = spawn("cursor-agent", args, {
      cwd: workDir,
      env: {
        ...process.env,
        CURSOR_API_KEY: cursorApiKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const events: CursorStreamEvent[] = [];
    let buffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;

      // Parse stream-json events (newline-delimited JSON)
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event: CursorStreamEvent = JSON.parse(trimmed);
          events.push(event);
          onEvent?.(event);
        } catch {
          // Non-JSON output, treat as log line
          const logEvent: CursorStreamEvent = { type: "log", content: trimmed };
          events.push(logEvent);
          onEvent?.(logEvent);
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Cursor CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        events,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
