const API_BASE = localStorage.getItem("apiBase") || "";
const WS_URL = localStorage.getItem("wsUrl") || "";

const micBtn = document.getElementById("micBtn");
const status = document.getElementById("status");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const taskLog = document.getElementById("taskLog");

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

micBtn.addEventListener("click", toggleRecording);
sendBtn.addEventListener("click", sendTextCommand);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendTextCommand();
});

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
    status.textContent = "Listening...";
  } catch (err) {
    status.textContent = "Microphone access denied";
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
  isRecording = false;
  micBtn.classList.remove("recording");
  status.textContent = "Processing...";
}

async function handleRecordingComplete() {
  const blob = new Blob(audioChunks, { type: "audio/webm" });
  const reader = new FileReader();
  reader.onloadend = async () => {
    const base64 = reader.result.split(",")[1];
    await sendCommand({ audioBase64: base64 });
  };
  reader.readAsDataURL(blob);
}

async function sendTextCommand() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = "";
  await sendCommand({ text });
}

async function sendCommand(payload) {
  status.textContent = "Sending command...";

  if (!API_BASE) {
    addLogEntry("Set API_BASE in localStorage first", "error");
    status.textContent = "Not configured";
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/voice-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (res.ok) {
      addLogEntry(`Task ${data.taskId} queued`, "pending");
      status.textContent = `Task queued: ${data.taskId.slice(0, 8)}...`;
      if (WS_URL) connectWebSocket(data.taskId);
    } else {
      addLogEntry(`Error: ${data.error}`, "error");
      status.textContent = "Command failed";
    }
  } catch (err) {
    addLogEntry(`Network error: ${err.message}`, "error");
    status.textContent = "Connection failed";
  }
}

function connectWebSocket(taskId) {
  if (!WS_URL) return;

  const ws = new WebSocket(`${WS_URL}?taskId=${taskId}`);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const type = data.type === "result" ? "success" : "pending";
    addLogEntry(`[${data.agent || "system"}] ${data.message}`, type);
  };

  ws.onerror = () => addLogEntry("WebSocket error", "error");
  ws.onclose = () => addLogEntry("Stream closed", "pending");
}

function addLogEntry(message, type = "pending") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;

  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="time">${time}</span> ${message}`;

  taskLog.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth" });
}
