import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

interface StorageStackProps extends cdk.StackProps {
  stage: string;
}

export class StorageStack extends cdk.Stack {
  public readonly tasksTable: dynamodb.Table;
  public readonly approvalsTable: dynamodb.Table;
  public readonly agentResultsTable: dynamodb.Table;
  public readonly connectionsTable: dynamodb.Table;
  public readonly logsTable: dynamodb.Table;
  public readonly skillsBucket: s3.Bucket;
  public readonly audioBucket: s3.Bucket;
  public readonly taskQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    this.tasksTable = new dynamodb.Table(this, "TasksTable", {
      tableName: `${props.stage}-tasks`,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.approvalsTable = new dynamodb.Table(this, "ApprovalsTable", {
      tableName: `${props.stage}-approvals`,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.approvalsTable.addGlobalSecondaryIndex({
      indexName: "taskId-index",
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
    });

    this.agentResultsTable = new dynamodb.Table(this, "AgentResultsTable", {
      tableName: `${props.stage}-agent-results`,
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "agent", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.connectionsTable = new dynamodb.Table(this, "ConnectionsTable", {
      tableName: `${props.stage}-ws-connections`,
      partitionKey: { name: "connectionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });
    this.connectionsTable.addGlobalSecondaryIndex({
      indexName: "taskId-index",
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
    });

    this.logsTable = new dynamodb.Table(this, "LogsTable", {
      tableName: `${props.stage}-logs`,
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });
    this.logsTable.addGlobalSecondaryIndex({
      indexName: "level-index",
      partitionKey: { name: "level", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
    });

    this.skillsBucket = new s3.Bucket(this, "SkillsBucket", {
      bucketName: `${props.stage}-agent-skills-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.audioBucket = new s3.Bucket(this, "AudioBucket", {
      bucketName: `${props.stage}-agent-audio-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        { expiration: cdk.Duration.days(7) },
      ],
    });

    const dlq = new sqs.Queue(this, "TaskDLQ", {
      queueName: `${props.stage}-task-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.taskQueue = new sqs.Queue(this, "TaskQueue", {
      queueName: `${props.stage}-task-queue`,
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });
  }
}
