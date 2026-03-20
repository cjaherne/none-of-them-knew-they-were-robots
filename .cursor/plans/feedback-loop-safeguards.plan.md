# Plan: Feedback Loop Safeguards (No-Approval Mode)

## Overview

When design approval is turned off (`requireDesignApproval: false`), the pipeline currently **skips** the coding→design feedback loop entirely. The goal is to enable automatic feedback from coding back to design in this mode while avoiding infinite loops, using criteria-based limits first and iteration caps as fallback, with a final summary of unimplemented feedback.

## Current Behavior

| Mode | Design approval gate | Coding feedback loop |
|------|----------------------|----------------------|
| `requireDesignApproval: true` | User approves/rejects/revises after design | If `CODING_NOTES.md` exists, user chooses: continue or redesign |
| `requireDesignApproval: false` | Skipped; design auto-proceeds | **Never runs** — CODING_NOTES.md is ignored |

**Loop limits today:** `MAX_DESIGN_LOOPS = 2` (shared between design revisions and coding→design feedback). When exceeded, the pipeline continues without looping.

**Parallel stages:**
- **Design:** Multiple design agents run in parallel; outputs merged into `DESIGN.md` via `mergeDesignOutputs()`. Feedback is injected into **all** parallel design agents when looping back.
- **Coding:** Currently one agent per coding stage. Pipeline structure supports multiple agents per stage; multiple coding agents would each write to `CODING_NOTES.md` (last writer overwrites — needs merging strategy for multi-agent coding).

---

## Design Goals

1. **Enable feedback when approval is off** — Automatically feed `CODING_NOTES.md` back to design when `requireDesignApproval` is false, up to some limit.
2. **Criteria-based limiting** — Decide whether to loop based on feedback content (e.g. severity, type).
3. **Iteration cap fallback** — Always enforce a max number of feedback loops regardless of criteria.
4. **Unimplemented feedback summary** — When the cap is reached, produce a clear output listing what feedback was not addressed.

---

## Criteria-Based Feedback Filtering

### Feedback severity / type

`CODING_NOTES.md` has three sections (per coding agent preamble):

- **Deviations** — Where the coder diverged from design and why
- **Issues Found** — Problems in the design that should be flagged
- **Suggestions** — Improvements for future iterations

**Proposed criteria for looping:**

| Criterion | Loop? | Rationale |
|-----------|-------|-----------|
| **Issues Found** present (design bugs, contradictions, infeasible spec) | Yes | Design is wrong; worth revising |
| **Deviations** with explicit "design unclear/incomplete" | Yes | Design needs refinement |
| **Suggestions only** (no issues, no critical deviations) | No | Nice-to-haves; avoid churn |
| **Empty or trivial** (e.g. < 50 chars meaningful content) | No | Nothing substantive to act on |
| **Stability check** — feedback content highly similar to previous loop | No | Likely oscillating; stop |

### Implementation approach for criteria

1. **Parse `CODING_NOTES.md`** into sections (Deviations, Issues Found, Suggestions) via simple regex or structure-aware parsing.
2. **Classify** each section as "must address" vs "optional":
   - Issues Found → must address (loop if present)
   - Deviations that reference design gaps → must address
   - Suggestions only → optional (do not loop on this basis)
3. **Stability check:** Before looping, compare a fingerprint (e.g. first 500 chars of Issues+Deviations) to the previous loop’s feedback. If similarity > 80%, treat as "no progress" and do not loop again.
4. **Combine with iteration cap:** Loop only if (criteria say loop) **and** (iterations < max).

---

## Iteration Limits

| Limit | Value | Applies to |
|-------|-------|------------|
| `MAX_FEEDBACK_LOOPS` | 2 (configurable) | Total coding→design→coding cycles when approval is off |
| `MAX_DESIGN_LOOPS` | 2 | Design revision loops (user-triggered when approval is on) |

**Unified counter:** Use a single `feedbackLoops` (or `designFeedbackLoops`) counter that increments on each coding→design feedback cycle. Same cap applies whether approval is on or off. When approval is on, the user’s "redesign" decision also increments this counter.

**Recommendation:** Keep `MAX_DESIGN_LOOPS = 2` as the shared limit. Add `MAX_FEEDBACK_LOOPS_NO_APPROVAL` (default 2) for the no-approval path if we want different caps, or unify to one constant.

---

## Unimplemented Feedback Summary

When the loop limit is reached (or criteria say "don’t loop") but `CODING_NOTES.md` still contains feedback:

1. **Persist the final CODING_NOTES** — Already on disk; ensure it’s included in the stage notes for the coding stage.
2. **Emit a structured summary** — Add a log entry and/or stage metadata, e.g.:
   - `feedbackLimitReached: true`
   - `unaddressedFeedback: string` (full or truncated CODING_NOTES content)
   - Message: `"Feedback loop limit reached. Unaddressed coding feedback has been recorded in CODING_NOTES.md and in the coding stage notes."`
3. **Expose in UI** — Show a "Feedback not implemented" card in the event log / stage summary when `feedbackLimitReached` is true, with expandable content from `unaddressedFeedback`.
4. **Optional:** Append a section to `DESIGN.md` or create `FEEDBACK_NOT_IMPLEMENTED.md` with the summary so it’s visible in the workspace.

---

## Multi-Agent Considerations

### Parallel design agents

- **Current:** When looping back to design, `designFeedback` is appended to the prompt for **all** design agents in the parallel group.
- **No change needed** — Feedback is broadcast to every designer. Each sees the same coding notes. The merge step combines their revised outputs.

### Parallel coding agents (future)

- **Current:** Single coding agent writes `CODING_NOTES.md`. Last writer wins.
- **Future:** If multiple coding agents run in parallel, each could produce `CODING_NOTES_<agent>.md` or append to a shared file.
- **Proposed merge strategy:**
  1. After parallel coding, look for `CODING_NOTES.md` and `CODING_NOTES_<agent>.md` (e.g. `CODING_NOTES_coding.md` if we namespaced).
  2. If multiple exist, merge via concatenation (similar to `mergeDesignOutputs`) or OpenAI merge into a single `CODING_NOTES.md` before the feedback decision.
  3. Apply the same criteria and iteration logic to the merged notes.
  4. When summarizing "feedback not implemented", include which agents contributed.

---

## Implementation Checklist

### Phase 1: Enable feedback when approval is off

- [ ] Remove the `task.requireDesignApproval` gate around the coding feedback block in `orchestrator.ts` (lines ~831–862).
- [ ] Add a branch: if `requireDesignApproval` is true, keep current behavior (request user approval; on "redesign", loop). If false, use automatic criteria + iteration logic to decide whether to loop.

### Phase 2: Criteria-based filtering

- [ ] Add `parseCodingNotes(notes: string): { deviations, issuesFound, suggestions }` (or similar) in a small utility module.
- [ ] Add `shouldLoopOnFeedback(parsed, previousFeedbackFingerprint?): boolean` implementing the criteria above.
- [ ] Add optional `feedbackFingerprint` state to track the last loop’s feedback for stability check.
- [ ] Wire `shouldLoopOnFeedback` into the orchestrator’s feedback decision.

### Phase 3: Iteration cap and unimplemented summary

- [ ] Ensure `feedbackLoops` (or `designLoops`) is incremented and checked in the no-approval path.
- [ ] When cap is reached but notes exist: set `feedbackLimitReached`, persist `unaddressedFeedback` in stage notes, emit log.
- [ ] Update `StageStatus` type to include optional `feedbackLimitReached?: boolean` and `unaddressedFeedback?: string`.
- [ ] Update client UI to show "Feedback not implemented" when present.

### Phase 4: Multi-agent coding (when applicable)

- [ ] If parallel coding is added: implement `mergeCodingNotes(workDir, results)` analogous to `mergeDesignOutputs`.
- [ ] Call it before the feedback decision when the coding group has multiple agents.

---

## Configuration

Proposed task/pipeline options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `requireDesignApproval` | boolean | false | Whether to pause for user approval after design (and for coding feedback when notes exist) |
| `maxFeedbackLoops` | number | 2 | Max coding→design feedback cycles (both approval and no-approval paths) |
| `feedbackCriteriaStrict` | boolean | false | If true, only loop when "Issues Found" present; if false, also loop on significant Deviations |

---

## File Edits Summary

| File | Changes |
|------|---------|
| `server/src/orchestrator.ts` | Ungate coding feedback when approval off; add criteria + iteration logic; emit unimplemented summary |
| `server/src/task-store.ts` | Extend `StageStatus` with `feedbackLimitReached`, `unaddressedFeedback` |
| `packages/shared/src/types.ts` | Add `feedbackLimitReached`, `unaddressedFeedback` to stage type if shared |
| `server/src/feedback-criteria.ts` (new) | `parseCodingNotes`, `shouldLoopOnFeedback` |
| `web/app.js` | Render "Feedback not implemented" card when stage has `feedbackLimitReached` |
| `skills/coding/` (optional) | Consider adding `## Severity` or structured markers to CODING_NOTES for easier parsing |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Criteria too strict — never loop when we should | Start permissive: loop on any non-trivial Issues or Deviations. Tune based on real runs. |
| Criteria too loose — loop too often | Stability check (fingerprint similarity) stops oscillation. Iteration cap is hard stop. |
| Parsing CODING_NOTES fails (unexpected format) | Fallback: if parse fails, treat as "has content" and use iteration cap only. Or default to no loop when uncertain. |
| User expects approval UI when approval is off | Clarify in UI/docs: "No approval" = automatic feedback up to limit, then continue. |
