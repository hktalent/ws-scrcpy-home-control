/**
 * ws-scrcpy-home-control Server
 * Based on ws-scrcpy project architecture, simplified for home use
 * 
 * Features:
 * 1. Express HTTP server for static frontend
 * 2. WebSocket server for device control and video streaming
 * 3. ADB auto-scan on local network + manual device list fallback
 * 4. scrcpy-server.jar launcher & stream proxy
 * 5. Password authentication
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const adb = require('adbkit');
const net = require('net');
const { exec } = require('child_process');

// ====== Config ======
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config', 'default.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('[CONFIG] Failed to load:', CONFIG_PATH, e.message);
  config = {
    server: { host: '0.0.0.0', port: 8080 },
    auth: { password: 'xxyxx' },
    devices: [],
    scan: { enabled: false }
  };
}

const SCRCPY_JAR = process.env.SCRCPY_JAR || path.join(__dirname, '..', 'scripts', 'scrcpy-server.jar');

// ====== ADB Client ======
// ADB_HOST env: useful in Docker where container ADB daemon can't reach LAN devices.
// Set ADB_HOST=host.docker.internal to delegate to host machine's ADB (which has real routes).
const ADB_HOST = process.env.ADB_HOST || '127.0.0.1';
const ADB_PORT = parseInt(process.env.ADB_PORT || '5037', 10);
let adbClient;
try {
  adbClient = adb.createClient({ host: ADB_HOST, port: ADB_PORT });
  console.log(`[ADB] Client created → ${ADB_HOST}:${ADB_PORT}`);
} catch (e) {
  console.error('[ADB] Failed to create client:', e.message);
}

// ====== Device Cache ======
const deviceCache = new Map(); // serial -> { name, ip, port, online, type, serial }
let devicesCache = [];
let devicesCacheTime = 0;
const CACHE_TTL_MS = 30000; // 30 seconds cache
let backgroundRefreshPromise = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(int) {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255
  ].join('.');
}

function parseCidr(cidr) {
  const [base, prefix] = cidr.split('/');
  const mask = (0xFFFFFFFF << (32 - parseInt(prefix))) >>> 0;
  const baseInt = ipToInt(base);
  const network = baseInt & mask;
  const broadcast = (baseInt | (~mask >>> 0)) >>> 0;
  return { network, broadcast, prefix: parseInt(prefix) };
}

async function portScan(ip, port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
    socket.connect(port, ip);
  });
}

async function scanNetwork() {
  if (!config.scan || !config.scan.enabled) return [];
  
  const { network, broadcast } = parseCidr(config.scan.subnet);
  const timeout = config.scan.timeout || 800;
  const ports = config.scan.ports || [5555];
  const concurrency = 20; // lower concurrency to avoid event loop starvation
  
  log('[SCAN] Starting network scan:', config.scan.subnet, 'ports:', ports);
  
  const results = [];
  const queue = [];
  
  for (let ipInt = network + 1; ipInt < broadcast; ipInt++) {
    const ip = intToIp(ipInt);
    for (const port of ports) {
      queue.push({ ip, port });
    }
  }
  
  // Limit concurrency AND yield event loop between batches
  const batches = [];
  for (let i = 0; i < queue.length; i += concurrency) {
    batches.push(queue.slice(i, i + concurrency));
  }
  
  for (const batch of batches) {
    await Promise.all(batch.map(item => 
      portScan(item.ip, item.port, timeout).then(open => {
        if (open) results.push(item);
      })
    ));
    // Yield to event loop so Express can handle requests
    await new Promise(resolve => setImmediate(resolve));
  }
  
  log('[SCAN] Found open ADB ports:', results);
  return results;
}

async function tryAdbConnect(ip, port = 5555) {
  if (!adbClient) return null;
  const serial = `${ip}:${port}`;
  try {
    await adbClient.connect(ip, port);
    await new Promise(r => setTimeout(r, 500));
    const devices = await adbClient.listDevices();
    const found = devices.find(d => d.id === serial || d.id.startsWith(`${ip}:`));
    if (found && found.type === 'device') {
      log('[ADB] Connected:', serial);
      return serial;
    }
  } catch (e) {
    log('[ADB] Connect failed:', serial, e.message);
  }
  return null;
}

async function getAllDevices(forceRefresh = false) {
  const now = Date.now();
  
  // Return cached result if fresh enough and not forced
  if (!forceRefresh && devicesCache.length > 0 && (now - devicesCacheTime) < CACHE_TTL_MS) {
    return devicesCache;
  }
  
  // If NOT forcing refresh and cache is empty but we've already started background refresh,
  // return a fast result (configured devices only)
  if (!forceRefresh && devicesCache.length === 0 && backgroundRefreshPromise) {
    // Return configured devices immediately without waiting for scan
    const fastDevices = config.devices ? config.devices.map(d => ({
      serial: `${d.ip}:${d.port || 5555}`,
      name: d.name || `Device ${d.ip}`,
      ip: d.ip,
      port: d.port || 5555,
      type: d.type || 'generic',
      online: false
    })) : [];
    devicesCache = fastDevices;
    devicesCacheTime = Date.now();
    return fastDevices;
  }
  
  const devices = [];
  
  // 1. From configured devices (fast, no network needed)
  if (config.devices && config.devices.length) {
    for (const d of config.devices) {
      const serial = `${d.ip}:${d.port || 5555}`;
      devices.push({
        serial,
        name: d.name || `Device ${d.ip}`,
        ip: d.ip,
        port: d.port || 5555,
        type: d.type || 'generic',
        online: false
      });
    }
  }
  
  // Cache configured devices immediately so first response is fast
  devicesCache = devices;
  devicesCacheTime = Date.now();
  deviceCache.clear();
  for (const d of devices) deviceCache.set(d.serial, d);
  
  // 2. Then do the slow network operations (scan + adb check)
  const scanPromise = config.scan && config.scan.enabled ? scanNetwork() : Promise.resolve([]);
  
  // Also check ADB devices (may hang if adb server not responsive)
  const adbPromise = adbClient 
    ? Promise.race([
        adbClient.listDevices()
          .then(list => { log('[DEVICES] ADB listDevices returned', list.length, 'devices:', list.map(d=>d.id)); return list; })
          .catch(e => { log('[DEVICES] ADB listDevices ERROR:', e.message); return []; }),
        new Promise(resolve => setTimeout(() => { log('[DEVICES] ADB listDevices TIMEOUT'); resolve([]); }, 3000))
      ])
    : Promise.resolve([]);
  
  try {
    const [scanned, adbDevices] = await Promise.all([scanPromise, adbPromise]);
    log('[DEVICES] scanned:', scanned.length, 'adbDevices:', adbDevices.length);
    
    // Merge scanned devices
    for (const s of scanned) {
      const serial = `${s.ip}:${s.port}`;
      if (!devices.find(d => d.serial === serial)) {
        devices.push({
          serial, name: `Discovered ${s.ip}`, ip: s.ip, port: s.port,
          type: 'generic', online: false
        });
      }
    }
    
    // Mark online via ADB
    for (const dev of devices) {
      const match = adbDevices.find(a => 
        a.id === dev.serial || (a.id.startsWith(`${dev.ip}:`) && a.type === 'device')
      );
      dev.online = !!match;
    }
    
    // Add extra ADB devices
    for (const a of adbDevices) {
      if (a.type === 'device' && !devices.find(d => d.serial === a.id)) {
        const [ip, port] = a.id.split(':');
        devices.push({
          serial: a.id, name: `ADB ${a.id}`, ip: ip || '',
          port: parseInt(port) || 5555, type: 'generic', online: true
        });
      }
    }
  } catch (e) {
    log('[DEVICES] Background scan error:', e.message);
  }
  
  // Update full cache
  devicesCache = devices;
  devicesCacheTime = Date.now();
  deviceCache.clear();
  for (const d of devices) deviceCache.set(d.serial, d);
  
  return devices;
}

// ====== scrcpy Manager ======
const scrcpySessions = new Map(); // serial -> { proc, videoStream, ws }

// Video source: MJPEG via /video/mjpeg endpoint (adb exec-out screencap -p)
// Frontend uses <img src="/video/mjpeg?serial=..."> — NO scrcpy-server needed
// Control: adb shell input tap/swipe/keyevent (see sendAdbTap etc.)
async function startScrcpySession(serial, wsClient) {
  if (!adbClient) {
    wsClient.send(JSON.stringify({ type: 'error', message: 'ADB client not available' }));
    return null;
  }

  // Reuse existing session
  if (scrcpySessions.has(serial)) {
    const existing = scrcpySessions.get(serial);
    log('[SESSION] Reusing existing session for', serial);
    existing.ws = wsClient;
    return existing;
  }

  log('[SESSION] Starting session for', serial);

  // 1. Make sure ADB is connected to the device
  try {
    const [ip, port] = serial.split(':');
    await adbClient.connect(ip, parseInt(port) || 5555);
    log('[SESSION] ADB connected to', serial);
  } catch (e) {
    // May already be connected — adbClient.listDevices() would fail otherwise
    log('[SESSION] adb connect (may already exist):', e.message);
  }

  // 2. Quick health check: try screencap to confirm device is really usable
  try {
    const stream = await adbClient.screencap(serial);
    await streamToBuffer(stream);
  } catch (e) {
    log('[SESSION] ADB screencap failed for', serial, '- device may be offline:', e.message);
    wsClient.send(JSON.stringify({ type: 'error', message: '设备 ADB 不可用: ' + e.message }));
    return null;
  }

  // 3. Register session
  const session = { serial, ws: wsClient };
  scrcpySessions.set(serial, session);
  log('[SESSION] Session ready for', serial, '— video via MJPEG, control via adb shell');

  return session;
}

function stopScrcpySession(serial) {
  if (!scrcpySessions.has(serial)) return;
  log('[SESSION] Stopping session for', serial);
  scrcpySessions.delete(serial);
}

// ====== Control Event Encoding ======
// scrcpy control protocol (binary):
// 1 byte type: 0x02 = touch, 0x03 = key, 0x04 = text, 0x05 = scroll, 0x08 = mouse/keyboard
//
// Touch event format (19 bytes):
// [1 byte type=0x02][4 bytes action][4 bytes pointerId][4 bytes x][4 bytes y][2 bytes pressure][1 byte buttons]

function buildTouchEvent(action, pointerId, x, y, pressure, buttons) {
  const buf = Buffer.alloc(19);
  buf.writeUInt8(0x02, 0); // type: touch
  buf.writeUInt32BE(action >>> 0, 1);
  buf.writeUInt32BE(pointerId >>> 0, 5);
  buf.writeUInt32BE(Math.round(x * 65535) & 0xFFFF, 9);
  // Wait, need to check scrcpy protocol - it uses 16-bit normalized coords
  // Actually scrcpy uses: x (4 bytes: uint16 * maxW), y (4 bytes: uint16 * maxH)
  // Let me correct:
  buf.writeUInt32BE(Math.round(x) & 0xFFFFFFFF, 9);
  buf.writeUInt32BE(Math.round(y) & 0xFFFFFFFF, 13);
  buf.writeUInt16BE(pressure & 0xFFFF, 17);
  buf.writeUInt8(buttons & 0xFF, 19);
  return buf;
}

// Simpler approach: use adb shell input commands for control
function sendTouchViaAdb(serial, action, x, y) {
  if (!adbClient) return;
  const actionMap = { down: 0, move: 2, up: 1 };
  const a = actionMap[action] ?? action;
  // For simple tap: use adb shell input tap x y
  // For swipe/gesture: use adb shell input swipe
  // For now, use tap and swipe
}

function sendAdbTap(serial, x, y) {
  if (!adbClient) return;
  adbClient.shell(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
}

function sendAdbSwipe(serial, x1, y1, x2, y2, duration = 300) {
  if (!adbClient) return;
  adbClient.shell(serial, `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${duration}`);
}

function sendAdbKey(serial, keycode) {
  if (!adbClient) return;
  adbClient.shell(serial, `input keyevent ${keycode}`);
}

// ====== HTTP Server ======
const app = express();
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json());
app.use(express.static(publicDir));

app.get('/api/devices', async (req, res) => {
  const devices = await getAllDevices(true);  // force refresh to get latest ADB state
  res.json({ devices });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, adb: !!adbClient, sessions: scrcpySessions.size });
});

// Collect stream into Buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// MJPEG video stream endpoint
// adbkit screencap(serial) returns a readable stream → collect to PNG buffer
app.get('/video/mjpeg', async (req, res) => {
  const serial = req.query.serial;
  if (!serial) { res.status(400).send('serial required'); return; }
  
  const fps = Math.min(parseInt(req.query.fps) || 2, 5); // max 5 fps
  const interval = 1000 / fps;
  
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  if (adbClient) {
    try { await adbClient.connect(serial.split(':')[0], parseInt(serial.split(':')[1]) || 5555); } catch (e) {}
  }
  
  let cancelled = false;
  req.on('close', () => { cancelled = true; });
  req.on('end', () => { cancelled = true; });
  
  log('[MJPEG] Stream started for', serial, '@', fps, 'fps');
  
  while (!cancelled) {
    const frameStart = Date.now();
    try {
      if (!adbClient) break;
      
      const stream = await adbClient.screencap(serial);
      const pngData = await streamToBuffer(stream);
      
      if (Buffer.isBuffer(pngData) && pngData.length > 100) {
        res.write('--frame\r\n');
        res.write('Content-Type: image/png\r\n');
        res.write(`Content-Length: ${pngData.length}\r\n\r\n`);
        res.write(pngData);
        res.write('\r\n');
      }
    } catch (e) {
      log('[MJPEG] Frame error:', e.message);
    }
    
    const elapsed = Date.now() - frameStart;
    const waitTime = Math.max(0, interval - elapsed);
    await new Promise(r => setTimeout(r, waitTime));
  }
  
  log('[MJPEG] Stream ended for', serial);
});

// Single screenshot endpoint
app.get('/video/screenshot', async (req, res) => {
  const serial = req.query.serial;
  if (!serial) { res.status(400).send('serial required'); return; }
  if (!adbClient) { res.status(500).send('ADB not available'); return; }
  
  try { await adbClient.connect(serial.split(':')[0], parseInt(serial.split(':')[1]) || 5555); } catch (e) {}
  
  try {
    const stream = await adbClient.screencap(serial);
    const pngData = await streamToBuffer(stream);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pngData.length });
    res.end(pngData);
  } catch (e) {
    log('[SCREENSHOT] Error:', e.message);
    res.status(500).send('Screenshot failed: ' + e.message);
  }
});

const server = http.createServer(app);

// ====== WebSocket Server ======
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  log('[WS] New connection from', req.socket.remoteAddress);
  
  // Auth check (simple token query param approach)
  let authenticated = false;
  let currentSerial = null;
  let clientIp = req.socket.remoteAddress;
  
  ws.on('message', async (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch (e) {
      return;
    }
    
    // Auth
    if (msg.type === 'auth') {
      if (msg.password === config.auth.password) {
        authenticated = true;
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        log('[WS] Authenticated:', clientIp);
        // Send device list: ALL configured/discovered devices (前端自己根据 online 渲染)
        const devices = await getAllDevices();
        ws.send(JSON.stringify({ type: 'device_list', devices }));
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail', message: 'Invalid password' }));
        log('[WS] Auth failed from', clientIp);
        ws.close();
      }
      return;
    }
    
    // Log all incoming messages (debug)
    log('[WS →]', msg.type || '(no type)', 'authenticated=', authenticated, 'currentSerial=', currentSerial);

    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }
    
    // List devices
    if (msg.type === 'list_devices') {
      const devices = await getAllDevices();
      ws.send(JSON.stringify({ type: 'device_list', devices }));
      return;
    }
    
    // Refresh devices (re-scan)
    if (msg.type === 'refresh_devices') {
      const devices = await getAllDevices(true);  // force refresh
      ws.send(JSON.stringify({ type: 'device_list', devices }));
      return;
    }
    
    // Connect to specific device
    if (msg.type === 'connect_device') {
      const serial = msg.serial;
      currentSerial = serial;
      
      // Ensure connection
      if (adbClient) {
        const [ip, port] = serial.split(':');
        try {
          await adbClient.connect(ip, parseInt(port) || 5555);
        } catch (e) {}
      }
      
      // Start scrcpy session
      const session = await startScrcpySession(serial, ws);
      if (session) {
        ws.send(JSON.stringify({ type: 'connected', serial }));
      }
      return;
    }
    
    // Disconnect
    if (msg.type === 'disconnect_device') {
      if (currentSerial) {
        stopScrcpySession(currentSerial);
        currentSerial = null;
      }
      ws.send(JSON.stringify({ type: 'disconnected' }));
      return;
    }
    
    // Control events (touch/tap/swipe/key)
    log('[WS] control event received, currentSerial=', currentSerial, 'msg=', JSON.stringify(msg.control || {}).slice(0,100));
    if (msg.type === 'control' && currentSerial) {
      const ctrl = msg.control || {};
      
      if (ctrl.action === 'tap') {
        log('[CONTROL] TAP', ctrl.x, ctrl.y, '→', currentSerial);
        sendAdbTap(currentSerial, ctrl.x, ctrl.y);
      } else if (ctrl.action === 'swipe') {
        log('[CONTROL] SWIPE', ctrl.x1, ctrl.y1, '→', ctrl.x2, ctrl.y2);
        sendAdbSwipe(currentSerial, ctrl.x1, ctrl.y1, ctrl.x2, ctrl.y2, ctrl.duration || 300);
      } else if (ctrl.action === 'key') {
        log('[CONTROL] KEY', ctrl.keycode);
        sendAdbKey(currentSerial, ctrl.keycode);
      } else if (ctrl.action === 'touch') {
        const act = ctrl.touch_action;
        if (act === 0) {
          log('[CONTROL] TOUCH_DOWN→TAP', ctrl.x, ctrl.y);
          sendAdbTap(currentSerial, ctrl.x, ctrl.y);
        }
      }
      return;
    }
    log('[WS] control event DROPPED (missing serial)', JSON.stringify(msg).slice(0,100));
  });
  
  ws.on('close', () => {
    log('[WS] Connection closed:', clientIp);
    // Cleanup: stop session if it exists
    if (currentSerial) {
      stopScrcpySession(currentSerial);
    }
  });
  
  ws.on('error', (err) => {
    log('[WS] Error:', err.message);
  });
});

// ====== Start ======
const port = config.server.port || 8080;
const host = config.server.host || '0.0.0.0';

server.listen(port, host, () => {
  log('========================================');
  log('  ws-scrcpy-home-control starting...');
  log('  HTTP + WebSocket on', `${host}:${port}`);
  log('  Auth password:', config.auth.password);
  log('  scrcpy-server.jar:', SCRCPY_JAR);
  log('  Network scan:', config.scan?.enabled ? 'ON' : 'OFF');
  log('========================================');
  
  // Start device scan in background - fire and forget
  // Do NOT await it here - it must not block Express from handling requests
  backgroundRefreshPromise = getAllDevices(true).catch(e => {
    log('[INIT] Device scan error:', e.message);
  });
});

// Periodic device refresh
setInterval(async () => {
  try {
    await getAllDevices();
  } catch (e) {}
}, 30000); // every 30s

// ====== ADB auto-reconnect watchdog ======
// 每 60s 检查：如果配置里的设备不在 ADB 列表中，就通过宿主 ADB daemon 发 host:connect
// 注意：不能用 child_process exec('adb connect ...')，因为容器内 adbd reach 不到 LAN
// 所以直接用 ADB daemon 协议向宿主发 host:connect 命令
async function adbAutoReconnect() {
  if (!adbClient || !config.devices?.length) return;

  try {
    const adbList = await Promise.race([
      adbClient.listDevices(),
      new Promise(resolve => setTimeout(() => resolve([]), 3000))
    ]);
    const adbIds = new Set(adbList.map(d => d.id));

    for (const dev of config.devices) {
      const serial = `${dev.ip}:${dev.port || 5555}`;
      if (!adbIds.has(serial)) {
        log(`[AUTO-RECONNECT] 设备 ${serial} 不在 ADB 列表，通过宿主 ADB daemon 发 connect ...`);
        // 用 ADB daemon 协议发 host:connect
        try {
          const result = await adbHostConnect(ADB_HOST, ADB_PORT, dev.ip, dev.port || 5555);
          log(`[AUTO-RECONNECT] host:connect ${serial} → ${result}`);
          getAllDevices(true).catch(() => {});
        } catch (e) {
          log(`[AUTO-RECONNECT] host:connect ${serial} 失败:`, e.message);
        }
      }
    }
  } catch (e) {
    log('[AUTO-RECONNECT] 守护错误:', e.message);
  }
}

// 通过 ADB daemon 协议发送 host:connect 命令
function adbHostConnect(host, port, deviceIp, devicePort) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const s = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let phase = 'version'; // version → connect → done
    let resolved = false;

    s.setTimeout(8000, () => { if (!resolved) { resolved = true; s.destroy(); reject(new Error('timeout')); } });

    // 构造 ADB sync message: 4字节长度 + payload
    const adbMsg = (payload) => {
      const buf = Buffer.alloc(4 + payload.length);
      buf.writeUInt32LE(payload.length, 0);
      buf.write(payload, 4, payload.length);
      return buf;
    };

    s.on('connect', () => {
      // 1. 先握手：host:version
      s.write(adbMsg('host:version'));
      phase = 'version';
    });

    s.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) break;
        const payload = buffer.slice(4, 4 + len).toString();
        buffer = buffer.slice(4 + len);

        if (phase === 'version') {
          // 2. 握手成功，发 host:connect:<ip>:<port>
          s.write(adbMsg(`host:connect:${deviceIp}:${devicePort}`));
          phase = 'connect';
        } else if (phase === 'connect') {
          // 3. 拿到 connect 结果
          if (!resolved) { resolved = true; s.destroy(); resolve(payload.trim()); }
        }
      }
    });

    s.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
    s.on('close', () => { if (!resolved) { resolved = true; reject(new Error('connection closed')); } });
  });
}

setInterval(adbAutoReconnect, 60000); // every 60s
log('[AUTO-RECONNECT] 已启动（每 60s 检查配置设备的 ADB 连接状态）');

process.on('SIGINT', () => {
  log('[SHUTDOWN] Stopping all sessions...');
  for (const serial of scrcpySessions.keys()) {
    stopScrcpySession(serial);
  }
  process.exit(0);
});
