from __future__ import annotations

import csv
import hmac
import math
import os
import re
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

from supabase import create_client
from werkzeug.security import (
    generate_password_hash,
    check_password_hash,
)


# =====================================================
# APPLICATION CONFIGURATION
# =====================================================

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"
DATA_DIR = BASE_DIR / "data"
CSV_PATH = DATA_DIR / "telemetry.csv"

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=None)

app.secret_key = os.getenv(
    "SMOOTH_TRANSPORT_SECRET",
    "development-only-secret-change-before-production",
)

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=(
        os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
    ),
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    MAX_CONTENT_LENGTH=64 * 1024,
)


# =====================================================
# ADMIN AND LEGACY USER CONFIGURATION
# =====================================================

ADMIN_USERNAME = os.getenv(
    "ST_ADMIN_USER",
    "admin",
).strip()

ADMIN_PASSWORD = os.getenv(
    "ST_ADMIN_PASSWORD",
    "Admin@12345",
)

# Keep the existing User account available during migration.
# Newly registered users will have their own credentials.

LEGACY_USER_USERNAME = os.getenv(
    "ST_USER_USER",
    "user",
).strip()

LEGACY_USER_PASSWORD = os.getenv(
    "ST_USER_PASSWORD",
    "User@12345",
)


# =====================================================
# SUPABASE DATABASE CONNECTION
# =====================================================

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()

SUPABASE_SECRET_KEY = os.getenv(
    "SUPABASE_SECRET_KEY",
    "",
).strip()

supabase_client = None

if SUPABASE_URL and SUPABASE_SECRET_KEY:
    try:
        supabase_client = create_client(
            SUPABASE_URL,
            SUPABASE_SECRET_KEY,
        )

        app.logger.info("Supabase client initialized.")

    except Exception:
        app.logger.exception(
            "Could not initialize Supabase client."
        )

else:
    app.logger.warning(
        "Supabase is not configured. "
        "New account registration is unavailable."
    )


# =====================================================
# ESP32 DEVICE AUTHENTICATION
# =====================================================

DEVICE_TOKEN = os.getenv(
    "SMOOTH_TRANSPORT_DEVICE_TOKEN",
    "",
).strip()


# =====================================================
# TELEMETRY AND COMMAND STORAGE
# =====================================================

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

USERNAME_PATTERN = re.compile(
    r"^[a-z0-9_.-]{3,30}$"
)


# =====================================================
# CSV HELPERS
# =====================================================

def ensure_csv_header() -> None:
    if not CSV_PATH.exists() or CSV_PATH.stat().st_size == 0:
        with CSV_PATH.open(
            "w",
            newline="",
            encoding="utf-8",
        ) as file:
            writer = csv.DictWriter(
                file,
                fieldnames=CSV_FIELDS,
            )

            writer.writeheader()


def append_csv(payload: dict[str, Any]) -> None:
    ensure_csv_header()

    row = {
        field: payload.get(field, "")
        for field in CSV_FIELDS
    }

    row["timestamp_utc"] = payload.get(
        "timestamp",
        "",
    )

    with CSV_PATH.open(
        "a",
        newline="",
        encoding="utf-8",
    ) as file:
        writer = csv.DictWriter(
            file,
            fieldnames=CSV_FIELDS,
        )

        writer.writerow(row)


# =====================================================
# VALIDATION HELPERS
# =====================================================

def valid_number(value: Any) -> bool:
    try:
        return math.isfinite(float(value))

    except (
        TypeError,
        ValueError,
        OverflowError,
    ):
        return False


def queue_command(command: dict[str, Any]) -> None:
    with lock:
        commands.append(command)

        if len(commands) > MAX_COMMANDS:
            del commands[:-MAX_COMMANDS]


# =====================================================
# LOGIN AND ROLE PROTECTION
# =====================================================

def login_required(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        if not session.get("username"):
            return jsonify({
                "error": "Please sign in first."
            }), 401

        return function(*args, **kwargs)

    return wrapper


def roles_required(*allowed_roles):
    def decorator(function):
        @wraps(function)
        def wrapper(*args, **kwargs):

            if not session.get("username"):
                return jsonify({
                    "error": "Please sign in first."
                }), 401

            if session.get("role") not in allowed_roles:
                return jsonify({
                    "error": (
                        "You do not have permission "
                        "to perform this action."
                    )
                }), 403

            return function(*args, **kwargs)

        return wrapper

    return decorator


# =====================================================
# DASHBOARD
# =====================================================

@app.get("/")
def dashboard():
    return send_from_directory(
        WEB_DIR,
        "index.html",
    )


@app.get("/<path:filename>")
def web_asset(filename: str):
    return send_from_directory(
        WEB_DIR,
        filename,
    )


# =====================================================
# CREATE PERSONAL USER ACCOUNT
# =====================================================

@app.post("/api/register")
def api_register():

    if supabase_client is None:
        return jsonify({
            "error": (
                "Registration is unavailable right now. "
                "Please try again later."
            )
        }), 503

    body = request.get_json(silent=True)

    if not isinstance(body, dict):
        return jsonify({
            "error": "Expected a JSON object."
        }), 400

    username = str(
        body.get("username", "")
    ).strip().lower()

    password = body.get("password", "")
    confirm_password = body.get("confirm_password", "")

    # Username validation.
    if not USERNAME_PATTERN.fullmatch(username):
        return jsonify({
            "error": (
                "Username must contain 3–30 characters. "
                "Use lowercase letters, numbers, periods, "
                "underscores or hyphens."
            )
        }), 400

    # Password validation.
    if (
        not isinstance(password, str)
        or not isinstance(confirm_password, str)
    ):
        return jsonify({
            "error": "Invalid password."
        }), 400

    if len(password) < 10:
        return jsonify({
            "error": (
                "Password must contain at least "
                "10 characters."
            )
        }), 400

    if len(password) > 128:
        return jsonify({
            "error": "Password is too long."
        }), 400

    if password != confirm_password:
        return jsonify({
            "error": "Passwords do not match."
        }), 400

    # Prevent registration using existing account names.
    reserved_usernames = {
        ADMIN_USERNAME.lower(),
        LEGACY_USER_USERNAME.lower(),
        "admin",
    }

    if username in reserved_usernames:
        return jsonify({
            "error": (
                "This username is reserved. "
                "Please choose another."
            )
        }), 400

    # Check whether this username already exists.
    try:
        existing = (
            supabase_client
            .table("app_users")
            .select("id")
            .eq("username", username)
            .limit(1)
            .execute()
        )

        if existing.data:
            return jsonify({
                "error": (
                    "This username is already taken. "
                    "Please choose another."
                )
            }), 409

    except Exception:
        app.logger.exception(
            "Could not check the requested username."
        )

        return jsonify({
            "error": (
                "Could not access the account database. "
                "Please try again."
            )
        }), 503

    # Hash the password before storing it.
    password_hash = generate_password_hash(
        password
    )

    # Every self-registered account is a normal User.
    # Users cannot select or assign their own role.
    user_record = {
        "username": username,
        "password_hash": password_hash,
        "role": "user",
    }

    try:
        (
            supabase_client
            .table("app_users")
            .insert(user_record)
            .execute()
        )

    except Exception as error:
        error_text = str(error).lower()

        if (
            "duplicate" in error_text
            or "unique constraint" in error_text
            or "23505" in error_text
        ):
            return jsonify({
                "error": (
                    "This username is already taken."
                )
            }), 409

        app.logger.exception(
            "Could not create the user account."
        )

        return jsonify({
            "error": (
                "Could not create the account. "
                "Please try again."
            )
        }), 503

    return jsonify({
        "ok": True,
        "message": (
            "Account created successfully. "
            "You can now sign in."
        ),
    }), 201


# =====================================================
# LOGIN
# =====================================================

@app.post("/api/login")
def api_login():

    body = request.get_json(silent=True)

    if not isinstance(body, dict):
        return jsonify({
            "error": "Expected a JSON object."
        }), 400

    username_input = str(
        body.get("username", "")
    ).strip()

    password = body.get("password", "")

    if not username_input or not isinstance(password, str) or not password:
        return jsonify({
            "error": "Enter your username and password."
        }), 400

    username = username_input.lower()

    authenticated = False
    role = None
    display_username = username

    # 1. Admin authentication.
    valid_admin = (
        hmac.compare_digest(
            username,
            ADMIN_USERNAME.lower(),
        )
        and hmac.compare_digest(
            password,
            ADMIN_PASSWORD,
        )
    )

    if valid_admin:
        authenticated = True
        role = "admin"
        display_username = ADMIN_USERNAME

    # 2. Optional legacy User account.
    elif (
        LEGACY_USER_PASSWORD
        and hmac.compare_digest(
            username,
            LEGACY_USER_USERNAME.lower(),
        )
        and hmac.compare_digest(
            password,
            LEGACY_USER_PASSWORD,
        )
    ):
        authenticated = True
        role = "user"
        display_username = LEGACY_USER_USERNAME

    # 3. Accounts created through registration.
    elif supabase_client is not None:
        try:
            result = (
                supabase_client
                .table("app_users")
                .select(
                    "username,password_hash,role"
                )
                .eq("username", username)
                .limit(1)
                .execute()
            )

            if result.data:
                record = result.data[0]

                stored_hash = record.get(
                    "password_hash",
                    "",
                )

                password_matches = (
                    stored_hash
                    and check_password_hash(
                        stored_hash,
                        password,
                    )
                )

                if (
                    password_matches
                    and record.get("role") == "user"
                ):
                    authenticated = True
                    role = "user"
                    display_username = record["username"]

        except Exception:
            app.logger.exception(
                "User account lookup failed."
            )

            return jsonify({
                "error": (
                    "Unable to verify your account right now. "
                    "Please try again."
                )
            }), 503

    if not authenticated:
        return jsonify({
            "error": "Invalid username or password."
        }), 401

    # Start a fresh session after successful login.
    session.clear()

    session["username"] = display_username
    session["role"] = role
    session.permanent = True

    return jsonify({
        "ok": True,
        "username": display_username,
        "role": role,
    })


# =====================================================
# CURRENT SESSION
# =====================================================

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


# =====================================================
# LOGOUT
# =====================================================

@app.post("/api/logout")
@login_required
def api_logout():

    session.clear()

    return jsonify({
        "ok": True,
    })


# =====================================================
# DEVICE STATUS
# =====================================================

@app.get("/api/status")
@login_required
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


# =====================================================
# ESP32 TELEMETRY
# =====================================================

@app.post("/api/telemetry")
def api_telemetry():

    # If a device token is configured on Render,
    # the ESP32 must send it in the X-Device-Token header.

    if DEVICE_TOKEN:
        supplied_token = request.headers.get(
            "X-Device-Token",
            "",
        )

        if not hmac.compare_digest(
            supplied_token,
            DEVICE_TOKEN,
        ):
            return jsonify({
                "error": "Invalid device token."
            }), 401

    incoming = request.get_json(silent=True)

    if not isinstance(incoming, dict):
        return jsonify({
            "error": "Expected a JSON object."
        }), 400

    required_fields = (
        "weight_kg",
        "roll_deg",
        "pitch_deg",
        "impact_g",
        "servo_angle",
    )

    for key in required_fields:
        if (
            key not in incoming
            or not valid_number(incoming[key])
        ):
            return jsonify({
                "error": f"Missing or invalid field: {key}"
            }), 400

    weight = float(incoming["weight_kg"])
    roll = float(incoming["roll_deg"])
    pitch = float(incoming["pitch_deg"])
    impact = float(incoming["impact_g"])
    angle = float(incoming["servo_angle"])

    if weight < 0 or impact < 0:
        return jsonify({
            "error": "Weight and impact cannot be negative."
        }), 400

    # Validate optional GPS fields.
    latitude = incoming.get("latitude")
    longitude = incoming.get("longitude")

    if latitude is not None and not valid_number(latitude):
        return jsonify({
            "error": "Invalid latitude."
        }), 400

    if longitude is not None and not valid_number(longitude):
        return jsonify({
            "error": "Invalid longitude."
        }), 400

    if (latitude is None) != (longitude is None):
        return jsonify({
            "error": (
                "Latitude and longitude must be supplied together."
            )
        }), 400

    gps_valid = (
        incoming.get("gps_valid") is True
        and latitude is not None
        and longitude is not None
    )

    if gps_valid:
        latitude = float(latitude)
        longitude = float(longitude)

        if not -90 <= latitude <= 90:
            return jsonify({
                "error": "Latitude is out of range."
            }), 400

        if not -180 <= longitude <= 180:
            return jsonify({
                "error": "Longitude is out of range."
            }), 400

    else:
        latitude = None
        longitude = None

    loading_mode = incoming.get(
        "loading_mode",
        False,
    )

    load_enabled = incoming.get(
        "load_enabled",
        False,
    )

    if (
        not isinstance(loading_mode, bool)
        or not isinstance(load_enabled, bool)
    ):
        return jsonify({
            "error": "Invalid loading or mode state."
        }), 400

    satellites = incoming.get("gps_sats", 0)

    if (
        isinstance(satellites, bool)
        or not isinstance(satellites, int)
    ):
        return jsonify({
            "error": "GPS satellite count must be an integer."
        }), 400

    clean = {
        "device_id": str(
            incoming.get(
                "device_id",
                "smooth-transport-esp32",
            )
        )[:80],

        "timestamp": datetime.now(
            timezone.utc
        ).isoformat(),

        "weight_kg": round(weight, 3),
        "roll_deg": round(roll, 3),
        "pitch_deg": round(pitch, 3),
        "impact_g": round(impact, 3),

        "servo_angle": round(
            min(135.0, max(45.0, angle)),
            1,
        ),

        "loading_mode": loading_mode,
        "load_enabled": load_enabled,
        "mpu_ok": incoming.get("mpu_ok") is True,

        "gps_valid": gps_valid,
        "latitude": latitude,
        "longitude": longitude,

        "gps_sats": max(
            0,
            min(100, satellites),
        ),

        "gps_time": (
            str(incoming.get("gps_time", ""))[:50]
            or None
        ),
    }

    with lock:
        latest.update(clean)

        try:
            append_csv(latest)

        except OSError:
            app.logger.exception(
                "Could not write telemetry CSV."
            )

        pending = commands.copy()
        commands.clear()

    return jsonify({
        "ok": True,
        "commands": pending,
    })


# =====================================================
# ADMIN-ONLY: LEVELLING MODE
# =====================================================

@app.post("/api/commands/mode")
@roles_required("admin")
def command_mode():

    body = request.get_json(silent=True) or {}

    mode = body.get("loading_mode")
    angle = body.get("servo_angle", 90)

    if (
        not isinstance(mode, bool)
        or not valid_number(angle)
    ):
        return jsonify({
            "error": "Invalid mode or servo angle."
        }), 400

    angle = float(angle)

    if not 45 <= angle <= 135:
        return jsonify({
            "error": "Servo angle must be between 45 and 135."
        }), 400

    queue_command({
        "type": "set_mode",
        "loading_mode": mode,
        "servo_angle": angle,
    })

    return jsonify({
        "ok": True,
        "queued": True,
    })


# =====================================================
# ADMIN-ONLY: SERVO CONTROL
# =====================================================

@app.post("/api/commands/servo")
@roles_required("admin")
def command_servo():

    body = request.get_json(silent=True) or {}

    angle = body.get("angle")

    if not valid_number(angle):
        return jsonify({
            "error": "Invalid servo angle."
        }), 400

    angle = float(angle)

    if not 45 <= angle <= 135:
        return jsonify({
            "error": "Servo angle must be between 45 and 135."
        }), 400

    queue_command({
        "type": "set_servo",
        "angle": angle,
    })

    return jsonify({
        "ok": True,
        "queued": True,
    })


# =====================================================
# ADMIN AND USER: LOADING SYSTEM
# =====================================================

@app.post("/api/commands/load")
@roles_required("admin", "user")
def command_load():

    body = request.get_json(silent=True) or {}

    enabled = body.get("enabled")

    if not isinstance(enabled, bool):
        return jsonify({
            "error": "enabled must be true or false."
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


# =====================================================
# ADMIN-ONLY: DOWNLOAD TELEMETRY CSV
# =====================================================

@app.get("/api/telemetry.csv")
@roles_required("admin")
def download_csv():

    ensure_csv_header()

    return send_from_directory(
        DATA_DIR,
        CSV_PATH.name,
        as_attachment=True,
    )


# =====================================================
# HEALTH CHECK
# =====================================================

@app.get("/api/health")
def health():

    return jsonify({
        "ok": True,
    })


# =====================================================
# START LOCAL SERVER
# =====================================================

if __name__ == "__main__":

    ensure_csv_header()

    app.run(
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "5000")),
        debug=False,
        threaded=True,
    )