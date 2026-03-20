/**
 * Feedback criteria for coding→design loop.
 * Used when requireDesignApproval is false to decide whether to automatically
 * loop back to design based on CODING_NOTES.md content.
 */

export interface ParsedCodingNotes {
  deviations: string;
  issuesFound: string;
  suggestions: string;
  /** Raw content for fingerprinting (Issues + Deviations) */
  mustAddressContent: string;
}

/** Minimum meaningful content length (chars) to consider looping */
const MIN_CONTENT_LENGTH = 50;

/** Similarity threshold: if new fingerprint matches previous > this, treat as no progress */
const STABILITY_SIMILARITY_THRESHOLD = 0.8;

/**
 * Parse CODING_NOTES.md into sections.
 * Handles flexible header formats (## Deviations, ## Issues Found, ## Suggestions).
 */
export function parseCodingNotes(notes: string): ParsedCodingNotes {
  const trimmed = notes.trim();
  const result: ParsedCodingNotes = {
    deviations: "",
    issuesFound: "",
    suggestions: "",
    mustAddressContent: "",
  };

  if (!trimmed) return result;

  const sectionRegex = /^##\s+(Deviations|Issues Found|Suggestions)\s*$/gim;
  const sections: Array<{
    key: "deviations" | "issuesFound" | "suggestions";
    contentStart: number;
    headerStart: number;
  }> = [];
  let m: RegExpExecArray | null;
  const keyMap: Record<string, "deviations" | "issuesFound" | "suggestions"> = {
    Deviations: "deviations",
    "Issues Found": "issuesFound",
    Suggestions: "suggestions",
  };

  while ((m = sectionRegex.exec(trimmed)) !== null) {
    const key = keyMap[m[1]];
    sections.push({
      key,
      contentStart: m.index + m[0].length,
      headerStart: m.index,
    });
  }

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const end =
      i < sections.length - 1 ? sections[i + 1].headerStart : trimmed.length;
    const content = trimmed
      .slice(s.contentStart, end)
      .replace(/^[\s\n]+|[\s\n]+$/g, "")
      .trim();
    result[s.key] = content;
  }

  // Build must-address content (Issues + Deviations) for fingerprint
  const issues = result.issuesFound.trim();
  const deviations = result.deviations.trim();
  result.mustAddressContent = [issues, deviations]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 500);

  return result;
}

/**
 * Simple Jaccard-like similarity on normalized word tokens.
 * Returns a value in [0, 1] where 1 = identical.
 */
function fingerprintSimilarity(a: string, b: string): number {
  if (!a.trim() || !b.trim()) return 0;
  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((t) => t.length > 2);
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Decide whether to loop back to design based on feedback content.
 * Returns true only if we should loop (criteria pass and stability check passes).
 *
 * Criteria:
 * - Issues Found present and non-trivial → loop
 * - Deviations present and non-trivial → loop (design gaps)
 * - Suggestions only → do not loop
 * - Empty/trivial content → do not loop
 * - Stability: if new content highly similar to previous, do not loop (oscillation)
 */
export function shouldLoopOnFeedback(
  parsed: ParsedCodingNotes,
  previousFeedbackFingerprint?: string,
): boolean {
  const { issuesFound, deviations, mustAddressContent } = parsed;

  // Trivial or empty: do not loop
  if (mustAddressContent.length < MIN_CONTENT_LENGTH) {
    return false;
  }

  // Suggestions only (no Issues, no Deviations): do not loop
  if (!issuesFound.trim() && !deviations.trim()) {
    return false;
  }

  // Stability check: similar to previous loop → likely oscillating
  if (previousFeedbackFingerprint) {
    const similarity = fingerprintSimilarity(
      mustAddressContent,
      previousFeedbackFingerprint,
    );
    if (similarity >= STABILITY_SIMILARITY_THRESHOLD) {
      return false;
    }
  }

  return true;
}
