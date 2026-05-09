/**
 * Backend adapter for the agent server (Express + SSE).
 */

class BackendAdapter {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this._stream = null;
  }

  isFeatureSupported(feature) {
    const supported = new Set([
      "cancel",
      "workspace",
      "pipelineMode",
      "branches",
      "requireApproval",
      "requireRequirementsApproval",
    ]);
    return supported.has(feature);
  }

  async submitCommand(params) {
    const res = await fetch(`${this.baseUrl}/voice-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...params }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Command failed");
    return {
      taskId: data.taskId,
      status: data.status,
      transcript: data.transcript,
    };
  }

  streamTask(taskId, onEvent) {
    this.closeStream();
    const url = `${this.baseUrl}/tasks/${taskId}/stream`;
    const es = new EventSource(url);
    this._stream = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
      } catch {
        /* ignore unparseable */
      }
    };

    es.onerror = () => {
      onEvent({ type: "error", message: "SSE connection lost" });
      es.close();
      this._stream = null;
    };

    return { close: () => { es.close(); this._stream = null; } };
  }

  closeStream() {
    if (this._stream) {
      this._stream.close();
      this._stream = null;
    }
  }

  async approve(taskId, response) {
    await fetch(`${this.baseUrl}/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
  }

  async cancel(taskId) {
    await fetch(`${this.baseUrl}/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  }

  async getTaskHistory(limit = 50, offset = 0) {
    const res = await fetch(
      `${this.baseUrl}/tasks/history?limit=${limit}&offset=${offset}`,
    );
    if (!res.ok) throw new Error("Failed to fetch task history");
    return res.json();
  }

  async getTaskDetail(taskId) {
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/detail`);
    if (!res.ok) throw new Error("Failed to fetch task detail");
    return res.json();
  }

  /**
   * Fetch a whitelisted markdown artefact from the task workspace.
   * Returns `{ ok: true, content }` on 200, `{ ok: false, status, message }`
   * on 4xx/5xx so callers can disable a tab on 404 without wrapping every
   * call in try/catch. Caller is responsible for whitelist enforcement.
   */
  async getArtefact(taskId, file) {
    const url = `${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/artefacts/${encodeURIComponent(file)}`;
    const res = await fetch(url);
    if (!res.ok) {
      let msg = res.statusText || "Fetch failed";
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch { /* non-json */ }
      return { ok: false, status: res.status, message: msg };
    }
    const content = await res.text();
    return { ok: true, content };
  }

  async setLogLevel(level) {
    const res = await fetch(`${this.baseUrl}/config/log-level`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    });
    if (!res.ok) throw new Error("Failed to set log level");
    return res.json();
  }

  async getLogLevel() {
    const res = await fetch(`${this.baseUrl}/config/log-level`);
    if (!res.ok) return { level: "INFO" };
    return res.json();
  }

  async getLogs(opts = {}) {
    const params = new URLSearchParams();
    if (opts.taskId) params.set("taskId", opts.taskId);
    if (opts.level) params.set("level", opts.level);
    if (opts.category) params.set("category", opts.category);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    const res = await fetch(`${this.baseUrl}/logs?${params.toString()}`);
    if (!res.ok) throw new Error("Failed to fetch logs");
    return res.json();
  }
}
