#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { StorageStack } from "../lib/storage-stack";
import { ApiStack } from "../lib/api-stack";
import { EksStack } from "../lib/eks-stack";
import { WebSocketStack } from "../lib/websocket-stack";

const app = new cdk.App();

const stage = app.node.tryGetContext("stage") || "dev";
const prefix = `robots-${stage}`;

const storage = new StorageStack(app, `${prefix}-storage`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const eks = new EksStack(app, `${prefix}-eks`, {
  stage,
  tasksTable: storage.tasksTable,
  approvalsTable: storage.approvalsTable,
  agentResultsTable: storage.agentResultsTable,
  skillsBucket: storage.skillsBucket,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const websocket = new WebSocketStack(app, `${prefix}-websocket`, {
  stage,
  connectionsTable: storage.connectionsTable,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

new ApiStack(app, `${prefix}-api`, {
  stage,
  tasksTable: storage.tasksTable,
  approvalsTable: storage.approvalsTable,
  taskQueue: storage.taskQueue,
  audioBucket: storage.audioBucket,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
