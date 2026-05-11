# Operations

Practical notes for **day-to-day use**: how work typically flows through the harness, what drives **cost and latency**, and where **Cursor** vs **OpenAI** fit. Tone stays technical; nothing here is legal advice.

## Cursor IDE in this repository (not the pipeline CLI)

This repo ships **Cursor project rules** under [`.cursor/rules/`](../.cursor/rules/) and **Cursor Agent Skills** under [`.cursor/skills/`](../.cursor/skills/). They complement the runtime **skill packs** under `skills/` (loaded by `server/src/skill-loader.ts` for `agent` runs).

| Location | Purpose |
|----------|---------|
| `.cursor/rules/*.mdc` | Persistent IDE hints: branch/docs pointers, server test conventions, web vs server artefact whitelist sync, release parity when editing `skills/release/`. |
| `.cursor/skills/*/SKILL.md` | Named workflows (e.g. **merge-to-main** for release; **source-change-workflow** for feature branch + `npm test` + doc placement). |

Treat updates to **merge-to-main** behaviour as three-way: the skill file, [`skills/release/system-prompt.md`](../skills/release/system-prompt.md), and `PREAMBLE_RELEASE` in [`server/src/agent-runner.ts`](../server/src/agent-runner.ts).

## Typical workflows

### Text-first

1. Set **workspace / repo / branches** in the sidebar (when not using ephemeral temp workspace).
2. Type the task in **Command**, choose **pipeline mode**, toggle approvals as needed.
3. Watch **Live** tab: stages, logs, overseer lines; use **Artefacts** tab (v2) to read `spec.md` / `plan.md` / `TASKS.md` / `CHECKLISTS.md` as they land.
4. Respond to **approval banners** when requirements/design/feedback/checklist-blocking gates fire.

**Why it is default-friendly:** no browser permissions, reproducible transcripts in logs.

### Voice-first

1. Prefer **browser SpeechRecognition** where the browser supports it (see root README).
2. If unavailable, **Whisper** on the server requires `OPENAI_API_KEY` — audio is sent to OpenAI for transcription.

**Trade-off:** voice is faster for the operator but adds a **privacy and cost** path (audio upload) compared to local speech APIs.

### Remote UI against a running API

- Same as text-first, but set **API URL** in the sidebar (README “Alternate: UI only”).
- Re-read [`security-and-deployment.md`](security-and-deployment.md) before using this across a network.

## Cost and usage model (two wallets)

Costs split into **things this repo meters in UI** vs **things it does not**.

### 1 — OpenAI API (optional but common)

Used for (non-exhaustive; see `server/src` and env docs):

- BigBoss **planning / routing / summaries** when API path is taken
- **Design merge** fallbacks, Overseer-style reviews, checklist passes, requirements extraction, optional Whisper
- **Game-art** image generation when enabled

**What the project shows you:** per-stage **estimated cost** aggregates in the web UI when token usage is parsed from agent output — useful for **relative** comparison, not a financial guarantee.

**How to control spend:** tighten pipeline modes (`code-only` skips design), reduce approval loops, lower `CHECKLIST_BLOCKING` strictness during exploration, unset keys for dry UI-only tests (orchestrator paths that skip OpenAI will noop or use CLI fallbacks where coded).

### 2 — Cursor Agent CLI (`agent`)

Each specialist stage runs the **Cursor Agent** with your local CLI installation. **Metering, plan limits, and model availability** are defined by **Cursor for your account**, not by this repository.

**Operational implications:**

- **Model slugs:** use `agent models` on your machine; configure `CURSOR_AGENT_MODEL` when `auto` misbehaves (documented in `server/.env.local.example`).
- **Session resume:** `CURSOR_AGENT_SESSIONS` trades **extra context** (fewer repeated explanations) for **longer-lived chats** and potentially higher cumulative usage — tune deliberately.
- **Failures after Cursor upgrades:** flags and JSON output formats can change; pin or document working CLI versions for your team if CI stability matters.

This repo **does not** implement billing, seat management, or org-wide usage dashboards for Cursor.

## Latency levers (what makes pipelines feel slow)

- **Number of stages** — full + parallel design + v2 clarify/analyze/checklist + validation is intentionally thorough.
- **Agent round-trips** — each stage is a fresh `agent` invocation unless resumed via session registry.
- **OpenAI calls** — BigBoss, merge, overseer, checklist, optional image passes add wall-clock even when agents are fast.
- **Git operations** — clone/fetch/checkout in `setupWorkspace` on cold workspaces.

## Logs and debugging

- **SQLite** stores structured history — good for “what happened at 14:32”.
- **SSE** is live-only; reconnect behaviour is browser-dependent.
- **`LOG_LEVEL`** — see server env example; noisy DEBUG in shared environments can grow SQLite quickly.

## Keeping `docs/` honest

When you change **defaults** (e.g. new gate, new endpoint), update in one sweep:

1. Root **README** if user-facing quick start changes
2. **`docs/pipeline-and-artifacts.md`** if stage order or gates change
3. **`docs/security-and-deployment.md`** if trust boundary or HTTP surface changes
4. **`docs/operations.md`** if cost drivers or operator workflow shifts
5. **`docs/decisions.md`** when the change reflects a deliberate trade-off

## Related reading

- [`security-and-deployment.md`](security-and-deployment.md) — exposure and trust model
- [`pipeline-and-artifacts.md`](pipeline-and-artifacts.md) — stages and bounded loops
- [`decisions.md`](decisions.md) — why defaults exist
