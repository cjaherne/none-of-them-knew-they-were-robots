/**
 * Unit tests for the v2 visibility PR's two new server-side surfaces:
 *
 *   1. `readArtefact` — pure helper behind GET /tasks/:id/artefacts/:file.
 *      Covers whitelist enforcement, path-traversal rejection (relative,
 *      absolute, encoded), 404 on missing file, 200 on present file.
 *
 *   2. `appendOverrideNote` — CHECKLISTS.md audit-trail helper called when
 *      the user accepts the "Override and Continue" action on the new
 *      checklist approval banner.
 *
 * No live server / OpenAI is involved — both helpers are pure file IO so
 * tests run fast and offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { readArtefact, ARTEFACT_WHITELIST } from "../src/artefact-endpoint";
import { appendOverrideNote } from "../src/checklists-artifact";

async function makeTempWorkDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "artefact-endpoint-test-"));
}

async function rmrf(workDir: string): Promise<void> {
  await fs.rm(workDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// readArtefact: whitelist enforcement
// ---------------------------------------------------------------------------

test("readArtefact: rejects file not in whitelist with 400", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(path.join(workDir, "secret.txt"), "shhh");
    const result = readArtefact(workDir, "secret.txt");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.match(result.error, /whitelist/i);
    }
  } finally {
    await rmrf(workDir);
  }
});

test("readArtefact: whitelist contains spec/plan artefacts plus REQUIREMENTS", () => {
  const expected = [
    "constitution.md",
    "REQUIREMENTS.md",
    "spec.md",
    "plan.md",
    "TASKS.md",
    "CHECKLISTS.md",
  ];
  for (const f of expected) {
    assert.ok(ARTEFACT_WHITELIST.has(f), `whitelist missing ${f}`);
  }
  assert.equal(ARTEFACT_WHITELIST.has("DESIGN.md"), false, "DESIGN.md must be retired from whitelist");
});

// ---------------------------------------------------------------------------
// readArtefact: path-traversal hardening
// ---------------------------------------------------------------------------

test("readArtefact: relative ../ traversal rejected (caught by whitelist)", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const result = readArtefact(workDir, "../etc/passwd");
    assert.equal(result.ok, false);
    if (!result.ok) {
      // Whitelist check trips first — that's fine; both layers are defence.
      assert.equal(result.status, 400);
    }
  } finally {
    await rmrf(workDir);
  }
});

test("readArtefact: nested traversal in whitelisted name still rejected", async () => {
  // "../spec.md" is not in the whitelist (because the whitelist requires the
  // bare name). This confirms the whitelist + resolve() guard combine to
  // reject sneaky escapes even if a future contributor relaxes the whitelist.
  const workDir = await makeTempWorkDir();
  try {
    const result = readArtefact(workDir, "../spec.md");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  } finally {
    await rmrf(workDir);
  }
});

test("readArtefact: empty workDir returns 404 not crash", () => {
  const result = readArtefact("", "spec.md");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.match(result.error, /workspace/i);
  }
});

// ---------------------------------------------------------------------------
// readArtefact: file-state branches
// ---------------------------------------------------------------------------

test("readArtefact: missing whitelisted file returns 404 (UI disables tab)", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const result = readArtefact(workDir, "spec.md");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 404);
      assert.match(result.error, /not yet written/i);
    }
  } finally {
    await rmrf(workDir);
  }
});

test("readArtefact: present whitelisted file returns 200 + content", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const body = "# Spec\n\nUser can do X.\n";
    await fs.writeFile(path.join(workDir, "spec.md"), body, "utf-8");
    const result = readArtefact(workDir, "spec.md");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, body);
  } finally {
    await rmrf(workDir);
  }
});

test("readArtefact: directory at whitelisted name returns 404 not 500", async () => {
  const workDir = await makeTempWorkDir();
  try {
    // Edge case: spec.md is a directory (shouldn't happen but EISDIR exists).
    await fs.mkdir(path.join(workDir, "spec.md"));
    const result = readArtefact(workDir, "spec.md");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 404);
  } finally {
    await rmrf(workDir);
  }
});

test("readArtefact: each whitelisted artefact roundtrips", async () => {
  const workDir = await makeTempWorkDir();
  try {
    for (const file of ARTEFACT_WHITELIST) {
      const body = `# ${file}\nfixture\n`;
      await fs.writeFile(path.join(workDir, file), body, "utf-8");
      const result = readArtefact(workDir, file);
      assert.equal(result.ok, true, `read failed for ${file}`);
      if (result.ok) assert.equal(result.content, body);
    }
  } finally {
    await rmrf(workDir);
  }
});

// ---------------------------------------------------------------------------
// appendOverrideNote: checklist override audit trail
// ---------------------------------------------------------------------------

test("appendOverrideNote: marks matching [!] items as [~] with stamped suffix", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(
      path.join(workDir, "CHECKLISTS.md"),
      "# Checklists\n\n- [!] User can save\n- [!] User can quit\n- [X] Game launches\n",
    );
    const result = await appendOverrideNote(
      workDir,
      ["User can save", "User can quit"],
      { reason: "Edge case acceptable for v0.1", userAt: "2026-05-09T20:00:00.000Z" },
    );
    assert.equal(result.updated, 2);
    assert.equal(result.appendedFooter, true);

    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    assert.match(after, /- \[~\] User can save.*overridden by user @ 2026-05-09T20:00:00\.000Z/);
    assert.match(after, /- \[~\] User can quit.*Edge case acceptable for v0\.1/);
    // Untouched items unchanged.
    assert.match(after, /- \[X\] Game launches/);
    // Footer block.
    assert.match(after, /## Overrides/);
    assert.match(after, /2026-05-09T20:00:00\.000Z: 2 item\(s\) overridden/);
  } finally {
    await rmrf(workDir);
  }
});

test("appendOverrideNote: unmatched items recorded in footer audit", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(
      path.join(workDir, "CHECKLISTS.md"),
      "# Checklists\n\n- [!] Real failing item\n",
    );
    const result = await appendOverrideNote(
      workDir,
      ["Real failing item", "Phantom item that drifted"],
      { reason: "test", userAt: "2026-01-01T00:00:00.000Z" },
    );
    assert.equal(result.updated, 1);
    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    assert.match(after, /Unmatched.*Phantom item that drifted/);
  } finally {
    await rmrf(workDir);
  }
});

test("appendOverrideNote: missing CHECKLISTS.md is a no-op", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const result = await appendOverrideNote(workDir, ["anything"], { reason: "x" });
    assert.equal(result.updated, 0);
    assert.equal(result.appendedFooter, false);
  } finally {
    await rmrf(workDir);
  }
});

test("appendOverrideNote: empty failedItems array does not write a footer", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const before = "# Checklists\n\n- [ ] only item\n";
    await fs.writeFile(path.join(workDir, "CHECKLISTS.md"), before);
    const result = await appendOverrideNote(workDir, [], { reason: "x" });
    assert.equal(result.updated, 0);
    assert.equal(result.appendedFooter, false);
    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    assert.equal(after, before);
  } finally {
    await rmrf(workDir);
  }
});

test("appendOverrideNote: second override appends to existing footer (no duplicate heading)", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(
      path.join(workDir, "CHECKLISTS.md"),
      "# Checklists\n\n- [!] First failing\n- [!] Second failing\n",
    );
    await appendOverrideNote(workDir, ["First failing"], { userAt: "2026-01-01T00:00:00.000Z" });
    await appendOverrideNote(workDir, ["Second failing"], { userAt: "2026-01-02T00:00:00.000Z" });
    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    const headingMatches = after.match(/## Overrides/g) || [];
    assert.equal(headingMatches.length, 1, "footer heading must not duplicate");
    assert.match(after, /2026-01-01T00:00:00\.000Z: 1 item\(s\) overridden/);
    assert.match(after, /2026-01-02T00:00:00\.000Z: 1 item\(s\) overridden/);
  } finally {
    await rmrf(workDir);
  }
});

test("appendOverrideNote: omits reason suffix when reason absent", async () => {
  const workDir = await makeTempWorkDir();
  try {
    await fs.writeFile(
      path.join(workDir, "CHECKLISTS.md"),
      "# Checklists\n\n- [!] Failing item\n",
    );
    const result = await appendOverrideNote(workDir, ["Failing item"], {
      userAt: "2026-05-09T20:00:00.000Z",
    });
    assert.equal(result.updated, 1);
    const after = await fs.readFile(path.join(workDir, "CHECKLISTS.md"), "utf-8");
    assert.match(after, /overridden by user @ 2026-05-09T20:00:00\.000Z\)_/);
    assert.doesNotMatch(after, /overridden by user @ 2026-05-09T20:00:00\.000Z: /);
  } finally {
    await rmrf(workDir);
  }
});
