import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Task, TaskStatus } from "@agents/shared";
import { randomUUID } from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function createTask(
  prompt: string,
  repo: string,
  requiresApproval: boolean,
  tableName: string
): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    prompt,
    status: TaskStatus.Queued,
    repo,
    requiresApproval,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: tableName, Item: task }));
  return task;
}

export async function getTask(
  taskId: string,
  tableName: string
): Promise<Task | undefined> {
  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id: taskId } })
  );
  return result.Item as Task | undefined;
}

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  tableName: string,
  extra?: { resultSummary?: string; error?: string; pipelineName?: string }
): Promise<void> {
  let updateExpr = "SET #status = :status, updatedAt = :now";
  const exprNames: Record<string, string> = { "#status": "status" };
  const exprValues: Record<string, unknown> = {
    ":status": status,
    ":now": new Date().toISOString(),
  };

  if (extra?.resultSummary) {
    updateExpr += ", resultSummary = :summary";
    exprValues[":summary"] = extra.resultSummary;
  }
  if (extra?.error) {
    updateExpr += ", #error = :error";
    exprNames["#error"] = "error";
    exprValues[":error"] = extra.error;
  }
  if (extra?.pipelineName) {
    updateExpr += ", pipelineName = :pipeline";
    exprValues[":pipeline"] = extra.pipelineName;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { id: taskId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    })
  );
}
