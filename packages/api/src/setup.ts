import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import * as k8s from "@kubernetes/client-node";
import {
  SetupGitHubRequest,
  SetupGitHubResponse,
  SetupStatus,
} from "@agents/shared";

const NAMESPACE = process.env.AGENT_NAMESPACE || "agent-system";
const GITHUB_SECRET = process.env.GITHUB_SECRET_NAME || "github-credentials";
const CURSOR_SECRET = process.env.CURSOR_SECRET_NAME || "cursor-api-key";

let coreApi: k8s.CoreV1Api | null = null;

function getCoreApi(): k8s.CoreV1Api {
  if (coreApi) return coreApi;
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  coreApi = kc.makeApiClient(k8s.CoreV1Api);
  return coreApi;
}

export async function setupGitHubHandler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const body: SetupGitHubRequest = JSON.parse(event.body || "{}");

    if (!body.token || !body.username || !body.email) {
      return response(400, {
        success: false,
        error: "token, username, and email are required",
      });
    }

    const validation = await validateGitHubToken(body.token);
    if (!validation.valid) {
      return response(401, {
        success: false,
        error: validation.error || "Invalid GitHub token",
      });
    }

    await upsertSecret(GITHUB_SECRET, {
      token: body.token,
      username: body.username,
      email: body.email,
    });

    const result: SetupGitHubResponse = {
      success: true,
      username: body.username,
      email: body.email,
      scopes: validation.scopes,
    };

    return response(200, result);
  } catch (err) {
    console.error("Setup GitHub error:", err);
    return response(500, {
      success: false,
      error: "Internal server error",
    });
  }
}

export async function setupStatusHandler(
  _event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const github = await probeSecret(GITHUB_SECRET, ["token", "username", "email"]);
    const cursor = await probeSecret(CURSOR_SECRET, ["api-key"]);

    const status: SetupStatus = {
      github: {
        configured: github.exists && !github.isPlaceholder,
        username: github.values?.username,
        email: github.values?.email,
        tokenSet: github.exists && !github.isPlaceholder,
      },
      cursor: {
        configured: cursor.exists && !cursor.isPlaceholder,
        tokenSet: cursor.exists && !cursor.isPlaceholder,
      },
    };

    return response(200, status);
  } catch (err) {
    console.error("Setup status error:", err);
    return response(500, { error: "Internal server error" });
  }
}

async function validateGitHubToken(
  token: string
): Promise<{ valid: boolean; scopes?: string[]; error?: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (res.status !== 200) {
    return { valid: false, error: `GitHub API returned ${res.status}` };
  }

  const scopeHeader = res.headers.get("x-oauth-scopes") || "";
  const scopes = scopeHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return { valid: true, scopes };
}

async function upsertSecret(
  name: string,
  data: Record<string, string>
): Promise<void> {
  const api = getCoreApi();
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    encoded[k] = Buffer.from(v).toString("base64");
  }

  try {
    await api.readNamespacedSecret({ name, namespace: NAMESPACE });
    await api.patchNamespacedSecret({
      name,
      namespace: NAMESPACE,
      body: { data: encoded },
    });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    if (status === 404) {
      await api.createNamespacedSecret({
        namespace: NAMESPACE,
        body: {
          metadata: { name, namespace: NAMESPACE },
          type: "Opaque",
          data: encoded,
        },
      });
    } else {
      throw err;
    }
  }
}

interface SecretProbe {
  exists: boolean;
  isPlaceholder: boolean;
  values?: Record<string, string>;
}

async function probeSecret(
  name: string,
  keys: string[]
): Promise<SecretProbe> {
  const api = getCoreApi();

  try {
    const secret = await api.readNamespacedSecret({ name, namespace: NAMESPACE });
    const data = (secret as any).data as Record<string, string> | undefined;
    if (!data) {
      return { exists: true, isPlaceholder: true };
    }

    const values: Record<string, string> = {};
    let placeholder = false;
    for (const key of keys) {
      const raw = data[key];
      if (!raw) {
        placeholder = true;
        continue;
      }
      const decoded = Buffer.from(raw, "base64").toString("utf-8");
      if (decoded.startsWith("PLACEHOLDER")) {
        placeholder = true;
      }
      if (key !== "token" && key !== "api-key") {
        values[key] = decoded;
      }
    }

    return { exists: true, isPlaceholder: placeholder, values };
  } catch {
    return { exists: false, isPlaceholder: false };
  }
}

function response(
  statusCode: number,
  body: unknown
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
