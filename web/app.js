const POLL_MS = 500;
const BALANCE_TOLERANCE = 0.5;
const MAX_LOG_EVENTS = 200;
const $ = (id) => document.getElementById(id);

let lastBalanced = null;
let lastImpact = 0;
let lastTelemetryKey = "";
let logEvents = [];
let modeRequestInFlight = false;
let servoRequestInFlight = false;

function fmt(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function showToast(title, message, severity = "normal") {
  const toast = document.createElement("div");
  toast.className = `toast ${severity === "normal" ? "" : severity}`;
  const heading = document.createElement("strong");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = message;
  toast.append(heading, body);
  $("toastStack").prepend(toast);
  window.setTimeout(() => toast.remove(), 5200);
}

function addLog(title, message, severity = "normal", notify = true) {
  const event = { title, message, severity, time: new Date() };
  logEvents.unshift(event);
  logEvents = logEvents.slice(0, MAX_LOG_EVENTS);
  renderLog();
  if (notify) {
    showToast(title, message, severity);
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(`Smooth Transport: ${title}`, { body: message, tag: title }); } catch (_) {}
    }
  }
}

function renderLog() {
  const container = $("notificationLog");
  $("logCount").textContent = `${logEvents.length} event${logEvents.length === 1 ? "" : "s"}`;
  container.replaceChildren();
  if (!logEvents.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No events yet. Notifications will appear as the system runs.";
    container.append(empty);
    return;
  }
  for (const event of logEvents) {
    const row = document.createElement("div");
    row.className = `log-item ${event.severity === "normal" ? "" : event.severity}`;
    const marker = document.createElement("span");
    marker.className = "log-marker";
    marker.textContent = event.severity === "danger" ? "ϟ" : event.severity === "warning" ? "!" : "✓";
    const copy = document.createElement("div");
    copy.className = "log-copy";
    const title = document.createElement("strong");
    title.textContent = event.title;
    const message = document.createElement("p");
    message.textContent = event.message;
    copy.append(title, message);
    const time = document.createElement("time");
    time.className = "log-time";
    time.textContent = event.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    row.append(marker, copy, time);
    container.append(row);
  }
}

function setConnection(online) {
  $("connectionDot").className = `dot ${online ? "online" : "offline"}`;
  $("connectionText").textContent = online ? "Device connected" : "Waiting for device";
}

function setSignal(impact) {
  const lamp = $("signalLamp");
  lamp.className = "lamp";
  if (impact <= 0.5) {
    lamp.classList.add("green");
    $("signalLabel").textContent = "Normal · Green";
  } else if (impact >= 2.0) {
    lamp.classList.add("red");
    $("signalLabel").textContent = "High impact · Red";
  } else {
    lamp.classList.add("amber", "blink");
    $("signalLabel").textContent = "Caution · Amber";
  }
}

function updateBalance(roll, pitch) {
  const balanced = Math.abs(roll) <= BALANCE_TOLERANCE && Math.abs(pitch) <= BALANCE_TOLERANCE;
  const banner = $("balanceBanner");
  banner.classList.toggle("unbalanced", !balanced);
  banner.classList.remove("waiting");
  $("balanceIcon").textContent = balanced ? "✓" : "!";
  $("balanceTitle").textContent = balanced ? "Balanced at 0°" : "Balance lost";
  $("balanceDescription").textContent = balanced
    ? `Roll ${fmt(roll)}° and pitch ${fmt(pitch)}° are within ±${BALANCE_TOLERANCE}° tolerance.`
    : `Roll ${fmt(roll)}° and pitch ${fmt(pitch)}° are outside the balance tolerance.`;
  if (lastBalanced !== null && balanced !== lastBalanced) {
    if (balanced) addLog("Container balanced", `Balanced at 0°. Roll ${fmt(roll)}°, pitch ${fmt(pitch)}°.`, "normal");
    else addLog("Balance lost", `Roll ${fmt(roll)}°, pitch ${fmt(pitch)}°. Levelling response is required.`, "warning");
  }
  lastBalanced = balanced;
}

function updateTelemetry(t) {
  $("weight").textContent = fmt(t.weight_kg, 2);
  $("roll").textContent = fmt(t.roll_deg, 2);
  $("pitch").textContent = fmt(t.pitch_deg, 2);
  $("impact").textContent = fmt(t.impact_g, 2);
  const angle = Number(t.servo_angle ?? 90);
  $("servoAngle").textContent = fmt(angle, 0);
  $("servoPill").textContent = `${fmt(angle, 0)}°`;
  $("servoVisual").querySelector(".servo-arm").style.transform = `rotate(${(angle - 90) * 1.3 - 30}deg)`;
  const loading = Boolean(t.loading_mode);
  $("modeSwitch").checked = loading;
  $("modeTag").textContent = loading ? "MANUAL MODE" : "AUTO MODE";
  $("manualControls").classList.toggle("disabled", !loading);
  $("servoRange").disabled = !loading;
  $("applyAngle").disabled = !loading;
  $("controlNote").textContent = loading
    ? "Automatic levelling is paused. Adjust the servo and apply the angle."
    : "Automatic levelling is active. The servo angle is controlled by the ESP32.";
  setSignal(Number(t.impact_g || 0));
  updateBalance(Number(t.roll_deg || 0), Number(t.pitch_deg || 0));

  const impact = Number(t.impact_g || 0);
  if (impact >= 2.0 && lastImpact < 2.0) {
    addLog("Maximum impact threshold reached", `Impact reached ${fmt(impact, 2)} g (red signal).`, "danger");
  }
  lastImpact = impact;
  $("lastUpdated").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function poll() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Status request failed");
    const data = await response.json();
    const t = data.telemetry;
    if (!t || !t.timestamp) {
      setConnection(false);
      return;
    }
    setConnection(true);
    const key = `${t.timestamp}|${t.roll_deg}|${t.pitch_deg}|${t.impact_g}`;
    if (key !== lastTelemetryKey) {
      updateTelemetry(t);
      lastTelemetryKey = key;
    }
  } catch (_) {
    setConnection(false);
  }
}

async function sendJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Command could not be sent");
  return result;
}

$("modeSwitch").addEventListener("change", async (event) => {
  if (modeRequestInFlight) return;
  modeRequestInFlight = true;
  const enabled = event.target.checked;
  try {
    await sendJson("/api/commands/mode", { loading_mode: enabled, servo_angle: Number($("servoRange").value) });
    $("modeTag").textContent = enabled ? "MANUAL MODE" : "AUTO MODE";
    $("manualControls").classList.toggle("disabled", !enabled);
    $("servoRange").disabled = !enabled;
    $("applyAngle").disabled = !enabled;
    $("controlNote").textContent = enabled
      ? "Automatic levelling is paused. Adjust the servo and apply the angle."
      : "Automatic levelling will resume when the ESP32 receives the command.";
    addLog(enabled ? "Manual mode enabled" : "Automatic mode enabled",
      enabled ? "Automatic levelling paused; manual servo control is available." : "Automatic levelling will resume.", "normal", false);
  } catch (error) {
    event.target.checked = !enabled;
    showToast("Mode command failed", error.message, "danger");
  } finally {
    modeRequestInFlight = false;
  }
});

$("servoRange").addEventListener("input", (event) => {
  $("rangeValue").textContent = event.target.value;
});

$("applyAngle").addEventListener("click", async () => {
  if (servoRequestInFlight) return;
  servoRequestInFlight = true;
  const angle = Number($("servoRange").value);
  $("applyAngle").textContent = "Sending…";
  try {
    await sendJson("/api/commands/servo", { angle });
    addLog("Manual servo command queued", `Requested servo angle: ${angle}°.`, "normal", false);
    showToast("Servo command queued", `The ESP32 will set the servo to ${angle}° when it next checks in.`);
  } catch (error) {
    showToast("Servo command failed", error.message, "danger");
  } finally {
    $("applyAngle").textContent = "Apply servo angle";
    servoRequestInFlight = false;
  }
});

$("clearLog").addEventListener("click", () => {
  logEvents = [];
  renderLog();
});

if ("Notification" in window && Notification.permission === "default") {
  // Request only after an explicit user interaction with the page.
  document.addEventListener("click", function requestPermissionOnce() {
    Notification.requestPermission().catch(() => {});
    document.removeEventListener("click", requestPermissionOnce);
  }, { once: true });
}

poll();
window.setInterval(poll, POLL_MS);
