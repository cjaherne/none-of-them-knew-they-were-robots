# None of Them Knew They Were Robots

A voice-controlled multi-agent AI design and development team: a **web UI**, a **Node.js server** (Express) that orchestrates pipelines, and the **Cursor Agent CLI** (`agent`) for headless runs.

**Version 2.0 (major)** — AWS CDK, Kubernetes/Helm, the Go operator, and container-based agent runtime were **removed** from this repo. The supported stack is **this server + web UI** only. If you depended on in-tree cloud deployment from the 1.x line, stay on the latest **1.x** tag (e.g. **v1.4.3**) or maintain a fork.

**Version 2.1** — Repository layout was renamed for clarity: the Node backend is **`server/`** (package `@agents/server`), and the browser assets live in **`web/`** at the repo root. Scripts or docs that still reference `test-harness/` or `client/web/` should be updated.

## Overview

Speak or type a task, and specialist agents — designers, coders, testers — collaborate via Cursor CLI to complete it. New agent types are added mostly through **skill packs** under `skills/`, not by changing the server core.

### Agent team

| Category | Agents | Role | MCP Tools |
|----------|--------|------|-----------|
| **Analysis / Overseer** | BigBoss | Plans pipelines; Overseer reviews (design fit + code drift) | Filesystem, GitHub, Fetch, Sequential Thinking |
| **Design** | UX Designer | Flows, wireframes, a11y, game UI | Filesystem, Playwright, Fetch |
| **Design** | Core Code Designer | Architecture, APIs, Lua modules | Filesystem, GitHub, Fetch |
| **Design** | Graphics Designer | Tokens, game art briefs | Filesystem, Fetch |
| **Design** | Game Designer | Mechanics, controls, Lua/LÖVE structure | Filesystem, Fetch, Sequential Thinking |
| **Coding** | Coding / Lua coding | Implementation from specs | Filesystem, GitHub, Fetch |
| **Validation** | Testing Agent | Tests, E2E, Lua/busted | Filesystem, Playwright, Fetch |
| **Release** | Release Agent | README, SemVer, tags, PR | Filesystem, GitHub |

BigBoss selects stage agents, runs the Overseer after design merge and after coding, and can trigger focused re-runs. The **Release** agent runs at the end of a successful pipeline when a repo is configured.

### Architecture

The **same Node process** serves the REST API, **Server-Sent Events** for live task streams, and **static files** for the web UI (`web/`).

```
Browser  --HTTP-->  Express (API + SSE + static web/)
                         |
                         v
              orchestrator (pipeline driver)
                         |
         +---------------+---------------+
         v               v               v
  bigboss-director   agent-runner    task-store / logs
  (plan, summarize,   (Cursor CLI      (SQLite + SSE)
   Overseer reviews)  per specialist)
```

**BigBoss in code:** [`server/src/bigboss-director.ts`](server/src/bigboss-director.ts) centralises planning (OpenAI + CLI fallback), human-facing summaries, and Overseer design/code reviews (CLI + API fallback). It prepends the canonical persona from [`skills/bigboss/system-prompt.md`](skills/bigboss/system-prompt.md) to those calls. [`server/src/agent-runner.ts`](server/src/agent-runner.ts) prepends the same file for BigBoss overseer CLI runs and passes `--resume <chatId>` when a session id is set. [`server/src/cursor-session-registry.ts`](server/src/cursor-session-registry.ts) lazily runs `agent create-chat` per `(taskId, agentType)` (see `CURSOR_AGENT_SESSIONS`). Stage definitions live in [`server/src/pipeline-stages.ts`](server/src/pipeline-stages.ts); [`server/src/orchestrator.ts`](server/src/orchestrator.ts) runs the pipeline loop and specialist stages.

Skill packs are read from `skills/` on disk (`SKILLS_ROOT` overrides the path).

## Project structure

```
├── server/                 Node server (Express, SQLite, orchestration)
├── web/                    Browser UI (HTML/JS/CSS; served by server)
├── packages/shared/        Shared types, logging, safety helpers
└── skills/                 Agent skill packs + registry.yaml
```

## Prerequisites

- Node.js 20+
- Cursor Agent CLI (`agent`) on your PATH
- Git
- (Optional) `OPENAI_API_KEY` — BigBoss routing, Whisper when the browser has no SpeechRecognition, summaries, merge/overseer fallbacks

## Quick start (recommended)

From the repository root:

```bash
npm install
cd server
cp .env.local.example .env.local   # optional keys
npx tsx src/server.ts
```

Open **http://localhost:3000** — the UI loads from the server; no separate static host is required.

## Alternate: UI only, remote API URL

You can open `web/index.html` directly (or serve the `web/` folder elsewhere). In the sidebar under **Server**, set **API URL** to your server origin (e.g. `http://localhost:3000`).

## Usage

- **Sidebar** — command, project (workspace, repo, branches, pipeline mode), voice, design approval, **Server** (API URL), logging level.
- **Live / History** — current run vs past tasks and logs.
- **Voice** — browser SpeechRecognition where available; otherwise server-side Whisper if configured.

Human-in-the-loop: design approval, coding feedback loops, pipeline cancel. See in-app behaviour for iteration limits and summaries.

Structured logs and task history use SQLite at **`server/data/logs.db`**. Notable routes: `GET /logs`, `GET /tasks/history`, `GET /tasks/:id/detail`, `POST /config/log-level`. Debug file logs use the system temp directory under **`agents-robots-logs`**.

## Adding a new agent type

1. Add a directory under `skills/<agent-type>/` with `system-prompt.md`, `constraints.json`, `mcp-config.json`, optional `tools.json` and `rules/`.
2. Register the agent in `skills/registry.yaml`.
3. Restart or rely on disk reads — the server loads packs from `skills/` (or `SKILLS_ROOT`).

## How it works

The server loads skill packs, prepares the workspace (clone optional), writes Cursor rules and MCP config, builds prompts, runs `cursor-agent` (or `CURSOR_CLI`), validates output, and commits/pushes when a repo is configured.

## Development

```bash
npm run build

# Dev server with reload
cd server && npm run dev

# Type-check
npx tsc --noEmit -p packages/shared/tsconfig.json
npx tsc --noEmit -p server/tsconfig.json
```

The `web/` package has a simple `npm run dev` (static serve) if you want to iterate on assets against a running API.

### Environment variables (`server/.env.local`)

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENAI_API_KEY` | Routing, Whisper, summaries, merge/overseer fallbacks | Optional |
| `PORT` | Listen port (default `3000`) | Optional |
| `SKILLS_ROOT` | Override skills directory | Optional |
| `CURSOR_CLI` | Override Cursor agent binary | Optional |
| `CURSOR_AGENT_MODEL` | Model for Cursor CLI (default `auto`) | Optional |
| `CURSOR_AGENT_SESSIONS` | `off` — no resume; `bigboss` — only BigBoss CLI uses `--resume` (default if unset and `BIGBOSS_PERSIST_CLI` not `0`); `all` — each specialist `agentType` gets its own lazy chat per pipeline | Optional |
| `BIGBOSS_PERSIST_CLI` | If `0` and `CURSOR_AGENT_SESSIONS` unset, same as `CURSOR_AGENT_SESSIONS=off` (legacy) | Optional |
| `BIGBOSS_MODEL` | OpenAI model for planning (default `gpt-4o-mini`) | Optional |
| `MERGE_MODEL` | Design merge model (defaults to `BIGBOSS_MODEL`) | Optional |

## Licence

Apache 2.0
