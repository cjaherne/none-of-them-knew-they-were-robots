import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  VoiceCommandRequest,
  VoiceCommandResponse,
  TaskStatus,
  AgentPipelineSpec,
} from "@agents/shared";
import { transcribeFromBase64, parseIntent, createTask } from "@agents/services";
import { createAgentPipeline } from "./k8s-client";

const TASKS_TABLE = process.env.TASKS_TABLE!;
const OPENAI_SECRET_ARN = process.env.OPENAI_API_KEY_SECRET_ARN!;
const AGENT_NAMESPACE = process.env.AGENT_NAMESPACE || "agent-system";

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const body: VoiceCommandRequest = JSON.parse(event.body || "{}");

    let rawText: string;

    if (body.text) {
      rawText = body.text;
    } else if (body.audioBase64) {
      const transcription = await transcribeFromBase64(
        body.audioBase64,
        OPENAI_SECRET_ARN
      );
      rawText = transcription.text;
    } else {
      return response(400, { error: "Provide text or audioBase64" });
    }

    const intent = await parseIntent(rawText, OPENAI_SECRET_ARN);

    const task = await createTask(
      intent.prompt,
      intent.repo,
      intent.requiresApproval,
      TASKS_TABLE
    );

    // BigBoss planning is handled by the operator's pipeline controller.
    // For now, create a default pipeline with standard stages.
    // In future, a BigBoss Lambda or pre-processing step can generate
    // custom stages based on the intent.
    const pipelineSpec: AgentPipelineSpec = {
      taskId: task.id,
      prompt: intent.prompt,
      repo: intent.repo,
      requiresApproval: intent.requiresApproval,
      stages: [
        {
          name: "design",
          agents: [{ type: "core-code-designer" }],
        },
        {
          name: "coding",
          agents: [{ type: "coding" }],
        },
        {
          name: "validation",
          agents: [{ type: "testing" }],
        },
      ],
    };

    const pipelineName = await createAgentPipeline(
      task.id,
      pipelineSpec,
      AGENT_NAMESPACE
    );

    const result: VoiceCommandResponse = {
      taskId: task.id,
      pipelineName,
      status: TaskStatus.Queued,
    };

    return response(201, result);
  } catch (err) {
    console.error("Voice command error:", err);
    return response(500, { error: "Internal server error" });
  }
}

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
