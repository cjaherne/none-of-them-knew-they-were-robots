# Decision log

This file records **significant architectural and product decisions** in a lightweight format. Each entry is meant to be **short enough to maintain** but **rich enough** that a new contributor understands constraints without archaeology.

**Status key:** `Accepted` (current truth), `Superseded` (replaced — pointer to newer entry), `Proposed` (not yet implemented)

**Companion docs:** [`security-and-deployment.md`](security-and-deployment.md) (how to expose the server safely), [`operations.md`](operations.md) (workflows and cost drivers).

---

## D-013 — Cursor project rules + skills live beside the harness

**Status:** Accepted  
**Context:** Contributors use **Cursor IDE** on this repo; behaviour-only guidance in chat is easy to forget. The harness already ships **skill packs** under `skills/` for the **CLI agent** — a different surface from IDE rules and IDE-local skills.  
**Decision:** Add **`.cursor/rules/*.mdc`** (scoped globs + one always-on rule for repo-wide tone and pointers) and **`.cursor/skills/`** for versioned workflows (**merge-to-main**, **source-change-workflow**). Keep the long-form narrative under **`docs/`** per [`docs/README.md`](README.md).  
**Consequences:** Changing release steps still requires **merge-to-main** skill, `skills/release/system-prompt.md`, and `agent-runner.ts` `PREAMBLE_RELEASE` to stay aligned (existing parity rule). New server tests must still be listed in `server/package.json`’s `test` script (called out in `server-typescript` rule).  
**Alternatives considered:** Personal-only rules in `~/.cursor` (rejected: not shared with clones); documenting everything in README only (rejected: splits onboarding vs depth).

---

## D-012 — Document security/deployment and day-to-day operations separately from README

**Status:** Accepted  
**Context:** Quick-start README should stay short; operators still need a **canonical** place for trust boundaries, LAN vs localhost posture, and how voice/text and OpenAI vs Cursor affect cost.  
**Decision:** Add [`security-and-deployment.md`](security-and-deployment.md) and [`operations.md`](operations.md); link them from [`docs/README.md`](README.md); keep [`decisions.md`](decisions.md) as the single ADR-style file for now.  
**Consequences:** README gains only a pointer to `docs/` (already present under Development); deeper material lives in two focused pages that must be updated when HTTP surface or cost-relevant defaults change.  
**Alternatives considered:** Inline long security sections in README (rejected: duplicates and rots); one mega `docs/operations.md` only (rejected: security deserves its own scan path for reviewers).

---

## D-001 — Local harness, not a hosted multi-tenant product

**Status:** Accepted  
**Context:** Earlier versions of the broader product vision included cloud deployment; **2.0** removed AWS CDK, Kubernetes, Go operator, and container runtime from *this* repo.  
**Decision:** Treat the repo as a **single-user / team-local** orchestrator: Node + web UI + Cursor CLI + git workspace.  
**Consequences:** No built-in auth model, tenancy, or quota enforcement. If you expose the server beyond localhost, you own network ACLs and trust boundaries.  
**Alternatives considered:** Keep cloud control plane in-tree (rejected: operational burden vs. your actual usage).

---

## D-002 — Cursor Agent CLI as the execution engine

**Status:** Accepted  
**Context:** Specialists need file access, MCP tools, and model routing consistent with Cursor’s agent product.  
**Decision:** Spawn **`agent`** per stage with composed prompts rather than embedding a separate agent framework.  
**Consequences:** Requires Cursor CLI on PATH; upgrades to Cursor can change flags/behaviour — `CURSOR_AGENT_MODEL`, `CURSOR_AGENT_SESSIONS` exist to absorb friction.  
**Alternatives considered:** Direct OpenAI-only coding (rejected: loses repo-aware tooling and parity with how you work in IDE).

---

## D-003 — Skill packs as the primary extension surface

**Status:** Accepted  
**Context:** Adding specialists should not require fork-the-server for every new persona.  
**Decision:** `skills/<agent>/` directories + `registry.yaml`; server loads prompts/constraints from disk (`SKILLS_ROOT` override).  
**Consequences:** New **behavioural** stages (new categories, gates, artefact types) still need TypeScript changes; new **personalities** mostly do not.  
**Alternatives considered:** Hard-code all prompts in TS (rejected: merge pain, slower iteration on copy).

---

## D-004 — Parallel design merge, then single blueprint

**Status:** Accepted (artefact paths updated in **D-014**)  
**Context:** Multiple designers run concurrently for speed and separation of concerns.  
**Decision:** Each writes `.pipeline/<agent>-spec.md` and `.pipeline/<agent>-plan.md`; orchestrator merges to root **`spec.md`** and **`plan.md`**.  
**Consequences:** Merge quality is a bottleneck; Overseer gaps can trigger **partial reruns** (`gapsByAgent`) when the gap set is a strict subset of designers.  
**Alternatives considered:** Strictly sequential design (rejected: slower, weaker separation).

---

## D-005 — SQLite logs + SSE for observability

**Status:** Accepted  
**Context:** You need a durable timeline for debugging and a live view in the browser.  
**Decision:** `log-store` writes structured rows; `task-store` emits in-memory events; SSE fans out to connected clients.  
**Consequences:** Single-node memory model for active tasks; restarting the server loses in-flight task state unless you add persistence for tasks (not current design).  
**Alternatives considered:** File-only logs (rejected: harder to query for UI history).

---

## D-006 — Web vs LÖVE pipeline separation

**Status:** Accepted  
**Context:** Web UX/design prompts are poor fits for Lua game architecture and vice versa.  
**Decision:** Distinct parallel designer sets and agents per **stack**; BigBoss chooses stack from task + repo signals.  
**Consequences:** More registry entries and stage tables; less accidental “fix web prompt, break LÖVE”.  
**Alternatives considered:** One mega-designer (rejected: prompt dilution).

---

## D-007 — Cherry-pick spec-kit *concepts*, not the spec-kit CLI product

**Status:** Accepted (env-flag gating removed in **D-014**)  
**Context:** GitHub's [spec-kit](https://github.com/github/spec-kit) is Python-first, interactive, and opinionated for greenfield repos. This project is already a **voice + multi-agent pipeline** with different UX.  
**Decision:** Adopt **artefact shape** (`spec.md`, `plan.md`, `tasks`, checklists, constitution) and **named review phases** as **first-class pipeline stages**, implemented in TypeScript.  
**Consequences:** No drop-in `specify` CLI workflow; documentation must speak in **this** repo's terms. Tiered PRs (PR1 writers → PR2 clarify/analyze → PR3 checklist → PR4 default → PR5 UI) managed rollout risk.  
**Alternatives considered:** Vendor spec-kit wholesale (rejected in assessment: mismatched runtime and UX); ignore spec-kit entirely (rejected: useful shared vocabulary with collaborators).

---

## D-008 — v2 default with explicit v1 escape hatch

**Status:** Superseded by **D-014** (v3.0.0)  
**Context (historical):** Shipping v2 behind a flag forever split the community and test matrix.  
**Decision (historical):** **`ARTEFACT_SCHEMA` unset ⇒ v2**; only explicit **`v1`** opted out (case-insensitive). Accepted in release **2.7.0**.  
**Outcome:** The v1 escape hatch was retired wholesale in v3.0.0 (D-014); the env flag, the merged `DESIGN.md` surface, and the per-agent `<agent>-design.md` write are gone.  
**Alternatives considered (historical):** v2 opt-in forever (rejected: invisible wins); hard remove v1 immediately (rejected at the time: too harsh for one release).

---

## D-009 — Checklist stage: advisory by default, blocking optional

**Status:** Accepted  
**Context:** Failing a whole pipeline on subjective checklist items can be cruel when models hallucinate misses.  
**Decision:** Default **advisory** checklist; **`CHECKLIST_BLOCKING=1`** escalates to failure **after** one automated fix-up, then (as of **2.8.0**) a **human approval** path instead of a silent dead-end.  
**Consequences:** CI/dev environments should choose explicitly whether blocking is on.  
**Alternatives considered:** Always blocking (rejected: too brittle); never blocking (rejected: no teeth when quality bar must be enforced).

---

## D-010 — Whitelisted artefact HTTP reads

**Status:** Accepted (since **2.8.0**)  
**Context:** The UI needs markdown previews without turning the server into arbitrary file download of the whole disk.  
**Decision:** `GET /tasks/:id/artefacts/:file` allows only a **fixed set** of root-level markdown filenames; path traversal guarded in `artefact-endpoint.ts`.  
**Consequences:** New artefact types need **whitelist + UI tab list** updates together.  
**Alternatives considered:** Let UI read workspace via separate file:// (rejected: browser security); unauthenticated full workspace zip (rejected: unsafe).

---

## D-011 — Cap “re-analyze” from checklist blocking at one rewind

**Status:** Accepted  
**Context:** Allowing unlimited rewinds creates **analyze → checklist → analyze** loops that burn time/money on stubborn checklist rows.  
**Decision:** `MAX_CHECKLIST_REANALYZE_REWINDS = 1` in orchestrator; UI disables re-analyze when exhausted.  
**Consequences:** User must **override** or **cancel** after one extra analyze pass.  
**Alternatives considered:** Unlimited rewinds (rejected); zero rewinds (rejected: too little recovery).

---

## D-014 — Retire v1 artefact schema and merged `DESIGN.md`

**Status:** Accepted (since release **3.0.0**) — supersedes **D-008**  
**Context:** D-008 kept the v1 single-`DESIGN.md` flow as a one-release escape hatch behind `ARTEFACT_SCHEMA=v1`. The flag survived two releases unchanged. The dual-write contract (per-agent `<agent>-design.md` plus per-artefact `<agent>-spec.md` / `<agent>-plan.md`) and the v1 inline Overseer code paths (`overseerPostDesignReview`, `overseerPostCodeReview`, `LOVE_SMOKE_CHECKLIST`) were a constant drag on prompts, tests, and onboarding — every designer skill pack carried a fallback paragraph, every reader had to mentally diff v1 against v2, and the test matrix was twice as wide as the live runtime needed.  
**Decision:** Remove the v1 surface wholesale in **v3.0.0**:  
- Delete the `ARTEFACT_SCHEMA` env flag, the `artefact-schema.ts` module, and the `LOVE_SMOKE_CHECKLIST` env path.  
- Stop writing per-agent `.pipeline/<agent>-design.md`; designers contribute only `-spec.md` / `-plan.md`.  
- Stop merging to root `DESIGN.md`; the workspace's root artefact tree is `spec.md` / `plan.md` / `TASKS.md` / `CHECKLISTS.md` / `constitution.md` + `REQUIREMENTS.md`.  
- Remove the `Design (v1)` tab from the Artefacts panel; `GET /tasks/:id/artefacts/DESIGN.md` returns **400**.  
- Make `injectV2OverseerStages` and `runV2ArtefactWriters` unconditional (no env gate).  
- Delete the inline post-design / post-coding Overseer code blocks and their helpers (`overseerPostDesignReview`, `overseerPostCodeReview`, `mergeDesignOutputs`, `runLoveSmokeChecklistOpenAI`, `prependOriginalTaskToDesign`, `ensureDesignReferencesRequirements`, `writeDesignCompatShim` stub).  
- Realign `skills/coding/system-prompt.md` expertise to this repo's stack (TypeScript / Node / Express / React, `node:test`, MCP, SQLite, SSE).  
**Consequences:** **Breaking** for any external client GET-ing `DESIGN.md` or pipeline workspaces that depended on `<agent>-design.md` on disk. Acceptable for a major bump. Internal benefits: one prompt path, one artefact tree, half the test matrix, no flag gymnastics in skill packs.  
**Alternatives considered:** Keep the v1 escape hatch indefinitely (rejected: ongoing prompt drift, doubled review surface); hard-delete v1 without a major bump (rejected: violates SemVer); maintain a `DESIGN.md = spec.md + plan.md` compatibility shim (rejected: reintroduces dead code we just removed and gives external clients a quiet excuse to ignore the cut).

---

## How to add a new entry

Copy this template to the **top** of the file (newest first) or append to bottom if you prefer chronological — just stay consistent:

```markdown
## D-0NN — Short title

**Status:** Accepted | Superseded by D-0MM | Proposed  
**Context:** …  
**Decision:** …  
**Consequences:** …  
**Alternatives considered:** …  
```

If an ADR explodes in length, split to `docs/adr/D-0NN-title.md` and leave a one-line pointer here.
