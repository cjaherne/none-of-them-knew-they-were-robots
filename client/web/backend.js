/**
 * Backend adapter -- abstracts API differences between the local test harness
 * (Express + SSE) and the AWS cloud deployment (Lambda + WebSocket).
 */

class BackendAdapter {
  constructor(type, baseUrl, wsUrl) {
    this.type = type; // "local" | "cloud"
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.wsUrl = (wsUrl || "").replace(/\/$/, "");
    this._stream = null;
    this._pendingApprovalId = null;
  }

  isFeatureSupported(feature) {
    const local = new Set(["cancel", "workspace", "pipelineMode", "branches", "requireApproval"]);
    const cloud = new Set(["setup"]);
    if (this.type === "local") return local.has(feature);
    return cloud.has(feature);
  }

  async submitCommand(params) {
    if (this.type === "cloud") {
      const body = {};
      if (params.text) body.text = params.text;
      if (params.audioBase64) body.audioBase64 = params.audioBase64;

      const res = await fetch(`${this.baseUrl}/voice-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Command failed");
      return { taskId: data.taskId, status: data.status, pipelineName: data.pipelineName };
    }

    const body = { ...params };
    const res = await fetch(`${this.baseUrl}/voice-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Command failed");
    return { taskId: data.taskId, status: data.status, transcript: data.transcript };
  }

  streamTask(taskId, onEvent) {
    this.closeStream();

    if (this.type === "cloud") {
      return this._streamWebSocket(taskId, onEvent);
    }
    return this._streamSSE(taskId, onEvent);
  }

  _streamSSE(taskId, onEvent) {
    const url = `${this.baseUrl}/tasks/${taskId}/stream`;
    const es = new EventSource(url);
    this._stream = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
      } catch { /* ignore unparseable */ }
    };

    es.onerror = () => {
      onEvent({ type: "error", message: "SSE connection lost" });
      es.close();
      this._stream = null;
    };

    return { close: () => { es.close(); this._stream = null; } };
  }

  _streamWebSocket(taskId, onEvent) {
    const wsBase = this.wsUrl || this.baseUrl.replace(/^http/, "ws");
    const url = `${wsBase}?taskId=${encodeURIComponent(taskId)}`;
    let ws;
    let retries = 0;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(url);
      this._stream = ws;

      ws.onopen = () => {
        retries = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "approval_required" && data.data?.approvalId) {
            this._pendingApprovalId = data.data.approvalId;
          }
          onEvent(data);
        } catch { /* ignore */ }
      };

      ws.onerror = () => {
        /* handled in onclose */
      };

      ws.onclose = () => {
        this._stream = null;
        if (!closed && retries < 5) {
          retries++;
          const delay = Math.min(1000 * Math.pow(2, retries), 16000);
          setTimeout(connect, delay);
        } else if (!closed) {
          onEvent({ type: "error", message: "WebSocket connection lost" });
        }
      };
    };

    connect();

    return {
      close: () => {
        closed = true;
        if (ws) { ws.close(); this._stream = null; }
      },
    };
  }

  closeStream() {
    if (this._stream) {
      if (this._stream instanceof EventSource) {
        this._stream.close();
      } else if (this._stream.close) {
        this._stream.close();
      }
      this._stream = null;
    }
  }

  async approve(taskId, response) {
    if (this.type === "cloud") {
      const approvalId = this._pendingApprovalId || taskId;
      await fetch(`${this.baseUrl}/tasks/${approvalId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: response.approved }),
      });
      this._pendingApprovalId = null;
      return;
    }

    await fetch(`${this.baseUrl}/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
  }

  async cancel(taskId) {
    if (this.type === "cloud") return;

    await fetch(`${this.baseUrl}/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  }
}
