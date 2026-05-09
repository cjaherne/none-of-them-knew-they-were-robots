/**
 * Artefact schema version flag — gates the spec-kit Tier 2 PR1 v2 artefacts
 * (spec.md / plan.md / research.md / data-model.md / contracts/ / CHECKLISTS.md)
 * behind ARTEFACT_SCHEMA=v2. When unset (or "v1"), the orchestrator behaves
 * exactly as before: a single merged DESIGN.md plus the existing REQUIREMENTS.md
 * and (Tier 1) TASKS.md flow.
 *
 * v1 vs v2 contract:
 *   - v1: DESIGN.md is the single source of truth for design.
 *   - v2: spec.md (what/why) and plan.md (how) are the primary artefacts;
 *         DESIGN.md is written as a back-compat concatenation (spec.md + plan.md)
 *         so coding agents and Overseer prompts that still read DESIGN.md keep
 *         working through the transition.
 *
 * The flag is intentionally a single env var (no per-task override yet) to keep
 * PR1 as additive as possible. Per-task overrides are documented in the Tier 2
 * plan as a follow-up.
 */

export type ArtefactSchemaVersion = "v1" | "v2";

export function getArtefactSchemaVersion(): ArtefactSchemaVersion {
  const raw = (process.env.ARTEFACT_SCHEMA || "v1").trim().toLowerCase();
  return raw === "v2" ? "v2" : "v1";
}

export function isArtefactSchemaV2(): boolean {
  return getArtefactSchemaVersion() === "v2";
}
