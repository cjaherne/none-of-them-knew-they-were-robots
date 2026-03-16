// --- State ---
let adapter = null;
let currentStreamHandle = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let voiceEnabled = true;

function speak(text) {
  if (!voiceEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.1;
  utter.pitch = 1.0;
  window.speechSynthesis.speak(utter);
}

// --- DOM refs ---
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebar = document.getElementById("sidebar");
const backendSelect = document.getElementById("backendSelect");
const localUrl = document.getElementById("localUrl");
const localUrlGroup = document.getElementById("localUrlGroup");
const cloudRestUrl = document.getElementById("cloudRestUrl");
const cloudWsUrl = document.getElementById("cloudWsUrl");
const cloudUrlGroup = document.getElementById("cloudUrlGroup");
const localConfig = document.getElementById("localConfig");
const textInput = document.getElementById("textInput");
const textInputMobile = document.getElementById("textInputMobile");
const workspaceInput = document.getElementById("workspaceInput");
const repoInput = document.getElementById("repoInput");
const baseBranchInput = document.getElementById("baseBranchInput");
const branchInput = document.getElementById("branchInput");
const pipelineModeSelect = document.getElementById("pipelineModeSelect");
const voiceToggle = document.getElementById("voiceToggle");
const approvalToggle = document.getElementById("approvalToggle");
const approvalBanner = document.getElementById("approvalBanner");
const approvalTitle = document.getElementById("approvalTitle");
const approvalTypeBadge = document.getElementById("approvalTypeBadge");
const approvalSummary = document.getElementById("approvalSummary");
const approvalPreviewBlock = document.getElementById("approvalPreviewBlock");
const approvalPreview = document.getElementById("approvalPreview");
const revisionInputBlock = document.getElementById("revisionInputBlock");
const revisionInput = document.getElementById("revisionInput");
const approvalActions = document.getElementById("approvalActions");
const cancelBtn = document.getElementById("cancelBtn");
const sendBtn = document.getElementById("sendBtn");
const sendBtnMobile = document.getElementById("sendBtnMobile");
const micBtn = document.getElementById("micBtn");
const micBtnMobile = document.getElementById("micBtnMobile");
const statusEl = document.getElementById("status");
const pipelinePanel = document.getElementById("pipelinePanel");
const pipelineTaskId = document.getElementById("pipelineTaskId");
const stageDetail = document.getElementById("stageDetail");
const taskLog = document.getElementById("taskLog");

// --- Adapter creation ---
function createAdapter() {
  const type = backendSelect.value; // "local" | "cloud"
  if (type === "cloud") {
    const restBase = cloudRestUrl.value.trim() || "https://localhost";
    const ws = cloudWsUrl.value.trim() || "";
    adapter = new BackendAdapter("cloud", restBase, ws);
  } else {
    const base = localUrl.value.trim() || window.location.origin;
    adapter = new BackendAdapter("local", base);
  }
  applyFeatureVisibility();
}

function applyFeatureVisibility() {
  if (!adapter) return;
  const isLocal = adapter.type === "local";
  localConfig.style.display = isLocal ? "" : "none";
  cancelBtn.style.display = "none"; // always hidden until a task is running
}

// --- Init ---
(function init() {
  const savedBackend = localStorage.getItem("backend") || "local";
  backendSelect.value = savedBackend;
  localUrl.value = localStorage.getItem("localUrl") || "";
  cloudRestUrl.value = localStorage.getItem("cloudRestUrl") || "";
  cloudWsUrl.value = localStorage.getItem("cloudWsUrl") || "";
  toggleBackendFields(savedBackend);

  workspaceInput.value = localStorage.getItem("workspace") || "";
  repoInput.value = localStorage.getItem("repo") || "";
  baseBranchInput.value = localStorage.getItem("baseBranch") || "";
  branchInput.value = localStorage.getItem("branch") || "";
  pipelineModeSelect.value = localStorage.getItem("pipelineMode") || "full";
  const savedVoice = localStorage.getItem("voiceEnabled");
  voiceEnabled = savedVoice !== "false";
  voiceToggle.checked = voiceEnabled;
  approvalToggle.checked = localStorage.getItem("approvalEnabled") === "true";

  createAdapter();
})();

function toggleBackendFields(type) {
  if (type === "cloud") {
    localUrlGroup.style.display = "none";
    cloudUrlGroup.style.display = "";
  } else {
    localUrlGroup.style.display = "";
    cloudUrlGroup.style.display = "none";
  }
}

// --- Settings / persistence ---
sidebarToggle.addEventListener("click", () => {
  sidebar.classList.toggle("mobile-open");
});

backendSelect.addEventListener("change", () => {
  const val = backendSelect.value;
  localStorage.setItem("backend", val);
  toggleBackendFields(val);
  createAdapter();
});

localUrl.addEventListener("change", () => {
  localStorage.setItem("localUrl", localUrl.value.trim());
  createAdapter();
});

cloudRestUrl.addEventListener("change", () => {
  localStorage.setItem("cloudRestUrl", cloudRestUrl.value.trim());
  createAdapter();
});

cloudWsUrl.addEventListener("change", () => {
  localStorage.setItem("cloudWsUrl", cloudWsUrl.value.trim());
  createAdapter();
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

pipelineModeSelect.addEventListener("change", () => {
  localStorage.setItem("pipelineMode", pipelineModeSelect.value);
});

voiceToggle.addEventListener("change", () => {
  voiceEnabled = voiceToggle.checked;
  localStorage.setItem("voiceEnabled", voiceToggle.checked);
});

approvalToggle.addEventListener("change", () => {
  localStorage.setItem("approvalEnabled", approvalToggle.checked);
});

// --- Sync desktop ↔ mobile prompt ---
textInput.addEventListener("input", () => { textInputMobile.value = textInput.value; });
textInputMobile.addEventListener("input", () => { textInput.value = textInputMobile.value; });

// --- Approval ---
let pendingApprovalTaskId = null;
let currentRunningTaskId = null;

function handleApprovalRequired(data) {
  pendingApprovalTaskId = data.taskId;
  const approvalType = data.data?.approvalType || "design";
  const summary = data.data?.summary || "Stage complete. Proceed?";

  approvalSummary.textContent = summary;
  speak(summary);

  if (approvalType === "design") {
    approvalTitle.textContent = "Design Review";
    approvalTypeBadge.textContent = "BigBoss";

    const preview = data.data?.designPreview || "";
    if (preview) {
      approvalPreview.textContent = preview;
      approvalPreviewBlock.style.display = "";
    } else {
      approvalPreviewBlock.style.display = "none";
    }
    revisionInputBlock.style.display = "none";

    approvalActions.innerHTML = `
      <button class="btn-approve" id="actApprove">Approve</button>
      <button class="btn-revise" id="actRevise">Request Changes</button>
      <button class="btn-reject" id="actReject">Reject</button>
    `;

    document.getElementById("actApprove").addEventListener("click", () => {
      sendApprovalResponse({ approved: true, action: "approve" });
    });
    document.getElementById("actRevise").addEventListener("click", () => {
      if (revisionInputBlock.style.display === "none") {
        revisionInputBlock.style.display = "";
        revisionInput.focus();
        speak("Enter your change request.");
      } else {
        const feedback = revisionInput.value.trim();
        if (!feedback) { speak("Please describe the changes you want."); return; }
        sendApprovalResponse({ approved: true, action: "revise", feedback });
      }
    });
    document.getElementById("actReject").addEventListener("click", () => {
      sendApprovalResponse({ approved: false, action: "reject" });
    });
  } else if (approvalType === "feedback") {
    approvalTitle.textContent = "Coding Feedback";
    approvalTypeBadge.textContent = "Feedback Loop";

    const preview = data.data?.feedbackPreview || "";
    if (preview) {
      approvalPreview.textContent = preview;
      approvalPreviewBlock.style.display = "";
    } else {
      approvalPreviewBlock.style.display = "none";
    }
    revisionInputBlock.style.display = "none";

    approvalActions.innerHTML = `
      <button class="btn-continue" id="actContinue">Continue to Testing</button>
      <button class="btn-redesign" id="actRedesign">Re-run Design</button>
    `;

    document.getElementById("actContinue").addEventListener("click", () => {
      sendApprovalResponse({ approved: true, action: "continue" });
    });
    document.getElementById("actRedesign").addEventListener("click", () => {
      sendApprovalResponse({ approved: true, action: "redesign" });
    });
  }

  approvalBanner.classList.add("visible");
}

async function sendApprovalResponse(response) {
  if (!pendingApprovalTaskId) return;
  try {
    await adapter.approve(pendingApprovalTaskId, response);
  } catch (err) {
    addLogEntry(`Approval error: ${err.message}`, "error");
  }
  approvalBanner.classList.remove("visible");
  revisionInputBlock.style.display = "none";
  revisionInput.value = "";
  pendingApprovalTaskId = null;

  const msgs = {
    approve: "Approved. Continuing pipeline.",
    reject: "Rejected. Pipeline stopped.",
    revise: "Revision requested. Re-running design.",
    continue: "Continuing to testing.",
    redesign: "Re-running design with feedback.",
  };
  speak(msgs[response.action] || "Response sent.");
}

cancelBtn.addEventListener("click", async () => {
  if (!currentRunningTaskId) return;
  try {
    await adapter.cancel(currentRunningTaskId);
    speak("Pipeline cancelled.");
    statusEl.textContent = "Pipeline cancelled";
    cancelBtn.style.display = "none";
  } catch (err) {
    addLogEntry(`Cancel error: ${err.message}`, "error");
  }
});

// --- Send command ---
function getCommandText() {
  return (textInput.value || textInputMobile.value || "").trim();
}

sendBtn.addEventListener("click", sendTextCommand);
sendBtnMobile.addEventListener("click", sendTextCommand);

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextCommand(); }
});
textInputMobile.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextCommand(); }
});

async function sendTextCommand() {
  const text = getCommandText();
  if (!text) return;

  sendBtn.disabled = true;
  sendBtnMobile.disabled = true;
  statusEl.textContent = "Sending command...";

  const params = { text };

  if (adapter.isFeatureSupported("workspace")) {
    const repo = repoInput.value.trim() || undefined;
    const workspace = workspaceInput.value.trim() || undefined;
    const baseBranch = baseBranchInput.value.trim() || undefined;
    const branch = branchInput.value.trim() || undefined;
    const pipelineMode = pipelineModeSelect.value || "full";
    const requireApproval = approvalToggle.checked;
    Object.assign(params, { repo, workspace, baseBranch, branch, pipelineMode, requireApproval });
  }

  try {
    const result = await adapter.submitCommand(params);
    addLogEntry(`Task ${result.taskId.slice(0, 8)}... queued`, "pending");
    statusEl.textContent = `Pipeline running for ${result.taskId.slice(0, 8)}...`;
    speak("Starting pipeline. Analyzing your request.");
    showPipeline(result.taskId);
    connectStream(result.taskId);
  } catch (err) {
    addLogEntry(`Error: ${err.message}`, "error");
    statusEl.textContent = adapter.type === "local"
      ? "Connection failed -- is the test harness running?"
      : `Error: ${err.message}`;
  } finally {
    sendBtn.disabled = false;
    sendBtnMobile.disabled = false;
  }
}

// --- Voice input ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let speechRecognition = null;

micBtn.addEventListener("click", toggleVoiceInput);
micBtnMobile.addEventListener("click", toggleVoiceInput);

function toggleVoiceInput() {
  if (isRecording) { stopVoiceInput(); } else { startVoiceInput(); }
}

function setMicRecording(on) {
  isRecording = on;
  const method = on ? "add" : "remove";
  micBtn.classList[method]("recording");
  micBtnMobile.classList[method]("recording");
}

function startVoiceInput() {
  if (!SpeechRecognition) {
    startRecordingFallback();
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;
  speechRecognition.lang = "en-US";

  speechRecognition.onstart = () => {
    setMicRecording(true);
    statusEl.textContent = "Listening...";
  };

  speechRecognition.onresult = (event) => {
    let transcript = "";
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    textInput.value = transcript;
    textInputMobile.value = transcript;

    if (event.results[0]?.isFinal) {
      statusEl.textContent = `Heard: "${transcript.slice(0, 60)}${transcript.length > 60 ? "..." : ""}"`;
    }
  };

  speechRecognition.onend = () => {
    setMicRecording(false);
    const text = getCommandText();
    if (text) {
      speak(`Sending: ${text.slice(0, 80)}`);
      setTimeout(() => sendTextCommand(), 600);
    } else {
      statusEl.textContent = "No speech detected. Try again.";
    }
  };

  speechRecognition.onerror = (event) => {
    setMicRecording(false);
    if (event.error === "not-allowed") {
      statusEl.textContent = "Microphone access denied";
    } else {
      statusEl.textContent = `Speech error: ${event.error}`;
    }
  };

  speechRecognition.start();
}

function stopVoiceInput() {
  if (speechRecognition) {
    speechRecognition.stop();
  } else if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
  setMicRecording(false);
}

async function startRecordingFallback() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = handleRecordingFallback;

    mediaRecorder.start();
    setMicRecording(true);
    statusEl.textContent = "Recording... (click again to stop)";
  } catch {
    statusEl.textContent = "Microphone access denied";
  }
}

async function handleRecordingFallback() {
  setMicRecording(false);
  statusEl.textContent = "Transcribing...";

  const blob = new Blob(audioChunks, { type: "audio/webm" });
  const reader = new FileReader();
  reader.onloadend = async () => {
    const base64 = reader.result.split(",")[1];
    const params = { audioBase64: base64 };

    if (adapter.isFeatureSupported("workspace")) {
      Object.assign(params, {
        repo: repoInput.value.trim() || undefined,
        workspace: workspaceInput.value.trim() || undefined,
        baseBranch: baseBranchInput.value.trim() || undefined,
        branch: branchInput.value.trim() || undefined,
        pipelineMode: pipelineModeSelect.value || "full",
        requireApproval: approvalToggle.checked,
      });
    }

    try {
      const result = await adapter.submitCommand(params);
      if (result.transcript) {
        textInput.value = result.transcript;
        textInputMobile.value = result.transcript;
      }
      addLogEntry(`Task ${result.taskId.slice(0, 8)}... queued (voice)`, "pending");
      statusEl.textContent = `Pipeline running for ${result.taskId.slice(0, 8)}...`;
      speak("Starting pipeline. Analyzing your request.");
      showPipeline(result.taskId);
      connectStream(result.taskId);
    } catch (err) {
      addLogEntry(`Error: ${err.message}`, "error");
      statusEl.textContent = adapter.type === "local"
        ? "Connection failed -- is the test harness running?"
        : `Error: ${err.message}`;
    }
  };
  reader.readAsDataURL(blob);
}

// --- Pipeline visualization ---
const pipelineStages = document.getElementById("pipelineStages");

function showPipeline(taskId) {
  pipelinePanel.classList.add("visible");
  pipelineTaskId.textContent = taskId;
  pipelineStages.innerHTML = "";
  stageDetail.innerHTML = "";
  lastStageCount = 0;
  lastStagesSnapshot = [];
  currentRunningTaskId = taskId;

  if (adapter.isFeatureSupported("cancel")) {
    cancelBtn.style.display = "inline-block";
  } else {
    cancelBtn.style.display = "none";
  }

  approvalBanner.classList.remove("visible");
  finalizeRunningIndicator();
}

function buildStageElements(stages) {
  pipelineStages.innerHTML = "";
  for (let i = 0; i < stages.length; i++) {
    if (i > 0) {
      const connector = document.createElement("div");
      connector.className = "stage-connector";
      pipelineStages.appendChild(connector);
    }
    const stageEl = document.createElement("div");
    stageEl.className = "stage";
    stageEl.dataset.stage = stages[i].name;
    stageEl.innerHTML = `
      <div class="stage-bar" id="bar-${stages[i].name}"></div>
      <div class="stage-label">${stages[i].name}</div>
    `;
    pipelineStages.appendChild(stageEl);
  }
}

let lastStageCount = 0;
let lastStagesSnapshot = [];

function updateStages(stages) {
  if (!stages || stages.length === 0) return;
  lastStagesSnapshot = stages;

  if (stages.length !== lastStageCount) {
    buildStageElements(stages);
    lastStageCount = stages.length;
  }

  for (const s of stages) {
    const bar = document.getElementById(`bar-${s.name}`);
    if (!bar) continue;
    bar.className = `stage-bar ${s.status}`;
    const label = bar.parentElement.querySelector(".stage-label");
    label.className = `stage-label ${s.status === "running" ? "active" : ""}`;
  }

  renderAllStageDetails(stages);
}

function renderAllStageDetails(stages) {
  const activeStages = stages.filter((s) => s.status !== "pending");
  if (activeStages.length === 0) {
    stageDetail.innerHTML = "";
    return;
  }

  let html = "";

  const completedStages = stages.filter((s) => s.status === "succeeded" || s.status === "failed");
  const totalFiles = new Set();
  let totalDuration = 0;
  let totalCost = 0;
  let hasNotes = false;

  for (const s of stages) {
    if (s.filesModified) s.filesModified.forEach((f) => totalFiles.add(f));
    if (s.durationMs) totalDuration += s.durationMs;
    if (s.estimatedCost) totalCost += s.estimatedCost;
    if (s.notes) hasNotes = true;
  }

  html += `<div class="pipeline-summary">`;
  html += `<span class="summary-stat"><span class="summary-value">${completedStages.length}</span>/${stages.length} stages</span>`;
  html += `<span class="summary-stat"><span class="summary-value">${totalFiles.size}</span> file(s)</span>`;
  if (totalDuration > 0) {
    html += `<span class="summary-stat"><span class="summary-value">${(totalDuration / 1000).toFixed(1)}s</span> total</span>`;
  }
  if (totalCost > 0) {
    html += `<span class="summary-stat"><span class="cost-badge">$${totalCost.toFixed(4)}</span></span>`;
  }
  if (hasNotes) {
    html += `<span class="summary-stat" style="color: var(--warning)">feedback logged</span>`;
  }
  html += `</div>`;

  for (const s of activeStages) {
    html += `<div class="stage-card ${s.status}">`;
    html += `<div class="stage-card-header">`;
    html += `<span class="agent-name">${s.agent} <span style="color: var(--text-dim); font-weight: 400">(${s.name})</span></span>`;

    const meta = [];
    if (s.durationMs) meta.push(`${(s.durationMs / 1000).toFixed(1)}s`);
    if (s.filesModified?.length) meta.push(`${s.filesModified.length} file(s)`);
    if (s.estimatedCost) meta.push(`$${s.estimatedCost.toFixed(4)}`);
    if (s.status === "running") meta.push("running...");
    if (meta.length) html += `<span class="stage-meta">${meta.join(" &middot; ")}</span>`;
    html += `</div>`;

    if (s.filesModified?.length) {
      html += `<div class="stage-files">${s.filesModified.slice(0, 8).join("<br>")}`;
      if (s.filesModified.length > 8) html += `<br>... +${s.filesModified.length - 8} more`;
      html += `</div>`;
    }
    if (s.errors?.length) {
      html += `<div class="stage-errors">${s.errors.map(escapeHtml).join("<br>")}</div>`;
    }
    html += `</div>`;
  }

  const notesStage = stages.find((s) => s.notes);
  if (notesStage) {
    html += `<div class="feedback-card">`;
    html += `<div class="feedback-header">`;
    html += `<span>Feedback</span>`;
    html += `<span class="feedback-arrow">coding → design</span>`;
    html += `</div>`;
    html += `<div class="feedback-body">${escapeHtml(notesStage.notes)}</div>`;
    html += `</div>`;
  }

  stageDetail.innerHTML = html;
}

// --- Streaming ---
let activeRunningEntry = null;
let activeRunningStage = null;
let activeRunningStart = null;

function connectStream(taskId) {
  if (currentStreamHandle) {
    currentStreamHandle.close();
  }

  activeRunningEntry = null;
  activeRunningStage = null;
  activeRunningStart = null;

  currentStreamHandle = adapter.streamTask(taskId, handleStreamEvent);
}

function handleStreamEvent(data) {
  try {
    if (data.type === "error") {
      finalizeRunningIndicator();
      addLogEntry(data.message || "Connection lost", "error");
      return;
    }

    if (data.type === "snapshot") {
      updateStages(data.task?.stages);
      return;
    }

    if (data.type === "done") {
      if (currentStreamHandle) { currentStreamHandle.close(); currentStreamHandle = null; }
      finalizeRunningIndicator();
      return;
    }

    if (data.data?.stages) {
      updateStages(data.data.stages);
    }

    if (data.type === "status_change" && data.message?.includes("Pipeline stages set")) {
      const stageNames = (data.data?.stages || []).map((s) => s.name).join(" → ");
      if (stageNames) {
        addLogEntry(`Pipeline: ${stageNames}`, "info");
        speak(`This needs ${stageNames.replace(/→/g, "then")}.`);
      }
      return;
    }

    if (data.type === "log") {
      const msg = data.message || "";
      const stageMatch = msg.match(/Stage "([^"]+)" (\w+)/);
      if (stageMatch) {
        const [, stageName, stageStatus] = stageMatch;

        if (stageStatus === "running") {
          if (activeRunningStage === stageName) {
            updateRunningIndicator(stageName);
            return;
          }
          finalizeRunningIndicator();
          activeRunningStage = stageName;
          activeRunningStart = Date.now();
          activeRunningEntry = addRunningIndicator(stageName, data.agent || data.data?.agent);
          return;
        }

        if (stageStatus === "succeeded" || stageStatus === "failed") {
          finalizeRunningIndicator();
          return;
        }
      }

      if (!stageMatch && msg) {
        addLogEntry(msg, "info");
      }
      return;
    }

    if (data.type === "result" && data.data?.stage) {
      const s = data.data.stage;
      finalizeRunningIndicator();

      if (s.status === "succeeded") {
        const files = s.filesModified?.length || 0;
        const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(0)}s` : "";
        const cost = s.estimatedCost ? ` · $${s.estimatedCost.toFixed(4)}` : "";
        const notes = s.notes ? ` · feedback logged` : "";
        addLogEntry(`${s.agent || s.name} completed — ${files} file(s)${dur ? ` in ${dur}` : ""}${cost}${notes}`, "success");
        speak(`${s.name} complete. ${files} files modified${dur ? ` in ${dur}` : ""}.`);
      } else if (s.status === "failed") {
        const err = s.errors?.length ? `: ${s.errors[0]}` : "";
        addLogEntry(`${s.agent || s.name} failed${err}`, "error");
        speak(`${s.name} stage failed.`);
      }
      return;
    }

    if (data.type === "status_change") {
      finalizeRunningIndicator();

      if (data.data?.status === "completed") {
        statusEl.textContent = "Pipeline completed";
        cancelBtn.style.display = "none";
        currentRunningTaskId = null;
        const stages = data.data?.stages || lastStagesSnapshot;
        const totalFiles = new Set();
        let totalCost = 0;
        stages.forEach((s) => {
          (s.filesModified || []).forEach((f) => totalFiles.add(f));
          if (s.estimatedCost) totalCost += s.estimatedCost;
        });
        const costStr = totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : "";
        addLogEntry(`Pipeline complete — ${totalFiles.size} file(s) modified${costStr}`, "success");
        speak(`Pipeline complete. ${totalFiles.size} files modified across all stages.`);
      } else if (data.data?.status === "failed") {
        const errMsg = data.data?.error || "unknown error";
        statusEl.textContent = "Pipeline failed";
        cancelBtn.style.display = "none";
        currentRunningTaskId = null;
        addLogEntry(`Pipeline failed: ${errMsg}`, "error");
        speak(`Pipeline failed. ${errMsg}.`);
      } else if (data.data?.status === "cancelled") {
        statusEl.textContent = "Pipeline cancelled";
        cancelBtn.style.display = "none";
        currentRunningTaskId = null;
        approvalBanner.classList.remove("visible");
        addLogEntry("Pipeline cancelled by user", "error");
      } else if (data.message && !data.message.includes("Stage")) {
        addLogEntry(data.message, "info");
      }
      return;
    }

    if (data.type === "approval_required") {
      finalizeRunningIndicator();
      addLogEntry(`Awaiting approval: ${data.data?.approvalType || "review"}`, "pending");
      handleApprovalRequired(data);
      return;
    }
  } catch {
    // Ignore
  }
}

function addRunningIndicator(stageName, agent) {
  const entry = document.createElement("div");
  entry.className = "log-entry running-indicator";
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const displayName = agent ? `${agent}` : stageName;
  entry.innerHTML = `<span class="time">${time}</span><span class="log-msg"><span class="spinner"></span> ${escapeHtml(displayName)} running <span class="elapsed">0s</span></span>`;
  taskLog.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth" });
  return entry;
}

function updateRunningIndicator() {
  if (!activeRunningEntry || !activeRunningStart) return;
  const elapsed = Math.floor((Date.now() - activeRunningStart) / 1000);
  const elSpan = activeRunningEntry.querySelector(".elapsed");
  if (elSpan) elSpan.textContent = `${elapsed}s`;
}

function finalizeRunningIndicator() {
  if (activeRunningEntry) {
    activeRunningEntry.remove();
    activeRunningEntry = null;
    activeRunningStage = null;
    activeRunningStart = null;
  }
}

// --- Log entries ---
function addLogEntry(message, type = "pending") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  entry.innerHTML = `<span class="time">${time}</span><span class="log-msg">${escapeHtml(message)}</span>`;
  taskLog.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth" });
  return entry;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
