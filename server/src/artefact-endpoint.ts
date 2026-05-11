/**
 * Pure helpers for the GET /tasks/:id/artefacts/:file endpoint.
 *
 * The Express handler in server.ts is a thin wrapper around `readArtefact`;
 * keeping the file-resolution + whitelist + path-traversal logic here makes
 * it directly testable without spinning up the full server (which transitively
 * imports the orchestrator + sqlite log store).
 */
import * as fs from "fs";
import * as path from "path";

/**
 * Allowed artefact file names. Kept deliberately small. MUST stay in sync
 * with the `ARTEFACT_TABS` array in web/app.js — a missing entry on either
 * side is visible during local dev.
 */
export const ARTEFACT_WHITELIST: ReadonlySet<string> = new Set([
  "constitution.md",
  "REQUIREMENTS.md",
  "spec.md",
  "plan.md",
  "TASKS.md",
  "CHECKLISTS.md",
]);

export type ArtefactReadOk = { ok: true; content: string };
export type ArtefactReadErr = { ok: false; status: number; error: string };
export type ArtefactReadResult = ArtefactReadOk | ArtefactReadErr;

/**
 * Read a whitelisted markdown artefact from `workDir` safely. Returns a
 * structured result rather than throwing so callers can map directly to
 * HTTP responses without try/catch noise.
 *
 * Status mapping:
 *   400 → not in whitelist, or path traversal detected
 *   404 → file not yet written (ENOENT/EISDIR)
 *   500 → unexpected fs error
 *   200 → ok, content returned
 *
 * Path-traversal guard: even though the whitelist already constrains the
 * filename to bare names (no slashes), `path.resolve` would still happily
 * collapse a malicious join, so we belt-and-brace by verifying the
 * resolved absolute path stays inside `workDir`.
 */
export function readArtefact(workDir: string, file: string): ArtefactReadResult {
  if (!ARTEFACT_WHITELIST.has(file)) {
    return { ok: false, status: 400, error: `Artefact not in whitelist: ${file}` };
  }
  if (!workDir) {
    return { ok: false, status: 404, error: "Workspace not yet ready" };
  }

  const workspaceRoot = path.resolve(workDir);
  const resolved = path.resolve(workspaceRoot, file);
  const isInside =
    resolved === workspaceRoot ||
    resolved.startsWith(workspaceRoot + path.sep);
  if (!isInside) {
    return { ok: false, status: 400, error: "Path traversal detected" };
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "EISDIR")) {
      return { ok: false, status: 404, error: "Artefact not yet written" };
    }
    return { ok: false, status: 500, error: `Read failed: ${String(err)}` };
  }
  return { ok: true, content };
}
