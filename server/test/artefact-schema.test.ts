/**
 * Unit tests for src/artefact-schema.ts — the ARTEFACT_SCHEMA env-flag helpers
 * that gate every spec-kit Tier 2 v2 code path.
 *
 * **PR4 flipped the default to v2.** The contract that matters in production:
 *   - unset / empty / "v2" / unknown → v2 (so users always get the modern flow
 *     unless they explicitly opt out)
 *   - explicit "v1" (case/whitespace insensitive) → v1 (preserved for one
 *     release per the migration plan)
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isArtefactSchemaV2, getArtefactSchemaVersion } from "../src/artefact-schema";

const ORIGINAL = process.env.ARTEFACT_SCHEMA;

beforeEach(() => {
  delete process.env.ARTEFACT_SCHEMA;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ARTEFACT_SCHEMA;
  else process.env.ARTEFACT_SCHEMA = ORIGINAL;
});

test("artefact-schema: defaults to v2 when env unset (PR4 flip)", () => {
  assert.equal(getArtefactSchemaVersion(), "v2");
  assert.equal(isArtefactSchemaV2(), true);
});

test("artefact-schema: explicit v2 stays v2", () => {
  process.env.ARTEFACT_SCHEMA = "v2";
  assert.equal(getArtefactSchemaVersion(), "v2");
  assert.equal(isArtefactSchemaV2(), true);
});

test("artefact-schema: explicit v1 is the opt-out", () => {
  process.env.ARTEFACT_SCHEMA = "v1";
  assert.equal(getArtefactSchemaVersion(), "v1");
  assert.equal(isArtefactSchemaV2(), false);
});

test("artefact-schema: v1 opt-out is case-insensitive and whitespace-tolerant", () => {
  process.env.ARTEFACT_SCHEMA = "  V1  ";
  assert.equal(getArtefactSchemaVersion(), "v1");
  assert.equal(isArtefactSchemaV2(), false);
});

test("artefact-schema: V2 (uppercase) still v2", () => {
  process.env.ARTEFACT_SCHEMA = "  V2  ";
  assert.equal(isArtefactSchemaV2(), true);
});

test("artefact-schema: unknown / future values default to v2 (modern flow wins)", () => {
  process.env.ARTEFACT_SCHEMA = "v3";
  assert.equal(getArtefactSchemaVersion(), "v2");
  assert.equal(isArtefactSchemaV2(), true);
});

test("artefact-schema: empty string defaults to v2", () => {
  process.env.ARTEFACT_SCHEMA = "";
  assert.equal(isArtefactSchemaV2(), true);
});

test("artefact-schema: whitespace-only defaults to v2", () => {
  process.env.ARTEFACT_SCHEMA = "   ";
  assert.equal(isArtefactSchemaV2(), true);
});
