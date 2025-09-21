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

function getDeviceStatus() {
  if (!recentData.length) return { lastSeen: null, online: false };
  const last = recentData[recentData.length - 1];
  const lastMs = new Date(last.receivedAt).getTime();
  const now = Date.now();
  const online = (now - lastMs) < 90000; // 90 seconds
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

  // Compute authoritative sea-level pressure on server using stored altitude
  try {
    const p = parseFloat(payload.bmp_pressure);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
