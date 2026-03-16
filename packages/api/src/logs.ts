import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { writeLogEntry, getLogsForTask } from "@agents/services";
import type { LogEntry, LogLevel } from "@agents/shared";

const LOGS_TABLE = process.env.LOGS_TABLE!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function ingestHandler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  try {
    const entry = JSON.parse(event.body || "{}") as LogEntry;
    if (!entry.id || !entry.level || !entry.source || !entry.message) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing required fields" }) };
    }
    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    await writeLogEntry(entry, LOGS_TABLE);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: String(err) }) };
  }
}

export async function queryHandler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  try {
    const taskId = event.queryStringParameters?.taskId;
    if (!taskId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "taskId is required" }) };
    }
    const level = event.queryStringParameters?.level as LogLevel | undefined;
    const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit, 10) : undefined;

    const logs = await getLogsForTask(taskId, LOGS_TABLE, { level, limit });
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(logs) };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: String(err) }) };
  }
}

export async function historyHandler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  try {
    const tasksTable = process.env.TASKS_TABLE!;
    const { getTaskHistory } = await import("@agents/services");
    const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit, 10) : 50;
    const tasks = await getTaskHistory(tasksTable, limit);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(tasks) };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: String(err) }) };
  }
}
