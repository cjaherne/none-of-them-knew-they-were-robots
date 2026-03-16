import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import * as path from "path";

interface WebSocketStackProps extends cdk.StackProps {
  stage: string;
  connectionsTable: dynamodb.Table;
  logsTable?: dynamodb.Table;
}

export class WebSocketStack extends cdk.Stack {
  public readonly wsApi: apigatewayv2.WebSocketApi;

  constructor(scope: Construct, id: string, props: WebSocketStackProps) {
    super(scope, id, props);

    const commonEnv = {
      CONNECTIONS_TABLE: props.connectionsTable.tableName,
    };

    const connectFn = new lambdaNode.NodejsFunction(this, "ConnectFn", {
      entry: path.join(__dirname, "../../packages/api/src/stream.ts"),
      handler: "connectHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });
    props.connectionsTable.grantReadWriteData(connectFn);

    const disconnectFn = new lambdaNode.NodejsFunction(this, "DisconnectFn", {
      entry: path.join(__dirname, "../../packages/api/src/stream.ts"),
      handler: "disconnectHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });
    props.connectionsTable.grantReadWriteData(disconnectFn);

    this.wsApi = new apigatewayv2.WebSocketApi(this, "TaskStreamApi", {
      apiName: `${props.stage}-task-stream`,
      connectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          "ConnectIntegration",
          connectFn
        ),
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          "DisconnectIntegration",
          disconnectFn
        ),
      },
    });

    const wsStage = new apigatewayv2.WebSocketStage(this, "WsStage", {
      webSocketApi: this.wsApi,
      stageName: props.stage,
      autoDeploy: true,
    });

    new cdk.CfnOutput(this, "WebSocketUrl", {
      value: wsStage.url,
      description: "WebSocket API URL",
    });

    if (props.logsTable) {
      const logBroadcasterFn = new lambdaNode.NodejsFunction(this, "LogBroadcasterFn", {
        entry: path.join(__dirname, "../../packages/api/src/log-broadcaster.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(30),
        environment: {
          ...commonEnv,
          WS_ENDPOINT: `https://${this.wsApi.apiId}.execute-api.${this.region}.amazonaws.com/${props.stage}`,
        },
        bundling: { externalModules: ["@aws-sdk/*"] },
      });

      props.connectionsTable.grantReadData(logBroadcasterFn);
      logBroadcasterFn.addToRolePolicy(
        new cdk.aws_iam.PolicyStatement({
          actions: ["execute-api:ManageConnections"],
          resources: [`arn:aws:execute-api:${this.region}:${this.account}:${this.wsApi.apiId}/*`],
        }),
      );

      logBroadcasterFn.addEventSource(
        new lambdaEventSources.DynamoEventSource(props.logsTable, {
          startingPosition: lambda.StartingPosition.LATEST,
          batchSize: 25,
          maxBatchingWindow: cdk.Duration.seconds(1),
          retryAttempts: 2,
        }),
      );
    }
  }
}
