---
name: source-change-workflow
description: >-
  Enforces feature-branch work, unit tests (add/update, run, pass), and correct
  doc placement (root README vs docs/) for application source changes. Use when
  editing server/, packages/, orchestration/pipeline logic, shared libraries, or
  any non-trivial source change; when implementing features or fixes; or when
  the user asks for this workflow by name.
disable-model-invocation: false
---

# Source change workflow

Use this workflow **before finishing** any substantive change to application source (not design-only notes under [`.cursor/plans/`](../../../.cursor/plans/)). For shipping a finished branch to `main`, use the separate [merge-to-main](../merge-to-main/SKILL.md) skill (version bump, build, PR, tag).

## 1. Branch discipline

1. Run `git branch --show-current` (and `git status` if useful).
2. If the current branch is **`main`**: stop and create or switch to a feature branch (`feat/…`, `fix/…`, or team convention) **before** applying edits.
3. **Exception:** If the user **explicitly** requested a hotfix or direct commit on `main`, document that in the summary and skip the branch switch.
4. Keep the branch scoped to one coherent change set when practical.

## 2. Unit tests

1. After code changes, run **`npm test`** from the **repository root** ([`package.json`](../../../package.json) runs tests across workspaces with `--if-present`).
2. Fix failures and re-run until the suite passes. Do not treat the task as complete while tests are red.
3. **Server** ([`server/src/`](../../../server/src/)): add or extend tests under [`server/test/`](../../../server/test/) using the same runner as [`server/package.json`](../../../server/package.json) (`node --import tsx --test` with explicit test files). Mirror patterns in existing tests (e.g. [`server/test/artefact-endpoint.test.ts`](../../../server/test/artefact-endpoint.test.ts)).
4. **Workspaces without a `test` script** (e.g. [`web/package.json`](../../../web/package.json) today): still run root `npm test`. Prefer adding a **minimal** harness if the change is easy to cover; otherwise state briefly **why** automated tests are not applicable yet (do not add heavy frontend test infra unless the user asks).

## 3. Documentation — what goes where

Match the maintainer split in [`docs/README.md`](../../../docs/README.md). Prefer **links to source paths** over large pasted blocks.

| Kind of change | Update |
|----------------|--------|
| Onboarding, quick start, high-level product overview, user-visible version bullets | Root [`README.md`](../../../README.md) |
| Repo layout, runtime components, data stores, extension model | [`docs/architecture.md`](../../../docs/architecture.md) |
| Pipeline stages, v1/v2 artefacts, approvals, UI/API behaviour | [`docs/pipeline-and-artifacts.md`](../../../docs/pipeline-and-artifacts.md) |
| Deployment shapes, trust/threat model, HTTP surface | [`docs/security-and-deployment.md`](../../../docs/security-and-deployment.md) |
| Day-2 ops, cost/latency levers, keeping documentation in sync | [`docs/operations.md`](../../../docs/operations.md) |
| Trade-offs or reversals of prior assumptions (even one short paragraph) | [`docs/decisions.md`](../../../docs/decisions.md) |

Treat `.cursor/plans/` as **design-time** notes; when behaviour is normative for contributors, reflect it in `docs/` (and README if user-facing).

## 4. Task completion checklist

- [ ] Not on `main` without an explicit user exception
- [ ] Tests added or updated where the harness supports it; rationale noted if not
- [ ] `npm test` at repo root passes
- [ ] [`README.md`](../../../README.md) updated if setup, behaviour, or user-facing story changed
- [ ] Correct [`docs/*.md`](../../../docs/) file(s) updated per the table above
