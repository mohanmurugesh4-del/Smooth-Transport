"use strict";

// =====================================================
// SMOOTH TRANSPORT
// Login, registration, dashboard and device controls
// =====================================================

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


// =====================================================
// API HELPERS
// =====================================================

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
        showLogin(
            "Your session has expired. Please sign in again."
        );

        throw new Error(
            "Your session has expired. Please sign in again."
        );
    }

    if (!response.ok) {
        throw new Error(
            result.error || `Request failed (${response.status})`
        );
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


function fmt(value, digits = 2) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number.toFixed(digits)
        : "—";
}


// =====================================================
// LOGIN AND REGISTRATION PANELS
// =====================================================

function showLogin(message = "") {
    $("loginScreen").hidden = false;
    $("dashboard").hidden = true;

    $("loginPanel").hidden = false;
    $("registerPanel").hidden = true;

    $("loginError").textContent = message;

    $("registerError").textContent = "";
    $("registerSuccess").textContent = "";

    $("loginPassword").value = "";

    currentUser = null;
}


function showRegister() {
    $("loginPanel").hidden = true;
    $("registerPanel").hidden = false;

    $("registerError").textContent = "";
    $("registerSuccess").textContent = "";

    $("registerForm").reset();

    $("registerUsername").focus();
}


$("showRegisterButton").addEventListener("click", () => {
    showRegister();
});


$("showLoginButton").addEventListener("click", () => {
    showLogin();

    $("loginUsername").focus();
});


// =====================================================
// SHOW AUTHENTICATED DASHBOARD
// =====================================================

function showDashboard(user) {
    currentUser = user;

    $("loginScreen").hidden = true;
    $("dashboard").hidden = false;

    $("usernameLabel").textContent = user.username;

    $("roleBadge").textContent = user.role.toUpperCase();

    const isAdmin = user.role === "admin";

    // Only Admin can access levelling controls.
    $("adminControls").hidden = !isAdmin;

    // Both roles can use loading-system controls.
    $("loadOnButton").hidden = false;
    $("loadOffButton").hidden = false;

    // Only Admin can download telemetry.
    $("downloadCsv").hidden = !isAdmin;

    if (!isAdmin) {
        $("controlNote").textContent =
            "Servo and levelling controls are available to Admin only.";
    }

    addLog(
        "Signed in",
        `${user.username} signed in as ${user.role}.`,
        "normal",
        false
    );
}


// =====================================================
// SIGN IN
// =====================================================

$("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = $("loginUsername").value.trim();

    const password = $("loginPassword").value;

    if (!username || !password) {
        $("loginError").textContent =
            "Enter your username and password.";

        return;
    }

    const button = $("loginButton");

    button.disabled = true;
    button.textContent = "Signing in...";

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
        button.disabled = false;
        button.textContent = "Sign In";
    }
});


// =====================================================
// CREATE ACCOUNT
// =====================================================

$("registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = $("registerUsername").value
        .trim()
        .toLowerCase();

    const password = $("registerPassword").value;

    const confirmPassword =
        $("registerConfirmPassword").value;

    const button = $("registerButton");

    $("registerError").textContent = "";
    $("registerSuccess").textContent = "";

    // Validate the username.
    const usernamePattern = /^[a-z0-9_.-]{3,30}$/;

    if (!usernamePattern.test(username)) {
        $("registerError").textContent =
            "Use 3–30 characters: lowercase letters, numbers, dots, underscores or hyphens.";

        return;
    }

    // Validate the password length.
    if (password.length < 10 || password.length > 128) {
        $("registerError").textContent =
            "Your password must contain 10–128 characters.";

        return;
    }

    // Confirm that both passwords match.
    if (password !== confirmPassword) {
        $("registerError").textContent =
            "Your passwords do not match.";

        $("registerConfirmPassword").focus();

        return;
    }

    button.disabled = true;
    button.textContent = "Creating account...";

    try {
        const result = await postJson("/api/register", {
            username,
            password,
            confirm_password: confirmPassword
        });

        $("registerSuccess").textContent =
            result.message ||
            "Account created successfully. You can now sign in.";

        $("registerForm").reset();

        // Return to login and prefill the new username.
        $("loginPanel").hidden = false;
        $("registerPanel").hidden = true;

        $("loginUsername").value = username;
        $("loginPassword").value = "";

        $("loginError").textContent = "";

        showToast(
            "Account created",
            "Your account is ready. Sign in using your new credentials."
        );

        $("loginPassword").focus();

    } catch (error) {
        $("registerError").textContent = error.message;

    } finally {
        button.disabled = false;
        button.textContent = "Create My Account";
    }
});


// =====================================================
// LOGOUT
// =====================================================

$("logoutButton").addEventListener("click", async () => {
    try {
        await postJson("/api/logout", {});

    } catch (error) {
        console.warn("Logout request failed:", error.message);
    }

    showLogin();

    $("loginUsername").focus();
});


// =====================================================
// RESTORE EXISTING SESSION
// =====================================================

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
        showLogin(
            "Unable to verify your session. Please sign in again."
        );
    }
}


// =====================================================
// TOAST NOTIFICATIONS
// =====================================================

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

    window.setTimeout(() => {
        toast.remove();
    }, 5000);
}


// =====================================================
// EVENT LOG
// =====================================================

function addLog(
    title,
    message,
    severity = "normal",
    notify = true
) {
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

        row.className =
            `log-item ${event.severity === "normal" ? "" : event.severity}`;

        const marker = document.createElement("span");

        marker.className = "log-marker";

        marker.textContent =
            event.severity === "danger"
                ? "!"
                : event.severity === "warning"
                    ? "!"
                    : "✓";

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


// =====================================================
// CONNECTION STATUS
// =====================================================

function setConnection(online) {
    $("connectionDot").className =
        `dot ${online ? "online" : "offline"}`;

    $("connectionText").textContent =
        online ? "ESP32 connected" : "Waiting for ESP32";

    $("deviceStatus").textContent =
        online ? "Online" : "Offline";

    $("deviceNote").textContent = online
        ? "The ESP32 recently sent telemetry."
        : "No recent ESP32 telemetry. Check device power, Wi-Fi and API settings.";
}


// =====================================================
// IMPACT STATUS
// =====================================================

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


// =====================================================
// BALANCE MONITORING
// =====================================================

function updateBalance(roll, pitch) {
    const balanced =
        Math.abs(roll) <= BALANCE_TOLERANCE &&
        Math.abs(pitch) <= BALANCE_TOLERANCE;

    const banner = $("balanceBanner");

    banner.classList.toggle("unbalanced", !balanced);

    banner.classList.remove("waiting");

    $("balanceIcon").textContent =
        balanced ? "✓" : "!";

    $("balanceTitle").textContent =
        balanced ? "Balanced at 0°" : "Balance lost";

    $("balanceDescription").textContent = balanced
        ? `Roll ${fmt(roll)}° and pitch ${fmt(pitch)}° are within tolerance.`
        : `Roll ${fmt(roll)}° and pitch ${fmt(pitch)}° are outside tolerance.`;

    if (
        lastBalanced !== null &&
        balanced !== lastBalanced
    ) {
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


// =====================================================
// GPS DISPLAY
// =====================================================

function updateGps(t) {
    const latitudeValue = Number(t.latitude);

    const longitudeValue = Number(t.longitude);

    const valid =
        t.gps_valid === true &&
        t.latitude !== null &&
        t.longitude !== null &&
        Number.isFinite(latitudeValue) &&
        Number.isFinite(longitudeValue) &&
        latitudeValue >= -90 &&
        latitudeValue <= 90 &&
        longitudeValue >= -180 &&
        longitudeValue <= 180;

    $("gpsStatus").textContent =
        valid ? "GPS fix available" : "No GPS fix";

    $("gpsBadge").textContent =
        valid ? "GPS active" : "No fix";

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

    const lat = latitudeValue.toFixed(6);

    const lon = longitudeValue.toFixed(6);

    $("latitude").textContent = lat;

    $("longitude").textContent = lon;

    const delta = 0.01;

    const bbox = [
        longitudeValue - delta,
        latitudeValue - delta,
        longitudeValue + delta,
        latitudeValue + delta
    ].join(",");

    $("gpsMap").src =
        "https://www.openstreetmap.org/export/embed.html" +
        `?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;

    $("openMapLink").href =
        `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;

    $("gpsNote").textContent =
        `Latest GPS time: ${t.gps_time || "Not supplied"}`;
}


// =====================================================
// TELEMETRY DISPLAY
// =====================================================

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

    $("manualControls").classList.toggle(
        "disabled",
        !loadingMode
    );

    const canControlServo =
        loadingMode && currentUser?.role === "admin";

    $("servoRange").disabled = !canControlServo;

    $("applyAngle").disabled = !canControlServo;

    $("controlNote").textContent = loadingMode
        ? "Automatic levelling is paused. Admin can adjust the servo."
        : "Automatic levelling is active, subject to your ESP32 firmware.";

    const loadEnabled = t.load_enabled === true;

    $("loadStatus").textContent =
        loadEnabled ? "ON" : "OFF";

    $("loadTitle").textContent =
        loadEnabled
            ? "Loading system is ON"
            : "Loading system is OFF";

    $("loadDescription").textContent =
        loadEnabled
            ? "The device reports that loading is enabled."
            : "The device reports that loading is disabled.";

    $("loadIndicator").classList.toggle(
        "active",
        loadEnabled
    );

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

    const timestamp = Date.parse(t.timestamp);

    $("lastUpdated").textContent = Number.isFinite(timestamp)
        ? new Date(timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        })
        : "—";
}


// =====================================================
// TELEMETRY POLLING
// =====================================================

async function poll() {
    if (pollInFlight || !currentUser) {
        return;
    }

    pollInFlight = true;

    try {
        const data = await apiRequest("/api/status");

        const telemetry = data.telemetry;

        const online =
            data.device_online === true &&
            Boolean(telemetry && telemetry.timestamp);

        setConnection(online);

        if (!telemetry || !telemetry.timestamp) {
            $("balanceBanner").classList.add("waiting");

            $("balanceTitle").textContent =
                "Waiting for telemetry";

            $("balanceDescription").textContent =
                "The ESP32 has not sent its first reading yet.";

            return;
        }

        const key = JSON.stringify(telemetry);

        if (key !== lastTelemetryKey) {
            updateTelemetry(telemetry);

            lastTelemetryKey = key;
        }

    } catch (error) {
        console.error(
            "Telemetry polling failed:",
            error.message
        );

        setConnection(false);

    } finally {
        pollInFlight = false;
    }
}


// =====================================================
// ADMIN-ONLY LEVELLING MODE
// =====================================================

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
            enabled
                ? "Manual mode requested"
                : "Automatic mode requested",
            "The command was queued for the ESP32.",
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


// =====================================================
// ADMIN-ONLY SERVO CONTROL
// =====================================================

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
            `Requested servo angle: ${angle}°.`,
            "normal",
            false
        );

        showToast(
            "Servo command queued",
            "Waiting for the ESP32 to process the command."
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
            !(
                $("modeSwitch").checked &&
                currentUser?.role === "admin"
            );

        servoRequestInFlight = false;
    }
});


// =====================================================
// LOADING SYSTEM ON/OFF
// =====================================================

async function setLoadSystem(enabled) {
    if (!currentUser || loadRequestInFlight) {
        return;
    }

    loadRequestInFlight = true;

    $("loadOnButton").disabled = true;

    $("loadOffButton").disabled = true;

    $("loadNote").textContent =
        "Sending the command to the server...";

    try {
        const result = await postJson(
            "/api/commands/load",
            { enabled }
        );

        $("loadNote").textContent = result.queued
            ? "Command queued. Waiting for the ESP32 to report its state."
            : "Command sent.";

        addLog(
            enabled
                ? "Loading system ON requested"
                : "Loading system OFF requested",
            "Waiting for the ESP32 to process the command.",
            "normal",
            false
        );

        showToast(
            "Command queued",
            "The displayed state will update when new device telemetry arrives."
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


// =====================================================
// START APPLICATION
// =====================================================

renderLog();

checkSession();

window.setInterval(poll, POLL_MS);