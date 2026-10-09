# Smooth Transport

An IoT container monitoring and control project with three parts:

1. **ESP32 firmware** — Arduino C++ managed by PlatformIO.
2. **Python server** — Flask REST API, command queue, and CSV telemetry logging.
3. **Live dashboard** — plain HTML, CSS, and JavaScript. No external UI libraries.

> **Safety note:** This is a development starter, not a certified transport safety system. Validate the mechanical linkage, sensor calibration, power supply, and control response on a secured bench setup before connecting a real load or vehicle. The example automatic levelling logic is intentionally basic and must be tuned to your servo linkage. An MPU6050 accelerometer-only tilt estimate is not reliable during vehicle acceleration, braking, or vibration.

## Project structure

```text
Smooth-Transport/
├── platformio.ini
├── firmware/
│   └── src/main.cpp
├── server/
│   ├── app.py
│   ├── requirements.txt
│   └── data/                 # telemetry.csv created here
├── web/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

## Features

- ESP32 sends JSON telemetry every 500 ms over Wi-Fi.
- The telemetry response contains pending commands for the ESP32 to execute.
- Dashboard polls the server every 500 ms.
- Shows weight (kg), roll and pitch (degrees), impact (g), and servo angle.
- Shows **Balanced at 0°** when both roll and pitch are within ±0.5°; logs notifications when balance is gained or lost.
- Impact signal thresholds:
  - **Green:** impact ≤ 0.5 g
  - **Amber caution:** impact > 0.5 g and < 2.0 g; the ESP32 red lamp blinks
  - **Red:** impact ≥ 2.0 g
- Loading/unloading mode pauses automatic levelling and allows manual servo commands from 45° to 135°.
- On-screen toasts, browser desktop notifications (permission required), and a scrollable event log.
- Every accepted telemetry sample is appended to `server/data/telemetry.csv`.
- CSV download link in the dashboard.

## Hardware and wiring

Use a regulated supply appropriate for each module. **Do not power the MG90S servo from the ESP32 3.3 V pin.** Use a DC-DC buck converter set to the servo's specified voltage (commonly 5 V; confirm your servo documentation). Join the servo supply ground and ESP32 ground. A separate suitable supply is recommended because servo startup/stall current can reset the ESP32.

### Example ESP32 DevKit pin map

| Component | Module pin | ESP32 connection | Notes |
|---|---|---|---|
| HX711 | VCC | 3V3 or module-rated supply | Confirm the specific board's logic-level compatibility |
| HX711 | GND | GND | Common ground |
| HX711 | DT / DOUT | GPIO 19 | Data |
| HX711 | SCK / CLK | GPIO 18 | Clock |
| Load cell | E+ / E- | HX711 E+ / E- | Excitation |
| Load cell | A+ / A- | HX711 A+ / A- | Signal; wire colors vary by load cell |
| MPU6050 | VCC | 3V3 | Use 3.3 V for a typical bare breakout; check board specification |
| MPU6050 | GND | GND | Common ground |
| MPU6050 | SDA | GPIO 21 | I²C data |
| MPU6050 | SCL | GPIO 22 | I²C clock |
| MG90S | Signal | GPIO 13 | PWM signal |
| MG90S | V+ | Buck converter positive | Never use ESP32 3V3 for servo power |
| MG90S | GND | Buck converter negative and ESP32 GND | Common ground is essential |
| Green lamp | Positive/control | GPIO 25 through suitable driver | Use a transistor/MOSFET driver and current-limiting resistor as appropriate |
| Red lamp | Positive/control | GPIO 26 through suitable driver | Use a transistor/MOSFET driver and current-limiting resistor as appropriate |

GPIOs drive logic signals only. Do not connect a high-current lamp directly to an ESP32 pin. Add appropriate drivers, resistors, flyback protection if the load requires it, and a common ground. Check your actual ESP32 board pinout before wiring.

## Load cell calibration

The calibration factor is hardware-specific. The placeholder `-7050.0` in `firmware/src/main.cpp` is **not a guaranteed value**.

1. Securely mount the load cell and connect it to the HX711.
2. With the platform empty, power up the ESP32 and let `scale.tare()` run. Keep the platform still during tare.
3. Use a known reference mass (for example, 1 kg) placed safely in the intended load position.
4. Temporarily add a calibration sketch or serial routine that calls `scale.set_scale()` with an initial factor, prints `scale.get_units(10)`, and allows the factor to be adjusted.
5. Adjust the factor until the displayed mass matches the reference mass. If the reading has the wrong sign, reverse the factor sign or verify load-cell wiring.
6. Verify with at least two other known masses across the expected operating range.
7. Put the calibrated factor in `LOAD_CELL_CALIBRATION_FACTOR`, rebuild, and repeat the checks after final mechanical installation.

Calibration tips:
- Ensure the load cell is not mechanically constrained or overloaded.
- Tare only when the platform is empty.
- A negative value is clamped to zero by the starter firmware; adjust the factor/sign rather than relying on this clamp.
- The dashboard weight is in kilograms only if your reference mass and calibration routine establish kilograms.

## Software requirements

- VS Code
- PlatformIO IDE extension
- Python 3.10 or newer
- A USB data cable and ESP32 USB serial driver if required
- ESP32 and computer connected to the same Wi-Fi network for device-to-server communication

## Setup in VS Code

### 1. Open the project

1. Extract the project folder.
2. Open VS Code.
3. Choose **File → Open Folder…** and select `Smooth-Transport`.
4. Install the **PlatformIO IDE** extension if it is not already installed.

### 2. Start the Flask server

Open a VS Code terminal (**Terminal → New Terminal**) and run:

**Windows PowerShell**
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r server/requirements.txt
python server/app.py
```

If PowerShell blocks activation, you can skip activation and use:
```powershell
py -m pip install -r server/requirements.txt
py server/app.py
```

Open `http://127.0.0.1:5000` in your browser. Keep this terminal running. The server binds to `0.0.0.0:5000` so another device on the same LAN can reach it, subject to Windows Firewall rules.

### 3. Find your computer's LAN IP address

On Windows, open a second terminal and run:
```powershell
ipconfig
```
Find the IPv4 address of the Wi-Fi adapter connected to the same network as the ESP32, such as `192.168.1.100`. Do not use `127.0.0.1` in the ESP32 firmware; that address refers to the ESP32 itself.

### 4. Configure firmware

1. Open `firmware/src/main.cpp`.
2. Set `WIFI_SSID` and `WIFI_PASSWORD`.
3. Set `SERVER_URL` to `http://<YOUR_COMPUTER_LAN_IP>:5000/api/telemetry`.
4. Set and verify the load-cell calibration factor.
5. Connect the ESP32 by USB.
6. In PlatformIO, select the `esp32dev` environment and use **Build**, then **Upload**.
7. Open the PlatformIO Serial Monitor at 115200 baud.

The required `ArduinoJson` library is resolved by PlatformIO as a transitive dependency in many setups; if the build reports `ArduinoJson.h: No such file or directory`, add `bblanchon/ArduinoJson` to `lib_deps` in `platformio.ini`, then build again.

### 5. Test the dashboard

1. Keep the Flask server running.
2. Upload firmware and reset the ESP32.
3. Confirm serial output shows Wi-Fi connected.
4. Open `http://127.0.0.1:5000` on the computer.
5. Watch the connection indicator and live readings.
6. Try loading/unloading mode and manual servo control while the mechanism is safely disconnected from any hazardous load.
7. Use **Download telemetry CSV** to export the readings.

## API reference

All endpoints are served by Flask on port `5000`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | Serve dashboard |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/status` | Return latest telemetry and server time |
| `POST` | `/api/telemetry` | Accept device telemetry, append CSV row, and return queued commands |
| `POST` | `/api/commands/mode` | Queue loading/unloading mode command |
| `POST` | `/api/commands/servo` | Queue manual servo angle |
| `GET` | `/api/telemetry.csv` | Download CSV log |

### Telemetry request example

```json
{
  "device_id": "smooth-transport-esp32",
  "timestamp_ms": 123456,
  "weight_kg": 12.34,
  "roll_deg": 0.1,
  "pitch_deg": -0.2,
  "impact_g": 0.3,
  "servo_angle": 90,
  "loading_mode": false,
  "mpu_ok": true
}
```

### Telemetry response example

```json
{
  "ok": true,
  "commands": [
    {"type": "set_mode", "loading_mode": true, "servo_angle": 90},
    {"type": "set_servo", "angle": 110}
  ]
}
```

Commands are queued by dashboard requests and delivered on the next successful ESP32 telemetry POST. The starter uses an in-memory queue; queued commands are lost if the Flask process restarts.

### Mode command

`POST /api/commands/mode`
```json
{"loading_mode": true, "servo_angle": 90}
```

Set `loading_mode` to `false` to resume automatic levelling.

### Manual servo command

`POST /api/commands/servo`
```json
{"angle": 110}
```

`angle` must be between 45 and 135 degrees. The ESP32 applies the command only while loading/unloading mode is active.

## Troubleshooting

| Symptom | Checks |
|---|---|
| ESP32 cannot connect to Wi-Fi | Check SSID/password, 2.4 GHz Wi-Fi support, signal strength, and router client isolation |
| ESP32 cannot reach Flask | Use the computer's LAN IPv4 address, not `localhost`/`127.0.0.1`; check Windows Firewall and same Wi-Fi network |
| Dashboard says “Waiting for device” | Check `/api/health`, serial monitor, URL, and server terminal errors |
| `MPU6050 not detected` | Check SDA=GPIO 21, SCL=GPIO 22, power, ground, and I²C address/board compatibility |
| Weight stays zero or drifts | Check HX711 wiring, load-cell mounting, calibration factor, tare, and whether `scale.is_ready()` succeeds |
| Servo jitters or ESP32 resets | Use a suitable buck converter/supply, connect grounds, keep servo power off the 3V3 pin, and check mechanical binding |
| Lamps do not work | Use a suitable transistor/MOSFET driver, check polarity and current-limiting components, and verify the GPIO mapping |
| PlatformIO cannot find a library | Let PlatformIO finish dependency installation; add ArduinoJson explicitly if its header is missing |
| Desktop notifications do not appear | Grant notification permission in the browser; localhost is generally treated as a secure context |
| CSV is empty | Check `server/data/telemetry.csv` and confirm telemetry POST requests are reaching the server |

## Engineering notes and limitations

- The dashboard event log is held in browser memory and clears when the page is reloaded or the user presses **Clear log**. Telemetry is persisted to CSV by the server.
- Desktop notifications require browser permission and may be blocked by OS focus settings.
- The basic roll/pitch estimate uses accelerometer readings. Dynamic vehicle motion can look like tilt/impact; a real vehicle design needs filtering/sensor fusion and tested impact-event logic.
- A hobby servo is not a safety-rated levelling actuator. Add end stops, feedback/position verification, fault handling, watchdogs, and a safe failure state before real deployment.
- For a public or production deployment, add authentication, TLS, input limits, access controls, and durable command storage.
