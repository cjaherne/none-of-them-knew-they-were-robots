/**
 * Unit tests for src/artefact-schema.ts — the ARTEFACT_SCHEMA env-flag helpers
 * that gate every spec-kit Tier 2 v2 code path. Critical to verify because the
 * v1/v2 contract relies on this returning false by default in production.
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

test("artefact-schema: defaults to v1 when env unset", () => {
  assert.equal(getArtefactSchemaVersion(), "v1");
  assert.equal(isArtefactSchemaV2(), false);
});

test("artefact-schema: returns v2 when ARTEFACT_SCHEMA=v2", () => {
  process.env.ARTEFACT_SCHEMA = "v2";
  assert.equal(getArtefactSchemaVersion(), "v2");
  assert.equal(isArtefactSchemaV2(), true);
});

test("artefact-schema: case-insensitive and whitespace-tolerant", () => {
  process.env.ARTEFACT_SCHEMA = "  V2  ";
  assert.equal(isArtefactSchemaV2(), true);
});

test("artefact-schema: explicit v1 stays v1", () => {
  process.env.ARTEFACT_SCHEMA = "v1";
  assert.equal(getArtefactSchemaVersion(), "v1");
  assert.equal(isArtefactSchemaV2(), false);
});

test("artefact-schema: unknown / future values default safe to v1", () => {
  process.env.ARTEFACT_SCHEMA = "v3";
  assert.equal(getArtefactSchemaVersion(), "v1");
  assert.equal(isArtefactSchemaV2(), false);
});

test("artefact-schema: empty string defaults to v1", () => {
  process.env.ARTEFACT_SCHEMA = "";
  assert.equal(isArtefactSchemaV2(), false);
});
