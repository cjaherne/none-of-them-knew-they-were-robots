// --- State ---
let adapter = null;
let currentStreamHandle = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let voiceEnabled = true;
let currentLogLevelFilter = "INFO";
const LOG_LEVEL_PRIORITY = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

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
const localUrl = document.getElementById("localUrl");
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
const logEntriesTop = document.getElementById("logEntriesTop");
const stageBlocks = document.getElementById("stageBlocks");
const logLevelSelect = document.getElementById("logLevelSelect");
const tabLive = document.getElementById("tabLive");
const tabHistory = document.getElementById("tabHistory");
const historyView = document.getElementById("historyView");
const historyList = document.getElementById("historyList");
const historyDetail = document.getElementById("historyDetail");
const historyBackBtn = document.getElementById("historyBackBtn");
const historyDetailTitle = document.getElementById("historyDetailTitle");
const historyDetailLogs = document.getElementById("historyDetailLogs");

// --- Adapter creation ---
function createAdapter() {
  const base = localUrl.value.trim() || window.location.origin;
  adapter = new BackendAdapter(base);
  applyFeatureVisibility();
}

function applyFeatureVisibility() {
  if (!adapter) return;
  localConfig.style.display = "";
  cancelBtn.style.display = "none"; // always hidden until a task is running
}

// --- Init ---
(function init() {
  localUrl.value = localStorage.getItem("localUrl") || "";

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
  syncLogLevel();
})();

// --- Settings / persistence ---
sidebarToggle.addEventListener("click", () => {
  sidebar.classList.toggle("mobile-open");
});

localUrl.addEventListener("change", () => {
  localStorage.setItem("localUrl", localUrl.value.trim());
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
    statusEl.textContent = `Pipeline running for ${result.taskId.slice(0, 8)}...`;
    speak("Starting pipeline. Analyzing your request.");
    showPipeline(result.taskId);
    connectStream(result.taskId);
    addLogEntry(`Task ${result.taskId.slice(0, 8)}... queued`, "pending", null);
  } catch (err) {
    addLogEntry(`Error: ${err.message}`, "error");
    statusEl.textContent =
      "Connection failed -- is the server running?";
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
      statusEl.textContent = `Pipeline running for ${result.taskId.slice(0, 8)}...`;
      speak("Starting pipeline. Analyzing your request.");
      showPipeline(result.taskId);
      connectStream(result.taskId);
      addLogEntry(`Task ${result.taskId.slice(0, 8)}... queued (voice)`, "pending", null);
    } catch (err) {
      addLogEntry(`Error: ${err.message}`, "error");
      statusEl.textContent =
        "Connection failed -- is the server running?";
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
  finalizeAllRunningIndicators();
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

  let hasUnaddressedFeedback = false;
  for (const s of stages) {
    if (s.filesModified) s.filesModified.forEach((f) => totalFiles.add(f));
    if (s.durationMs) totalDuration += s.durationMs;
    if (s.estimatedCost) totalCost += s.estimatedCost;
    if (s.notes) hasNotes = true;
    if (s.feedbackLimitReached) hasUnaddressedFeedback = true;
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
  if (hasUnaddressedFeedback) {
    html += `<span class="summary-stat" style="color: var(--warning)">feedback not implemented</span>`;
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

  const unaddressedStage = stages.find((s) => s.feedbackLimitReached && s.unaddressedFeedback);
  if (unaddressedStage) {
    const preview = unaddressedStage.unaddressedFeedback.length > 600
      ? unaddressedStage.unaddressedFeedback.slice(0, 600) + "..."
      : unaddressedStage.unaddressedFeedback;
    html += `<div class="feedback-card feedback-not-implemented">`;
    html += `<div class="feedback-header">`;
    html += `<span>Feedback not implemented</span>`;
    html += `<span class="feedback-arrow">loop limit reached</span>`;
    html += `</div>`;
    html += `<div class="feedback-body">${escapeHtml(preview)}</div>`;
    html += `</div>`;
  }

  stageDetail.innerHTML = html;
}

// --- Streaming ---
// Track running indicators per stage (supports parallel stages)
const runningIndicators = new Map(); // stageName -> { entry, start, filesEdited }
let runningIndicatorInterval = null;
const stageBlockMap = {};

function ensureStageBlocks(stages) {
  if (!stages || stages.length === 0 || !stageBlocks) return;
  for (const s of stages) {
    if (stageBlockMap[s.name]) continue;
    const block = document.createElement("div");
    block.className = "stage-block collapsed";
    block.dataset.stage = s.name;
    block.innerHTML = `
      <div class="stage-block-header" data-stage="${escapeHtml(s.name)}">
        <span class="stage-block-toggle">&#9660;</span>
        <span class="stage-block-name">${escapeHtml(s.agent || s.name)}</span>
        <span class="stage-block-summary"></span>
        <span class="stage-block-status pending">pending</span>
      </div>
      <div class="stage-block-body"></div>
    `;
    const header = block.querySelector(".stage-block-header");
    const body = block.querySelector(".stage-block-body");
    header.addEventListener("click", () => {
      block.classList.toggle("expanded");
      block.classList.toggle("collapsed", !block.classList.contains("expanded"));
    });
    stageBlocks.appendChild(block);
    stageBlockMap[s.name] = { block, header, body };
  }
}

function expandStageBlock(stageName) {
  const entry = stageBlockMap[stageName];
  if (!entry) return;
  entry.block.classList.add("expanded");
  entry.block.classList.remove("collapsed");
  const statusEl = entry.block.querySelector(".stage-block-status");
  if (statusEl) statusEl.textContent = "running";
  if (statusEl) statusEl.className = "stage-block-status running";
}

function collapseStageBlock(stageName, summary, status) {
  const entry = stageBlockMap[stageName];
  if (!entry) return;
  entry.block.classList.remove("expanded");
  entry.block.classList.add("collapsed");
  const summaryEl = entry.block.querySelector(".stage-block-summary");
  const statusEl = entry.block.querySelector(".stage-block-status");
  if (summaryEl) summaryEl.textContent = summary;
  if (statusEl) {
    statusEl.textContent = status;
    statusEl.className = "stage-block-status " + status;
  }
}

function getStageBlockBody(stageName) {
  return stageBlockMap[stageName]?.body || null;
}

function clearStageBlocks() {
  if (stageBlocks) stageBlocks.innerHTML = "";
  for (const k of Object.keys(stageBlockMap)) delete stageBlockMap[k];
}

function connectStream(taskId) {
  if (currentStreamHandle) {
    currentStreamHandle.close();
  }

  runningIndicators.clear();
  if (runningIndicatorInterval) {
    clearInterval(runningIndicatorInterval);
    runningIndicatorInterval = null;
  }

  clearStageBlocks();
  if (logEntriesTop) logEntriesTop.innerHTML = "";

  currentStreamHandle = adapter.streamTask(taskId, handleStreamEvent);
}

function getAnyRunningStage() {
  if (runningIndicators.size === 0) return null;
  return runningIndicators.keys().next().value;
}

function handleStreamEvent(data) {
  try {
    if (handleLogEntryEvent(data, getAnyRunningStage())) return;

    if (data.type === "error") {
      finalizeAllRunningIndicators();
      addLogEntry(data.message || "Connection lost", "error", null);
      return;
    }

    if (data.type === "snapshot") {
      const stages = data.task?.stages;
      updateStages(stages);
      ensureStageBlocks(stages);
      return;
    }

    if (data.type === "done") {
      if (currentStreamHandle) { currentStreamHandle.close(); currentStreamHandle = null; }
      finalizeAllRunningIndicators();
      return;
    }

    if (data.data?.stages) {
      updateStages(data.data.stages);
      ensureStageBlocks(data.data.stages);
    }

    if (data.type === "status_change" && data.message?.includes("Pipeline stages set")) {
      const stages = data.data?.stages || [];
      ensureStageBlocks(stages);
      const stageNames = stages.map((s) => s.name).join(" → ");
      if (stageNames) {
        addLogEntry(`Pipeline: ${stageNames}`, "info", null);
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
          if (runningIndicators.has(stageName)) {
            updateRunningIndicatorFor(stageName);
            return;
          }
          ensureStageBlocks(data.data?.stages || []);
          expandStageBlock(stageName);
          const entry = addRunningIndicator(stageName, data.agent || data.data?.agent);
          runningIndicators.set(stageName, { entry, start: Date.now(), filesEdited: 0 });
          if (!runningIndicatorInterval) {
            runningIndicatorInterval = setInterval(updateAllRunningIndicators, 1000);
          }
          return;
        }

        if (stageStatus === "succeeded" || stageStatus === "failed") {
          finalizeRunningIndicatorFor(stageName);
          return;
        }
      }

      if (!stageMatch && msg) {
        const isOverseer = data.data?.overseer === true;
        const logType = isOverseer
          ? (data.data?.result === "ok" ? "success" : data.data?.result === "gaps" || data.data?.result === "drift" ? "pending" : "info")
          : "info";
        addLogEntry(msg, logType, getAnyRunningStage(), isOverseer ? { overseer: true, phase: data.data?.phase, status: data.data?.status, result: data.data?.result } : undefined);
      }
      return;
    }

    if (data.type === "result" && data.data?.stage) {
      const s = data.data.stage;
      const stageName = s.name;
      finalizeRunningIndicatorFor(stageName);

      if (s.status === "succeeded") {
        const files = s.filesModified?.length || 0;
        const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(0)}s` : "";
        const cost = s.estimatedCost ? ` · $${s.estimatedCost.toFixed(4)}` : "";
        const notes = s.notes ? ` · feedback logged` : "";
        const summary = `${files} file(s)${dur ? ` in ${dur}` : ""}${cost}${notes}`;
        collapseStageBlock(stageName, `— ${summary}`, "succeeded");
        addLogEntry(`${s.agent || s.name} completed ${summary}`, "success", stageName);
        speak(`${s.name} complete. ${files} files modified${dur ? ` in ${dur}` : ""}.`);
      } else if (s.status === "failed") {
        const err = s.errors?.length ? `: ${s.errors[0]}` : "";
        collapseStageBlock(stageName, err ? `— ${err}` : "— failed", "failed");
        addLogEntry(`${s.agent || s.name} failed${err}`, "error", stageName);
        speak(`${s.name} stage failed.`);
      }
      return;
    }

    if (data.type === "status_change") {
      finalizeAllRunningIndicators();

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
        addLogEntry(`Pipeline complete — ${totalFiles.size} file(s) modified${costStr}`, "success", null);
        speak(`Pipeline complete. ${totalFiles.size} files modified across all stages.`);
      } else if (data.data?.status === "failed") {
        const errMsg = data.data?.error || "unknown error";
        statusEl.textContent = "Pipeline failed";
        cancelBtn.style.display = "none";
        currentRunningTaskId = null;
        addLogEntry(`Pipeline failed: ${errMsg}`, "error", null);
        speak(`Pipeline failed. ${errMsg}.`);
      } else if (data.data?.status === "cancelled") {
        statusEl.textContent = "Pipeline cancelled";
        cancelBtn.style.display = "none";
        currentRunningTaskId = null;
        approvalBanner.classList.remove("visible");
        addLogEntry("Pipeline cancelled by user", "error", null);
      } else if (data.message && !data.message.includes("Stage")) {
        addLogEntry(data.message, "info", null);
      }
      return;
    }

    if (data.type === "approval_required") {
      finalizeAllRunningIndicators();
      addLogEntry(`Awaiting approval: ${data.data?.approvalType || "review"}`, "pending", getAnyRunningStage());
      handleApprovalRequired(data);
      return;
    }

    if (data.type === "stage_progress" && data.data) {
      const stageName = data.data.stageName;
      const indicator = stageName ? runningIndicators.get(stageName) : null;
      if (indicator) {
        const elapsed = data.data.elapsedSeconds;
        const files = data.data.filesEdited ?? 0;
        indicator.filesEdited = files;
        const elSpan = indicator.entry.querySelector(".elapsed");
        const filesSpan = indicator.entry.querySelector(".files-edited");
        if (elSpan) elSpan.textContent = `${elapsed}s`;
        if (filesSpan) filesSpan.textContent = `${files} file${files !== 1 ? "s" : ""}`;
      }
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
  entry.innerHTML = `<span class="time">${time}</span><span class="log-msg"><span class="spinner"></span> ${escapeHtml(displayName)} running <span class="elapsed">0s</span> · <span class="files-edited">0 files</span></span>`;
  const target = getStageBlockBody(stageName) || logEntriesTop || taskLog;
  target.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth" });
  return entry;
}

function updateRunningIndicatorFor(stageName) {
  const indicator = runningIndicators.get(stageName);
  if (!indicator) return;
  const elapsed = Math.floor((Date.now() - indicator.start) / 1000);
  const elSpan = indicator.entry.querySelector(".elapsed");
  const filesSpan = indicator.entry.querySelector(".files-edited");
  if (elSpan) elSpan.textContent = `${elapsed}s`;
  if (filesSpan) filesSpan.textContent = `${indicator.filesEdited} file${indicator.filesEdited !== 1 ? "s" : ""}`;
}

function updateAllRunningIndicators() {
  for (const stageName of runningIndicators.keys()) {
    updateRunningIndicatorFor(stageName);
  }
}

function finalizeRunningIndicatorFor(stageName) {
  const indicator = runningIndicators.get(stageName);
  if (indicator) {
    indicator.entry.remove();
    runningIndicators.delete(stageName);
  }
  if (runningIndicators.size === 0 && runningIndicatorInterval) {
    clearInterval(runningIndicatorInterval);
    runningIndicatorInterval = null;
  }
}

function finalizeAllRunningIndicators() {
  for (const [, indicator] of runningIndicators) {
    indicator.entry.remove();
  }
  runningIndicators.clear();
  if (runningIndicatorInterval) {
    clearInterval(runningIndicatorInterval);
    runningIndicatorInterval = null;
  }
}

// --- Log entries ---
function addLogEntry(message, type = "pending", stageName = null, opts = null) {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  if (opts?.overseer) {
    entry.classList.add("overseer");
    entry.dataset.overseerPhase = opts.phase || "";
    entry.dataset.overseerStatus = opts.status || "";
    if (opts.result) entry.dataset.overseerResult = opts.result;
  }
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const overseerLabel = opts?.overseer ? "<span class=\"overseer-badge\">BigBoss</span> " : "";
  entry.innerHTML = `<span class="time">${time}</span><span class="log-msg">${overseerLabel}${escapeHtml(message)}</span>`;
  const target = (stageName && getStageBlockBody(stageName)) ? getStageBlockBody(stageName) : (logEntriesTop || taskLog);
  target.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth" });
  return entry;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Log level control ---
async function syncLogLevel() {
  if (!adapter) return;
  try {
    const { level } = await adapter.getLogLevel();
    if (level) {
      logLevelSelect.value = level;
      currentLogLevelFilter = level;
    }
  } catch { /* ignore */ }
}

logLevelSelect.addEventListener("change", async () => {
  const level = logLevelSelect.value;
  currentLogLevelFilter = level;
  try {
    await adapter.setLogLevel(level);
  } catch { /* ignore */ }
});

// --- Structured log entry rendering ---
function addStructuredLogEntry(entry, stageName = null) {
  if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[currentLogLevelFilter]) return null;

  const el = document.createElement("div");
  el.className = "log-entry";
  el.dataset.level = entry.level;
  el.dataset.category = entry.category || "";

  if (entry.level === "ERROR") el.classList.add("error");
  else if (entry.level === "WARN") el.style.borderLeftColor = "var(--warning)";
  else if (entry.level === "INFO") el.classList.add("info");

  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const catTag = entry.category ? `<span class="log-category-indicator">${entry.category}</span>` : "";

  el.innerHTML = `<span class="time">${time}</span><span class="log-level-badge ${entry.level}">${entry.level}</span><span class="log-source-tag">${escapeHtml(entry.source)}</span>${catTag}<span class="log-msg">${escapeHtml(entry.message)}</span>`;
  const target = (stageName && getStageBlockBody(stageName)) ? getStageBlockBody(stageName) : (logEntriesTop || taskLog);
  target.appendChild(el);
  el.scrollIntoView({ behavior: "smooth" });
  return el;
}

// --- Handle log_entry events from SSE / WebSocket ---
function handleLogEntryEvent(data, stageContext = null) {
  if (data.type === "log_entry") {
    addStructuredLogEntry(data, stageContext);
    return true;
  }
  if (data.type === "log" && data.data?.type === "log_entry") {
    const entry = { ...data.data, message: data.message || data.data.message };
    addStructuredLogEntry(entry, stageContext);
    return true;
  }
  return false;
}

// --- Tab switching ---
let activeTab = "live";

tabLive.addEventListener("click", () => switchTab("live"));
tabHistory.addEventListener("click", () => switchTab("history"));

function switchTab(tab) {
  activeTab = tab;
  tabLive.classList.toggle("active", tab === "live");
  tabHistory.classList.toggle("active", tab === "history");

  const liveElements = [statusEl, approvalBanner, pipelinePanel, taskLog, document.getElementById("mobilePrompt")];
  for (const el of liveElements) {
    if (el) el.style.display = tab === "live" ? "" : "none";
  }

  if (tab === "history") {
    historyView.classList.add("visible");
    historyDetail.classList.remove("visible");
    loadHistory();
  } else {
    historyView.classList.remove("visible");
  }
}

// --- History view ---
async function loadHistory() {
  historyList.innerHTML = '<div style="color: var(--text-dim); font-family: var(--mono); font-size: 0.6875rem; padding: 0.5rem;">Loading...</div>';
  try {
    const tasks = await adapter.getTaskHistory(50, 0);
    if (!tasks || tasks.length === 0) {
      historyList.innerHTML = '<div style="color: var(--text-dim); font-family: var(--mono); font-size: 0.6875rem; padding: 0.5rem;">No past tasks found</div>';
      return;
    }
    historyList.innerHTML = "";
    for (const t of tasks) {
      const item = document.createElement("div");
      item.className = "history-item";
      const promptExcerpt = (t.prompt || "").slice(0, 80) + ((t.prompt || "").length > 80 ? "..." : "");
      const created = t.created_at ? relativeTime(t.created_at) : "";
      item.innerHTML = `<span class="status-dot ${t.status}"></span><span class="prompt-excerpt">${escapeHtml(promptExcerpt)}</span><span class="history-meta">${escapeHtml(created)}</span>`;
      item.addEventListener("click", () => loadTaskDetail(t.id, promptExcerpt));
      historyList.appendChild(item);
    }
  } catch (err) {
    historyList.innerHTML = `<div style="color: var(--danger); font-family: var(--mono); font-size: 0.6875rem; padding: 0.5rem;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadTaskDetail(taskId, title) {
  historyList.style.display = "none";
  historyDetail.classList.add("visible");
  historyDetailTitle.textContent = title || taskId.slice(0, 8);
  historyDetailLogs.innerHTML = '<div style="color: var(--text-dim); font-family: var(--mono); font-size: 0.6875rem; padding: 0.5rem;">Loading logs...</div>';

  try {
    const detail = await adapter.getTaskDetail(taskId);
    historyDetailLogs.innerHTML = "";

    if (detail.task) {
      const meta = document.createElement("div");
      meta.className = "log-entry info";
      meta.innerHTML = `<span class="time">${new Date(detail.task.created_at).toLocaleString()}</span><span class="log-msg">Status: <strong>${detail.task.status}</strong>${detail.task.error ? " &mdash; " + escapeHtml(detail.task.error) : ""}</span>`;
      historyDetailLogs.appendChild(meta);
    }

    if (detail.logs && detail.logs.length > 0) {
      for (const log of detail.logs) {
        const el = document.createElement("div");
        el.className = "log-entry";
        if (log.level === "ERROR") el.classList.add("error");
        else if (log.level === "WARN") el.style.borderLeftColor = "var(--warning)";
        else if (log.level === "INFO") el.classList.add("info");

        const time = new Date(log.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const catTag = log.category ? `<span class="log-category-indicator">${log.category}</span>` : "";
        el.innerHTML = `<span class="time">${time}</span><span class="log-level-badge ${log.level}">${log.level}</span><span class="log-source-tag">${escapeHtml(log.source)}</span>${catTag}<span class="log-msg">${escapeHtml(log.message)}</span>`;
        historyDetailLogs.appendChild(el);
      }
    } else {
      const empty = document.createElement("div");
      empty.style.cssText = "color: var(--text-dim); font-family: var(--mono); font-size: 0.6875rem; padding: 0.5rem;";
      empty.textContent = "No log entries for this task";
      historyDetailLogs.appendChild(empty);
    }
  } catch (err) {
    historyDetailLogs.innerHTML = `<div style="color: var(--danger); font-family: var(--mono); font-size: 0.6875rem; padding: 0.5rem;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

historyBackBtn.addEventListener("click", () => {
  historyDetail.classList.remove("visible");
  historyList.style.display = "";
});

function relativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
