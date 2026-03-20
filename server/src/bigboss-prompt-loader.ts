import * as path from "path";
import { readFileSync } from "fs";

/**
 * Load the canonical BigBoss persona from the skill pack (sync, for agent-runner preambles).
 * Returns empty string if missing (caller keeps fallback behavior).
 */
export function loadBigBossSystemPromptSync(skillsRoot: string): string {
  try {
    const p = path.join(skillsRoot, "bigboss", "system-prompt.md");
    return readFileSync(p, "utf-8").trim();
  } catch {
    return "";
  }
}
