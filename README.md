# None of Them Knew They Were Robots

A voice-controlled multi-agent AI design and development team running on AWS EKS with a custom Kubernetes operator.

## Overview

Speak a task into your phone, and a team of specialist AI agents -- designers, coders, testers -- collaborate via Cursor CLI headless to complete it. The system is built on an extensible framework where adding a new agent type requires only configuration, not code.

### Agent Team

Agents are organised into categories that define their pipeline position:

| Category | Agents | Role | MCP Tools |
|----------|--------|------|-----------|
| **Analysis / Overseer** | BigBoss | Plans agent pipelines; runs Overseer reviews (design fit + code drift) | Filesystem, GitHub, Fetch, Sequential Thinking |
| **Design** | UX Designer | User flows, wireframes, accessibility, game UI (menus, HUD, split-screen) | Filesystem, Playwright, Fetch |
| **Design** | Core Code Designer | Architecture, data models, API contracts, Lua module architecture | Filesystem, GitHub, Fetch |
| **Design** | Graphics Designer | Color palettes, typography, CSS tokens, game art briefs (sprites, palettes, animations) | Filesystem, Fetch |
| **Design** | Game Designer | Game mechanics, controls (keyboard + gamepad), game loop, Lua/LÖVE2D structure | Filesystem, Fetch, Sequential Thinking |
| **Coding** | Coding Agent | Implements code (TypeScript, Python, web) from design specs | Filesystem, GitHub |
| **Coding** | Lua Coding Agent | Implements Lua and LÖVE2D games from design specs | Filesystem, GitHub, Fetch, Sequential Thinking |
| **Validation** | Testing Agent | Unit tests, integration tests, E2E, Lua/busted | Filesystem, Playwright, Fetch |
| **Release** | Release Agent | Updates README, bumps SemVer in appropriate version file, commits, creates and pushes version tag, creates PR | Filesystem, GitHub |

BigBoss uses a full stage/agent structure to select which designers and coders run (e.g. for Lua games: Game Designer + Lua Coding Agent; for web UI: UX + Graphics + Core Code Designer). BigBoss also acts as an **Overseer**: after design merge it runs a full agent-based design review (reading DESIGN.md via filesystem MCP); after coding it runs a code review (reading actual source files). If gaps or drift are found, the Overseer triggers up to 2 re-runs of the affected stage with focused feedback. All agents with game responsibilities have Lua/LÖVE expertise in their prompts: Core Code Designer knows Lua module architecture, UX Designer handles game menus/HUD/controller-navigable UI, and Graphics Designer outputs game art briefs instead of CSS tokens.

MCP capabilities: Fetch (web search via `uvx mcp-server-fetch`) is available to all design agents, Lua Coding, Testing, and BigBoss. Sequential Thinking is available to Game Designer, Lua Coding, and BigBoss for complex multi-step reasoning. New specialist agents can be added by creating a skill pack directory and a registry entry. The **Release** agent runs automatically at the end of every successful pipeline (when a repo is configured).

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
└── client/web/             Unified browser UI (local test harness + AWS cloud; backend adapter, responsive layout)
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

In the UI, set **Backend → Mode** to **AWS Cloud** and enter your **REST URL** and **WebSocket URL** (e.g. `https://your-api-id.execute-api.region.amazonaws.com/prod` and `wss://your-ws-id.execute-api.region.amazonaws.com/prod`). Values are stored in `localStorage`.

## Usage

### Local MVP test harness

The fastest way to try the system. Runs the full multi-stage pipeline (design, coding, testing) locally using the Cursor Agent CLI with an interactive BigBoss orchestrator:

```bash
cd test-harness
cp .env.local.example .env.local   # add your OPENAI_API_KEY here (optional)
npm install
npx tsx src/server.ts
```

Open http://localhost:3000. The same UI is used for the local test harness and for the AWS cloud deployment; use **Backend → Mode** to switch between **Local Test Harness** and **AWS Cloud** (cloud mode uses separate REST and WebSocket URLs). The layout is responsive: desktop shows a 300px sidebar (command + config) and a main panel (pipeline, approval, event log); below 768px the sidebar collapses and can be toggled via Settings. Use the **Live** / **History** tabs to switch between the current run and a list of past tasks with their full log timelines.

Configure in the sidebar:

- **Workspace** -- local directory where the agent will create files (e.g. `C:\dev\my-project`) (local only)
- **Repo** -- GitHub repo URL (optional, for clone + push) (local only)
- **Base branch** / **Work branch** -- branch to fork from and name for the new branch (local only)
- **Pipeline mode** -- Auto (BigBoss decides), Full, Code+Test, or Code Only (local only)
- **Voice** -- toggle spoken status updates and design approval announcements (local only)
- **Require design approval** -- pause the pipeline after the design stage for human review (local only)
- **Log level** -- DEBUG, INFO, WARN, or ERROR; controls which log entries are captured and shown (local only; default INFO)

#### Voice input

Click the microphone button to speak your prompt. In Chrome/Edge, the browser's native SpeechRecognition transcribes your speech in real-time and auto-submits. For other browsers, audio is sent to the server for OpenAI Whisper transcription (requires `OPENAI_API_KEY`).

#### Interactive pipeline

The pipeline now supports human-in-the-loop checkpoints:

- **Design approval** -- after the design agent produces `DESIGN.md`, BigBoss summarises the design and presents it for review. You can approve, request changes (with written feedback that gets fed back to the designer), or reject.
- **Coding feedback** -- if the coding agent writes `CODING_NOTES.md` (flagging design issues encountered during implementation), BigBoss summarises the feedback. With **Require design approval** on, you choose to continue to testing or re-run the design stage. With it off, the pipeline automatically loops back to design when the notes contain substantive Issues or Deviations (not Suggestions only), up to a configurable iteration cap; when the cap is reached, unaddressed feedback is recorded and shown as "Feedback not implemented" in the UI.
- **Pipeline cancellation** -- click Stop at any time to abort the running agent and cancel the pipeline.

#### Context passing

Agents receive rich, role-specific codebase context:

- **Design agents** get the full file tree, tech stack detection, git history, branch diff stats, project config files, and key architectural source files (entry points, types, interfaces).
- **Coding agents** get a **preview** of `DESIGN.md` (first 3000 chars) in-prompt for orientation, then are instructed to **read the full DESIGN.md from disk** using their filesystem tool. This eliminates context truncation -- the agent reads the complete, untruncated design on disk. Upstream handoff files (`.pipeline/*.handoff.md`) are similarly read from disk rather than injected.
- **Testing agents** get a `DESIGN.md` preview and read the full document from disk, plus existing test patterns and npm scripts.
- **BigBoss** acts as a **context broker** -- it receives a workspace summary and produces per-agent focus briefs (1-3 sentences) telling each agent exactly which files and patterns to pay attention to.

A **codebase summary cache** (`.pipeline/context-cache.json`) persists per-file purpose summaries with incremental git-diff updates, so repeated pipeline runs don't re-analyse unchanged files.

#### Parallel design stages

For complex tasks, BigBoss can fan out design work to multiple specialist designers (UX, Core Code, Graphics, Game Designer) running in parallel. For full videogame or Lua/LÖVE tasks it selects game-designer, core-code-designer, ux-designer, and graphics-designer together -- each now with Lua/game-aware prompts. Each designer writes to `.pipeline/<agent>-design.md`; the orchestrator merges these into a unified `DESIGN.md` using a three-tier strategy: **agent-based merge** (a full Cursor agent reads all design files from disk with no truncation), then OpenAI API merge as fallback, then concatenation. The merged DESIGN.md is prefixed with the **Original task (source of truth)** so the coder always has the full user request; the Game Designer outputs a **requirements checklist** (with sentence-by-sentence cross-referencing) and the merge preserves it.

The **Overseer** (BigBoss as a full agent) runs after design merge and after coding to verify requirements fit. The code review Overseer reads ALL source files from disk (not just file trees) and also reads `CODING_NOTES.md` for coder deviation context. If the agent review fails, it falls back to an OpenAI API call (which now also receives key source file contents and coding notes). The Overseer can trigger up to **2 re-runs** of design or code with focused feedback when gaps or drift are found.

**Task decomposition**: For complex tasks (as rated by BigBoss), the orchestrator decomposes the coding phase into up to 3 sequential sub-tasks (core structure, features, polish). Each sub-task builds on the previous one's output, enabling incremental implementation instead of a single monolithic pass.

**Execution verification**: After coding completes, the orchestrator attempts to verify the output by running it -- Lua syntax checks (`luac -p`) for LÖVE projects, and optionally a short runtime run (`love .`) when `LOVE_RUNTIME_VERIFY=1` is set (catches runtime errors like bad `setColor` arguments); `npm run build` for Node projects. If verification fails, a fix-up agent pass is triggered automatically.

**Self-verification**: Coding agents are instructed to perform a pre-completion checklist -- re-reading the Original task section, verifying every requirement was implemented, checking for syntax errors, and confirming framework-specific callbacks (e.g. `love.load`/`love.update`/`love.draw` for LÖVE).

**Complexity-aware prompts**: BigBoss rates each task as trivial, moderate, or complex. Complex tasks receive additional coding guidance: read the design multiple times, implement incrementally, and re-read the Original task after each major feature.

Structured logging and task history are persisted in SQLite (`test-harness/data/logs.db`). The server exposes `GET /logs`, `GET /tasks/history`, `GET /tasks/:id/detail`, and `POST /config/log-level`; the event log shows level badges and category tags, and the History tab lists past prompts with full log detail. Debug logs are written to `%TEMP%/agent-mvp-logs`.

#### Event log improvements

While agents run, the event log shows real-time progress: elapsed time and files edited. When multiple design agents run in parallel, each stage has its own running indicator and progress (time and file count) so all are visible concurrently. Stage logs (design, coding, testing, release) are nested in collapsible blocks that auto-expand while a stage is active and auto-collapse when it completes with a summary. Click a stage header to toggle it open or closed.

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

# Get task detail with logs (cloud parity with local)
curl https://YOUR_API/tasks/{taskId}/detail
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
6. Build prompt: role preamble + BigBoss context brief + file tree + git history + design doc preview (coding agents read full doc from disk) + upstream handoff pointers + system prompt + task + tool hints
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
| `OPENAI_API_KEY` | Lightweight BigBoss routing, Whisper voice transcription, design/feedback summarisation, API-fallback Overseer reviews | Optional |
| `PORT` | Override the default port (3000) | Optional |
| `SKILLS_ROOT` | Override the skills directory path | Optional |
| `CURSOR_CLI` | Override the Cursor agent CLI path | Optional |
| `CURSOR_AGENT_MODEL` | Model for the Cursor Agent CLI (default: `auto`, to avoid Opus usage limits) | Optional |
| `BIGBOSS_MODEL` | OpenAI model for BigBoss planning and summarisation (default: `gpt-4o-mini`; set to `gpt-4o` for better accuracy) | Optional |
| `MERGE_MODEL` | OpenAI model for design document merge (default: same as `BIGBOSS_MODEL`) | Optional |

## Licence

Apache 2.0
