import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { respondToApproval, getApprovalRequest } from "@agents/services";

const sfn = new SFNClient({});

const APPROVALS_TABLE = process.env.APPROVALS_TABLE!;

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const approvalId = event.pathParameters?.id;
    if (!approvalId) {
      return response(400, { error: "Approval ID required" });
    }

    const body = JSON.parse(event.body || "{}");
    const approved: boolean = body.approved === true;

    const approval = await getApprovalRequest(approvalId, APPROVALS_TABLE);
    if (!approval) {
      return response(404, { error: "Approval request not found" });
    }

    await respondToApproval(approvalId, approved, APPROVALS_TABLE);

    if (body.taskToken) {
      await sfn.send(
        new SendTaskSuccessCommand({
          taskToken: body.taskToken,
          output: JSON.stringify({ approved }),
        })
      );
    }

    return response(200, { approvalId, approved });
  } catch (err) {
    console.error("Approval error:", err);
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
