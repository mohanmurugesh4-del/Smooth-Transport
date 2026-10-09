#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <HX711.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <ESP32Servo.h>

// Configure these for your network and server.
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "http://192.168.1.100:5000/api/telemetry";

// ESP32 pin map (change to match your wiring).
constexpr int HX711_DOUT = 19;
constexpr int HX711_SCK = 18;
constexpr int SERVO_PIN = 13;
constexpr int GREEN_LAMP_PIN = 25;
constexpr int RED_LAMP_PIN = 26;

constexpr unsigned long TELEMETRY_INTERVAL_MS = 500;
constexpr float BALANCE_TOLERANCE_DEG = 0.5f;
constexpr float IMPACT_GREEN_G = 0.5f;
constexpr float IMPACT_RED_G = 2.0f;
constexpr float SERVO_MIN_DEG = 45.0f;
constexpr float SERVO_MAX_DEG = 135.0f;

// IMPORTANT: Replace with a value obtained using the calibration steps in README.
float LOAD_CELL_CALIBRATION_FACTOR = -7050.0f;

HX711 scale;
Adafruit_MPU6050 mpu;
Servo levellingServo;

bool loadingMode = false;
float manualServoAngle = 90.0f;
float currentServoAngle = 90.0f;
float lastRoll = 0.0f, lastPitch = 0.0f;
unsigned long lastTelemetryMs = 0;
unsigned long lastBlinkMs = 0;
bool blinkState = false;
bool mpuReady = false;

void setServo(float angle) {
  currentServoAngle = constrain(angle, SERVO_MIN_DEG, SERVO_MAX_DEG);
  levellingServo.write((int)roundf(currentServoAngle));
}

void updateSignal(float impactG) {
  if (impactG <= IMPACT_GREEN_G) {
    digitalWrite(GREEN_LAMP_PIN, HIGH);
    digitalWrite(RED_LAMP_PIN, LOW);
  } else if (impactG >= IMPACT_RED_G) {
    digitalWrite(GREEN_LAMP_PIN, LOW);
    digitalWrite(RED_LAMP_PIN, HIGH);
  } else {
    digitalWrite(GREEN_LAMP_PIN, LOW);
    if (millis() - lastBlinkMs >= 250) {
      lastBlinkMs = millis();
      blinkState = !blinkState;
      digitalWrite(RED_LAMP_PIN, blinkState ? HIGH : LOW);
    }
  }
}

void applyCommands(JsonArray commands) {
  for (JsonObject cmd : commands) {
    const char* type = cmd["type"] | "";
    if (strcmp(type, "set_mode") == 0) {
      loadingMode = cmd["loading_mode"] | false;
      if (loadingMode) {
        manualServoAngle = cmd["servo_angle"] | manualServoAngle;
        setServo(manualServoAngle);
      }
    } else if (strcmp(type, "set_servo") == 0 && loadingMode) {
      manualServoAngle = cmd["angle"] | manualServoAngle;
      setServo(manualServoAngle);
    }
  }
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\nWi-Fi connected" : "\nWi-Fi connection timed out");
}

void setup() {
  Serial.begin(115200);
  pinMode(GREEN_LAMP_PIN, OUTPUT);
  pinMode(RED_LAMP_PIN, OUTPUT);
  digitalWrite(GREEN_LAMP_PIN, LOW);
  digitalWrite(RED_LAMP_PIN, LOW);

  Wire.begin();
  scale.begin(HX711_DOUT, HX711_SCK);
  scale.set_scale(LOAD_CELL_CALIBRATION_FACTOR);
  scale.tare();

  mpuReady = mpu.begin();
  if (mpuReady) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  } else {
    Serial.println("ERROR: MPU6050 not detected. Check SDA/SCL and power.");
  }

  levellingServo.setPeriodHertz(50);
  levellingServo.attach(SERVO_PIN, 500, 2400);
  setServo(90);
  connectWiFi();
}

void loop() {
  const unsigned long now = millis();
  float weightKg = 0.0f;
  if (scale.is_ready()) {
    // The scale factor must be calibrated for your specific load cell.
    weightKg = scale.get_units(3);
    if (weightKg < 0.0f) weightKg = 0.0f;
  }

  float roll = lastRoll, pitch = lastPitch, impactG = 0.0f;
  if (mpuReady) {
    sensors_event_t accel, gyro, temp;
    mpu.getEvent(&accel, &gyro, &temp);
    const float ax = accel.acceleration.x / 9.80665f;
    const float ay = accel.acceleration.y / 9.80665f;
    const float az = accel.acceleration.z / 9.80665f;
    // Static tilt estimate; for a moving vehicle use a filtered/fused estimate.
    roll = atan2f(ay, az) * 180.0f / PI;
    pitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * 180.0f / PI;
    lastRoll = roll;
    lastPitch = pitch;
    // Impact magnitude above 1 g at rest, so subtract gravity baseline.
    const float magnitudeG = sqrtf(ax * ax + ay * ay + az * az);
    impactG = fabsf(magnitudeG - 1.0f);
  }

  updateSignal(impactG);

  if (!loadingMode) {
    // Basic proportional correction; servo linkage must be mechanically mapped
    // and validated. Tune the gain/direction for your platform before use.
    const float correction = (roll + pitch) * 0.5f;
    setServo(constrain(90.0f - correction * 1.5f, SERVO_MIN_DEG, SERVO_MAX_DEG));
  }

  if (WiFi.status() == WL_CONNECTED && now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    StaticJsonDocument<512> doc;
    doc["device_id"] = "smooth-transport-esp32";
    doc["timestamp_ms"] = now;
    doc["weight_kg"] = weightKg;
    doc["roll_deg"] = roll;
    doc["pitch_deg"] = pitch;
    doc["impact_g"] = impactG;
    doc["servo_angle"] = currentServoAngle;
    doc["loading_mode"] = loadingMode;
    doc["mpu_ok"] = mpuReady;

    String payload;
    serializeJson(doc, payload);
    HTTPClient http;
    http.setTimeout(350);
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    int status = http.POST(payload);
    if (status > 0) {
      String response = http.getString();
      StaticJsonDocument<768> reply;
      if (deserializeJson(reply, response) == DeserializationError::Ok) {
        JsonArray commands = reply["commands"].as<JsonArray>();
        if (!commands.isNull()) applyCommands(commands);
      }
    } else {
      Serial.printf("Telemetry POST failed: %s\n", http.errorToString(status).c_str());
    }
    http.end();
  }
  delay(5);
}
