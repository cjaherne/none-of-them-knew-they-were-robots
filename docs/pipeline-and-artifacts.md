# Pipeline and artefacts

This document describes **what runs, in what order**, and **which files** appear on disk. For the historical context of the artefact schema and how it differs from GitHub's spec-kit CLI, see [`decisions.md`](decisions.md) (D-007, D-008 superseded by D-014).

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

## Artefact schema

Designers contribute per-artefact `.pipeline/<agent>-spec.md` (what + why) and `.pipeline/<agent>-plan.md` (how / architecture). The orchestrator merges those contributions into the workspace's root `spec.md` and `plan.md`. `TASKS.md` is generated after the merge (BigBoss extracts task ids + file paths from `spec.md` + `plan.md` + `REQUIREMENTS.md` when `OPENAI_API_KEY` is set, otherwise a stage-derived skeleton is written). `CHECKLISTS.md` is generated alongside as a stack-agnostic quality bar.

| Concern | Where it lives |
|---------|----------------|
| What + why (user-facing scope, acceptance, original task) | **`spec.md`** |
| How (architecture, file layout, data models, dependencies) | **`plan.md`** |
| Executable task list with file paths + `R#` requirement links | **`TASKS.md`** |
| Acceptance + smoke + governance checklist | **`CHECKLISTS.md`** |
| Numbered requirements traceability | **`REQUIREMENTS.md`** |
| Project governance prepended to every agent prompt | **`constitution.md`** |

The legacy single-`DESIGN.md` flow and the `ARTEFACT_SCHEMA` / `LOVE_SMOKE_CHECKLIST` env flags were retired in v3.0 — see [`decisions.md`](decisions.md) **D-014**.

## Overseer stage injection (`injectV2OverseerStages`)

The orchestrator always inserts:

1. **`clarify`** — immediately **after the last design stage** in the flattened plan (after merge + `TASKS.md` / checklist generation for parallel design paths).
2. **`analyze`** — after the **last coding** stage (before validation in typical full pipelines).
3. **`checklist`** — **after `analyze`**, before validation.

**Invariant** (tested in `server/test/pipeline-stages.test.ts`): `clarify` sits after design; `analyze` then `checklist` stay adjacent in that order. The helper is unconditional — there is no longer an env-flag gate.

## Human-in-the-loop gates (current)

| Gate | Trigger | UI `approvalType` | Notes |
|------|---------|-------------------|--------|
| Requirements | Optional `requireRequirementsApproval` after `REQUIREMENTS.md` | `requirements` | Revise appends user notes |
| Design | Optional `requireDesignApproval` after merged / single design | `design` | Runs **after** `clarify` so users see clarifications first |
| Coding feedback | Design approval on + `CODING_NOTES.md` conditions | `feedback` | Continue vs redesign |
| Checklist blocking | `CHECKLIST_BLOCKING=1` + checklist still failing after fix-up | `checklist` | Override (audit note in `CHECKLISTS.md`), re-analyze (capped rewind), or cancel |

## Workspace files (mental checklist)

| File | Produced by | Consumed by |
|------|-------------|-------------|
| `REQUIREMENTS.md` | Requirements extraction | Designers, Overseer, TASKS/checklists |
| `constitution.md` | User-provided or bootstrap | All agents (prompt prepend) |
| `spec.md` | Per-designer `*-spec.md` merge + **clarify** append | Agents, checklist, UI artefact tab |
| `plan.md` | Per-designer `*-plan.md` merge | Agents, checklist |
| `TASKS.md` | Generator post-design | Coding agents |
| `CHECKLISTS.md` | Generator post-design | **checklist** stage; UI |
| `.pipeline/<agent>-spec.md`, `.pipeline/<agent>-plan.md`, `.pipeline/*.handoff.md` | Each agent | Merge inputs and downstream handoffs |

## UI coupling

- **`GET /tasks/:id/artefacts/:file`** — whitelist only (see `server/src/artefact-endpoint.ts`); UI sub-tabs must stay in sync.
- **`task.workDir`** — set after `setupWorkspace()` so the artefact endpoint resolves paths.

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
- [`decisions.md`](decisions.md) — rationale for the artefact schema and UI surfacing
