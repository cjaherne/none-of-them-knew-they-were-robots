#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# Setup Cursor API key for the agent system.
# Creates (or updates) the cursor-api-key Kubernetes Secret.
# -------------------------------------------------------------------

NAMESPACE="${AGENT_NAMESPACE:-agent-system}"
SECRET_NAME="${CURSOR_SECRET_NAME:-cursor-api-key}"
SECRET_KEY="api-key"

bold() { printf "\033[1m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
red() { printf "\033[31m%s\033[0m" "$1"; }

echo ""
echo "======================================"
echo " Cursor API Key Setup for Agent System"
echo "======================================"
echo ""

if [ -n "${CURSOR_API_KEY:-}" ]; then
  API_KEY="$CURSOR_API_KEY"
else
  read -rsp "$(bold 'Cursor API Key: ')" API_KEY
  echo ""
fi

if [ -z "$API_KEY" ]; then
  echo "$(red 'Error'): API key cannot be empty."
  exit 1
fi

if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
  echo "Creating namespace $NAMESPACE..."
  kubectl create namespace "$NAMESPACE"
fi

kubectl create secret generic "$SECRET_NAME" \
  --namespace="$NAMESPACE" \
  --from-literal="$SECRET_KEY=$API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "$(green 'Done!') Secret '$SECRET_NAME' created in namespace '$NAMESPACE'."
echo ""
