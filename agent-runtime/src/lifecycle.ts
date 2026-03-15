import { AgentConfig, AgentResult } from "./types";
import { loadSkillPack } from "./skill-loader";
import { setupWorkspace, collectModifiedFiles, commitAndPush } from "./workspace";
import { runCursor } from "./cursor-runner";
import { assessOutputRisks } from "./risk-detector";
import { reportResult } from "./result-reporter";

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

    // 3. Build the full prompt with system context
    const fullPrompt = buildFullPrompt(config, skillPack.systemPrompt);

    // 4. Run Cursor CLI headless
    console.log(`[${config.agentType}] Running Cursor CLI`);
    const cursorResult = await runCursor({
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
    });

    if (cursorResult.exitCode !== 0) {
      errors.push(`Cursor CLI exited with code ${cursorResult.exitCode}`);
      if (cursorResult.stderr) {
        errors.push(cursorResult.stderr.slice(0, 1000));
      }
    }

    // 5. Check for risky actions
    const riskAssessment = assessOutputRisks(cursorResult.events);
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
  systemPrompt: string
): string {
  const parts: string[] = [];

  parts.push(config.prompt);

  if (Object.keys(config.context).length > 0) {
    parts.push("");
    parts.push("Additional context:");
    for (const [key, value] of Object.entries(config.context)) {
      parts.push(`- ${key}: ${value}`);
    }
  }

  if (config.upstreamRefs.length > 0) {
    parts.push("");
    parts.push(`Upstream agent results are available in S3 bucket "${config.skillsBucket}" under results/${config.pipelineRef}/`);
    parts.push(`Upstream task refs: ${config.upstreamRefs.join(", ")}`);
  }

  return parts.join("\n");
}
