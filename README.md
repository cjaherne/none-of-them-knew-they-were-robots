# None of Them Knew They Were Robots

A voice-controlled multi-agent AI design and development team running on AWS EKS with a custom Kubernetes operator.

## Overview

Speak a task into your phone, and a team of specialist AI agents -- designers, coders, testers -- collaborate via Cursor CLI headless to complete it. The system is built on an extensible framework where adding a new agent type requires only configuration, not code.

### Agent Team

Agents are organised into categories that define their pipeline position:

| Category | Agents | Role | MCP Tools |
|----------|--------|------|-----------|
| **Analysis** | BigBoss | Analyses tasks, plans agent pipelines | Filesystem, GitHub |
| **Design** | UX Designer | User flows, wireframes, accessibility | Filesystem, Playwright |
| **Design** | Core Code Designer | Architecture, data models, API contracts | Filesystem, GitHub |
| **Design** | Graphics Designer | Color palettes, typography, CSS tokens | Filesystem |
| **Coding** | Coding Agent | Implements code from design specs | Filesystem, GitHub |
| **Validation** | Testing Agent | Unit tests, integration tests, E2E | Filesystem, Playwright |

New specialist agents can be added by creating a skill pack directory and a registry entry -- no code changes needed.

### Architecture

```
Phone (voice/text) --> API Gateway --> Lambda (transcribe + parse)
                                           |
                                           v
                                    DynamoDB (task state)
                                           |
                                           v
                                  K8s API (AgentPipeline CRD)
                                           |
                                           v
                           +----- EKS Cluster ------+
                           |                        |
                           |  Pipeline Controller   |
                           |    (watches pipelines, |
                           |     manages stages)    |
                           |         |              |
                           |         v              |
                           |  Task Controller       |
                           |    (creates K8s Jobs   |
                           |     per agent)         |
                           |         |              |
                           |         v              |
                           |  Agent Runtime Pods    |
                           |    (Cursor CLI         |
                           |     headless)          |
                           |                        |
                           +--- Karpenter ----------+
                                (scale to zero)
                                     |
                                     v
                            Result --> TTS --> Voice Response
```

### Custom Resource Definitions

The operator manages two CRDs:

- **AgentPipeline** -- a full multi-agent workflow (design -> code -> test)
- **AgentTask** -- a single agent's work unit within a pipeline

```bash
kubectl get agentpipelines    # or: kubectl get ap
kubectl get agenttasks        # or: kubectl get at
```

## Project Structure

```
├── operator/               Go kubebuilder operator (CRDs + controllers)
├── agent-runtime/          Base agent container (TypeScript + Cursor CLI)
├── packages/
│   ├── shared/             Types, config, safety rules
│   ├── services/           Transcription, LLM, TTS, task store, skill loader
│   └── api/                REST + WebSocket Lambda handlers + setup endpoints
├── skills/                 Agent skill packs + registry (hot-configurable)
├── scripts/                Setup scripts (GitHub PAT, Cursor API key)
├── helm/agent-system/      Helm chart for K8s deployment
├── infra/                  AWS CDK (EKS, DynamoDB, S3, API Gateway)
├── test-harness/           Local MVP test harness (Express + agent CLI)
└── client/web/             Browser UI (works with both cloud and local)
```

## Prerequisites

### Full cloud deployment

- Node.js 20+
- Go 1.22+ (for the operator)
- Docker
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- kubectl
- Helm 3
- An OpenAI API key in AWS Secrets Manager
- A Cursor API key
- A GitHub account with a Personal Access Token (PAT) that has `repo` scope

### Local MVP testing (no cloud required)

- Node.js 20+
- The Cursor Agent CLI (`agent`) installed locally
- Git
- (Optional) An OpenAI API key -- enables lightweight BigBoss routing, voice transcription (Whisper), and AI-powered design/feedback summaries. Without it, BigBoss falls back to the full agent CLI and voice input uses browser-native SpeechRecognition.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Store secrets

```bash
# OpenAI key for transcription and intent parsing
aws secretsmanager create-secret \
  --name dev/openai-api-key \
  --secret-string "sk-your-openai-key"
```

### 3. Deploy infrastructure

```bash
cd infra
npx cdk bootstrap   # first time only
npx cdk deploy --all
```

This creates the EKS cluster, DynamoDB tables, S3 buckets, ECR repos, API Gateway, and deploys the Helm chart.

### 4. Build and push container images

```bash
# Get ECR login
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com

# Build and push the operator
cd operator
make docker-build IMG=<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/dev-agent-operator:latest
make docker-push IMG=<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/dev-agent-operator:latest

# Build and push the agent runtime
make docker-build-agent AGENT_IMG=<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/dev-agent-runtime:latest
make docker-push-agent AGENT_IMG=<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/dev-agent-runtime:latest
```

### 5. Configure GitHub credentials

Agents need access to your GitHub account to clone private repos and push changes. Run the setup script:

```bash
bash scripts/setup-github.sh
```

This will prompt you for:

- **GitHub Personal Access Token** -- create one at https://github.com/settings/tokens with `repo` scope
- **Git commit username** -- defaults to your GitHub display name
- **Git commit email** -- defaults to your GitHub noreply address

The script validates the token against the GitHub API and creates a Kubernetes secret (`github-credentials`) in the agent namespace.

You can also set these as environment variables for non-interactive use:

```bash
GITHUB_TOKEN=ghp_xxxx GIT_USER_NAME="Your Name" GIT_USER_EMAIL="you@example.com" \
  bash scripts/setup-github.sh
```

**Via API (alternative):**

```bash
curl -X POST https://YOUR_API/setup/github \
  -H "Content-Type: application/json" \
  -d '{"token": "ghp_xxxx", "username": "Your Name", "email": "you@example.com"}'
```

Check configuration status at any time:

```bash
curl https://YOUR_API/setup/status
```

### 6. Create the Cursor API key secret in K8s

```bash
bash scripts/setup-cursor.sh
```

Or manually:

```bash
kubectl create secret generic cursor-api-key \
  --namespace agent-system \
  --from-literal=api-key=your-cursor-api-key
```

### 7. Upload skill packs to S3

```bash
aws s3 sync skills/ s3://dev-agent-skills-<ACCOUNT>/
```

### 8. Configure the web client

Set the API Gateway URL in the web client:

```javascript
localStorage.setItem("apiBase", "https://your-api-id.execute-api.region.amazonaws.com/prod");
localStorage.setItem("wsUrl", "wss://your-ws-id.execute-api.region.amazonaws.com/dev");
```

## Usage

### Local MVP test harness

The fastest way to try the system. Runs the full multi-stage pipeline (design, coding, testing) locally using the Cursor Agent CLI with an interactive BigBoss orchestrator:

```bash
cd test-harness
cp .env.local.example .env.local   # add your OPENAI_API_KEY here (optional)
npm install
npx tsx src/server.ts
```

Open http://localhost:3000 and configure:

- **Workspace** -- local directory where the agent will create files (e.g. `C:\dev\my-project`)
- **Repo** -- GitHub repo URL (optional, for clone + push)
- **Base branch** -- branch to fork from (default: `main`)
- **Work branch** -- name for the new branch (auto-generated if blank)
- **Pipeline mode** -- Auto (BigBoss decides), Full, Code+Test, or Code Only
- **Voice** -- toggle spoken status updates and design approval announcements
- **Require design approval** -- pause the pipeline after the design stage for human review

#### Voice input

Click the microphone button to speak your prompt. In Chrome/Edge, the browser's native SpeechRecognition transcribes your speech in real-time and auto-submits. For other browsers, audio is sent to the server for OpenAI Whisper transcription (requires `OPENAI_API_KEY`).

#### Interactive pipeline

The pipeline now supports human-in-the-loop checkpoints:

- **Design approval** -- after the design agent produces `DESIGN.md`, BigBoss summarises the design and presents it for review. You can approve, request changes (with written feedback that gets fed back to the designer), or reject.
- **Coding feedback** -- if the coding agent writes `CODING_NOTES.md` (flagging design issues encountered during implementation), BigBoss summarises the feedback and lets you choose to continue to testing or re-run the design stage with the coding notes as context.
- **Pipeline cancellation** -- click Stop at any time to abort the running agent and cancel the pipeline.

#### Context passing

Agents receive rich, role-specific codebase context injected directly into their prompts:

- **Design agents** get the full file tree, tech stack detection, git history, branch diff stats, project config files, and key architectural source files (entry points, types, interfaces).
- **Coding agents** get the file tree, the full `DESIGN.md` content (no disk read needed), project config, and upstream handoff files.
- **Testing agents** get `DESIGN.md`, existing test patterns with code samples, npm scripts, and upstream handoffs.
- **BigBoss** acts as a **context broker** -- it receives a workspace summary and produces per-agent focus briefs (1-3 sentences) telling each agent exactly which files and patterns to pay attention to.

A **codebase summary cache** (`.pipeline/context-cache.json`) persists per-file purpose summaries with incremental git-diff updates, so repeated pipeline runs don't re-analyse unchanged files.

#### Parallel design stages

For complex tasks, BigBoss can fan out design work to multiple specialist designers (UX, Core Code, Graphics) running in parallel. Each writes to `.pipeline/<agent>-design.md`, and the orchestrator merges them into a unified `DESIGN.md` (via OpenAI merge or concatenation fallback) before passing to the coding stage.

Debug logs are written to `%TEMP%/agent-mvp-logs`.

### Voice command (cloud)

1. Open `client/web/index.html` on your phone
2. Tap the microphone button
3. Speak: "Build a login page with social authentication"
4. Watch the task log for progress

### Text command

Type a command in the text input and press Send.

### API (cloud)

```bash
# Submit a task
curl -X POST https://YOUR_API/voice-command \
  -H "Content-Type: application/json" \
  -d '{"text": "Refactor the auth module and add tests"}'

# Check setup status (GitHub + Cursor credentials)
curl https://YOUR_API/setup/status

# Get task status
curl https://YOUR_API/tasks/{taskId}
```

### Direct K8s pipeline

```yaml
kubectl apply -f - <<EOF
apiVersion: agents.robots.io/v1alpha1
kind: AgentPipeline
metadata:
  name: my-pipeline
  namespace: agent-system
spec:
  taskId: "manual-001"
  prompt: "Add dark mode support to the settings page"
  repo: "https://github.com/org/repo.git"
  requiresApproval: true
  stages:
    - name: design
      parallel: true
      agents:
        - type: ux-designer
        - type: graphics-designer
    - name: coding
      agents:
        - type: coding
    - name: validation
      agents:
        - type: testing
EOF
```

## Adding a New Agent Type

Adding a specialist agent (e.g., a Database Migration Agent) requires **zero code changes**:

### 1. Create a skill pack

```
skills/db-migration/
├── system-prompt.md      # Agent persona, expertise, output format
├── constraints.json      # Guardrails (max tokens, timeouts, forbidden actions)
├── mcp-config.json       # MCP servers the agent needs (use ${ENV_VAR} for secrets)
├── tools.json            # Optional: tool preference descriptions
└── rules/                # Cursor rules (multi-file, injected into .cursor/rules/)
    ├── role.md           # Agent role and behaviour constraints
    ├── output-format.md  # Expected output structure with examples
    ├── examples.md       # 2-3 few-shot input/output examples
    └── checklist.md      # Domain-specific quality checklist
```

### 2. Register in the agent registry

Add an entry to `skills/registry.yaml`:

```yaml
  - type: db-migration
    displayName: Database Migration Specialist
    category: coding
    skillPack: db-migration
    resources:
      memory: "2Gi"
      cpu: "1"
    cursorFlags: ["--force", "--trust", "--output-format", "stream-json"]
```

### 3. Sync and use

```bash
aws s3 sync skills/ s3://dev-agent-skills-<ACCOUNT>/
```

The new agent is immediately available for use in pipeline stages.

## How It Works

### Agent Specialisation

Each agent runs the same base container image. Specialisation happens through multiple complementary mechanisms:

| Layer | What it does | Example |
|-------|-------------|---------|
| **System prompt** | Defines the agent's persona, expertise, and output format | "You are a senior UX designer..." |
| **Cursor rules** | Multi-file rules injected into `.cursor/rules/` with role, output format, few-shot examples, and domain checklists | `rules/role.md`, `rules/examples.md` |
| **MCP servers** | Per-agent external tools (GitHub API, Playwright browser, filesystem) | UX Designer gets Playwright for screenshots |
| **Tool preferences** | `tools.json` describing which tools the agent should favour | Coding agent: create_file, modify_file |
| **Constraints** | Enforced guardrails: forbidden actions, required output fields (with retry), timeouts | Designers forbidden from writing code |

The agent lifecycle:

1. Load skill pack from S3 (system prompt, rules, constraints, MCP config, tools)
2. Clone the target repo (authenticated via GitHub PAT) to `/workspace`
3. Configure git identity (user name, email, credential helper)
4. Write cursor rules files to `/workspace/.cursor/rules/` (multiple `.md` files)
5. Write MCP config to `/workspace/.cursor/mcp.json` (with env var templating for secrets)
6. Build prompt: role preamble + BigBoss context brief + file tree + git history + design doc + upstream handoffs + system prompt + task + tool hints
7. Run `cursor-agent -p --force --trust --output-format stream-json "<prompt>"`
8. Validate output: check forbidden actions, verify required fields (retry once if missing)
9. Commit and push changes to a branch (`agent/<pipeline>/<agent-type>`)
10. Report results (including commit SHA) to S3 and DynamoDB

### Operator Pipeline Flow

1. **AgentPipeline** created (via API or kubectl)
2. **PipelineController** sets phase to Running, creates AgentTasks for the first stage
3. **TaskController** creates a K8s Job per AgentTask with the base agent container
4. Jobs run Cursor CLI headless with injected skill packs
5. On completion, PipelineController advances to the next stage
6. When all stages complete, pipeline is marked Completed

### Safety Controls

- Risky action detection (git push, file deletion, dependency installs)
- Forbidden action enforcement per agent (`constraints.json`)
- Required output field validation with automatic retry
- Approval workflow (pipeline pauses, notifies user)
- Sensitive file protection (.env, credentials, keys)
- Sandbox mode (each agent gets an isolated workspace)

## Development

```bash
# Build TypeScript packages
npm run build

# Build the operator
cd operator && make build

# Run operator locally (with kubeconfig)
cd operator && make run

# Run the local test harness
cd test-harness && npx tsx src/server.ts

# Type-check everything
npx tsc --noEmit -p packages/shared/tsconfig.json
npx tsc --noEmit -p packages/services/tsconfig.json
npx tsc --noEmit -p packages/api/tsconfig.json
npx tsc --noEmit -p agent-runtime/tsconfig.json
npx tsc --noEmit -p infra/tsconfig.json
npx tsc --noEmit -p test-harness/tsconfig.json
```

### Local environment variables

The test harness loads environment variables from `test-harness/.env.local` (gitignored). Copy the example file and add your keys:

```bash
cd test-harness
cp .env.local.example .env.local
```

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENAI_API_KEY` | Lightweight BigBoss routing (gpt-4o-mini), Whisper voice transcription, design/feedback summarisation | Optional |
| `PORT` | Override the default port (3000) | Optional |
| `SKILLS_ROOT` | Override the skills directory path | Optional |
| `CURSOR_CLI` | Override the Cursor agent CLI path | Optional |

## Licence

Apache 2.0
