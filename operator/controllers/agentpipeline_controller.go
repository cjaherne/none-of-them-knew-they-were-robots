package controllers

import (
	"context"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	agentsv1alpha1 "github.com/none-of-them-knew-they-were-robots/operator/api/v1alpha1"
)

type AgentPipelineReconciler struct {
	client.Client
	Scheme         *runtime.Scheme
	AgentNamespace string
}

// +kubebuilder:rbac:groups=agents.robots.io,resources=agentpipelines,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agents.robots.io,resources=agentpipelines/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=agents.robots.io,resources=agentpipelines/finalizers,verbs=update
// +kubebuilder:rbac:groups=agents.robots.io,resources=agenttasks,verbs=get;list;watch;create;update;patch;delete

func (r *AgentPipelineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var pipeline agentsv1alpha1.AgentPipeline
	if err := r.Get(ctx, req.NamespacedName, &pipeline); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	switch pipeline.Status.Phase {
	case "", agentsv1alpha1.PipelinePhasePending:
		return r.handlePending(ctx, &pipeline)
	case agentsv1alpha1.PipelinePhaseRunning:
		return r.handleRunning(ctx, &pipeline)
	case agentsv1alpha1.PipelinePhaseAwaitingApproval:
		return r.handleAwaitingApproval(ctx, &pipeline)
	case agentsv1alpha1.PipelinePhaseCompleted, agentsv1alpha1.PipelinePhaseFailed:
		return ctrl.Result{}, nil
	}

	return ctrl.Result{}, nil
}

func (r *AgentPipelineReconciler) handlePending(ctx context.Context, pipeline *agentsv1alpha1.AgentPipeline) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	if len(pipeline.Spec.Stages) == 0 {
		return r.failPipeline(ctx, pipeline, "pipeline has no stages defined")
	}

	now := metav1.Now()
	pipeline.Status.Phase = agentsv1alpha1.PipelinePhaseRunning
	pipeline.Status.StartedAt = &now
	pipeline.Status.CurrentStage = pipeline.Spec.Stages[0].Name
	pipeline.Status.CompletedStages = []string{}

	if err := r.Status().Update(ctx, pipeline); err != nil {
		return ctrl.Result{}, err
	}

	logger.Info("pipeline started", "stage", pipeline.Status.CurrentStage)
	postLogEntry(pipeline.Spec.TaskId, "INFO", "operator:pipeline", fmt.Sprintf("Pipeline %s started, first stage: %s", pipeline.Name, pipeline.Status.CurrentStage), "flow", map[string]interface{}{"pipeline": pipeline.Name, "stage": pipeline.Status.CurrentStage})
	return r.createTasksForCurrentStage(ctx, pipeline)
}

func (r *AgentPipelineReconciler) handleRunning(ctx context.Context, pipeline *agentsv1alpha1.AgentPipeline) (ctrl.Result, error) {
	currentStage := r.getCurrentStage(pipeline)
	if currentStage == nil {
		return r.failPipeline(ctx, pipeline, "current stage not found in spec")
	}

	tasks, err := r.listTasksForStage(ctx, pipeline, currentStage.Name)
	if err != nil {
		return ctrl.Result{}, err
	}

	if len(tasks) == 0 {
		return r.createTasksForCurrentStage(ctx, pipeline)
	}

	allSucceeded := true
	anyFailed := false
	anyAwaitingApproval := false
	anyRunning := false

	for _, task := range tasks {
		switch task.Status.Phase {
		case agentsv1alpha1.AgentTaskPhaseSucceeded:
			continue
		case agentsv1alpha1.AgentTaskPhaseFailed:
			anyFailed = true
		case agentsv1alpha1.AgentTaskPhaseAwaitingApproval:
			anyAwaitingApproval = true
			allSucceeded = false
		default:
			anyRunning = true
			allSucceeded = false
		}
	}

	if anyFailed {
		return r.failPipeline(ctx, pipeline, fmt.Sprintf("agent task failed in stage %s", currentStage.Name))
	}

	if anyAwaitingApproval {
		pipeline.Status.Phase = agentsv1alpha1.PipelinePhaseAwaitingApproval
		if err := r.Status().Update(ctx, pipeline); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if anyRunning {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}

	if allSucceeded {
		return r.advanceToNextStage(ctx, pipeline)
	}

	return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
}

func (r *AgentPipelineReconciler) handleAwaitingApproval(ctx context.Context, pipeline *agentsv1alpha1.AgentPipeline) (ctrl.Result, error) {
	currentStage := r.getCurrentStage(pipeline)
	if currentStage == nil {
		return ctrl.Result{}, nil
	}

	tasks, err := r.listTasksForStage(ctx, pipeline, currentStage.Name)
	if err != nil {
		return ctrl.Result{}, err
	}

	// Check if all approval-waiting tasks have been resolved
	anyStillWaiting := false
	for _, task := range tasks {
		if task.Status.Phase == agentsv1alpha1.AgentTaskPhaseAwaitingApproval {
			anyStillWaiting = true
			break
		}
	}

	if !anyStillWaiting {
		pipeline.Status.Phase = agentsv1alpha1.PipelinePhaseRunning
		if err := r.Status().Update(ctx, pipeline); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

func (r *AgentPipelineReconciler) advanceToNextStage(ctx context.Context, pipeline *agentsv1alpha1.AgentPipeline) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	pipeline.Status.CompletedStages = append(pipeline.Status.CompletedStages, pipeline.Status.CurrentStage)

	nextIdx := len(pipeline.Status.CompletedStages)
	if nextIdx >= len(pipeline.Spec.Stages) {
		now := metav1.Now()
		pipeline.Status.Phase = agentsv1alpha1.PipelinePhaseCompleted
		pipeline.Status.CompletedAt = &now
		pipeline.Status.CurrentStage = ""

		if err := r.Status().Update(ctx, pipeline); err != nil {
			return ctrl.Result{}, err
		}

		logger.Info("pipeline completed", "pipeline", pipeline.Name)
		postLogEntry(pipeline.Spec.TaskId, "INFO", "operator:pipeline", fmt.Sprintf("Pipeline %s completed", pipeline.Name), "output", map[string]interface{}{"pipeline": pipeline.Name})
		return ctrl.Result{}, nil
	}

	pipeline.Status.CurrentStage = pipeline.Spec.Stages[nextIdx].Name
	if err := r.Status().Update(ctx, pipeline); err != nil {
		return ctrl.Result{}, err
	}

	logger.Info("advancing to next stage", "stage", pipeline.Status.CurrentStage)
	postLogEntry(pipeline.Spec.TaskId, "INFO", "operator:pipeline", fmt.Sprintf("Advancing to stage: %s", pipeline.Status.CurrentStage), "status", map[string]interface{}{"pipeline": pipeline.Name, "stage": pipeline.Status.CurrentStage})
	return r.createTasksForCurrentStage(ctx, pipeline)
}

func (r *AgentPipelineReconciler) createTasksForCurrentStage(ctx context.Context, pipeline *agentsv1alpha1.AgentPipeline) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	stage := r.getCurrentStage(pipeline)
	if stage == nil {
		return ctrl.Result{}, fmt.Errorf("current stage %s not found", pipeline.Status.CurrentStage)
	}

	// Collect upstream task names from completed stages for passing results
	var upstreamRefs []string
	for _, completedStageName := range pipeline.Status.CompletedStages {
		tasks, err := r.listTasksForStage(ctx, pipeline, completedStageName)
		if err != nil {
			return ctrl.Result{}, err
		}
		for _, t := range tasks {
			if t.Status.Phase == agentsv1alpha1.AgentTaskPhaseSucceeded {
				upstreamRefs = append(upstreamRefs, t.Name)
			}
		}
	}

	for _, agentDef := range stage.Agents {
		taskName := fmt.Sprintf("%s-%s", pipeline.Name, agentDef.Type)

		existing := &agentsv1alpha1.AgentTask{}
		err := r.Get(ctx, types.NamespacedName{Name: taskName, Namespace: pipeline.Namespace}, existing)
		if err == nil {
			continue // already created
		}
		if !errors.IsNotFound(err) {
			return ctrl.Result{}, err
		}

		task := &agentsv1alpha1.AgentTask{
			ObjectMeta: metav1.ObjectMeta{
				Name:      taskName,
				Namespace: pipeline.Namespace,
				Labels: map[string]string{
					"agents.robots.io/pipeline": pipeline.Name,
					"agents.robots.io/stage":    stage.Name,
					"agents.robots.io/agent":    agentDef.Type,
				},
			},
			Spec: agentsv1alpha1.AgentTaskSpec{
				PipelineRef:        pipeline.Name,
				AgentType:          agentDef.Type,
				Category:           stage.Name,
				Prompt:             pipeline.Spec.Prompt,
				Context:            agentDef.Context,
				UpstreamResultRefs: upstreamRefs,
				SkillPack:          agentDef.Type,
				Repo:               pipeline.Spec.Repo,
			},
		}

		if err := controllerutil.SetControllerReference(pipeline, task, r.Scheme); err != nil {
			return ctrl.Result{}, err
		}

		if err := r.Create(ctx, task); err != nil {
			return ctrl.Result{}, err
		}

		logger.Info("created agent task", "task", taskName, "agent", agentDef.Type, "stage", stage.Name)
	}

	return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
}

func (r *AgentPipelineReconciler) getCurrentStage(pipeline *agentsv1alpha1.AgentPipeline) *agentsv1alpha1.PipelineStage {
	for i := range pipeline.Spec.Stages {
		if pipeline.Spec.Stages[i].Name == pipeline.Status.CurrentStage {
			return &pipeline.Spec.Stages[i]
		}
	}
	return nil
}

func (r *AgentPipelineReconciler) listTasksForStage(ctx context.Context, pipeline *agentsv1alpha1.AgentPipeline, stageName string) ([]agentsv1alpha1.AgentTask, error) {
	var taskList agentsv1alpha1.AgentTaskList
	err := r.List(ctx, &taskList,
		client.InNamespace(pipeline.Namespace),
		client.MatchingLabels{
			"agents.robots.io/pipeline": pipeline.Name,
			"agents.robots.io/stage":    stageName,
		},
	)
	if err != nil {
		return nil, err
	}
	return taskList.Items, nil
}

func (r *AgentPipelineReconciler) failPipeline(ctx context.Context, pipeline *agentsv1alpha1.AgentPipeline, reason string) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	now := metav1.Now()
	pipeline.Status.Phase = agentsv1alpha1.PipelinePhaseFailed
	pipeline.Status.Error = reason
	pipeline.Status.CompletedAt = &now
	if err := r.Status().Update(ctx, pipeline); err != nil {
		return ctrl.Result{}, err
	}
	logger.Error(fmt.Errorf(reason), "pipeline failed", "pipeline", pipeline.Name)
	postLogEntry(pipeline.Spec.TaskId, "ERROR", "operator:pipeline", fmt.Sprintf("Pipeline %s failed: %s", pipeline.Name, reason), "error", map[string]interface{}{"pipeline": pipeline.Name, "reason": reason})
	return ctrl.Result{}, nil
}

func (r *AgentPipelineReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentsv1alpha1.AgentPipeline{}).
		Owns(&agentsv1alpha1.AgentTask{}).
		Complete(r)
}
