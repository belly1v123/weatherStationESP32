// ESP32_WeatherStation_MVP.ino
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BMP085.h> // for BMP180/BMP085
#include <DHT.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>

// --- CONFIG ---
const char *WIFI_SSID = "Pranjal_2.4";
const char *WIFI_PASS = "PK@98400";
const char *SERVER_HOST = "http://192.168.18.6:3000"; // backend address
const char *POST_ENDPOINT = "/api/data";

const int POST_INTERVAL_MS = 15 * 1000;       // 15 seconds
const int WIFI_RETRY_INTERVAL_MS = 10 * 1000; // 10 seconds retry

// Pins (adjust to your wiring)
#define DHTPIN 4
#define DHTTYPE DHT11
#define MQ135_PIN 36 // ADC1_0 on ESP32

// RGB LED pins (common-cathode assumed; use PWM)
const int R_PIN = 14;
const int G_PIN = 12;
const int B_PIN = 13;

// OLED
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Sensors
Adafruit_BMP085 bmp;
DHT dht(DHTPIN, DHTTYPE);

// State
unsigned long lastPost = 0;
unsigned long lastWiFiRetry = 0;
bool wifiConnected = false;

// Calibration
const float BMP_TEMP_OFFSET = 0.0; // adjust if BMP reads biased
// Altitude (meters) for sea-level pressure correction (mutable at runtime)
float altitude_m = 1350.0; // set to your location altitude; will be updated from server if available

// Config fetch timing
unsigned long lastConfigFetchMs = 0;
// Poll server config every 5 minutes to pick up dashboard changes quickly
const unsigned long CONFIG_FETCH_INTERVAL_MS = 5UL * 60UL * 1000UL; // 5 minutes

void fetchConfigFromServer()
{
  if (WiFi.status() != WL_CONNECTED)
    return;
  HTTPClient http;
  String url = String(SERVER_HOST) + "/api/config";
  http.begin(url);
  int code = http.GET();
  if (code == 200)
  {
    String body = http.getString();
    // parse JSON using ArduinoJson
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, body);
    if (!err)
    {
      if (doc.containsKey("altitude_m"))
      {
        float v = doc["altitude_m"] | altitude_m;
        if (v > -500 && v < 10000)
        {
          altitude_m = v;
          Serial.printf("Config fetched: altitude_m=%.1f\n", altitude_m);
        }
      }
    }
    else
    {
      Serial.print("Config JSON parse error: ");
      Serial.println(err.c_str());
    }
  }
  http.end();
}

// DHT caching
const unsigned long DHT_MIN_READ_INTERVAL_MS = 2000;
unsigned long lastDHTReadMs = 0;
float lastValidDHTTemp = NAN;
float lastValidDHTHum = NAN;

// MQ sensor smoothing and calibration
float mqEma = NAN;
const float MQ_EMA_ALPHA = 0.2; // smoothing factor (0..1)
const float MQ_VREF = 3.3;
const int MQ_ADC_MAX = 4095;
// simple environmental correction factors (empirical)
const float MQ_HUM_FACTOR = 0.5;  // adjust baseline per %RH
const float MQ_TEMP_FACTOR = 1.0; // adjust baseline per degC
// thresholds (ADC raw after correction/EMA)
const int MQ_GOOD_THRESHOLD = 420;
const int MQ_MODERATE_THRESHOLD = 520; // treat >520 as poor

// === Helpers ===
void setRGB(uint8_t r, uint8_t g, uint8_t b)
{
  analogWrite(R_PIN, r);
  analogWrite(G_PIN, g);
  analogWrite(B_PIN, b);
}
void indicateStatusWifiConnected() { setRGB(0, 255, 0); }    // green
void indicateStatusWifiDisconnected() { setRGB(255, 0, 0); } // red
void indicateStatusSending()
{
  setRGB(0, 0, 255);
  delay(100);
  indicateStatusWifiConnected();
}
void indicateStatusError() { setRGB(120, 0, 120); } // purple

// PWM setup for ESP32
void pwmSetup()
{
  ledcAttachPin(R_PIN, 0);
  ledcSetup(0, 5000, 8);
  ledcAttachPin(G_PIN, 1);
  ledcSetup(1, 5000, 8);
  ledcAttachPin(B_PIN, 2);
  ledcSetup(2, 5000, 8);
}
void analogWrite(int pin, int val)
{
  if (pin == R_PIN)
    ledcWrite(0, val);
  if (pin == G_PIN)
    ledcWrite(1, val);
  if (pin == B_PIN)
    ledcWrite(2, val);
}

// === WiFi Reconnect ===
void checkWiFiReconnect()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    wifiConnected = false;
    indicateStatusWifiDisconnected();

    unsigned long now = millis();
    if (now - lastWiFiRetry >= WIFI_RETRY_INTERVAL_MS)
    {
      lastWiFiRetry = now;
      Serial.println("Retrying WiFi...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }
  else
  {
    if (!wifiConnected)
    {
      Serial.print("WiFi reconnected: ");
      Serial.println(WiFi.localIP());
      // fetch config right after reconnect
      fetchConfigFromServer();
      lastConfigFetchMs = millis();
    }
    wifiConnected = true;
    indicateStatusWifiConnected();
  }
}

// === Sensors ===
float readBMPTemperature() { return bmp.readTemperature() + BMP_TEMP_OFFSET; }
float readBMPPressure() { return bmp.readPressure() / 100.0F; } // Absolute pressure
// Sea-level pressure is computed on the server. Device no longer computes it.
float readDHTTemp()
{
  unsigned long now = millis();
  if (now - lastDHTReadMs >= DHT_MIN_READ_INTERVAL_MS)
  {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    lastDHTReadMs = now;
    if (!isnan(t) && t > -40 && t < 80)
      lastValidDHTTemp = t;
    if (!isnan(h) && h >= 0 && h <= 100)
      lastValidDHTHum = h;
  }
  return lastValidDHTTemp;
}
float readDHTHum() { return lastValidDHTHum; }
int readMQ135Raw() { return analogRead(MQ135_PIN); }

// Convert ADC raw to volts
float mqRawToVolts(int raw)
{
  return (float)raw / (float)MQ_ADC_MAX * MQ_VREF;
}

// Compute corrected MQ baseline using humidity and temperature
float mqApplyEnvCorrection(float raw, float tempC, float humPercent)
{
  if (!isfinite(raw))
    return raw;
  float corr = raw;
  if (isfinite(humPercent))
    corr -= (humPercent - 50.0) * MQ_HUM_FACTOR;
  if (isfinite(tempC))
    corr -= (tempC - 25.0) * MQ_TEMP_FACTOR;
  if (corr < 0)
    corr = 0;
  return corr;
}

// === Data / HTTP ===
String postJSON(float bmpT, float bmpP, float dhtT, float dhtH, int mqRaw)
{
  // Provide distinct temperature fields so server & dashboard don't mirror one value
  // Keys: bmp_temp, dht_temp, humidity (DHT), pressure (absolute), mq135_adc
  String payload = "{";
  unsigned long ts = (unsigned long)(millis() / 1000UL); // seconds since boot (server treats small numbers as relative)
  payload += "\"timestamp\":" + String(ts) + ",";
  payload += "\"bmp_temp\":" + (isnan(bmpT) ? String("null") : String(bmpT, 2)) + ",";
  payload += "\"dht_temp\":" + (isnan(dhtT) ? String("null") : String(dhtT, 2)) + ",";
  payload += "\"humidity\":" + (isnan(dhtH) ? String("null") : String(dhtH, 1)) + ",";
  payload += "\"pressure\":" + (isnan(bmpP) ? String("null") : String(bmpP, 2)) + ",";
  payload += "\"mq135_adc\":" + String(mqRaw);
  payload += "}";
  return payload;
}

bool sendDataToServer(const String &jsonPayload)
{
  if (WiFi.status() != WL_CONNECTED)
  {
    wifiConnected = false;
    indicateStatusWifiDisconnected();
    return false;
  }
  HTTPClient http;
  String url = String(SERVER_HOST) + String(POST_ENDPOINT);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  indicateStatusSending();
  int httpCode = http.POST(jsonPayload);
  if (httpCode > 0)
  {
    String resp = http.getString();
    Serial.printf("POST %d -> %s\n", httpCode, resp.c_str());
    // If server returned a config object, parse it and apply immediately
    if (resp.length() > 0)
    {
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, resp);
      if (!err && doc.containsKey("config"))
      {
        JsonObject c = doc["config"].as<JsonObject>();
        if (c.containsKey("altitude_m"))
        {
          float v = c["altitude_m"] | altitude_m;
          if (v > -500 && v < 10000)
          {
            altitude_m = v;
            Serial.printf("Config from POST: altitude_m=%.1f\n", altitude_m);
          }
        }
      }
      else if (err)
      {
        // non-fatal: server may return a simple {status:'ok'}
      }
    }
    http.end();
    indicateStatusWifiConnected();
    return (httpCode >= 200 && httpCode < 300);
  }
  else
  {
    Serial.printf("POST failed: %s\n", http.errorToString(httpCode).c_str());
    http.end();
    indicateStatusError();
    return false;
  }
}

// === Display ===
void updateOLED(float bmpT, float bmpP, float dhtT, float dhtH, int mqRaw)
{
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);
  display.setTextWrap(false);

  display.setCursor(0, 0);
  display.print("Sensors Readings");

  display.setCursor(0, 10);
  if (!isnan(bmpT))
    display.printf("BMP T:%5.1fC", bmpT);
  else
    display.print("BMP T:--.-C");
  display.setCursor(0, 22);
  if (!isnan(dhtH))
    display.printf("DHT H:%4.1f%%", dhtH);
  else
    display.print("DHT H:--.-%");

  display.setCursor(0, 34);
  if (!isnan(bmpP))
    display.printf("BMP P:%6.1f hPa", bmpP);
  else
    display.print("BMP P:---.-- hPa");
  display.setCursor(0, 44);
  // Air health label will be painted by loop (we keep the OLED simple here)
  display.setCursor(0, 55);
  display.printf("MQ:%5d", mqRaw);
  display.display();
}

// === Optional: Update Serial Print ===
void printSensorStatus(float bmpT, float bmpP, float dhtT, float dhtH, int mqRaw)
{
  unsigned long s = millis() / 1000;
  Serial.printf("[Uptime %lus] WiFi:%s | BMP T:%.2fC | BMP P:%.1f hPa | DHT T:%.2fC H:%.1f%% | MQ:%d\n",
                s,
                WiFi.status() == WL_CONNECTED ? "OK" : "OFF",
                bmpT, bmpP,
                isnan(dhtT) ? -99.0 : dhtT,
                isnan(dhtH) ? -99.0 : dhtH,
                mqRaw);
}

// === Setup & Loop ===
void setup()
{
  Serial.begin(115200);
  pwmSetup();

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
  {
    Serial.println("SSD1306 failed");
  }
  else
  {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(WHITE);
  }

  if (!bmp.begin())
    Serial.println("No BMP180 found!");
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWiFiRetry = millis();
}

void loop()
{
  float bmpT = readBMPTemperature();
  float bmpP = readBMPPressure();
  float dhtT = readDHTTemp();
  float dhtH = readDHTHum();
  int mq = readMQ135Raw();
  // MQ processing: smoothing and environmental correction
  float mqCorrected = mqApplyEnvCorrection((float)mq, dhtT, dhtH);
  if (!isfinite(mqEma))
    mqEma = mqCorrected;
  else
    mqEma = MQ_EMA_ALPHA * mqCorrected + (1 - MQ_EMA_ALPHA) * mqEma;

  // Determine health
  String airLabel = "Air: ?";
  if (mqEma < MQ_GOOD_THRESHOLD)
  {
    // Good
    setRGB(0, 200, 0);
    airLabel = "Air: Good";
  }
  else if (mqEma < MQ_MODERATE_THRESHOLD)
  {
    // Moderate
    setRGB(240, 200, 0);
    airLabel = "Air: Moderate";
  }
  else
  {
    // Poor
    setRGB(200, 0, 0);
    airLabel = "Air: Poor";
  }

  updateOLED(bmpT, bmpP, dhtT, dhtH, mq);
  // repaint air label at top-right
  display.setTextSize(1);
  display.setTextColor(WHITE);
  display.setCursor(0, 45);
  display.print(airLabel);
  display.display();

  printSensorStatus(bmpT, bmpP, dhtT, dhtH, mq);
  checkWiFiReconnect();

  unsigned long now = millis();
  if (wifiConnected && now - lastPost >= POST_INTERVAL_MS)
  {
    lastPost = now;
    String payload = postJSON(bmpT, bmpP, dhtT, dhtH, mq);
    if (!sendDataToServer(payload))
      Serial.println("Send failed");
  }

  // Periodically fetch config from server (hourly)
  if (wifiConnected && (millis() - lastConfigFetchMs >= CONFIG_FETCH_INTERVAL_MS))
  {
    fetchConfigFromServer();
    lastConfigFetchMs = millis();
  }

  delay(1000);
}
