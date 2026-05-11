# Technical documentation

This folder is the **long-form companion** to the root [`README.md`](../README.md). The README stays optimised for **onboarding and quick start**; here we keep **structure, behaviour, and rationale** so you (and future collaborators) can answer “how does this work?” and “why did we build it this way?” without reverse-engineering the whole tree.

## Who this is for

| Reader | Use this for |
|--------|----------------|
| **You (maintainer)** | Mental model of orchestration, artefact flow, env flags, extension points |
| **Contributors** | Where to change behaviour safely, what invariants exist, what tests cover |
| **Future you** | Recovering intent months later — especially around spec-kit Tier 2 and pipeline gates |

## How to keep this up to date

1. **When you merge a meaningful feature** — add or adjust a short entry in [`decisions.md`](decisions.md) if the change reflects a new trade-off or reverses an old assumption (even one paragraph beats nothing).
2. **When pipeline stages or artefacts change** — update [`pipeline-and-artifacts.md`](pipeline-and-artifacts.md) and the diagram references there.
3. **When you add a major module or split responsibilities** — touch [`architecture.md`](architecture.md).
4. **When you add IDE-wide conventions** — update [`.cursor/rules/`](../.cursor/rules/) (and, for agent-invoked workflows, [`.cursor/skills/`](../.cursor/skills/)); if the change affects how humans work in the repo, add a pointer here or in [`operations.md`](operations.md) rather than duplicating long prose in the root README.
5. **Prefer links to source** over pasting large blocks of code; line numbers drift, file paths stay stable.

Historical planning material (not normative for behaviour) may still live under [`.cursor/plans/`](../.cursor/plans/) — treat those as **design-time notes**; this `docs/` folder is the **maintained narrative**.

## Contents

| Document | Focus |
|----------|--------|
| [`architecture.md`](architecture.md) | Repo layout, runtime components, data stores, extension model |
| [`pipeline-and-artifacts.md`](pipeline-and-artifacts.md) | End-to-end task flow, v1 vs v2 artefacts, stages, approvals, UI/API |
| [`security-and-deployment.md`](security-and-deployment.md) | Canonical deployment shapes (local / remote UI / internet), trust model, HTTP surface, data sensitivity |
| [`operations.md`](operations.md) | Text vs voice workflows, OpenAI vs Cursor cost drivers, latency levers, keeping docs in sync |
| [`decisions.md`](decisions.md) | Decision log: context, options, what we chose, consequences |

## Gaps and questions (fill in over time)

Use this section as a scratchpad for **intentional TODOs** in the docs themselves (not product bugs):

- [x] **Deployment model** — see [`security-and-deployment.md`](security-and-deployment.md) (shapes A–C).
- [x] **Threat model** — same file (practical threat table + CORS / no-auth notes).

If you want a stricter process later, you can split `decisions.md` into individual ADR files (`docs/adr/0001-…md`) without changing the substance.
