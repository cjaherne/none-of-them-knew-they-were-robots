import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getTask, getLogsForTask } from "@agents/services";
import type { LogLevel } from "@agents/shared";

const TASKS_TABLE = process.env.TASKS_TABLE!;
const LOGS_TABLE = process.env.LOGS_TABLE!;

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const taskId = event.pathParameters?.id;

    if (!taskId) {
      return response(400, { error: "Task ID required" });
    }

    const [task, logs] = await Promise.all([
      getTask(taskId, TASKS_TABLE),
      getLogsForTask(taskId, LOGS_TABLE, {
        limit: 500,
        level: (event.queryStringParameters?.level as LogLevel) || undefined,
      }),
    ]);

    if (!task) {
      return response(404, { error: "Task not found" });
    }

    return response(200, { task, logs });
  } catch (err) {
    console.error("Get task detail error:", err);
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
