import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { TaskStreamEvent } from "@agents/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

export async function connectHandler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId!;
  const taskId = event.queryStringParameters?.taskId;

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        taskId: taskId || "global",
        connectedAt: new Date().toISOString(),
      },
    })
  );

  return { statusCode: 200, body: "Connected" };
}

export async function disconnectHandler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId!;

  await ddb.send(
    new DeleteCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId },
    })
  );

  return { statusCode: 200, body: "Disconnected" };
}

export async function broadcastToTask(
  apiEndpoint: string,
  streamEvent: TaskStreamEvent,
  connections: { connectionId: string }[]
): Promise<void> {
  const client = new ApiGatewayManagementApiClient({
    endpoint: apiEndpoint,
  });

  const payload = Buffer.from(JSON.stringify(streamEvent));

  await Promise.allSettled(
    connections.map((conn) =>
      client.send(
        new PostToConnectionCommand({
          ConnectionId: conn.connectionId,
          Data: payload,
        })
      )
    )
  );
}
