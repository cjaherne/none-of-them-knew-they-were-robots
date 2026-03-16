package controllers

import (
	"context"
	"fmt"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	agentsv1alpha1 "github.com/none-of-them-knew-they-were-robots/operator/api/v1alpha1"
)

type AgentTaskReconciler struct {
	client.Client
	Scheme           *runtime.Scheme
	AgentImage       string
	SkillsBucket     string
	ResultsTable     string
	GitHubSecretName string
}

// +kubebuilder:rbac:groups=agents.robots.io,resources=agenttasks,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agents.robots.io,resources=agenttasks/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agents.robots.io,resources=agenttasks/finalizers,verbs=update
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete

func (r *AgentTaskReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var task agentsv1alpha1.AgentTask
	if err := r.Get(ctx, req.NamespacedName, &task); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	switch task.Status.Phase {
	case "", agentsv1alpha1.AgentTaskPhasePending:
		return r.handlePending(ctx, &task)
	case agentsv1alpha1.AgentTaskPhaseRunning:
		return r.handleRunning(ctx, &task)
	case agentsv1alpha1.AgentTaskPhaseSucceeded, agentsv1alpha1.AgentTaskPhaseFailed:
		return ctrl.Result{}, nil
	}

	return ctrl.Result{}, nil
}

func (r *AgentTaskReconciler) handlePending(ctx context.Context, task *agentsv1alpha1.AgentTask) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	jobName := fmt.Sprintf("%s-job", task.Name)

	existing := &batchv1.Job{}
	err := r.Get(ctx, types.NamespacedName{Name: jobName, Namespace: task.Namespace}, existing)
	if err == nil {
		// Job already exists, update status to Running
		now := metav1.Now()
		task.Status.Phase = agentsv1alpha1.AgentTaskPhaseRunning
		task.Status.JobName = jobName
		task.Status.StartedAt = &now
		return ctrl.Result{}, r.Status().Update(ctx, task)
	}
	if !errors.IsNotFound(err) {
		return ctrl.Result{}, err
	}

	job := r.buildJob(task, jobName)
	if err := controllerutil.SetControllerReference(task, job, r.Scheme); err != nil {
		return ctrl.Result{}, err
	}

	if err := r.Create(ctx, job); err != nil {
		return ctrl.Result{}, err
	}

	now := metav1.Now()
	task.Status.Phase = agentsv1alpha1.AgentTaskPhaseRunning
	task.Status.JobName = jobName
	task.Status.StartedAt = &now

	if err := r.Status().Update(ctx, task); err != nil {
		return ctrl.Result{}, err
	}

	logger.Info("created job for agent task", "job", jobName, "agent", task.Spec.AgentType)
	postLogEntry(task.Spec.PipelineRef, "INFO", "operator:task", fmt.Sprintf("Task %s running (agent: %s)", task.Name, task.Spec.AgentType), "status", map[string]interface{}{"task": task.Name, "agent": task.Spec.AgentType, "job": jobName})
	return ctrl.Result{}, nil
}

func (r *AgentTaskReconciler) handleRunning(ctx context.Context, task *agentsv1alpha1.AgentTask) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	if task.Status.JobName == "" {
		return ctrl.Result{}, fmt.Errorf("running task %s has no job name", task.Name)
	}

	var job batchv1.Job
	if err := r.Get(ctx, types.NamespacedName{Name: task.Status.JobName, Namespace: task.Namespace}, &job); err != nil {
		if errors.IsNotFound(err) {
			return r.failTask(ctx, task, "job disappeared")
		}
		return ctrl.Result{}, err
	}

	if job.Status.Succeeded > 0 {
		now := metav1.Now()
		task.Status.Phase = agentsv1alpha1.AgentTaskPhaseSucceeded
		task.Status.CompletedAt = &now
		task.Status.ResultKey = fmt.Sprintf("results/%s/%s.json", task.Spec.PipelineRef, task.Name)

		if err := r.Status().Update(ctx, task); err != nil {
			return ctrl.Result{}, err
		}

		logger.Info("agent task succeeded", "task", task.Name, "agent", task.Spec.AgentType)
		postLogEntry(task.Spec.PipelineRef, "INFO", "operator:task", fmt.Sprintf("Task %s succeeded (agent: %s)", task.Name, task.Spec.AgentType), "output", map[string]interface{}{"task": task.Name, "agent": task.Spec.AgentType})
		return ctrl.Result{}, nil
	}

	if job.Status.Failed > 0 {
		return r.failTask(ctx, task, "job failed")
	}

	// Still running -- requeue
	return ctrl.Result{RequeueAfter: 5_000_000_000}, nil // 5 seconds
}

func (r *AgentTaskReconciler) buildJob(task *agentsv1alpha1.AgentTask, jobName string) *batchv1.Job {
	backoffLimit := int32(1)
	ttlSeconds := int32(3600)

	env := []corev1.EnvVar{
		{Name: "AGENT_TYPE", Value: task.Spec.AgentType},
		{Name: "AGENT_CATEGORY", Value: task.Spec.Category},
		{Name: "SKILL_PACK", Value: task.Spec.SkillPack},
		{Name: "PIPELINE_REF", Value: task.Spec.PipelineRef},
		{Name: "TASK_NAME", Value: task.Name},
		{Name: "PROMPT", Value: task.Spec.Prompt},
		{Name: "REPO", Value: task.Spec.Repo},
		{Name: "SKILLS_BUCKET", Value: r.SkillsBucket},
		{Name: "RESULTS_TABLE", Value: r.ResultsTable},
		{Name: "UPSTREAM_REFS", Value: strings.Join(task.Spec.UpstreamResultRefs, ",")},
		{Name: "CURSOR_FLAGS", Value: strings.Join(task.Spec.CursorFlags, " ")},
	}

	// Add context as env vars with CONTEXT_ prefix
	for k, v := range task.Spec.Context {
		env = append(env, corev1.EnvVar{
			Name:  fmt.Sprintf("CONTEXT_%s", strings.ToUpper(strings.ReplaceAll(k, "-", "_"))),
			Value: v,
		})
	}

	// Add Cursor API key from K8s secret
	env = append(env, corev1.EnvVar{
		Name: "CURSOR_API_KEY",
		ValueFrom: &corev1.EnvVarSource{
			SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: "cursor-api-key"},
				Key:                  "api-key",
			},
		},
	})

	// Add GitHub credentials from K8s secret
	githubSecret := r.GitHubSecretName
	if githubSecret == "" {
		githubSecret = "github-credentials"
	}
	env = append(env,
		corev1.EnvVar{
			Name: "GITHUB_TOKEN",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: githubSecret},
					Key:                  "token",
				},
			},
		},
		corev1.EnvVar{
			Name: "GIT_USER_NAME",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: githubSecret},
					Key:                  "username",
				},
			},
		},
		corev1.EnvVar{
			Name: "GIT_USER_EMAIL",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: githubSecret},
					Key:                  "email",
				},
			},
		},
	)

	// Resource defaults
	memoryRequest := "2Gi"
	cpuRequest := "1"
	if task.Spec.Resources.Requests != nil {
		if m, ok := task.Spec.Resources.Requests[corev1.ResourceMemory]; ok {
			memoryRequest = m.String()
		}
		if c, ok := task.Spec.Resources.Requests[corev1.ResourceCPU]; ok {
			cpuRequest = c.String()
		}
	}

	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: task.Namespace,
			Labels: map[string]string{
				"agents.robots.io/pipeline": task.Spec.PipelineRef,
				"agents.robots.io/task":     task.Name,
				"agents.robots.io/agent":    task.Spec.AgentType,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoffLimit,
			TTLSecondsAfterFinished: &ttlSeconds,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"agents.robots.io/pipeline": task.Spec.PipelineRef,
						"agents.robots.io/task":     task.Name,
						"agents.robots.io/agent":    task.Spec.AgentType,
					},
				},
				Spec: corev1.PodSpec{
					RestartPolicy:      corev1.RestartPolicyNever,
					ServiceAccountName: "agent-runtime",
					Containers: []corev1.Container{
						{
							Name:  "agent",
							Image: r.AgentImage,
							Env:   env,
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceMemory: resource.MustParse(memoryRequest),
									corev1.ResourceCPU:    resource.MustParse(cpuRequest),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceMemory: resource.MustParse(memoryRequest),
								},
							},
							VolumeMounts: []corev1.VolumeMount{
								{Name: "workspace", MountPath: "/workspace"},
							},
						},
					},
					Volumes: []corev1.Volume{
						{
							Name: "workspace",
							VolumeSource: corev1.VolumeSource{
								EmptyDir: &corev1.EmptyDirVolumeSource{},
							},
						},
					},
				},
			},
		},
	}
}

func (r *AgentTaskReconciler) failTask(ctx context.Context, task *agentsv1alpha1.AgentTask, reason string) (ctrl.Result, error) {
	now := metav1.Now()
	task.Status.Phase = agentsv1alpha1.AgentTaskPhaseFailed
	task.Status.Error = reason
	task.Status.CompletedAt = &now
	if err := r.Status().Update(ctx, task); err != nil {
		return ctrl.Result{}, err
	}
	postLogEntry(task.Spec.PipelineRef, "ERROR", "operator:task", fmt.Sprintf("Task %s failed: %s", task.Name, reason), "error", map[string]interface{}{"task": task.Name, "agent": task.Spec.AgentType, "reason": reason})
	return ctrl.Result{}, nil
}

func (r *AgentTaskReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentsv1alpha1.AgentTask{}).
		Owns(&batchv1.Job{}).
		Complete(r)
}
