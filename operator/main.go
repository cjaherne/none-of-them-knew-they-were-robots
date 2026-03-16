package main

import (
	"flag"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	agentsv1alpha1 "github.com/none-of-them-knew-they-were-robots/operator/api/v1alpha1"
	"github.com/none-of-them-knew-they-were-robots/operator/controllers"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(agentsv1alpha1.AddToScheme(scheme))
}

func main() {
	var metricsAddr string
	var probeAddr string
	var enableLeaderElection bool
	var agentImage string
	var skillsBucket string
	var resultsTable string
	var agentNamespace string
	var githubSecretName string

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false, "Enable leader election for controller manager.")
	flag.StringVar(&agentImage, "agent-image", "", "Container image URI for the base agent runtime.")
	flag.StringVar(&skillsBucket, "skills-bucket", "", "S3 bucket containing agent skill packs.")
	flag.StringVar(&resultsTable, "results-table", "", "DynamoDB table for agent results.")
	flag.StringVar(&agentNamespace, "agent-namespace", "agent-system", "Namespace for agent workloads.")
	flag.StringVar(&githubSecretName, "github-secret-name", "github-credentials", "K8s Secret name containing GitHub PAT and identity.")

	opts := zap.Options{Development: true}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	if agentImage == "" {
		agentImage = os.Getenv("AGENT_IMAGE_URI")
	}
	if skillsBucket == "" {
		skillsBucket = os.Getenv("SKILLS_BUCKET")
	}
	if resultsTable == "" {
		resultsTable = os.Getenv("AGENT_RESULTS_TABLE")
	}

	if logURL := os.Getenv("LOG_API_URL"); logURL != "" {
		controllers.SetLogAPIURL(logURL)
		setupLog.Info("log API URL configured", "url", logURL)
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "agent-operator-leader.robots.io",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	if err = (&controllers.AgentPipelineReconciler{
		Client:         mgr.GetClient(),
		Scheme:         mgr.GetScheme(),
		AgentNamespace: agentNamespace,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "AgentPipeline")
		os.Exit(1)
	}

	if err = (&controllers.AgentTaskReconciler{
		Client:           mgr.GetClient(),
		Scheme:           mgr.GetScheme(),
		AgentImage:       agentImage,
		SkillsBucket:     skillsBucket,
		ResultsTable:     resultsTable,
		GitHubSecretName: githubSecretName,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "AgentTask")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
