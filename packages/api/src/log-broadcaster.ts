import { DynamoDBStreamEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { broadcastToTask } from "./stream";
import type { TaskStreamEvent } from "@agents/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const WS_ENDPOINT = process.env.WS_ENDPOINT!;

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName !== "INSERT" || !record.dynamodb?.NewImage) continue;

    const item = unmarshall(record.dynamodb.NewImage as any);
    const taskId = item.taskId as string;
    if (!taskId || taskId === "system") continue;

    const conns = await ddb.send(
      new QueryCommand({
        TableName: CONNECTIONS_TABLE,
        IndexName: "taskId-index",
        KeyConditionExpression: "taskId = :tid",
        ExpressionAttributeValues: { ":tid": taskId },
      }),
    );

    if (!conns.Items || conns.Items.length === 0) continue;

    const streamEvent: TaskStreamEvent = {
      taskId,
      type: "log" as TaskStreamEvent["type"],
      message: item.message || "",
      data: {
        type: "log_entry",
        id: item.id,
        level: item.level,
        source: item.source,
        category: item.category,
        metadata: item.metadata,
      },
      timestamp: item.timestamp || new Date().toISOString(),
    };

    await broadcastToTask(
      WS_ENDPOINT,
      streamEvent,
      conns.Items as { connectionId: string }[],
    );
  }
}
