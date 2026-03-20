/**
 * Stdio MCP server: DALL-E 3 image generation → PNG file under pipeline workspace.
 * argv[2] = absolute workspace root. OPENAI_API_KEY from environment.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const DALLE3_SIZES = ["1024x1024", "1792x1024", "1024x1792"] as const;

function resolveSafeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, relativePath);
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`relativePath escapes workspace: ${relativePath}`);
  }
  return candidate;
}

async function writePngFromDallE3(
  prompt: string,
  size: (typeof DALLE3_SIZES)[number],
  outPath: string,
): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || "dall-e-3";

  const body = {
    model,
    prompt,
    n: 1,
    size,
    response_format: "b64_json" as const,
    quality: "standard" as const,
  };

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI images API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string }>;
    error?: { message?: string };
  };
  if (json.error?.message) {
    throw new Error(json.error.message);
  }
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("No b64_json in OpenAI response");
  }

  const buf = Buffer.from(b64, "base64");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
}

const workspaceRoot = process.argv[2];
if (!workspaceRoot) {
  console.error("openai-sprite-mcp: missing workspace root argv[2]");
  process.exit(1);
}

const server = new McpServer({
  name: "openai-sprite-mcp",
  version: "0.1.0",
});

server.registerTool(
  "generate_sprite",
  {
    title: "Generate sprite (DALL-E 3)",
    description:
      "Generate a PNG via OpenAI DALL-E 3 and save it under the pipeline workspace. " +
      "Use pixel-art style in the prompt; output is typically 1024px — scale in LÖVE. " +
      "Paths are relative to workspace root (e.g. assets/sprites/mole.png).",
    inputSchema: {
      relativePath: z.string().describe("Repo-relative path for the .png file"),
      prompt: z.string().describe("Image prompt (include pixel art / game sprite cues)"),
      size: z.enum(DALLE3_SIZES).optional().describe("DALL-E 3 size; default 1024x1024"),
    },
  },
  async ({ relativePath, prompt, size }) => {
    try {
      const outPath = resolveSafeWorkspacePath(workspaceRoot, relativePath);
      if (!relativePath.toLowerCase().endsWith(".png")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "relativePath should end with .png",
            },
          ],
          isError: true,
        };
      }
      const sz = size ?? "1024x1024";
      await writePngFromDallE3(prompt, sz, outPath);
      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${outPath} (${sz}, ${modelLabel()})`,
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  },
);

function modelLabel(): string {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || "dall-e-3";
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
