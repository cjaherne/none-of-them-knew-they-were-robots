import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { ApprovalRequest } from "@agents/shared";
import { randomUUID } from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

export async function createApprovalRequest(
  taskId: string,
  action: string,
  detail: string,
  diffPreview: string | undefined,
  tableName: string,
  notificationTopicArn?: string
): Promise<ApprovalRequest> {
  const request: ApprovalRequest = {
    id: randomUUID(),
    taskId,
    action,
    detail,
    diffPreview,
    createdAt: new Date().toISOString(),
  };

  await ddb.send(
    new PutCommand({ TableName: tableName, Item: request })
  );

  if (notificationTopicArn) {
    await sns.send(
      new PublishCommand({
        TopicArn: notificationTopicArn,
        Subject: `Approval Required: ${action}`,
        Message: JSON.stringify({
          taskId,
          action,
          detail,
          approvalId: request.id,
        }),
      })
    );
  }

  return request;
}

export async function getApprovalRequest(
  approvalId: string,
  tableName: string
): Promise<ApprovalRequest | undefined> {
  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id: approvalId } })
  );
  return result.Item as ApprovalRequest | undefined;
}

export async function respondToApproval(
  approvalId: string,
  approved: boolean,
  tableName: string
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { id: approvalId },
      UpdateExpression: "SET approved = :approved, respondedAt = :now",
      ExpressionAttributeValues: {
        ":approved": approved,
        ":now": new Date().toISOString(),
      },
    })
  );
}
