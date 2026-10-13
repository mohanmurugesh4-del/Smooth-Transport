"use strict";

// =============================================
// SMOOTH TRANSPORT - FRONTEND APPLICATION
// =============================================

const POLL_MS = 1500;
const BALANCE_TOLERANCE = 0.5;
const MAX_LOG_EVENTS = 200;

const $ = (id) => document.getElementById(id);

let currentUser = null;
let lastBalanced = null;
let lastImpact = 0;
let lastTelemetryKey = "";
let logEvents = [];

let modeRequestInFlight = false;
let servoRequestInFlight = false;
let loadRequestInFlight = false;
let pollInFlight = false;


// =============================================
// GENERAL HELPERS
// =============================================

function fmt(value, digits = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        headers: {
            ...(options.headers || {})
        }
    });

    const result = await response.json().catch(() => ({}));

    if (response.status === 401 && url !== "/api/login") {
        showLogin("Your session has expired. Please sign in again.");
        throw new Error("Your session has expired. Please sign in again.");
    }

    if (!response.ok) {
        throw new Error(result.error || `Request failed (${response.status})`);
    }

    return result;
}

async function postJson(url, body) {
    return apiRequest(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
}


// =============================================
// LOGIN AND LOGOUT
// =============================================

function showLogin(message = "") {
    $("loginScreen").hidden = false;
    $("dashboard").hidden = true;

    $("loginError").textContent = message;
    $("loginPassword").value = "";

    currentUser = null;
}

function showDashboard(user) {
    currentUser = user;

    $("loginScreen").hidden = true;
    $("dashboard").hidden = false;

    $("usernameLabel").textContent = user.username;
    $("roleBadge").textContent = user.role.toUpperCase();

    const isAdmin = user.role === "admin";

    // Admin can manage servo and levelling controls.
    $("adminControls").hidden = !isAdmin;

    // Both roles can operate the loading system.
    $("loadOnButton").hidden = false;
    $("loadOffButton").hidden = false;

    // Only Admin can download telemetry.
    $("downloadCsv").hidden = !isAdmin;

    if (!isAdmin) {
        $("controlNote").textContent =
            "Servo and automatic levelling controls are available to Admin only.";
    }

    addLog(
        "Signed in",
        `${user.username} signed in as ${user.role}.`,
        "normal",
        false
    );
}

$("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = $("loginUsername").value.trim();
    const password = $("loginPassword").value;

    if (!username || !password) {
        $("loginError").textContent = "Enter your username and password.";
        return;
    }

    $("loginButton").disabled = true;
    $("loginButton").textContent = "Signing in...";
    $("loginError").textContent = "";

    try {
        const result = await postJson("/api/login", {
            username,
            password
        });

        showDashboard({
            username: result.username,
            role: result.role
        });

        await poll();
    } catch (error) {
        $("loginError").textContent = error.message;
    } finally {
        $("loginButton").disabled = false;
        $("loginButton").textContent = "Sign in";
    }
});

$("logoutButton").addEventListener("click", async () => {
    try {
        await postJson("/api/logout", {});
    } catch (error) {
        console.warn("Logout request failed:", error.message);
    }

    showLogin();
});

async function checkSession() {
    try {
        const result = await apiRequest("/api/me");

        if (result.authenticated) {
            showDashboard({
                username: result.username,
                role: result.role
            });

            await poll();
        } else {
            showLogin();
        }
    } catch (error) {
        showLogin("Unable to verify your session. Please sign in.");
    }
}


// =============================================
// NOTIFICATION SYSTEM
// =============================================

function showToast(title, message, severity = "normal") {
    const toast = document.createElement("div");

    toast.className =
        `toast ${severity === "normal" ? "" : severity}`;

    const heading = document.createElement("strong");
    heading.textContent = title;

    const body = document.createElement("p");
    body.textContent = message;

    toast.append(heading, body);
    $("toastStack").prepend(toast);

    window.setTimeout(() => toast.remove(), 5000);
}

function addLog(title, message, severity = "normal", notify = true) {
    const event = {
        title,
        message,
        severity,
        time: new Date()
    };

    logEvents.unshift(event);
    logEvents = logEvents.slice(0, MAX_LOG_EVENTS);

    renderLog();

    if (notify) {
        showToast(title, message, severity);
    }
}

function renderLog() {
    const container = $("notificationLog");

    $("logCount").textContent =
        `${logEvents.length} event${logEvents.length === 1 ? "" : "s"}`;

    container.replaceChildren();

    if (!logEvents.length) {
        const empty = document.createElement("div");

        empty.className = "empty-state";
        empty.textContent = "No events yet.";

        container.append(empty);
        return;
    }

    for (const event of logEvents) {
        const row = document.createElement("div");
        row.className = `log-item ${event.severity}`;

        const marker = document.createElement("span");
        marker.className = "log-marker";

        marker.textContent =
            event.severity === "danger" ? "!" :
            event.severity === "warning" ? "!" : "✓";

        const copy = document.createElement("div");
        copy.className = "log-copy";

        const title = document.createElement("strong");
        title.textContent = event.title;

        const message = document.createElement("p");
        message.textContent = event.message;

        copy.append(title, message);

        const time = document.createElement("time");
        time.className = "log-time";

        time.textContent = event.time.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });

        row.append(marker, copy, time);
        container.append(row);
    }
}

$("clearLog").addEventListener("click", () => {
    logEvents = [];
    renderLog();
});


// =============================================
// CONNECTION STATUS
// =============================================

function setConnection(online) {
    $("connectionDot").className =
        `dot ${online ? "online" : "offline"}`;

    $("connectionText").textContent =
        online ? "ESP32 connected" : "Waiting for ESP32";

    $("deviceStatus").textContent =
        online ? "Online" : "Offline";

    $("deviceNote").textContent = online
        ? "The ESP32 has recently sent telemetry."
        : "No recent ESP32 telemetry. Check its power, Wi-Fi and API settings.";
}


// =============================================
// IMPACT STATUS
// =============================================

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


// =============================================
// BALANCE MONITORING
// =============================================

function updateBalance(roll, pitch) {
    const balanced =
        Math.abs(roll) <= BALANCE_TOLERANCE &&
        Math.abs(pitch) <= BALANCE_TOLERANCE;

    const banner = $("balanceBanner");

    banner.classList.toggle("unbalanced", !balanced);
    banner.classList.remove("waiting");

    $("balanceIcon").textContent = balanced ? "✓" : "!";
    $("balanceTitle").textContent =
        balanced ? "Balanced" : "Balance lost";

    $("balanceDescription").textContent = balanced
        ? `Roll ${fmt(roll)}° and pitch ${fmt(pitch)}° are within tolerance.`
        : `Roll ${fmt(roll)}° and pitch ${fmt(pitch)}° are outside tolerance.`;

    if (lastBalanced !== null && balanced !== lastBalanced) {
        if (balanced) {
            addLog(
                "Container balanced",
                `Roll ${fmt(roll)}°, pitch ${fmt(pitch)}°.`
            );
        } else {
            addLog(
                "Balance lost",
                `Roll ${fmt(roll)}°, pitch ${fmt(pitch)}°.`,
                "warning"
            );
        }
    }

    lastBalanced = balanced;
}


// =============================================
// GPS LOCATION
// =============================================

function updateGps(t) {
    const valid =
        t.gps_valid === true &&
        Number.isFinite(Number(t.latitude)) &&
        Number.isFinite(Number(t.longitude)) &&
        t.latitude !== null &&
        t.longitude !== null &&
        Number(t.latitude) >= -90 &&
        Number(t.latitude) <= 90 &&
        Number(t.longitude) >= -180 &&
        Number(t.longitude) <= 180;

    $("gpsStatus").textContent = valid ? "GPS fix available" : "No GPS fix";
    $("gpsBadge").textContent = valid ? "GPS active" : "No fix";

    $("gpsSatellites").textContent =
        valid ? String(t.gps_sats ?? 0) : "—";

    if (!valid) {
        $("latitude").textContent = "—";
        $("longitude").textContent = "—";

        $("gpsMap").src = "about:blank";

        $("openMapLink").href =
            "https://www.openstreetmap.org/";

        $("gpsNote").textContent =
            "Waiting for valid GPS coordinates from the ESP32.";

        return;
    }

    const latitude = Number(t.latitude);
    const longitude = Number(t.longitude);

    $("latitude").textContent = latitude.toFixed(6);
    $("longitude").textContent = longitude.toFixed(6);

    // Coordinates are inserted only after numeric validation.
    const latText = latitude.toFixed(6);
    const lonText = longitude.toFixed(6);

    $("gpsMap").src =
        `https://www.openstreetmap.org/export/embed.html?bbox=` +
        `${longitude - 0.01}%2C${latitude - 0.01}%2C` +
        `${longitude + 0.01}%2C${latitude + 0.01}` +
        `&layer=mapnik&marker=${latitude}%2C${longitude}`;

    $("openMapLink").href =
        `https://www.openstreetmap.org/?mlat=${latText}&mlon=${lonText}#map=16/${latText}/${lonText}`;

    $("gpsNote").textContent =
        `Latest GPS time: ${t.gps_time || "Not supplied"}`;
}


// =============================================
// TELEMETRY DISPLAY
// =============================================

function updateTelemetry(t) {
    $("weight").textContent = fmt(t.weight_kg);
    $("roll").textContent = fmt(t.roll_deg);
    $("pitch").textContent = fmt(t.pitch_deg);
    $("impact").textContent = fmt(t.impact_g);

    $("deviceId").textContent =
        t.device_id || "smooth-transport-esp32";

    $("mpuStatus").textContent =
        t.mpu_ok === true ? "Connected" : "Not confirmed";

    const angle = Number(t.servo_angle ?? 90);

    $("servoAngle").textContent = fmt(angle, 0);
    $("servoPill").textContent = `${fmt(angle, 0)}°`;

    const arm = $("servoVisual").querySelector(".servo-arm");

    if (arm) {
        arm.style.transform =
            `rotate(${(angle - 90) * 1.3 - 30}deg)`;
    }

    const loadingMode = t.loading_mode === true;

    $("modeSwitch").checked = loadingMode;

    $("modeTag").textContent =
        loadingMode ? "MANUAL MODE" : "AUTO MODE";

    $("manualControls").classList.toggle("disabled", !loadingMode);

    $("servoRange").disabled =
        !loadingMode || currentUser?.role !== "admin";

    $("applyAngle").disabled =
        !loadingMode || currentUser?.role !== "admin";

    $("controlNote").textContent = loadingMode
        ? "Automatic levelling is paused. Admin can adjust the servo."
        : "Automatic levelling is active, subject to your hardware firmware.";

    const loadEnabled = t.load_enabled === true;

    $("loadStatus").textContent = loadEnabled ? "ON" : "OFF";

    $("loadTitle").textContent = loadEnabled
        ? "Loading system is ON"
        : "Loading system is OFF";

    $("loadDescription").textContent = loadEnabled
        ? "The device reports that the loading system is enabled."
        : "The device reports that the loading system is disabled.";

    $("loadIndicator").classList.toggle("active", loadEnabled);

    setSignal(Number(t.impact_g || 0));

    updateBalance(
        Number(t.roll_deg || 0),
        Number(t.pitch_deg || 0)
    );

    updateGps(t);

    const impact = Number(t.impact_g || 0);

    if (impact >= 2.0 && lastImpact < 2.0) {
        addLog(
            "High impact detected",
            `Impact reached ${fmt(impact)} g.`,
            "danger"
        );
    }

    lastImpact = impact;

    $("lastUpdated").textContent =
        new Date(t.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
}


// =============================================
// STATUS POLLING
// =============================================

async function poll() {
    if (pollInFlight || !currentUser) {
        return;
    }

    pollInFlight = true;

    try {
        const data = await apiRequest("/api/status");

        const t = data.telemetry;

        const online =
            data.device_online === true &&
            Boolean(t && t.timestamp);

        setConnection(online);

        if (!t || !t.timestamp) {
            $("balanceBanner").classList.add("waiting");

            $("balanceTitle").textContent =
                "Waiting for telemetry";

            $("balanceDescription").textContent =
                "The ESP32 has not sent its first reading yet.";

            return;
        }

        const key = JSON.stringify(t);

        if (key !== lastTelemetryKey) {
            updateTelemetry(t);
            lastTelemetryKey = key;
        }

    } catch (error) {
        console.error("Polling failed:", error.message);

        setConnection(false);
    } finally {
        pollInFlight = false;
    }
}


// =============================================
// ADMIN-ONLY SERVO AND MODE COMMANDS
// =============================================

$("modeSwitch").addEventListener("change", async (event) => {
    if (currentUser?.role !== "admin") {
        event.target.checked = !event.target.checked;

        showToast(
            "Access denied",
            "Only Admin can change levelling mode.",
            "danger"
        );

        return;
    }

    if (modeRequestInFlight) {
        return;
    }

    modeRequestInFlight = true;

    const enabled = event.target.checked;

    try {
        await postJson("/api/commands/mode", {
            loading_mode: enabled,
            servo_angle: Number($("servoRange").value)
        });

        addLog(
            enabled ? "Manual mode requested" : "Automatic mode requested",
            "The command has been queued for the ESP32.",
            "normal",
            false
        );

        showToast(
            "Mode command queued",
            "Waiting for the ESP32 to receive the command."
        );

    } catch (error) {
        event.target.checked = !enabled;

        showToast(
            "Mode command failed",
            error.message,
            "danger"
        );

    } finally {
        modeRequestInFlight = false;
    }
});

$("servoRange").addEventListener("input", (event) => {
    $("rangeValue").textContent = event.target.value;
});

$("applyAngle").addEventListener("click", async () => {
    if (currentUser?.role !== "admin") {
        return;
    }

    if (servoRequestInFlight) {
        return;
    }

    servoRequestInFlight = true;

    const angle = Number($("servoRange").value);

    $("applyAngle").disabled = true;
    $("applyAngle").textContent = "Sending...";

    try {
        await postJson("/api/commands/servo", {
            angle
        });

        addLog(
            "Servo command queued",
            `Requested servo angle: ${angle}°.`
        );

    } catch (error) {
        showToast(
            "Servo command failed",
            error.message,
            "danger"
        );

    } finally {
        $("applyAngle").textContent = "Apply servo angle";
        $("applyAngle").disabled =
            $("modeSwitch").checked === false;
        servoRequestInFlight = false;
    }
});


// =============================================
// LOADING SYSTEM ON/OFF
// =============================================

async function setLoadSystem(enabled) {
    if (!currentUser || loadRequestInFlight) {
        return;
    }

    loadRequestInFlight = true;

    $("loadOnButton").disabled = true;
    $("loadOffButton").disabled = true;

    $("loadNote").textContent =
        "Sending command to the server...";

    try {
        const result = await postJson("/api/commands/load", {
            enabled
        });

        $("loadNote").textContent = result.queued
            ? "Command queued. Waiting for the ESP32 to report the updated state."
            : "Command sent.";

        addLog(
            enabled ? "Loading system ON requested" : "Loading system OFF requested",
            "Waiting for the ESP32 to process the command.",
            "normal",
            false
        );

        showToast(
            "Command queued",
            "The displayed device state will update when new telemetry arrives."
        );

    } catch (error) {
        $("loadNote").textContent = error.message;

        showToast(
            "Loading command failed",
            error.message,
            "danger"
        );

    } finally {
        $("loadOnButton").disabled = false;
        $("loadOffButton").disabled = false;

        loadRequestInFlight = false;
    }
}

$("loadOnButton").addEventListener("click", () => {
    setLoadSystem(true);
});

$("loadOffButton").addEventListener("click", () => {
    setLoadSystem(false);
});


// =============================================
// START APPLICATION
// =============================================

renderLog();

checkSession();

window.setInterval(poll, POLL_MS);