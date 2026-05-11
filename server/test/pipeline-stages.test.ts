/**
 * Unit tests for src/pipeline-stages.ts — focused on injectV2OverseerStages,
 * the helper that splices clarify/analyze/checklist into the stage list. The
 * helper is called unconditionally by the orchestrator. The contract demands:
 *   - Idempotence (calling twice is a no-op).
 *   - No mutation of input.
 *   - Insertion only when corresponding upstream/downstream categories exist
 *     (no clarify without design; no analyze/checklist without coding).
 *   - Strict relative order: design → clarify → coding → analyze → checklist.
 *
 * These are the load-bearing invariants the orchestrator dispatch loop relies
 * on. A regression here silently breaks pipelines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  injectV2OverseerStages,
  FULL_STAGES_WEB,
  FULL_STAGES_LOVE,
  type StageDefinition,
} from "../src/pipeline-stages";

test("injectV2OverseerStages: web full pipeline gets clarify/analyze/checklist in order", () => {
  const result = injectV2OverseerStages(FULL_STAGES_WEB);
  assert.deepEqual(
    result.map((s) => s.category),
    ["design", "clarify", "coding", "analyze", "checklist", "validation"],
  );
});

test("injectV2OverseerStages: love full pipeline same shape", () => {
  const result = injectV2OverseerStages(FULL_STAGES_LOVE);
  assert.deepEqual(
    result.map((s) => s.category),
    ["design", "clarify", "coding", "analyze", "checklist", "validation"],
  );
});

test("injectV2OverseerStages: parallel-design pipeline gets ONE clarify after the LAST design", () => {
  const stages: StageDefinition[] = [
    { name: "ux-design", agent: "ux-designer", category: "design" },
    { name: "core-design", agent: "core-code-designer", category: "design" },
    { name: "visual-design", agent: "graphics-designer", category: "design" },
    { name: "coding", agent: "coding", category: "coding" },
    { name: "validation", agent: "testing", category: "validation" },
  ];
  const result = injectV2OverseerStages(stages);
  assert.deepEqual(
    result.map((s) => s.category),
    ["design", "design", "design", "clarify", "coding", "analyze", "checklist", "validation"],
  );
});

test("injectV2OverseerStages: idempotent — second call is a no-op", () => {
  const once = injectV2OverseerStages(FULL_STAGES_WEB);
  const twice = injectV2OverseerStages(once);
  assert.deepEqual(once.map((s) => s.name), twice.map((s) => s.name));
  assert.deepEqual(once.map((s) => s.category), twice.map((s) => s.category));
});

test("injectV2OverseerStages: no design stages → no clarify, but analyze + checklist still added", () => {
  const stages: StageDefinition[] = [
    { name: "coding", agent: "coding", category: "coding" },
    { name: "validation", agent: "testing", category: "validation" },
  ];
  const result = injectV2OverseerStages(stages);
  assert.deepEqual(
    result.map((s) => s.category),
    ["coding", "analyze", "checklist", "validation"],
  );
});

test("injectV2OverseerStages: no coding stages → no analyze/checklist, clarify still added", () => {
  const stages: StageDefinition[] = [
    { name: "design", agent: "core-code-designer", category: "design" },
  ];
  const result = injectV2OverseerStages(stages);
  assert.deepEqual(
    result.map((s) => s.category),
    ["design", "clarify"],
  );
});

test("injectV2OverseerStages: design + coding (no validation) gets all three substages", () => {
  const stages: StageDefinition[] = [
    { name: "design", agent: "core-code-designer", category: "design" },
    { name: "coding", agent: "coding", category: "coding" },
  ];
  const result = injectV2OverseerStages(stages);
  assert.deepEqual(
    result.map((s) => s.category),
    ["design", "clarify", "coding", "analyze", "checklist"],
  );
});

test("injectV2OverseerStages: empty input returns empty", () => {
  assert.deepEqual(injectV2OverseerStages([]), []);
});

test("injectV2OverseerStages: does not mutate input array", () => {
  const stages = [...FULL_STAGES_WEB];
  const beforeLen = stages.length;
  const beforeCats = stages.map((s) => s.category);
  injectV2OverseerStages(stages);
  assert.equal(stages.length, beforeLen);
  assert.deepEqual(stages.map((s) => s.category), beforeCats);
});

test("injectV2OverseerStages: checklist comes immediately AFTER analyze", () => {
  const result = injectV2OverseerStages(FULL_STAGES_WEB);
  const analyzeIdx = result.findIndex((s) => s.category === "analyze");
  const checklistIdx = result.findIndex((s) => s.category === "checklist");
  assert.ok(analyzeIdx >= 0, "analyze stage should be present");
  assert.ok(checklistIdx >= 0, "checklist stage should be present");
  assert.equal(checklistIdx, analyzeIdx + 1, "checklist must immediately follow analyze");
});

test("injectV2OverseerStages: clarify comes immediately AFTER last design (before coding)", () => {
  const result = injectV2OverseerStages(FULL_STAGES_WEB);
  const cats = result.map((s) => s.category);
  // Find LAST design index (in case of parallel design)
  let lastDesignIdx = -1;
  for (let i = 0; i < cats.length; i++) if (cats[i] === "design") lastDesignIdx = i;
  assert.equal(cats[lastDesignIdx + 1], "clarify");
});

test("injectV2OverseerStages: code-only pipeline (no design, no validation) gets analyze + checklist", () => {
  const stages: StageDefinition[] = [
    { name: "coding", agent: "coding", category: "coding" },
  ];
  const result = injectV2OverseerStages(stages);
  assert.deepEqual(
    result.map((s) => s.category),
    ["coding", "analyze", "checklist"],
  );
});

test("injectV2OverseerStages: clarify + analyze + checklist are now injected unconditionally (no ARTEFACT_SCHEMA gate)", () => {
  // Regression guard: v3.0.0 retired the ARTEFACT_SCHEMA env flag and the v1
  // pipeline. clarify, analyze, and checklist must always appear in the
  // expanded stage list as long as the upstream/downstream categories are
  // present. If a future refactor reintroduces a conditional, this test fails.
  for (const stages of [FULL_STAGES_WEB, FULL_STAGES_LOVE]) {
    const result = injectV2OverseerStages(stages);
    const cats = result.map((s) => s.category);
    assert.ok(cats.includes("clarify"), "clarify must be injected for full pipeline");
    assert.ok(cats.includes("analyze"), "analyze must be injected for full pipeline");
    assert.ok(cats.includes("checklist"), "checklist must be injected for full pipeline");
  }
});
