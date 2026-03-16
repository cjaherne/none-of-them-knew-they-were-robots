package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:generate=true
// AgentTaskSpec defines the desired state of an AgentTask.
type AgentTaskSpec struct {
	// PipelineRef is the name of the parent AgentPipeline.
	PipelineRef string `json:"pipelineRef"`

	// AgentType is the agent type from the registry (e.g. "ux-designer").
	AgentType string `json:"agentType"`

	// Category is the agent category (analysis, design, coding, validation).
	Category string `json:"category"`

	// Prompt is the task description for this agent.
	Prompt string `json:"prompt"`

	// Context provides additional key-value pairs for this agent invocation.
	// +optional
	Context map[string]string `json:"context,omitempty"`

	// UpstreamResultRefs lists AgentTask names whose results should be passed as input.
	// +optional
	UpstreamResultRefs []string `json:"upstreamResultRefs,omitempty"`

	// SkillPack is the name of the skill pack directory to load.
	SkillPack string `json:"skillPack"`

	// Resources defines compute requirements for the agent pod.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// CursorFlags are additional flags passed to the Cursor CLI.
	// +optional
	CursorFlags []string `json:"cursorFlags,omitempty"`

	// Repo is the git repository URL for the agent to work on.
	// +optional
	Repo string `json:"repo,omitempty"`
}

// AgentTaskPhase describes the current lifecycle phase of an agent task.
// +kubebuilder:validation:Enum=Pending;Running;AwaitingApproval;Succeeded;Failed
type AgentTaskPhase string

const (
	AgentTaskPhasePending          AgentTaskPhase = "Pending"
	AgentTaskPhaseRunning          AgentTaskPhase = "Running"
	AgentTaskPhaseAwaitingApproval AgentTaskPhase = "AwaitingApproval"
	AgentTaskPhaseSucceeded        AgentTaskPhase = "Succeeded"
	AgentTaskPhaseFailed           AgentTaskPhase = "Failed"
)

// +kubebuilder:object:generate=true
// AgentTaskStatus defines the observed state of an AgentTask.
type AgentTaskStatus struct {
	// Phase is the current task lifecycle phase.
	Phase AgentTaskPhase `json:"phase,omitempty"`

	// JobName is the name of the K8s Job created for this task.
	// +optional
	JobName string `json:"jobName,omitempty"`

	// ResultKey is the S3 key where the agent's result JSON is stored.
	// +optional
	ResultKey string `json:"resultKey,omitempty"`

	// FilesModified lists files changed by this agent.
	// +optional
	FilesModified []string `json:"filesModified,omitempty"`

	// StartedAt is when the agent began executing.
	// +optional
	StartedAt *metav1.Time `json:"startedAt,omitempty"`

	// CompletedAt is when the agent finished.
	// +optional
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`

	// Error contains any error message if the task failed.
	// +optional
	Error string `json:"error,omitempty"`

	// Conditions provide detailed status information.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Agent",type=string,JSONPath=`.spec.agentType`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Pipeline",type=string,JSONPath=`.spec.pipelineRef`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// AgentTask is the Schema for the agenttasks API.
// It represents a single agent's work unit within an AgentPipeline.
type AgentTask struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AgentTaskSpec   `json:"spec,omitempty"`
	Status AgentTaskStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AgentTaskList contains a list of AgentTask.
type AgentTaskList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentTask `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AgentTask{}, &AgentTaskList{})
}
