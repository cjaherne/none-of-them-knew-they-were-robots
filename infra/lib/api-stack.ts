import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "path";

interface ApiStackProps extends cdk.StackProps {
  stage: string;
  tasksTable: dynamodb.Table;
  approvalsTable: dynamodb.Table;
  logsTable: dynamodb.Table;
  taskQueue: sqs.Queue;
  audioBucket: s3.Bucket;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const openaiSecret = secretsmanager.Secret.fromSecretNameV2(
      this, "OpenAIKey", `${props.stage}/openai-api-key`
    );

    const commonEnv = {
      STAGE: props.stage,
      TASKS_TABLE: props.tasksTable.tableName,
      APPROVALS_TABLE: props.approvalsTable.tableName,
      LOGS_TABLE: props.logsTable.tableName,
      TASK_QUEUE_URL: props.taskQueue.queueUrl,
      AUDIO_BUCKET: props.audioBucket.bucketName,
      OPENAI_API_KEY_SECRET_ARN: openaiSecret.secretArn,
    };

    const voiceCommandFn = new lambdaNode.NodejsFunction(this, "VoiceCommandFn", {
      entry: path.join(__dirname, "../../packages/api/src/voice-command.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    const tasksFn = new lambdaNode.NodejsFunction(this, "TasksFn", {
      entry: path.join(__dirname, "../../packages/api/src/tasks.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    const approvalsFn = new lambdaNode.NodejsFunction(this, "ApprovalsFn", {
      entry: path.join(__dirname, "../../packages/api/src/approvals.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    const setupGitHubFn = new lambdaNode.NodejsFunction(this, "SetupGitHubFn", {
      entry: path.join(__dirname, "../../packages/api/src/setup.ts"),
      handler: "setupGitHubHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    const setupStatusFn = new lambdaNode.NodejsFunction(this, "SetupStatusFn", {
      entry: path.join(__dirname, "../../packages/api/src/setup.ts"),
      handler: "setupStatusHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    const logIngestFn = new lambdaNode.NodejsFunction(this, "LogIngestFn", {
      entry: path.join(__dirname, "../../packages/api/src/logs.ts"),
      handler: "ingestHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    const logQueryFn = new lambdaNode.NodejsFunction(this, "LogQueryFn", {
      entry: path.join(__dirname, "../../packages/api/src/logs.ts"),
      handler: "queryHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    const logHistoryFn = new lambdaNode.NodejsFunction(this, "LogHistoryFn", {
      entry: path.join(__dirname, "../../packages/api/src/logs.ts"),
      handler: "historyHandler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: commonEnv,
      bundling: { externalModules: ["@aws-sdk/*"] },
    });

    props.logsTable.grantReadWriteData(logIngestFn);
    props.logsTable.grantReadData(logQueryFn);
    props.tasksTable.grantReadData(logHistoryFn);

    props.tasksTable.grantReadWriteData(voiceCommandFn);
    props.tasksTable.grantReadData(tasksFn);
    props.approvalsTable.grantReadWriteData(approvalsFn);
    props.taskQueue.grantSendMessages(voiceCommandFn);
    props.audioBucket.grantReadWrite(voiceCommandFn);
    openaiSecret.grantRead(voiceCommandFn);

    this.api = new apigateway.RestApi(this, "AgentsApi", {
      restApiName: `${props.stage}-agents-api`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const voiceResource = this.api.root.addResource("voice-command");
    voiceResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(voiceCommandFn)
    );

    const tasksResource = this.api.root.addResource("tasks");
    const taskByIdResource = tasksResource.addResource("{id}");
    taskByIdResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(tasksFn)
    );

    const approveResource = taskByIdResource.addResource("approve");
    approveResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(approvalsFn)
    );

    const setupResource = this.api.root.addResource("setup");
    const githubSetupResource = setupResource.addResource("github");
    githubSetupResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(setupGitHubFn)
    );
    const statusResource = setupResource.addResource("status");
    statusResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(setupStatusFn)
    );

    const logsResource = this.api.root.addResource("logs");
    logsResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(logQueryFn),
    );

    const internalResource = this.api.root.addResource("internal");
    const internalLogResource = internalResource.addResource("log");
    internalLogResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(logIngestFn),
    );

    const tasksHistoryResource = tasksResource.addResource("history");
    tasksHistoryResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(logHistoryFn),
    );

    new cdk.CfnOutput(this, "ApiUrl", {
      value: this.api.url,
      description: "REST API URL",
    });
  }
}
