from __future__ import annotations

import csv
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"
DATA_DIR = BASE_DIR / "data"
CSV_PATH = DATA_DIR / "telemetry.csv"
DATA_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=None)
lock = threading.Lock()
latest: dict[str, Any] = {
    "device_id": "smooth-transport-esp32",
    "timestamp": None,
    "weight_kg": 0.0,
    "roll_deg": 0.0,
    "pitch_deg": 0.0,
    "impact_g": 0.0,
    "servo_angle": 90.0,
    "loading_mode": False,
    "mpu_ok": False,
}
commands: list[dict[str, Any]] = []
MAX_COMMANDS = 50
CSV_FIELDS = [
    "timestamp_utc", "device_id", "weight_kg", "roll_deg", "pitch_deg",
    "impact_g", "servo_angle", "loading_mode", "mpu_ok"
]


def ensure_csv_header() -> None:
    if not CSV_PATH.exists() or CSV_PATH.stat().st_size == 0:
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=CSV_FIELDS).writeheader()


def append_csv(payload: dict[str, Any]) -> None:
    row = {
        "timestamp_utc": payload["timestamp"],
        "device_id": payload.get("device_id", ""),
        "weight_kg": payload.get("weight_kg", 0),
        "roll_deg": payload.get("roll_deg", 0),
        "pitch_deg": payload.get("pitch_deg", 0),
        "impact_g": payload.get("impact_g", 0),
        "servo_angle": payload.get("servo_angle", 90),
        "loading_mode": payload.get("loading_mode", False),
        "mpu_ok": payload.get("mpu_ok", False),
    }
    with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=CSV_FIELDS).writerow(row)


@app.get("/")
def dashboard():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/<path:filename>")
def web_asset(filename: str):
    # Serve only files from the dashboard directory.
    return send_from_directory(WEB_DIR, filename)


@app.get("/api/status")
def api_status():
    with lock:
        return jsonify({"telemetry": latest, "server_time": datetime.now(timezone.utc).isoformat()})


@app.post("/api/telemetry")
def api_telemetry():
    incoming = request.get_json(silent=True)
    if not isinstance(incoming, dict):
        return jsonify({"error": "Expected a JSON object"}), 400

    required = ("weight_kg", "roll_deg", "pitch_deg", "impact_g", "servo_angle")
    try:
        clean = {
            "device_id": str(incoming.get("device_id", "unknown"))[:80],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "weight_kg": round(float(incoming["weight_kg"]), 3),
            "roll_deg": round(float(incoming["roll_deg"]), 3),
            "pitch_deg": round(float(incoming["pitch_deg"]), 3),
            "impact_g": round(max(0.0, float(incoming["impact_g"])), 3),
            "servo_angle": round(min(135.0, max(45.0, float(incoming["servo_angle"]))), 1),
            "loading_mode": bool(incoming.get("loading_mode", False)),
            "mpu_ok": bool(incoming.get("mpu_ok", False)),
        }
        for key in required:
            if not isinstance(clean[key], (int, float)):
                raise ValueError(key)
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Missing or invalid telemetry fields"}), 400

    with lock:
        latest.update(clean)
        append_csv(latest)
        pending = commands.copy()
        commands.clear()
    return jsonify({"ok": True, "commands": pending})


@app.post("/api/commands/mode")
def command_mode():
    body = request.get_json(silent=True) or {}
    mode = body.get("loading_mode")
    if not isinstance(mode, bool):
        return jsonify({"error": "loading_mode must be true or false"}), 400
    angle = body.get("servo_angle", 90)
    try:
        angle = min(135.0, max(45.0, float(angle)))
    except (TypeError, ValueError):
        return jsonify({"error": "servo_angle must be numeric"}), 400
    with lock:
        commands.append({"type": "set_mode", "loading_mode": mode, "servo_angle": angle})
        del commands[:-MAX_COMMANDS]
    return jsonify({"ok": True, "queued": True})


@app.post("/api/commands/servo")
def command_servo():
    body = request.get_json(silent=True) or {}
    try:
        angle = float(body["angle"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "angle must be numeric"}), 400
    if not 45 <= angle <= 135:
        return jsonify({"error": "angle must be between 45 and 135"},), 400
    with lock:
        commands.append({"type": "set_servo", "angle": angle})
        del commands[:-MAX_COMMANDS]
    return jsonify({"ok": True, "queued": True})


@app.get("/api/telemetry.csv")
def download_csv():
    ensure_csv_header()
    return send_from_directory(DATA_DIR, CSV_PATH.name, as_attachment=True)


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


if __name__ == "__main__":
    ensure_csv_header()
    app.run(host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "5000")), debug=False, threaded=True)
