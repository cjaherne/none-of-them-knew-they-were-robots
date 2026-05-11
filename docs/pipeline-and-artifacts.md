# Pipeline and artefacts

This document describes **what runs, in what order**, and **which files** appear on disk. For **why** v2 exists and how it differs from GitHub’s spec-kit CLI, see [`decisions.md`](decisions.md).

## Task lifecycle (API + UI)

1. **Create task** — `POST /voice-command` (or equivalent from UI) creates a `RuntimeTask` in `task-store` and calls `runPipeline(task)` **without awaiting** (fire-and-forget from the HTTP handler’s perspective).
2. **Stream** — UI opens `GET /tasks/:id/stream` (SSE). Events include snapshots, `status_change`, `approval_required`, `log` / structured log data, stage progress, etc.
3. **Approve** — `POST /tasks/:id/approve` resolves a pending `requestApproval()` promise with `{ approved, action, feedback }`.
4. **Cancel** — `POST /tasks/:id/cancel` aborts the pipeline `AbortController` and fails pending approvals.

The orchestrator is written as a **single async loop** over **stage groups** (see `groupStages` in `pipeline-stages.ts`): parallel design is one group; sequential stages are one stage per group.

## Pipeline modes (`PipelineMode`)

BigBoss can narrow the graph in `auto` mode; the UI also exposes **full**, **code-test**, **code-only**. Mode affects which `StageDefinition[]` you start from (`stagesForMode`).

## Stacks: `web` vs `love`

- **Web stack** — parallel **ux-designer**, **core-code-designer**, **graphics-designer**; coding **coding**; validation **testing**.
- **LÖVE stack** — parallel **game-designer**, **love-architect**, **love-ux**; coding **lua-coding**; validation **love-testing**.

Stack is inferred from BigBoss’s chosen agents (`inferStackFromAgents`). **Game-art** (`game-art` agent) is **injected after design** for LÖVE when OpenAI image tooling is available — see `injectPostDesignGameArt`.

## Artefact schema: v1 vs v2 (`ARTEFACT_SCHEMA`)

| | **v1** (`ARTEFACT_SCHEMA=v1`) | **v2** (default since 2.7) |
|---|------------------------------|----------------------------|
| Design output | Merged **`DESIGN.md`** (+ per-agent files under `.pipeline/`) | Same merge **plus** merged **`spec.md`** / **`plan.md`** (and optional research/data-model/contracts) |
| Overseer | **Inline** post-design and post-coding review inside the orchestrator loop | **Discrete stages** **`clarify`**, **`analyze`**, **`checklist`** injected after design merge / after coding / after analyze respectively |
| Task list | Optional / not central | **`TASKS.md`** generated after design merge for coding agents |
| Quality checklist | LÖVE-only env `LOVE_SMOKE_CHECKLIST` | Stack-agnostic **`CHECKLISTS.md`** + **`checklist`** stage; `LOVE_SMOKE_CHECKLIST` deprecated under v2 |
| Governance | Ad hoc | **`constitution.md`** prepended to every agent prompt (optional bootstrap via `CONSTITUTION_BOOTSTRAP`) |

Implementation gate: `server/src/artefact-schema.ts` — only explicit `v1` opts out; everything else is treated as **v2**.

## v2 stage injection (`injectV2OverseerStages`)

When v2 is active, the orchestrator inserts:

1. **`clarify`** — immediately **after the last design stage** in the flattened plan (after merge + `TASKS.md` / checklist generation for parallel design paths).
2. **`analyze`** — after the **last coding** stage (before validation in typical full pipelines).
3. **`checklist`** — **after `analyze`**, before validation.

**Invariant** (tested in `server/test/pipeline-stages.test.ts`): `clarify` sits after design; `analyze` then `checklist` stay adjacent in that order.

## Human-in-the-loop gates (current)

| Gate | Trigger | UI `approvalType` | Notes |
|------|---------|-------------------|--------|
| Requirements | Optional `requireRequirementsApproval` after `REQUIREMENTS.md` | `requirements` | Revise appends user notes |
| Design | Optional `requireDesignApproval` after merged / single design | `design` | Runs **after** `clarify` in v2 so users see clarifications first |
| Coding feedback | Design approval on + `CODING_NOTES.md` conditions | `feedback` | Continue vs redesign |
| Checklist blocking | `CHECKLIST_BLOCKING=1` + checklist still failing after fix-up | `checklist` | Override (audit note in `CHECKLISTS.md`), re-analyze (capped rewind), or cancel |

## Workspace files (v2 mental checklist)

| File | Produced by | Consumed by |
|------|-------------|-------------|
| `REQUIREMENTS.md` | Requirements extraction | Designers, Overseer, TASKS/checklists |
| `constitution.md` | User-provided or bootstrap | All agents (prompt prepend) |
| `DESIGN.md` | Parallel design merge | Legacy prompts, fallbacks |
| `spec.md` | Per-designer `*-spec.md` merge + **clarify** append | Agents, checklist, UI artefact tab |
| `plan.md` | Per-designer `*-plan.md` merge | Agents, checklist |
| `TASKS.md` | Generator post-design | Coding agents |
| `CHECKLISTS.md` | Generator post-design | **checklist** stage; UI |
| `.pipeline/*` | Each agent | Merge inputs |

## UI coupling (post 2.8)

- **`GET /tasks/:id/artefacts/:file`** — whitelist only (see `server/src/artefact-endpoint.ts`); UI sub-tabs must stay in sync.
- **`task.workDir`** — set after `setupWorkspace()` so the artefact endpoint resolves paths; not used for v1-only flows beyond “missing = 404”.

## Bounded loops (safety)

Several caps prevent runaway cost:

- `MAX_OVERSEER_DESIGN_ITERATIONS`, `MAX_OVERSEER_CODE_ITERATIONS` — in `bigboss-director.ts`
- `MAX_CHECKLIST_FIX_ITERATIONS` — checklist fix-up passes
- `MAX_LOVE_TEST_FIX_ITERATIONS` — LÖVE validation retries
- `MAX_CHECKLIST_REANALYZE_REWINDS` — user-driven **re-analyze** from checklist banner (orchestrator constant)

**Why**: LLM + agent minutes are expensive; unbounded loops are a product bug.

## Release stage

When a git remote workflow applies, a **release** agent stage can run merge-to-main style steps (documented in `skills/release/system-prompt.md` and aligned with `.cursor/skills/merge-to-main`).

## Related reading

- Root [`README.md`](../README.md) — mermaid pipeline diagram and env table
- [`architecture.md`](architecture.md) — module map
- [`security-and-deployment.md`](security-and-deployment.md) — exposing the server beyond localhost
- [`operations.md`](operations.md) — cost/latency and operator workflows
- [`decisions.md`](decisions.md) — rationale for v2 and UI surfacing
