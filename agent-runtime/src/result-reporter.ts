import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AgentResult } from "./types";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function reportResult(
  result: AgentResult,
  skillsBucket: string,
  resultsTable: string
): Promise<void> {
  const resultKey = `results/${result.pipelineRef}/${result.taskName}.json`;

  await Promise.all([
    s3.send(
      new PutObjectCommand({
        Bucket: skillsBucket,
        Key: resultKey,
        Body: JSON.stringify(result, null, 2),
        ContentType: "application/json",
      })
    ),

    ddb.send(
      new PutCommand({
        TableName: resultsTable,
        Item: {
          taskId: result.pipelineRef,
          agent: result.agent,
          taskName: result.taskName,
          success: result.success,
          filesModified: result.filesModified,
          errors: result.errors,
          durationMs: result.durationMs,
          resultKey,
          timestamp: result.timestamp,
        },
      })
    ),
  ]);

  console.log(`Result reported: ${resultKey}`);
}
