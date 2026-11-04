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
const { exec, spawn } = require('child_process');

// 缩略图解码/缩放（纯服务端处理，失败时降级为不出图，不影响投屏/控制）
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('[THUMB] sharp 不可用，缩略图功能关闭:', e.message);
}

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

// ====== H264 采集（screenrecord 流式）======
// 为什么不用 screencap：本机实测 1080p PNG 截图在电视上要 ~1s/帧（设备端 PNG 编码是瓶颈）。
// screenrecord 走硬件编码器，输出 Annex-B H264，只传帧间差异（天然"增量"），浏览器 WebCodecs 解码。
const ADB_BIN = process.env.ADB_BIN || 'adb';
const H264_SIZE = process.env.H264_SIZE || '1280x720';
const H264_BITRATE = parseInt(process.env.H264_BITRATE || '2000000', 10);
const H264_TIME_LIMIT = 170; // screenrecord 单次上限（秒），到期自动重启
const _parsedSize = (H264_SIZE || '1280x720').split('x').map(Number);
const ENC_W = _parsedSize[0] || 1280; // 编码宽度（点击坐标的源空间）
const ENC_H = _parsedSize[1] || 720;  // 编码高度

// 设备原生分辨率缓存（点击坐标需从编码空间缩放到设备原生空间）
// 例如：流 1280x720，设备 1920x1080 → 坐标需 ×1.5
const deviceResCache = new Map(); // serial -> {w, h, t}
async function getDeviceResolution(serial) {
  const cached = deviceResCache.get(serial);
  const now = Date.now();
  if (cached && now - cached.t < 60000) return { w: cached.w, h: cached.h };
  let w = 0, h = 0;
  try {
    if (adbClient) {
      const s = await adbClient.shell(serial, 'wm size');
      const out = await streamToString(s);
      // input tap/swipe 的坐标基于「当前显示尺寸」：优先 Override size，其次 Physical size
      let m = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (!m) m = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (m) { w = parseInt(m[1], 10); h = parseInt(m[2], 10); }
    }
  } catch (e) { /* ignore, use fallback */ }
  if (!w || !h) { w = ENC_W; h = ENC_H; } // 查不到就不缩放
  deviceResCache.set(serial, { w, h, t: now });
  return { w, h };
}
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let s = '';
    stream.on('data', (c) => { s += c.toString(); });
    stream.on('end', () => resolve(s));
    stream.on('error', reject);
  });
}

class H264Capture {
  constructor(serial) {
    this.serial = serial;
    this.clients = new Set();
    this.proc = null;
    this.stopping = true;
    this.starting = false;
    this.restartTimer = null;
    this.lastFrameAt = 0;
    this.bytes = 0;
    // 缓存最新的 SPS/PPS，新客户端加入时先补发，让解码器立即 configure
    this.sps = null;
    this.pps = null;
    this.lastKeyframeAt = 0;
    this._parseTail = null;   // 跨 chunk 拼接用（解析起始码）
    this._restartPending = false;
    this._lastRestartAt = 0;
  }

  _adbArgs() {
    const args = ['-H', ADB_HOST, '-P', String(ADB_PORT), '-s', this.serial, 'exec-out', 'screenrecord',
      '--output-format=h264', '--bit-rate', String(H264_BITRATE), '--time-limit', String(H264_TIME_LIMIT)];
    if (H264_SIZE) args.push('--size', H264_SIZE);
    args.push('-');
    return args;
  }

  start() {
    if (this.proc || this.clients.size === 0 || this.starting) return;
    this.starting = true;
    this.stopping = false;
    this._lastRestartAt = Date.now();
    // 先清掉设备上可能残留的 screenrecord（否则并发会静默失败）
    const base = ['-H', ADB_HOST, '-P', String(ADB_PORT), '-s', this.serial];
    let preCleaned = false;
    const preClean = () => {
      if (preCleaned) return;
      preCleaned = true;
      this.starting = false;
      this._spawnCapture();
    };
    try {
      const killer = spawn(ADB_BIN, [...base, 'shell', 'pkill -f screenrecord'], { stdio: 'ignore' });
      killer.on('exit', preClean);
      killer.on('error', preClean);
      setTimeout(preClean, 1000);
    } catch (e) {
      preClean();
    }
  }

  _spawnCapture() {
    if (this.proc || this.clients.size === 0 || this.stopping) return;
    const args = this._adbArgs();
    let p;
    try {
      p = spawn(ADB_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log('[H264] spawn failed:', e.message);
      return;
    }
    this.proc = p;
    this.bytes = 0;
    log('[H264] capture start', this.serial, H264_SIZE, `${H264_BITRATE}bps`);

    p.stdout.on('data', (chunk) => {
      this.bytes += chunk.length;
      this.lastFrameAt = Date.now();
      this._feedParse(chunk); // 缓存 SPS/PPS、记录关键帧时间
      // Buffer 直接以二进制下发（前端按 Annex-B 起始码自行拼帧）
      for (const ws of this.clients) {
        if (ws.readyState === 1) {
          try { ws.send(chunk); } catch (e) {}
        } else {
          this.clients.delete(ws); // 顺便清理死掉的客户端
        }
      }
    });

    p.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) log('[H264][stderr]', this.serial, s.slice(0, 300));
    });

    p.on('error', (e) => log('[H264] proc error:', e.message));

    p.on('exit', (code, sig) => {
      this.proc = null;
      this._restartPending = false;
      log('[H264] capture exit', this.serial, 'code=', code, 'sig=', sig, 'bytes=', this.bytes);
      if (!this.stopping && this.clients.size > 0) {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.start(), 400);
      }
    });
  }

  // 解析 chunk 中的 NAL：缓存最新 SPS(type7)/PPS(type8)，遇到 IDR(type5) 记录时间
  _feedParse(chunk) {
    const data = this._parseTail ? Buffer.concat([this._parseTail, chunk]) : chunk;
    this._parseTail = null;
    const starts = [];
    for (let i = 0; i + 2 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        starts.push(i);
        i += 2;
      }
    }
    // 末尾不足一个起始码的部分留到下个 chunk（防止起始码被截断）
    const lastStart = starts.length ? starts[starts.length - 1] : -1;
    const tailLen = data.length - lastStart;
    if (lastStart >= 0 && tailLen < 5) {
      this._parseTail = data.slice(lastStart);
    }
    for (let k = 0; k < starts.length; k++) {
      const p = starts[k];
      const hdr = p + 3;
      if (hdr >= data.length) break;
      const t = data[hdr] & 0x1f;
      const end = (k + 1 < starts.length) ? starts[k + 1] : data.length;
      if (end - hdr <= 0) continue;
      if (t === 7) this.sps = data.slice(hdr, end);
      else if (t === 8) this.pps = data.slice(hdr, end);
      else if (t === 5) this.lastKeyframeAt = Date.now();
    }
  }

  // 清理 readyState 不是 OPEN 的死客户端（WS 已断但没触发 remove 的情况）
  _prune() {
    for (const ws of [...this.clients]) {
      if (ws.readyState !== 1) this.clients.delete(ws);
    }
  }

  // 新客户端加入：补发缓存的 SPS/PPS 让解码器立即 configure；
  // 若采集已在运行，强制重启一次以发出新的 IDR 关键帧（否则客户端只有 P 帧解不出画面）。
  add(ws) {
    this._prune();
    this.clients.add(ws);
    this.stopping = false;

    // 1) 先补发 SPS/PPS（Annex-B），让浏览器 VideoDecoder 立即完成 configure
    if (this.sps && this.pps) {
      const pre = Buffer.concat([
        Buffer.from([0, 0, 0, 1]), this.sps,
        Buffer.from([0, 0, 0, 1]), this.pps
      ]);
      try { ws.send(pre); } catch (e) {}
    }

    if (!this.proc) {
      // 没有运行中的采集 → 全新启动，首帧自带 SPS/PPS/IDR
      this.start();
    } else {
      log('[H264] client joined', this.serial, 'liveClients=', this.clients.size);
      // 2) 已有采集在跑 → 客户端拿到的都是 P 帧，无法解码。重启采集发一个新 IDR。
      //    节流：距上次重启不足 1.5s 就不重启（此时新 IDR 应该刚发过）。
      if (Date.now() - this._lastRestartAt > 1500) {
        this._scheduleRestart();
      }
    }
  }

  _scheduleRestart() {
    if (this._restartPending || this.stopping || !this.proc) return;
    this._restartPending = true;
    setTimeout(() => {
      this._restartPending = false;
      if (!this.proc || this.clients.size === 0 || this.stopping) return;
      log('[H264] force keyframe: restarting capture for new client', this.serial);
      try { this.proc.kill('SIGKILL'); } catch (e) {}
      // 不手动 start：exit handler 会在 400ms 后重启，避免双重 spawn
    }, 60);
  }

  remove(ws) {
    this.clients.delete(ws);
    this._prune();
    if (this.clients.size === 0) {
      this.stopping = true;
      clearTimeout(this.restartTimer);
      this._restartPending = false;
      if (this.proc) {
        log('[H264] no clients, stopping capture', this.serial);
        try { this.proc.kill('SIGKILL'); } catch (e) {}
        this.proc = null;
      }
    }
  }
}

const h264Captures = new Map();
function getH264Capture(serial) {
  if (!h264Captures.has(serial)) {
    h264Captures.set(serial, new H264Capture(serial));
  }
  return h264Captures.get(serial);
}
function detachAllCaptures(ws) {
  for (const cap of h264Captures.values()) cap.remove(ws);
}

// ====== 设备缩略图（定时 screencap → 小图缓存）======
// 目标：设备列表显示每台设备"最后一次看到"的画面，离线也保留最后一帧。
// 约束：单设备 1~3s 级刷新、失败保留旧帧、缓存有上限、绝不阻塞/影响投屏与控制。
const THUMB_REFRESH_MS = parseInt(process.env.THUMB_REFRESH_MS || '2000', 10);
const THUMB_TICK_MS = parseInt(process.env.THUMB_TICK_MS || '1000', 10);
const THUMB_WIDTH = parseInt(process.env.THUMB_WIDTH || '160', 10);
// 缓存条目上限：按设备数量即可（再多也只会是 discovery 出来的设备）
const THUMB_MAX_ENTRIES = Math.max(8, Math.min(64, (config.devices || []).length + 8));

const thumbCache = new Map();      // serial -> { jpeg, at }（Map 保序，用于 LRU 淘汰）
const thumbLastAttempt = new Map(); // serial -> 上次抓取尝试时间（限频用）
const thumbLastError = new Map();   // serial -> 上次错误信息（只在变化时打日志，避免刷屏）
const mjpegActive = new Map();      // serial -> 正在观看 MJPEG 的客户端数（投屏时缩略图让路）
let thumbBusy = false;              // 全局串行：同一时刻只抓一台，避免压垮设备/ADB

function setThumb(serial, jpeg) {
  thumbCache.delete(serial); // 重新插入到末尾，维持 LRU 顺序
  thumbCache.set(serial, { jpeg, at: Date.now() });
  while (thumbCache.size > THUMB_MAX_ENTRIES) {
    const oldest = thumbCache.keys().next().value;
    thumbCache.delete(oldest);
  }
}

async function captureThumb(serial) {
  if (!adbClient || !sharp) return null;
  const stream = await adbClient.screencap(serial);
  const png = await streamToBuffer(stream);
  if (!png || png.length < 100) throw new Error('empty screencap');
  // 等比缩到 160px 宽，JPEG 压缩（体积约 5~15KB）
  return sharp(png)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();
}

// 抓一帧写入缓存；失败保留旧帧。返回是否成功。
async function captureIntoCache(serial) {
  if (!adbClient || !sharp || thumbBusy) return false;
  thumbBusy = true;
  thumbLastAttempt.set(serial, Date.now());
  try {
    const jpeg = await captureThumb(serial);
    if (!jpeg) return false;
    setThumb(serial, jpeg);
    if (thumbLastError.has(serial)) {
      log('[THUMB]', serial, '恢复');
      thumbLastError.delete(serial);
    }
    return true;
  } catch (e) {
    const msg = e.message || String(e);
    if (thumbLastError.get(serial) !== msg) {
      // 只记录状态变化，失败期间不重复打日志
      log('[THUMB]', serial, '抓取失败（保留上一帧）:', msg);
      thumbLastError.set(serial, msg);
    }
    return false;
  } finally {
    thumbBusy = false;
  }
}

// 每 tick 最多抓一台在线且"已到刷新时间"的设备（串行，避免多设备并发抢带宽）
async function thumbTick() {
  if (thumbBusy || !adbClient || !sharp)
    return;
  try {
    const devices = await getAllDevices();
    for (const dev of devices) {
      if (!dev.online) continue; // 离线设备不抓，保留最后画面
      const cap = h264Captures.get(dev.serial);
      if (cap && cap.clients.size > 0) continue; // 正在投屏时让路，避免掉帧
      if ((mjpegActive.get(dev.serial) || 0) > 0) continue; // MJPEG 观看中同样让路
      if (Date.now() - (thumbLastAttempt.get(dev.serial) || 0) < THUMB_REFRESH_MS) continue;
      await captureIntoCache(dev.serial);
      break;
    }
  } catch (e) {
    // 缩略图永远不能影响主流程
  }
}

// 给设备列表附加缩略图状态（供前端判断是否已有画面 / 是否需要换 src）
function decorateDevices(list) {
  return list.map((d) => {
    const t = thumbCache.get(d.serial);
    return {
      ...d,
      hasThumb: !!t,
      thumbAt: t ? t.at : 0,
      thumbStale: !d.online && !!t // 离线：仍显示最后画面，但标记 stale
    };
  });
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
      online: true // 乐观默认：真正连接失败时前端会收到错误
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
  
  // 缓存配置设备（首次响应要快）
  const prevOnline = new Map();
  for (const d of deviceCache.values()) prevOnline.set(d.serial, d.online);

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
          .then(list => { log('[DEVICES] ADB listDevices returned', list.length, 'devices:', list.map(d=>d.id)); return { ok: true, list }; })
          .catch(e => { log('[DEVICES] ADB listDevices ERROR:', e.message); return { ok: false, list: [] }; }),
        new Promise(resolve => setTimeout(() => { log('[DEVICES] ADB listDevices TIMEOUT'); resolve({ ok: false, list: [] }); }, 8000))
      ])
    : Promise.resolve({ ok: false, list: [] });

  try {
    const [scanned, adbResult] = await Promise.all([scanPromise, adbPromise]);
    const adbDevices = adbResult.list || [];
    const adbOk = adbResult.ok;
    log('[DEVICES] scanned:', scanned.length, 'adbDevices:', adbDevices.length, 'adbOk:', adbOk);

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

    // Mark online via ADB：ADB 查询失败时保持上次状态，不要误判为离线（否则前端会禁用点击）
    for (const dev of devices) {
      const match = adbDevices.find(a =>
        a.id === dev.serial || (a.id.startsWith(`${dev.ip}:`) && a.type === 'device')
      );
      if (match) {
        dev.online = true;
      } else if (adbOk) {
        dev.online = false;
      } else {
        dev.online = prevOnline.has(dev.serial) ? prevOnline.get(dev.serial) : true;
      }
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

  // 1. 确保 ADB 已连接设备（最多等 2s，避免阻塞前端进入控制界面）
  const [ip, port] = serial.split(':');
  const connectPromise = adbClient.connect(ip, parseInt(port) || 5555)
    .then(() => log('[SESSION] ADB connected to', serial))
    .catch((e) => log('[SESSION] adb connect failed (may already exist):', e.message));
  await Promise.race([
    connectPromise,
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);

  // 2. 直接注册会话（不再做 screencap 健康检查：1080p 截图在设备上要 ~1s）
  //    可用性由 H264 流是否真的有数据来判定（前端有 8s 看门狗）
  const session = { serial, ws: wsClient };
  scrcpySessions.set(serial, session);
  log('[SESSION] Session ready for', serial, '— video via H264/screenrecord, control via adb shell');

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

function sendAdbText(serial, text) {
  if (!adbClient || !text) return;
  // Escape special chars for adb shell
  const escaped = text.replace(/'/g, `'"'"'`).replace(/"/g, '\\"');
  adbClient.shell(serial, `input text "${escaped}"`);
}

// ====== HTTP Server ======
const app = express();
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json());
app.use(express.static(publicDir));

app.get('/api/devices', async (req, res) => {
  const devices = await getAllDevices(true);  // force refresh to get latest ADB state
  res.json({ devices: decorateDevices(devices) });
});

// 轻量轮询接口：只读内存缓存（不触发 ADB 查询/截图），供前端 2s 级更新列表图标与在线状态
app.get('/api/thumbs', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ devices: decorateDevices(devicesCache) });
});

// 单设备缩略图（最近一帧）；?refresh=1 时立即补抓一次（切换到设备时用）
app.get('/api/thumb', async (req, res) => {
  const serial = String(req.query.serial || '');
  if (!serial) { res.status(400).send('serial required'); return; }
  if (req.query.refresh === '1') {
    await captureIntoCache(serial).catch(() => {});
  }
  const item = thumbCache.get(serial);
  if (!item) { res.status(404).send('no thumbnail'); return; }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=60');
  res.set('X-Thumb-At', String(item.at));
  res.end(item.jpeg);
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
  
  const fps = Math.min(parseInt(req.query.fps) || 3, 5); // 兜底流：screencap 设备端很慢，3fps 足够
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

  // 记录 MJPEG 活跃状态：此时缩略图抓取让路，避免和投屏抢设备
  const releaseMjpeg = () => {
    const n = (mjpegActive.get(serial) || 0) - 1;
    if (n > 0) mjpegActive.set(serial, n); else mjpegActive.delete(serial);
  };
  mjpegActive.set(serial, (mjpegActive.get(serial) || 0) + 1);
  res.on('close', releaseMjpeg);
  
  log('[MJPEG] Stream started for', serial, '@', fps, 'fps');
  let lastFrame = null; // 画面没变就不发，省带宽
  
  while (!cancelled) {
    const frameStart = Date.now();
    try {
      if (!adbClient) break;
      
      const stream = await adbClient.screencap(serial);
      const pngData = await streamToBuffer(stream);
      
      if (Buffer.isBuffer(pngData) && pngData.length > 100 && (!lastFrame || !pngData.equals(lastFrame))) {
        lastFrame = pngData;
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
        ws.send(JSON.stringify({ type: 'device_list', devices: decorateDevices(devices) }));
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
      ws.send(JSON.stringify({ type: 'device_list', devices: decorateDevices(devices) }));
      return;
    }
    
    // Refresh devices (re-scan)
    if (msg.type === 'refresh_devices') {
      const devices = await getAllDevices(true);  // force refresh
      ws.send(JSON.stringify({ type: 'device_list', devices: decorateDevices(devices) }));
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
        detachAllCaptures(ws);
        currentSerial = null;
      }
      ws.send(JSON.stringify({ type: 'disconnected' }));
      return;
    }

    // 开始 H264 视频流（浏览器 WebCodecs 解码）
    if (msg.type === 'video_start') {
      const serial = msg.serial || currentSerial;
      if (!serial) {
        ws.send(JSON.stringify({ type: 'error', message: 'video_start 缺少 serial' }));
        return;
      }
      const cap = getH264Capture(serial);
      cap.add(ws);
      const [w, h] = (msg.size || H264_SIZE || '1280x720').split('x').map(Number);
      ws.send(JSON.stringify({ type: 'video_meta', codec: 'h264', width: w, height: h, bitrate: H264_BITRATE }));
      log('[VIDEO] video_start', serial, 'clients=', cap.clients.size);
      return;
    }

    // 停止视频流
    if (msg.type === 'video_stop') {
      detachAllCaptures(ws);
      return;
    }
    
    // Control events (touch/tap/swipe/key)
    log('[WS] control event received, currentSerial=', currentSerial, 'msg=', JSON.stringify(msg.control || {}).slice(0,100));
    if (msg.type === 'control' && currentSerial) {
      const ctrl = msg.control || {};
      // 坐标缩放：前端坐标基于"显示源分辨率"（H264=编码尺寸如1280x720；MJPEG=设备原生截图如1920x1080），
      // input tap/swipe 需要设备原生像素坐标。前端会上报 srcW/srcH，缺失则按编码尺寸兜底。
      const res = await getDeviceResolution(currentSerial);
      const srcW = ctrl.srcW > 0 ? ctrl.srcW : ENC_W;
      const srcH = ctrl.srcH > 0 ? ctrl.srcH : ENC_H;
      const sx = res.w / srcW;
      const sy = res.h / srcH;

      if (ctrl.action === 'tap') {
        const x = Math.round(ctrl.x * sx), y = Math.round(ctrl.y * sy);
        log('[CONTROL] TAP', ctrl.x, ctrl.y, '→ scaled', x, y, `(${res.w}x${res.h}) →`, currentSerial);
        sendAdbTap(currentSerial, x, y);
      } else if (ctrl.action === 'swipe') {
        const x1 = Math.round(ctrl.x1 * sx), y1 = Math.round(ctrl.y1 * sy);
        const x2 = Math.round(ctrl.x2 * sx), y2 = Math.round(ctrl.y2 * sy);
        log('[CONTROL] SWIPE', ctrl.x1, ctrl.y1, '→', ctrl.x2, ctrl.y2, '→ scaled', x1, y1, '→', x2, y2);
        sendAdbSwipe(currentSerial, x1, y1, x2, y2, ctrl.duration || 300);
      } else if (ctrl.action === 'key') {
        log('[CONTROL] KEY', ctrl.keycode);
        sendAdbKey(currentSerial, ctrl.keycode);
      } else if (ctrl.action === 'text') {
        log('[CONTROL] TEXT', JSON.stringify(ctrl.text));
        sendAdbText(currentSerial, ctrl.text);
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
    detachAllCaptures(ws);
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

// 缩略图刷新循环（单设备 1~3s 级；投屏中自动让路）
setInterval(thumbTick, THUMB_TICK_MS);
log('[THUMB] 已启动（刷新间隔', THUMB_REFRESH_MS, 'ms，宽度', THUMB_WIDTH, 'px）');

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
