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
