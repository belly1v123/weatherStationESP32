// ESP32_WeatherStation_MVP.ino
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BMP085.h> // for BMP180/BMP085
#include <DHT.h>
#include <Adafruit_SSD1306.h>

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
const unsigned long CONFIG_FETCH_INTERVAL_MS = 60UL * 60UL * 1000UL; // 1 hour

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
    // crude parse for altitude_m (keep deps small)
    int idx = body.indexOf("altitude_m");
    if (idx >= 0)
    {
      int colon = body.indexOf(':', idx);
      if (colon >= 0)
      {
        int comma = body.indexOf(',', colon);
        String numstr;
        if (comma > colon)
          numstr = body.substring(colon + 1, comma);
        else
          numstr = body.substring(colon + 1);
        numstr.trim();
        float v = numstr.toFloat();
        if (v > -500 && v < 10000)
        {
          altitude_m = v;
          Serial.printf("Config: altitude_m=%.1f\n", altitude_m);
        }
      }
    }
  }
  http.end();
}

// DHT caching
const unsigned long DHT_MIN_READ_INTERVAL_MS = 2000;
unsigned long lastDHTReadMs = 0;
float lastValidDHTTemp = NAN;
float lastValidDHTHum = NAN;

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
float readBMPSeaLevelPressure()
{
  // Use measured absolute pressure (hPa) and convert to sea-level pressure
  // using the barometric formula approximation:
  // P0 = P / (1 - h/44330.0)^5.255
  float p_hpa = readBMPPressure();
  if (isnan(p_hpa) || p_hpa <= 0)
    return NAN;
  const float exponent = 5.255;
  float ratio = 1.0 - (altitude_m / 44330.0);
  if (ratio <= 0)
    return NAN;
  float seaLevel = p_hpa / pow(ratio, exponent);
  return seaLevel;
}
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

// === Data / HTTP ===
String postJSON(float bmpT, float bmpP, float bmpSeaP, float dhtT, float dhtH, int mqRaw)
{
  float chosenTemp = bmpT;
  String payload = "{";
  payload += "\"timestamp\":" + String(millis()) + ",";
  payload += "\"bmp_temp\":" + String(bmpT, 2) + ",";
  payload += "\"bmp_pressure\":" + String(bmpP, 2) + ",";
  payload += "\"bmp_sealevel\":" + String(bmpSeaP, 2) + ",";
  if (isnan(dhtT))
    payload += "\"dht_temp\":null,";
  else
    payload += "\"dht_temp\":" + String(dhtT, 2) + ",";
  if (isnan(dhtH))
    payload += "\"dht_hum\":null,";
  else
    payload += "\"dht_hum\":" + String(dhtH, 1) + ",";
  payload += "\"chosen_temp\":" + String(chosenTemp, 2) + ",";
  payload += "\"mq_raw\":" + String(mqRaw);
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
    Serial.printf("POST %d -> %s\n", httpCode, http.getString().c_str());
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
void updateOLED(float bmpT, float bmpP, float bmpSeaP, float dhtT, float dhtH, int mqRaw)
{
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);
  display.setTextWrap(false);

  display.setCursor(0, 0);
  display.print("ESP32 Weather");

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
  if (!isnan(bmpSeaP))
    display.printf("SL P:%6.1f hPa", bmpSeaP);
  else
    display.print("SL P:---.-- hPa");

  display.setCursor(0, 54);
  display.printf("MQ:%5d", mqRaw);
  display.display();
}

// === Optional: Update Serial Print ===
void printSensorStatus(float bmpT, float bmpP, float bmpSeaP, float dhtT, float dhtH, int mqRaw)
{
  unsigned long s = millis() / 1000;
  Serial.printf("[Uptime %lus] WiFi:%s | BMP T:%.2fC | BMP P:%.1f hPa | SL P:%.1f hPa | DHT T:%.2fC H:%.1f%% | MQ:%d\n",
                s,
                WiFi.status() == WL_CONNECTED ? "OK" : "OFF",
                bmpT, bmpP, bmpSeaP,
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
  float bmpSeaP = readBMPSeaLevelPressure(); // new
  float dhtT = readDHTTemp();
  float dhtH = readDHTHum();
  int mq = readMQ135Raw();

  updateOLED(bmpT, bmpP, bmpSeaP, dhtT, dhtH, mq);
  printSensorStatus(bmpT, bmpP, bmpSeaP, dhtT, dhtH, mq); // updated to include sea-level
  checkWiFiReconnect();

  unsigned long now = millis();
  if (wifiConnected && now - lastPost >= POST_INTERVAL_MS)
  {
    lastPost = now;
    String payload = postJSON(bmpT, bmpP, bmpSeaP, dhtT, dhtH, mq);
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
