/**
 * Artefact schema version flag — gates the spec-kit Tier 2 v2 artefacts
 * (spec.md / plan.md / research.md / data-model.md / contracts/ / CHECKLISTS.md)
 * and the discrete clarify / analyze / checklist Overseer sub-stages.
 *
 * **Tier 2 PR4 (v2.7+) flips the default to v2.** Setting `ARTEFACT_SCHEMA=v1`
 * is the explicit opt-out and preserves the legacy single-DESIGN.md flow byte-
 * identical for one release. Anything else (unset, empty, `v2`, unknown) is
 * treated as v2 — this is intentional so users who set typos or future schema
 * names get the modern behaviour rather than silently falling back to v1.
 *
 * v1 vs v2 contract:
 *   - v1: DESIGN.md is the single source of truth for design; inline Overseer
 *         post-design / post-coding reviews; LOVE_SMOKE_CHECKLIST=1 still active.
 *   - v2: spec.md (what/why) and plan.md (how) are the primary artefacts;
 *         CHECKLISTS.md generated alongside; clarify/analyze/checklist stages
 *         dispatched by the orchestrator. DESIGN.md is still produced by the
 *         existing parallel-design merge (kept for back-compat with Overseer
 *         prompts and coding-agent fallbacks until PR5 retires it).
 *
 * The flag is a single env var; per-task override (`RuntimeTask.artefactSchema`)
 * is documented as a follow-up but not implemented here.
 */

export type ArtefactSchemaVersion = "v1" | "v2";

export function getArtefactSchemaVersion(): ArtefactSchemaVersion {
  const raw = (process.env.ARTEFACT_SCHEMA || "").trim().toLowerCase();
  return raw === "v1" ? "v1" : "v2";
}

export function isArtefactSchemaV2(): boolean {
  return getArtefactSchemaVersion() === "v2";
}
