import { AgentConfig, AgentResult, SkillPack, AgentConstraints, CursorStreamEvent } from "./types";
import { loadSkillPack } from "./skill-loader";
import { setupWorkspace, collectModifiedFiles, commitAndPush } from "./workspace";
import { runCursor, CursorRunOptions, CursorRunResult } from "./cursor-runner";
import { assessOutputRisks } from "./risk-detector";
import { reportResult } from "./result-reporter";

const MAX_CONSTRAINT_RETRIES = 1;

export async function executeAgentLifecycle(config: AgentConfig): Promise<AgentResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  console.log(`[${config.agentType}] Starting agent lifecycle`);
  console.log(`[${config.agentType}] Pipeline: ${config.pipelineRef}`);
  console.log(`[${config.agentType}] Prompt: ${config.prompt.slice(0, 100)}...`);

  try {
    // 1. Load skill pack
    console.log(`[${config.agentType}] Loading skill pack: ${config.skillPack}`);
    const skillPack = await loadSkillPack(config.skillPack, config.skillsBucket);

    // 2. Set up workspace (clone repo, inject cursor rules + MCP config, configure git identity)
    console.log(`[${config.agentType}] Setting up workspace`);
    const workDir = await setupWorkspace(config, skillPack);

    // 3. Build the full prompt with system context, tool hints, and constraints
    const fullPrompt = buildFullPrompt(config, skillPack);

    // 4. Run Cursor CLI headless (with constraint-based retry)
    const runOptions: CursorRunOptions = {
      prompt: fullPrompt,
      workDir,
      flags: config.cursorFlags,
      cursorApiKey: config.cursorApiKey,
      timeoutMs: skillPack.constraints.timeoutMs,
      onEvent: (event) => {
        if (event.content) {
          process.stdout.write(event.content);
        }
      },
    };

    let cursorResult = await runCursorWithRetry(
      config, runOptions, skillPack.constraints
    );

    if (cursorResult.exitCode !== 0) {
      errors.push(`Cursor CLI exited with code ${cursorResult.exitCode}`);
      if (cursorResult.stderr) {
        errors.push(cursorResult.stderr.slice(0, 1000));
      }
    }

    // 5. Check for risky actions + forbidden actions
    const riskAssessment = assessOutputRisks(cursorResult.events);
    const forbiddenViolations = checkForbiddenActions(
      cursorResult.events, skillPack.constraints.forbiddenActions
    );
    if (forbiddenViolations.length > 0) {
      for (const v of forbiddenViolations) {
        errors.push(`Forbidden action: ${v}`);
      }
    }
    if (riskAssessment.isRisky) {
      console.log(`[${config.agentType}] Risks detected:`,
        riskAssessment.risks.map((r) => r.description).join(", ")
      );
    }

    // 6. Collect modified files
    const filesModified = await collectModifiedFiles(workDir);
    console.log(`[${config.agentType}] Files modified: ${filesModified.length}`);

    // 7. Commit and push changes back to the repo
    let commitSha: string | undefined;
    if (config.repo && filesModified.length > 0) {
      const branch = `agent/${config.pipelineRef}/${config.agentType}`;
      console.log(`[${config.agentType}] Pushing changes to branch: ${branch}`);
      const pushResult = commitAndPush(workDir, config.agentType, config.pipelineRef, branch);
      commitSha = pushResult.commitSha;
      if (pushResult.pushed) {
        console.log(`[${config.agentType}] Pushed commit ${commitSha} to ${branch}`);
      } else if (pushResult.committed) {
        errors.push("Committed locally but failed to push to remote");
      }
    }

    // 8. Build result
    const result: AgentResult = {
      agent: config.agentType,
      pipelineRef: config.pipelineRef,
      taskName: config.taskName,
      success: cursorResult.exitCode === 0 && errors.length === 0,
      output: {
        eventsCount: cursorResult.events.length,
        risks: riskAssessment.risks,
        exitCode: cursorResult.exitCode,
        ...(commitSha && { commitSha, branch: `agent/${config.pipelineRef}/${config.agentType}` }),
      },
      filesModified,
      errors,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    // 9. Report result to S3 + DynamoDB
    await reportResult(result, config.skillsBucket, config.resultsTable);

    console.log(`[${config.agentType}] Lifecycle complete (${result.durationMs}ms)`);
    return result;
  } catch (err) {
    const result: AgentResult = {
      agent: config.agentType,
      pipelineRef: config.pipelineRef,
      taskName: config.taskName,
      success: false,
      output: {},
      filesModified: [],
      errors: [err instanceof Error ? err.message : String(err)],
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    try {
      await reportResult(result, config.skillsBucket, config.resultsTable);
    } catch (reportErr) {
      console.error("Failed to report error result:", reportErr);
    }

    return result;
  }
}

function buildFullPrompt(
  config: AgentConfig,
  skillPack: SkillPack
): string {
  const parts: string[] = [];

  parts.push(skillPack.systemPrompt);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("## Task");
  parts.push(config.prompt);

  if (skillPack.tools && skillPack.tools.length > 0) {
    parts.push("");
    parts.push("## Preferred tools");
    for (const tool of skillPack.tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`);
    }
  }

  if (skillPack.constraints.maxTokens > 0) {
    parts.push("");
    parts.push(`Keep your response under ${skillPack.constraints.maxTokens} tokens.`);
  }

  if (Object.keys(config.context).length > 0) {
    parts.push("");
    parts.push("## Additional context");
    for (const [key, value] of Object.entries(config.context)) {
      parts.push(`- ${key}: ${value}`);
    }
  }

  if (config.upstreamRefs.length > 0) {
    parts.push("");
    parts.push("## Upstream results");
    parts.push(`Upstream agent results are available in S3 bucket "${config.skillsBucket}" under results/${config.pipelineRef}/`);
    parts.push(`Upstream task refs: ${config.upstreamRefs.join(", ")}`);
  }

  return parts.join("\n");
}

async function runCursorWithRetry(
  config: AgentConfig,
  options: CursorRunOptions,
  constraints: AgentConstraints
): Promise<CursorRunResult> {
  let result = await runCursor(options);

  if (constraints.requiredOutputFields.length === 0) {
    return result;
  }

  const missing = findMissingOutputFields(result, constraints.requiredOutputFields);
  if (missing.length === 0) {
    return result;
  }

  for (let retry = 0; retry < MAX_CONSTRAINT_RETRIES; retry++) {
    console.log(
      `[${config.agentType}] Missing required output fields: ${missing.join(", ")}. Retrying (${retry + 1}/${MAX_CONSTRAINT_RETRIES})...`
    );
    const retryPrompt =
      `${options.prompt}\n\nIMPORTANT: Your previous response was missing these required fields: ${missing.join(", ")}. You MUST include all of them in your output.`;
    const retryResult = await runCursor({ ...options, prompt: retryPrompt });
    const stillMissing = findMissingOutputFields(retryResult, constraints.requiredOutputFields);
    if (stillMissing.length === 0) {
      return retryResult;
    }
    result = retryResult;
  }

  console.warn(
    `[${config.agentType}] Still missing required output fields after retries: ${missing.join(", ")}`
  );
  return result;
}

function findMissingOutputFields(
  result: CursorRunResult,
  requiredFields: string[]
): string[] {
  if (requiredFields.length === 0) return [];
  const output = result.stdout.toLowerCase();
  return requiredFields.filter(
    (field) => !output.includes(field.toLowerCase())
  );
}

function checkForbiddenActions(
  events: CursorStreamEvent[],
  forbiddenActions: string[]
): string[] {
  if (forbiddenActions.length === 0) return [];
  const violations: string[] = [];
  for (const event of events) {
    if (!event.tool_call) continue;
    const toolName = event.tool_call.name.toLowerCase();
    for (const forbidden of forbiddenActions) {
      if (toolName.includes(forbidden.toLowerCase())) {
        violations.push(`${event.tool_call.name} matches forbidden action "${forbidden}"`);
      }
    }
  }
  return violations;
}
