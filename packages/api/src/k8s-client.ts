import * as k8s from "@kubernetes/client-node";
import { AgentPipelineSpec, PipelineStage } from "@agents/shared";

const AGENT_PIPELINE_GROUP = "agents.robots.io";
const AGENT_PIPELINE_VERSION = "v1alpha1";
const AGENT_PIPELINE_PLURAL = "agentpipelines";

let customApi: k8s.CustomObjectsApi | null = null;

function getCustomApi(): k8s.CustomObjectsApi {
  if (customApi) return customApi;
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  return customApi;
}

export async function createAgentPipeline(
  taskId: string,
  spec: AgentPipelineSpec,
  namespace: string = "agent-system"
): Promise<string> {
  const api = getCustomApi();

  const pipelineName = `pipeline-${taskId}`;

  const body = {
    apiVersion: `${AGENT_PIPELINE_GROUP}/${AGENT_PIPELINE_VERSION}`,
    kind: "AgentPipeline",
    metadata: {
      name: pipelineName,
      namespace,
      labels: {
        "agents.robots.io/task-id": taskId,
      },
    },
    spec: {
      taskId: spec.taskId,
      prompt: spec.prompt,
      repo: spec.repo || "",
      requiresApproval: spec.requiresApproval,
      stages: spec.stages,
    },
  };

  await api.createNamespacedCustomObject({
    group: AGENT_PIPELINE_GROUP,
    version: AGENT_PIPELINE_VERSION,
    namespace,
    plural: AGENT_PIPELINE_PLURAL,
    body,
  });

  return pipelineName;
}

export async function getAgentPipelineStatus(
  pipelineName: string,
  namespace: string = "agent-system"
): Promise<Record<string, unknown> | null> {
  const api = getCustomApi();

  try {
    const response = await api.getNamespacedCustomObject({
      group: AGENT_PIPELINE_GROUP,
      version: AGENT_PIPELINE_VERSION,
      namespace,
      plural: AGENT_PIPELINE_PLURAL,
      name: pipelineName,
    });
    return (response as any)?.status || null;
  } catch {
    return null;
  }
}
