package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:generate=true
// PipelineStageAgent defines an agent to run within a pipeline stage.
type PipelineStageAgent struct {
	// Type is the agent type from the registry (e.g. "ux-designer", "coding").
	Type string `json:"type"`

	// Context provides additional key-value pairs passed to the agent.
	// +optional
	Context map[string]string `json:"context,omitempty"`
}

// +kubebuilder:object:generate=true
// PipelineStage defines a stage in the agent pipeline.
type PipelineStage struct {
	// Name identifies this stage (e.g. "design", "coding", "validation").
	Name string `json:"name"`

	// Parallel indicates whether agents in this stage run concurrently.
	// +optional
	Parallel bool `json:"parallel,omitempty"`

	// Agents lists the agents to invoke in this stage.
	Agents []PipelineStageAgent `json:"agents"`
}

// +kubebuilder:object:generate=true
// AgentPipelineSpec defines the desired state of an AgentPipeline.
type AgentPipelineSpec struct {
	// TaskId links this pipeline to a task in DynamoDB.
	TaskId string `json:"taskId"`

	// Prompt is the user's original task description.
	Prompt string `json:"prompt"`

	// Repo is the git repository URL to operate on.
	// +optional
	Repo string `json:"repo,omitempty"`

	// RequiresApproval indicates whether risky actions need user approval.
	RequiresApproval bool `json:"requiresApproval"`

	// Stages defines the ordered sequence of agent stages.
	Stages []PipelineStage `json:"stages"`
}

// PipelinePhase describes the current lifecycle phase of the pipeline.
// +kubebuilder:validation:Enum=Pending;Planning;Running;AwaitingApproval;Completed;Failed
type PipelinePhase string

const (
	PipelinePhasePending          PipelinePhase = "Pending"
	PipelinePhasePlanning         PipelinePhase = "Planning"
	PipelinePhaseRunning          PipelinePhase = "Running"
	PipelinePhaseAwaitingApproval PipelinePhase = "AwaitingApproval"
	PipelinePhaseCompleted        PipelinePhase = "Completed"
	PipelinePhaseFailed           PipelinePhase = "Failed"
)

// +kubebuilder:object:generate=true
// AgentPipelineStatus defines the observed state of an AgentPipeline.
type AgentPipelineStatus struct {
	// Phase is the current pipeline lifecycle phase.
	Phase PipelinePhase `json:"phase,omitempty"`

	// CurrentStage is the name of the stage currently being executed.
	// +optional
	CurrentStage string `json:"currentStage,omitempty"`

	// CompletedStages lists stage names that have finished successfully.
	// +optional
	CompletedStages []string `json:"completedStages,omitempty"`

	// StartedAt is when the pipeline began executing.
	// +optional
	StartedAt *metav1.Time `json:"startedAt,omitempty"`

	// CompletedAt is when the pipeline finished.
	// +optional
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`

	// Error contains any error message if the pipeline failed.
	// +optional
	Error string `json:"error,omitempty"`

	// Conditions provide detailed status information.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Stage",type=string,JSONPath=`.status.currentStage`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// AgentPipeline is the Schema for the agentpipelines API.
// It represents a full multi-agent workflow triggered by a user task.
type AgentPipeline struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AgentPipelineSpec   `json:"spec,omitempty"`
	Status AgentPipelineStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AgentPipelineList contains a list of AgentPipeline.
type AgentPipelineList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentPipeline `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AgentPipeline{}, &AgentPipelineList{})
}
