# None of Them Knew They Were Robots

A voice-controlled multi-agent AI design and development team that runs **locally** via the test harness and **Cursor Agent CLI** (`agent`).

**Version 2.0 (major)** — AWS CDK, Kubernetes/Helm, the Go operator, and container-based agent runtime have been **removed** from this repo. The supported stack is the local test harness and browser UI only. If you depended on in-tree cloud deployment from the 1.x line, stay on the latest **1.x** tag (e.g. **v1.4.3**) or maintain a fork.

## Overview

Speak or type a task, and a team of specialist AI agents — designers, coders, testers — collaborate via Cursor CLI headless to complete it. The system is built on an extensible framework: adding a new agent type is mostly configuration (skill packs under `skills/`), not new orchestration code.

### Agent team

Agents are organised into categories that define their pipeline position:

| Category | Agents | Role | MCP Tools |
|----------|--------|------|-----------|
| **Analysis / Overseer** | BigBoss | Plans agent pipelines; runs Overseer reviews (design fit + code drift) | Filesystem, GitHub, Fetch, Sequential Thinking |
| **Design** | UX Designer | User flows, wireframes, accessibility, game UI (menus, HUD, split-screen) | Filesystem, Playwright, Fetch |
| **Design** | Core Code Designer | Architecture, data models, API contracts, Lua module architecture | Filesystem, GitHub, Fetch |
| **Design** | Graphics Designer | Color palettes, typography, CSS tokens, game art briefs (sprites, palettes, animations) | Filesystem, Fetch |
| **Design** | Game Designer | Game mechanics, controls (keyboard + gamepad), game loop, Lua/LÖVE2D structure | Filesystem, Fetch, Sequential Thinking |
| **Coding** | Coding Agent | Implements code (TypeScript, Python, web) from design specs | Filesystem, GitHub |
| **Coding** | Lua Coding Agent | Implements Lua and LÖVE2D games from design specs | Filesystem, GitHub, Fetch, Sequential Thinking |
| **Validation** | Testing Agent | Unit tests, integration tests, E2E, Lua/busted | Filesystem, Playwright, Fetch |
| **Release** | Release Agent | Updates README, bumps SemVer, commits, creates and pushes version tag, creates PR | Filesystem, GitHub |

BigBoss uses a full stage/agent structure to select which designers and coders run (e.g. for Lua games: Game Designer + Lua Coding Agent; for web UI: UX + Graphics + Core Code Designer). BigBoss also acts as an **Overseer**: after design merge it runs a full agent-based design review; after coding it runs a code review. If gaps or drift are found, the Overseer triggers up to 2 re-runs of the affected stage with focused feedback.

MCP capabilities: Fetch is available to all design agents, Lua Coding, Testing, and BigBoss. Sequential Thinking is available to Game Designer, Lua Coding, and BigBoss. New specialist agents can be added by creating a skill pack directory and a registry entry. The **Release** agent runs automatically at the end of every successful pipeline when a repo is configured.

### Architecture (local)

```
Browser UI (client/web)  --HTTP/SSE-->  test-harness (Express)
                                              |
                                              v
                                    Cursor Agent CLI (per stage)
                                              |
                                              v
                                    Workspace + git (optional)
```

Skill packs are read from the `skills/` directory on disk (see `SKILLS_ROOT` in environment variables).

## Project structure

```
├── packages/
│   └── shared/             Types, safety rules, logging helpers
├── skills/                 Agent skill packs + registry
├── test-harness/           Local server (Express + SQLite + orchestration)
└── client/web/             Browser UI (talks to the test harness)
```

## Prerequisites

- Node.js 20+
- The Cursor Agent CLI (`agent`) installed locally
- Git
- (Optional) An OpenAI API key — enables lightweight BigBoss routing, Whisper transcription when the browser has no SpeechRecognition, and AI-powered design/feedback summaries. Without it, BigBoss falls back to the full agent CLI and voice may rely on the browser.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Run the test harness

```bash
cd test-harness
cp .env.local.example .env.local   # optional: add OPENAI_API_KEY
npm install
npx tsx src/server.ts
```

### 3. Open the UI

Open `client/web/index.html` in a browser, or serve the `client/web` folder. In the sidebar, set **Test harness → API URL** to your server (default `http://localhost:3000` if the UI is opened from the same machine).

## Usage

The UI includes a responsive layout: desktop uses a sidebar (command + config) and a main panel (pipeline, approval, event log); on narrow viewports the sidebar collapses and can be toggled from Settings. Use **Live** / **History** for the current run versus past tasks and log timelines.

Configure in the sidebar:

- **Workspace** — local directory where the agent will create files (e.g. `C:\dev\my-project`)
- **Repo** — GitHub repo URL (optional, for clone + push)
- **Base branch** / **Work branch** — branch to fork from and name for the new branch
- **Pipeline mode** — Auto (BigBoss decides), Full, Code+Test, or Code Only
- **Voice** — spoken status updates and design approval announcements
- **Require design approval** — pause after the design stage for human review
- **Log level** — DEBUG, INFO, WARN, or ERROR (default INFO)

### Voice input

Click the microphone to speak. In Chrome/Edge, the browser’s SpeechRecognition transcribes in real time. Elsewhere, audio can be sent to the server for Whisper transcription if `OPENAI_API_KEY` is set.

### Interactive pipeline

- **Design approval** — after design output, BigBoss summarises and you can approve, request changes, or reject.
- **Coding feedback** — if the coder writes `CODING_NOTES.md`, BigBoss summarises; behaviour depends on **Require design approval** and iteration limits (see in-app behaviour).
- **Pipeline cancellation** — Stop aborts the running agent and cancels the pipeline.

### Context passing, parallel design, Overseer

Design agents receive rich codebase context (file tree, git history, key files). Coders read full `DESIGN.md` from disk. A **codebase summary cache** (`.pipeline/context-cache.json`) avoids re-analysing unchanged files. BigBoss can fan out parallel designers; merges use agent-based merge first, then API fallback, then concatenation. The Overseer runs after design merge and after coding with optional automatic re-runs.

**Task decomposition** and **execution verification** (e.g. `npm run build`, Lua checks) are described in the orchestrator; set `LOVE_RUNTIME_VERIFY=1` for optional LÖVE runtime checks.

Structured logging and task history use SQLite (`test-harness/data/logs.db`). Endpoints include `GET /logs`, `GET /tasks/history`, `GET /tasks/:id/detail`, and `POST /config/log-level`.

## Adding a new agent type

No orchestration code changes are required for a new specialist:

### 1. Create a skill pack

```
skills/my-agent/
├── system-prompt.md
├── constraints.json
├── mcp-config.json
├── tools.json          # optional
└── rules/
    ├── role.md
    ├── output-format.md
    ├── examples.md
    └── checklist.md    # optional
```

### 2. Register in `skills/registry.yaml`

Add an entry under `agents:` with `type`, `displayName`, `category`, `skillPack`, and `cursorFlags` as needed.

### 3. Use it

The local orchestrator discovers skill packs from `skills/` (or `SKILLS_ROOT`). BigBoss can include the new `type` in pipeline plans when appropriate.

## How it works

| Layer | Purpose |
|-------|---------|
| **System prompt** | Persona and task framing |
| **Cursor rules** | Injected under `.cursor/rules/` |
| **MCP servers** | Per-agent tools (GitHub, Playwright, etc.) |
| **Constraints** | Guardrails and retries |
| **Cursor CLI** | Headless runs with streamed JSON output |

The test harness loads each skill pack from disk, prepares the workspace (clone optional), writes rules and MCP config, builds the prompt, runs `cursor-agent` (or your `CURSOR_CLI`), validates output, and commits/pushes when a repo is configured.

## Development

```bash
npm run build

# Local server
cd test-harness && npx tsx src/server.ts

# Type-check
npx tsc --noEmit -p packages/shared/tsconfig.json
npx tsc --noEmit -p test-harness/tsconfig.json
```

### Local environment variables

Copy `test-harness/.env.local.example` to `test-harness/.env.local`.

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENAI_API_KEY` | BigBoss routing, Whisper, summaries, merge/overseer API fallbacks | Optional |
| `PORT` | Server port (default 3000) | Optional |
| `SKILLS_ROOT` | Override skills directory | Optional |
| `CURSOR_CLI` | Override Cursor agent binary | Optional |
| `CURSOR_AGENT_MODEL` | Model for Cursor CLI (default `auto`) | Optional |
| `BIGBOSS_MODEL` | OpenAI model for planning/summaries (default `gpt-4o-mini`) | Optional |
| `MERGE_MODEL` | OpenAI model for design merge (default same as `BIGBOSS_MODEL`) | Optional |

## Licence

Apache 2.0
