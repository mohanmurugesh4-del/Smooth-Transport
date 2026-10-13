from __future__ import annotations

import csv
import hmac
import math
import os
import threading
from datetime import datetime, timezone, timedelta
from functools import wraps
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    jsonify,
    request,
    send_from_directory,
    session,
)

# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"
DATA_DIR = BASE_DIR / "data"
CSV_PATH = DATA_DIR / "telemetry.csv"

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=None)

# Configure these as environment variables on Render
app.secret_key = os.getenv(
    "SMOOTH_TRANSPORT_SECRET",
    "development-secret-change-before-deployment",
)

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=(
        os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
    ),
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
)

lock = threading.Lock()

# Demo credentials are for initial development only.
# Replace them with environment variables on Render.
ADMIN_USERNAME = os.getenv("ST_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("ST_ADMIN_PASSWORD", "Admin@12345")

USER_USERNAME = os.getenv("ST_USER_USER", "user")
USER_PASSWORD = os.getenv("ST_USER_PASSWORD", "User@12345")

DEVICE_TOKEN = os.getenv("SMOOTH_TRANSPORT_DEVICE_TOKEN", "")

# --------------------------------------------------
# TELEMETRY STORAGE
# --------------------------------------------------

latest: dict[str, Any] = {
    "device_id": "smooth-transport-esp32",
    "timestamp": None,
    "weight_kg": 0.0,
    "roll_deg": 0.0,
    "pitch_deg": 0.0,
    "impact_g": 0.0,
    "servo_angle": 90.0,
    "loading_mode": False,
    "load_enabled": False,
    "mpu_ok": False,
    "gps_valid": False,
    "latitude": None,
    "longitude": None,
    "gps_sats": 0,
    "gps_time": None,
}

commands: list[dict[str, Any]] = []
MAX_COMMANDS = 50

CSV_FIELDS = [
    "timestamp_utc",
    "device_id",
    "weight_kg",
    "roll_deg",
    "pitch_deg",
    "impact_g",
    "servo_angle",
    "loading_mode",
    "load_enabled",
    "mpu_ok",
    "gps_valid",
    "latitude",
    "longitude",
    "gps_sats",
    "gps_time",
]


# --------------------------------------------------
# CSV HELPERS
# --------------------------------------------------

def ensure_csv_header() -> None:
    if not CSV_PATH.exists() or CSV_PATH.stat().st_size == 0:
        with CSV_PATH.open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=CSV_FIELDS)
            writer.writeheader()


def append_csv(payload: dict[str, Any]) -> None:
    ensure_csv_header()

    row = {field: payload.get(field, "") for field in CSV_FIELDS}
    row["timestamp_utc"] = payload.get("timestamp", "")

    with CSV_PATH.open("a", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_FIELDS)
        writer.writerow(row)


# --------------------------------------------------
# AUTHENTICATION HELPERS
# --------------------------------------------------

def login_required(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        if not session.get("username"):
            return jsonify({"error": "Please log in first"}), 401

        return function(*args, **kwargs)

    return wrapper


def roles_required(*allowed_roles):
    def decorator(function):
        @wraps(function)
        def wrapper(*args, **kwargs):
            if not session.get("username"):
                return jsonify({"error": "Please log in first"}), 401

            if session.get("role") not in allowed_roles:
                return jsonify({
                    "error": "You do not have permission to perform this action"
                }), 403

            return function(*args, **kwargs)

        return wrapper

    return decorator


def queue_command(command: dict[str, Any]) -> None:
    with lock:
        commands.append(command)

        if len(commands) > MAX_COMMANDS:
            del commands[:-MAX_COMMANDS]


def valid_number(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError, OverflowError):
        return False


# --------------------------------------------------
# FRONTEND
# --------------------------------------------------

@app.get("/")
def dashboard():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/<path:filename>")
def web_asset(filename: str):
    return send_from_directory(WEB_DIR, filename)


# --------------------------------------------------
# LOGIN AND USER ROLES
# --------------------------------------------------

@app.post("/api/login")
def api_login():
    body = request.get_json(silent=True)

    if not isinstance(body, dict):
        return jsonify({"error": "Expected a JSON object"}), 400

    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))

    valid_admin = (
        hmac.compare_digest(username, ADMIN_USERNAME)
        and hmac.compare_digest(password, ADMIN_PASSWORD)
    )

    valid_user = (
        hmac.compare_digest(username, USER_USERNAME)
        and hmac.compare_digest(password, USER_PASSWORD)
    )

    if valid_admin:
        role = "admin"
    elif valid_user:
        role = "user"
    else:
        return jsonify({"error": "Invalid username or password"}), 401

    session.clear()
    session["username"] = username
    session["role"] = role
    session.permanent = True

    return jsonify({
        "ok": True,
        "username": username,
        "role": role,
    })


@app.get("/api/me")
def api_me():
    if not session.get("username"):
        return jsonify({
            "authenticated": False,
        })

    return jsonify({
        "authenticated": True,
        "username": session["username"],
        "role": session["role"],
    })


@app.post("/api/logout")
@login_required
def api_logout():
    session.clear()
    return jsonify({"ok": True})


# --------------------------------------------------
# DEVICE STATUS
# --------------------------------------------------

@app.get("/api/status")
def api_status():
    with lock:
        telemetry = dict(latest)

    timestamp = telemetry.get("timestamp")

    device_online = False

    if timestamp:
        try:
            last_seen = datetime.fromisoformat(
                timestamp.replace("Z", "+00:00")
            )

            device_online = (
                datetime.now(timezone.utc) - last_seen
            ).total_seconds() <= 10

        except (ValueError, TypeError):
            device_online = False

    return jsonify({
        "telemetry": telemetry,
        "device_online": device_online,
        "server_time": datetime.now(timezone.utc).isoformat(),
    })


# --------------------------------------------------
# ESP32 TELEMETRY
# --------------------------------------------------

@app.post("/api/telemetry")
def api_telemetry():
    # Configure SMOOTH_TRANSPORT_DEVICE_TOKEN on Render
    # and send the same token from the ESP32.
    #
    # Until configured, the endpoint remains open for
    # initial development. Configure the token before
    # exposing a hardware-connected production system.

    if DEVICE_TOKEN:
        supplied_token = request.headers.get("X-Device-Token", "")

        if not hmac.compare_digest(supplied_token, DEVICE_TOKEN):
            return jsonify({"error": "Invalid device token"}), 401

    incoming = request.get_json(silent=True)

    if not isinstance(incoming, dict):
        return jsonify({"error": "Expected a JSON object"}), 400

    required = [
        "weight_kg",
        "roll_deg",
        "pitch_deg",
        "impact_g",
        "servo_angle",
    ]

    if any(
        key not in incoming or not valid_number(incoming[key])
        for key in required
    ):
        return jsonify({
            "error": "Missing or invalid telemetry fields"
        }), 400

    weight = float(incoming["weight_kg"])
    roll = float(incoming["roll_deg"])
    pitch = float(incoming["pitch_deg"])
    impact = float(incoming["impact_g"])
    angle = float(incoming["servo_angle"])

    if impact < 0:
        return jsonify({"error": "Impact cannot be negative"}), 400

    # GPS data is optional while GPS hardware is being integrated.
    latitude = incoming.get("latitude")
    longitude = incoming.get("longitude")

    if latitude is not None and not valid_number(latitude):
        return jsonify({"error": "Invalid latitude"}), 400

    if longitude is not None and not valid_number(longitude):
        return jsonify({"error": "Invalid longitude"}), 400

    if (latitude is None) != (longitude is None):
        return jsonify({
            "error": "Latitude and longitude must be supplied together"
        }), 400

    gps_valid = (
        incoming.get("gps_valid", False) is True
        and latitude is not None
        and longitude is not None
    )

    if gps_valid:
        latitude = float(latitude)
        longitude = float(longitude)

        if not -90 <= latitude <= 90:
            return jsonify({"error": "Latitude out of range"}), 400

        if not -180 <= longitude <= 180:
            return jsonify({"error": "Longitude out of range"}), 400
    else:
        latitude = None
        longitude = None

    loading_mode = incoming.get("loading_mode", False)
    load_enabled = incoming.get("load_enabled", False)

    if not isinstance(loading_mode, bool):
        return jsonify({"error": "loading_mode must be true or false"}), 400

    if not isinstance(load_enabled, bool):
        return jsonify({"error": "load_enabled must be true or false"}), 400

    satellites = incoming.get("gps_sats", 0)

    if isinstance(satellites, bool) or not isinstance(satellites, int):
        return jsonify({"error": "gps_sats must be an integer"}), 400

    clean = {
        "device_id": str(
            incoming.get("device_id", "smooth-transport-esp32")
        )[:80],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "weight_kg": round(weight, 3),
        "roll_deg": round(roll, 3),
        "pitch_deg": round(pitch, 3),
        "impact_g": round(impact, 3),
        "servo_angle": round(min(135.0, max(45.0, angle)), 1),
        "loading_mode": loading_mode,
        "load_enabled": load_enabled,
        "mpu_ok": incoming.get("mpu_ok", False) is True,
        "gps_valid": gps_valid,
        "latitude": latitude,
        "longitude": longitude,
        "gps_sats": max(0, min(100, satellites)),
        "gps_time": str(incoming.get("gps_time", ""))[:50] or None,
    }

    with lock:
        latest.update(clean)

        try:
            append_csv(latest)
        except OSError:
            app.logger.exception("Could not write telemetry CSV")

        pending = commands.copy()
        commands.clear()

    return jsonify({
        "ok": True,
        "commands": pending,
    })


# --------------------------------------------------
# ADMIN CONTROLS
# --------------------------------------------------

@app.post("/api/commands/mode")
@roles_required("admin")
def command_mode():
    body = request.get_json(silent=True) or {}

    mode = body.get("loading_mode")

    if not isinstance(mode, bool):
        return jsonify({
            "error": "loading_mode must be true or false"
        }), 400

    angle = body.get("servo_angle", 90)

    if not valid_number(angle):
        return jsonify({"error": "Invalid servo angle"}), 400

    angle = float(angle)

    if not 45 <= angle <= 135:
        return jsonify({
            "error": "Servo angle must be between 45 and 135"
        }), 400

    queue_command({
        "type": "set_mode",
        "loading_mode": mode,
        "servo_angle": angle,
    })

    return jsonify({"ok": True, "queued": True})


@app.post("/api/commands/servo")
@roles_required("admin")
def command_servo():
    body = request.get_json(silent=True) or {}
    angle = body.get("angle")

    if not valid_number(angle):
        return jsonify({"error": "Invalid servo angle"}), 400

    angle = float(angle)

    if not 45 <= angle <= 135:
        return jsonify({
            "error": "Servo angle must be between 45 and 135"
        }), 400

    queue_command({
        "type": "set_servo",
        "angle": angle,
    })

    return jsonify({"ok": True, "queued": True})


# --------------------------------------------------
# LOADING SYSTEM: ADMIN AND USER
# --------------------------------------------------

@app.post("/api/commands/load")
@roles_required("admin", "user")
def command_load():
    body = request.get_json(silent=True) or {}
    enabled = body.get("enabled")

    if not isinstance(enabled, bool):
        return jsonify({
            "error": "enabled must be true or false"
        }), 400

    queue_command({
        "type": "set_load",
        "enabled": enabled,
    })

    return jsonify({
        "ok": True,
        "queued": True,
        "load_enabled": enabled,
    })


# --------------------------------------------------
# CSV DOWNLOAD: ADMIN ONLY
# --------------------------------------------------

@app.get("/api/telemetry.csv")
@roles_required("admin")
def download_csv():
    ensure_csv_header()

    return send_from_directory(
        DATA_DIR,
        CSV_PATH.name,
        as_attachment=True,
    )


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.get("/api/health")
def health():
    return jsonify({"ok": True})


# --------------------------------------------------
# START SERVER
# --------------------------------------------------

if __name__ == "__main__":
    ensure_csv_header()

    app.run(
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "5000")),
        debug=False,
        threaded=True,
    )