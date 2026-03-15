import * as cdk from "aws-cdk-lib";
import * as eks from "aws-cdk-lib/aws-eks";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { KubectlV30Layer } from "@aws-cdk/lambda-layer-kubectl-v30";
import { Construct } from "constructs";

interface EksStackProps extends cdk.StackProps {
  stage: string;
  tasksTable: dynamodb.Table;
  approvalsTable: dynamodb.Table;
  agentResultsTable: dynamodb.Table;
  skillsBucket: s3.Bucket;
}

export class EksStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  public readonly operatorRepo: ecr.Repository;
  public readonly agentRuntimeRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: EksStackProps) {
    super(scope, id, props);

    // ECR repositories for operator and agent runtime images
    this.operatorRepo = new ecr.Repository(this, "OperatorRepo", {
      repositoryName: `${props.stage}-agent-operator`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    this.agentRuntimeRepo = new ecr.Repository(this, "AgentRuntimeRepo", {
      repositoryName: `${props.stage}-agent-runtime`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    // VPC for EKS
    const vpc = new ec2.Vpc(this, "AgentVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // EKS cluster
    const clusterRole = new iam.Role(this, "ClusterRole", {
      assumedBy: new iam.ServicePrincipal("eks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSClusterPolicy"),
      ],
    });

    this.cluster = new eks.Cluster(this, "AgentCluster", {
      clusterName: `${props.stage}-agent-cluster`,
      version: eks.KubernetesVersion.V1_30,
      kubectlLayer: new KubectlV30Layer(this, "KubectlLayer"),
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0,
      role: clusterRole,
    });

    // Managed node group for system workloads (operator, karpenter)
    this.cluster.addNodegroupCapacity("SystemNodes", {
      instanceTypes: [new ec2.InstanceType("m7i-flex.large")],
      minSize: 1,
      maxSize: 3,
      desiredSize: 2,
      labels: { "workload-type": "system" },
    });

    // IAM role for agent runtime pods (IRSA)
    const agentRuntimeRole = new iam.Role(this, "AgentRuntimeRole", {
      roleName: `${props.stage}-agent-runtime-role`,
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            [`${this.cluster.clusterOpenIdConnectIssuer}:sub`]:
              `system:serviceaccount:agent-system:agent-runtime`,
            [`${this.cluster.clusterOpenIdConnectIssuer}:aud`]: "sts.amazonaws.com",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    props.skillsBucket.grantRead(agentRuntimeRole);
    props.skillsBucket.grantWrite(agentRuntimeRole);
    props.agentResultsTable.grantReadWriteData(agentRuntimeRole);
    props.tasksTable.grantReadWriteData(agentRuntimeRole);

    // IAM role for the operator pods (IRSA)
    const operatorRole = new iam.Role(this, "OperatorRole", {
      roleName: `${props.stage}-agent-operator-role`,
      assumedBy: new iam.FederatedPrincipal(
        this.cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            [`${this.cluster.clusterOpenIdConnectIssuer}:sub`]:
              `system:serviceaccount:agent-system:agent-operator`,
            [`${this.cluster.clusterOpenIdConnectIssuer}:aud`]: "sts.amazonaws.com",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    props.tasksTable.grantReadWriteData(operatorRole);
    props.approvalsTable.grantReadData(operatorRole);

    // Create the agent-system namespace and install the Helm chart
    this.cluster.addHelmChart("AgentSystem", {
      chart: "../helm/agent-system",
      release: "agent-system",
      namespace: "agent-system",
      createNamespace: true,
      values: {
        namespace: "agent-system",
        operator: {
          image: `${this.operatorRepo.repositoryUri}:latest`,
        },
        agentRuntime: {
          image: `${this.agentRuntimeRepo.repositoryUri}:latest`,
        },
        aws: {
          region: this.region,
          skillsBucket: props.skillsBucket.bucketName,
          resultsTable: props.agentResultsTable.tableName,
          serviceAccountRoleArn: agentRuntimeRole.roleArn,
        },
      },
    });

    // Outputs
    new cdk.CfnOutput(this, "ClusterName", {
      value: this.cluster.clusterName,
    });
    new cdk.CfnOutput(this, "OperatorRepoUri", {
      value: this.operatorRepo.repositoryUri,
    });
    new cdk.CfnOutput(this, "AgentRuntimeRepoUri", {
      value: this.agentRuntimeRepo.repositoryUri,
    });
    new cdk.CfnOutput(this, "AgentRuntimeRoleArn", {
      value: agentRuntimeRole.roleArn,
    });
    new cdk.CfnOutput(this, "KubectlConfig", {
      value: `aws eks update-kubeconfig --name ${this.cluster.clusterName} --region ${this.region}`,
    });
  }
}
