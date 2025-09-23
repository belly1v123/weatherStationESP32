// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const fs = require('fs');
const CONFIG_PATH = 'config.json';
const STATE_PATH = 'runtime_state.json'; // persistence for baselines & streaks

app.use(cors());
app.use(bodyParser.json());

// Serve static frontend in ./public
app.use(express.static('public'));

// In-memory storage
const MAX_STORE = 500;
let recentData = [];
// In-memory configuration
let config = {
  altitude_m: 1350
};
// allow environment selection for comfort rules: 'home' | 'mushroom' | 'server'
if (!config.environment) config.environment = 'Home';

// Air quality high-delta streak counter for 'Unhealthy' escalation
let aqHighStreak = 0; // counts consecutive readings beyond high AQ delta threshold

// Persistent adaptive baselines (separate for day & night) + last update timestamp
let adaptiveState = {
  dayBaseline: null,
  nightBaseline: null,
  lastSaved: 0,
  savedAt: null,
  aqHighStreak: 0
};

// Hysteresis thresholds (percent deviation) for AQ classification
// Entering a category uses 'enter' threshold; exiting uses 'exit' threshold to reduce flicker
const AQ_THRESHOLDS = {
  good: { enter: 5, exit: 6 },
  moderate: { enter: 20, exit: 22 },
  // above moderate.exit => high band (poor/unhealthy)
};

// Baseline tuning parameters
const BASELINE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
const BASELINE_MIN_SAMPLES = 10;               // require at least this many to compute robust baseline
const BASELINE_TRIM_FRACTION = 0.1;            // trim 10% low & high before mean
const BASELINE_EMA_ALPHA = 0.15;               // smoothing for adaptive day/night baseline
const BASELINE_FALLBACK_DAY = 480;
const BASELINE_FALLBACK_NIGHT = 400;
const BASELINE_PERSIST_INTERVAL_MS = 5 * 60 * 1000; // save every 5 minutes

// Load runtime persistent state (if any)
try {
  if (fs.existsSync(STATE_PATH)) {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') {
      if (typeof s.dayBaseline === 'number') adaptiveState.dayBaseline = s.dayBaseline;
      if (typeof s.nightBaseline === 'number') adaptiveState.nightBaseline = s.nightBaseline;
      if (typeof s.aqHighStreak === 'number') { aqHighStreak = s.aqHighStreak; adaptiveState.aqHighStreak = s.aqHighStreak; }
      adaptiveState.savedAt = s.savedAt || null;
    }
  }
} catch (e) {
  console.error('Failed to load runtime_state', e);
}

function persistStateIfNeeded() {
  const now = Date.now();
  if (now - adaptiveState.lastSaved < BASELINE_PERSIST_INTERVAL_MS) return;
  adaptiveState.lastSaved = now;
  adaptiveState.aqHighStreak = aqHighStreak;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      dayBaseline: adaptiveState.dayBaseline,
      nightBaseline: adaptiveState.nightBaseline,
      aqHighStreak: adaptiveState.aqHighStreak,
      savedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error('Persist state failed', e);
  }
}

// Load persisted config if available
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.altitude_m === 'number') config.altitude_m = parsed.altitude_m;
  }
} catch (e) {
  console.error('Failed to load config.json', e);
}

// Faster online/offline detection
const DEVICE_OFFLINE_THRESHOLD_MS = 25 * 1000; // consider device offline if no data for 25s
function getDeviceStatus() {
  if (!recentData.length) return { lastSeen: null, online: false };
  const last = recentData[recentData.length - 1];
  const lastMs = new Date(last.receivedAt).getTime();
  const online = (Date.now() - lastMs) < DEVICE_OFFLINE_THRESHOLD_MS;
  return { lastSeen: last.receivedAt, online };
}

function computeSeaLevelPressure(p_hpa, altitude_m) {
  // p_hpa: measured absolute pressure in hPa
  // altitude_m: meters above sea level
  if (typeof p_hpa !== 'number') return null;
  if (!isFinite(p_hpa) || p_hpa <= 0) return null;
  const exponent = 5.255;
  const ratio = 1.0 - (altitude_m / 44330.0);
  if (ratio <= 0) return null;
  const sea = p_hpa / Math.pow(ratio, exponent);
  return sea;
}

// Accept POST from ESP32
app.post('/api/data', (req, res) => {
  const payload = req.body;
  payload.receivedAt = new Date().toISOString();
  // Normalize new firmware raw keys to legacy keys the frontend expects
  // (Keep originals too for future compatibility)
  // New firmware may send distinct bmp_temp & dht_temp.
  // Legacy firmware sent single 'temperature' which we map to both if individual keys absent.
  if (payload.temperature !== undefined && (payload.bmp_temp === undefined && payload.dht_temp === undefined)) {
    payload.bmp_temp = payload.temperature;
    payload.dht_temp = payload.temperature;
  }
  if (payload.humidity !== undefined && payload.dht_hum === undefined) payload.dht_hum = payload.humidity;
  if (payload.pressure !== undefined && payload.bmp_pressure === undefined) payload.bmp_pressure = payload.pressure;
  if (payload.mq135_adc !== undefined && payload.mq_raw === undefined) payload.mq_raw = payload.mq135_adc;
  // Also print a human-friendly Kathmandu time for logs
  let kathmanduTime = null;
  try {
    kathmanduTime = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kathmandu' }).format(new Date(payload.receivedAt));
  } catch (e) {
    // fallback: manual offset +5:45
    const dt = new Date(payload.receivedAt);
    const off = (5 * 60 + 45) * 60 * 1000;
    kathmanduTime = new Date(dt.getTime() + off).toISOString();
  }
  console.log(`Received: ${kathmanduTime}  payload:`, payload);

  // --- Day/Night determination ---
  // Device currently sends 'timestamp' as seconds-since-boot (small numbers like 409) NOT a real epoch.
  // We treat such small numeric values as relative and fallback to server receivedAt time for day/night.
  // If a large numeric (epoch seconds/ms) or a valid date string is provided, we use it.
  const tsCandidate = payload.time !== undefined ? payload.time : payload.timestamp;
  let dtUsed = new Date(payload.receivedAt); // default
  if (tsCandidate !== undefined) {
    if (typeof tsCandidate === 'number') {
      let num = tsCandidate;
      // If value looks like seconds (less than ms epoch range) multiply by 1000
      if (num < 1e12) { // could be seconds or boot seconds
        // Distinguish boot seconds (typically < 1e7 ~ 115 days) from epoch seconds (>= 1e9 ~ 2001+)
        if (num >= 1e9) {
          num = num * 1000; // epoch seconds -> ms
        } else {
          // boot-relative small number: ignore, keep receivedAt
          num = -1; // sentinel to skip
        }
      }
      if (num > 0) {
        const candidate = new Date(num);
        if (!isNaN(candidate.getTime()) && candidate.getFullYear() > 2000) dtUsed = candidate;
      }
    } else if (typeof tsCandidate === 'string') {
      const candidate = new Date(tsCandidate);
      if (!isNaN(candidate.getTime()) && candidate.getFullYear() > 2000) dtUsed = candidate;
    }
  }
  let isDaytimeFlag = false;
  try {
    const hourStr = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kathmandu' }).format(dtUsed);
    const hour = parseInt(hourStr, 10);
    isDaytimeFlag = (hour >= 7 && hour < 19);
  } catch (e) {
    // fallback simple offset (+5:45)
    try {
      const off = (5 * 60 + 45) * 60 * 1000;
      const hour = new Date(dtUsed.getTime() + off).getUTCHours();
      isDaytimeFlag = (hour >= 7 && hour < 19);
    } catch (e2) {
      isDaytimeFlag = true; // default to daytime
    }
  }
  payload.daytime_source = (dtUsed === new Date(payload.receivedAt)) ? 'receivedAt' : 'device';

  // --- Robust Baseline Calculation (rolling window + robust stats + EMA + dual day/night)
  const windowStart = Date.now() - BASELINE_WINDOW_MS;
  const windowVals = recentData
    .filter(d => {
      try {
        const t = new Date(d.receivedAt).getTime();
        return t >= windowStart && (d.mq_raw !== undefined || d.adc !== undefined || d.mq !== undefined || d.mq135_adc !== undefined);
      } catch (e) { return false; }
    })
    .map(d => {
      // prefer mq_raw, then adc, then mq
      const v = (typeof d.mq_raw !== 'undefined') ? parseFloat(d.mq_raw) : ((typeof d.mq135_adc !== 'undefined') ? parseFloat(d.mq135_adc) : ((typeof d.adc !== 'undefined') ? parseFloat(d.adc) : parseFloat(d.mq)));
      return isNaN(v) ? null : v;
    })
    .filter(v => v !== null && isFinite(v));
  // Compute robust average only if we have minimum samples
  let instantBaseline = null;
  if (windowVals.length >= BASELINE_MIN_SAMPLES) {
    // Sort copy for median & trimming
    const sorted = [...windowVals].sort((a, b) => a - b);
    // Trim extremes
    const trim = Math.floor(sorted.length * BASELINE_TRIM_FRACTION);
    const core = sorted.slice(trim, sorted.length - trim || sorted.length);
    const coreMean = core.reduce((s, x) => s + x, 0) / core.length;
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    // Blend mean & median to reduce sensitivity (50/50)
    const blended = (coreMean + median) / 2;
    // Apply relative offset (5% of blended) instead of fixed 20
    instantBaseline = blended * 0.95; // subtract 5%
  }

  // Select which adaptive baseline to update (day/night)
  const isDay = !!isDaytimeFlag;
  const fallback = isDay ? BASELINE_FALLBACK_DAY : BASELINE_FALLBACK_NIGHT;
  let adaptive = isDay ? adaptiveState.dayBaseline : adaptiveState.nightBaseline;

  if (instantBaseline !== null && isFinite(instantBaseline)) {
    if (adaptive === null || !isFinite(adaptive)) adaptive = instantBaseline;
    else adaptive = BASELINE_EMA_ALPHA * instantBaseline + (1 - BASELINE_EMA_ALPHA) * adaptive;
  }
  // If still null (insufficient samples), use existing adaptive if present else fallback
  if (adaptive === null || !isFinite(adaptive)) adaptive = fallback;

  // Write back to state
  if (isDay) adaptiveState.dayBaseline = adaptive; else adaptiveState.nightBaseline = adaptive;

  const baseline = adaptive; // final authoritative baseline

  // --- Air Quality Classification (percentage relative to baseline)
  const rawVal = (typeof payload.mq_raw !== 'undefined') ? parseFloat(payload.mq_raw) : ((typeof payload.mq135_adc !== 'undefined') ? parseFloat(payload.mq135_adc) : ((typeof payload.adc !== 'undefined') ? parseFloat(payload.adc) : (typeof payload.mq !== 'undefined' ? parseFloat(payload.mq) : NaN)));
  let quality = 'Unknown';
  let aqPercent = null;
  if (!isNaN(rawVal) && baseline > 5) {
    aqPercent = ((rawVal - baseline) / baseline) * 100.0;
    const absPct = Math.abs(aqPercent);
    // Hysteresis logic using previous quality to avoid flicker
    const prevQuality = payload.prev_mq_health || (recentData.length ? recentData[recentData.length - 1].mq_health : null);
    const prev = prevQuality || 'Unknown';

    const toGood = absPct <= AQ_THRESHOLDS.good.enter;
    const stayGood = absPct <= AQ_THRESHOLDS.good.exit;
    const toModerate = absPct > AQ_THRESHOLDS.good.enter && absPct <= AQ_THRESHOLDS.moderate.enter;
    const stayModerate = absPct > AQ_THRESHOLDS.good.exit && absPct <= AQ_THRESHOLDS.moderate.exit;

    if (prev === 'Good') {
      if (stayGood) quality = 'Good';
      else if (toModerate) quality = 'Moderate';
      else quality = 'Poor';
    } else if (prev === 'Moderate') {
      if (toGood) quality = 'Good';
      else if (stayModerate) quality = 'Moderate';
      else quality = 'Poor';
    } else if (prev === 'Poor' || prev === 'Unhealthy' || prev === 'Unknown') {
      if (toGood) quality = 'Good';
      else if (toModerate) quality = 'Moderate';
      else quality = 'Poor';
    }

    // Escalation to Unhealthy on sustained high deviation beyond moderate.exit
    if (quality === 'Poor' && absPct > AQ_THRESHOLDS.moderate.exit) {
      aqHighStreak += 1;
      if (aqHighStreak >= 5) quality = 'Unhealthy';
    } else if (quality === 'Good' || quality === 'Moderate') {
      aqHighStreak = 0; // reset streak on low/medium
    }
  } else if (!isNaN(rawVal)) {
    quality = 'Unknown';
  }

  // Attach computed baseline/quality/daytime to payload (override device-provided health if any)
  payload.mq_baseline = Math.round(baseline * 100) / 100;
  payload.mq_health = quality; // keep key name expected by frontend
  payload.isDaytime = !!isDaytimeFlag;
  payload.aq_high_streak = aqHighStreak;
  payload.baseline_source = (windowVals.length >= BASELINE_MIN_SAMPLES) ? 'window+ema' : 'adaptive/fallback';
  payload.day_baseline = adaptiveState.dayBaseline;
  payload.night_baseline = adaptiveState.nightBaseline;

  // --- Detailed Comfort classification with nuanced language ---
  const env = (config && typeof config.environment === 'string') ? config.environment.toLowerCase() : 'home';
  // Comfort temperature now strictly derived from BMP sensor for higher stability.
  // (Legacy 'temperature' field no longer used to avoid mixing DHT temp.)
  const t = (typeof payload.bmp_temp !== 'undefined') ? parseFloat(payload.bmp_temp) : NaN;
  const h = (typeof payload.dht_hum !== 'undefined') ? parseFloat(payload.dht_hum) : (typeof payload.humidity !== 'undefined' ? parseFloat(payload.humidity) : NaN);

  // Temperature categories (°C):
  // <15 Cold | 15–<18 Cool | 20–26 Optimal | 26–29 Slightly Warm | 29–32 Warm | >32 Hot
  // Ambiguous 18–<20 not specified by user; we treat 18–<20 as 'Cool' (assumption) to stay conservative.
  function classifyTemp(val) {
    if (isNaN(val)) return 'Unknown';
    if (val < 15) return 'Cold';
    if (val < 18) return 'Cool';
    if (val <= 26 && val >= 20) return 'Optimal';
    if (val > 26 && val <= 29) return 'Slightly Warm';
    if (val > 29 && val <= 32) return 'Warm';
    if (val > 32) return 'Hot';
    // 18–<20 window
    if (val >= 18 && val < 20) return 'Cool';
    return 'Unknown';
  }

  // Humidity categories (%):
  // 40–60 Optimal
  // 30–40 or 60–70 Acceptable
  // <30 Dry / >70 Humid
  // >80 High Humidity Risk (overrides Humid)
  function classifyHum(val) {
    if (isNaN(val)) return 'Unknown';
    if (val > 80) return 'High Humidity Risk';
    if (val >= 40 && val <= 60) return 'Optimal';
    if ((val >= 30 && val < 40) || (val > 60 && val <= 70)) return 'Acceptable';
    if (val < 30) return 'Dry';
    if (val > 70) return 'Humid';
    return 'Unknown';
  }

  // Air quality mapping from quality above:
  // Good -> Good; Moderate -> Moderate; Poor -> Poor; Unhealthy -> Unhealthy; Unknown stays Unknown
  function classifyAir(q) { return q || 'Unknown'; }

  const tempStatus = classifyTemp(t);
  const humStatus = classifyHum(h);
  const airStatus = classifyAir(quality);

  // Overall aggregation:
  // Comfortable: temp Optimal & hum Optimal & air Good
  // Acceptable: exactly one parameter slightly off (temp Slightly Warm or hum Acceptable or air Moderate) and no critical states
  // Needs Attention: multiple outside optimal OR any of (Warm, Humid, Dry, Cool, Cold, Poor)
  // Unhealthy: any critical state (Hot, Cold, High Humidity Risk, Unhealthy air)
  function isCriticalTemp(s) { return s === 'Hot' || s === 'Cold'; }
  function isCriticalHum(s) { return s === 'High Humidity Risk'; }
  function isCriticalAir(s) { return s === 'Unhealthy'; }

  let overall = 'Unknown';
  if (tempStatus === 'Unknown' || humStatus === 'Unknown' || airStatus === 'Unknown') {
    overall = 'Unknown';
  } else if (isCriticalTemp(tempStatus) || isCriticalHum(humStatus) || isCriticalAir(airStatus)) {
    overall = 'Unhealthy';
  } else if (tempStatus === 'Optimal' && humStatus === 'Optimal' && airStatus === 'Good') {
    overall = 'Comfortable';
  } else {
    // Count deviations
    const deviations = [
      tempStatus !== 'Optimal',
      humStatus !== 'Optimal',
      airStatus !== 'Good'
    ].filter(Boolean).length;
    if (deviations === 1) overall = 'Acceptable';
    else overall = 'Needs Attention';
  }

  payload.comfort = {
    temperature: tempStatus,
    humidity: humStatus,
    air_quality: airStatus,
    overall,
    aq_delta_pct: (aqPercent !== null && isFinite(aqPercent)) ? Math.round(aqPercent * 10) / 10 : null
  };
  // Backward compatibility legacy field mapping (simplify to Good / Warning / Unknown)
  let legacyOverall = 'Unknown';
  if (overall === 'Comfortable') legacyOverall = 'Good';
  else if (overall === 'Acceptable') legacyOverall = 'Good';
  else if (overall === 'Needs Attention') legacyOverall = 'Warning';
  else if (overall === 'Unhealthy') legacyOverall = 'Warning';
  payload.comfort_status = legacyOverall;
  payload.environment = env;

  // Compute authoritative sea-level pressure on server using stored altitude
  try {
    const p = parseFloat((typeof payload.bmp_pressure !== 'undefined') ? payload.bmp_pressure : payload.pressure);
    if (!isNaN(p) && isFinite(p) && p > 0) {
      const sl = computeSeaLevelPressure(p, config.altitude_m);
      if (sl && isFinite(sl)) {
        // round to 2 decimal places for storage/display
        payload.bmp_sealevel = Math.round(sl * 100) / 100;
      }
    }
  } catch (e) {
    // ignore and keep whatever was provided
  }

  recentData.push(payload);
  if (recentData.length > MAX_STORE) recentData.shift();

  // Persist adaptive baseline & streak periodically
  persistStateIfNeeded();

  // Broadcast to all connected clients
  io.emit('new-data', payload);
  // Broadcast device status as authoritative source of truth
  io.emit('device-status', getDeviceStatus());
  // Broadcast current config too (help clients stay in sync)
  io.emit('config', config);

  // Include current config in the response so devices can pick up changes
  res.json({ status: 'ok', config });
});

// API to get recent data
app.get('/api/recent', (req, res) => {
  res.json(recentData);
});

// API to get device status (last seen + online boolean)
app.get('/api/status', (req, res) => {
  res.json(getDeviceStatus());
});

// GET/POST config (altitude etc.)
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (typeof body.altitude_m === 'number') config.altitude_m = body.altitude_m;
  if (typeof body.environment === 'string') config.environment = body.environment;
  // broadcast new config to connected clients
  io.emit('config', config);
  // persist to disk
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write config.json', e);
  }
  res.json(config);
});

// Lightweight API to request an immediate config broadcast (useful for the dashboard "Push now")
app.post('/api/push', (req, res) => {
  try {
    io.emit('config', config);
    res.json({ status: 'ok', config });
  } catch (e) {
    res.status(500).json({ status: 'error', error: String(e) });
  }
});

// Socket handlers
io.on('connection', (socket) => {
  console.log('Client connected', socket.id);
  // Send existing data snapshot
  socket.emit('snapshot', recentData);
  // Send current device status on connect
  socket.emit('device-status', getDeviceStatus());
  // Send current config on connect
  socket.emit('config', config);
  socket.on('disconnect', () => {
    console.log('Client disconnected', socket.id);
  });
});

// Periodic status broadcaster so offline state is pushed even without new data
let lastBroadcastOnline = null;
setInterval(() => {
  const status = getDeviceStatus();
  if (lastBroadcastOnline === null || status.online !== lastBroadcastOnline) {
    io.emit('device-status', status);
    lastBroadcastOnline = status.online;
  }
}, 5000); // check every 5s

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
