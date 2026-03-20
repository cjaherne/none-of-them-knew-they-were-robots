/**
 * Cursor Agent server-side chat sessions (`create-chat` + `--resume`) policy.
 */

export type CursorAgentSessionsMode = "off" | "bigboss" | "all";

/**
 * - `off` — no `--resume`; every CLI invocation is cold.
 * - `bigboss` — only `agentType === "bigboss"` gets a shared chat (planner, merge, overseer).
 * - `all` — each `agentType` in a pipeline gets its own lazy-created chat (except denylist).
 *
 * `CURSOR_AGENT_SESSIONS` takes precedence when set to a known value.
 * If unset, `BIGBOSS_PERSIST_CLI=0` implies `off`; otherwise default is `bigboss` (backward compatible).
 */
export function getCursorAgentSessionsMode(): CursorAgentSessionsMode {
  const raw = (process.env.CURSOR_AGENT_SESSIONS || "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") {
    return "off";
  }
  if (raw === "bigboss") {
    return "bigboss";
  }
  if (raw === "all") {
    return "all";
  }
  if (process.env.BIGBOSS_PERSIST_CLI === "0") {
    return "off";
  }
  return "bigboss";
}
