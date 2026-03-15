import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getTask } from "@agents/services";

const TASKS_TABLE = process.env.TASKS_TABLE!;

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const taskId = event.pathParameters?.id;

    if (!taskId) {
      return response(400, { error: "Task ID required" });
    }

    const task = await getTask(taskId, TASKS_TABLE);

    if (!task) {
      return response(404, { error: "Task not found" });
    }

    return response(200, task);
  } catch (err) {
    console.error("Get task error:", err);
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
