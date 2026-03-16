// --- State ---
let currentEventSource = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// --- DOM refs ---
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const backendSelect = document.getElementById("backendSelect");
const customUrl = document.getElementById("customUrl");
const textInput = document.getElementById("textInput");
const workspaceInput = document.getElementById("workspaceInput");
const repoInput = document.getElementById("repoInput");
const baseBranchInput = document.getElementById("baseBranchInput");
const branchInput = document.getElementById("branchInput");
const sendBtn = document.getElementById("sendBtn");
const micBtn = document.getElementById("micBtn");
const statusEl = document.getElementById("status");
const pipelinePanel = document.getElementById("pipelinePanel");
const pipelineTaskId = document.getElementById("pipelineTaskId");
const stageDetail = document.getElementById("stageDetail");
const taskLog = document.getElementById("taskLog");

// --- Init ---
(function init() {
  const saved = localStorage.getItem("backend") || "local";
  backendSelect.value = saved;
  customUrl.value = localStorage.getItem("customUrl") || "";
  customUrl.style.display = saved === "custom" ? "block" : "none";
  workspaceInput.value = localStorage.getItem("workspace") || "";
  repoInput.value = localStorage.getItem("repo") || "";
  baseBranchInput.value = localStorage.getItem("baseBranch") || "";
  branchInput.value = localStorage.getItem("branch") || "";
})();

// --- Settings ---
settingsToggle.addEventListener("click", () => {
  settingsPanel.classList.toggle("visible");
});

backendSelect.addEventListener("change", () => {
  localStorage.setItem("backend", backendSelect.value);
  customUrl.style.display = backendSelect.value === "custom" ? "block" : "none";
});

customUrl.addEventListener("change", () => {
  localStorage.setItem("customUrl", customUrl.value.trim());
});

workspaceInput.addEventListener("change", () => {
  localStorage.setItem("workspace", workspaceInput.value.trim());
});

repoInput.addEventListener("change", () => {
  localStorage.setItem("repo", repoInput.value.trim());
});

baseBranchInput.addEventListener("change", () => {
  localStorage.setItem("baseBranch", baseBranchInput.value.trim());
});

branchInput.addEventListener("change", () => {
  localStorage.setItem("branch", branchInput.value.trim());
});

function getApiBase() {
  if (backendSelect.value === "custom") {
    return customUrl.value.trim().replace(/\/$/, "");
  }
  return window.location.origin;
}

// --- Send command ---
sendBtn.addEventListener("click", sendTextCommand);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTextCommand();
  }
});

async function sendTextCommand() {
  const text = textInput.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  statusEl.textContent = "Sending command...";

  const repo = repoInput.value.trim() || undefined;
  const workspace = workspaceInput.value.trim() || undefined;
  const baseBranch = baseBranchInput.value.trim() || undefined;
  const branch = branchInput.value.trim() || undefined;
  const apiBase = getApiBase();

  try {
    const res = await fetch(`${apiBase}/voice-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, repo, workspace, baseBranch, branch }),
    });
    const data = await res.json();

    if (res.ok) {
      addLogEntry(`Task ${data.taskId.slice(0, 8)}... queued`, "pending");
      statusEl.textContent = `Pipeline running for ${data.taskId.slice(0, 8)}...`;
      showPipeline(data.taskId);
      connectSSE(apiBase, data.taskId);
    } else {
      addLogEntry(`Error: ${data.error}`, "error");
      statusEl.textContent = "Command failed";
    }
  } catch (err) {
    addLogEntry(`Network error: ${err.message}`, "error");
    statusEl.textContent = "Connection failed -- is the test harness running?";
  } finally {
    sendBtn.disabled = false;
  }
}

// --- Voice recording (secondary) ---
micBtn.addEventListener("click", toggleRecording);

async function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = handleRecordingComplete;

    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add("recording");
    statusEl.textContent = "Listening...";
  } catch {
    statusEl.textContent = "Microphone access denied";
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
  isRecording = false;
  micBtn.classList.remove("recording");
  statusEl.textContent = "Processing...";
}

async function handleRecordingComplete() {
  const blob = new Blob(audioChunks, { type: "audio/webm" });
  const reader = new FileReader();
  reader.onloadend = async () => {
    const base64 = reader.result.split(",")[1];
    const apiBase = getApiBase();

    try {
      const res = await fetch(`${apiBase}/voice-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: base64 }),
      });
      const data = await res.json();

      if (res.ok) {
        addLogEntry(`Task ${data.taskId.slice(0, 8)}... queued (voice)`, "pending");
        statusEl.textContent = `Pipeline running for ${data.taskId.slice(0, 8)}...`;
        showPipeline(data.taskId);
        connectSSE(apiBase, data.taskId);
      } else {
        addLogEntry(`Error: ${data.error}`, "error");
        statusEl.textContent = "Command failed";
      }
    } catch (err) {
      addLogEntry(`Network error: ${err.message}`, "error");
      statusEl.textContent = "Connection failed";
    }
  };
  reader.readAsDataURL(blob);
}

// --- Pipeline visualization ---
function showPipeline(taskId) {
  pipelinePanel.classList.add("visible");
  pipelineTaskId.textContent = taskId;
  resetStages();
}

function resetStages() {
  for (const name of ["design", "coding", "validation"]) {
    const bar = document.getElementById(`bar-${name}`);
    bar.className = "stage-bar";
    const label = bar.parentElement.querySelector(".stage-label");
    label.className = "stage-label";
  }
  stageDetail.innerHTML = "";
}

function updateStages(stages) {
  if (!stages) return;
  for (const s of stages) {
    const bar = document.getElementById(`bar-${s.name}`);
    if (!bar) continue;
    bar.className = `stage-bar ${s.status}`;
    const label = bar.parentElement.querySelector(".stage-label");
    label.className = `stage-label ${s.status === "running" ? "active" : ""}`;
  }

  const active = stages.find((s) => s.status === "running" || s.status === "succeeded" || s.status === "failed");
  const latest = [...stages].reverse().find((s) => s.status !== "pending");
  if (latest) {
    renderStageDetail(latest);
  }
}

function renderStageDetail(stage) {
  let html = `<div class="agent-name">${stage.agent}</div>`;

  const meta = [];
  if (stage.durationMs) meta.push(`${(stage.durationMs / 1000).toFixed(1)}s`);
  if (stage.filesModified?.length) meta.push(`${stage.filesModified.length} file(s) modified`);
  if (meta.length) html += `<div class="stage-meta">${meta.join(" &middot; ")}</div>`;

  if (stage.filesModified?.length) {
    html += `<div class="stage-files">${stage.filesModified.slice(0, 10).join("<br>")}</div>`;
  }
  if (stage.errors?.length) {
    html += `<div class="stage-errors">${stage.errors.join("<br>")}</div>`;
  }

  stageDetail.innerHTML = html;
}

// --- SSE connection ---
function connectSSE(apiBase, taskId) {
  if (currentEventSource) {
    currentEventSource.close();
  }

  const url = `${apiBase}/tasks/${taskId}/stream`;
  const es = new EventSource(url);
  currentEventSource = es;

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "snapshot") {
        updateStages(data.task?.stages);
        return;
      }

      if (data.type === "done") {
        es.close();
        currentEventSource = null;
        return;
      }

      if (data.data?.stages) {
        updateStages(data.data.stages);
      }

      const logType =
        data.type === "result"
          ? data.data?.stage?.status === "failed" ? "error" : "success"
          : "pending";

      addLogEntry(data.message || JSON.stringify(data), logType);

      if (data.type === "status_change") {
        if (data.data?.status === "completed") {
          statusEl.textContent = "Pipeline completed successfully";
        } else if (data.data?.status === "failed") {
          statusEl.textContent = `Pipeline failed: ${data.data?.error || "unknown error"}`;
        }
      }
    } catch {
      addLogEntry(event.data, "pending");
    }
  };

  es.onerror = () => {
    addLogEntry("SSE connection lost", "error");
    es.close();
    currentEventSource = null;
  };
}

// --- Log entries ---
function addLogEntry(message, type = "pending") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="time">${time}</span> ${escapeHtml(message)}`;
  taskLog.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
