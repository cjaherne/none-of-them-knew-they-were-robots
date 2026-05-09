/**
 * Unit tests for src/checklist-stage.ts (PR3) and src/checklists-artifact.ts
 * (PR1). Focus on:
 *   - Pure helper: deriveFocusPathsFromFailed (path-extraction heuristic).
 *   - runChecklistStage noop branches that don't require a live OpenAI call:
 *       * CHECKLISTS.md missing
 *       * CHECKLISTS.md empty
 *       * OPENAI_API_KEY unset
 *   - tickChecklistItems integration: pass→[X], fail→[!], unknown skipped,
 *     missing items skipped (never inserts).
 *
 * Live-OpenAI paths are out of scope (would make tests flaky and require a
 * key); the noop branches still exercise the file-IO + emit_overseer_log
 * surface so a regression in those is caught.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { runChecklistStage, deriveFocusPathsFromFailed } from "../src/checklist-stage";
import { tickChecklistItems } from "../src/checklists-artifact";

async function makeTempWorkDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "checklist-stage-test-"));
}

async function rmrf(workDir: string): Promise<void> {
  await fs.rm(workDir, { recursive: true, force: true });
}

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  // Force noop OpenAI path so we never hit the network in CI/local runs.
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_OPENAI_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
});

// ---------------------------------------------------------------------------
// deriveFocusPathsFromFailed (pure helper)
// ---------------------------------------------------------------------------

test("deriveFocusPathsFromFailed: extracts path-like substrings", () => {
  const failed = [
    "User can save in src/saves/init.lua but the file is missing",
    "Background `assets/bg.png` not loaded",
    "test/foo.test.ts has no imports",
  ];
  const paths = deriveFocusPathsFromFailed(failed);
  assert.ok(paths.includes("src/saves/init.lua"), `missing src/saves/init.lua in ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("assets/bg.png"));
  assert.ok(paths.includes("test/foo.test.ts"));
});

test("deriveFocusPathsFromFailed: ignores http URLs", () => {
  const failed = ["Fetch https://example.com/api/users.json failed"];
  const paths = deriveFocusPathsFromFailed(failed);
  assert.equal(paths.length, 0, `expected no paths from URL, got ${JSON.stringify(paths)}`);
});

test("deriveFocusPathsFromFailed: dedupes repeated paths and caps at 25", () => {
  const failed = Array(50).fill("see src/foo.ts and src/foo.ts again");
  const paths = deriveFocusPathsFromFailed(failed);
  assert.equal(paths.length, 1);
  assert.equal(paths[0], "src/foo.ts");
});

test("deriveFocusPathsFromFailed: caps at 25 when many distinct paths", () => {
  const failed = Array.from({ length: 40 }, (_, i) => `missing src/file-${i}.ts handler`);
  const paths = deriveFocusPathsFromFailed(failed);
  assert.equal(paths.length, 25);
});

test("deriveFocusPathsFromFailed: returns empty for plain text without paths", () => {
  const failed = ["The user cannot save", "No persistence implemented"];
  const paths = deriveFocusPathsFromFailed(failed);
  assert.deepEqual(paths, []);
});

test("deriveFocusPathsFromFailed: extracts mixed extensions (lua, ts, json, md)", () => {
  const failed = [
    "main.lua missing love.update",
    "package.json has no test script",
    "README.md not updated",
    "src/util.ts: TypeError",
  ];
  const paths = deriveFocusPathsFromFailed(failed);
  // package.json is ambiguous (no leading dir), but our regex requires
  // [a-zA-Z0-9_./-]+\.ext so root-level "package.json" / "main.lua" are valid.
  assert.ok(paths.includes("main.lua"));
  assert.ok(paths.includes("package.json"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("src/util.ts"));
});

// ---------------------------------------------------------------------------
// runChecklistStage (noop branches)
// ---------------------------------------------------------------------------

test("runChecklistStage: noop when CHECKLISTS.md is missing", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const ac = new AbortController();
    const outcome = await runChecklistStage({
      workDir,
      originalTask: "do a thing",
      taskId: "test-task-missing",
      signal: ac.signal,
      stack: "web",
      initialFixUps: 0,
      fixUpRunner: async () => {
        throw new Error("fixUpRunner must not be called when CHECKLISTS.md is missing");
      },
    });
    assert.equal(outcome.status, "noop");
    assert.equal(outcome.result, null);
    assert.equal(outcome.fixUpsRun, 0);
    assert.equal(outcome.fixUpResults.length, 0);
    assert.equal(outcome.shouldBlock, false);
  } finally {
    await rmrf(workDir);
  }
});

test("runChecklistStage: noop when CHECKLISTS.md is whitespace-only", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(path.join(workDir, "CHECKLISTS.md"), "   \n\n  \n");
    const ac = new AbortController();
    const outcome = await runChecklistStage({
      workDir,
      originalTask: "x",
      taskId: "test-task-empty",
      signal: ac.signal,
      stack: "web",
      initialFixUps: 0,
      fixUpRunner: async () => {
        throw new Error("fixUpRunner must not be called for empty CHECKLISTS.md");
      },
    });
    assert.equal(outcome.status, "noop");
    assert.equal(outcome.result, null);
  } finally {
    await rmrf(workDir);
  }
});

test("runChecklistStage: noop when OPENAI_API_KEY unset (with content)", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(
      path.join(workDir, "CHECKLISTS.md"),
      "# Checklists\n\n- [ ] User can do X\n- [ ] User can do Y\n",
    );
    const ac = new AbortController();
    const outcome = await runChecklistStage({
      workDir,
      originalTask: "test",
      taskId: "test-task-no-key",
      signal: ac.signal,
      stack: "web",
      initialFixUps: 0,
      fixUpRunner: async () => {
        throw new Error("fixUpRunner must not be called without OPENAI_API_KEY");
      },
    });
    assert.equal(outcome.status, "noop");
    assert.equal(outcome.result, null);
    assert.equal(outcome.shouldBlock, false);
  } finally {
    await rmrf(workDir);
  }
});

test("runChecklistStage: noop returns shouldBlock=false even when CHECKLIST_BLOCKING=1", async () => {
  // Blocking should only fire on `incomplete`, never on noop.
  const original = process.env.CHECKLIST_BLOCKING;
  process.env.CHECKLIST_BLOCKING = "1";
  const workDir = await makeTempWorkDir();
  try {
    const ac = new AbortController();
    const outcome = await runChecklistStage({
      workDir,
      originalTask: "x",
      taskId: "test-blocking-noop",
      signal: ac.signal,
      stack: "love",
      initialFixUps: 0,
      fixUpRunner: async () => {
        throw new Error("must not run");
      },
    });
    assert.equal(outcome.status, "noop");
    assert.equal(outcome.shouldBlock, false);
  } finally {
    if (original === undefined) delete process.env.CHECKLIST_BLOCKING;
    else process.env.CHECKLIST_BLOCKING = original;
    await rmrf(workDir);
  }
});

// ---------------------------------------------------------------------------
// tickChecklistItems (PR1 helper consumed by checklist stage)
// ---------------------------------------------------------------------------

test("tickChecklistItems: pass → [X], fail → [!], unchanged otherwise", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(
      path.join(workDir, "CHECKLISTS.md"),
      `# Checklists\n\n- [ ] User can do X\n- [ ] User can do Y\n- [ ] User can do Z\n`,
    );
    const result = await tickChecklistItems(workDir, [
      { text: "User can do X", status: "pass" },
      { text: "User can do Y", status: "fail", note: "missing handler" },
      { text: "User can do Q", status: "pass" }, // not present → skipped
    ]);
    assert.equal(result.updated, 2);
    assert.equal(result.skipped, 1);
    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    assert.match(after, /- \[X\] User can do X/);
    assert.match(after, /- \[!\] User can do Y/);
    assert.match(after, /missing handler/);
    assert.match(after, /- \[ \] User can do Z/); // unchanged
  } finally {
    await rmrf(workDir);
  }
});

test("tickChecklistItems: unknown status leaves item unchanged", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(
      path.join(workDir, "CHECKLISTS.md"),
      `# Checklists\n\n- [ ] User can do X\n`,
    );
    const result = await tickChecklistItems(workDir, [
      { text: "User can do X", status: "unknown", note: "could not determine" },
    ]);
    assert.equal(result.updated, 1);
    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    // Marker stays as [ ] for unknown, but note is appended on the same line.
    assert.match(after, /- \[ \] User can do X.*could not determine/);
  } finally {
    await rmrf(workDir);
  }
});

test("tickChecklistItems: missing CHECKLISTS.md returns 0/skipped", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const result = await tickChecklistItems(workDir, [
      { text: "User can do X", status: "pass" },
    ]);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);
  } finally {
    await rmrf(workDir);
  }
});

test("tickChecklistItems: empty results array is a no-op", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const before = `# Checklists\n\n- [ ] only item\n`;
    await fs.writeFile(path.join(workDir, "CHECKLISTS.md"), before);
    const result = await tickChecklistItems(workDir, []);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 0);
    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    assert.equal(after, before);
  } finally {
    await rmrf(workDir);
  }
});
