# Architecture

## What this system is

**None of Them Knew They Were Robots** is a **local-first** harness: a small **Node (Express)** server orchestrates **multi-stage pipelines** by invoking the **Cursor Agent CLI** (`agent`) with per-stage prompts and a **git workspace**. A **static web UI** (`web/`) talks to the same server over HTTP and **Server-Sent Events (SSE)** for live progress. **BigBoss** (another skill-backed agent) plans routes and runs **Overseer**-style reviews.

Nothing in this repo replaces Cursor IDE; the server is a **driver** around the CLI and your disk.

## High-level component diagram

```text
┌─────────────┐     HTTP/SSE      ┌──────────────────────────────────────┐
│  Browser    │ ◄────────────────► │  Express (server/src/server.ts)      │
│  web/       │   voice-command,   │  REST + SSE + static web/            │
│  app.js     │   tasks/:id/*      └───────────────┬──────────────────────┘
└─────────────┘                                  │
                                                   │ runPipeline()
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  orchestrator.ts             │
                                    │  stage loop, gates, merge  │
                                    └───────┬──────────┬─────────┘
                                            │          │
              ┌─────────────────────────────┘          └────────────────────────────┐
              ▼                                                                     ▼
    ┌──────────────────┐                                                 ┌─────────────────┐
    │  agent-runner.ts │  spawn `agent`, build prompts, workspace prep   │  task-store.ts  │
    │  + skill-loader  │                                                 │  + log-store    │
    └────────┬─────────┘                                                 │  (SQLite SSE)   │
             │                                                           └─────────────────┘
             ▼
    ┌──────────────────┐
    │  Git workspace   │  REQUIREMENTS, DESIGN/spec/plan, TASKS, code…
    │  (clone or temp) │
    └──────────────────┘
```

## Repository layout (physical)

| Path | Role |
|------|------|
| `server/` | Express app, orchestration, artefact writers, tests (`server/test/`) |
| `web/` | Browser UI (HTML/CSS/JS); can be opened file:// with API URL configured |
| `skills/` | **Skill packs** — `system-prompt.md`, rules, MCP hints; `registry.yaml` lists agents |
| `packages/shared/` | Shared types, logging, transports used by server |
| `packages/openai-sprite-mcp/` | Stdio MCP server for DALL·E game sprites (LÖVE game-art stage) |
| `.cursor/plans/` | Historical design plans (informative, not the live contract) |
| `.cursor/rules/` | **Cursor IDE** project rules (`.mdc`): always-on conventions + globs for `server/`, `web/`, `skills/`, `docs/` |
| `.cursor/skills/` | **Cursor Agent Skills** versioned in-repo (e.g. merge-to-main release workflow, source-change branch/test/docs checklist) |
| `docs/` | This maintained technical narrative |

## Core server modules (logical)

| Module | Responsibility |
|--------|----------------|
| `server/src/server.ts` | HTTP routes: task create, approve, cancel, SSE stream, logs, **artefact fetch** |
| `server/src/orchestrator.ts` | **Single pipeline driver**: workspace setup, stage groups, merges, Overseer stage injection, approval waits |
| `server/src/agent-runner.ts` | **Run one agent**: prompt assembly, `agent` spawn, lint/build/Lua checks, context brief |
| `server/src/pipeline-stages.ts` | Declarative **stage lists** per mode/stack; `injectV2OverseerStages`, game-art injection |
| `server/src/bigboss-director.ts` | OpenAI-backed planning, merge fallbacks, Overseer JSON contracts, iteration caps |
| `server/src/task-store.ts` | In-memory tasks + **approval promise** resolvers; emits SSE-shaped events |
| `server/src/log-store.ts` | SQLite persistence for structured logs and task history |
| `server/src/skill-loader.ts` | Load pack metadata from `skills/<agent>/` |
| `server/src/cursor-session-registry.ts` | Optional **`agent create-chat`** + `--resume` per agent type |
| `server/src/*-artifact.ts` | Writers/mergers: requirements, constitution, spec, plan, tasks, checklists |
| `server/src/clarify-stage.ts` | Discrete design-review stage |
| `server/src/analyze-stage.ts` | Discrete code-review + drift fix-ups |
| `server/src/checklist-stage.ts` | `CHECKLISTS.md` review + one fix-up |
| `server/src/artefact-endpoint.ts` | Pure helper for **whitelisted** workspace file reads (UI + security) |

## Extension model (why skill packs)

**Adding a new specialist** is intentionally biased toward **data** (`skills/<type>/`) rather than **new TypeScript**:

- `skills/registry.yaml` declares the agent and category.
- The orchestrator resolves stages from BigBoss output + `AGENT_TYPE_TO_DEF` / parallel designer tables in `pipeline-stages.ts`.

**When you must touch TypeScript**: new **stage categories** (like `clarify` / `analyze`), new **gates**, or new **artefact types** require orchestrator and possibly UI changes. That is by design — the server remains the **trust boundary** for iteration limits, approvals, and file writes.

## Persistence and privacy

- **SQLite** (`server/data/logs.db` by convention — see README for path): task history and log rows for the UI / debugging.
- **Workspace** is the **source of truth** for code and markdown artefacts; the server does not mirror full file trees in the DB.

Treat **workspace paths** and **API exposure** as sensitive if you ever bind beyond localhost.

## Testing strategy

- Server tests use **Node’s built-in** `node:test` with `tsx` import (`server/package.json` `npm test`).
- Tests favour **pure helpers** and **noop branches** (no live OpenAI) for CI stability; see `server/test/*.test.ts` headers for scope.

## Related reading

- [`pipeline-and-artifacts.md`](pipeline-and-artifacts.md) — chronological behaviour and current artefact tree
- [`security-and-deployment.md`](security-and-deployment.md) — trust model and how to expose the API
- [`operations.md`](operations.md) — workflows, cost/latency levers, Cursor vs OpenAI
- [`decisions.md`](decisions.md) — why major forks (2.0 stack cut, spec-kit Tier 2, UI visibility PR) exist
