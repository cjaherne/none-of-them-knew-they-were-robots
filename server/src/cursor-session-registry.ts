import { createLogger } from "@agents/shared";
import { getCursorAgentSessionsMode, type CursorAgentSessionsMode } from "./cursor-session-policy";
import { spawnCursorAgentCreateChat } from "./agent-runner";

const SESSION_DENYLIST = new Set(["release"]);

export class CursorSessionRegistry {
  private readonly map = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workDir: string,
    private readonly taskId: string,
    private readonly mode: CursorAgentSessionsMode,
    private readonly log: ReturnType<typeof createLogger>,
  ) {}

  /** Mode active for this pipeline (frozen at registry construction). */
  getMode(): CursorAgentSessionsMode {
    return this.mode;
  }

  /**
   * Returns a Cursor chat id for (taskId, agentType), creating it on first use.
   * Respects mode and denylist; returns null when sessions are disabled or create-chat fails.
   */
  getOrCreate(agentType: string): Promise<string | null> {
    if (this.mode === "off") {
      return Promise.resolve(null);
    }
    if (this.mode === "bigboss" && agentType !== "bigboss") {
      return Promise.resolve(null);
    }
    if (SESSION_DENYLIST.has(agentType)) {
      return Promise.resolve(null);
    }

    const key = `${this.taskId}::${agentType}`;
    const cached = this.map.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }

    const run = async (): Promise<string | null> => {
      if (this.map.has(key)) {
        return this.map.get(key)!;
      }
      const id = await spawnCursorAgentCreateChat(this.workDir);
      if (id) {
        this.map.set(key, id);
        this.log.info("Cursor agent session created", {
          agentType,
          sessionHint: id.slice(0, 8),
        }, "flow");
      }
      return id;
    };

    const p = this.chain.then(run, run);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

export function createCursorSessionRegistry(
  workDir: string,
  taskId: string,
  log: ReturnType<typeof createLogger>,
): CursorSessionRegistry {
  return new CursorSessionRegistry(workDir, taskId, getCursorAgentSessionsMode(), log);
}
