#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# Setup GitHub credentials for the agent system.
# Creates (or updates) the github-credentials Kubernetes Secret
# that agent pods use to clone/push repositories.
# -------------------------------------------------------------------

NAMESPACE="${AGENT_NAMESPACE:-agent-system}"
SECRET_NAME="${GITHUB_SECRET_NAME:-github-credentials}"

bold() { printf "\033[1m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
red() { printf "\033[31m%s\033[0m" "$1"; }

echo ""
echo "======================================"
echo " GitHub Account Setup for Agent System"
echo "======================================"
echo ""

# --- Collect inputs (env vars or interactive) ---

if [ -n "${GITHUB_TOKEN:-}" ]; then
  TOKEN="$GITHUB_TOKEN"
else
  echo "A GitHub Personal Access Token (PAT) with 'repo' scope is required."
  echo "Create one at: https://github.com/settings/tokens"
  echo ""
  read -rsp "$(bold 'GitHub PAT: ')" TOKEN
  echo ""
fi

if [ -z "$TOKEN" ]; then
  echo "$(red 'Error'): Token cannot be empty."
  exit 1
fi

# --- Validate the token against the GitHub API ---

echo ""
echo "Validating token..."

HTTP_CODE=$(curl -s -o /tmp/gh_user.json -w "%{http_code}" \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user)

if [ "$HTTP_CODE" != "200" ]; then
  echo "$(red 'Error'): GitHub API returned HTTP $HTTP_CODE. Check your token."
  cat /tmp/gh_user.json 2>/dev/null
  exit 1
fi

GH_LOGIN=$(python3 -c "import json; print(json.load(open('/tmp/gh_user.json'))['login'])" 2>/dev/null \
  || jq -r '.login' /tmp/gh_user.json 2>/dev/null \
  || echo "")
GH_NAME=$(python3 -c "import json; print(json.load(open('/tmp/gh_user.json')).get('name','') or '')" 2>/dev/null \
  || jq -r '.name // empty' /tmp/gh_user.json 2>/dev/null \
  || echo "")
GH_EMAIL_API=$(python3 -c "import json; print(json.load(open('/tmp/gh_user.json')).get('email','') or '')" 2>/dev/null \
  || jq -r '.email // empty' /tmp/gh_user.json 2>/dev/null \
  || echo "")

echo "$(green 'Token valid') - authenticated as $(bold "$GH_LOGIN")"

# Check scopes
SCOPES=$(curl -sI -H "Authorization: token ${TOKEN}" https://api.github.com/ \
  | grep -i "x-oauth-scopes:" | cut -d: -f2- | xargs)
echo "Token scopes: ${SCOPES:-<none detected>}"
echo ""

# --- Git identity ---

if [ -n "${GIT_USER_NAME:-}" ]; then
  USERNAME="$GIT_USER_NAME"
else
  DEFAULT_NAME="${GH_NAME:-$GH_LOGIN}"
  read -rp "$(bold 'Git commit username') [$DEFAULT_NAME]: " USERNAME
  USERNAME="${USERNAME:-$DEFAULT_NAME}"
fi

if [ -n "${GIT_USER_EMAIL:-}" ]; then
  EMAIL="$GIT_USER_EMAIL"
else
  DEFAULT_EMAIL="${GH_EMAIL_API:-${GH_LOGIN}@users.noreply.github.com}"
  read -rp "$(bold 'Git commit email') [$DEFAULT_EMAIL]: " EMAIL
  EMAIL="${EMAIL:-$DEFAULT_EMAIL}"
fi

echo ""
echo "Configuration summary:"
echo "  GitHub user : $(bold "$GH_LOGIN")"
echo "  Commit as   : $(bold "$USERNAME") <$(bold "$EMAIL")>"
echo "  Namespace   : $(bold "$NAMESPACE")"
echo "  Secret name : $(bold "$SECRET_NAME")"
echo ""

# --- Create / update the K8s Secret ---

if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
  echo "Creating namespace $NAMESPACE..."
  kubectl create namespace "$NAMESPACE"
fi

kubectl create secret generic "$SECRET_NAME" \
  --namespace="$NAMESPACE" \
  --from-literal=token="$TOKEN" \
  --from-literal=username="$USERNAME" \
  --from-literal=email="$EMAIL" \
  --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "$(green 'Done!') Secret '$SECRET_NAME' created in namespace '$NAMESPACE'."
echo ""
echo "You can verify with:"
echo "  kubectl get secret $SECRET_NAME -n $NAMESPACE -o jsonpath='{.data.username}' | base64 -d"
echo ""

rm -f /tmp/gh_user.json
