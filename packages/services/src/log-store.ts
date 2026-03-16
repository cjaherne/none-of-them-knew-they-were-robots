import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { LogEntry, LogLevel } from "@agents/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function writeLogEntry(
  entry: LogEntry,
  tableName: string,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...entry,
        taskId: entry.taskId || "system",
      },
    }),
  );
}

export async function getLogsForTask(
  taskId: string,
  tableName: string,
  opts: { level?: LogLevel; limit?: number } = {},
): Promise<LogEntry[]> {
  const params: Record<string, unknown> = {
    TableName: tableName,
    KeyConditionExpression: "taskId = :tid",
    ExpressionAttributeValues: { ":tid": taskId } as Record<string, unknown>,
    ScanIndexForward: true,
    Limit: opts.limit || 500,
  };

  if (opts.level) {
    (params as any).FilterExpression = "#lvl = :lvl";
    (params as any).ExpressionAttributeNames = { "#lvl": "level" };
    (params.ExpressionAttributeValues as Record<string, unknown>)[":lvl"] = opts.level;
  }

  const result = await ddb.send(new QueryCommand(params as any));
  return (result.Items || []) as LogEntry[];
}

export async function getTaskHistory(
  tasksTableName: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tasksTableName,
      IndexName: "createdAt-index",
      KeyConditionExpression: "#s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "completed" },
      ScanIndexForward: false,
      Limit: limit,
    } as any),
  );
  return (result.Items || []) as Record<string, unknown>[];
}
