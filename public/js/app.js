/**
 * ws-scrcpy-home-control Frontend
 * Connects to WebSocket backend for password auth, device listing, and control.
 * Video: prefers scrcpy H264 via Broadway/Canvas, falls back to MJPEG screencap.
 */

(function() {
  'use strict';

  // ===== Elements =====
  const $ = (id) => document.getElementById(id);
  const authScreen = $('auth-screen');
  const deviceScreen = $('device-screen');
  const controlScreen = $('control-screen');
  
  // ===== State =====
  let ws = null;
  let authenticated = false;
  let currentSerial = null;
  let mjpegImg = null;
  
  // ===== Navigation =====
  function showScreen(screenId) {
    [authScreen, deviceScreen, controlScreen].forEach(s => s.classList.remove('active'));
    $(screenId).classList.add('active');
  }

  // ===== WebSocket =====
  function getWSUri() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connectWS() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === 1) {
        resolve(ws);
        return;
      }
      
      try {
        ws = new WebSocket(getWSUri());
        ws.binaryType = 'arraybuffer';
        
        ws.onopen = () => {
          console.log('[WS] Connected');
          resolve(ws);
        };
        
        ws.onmessage = handleMessage;
        
        ws.onerror = (e) => {
          console.error('[WS] Error', e);
        };
        
        ws.onclose = () => {
          console.log('[WS] Disconnected');
        };
        
        setTimeout(() => {
          if (ws && ws.readyState !== 1) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 5000);
      } catch (e) {
        reject(e);
      }
    });
  }

  function sendMsg(type, data = {}) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type, ...data }));
  }

  // ===== Message Handler =====
  function handleMessage(event) {
    // Binary = video data
    if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
      handleVideoData(event.data);
      return;
    }
    
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    
    console.log('[WS ←]', msg.type);
    
    switch (msg.type) {
      case 'auth_ok':
        authenticated = true;
        $('auth-message').classList.add('hidden');
        showScreen('device-screen');
        refreshDeviceList();
        break;
        
      case 'auth_fail':
        showAuthError(msg.message);
        break;
        
      case 'device_list':
        renderDeviceList(msg.devices);
        break;
        
      case 'connected':
        onDeviceConnected(msg.serial);
        break;

      case 'video_meta':
        // 保存服务端声明的编码尺寸，作为点击坐标换算的权威源尺寸
        if (msg.width) h264.streamW = msg.width;
        if (msg.height) h264.streamH = msg.height;
        break;
        
      case 'disconnected':
        onDeviceDisconnected();
        break;
        
      case 'error':
        console.error('[Server Error]', msg.message);
        showControlError(msg.message);
        break;
    }
  }

  function handleVideoData(data) {
    if (!h264.active) return;
    h264.lastDataAt = Date.now();
    appendH264(new Uint8Array(data));
  }

  // ===== H264 播放器（浏览器 WebCodecs 硬件解码 + Canvas 渲染）=====
  // 服务端 screenrecord 输出 Annex-B H264（只传帧间差异），这里解析 NAL → 转 AVCC → VideoDecoder
  const h264 = {
    active: false,
    canvas: null,
    ctx: null,
    decoder: null,
    sps: null,
    pps: null,
    configuredKey: '',
    tail: null,
    pending: [],
    frameIndex: 0,
    serial: null,
    watchdog: null,
    lastDataAt: 0,
    frames: 0,
    streamW: 0,   // 服务端 video_meta 声明的编码宽度（坐标源尺寸，权威）
    streamH: 0    // 服务端 video_meta 声明的编码高度
  };

  function appendH264(bytes) {
    const data = h264.tail ? concatBytes(h264.tail, bytes) : bytes;
    const positions = [];
    for (let i = 0; i + 3 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        positions.push({ start: i, len: 3 });
        i += 2;
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
        positions.push({ start: i, len: 4 });
        i += 3;
      }
    }
    if (positions.length === 0) {
      // 还没凑到起始码，先留着（限制长度防止无限增长）
      h264.tail = data.length > 1024 * 1024 ? data.slice(data.length - 4096) : data;
      return;
    }
    for (let k = 0; k < positions.length; k++) {
      const p = positions[k];
      if (k === positions.length - 1) {
        // 最后一个 NAL 可能还没收完整，留到下次
        h264.tail = data.slice(p.start);
        break;
      }
      const nal = data.slice(p.start + p.len, positions[k + 1].start);
      if (nal.length > 0) onNal(nal);
    }
  }

  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function onNal(nal) {
    const type = nal[0] & 0x1f;
    if (type === 7) { h264.sps = nal; h264.pending.push(nal); return; }
    if (type === 8) { h264.pps = nal; h264.pending.push(nal); return; }
    if (type === 1 || type === 5) {
      h264.pending.push(nal);
      emitFrame(type === 5);
      return;
    }
    // 其他（SEI/AUD）跟帧一起发
    h264.pending.push(nal);
  }

  function ensureDecoder() {
    if (!h264.sps || !h264.pps) return false;
    const key = h264.sps.length + ':' + h264.pps.length + ':' + h264.sps[1] + ':' + h264.sps[3];
    if (h264.decoder && h264.decoder.state === 'configured' && h264.configuredKey === key) return true;

    try { if (h264.decoder) h264.decoder.close(); } catch (e) {}
    h264.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const c = h264.canvas;
          if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
            c.width = frame.displayWidth;
            c.height = frame.displayHeight;
          }
          h264.ctx.drawImage(frame, 0, 0, c.width, c.height);
          h264.frames++;
        } catch (e) {
          console.warn('[H264] draw error', e.message);
        } finally {
          frame.close();
        }
      },
      error: (e) => {
        console.warn('[H264] decoder error:', e.message);
        fallbackFromH264();
      }
    });

    const sps = h264.sps, pps = h264.pps;
    // avcC 布局：6 字节头 + 2 字节 SPS 长度 + SPS + 1 字节 PPS 数量 + 2 字节 PPS 长度 + PPS
    const desc = new Uint8Array(6 + 2 + sps.length + 1 + 2 + pps.length);
    let o = 0;
    desc[o++] = 1;
    desc[o++] = sps[1];
    desc[o++] = sps[2];
    desc[o++] = sps[3];
    desc[o++] = 0xff; // lengthSizeMinusOne = 3 (4 bytes)
    desc[o++] = 0xe1; // numOfSPS = 1
    desc[o++] = (sps.length >> 8) & 0xff;
    desc[o++] = sps.length & 0xff;
    desc.set(sps, o); o += sps.length;
    desc[o++] = 1;
    desc[o++] = (pps.length >> 8) & 0xff;
    desc[o++] = pps.length & 0xff;
    desc.set(pps, o);

    const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
    const codec = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;

    try {
      h264.decoder.configure({ codec, description: desc, optimizeForLatency: true });
      h264.configuredKey = key;
      console.log('[H264] decoder configured', codec, `${desc.length} bytes avcC`);
      return true;
    } catch (e) {
      console.warn('[H264] configure failed:', e.message);
      fallbackFromH264();
      return false;
    }
  }

  function emitFrame(isKey) {
    const nals = h264.pending;
    h264.pending = [];
    if (!ensureDecoder() || !h264.decoder) return;
    // 丢弃积压帧，保证低延迟
    if (h264.decoder.decodeQueueSize > 8) { return; }

    let total = 0;
    for (const n of nals) total += 4 + n.length;
    const data = new Uint8Array(total);
    let o = 0;
    for (const n of nals) {
      data[o++] = (n.length >>> 24) & 0xff;
      data[o++] = (n.length >>> 16) & 0xff;
      data[o++] = (n.length >>> 8) & 0xff;
      data[o++] = n.length & 0xff;
      data.set(n, o);
      o += n.length;
    }
    try {
      h264.decoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: h264.frameIndex++ * 1000,
        data
      }));
    } catch (e) {
      console.warn('[H264] decode error:', e.message);
    }
  }

  function fallbackFromH264() {
    const serial = h264.serial;
    stopH264();
    if (serial) startMjpegStream(serial);
  }

  function stopH264() {
    h264.active = false;
    if (h264.watchdog) { clearInterval(h264.watchdog); h264.watchdog = null; }
    try { if (h264.decoder && h264.decoder.state !== 'closed') h264.decoder.close(); } catch (e) {}
    h264.decoder = null;
    h264.tail = null;
    h264.pending = [];
    h264.configuredKey = '';
    h264.sps = null;
    h264.pps = null;
  }

  function startH264Stream(serial) {
    const canvas = $('video-canvas');
    if (!canvas) { startMjpegStream(serial); return; }
    canvas.style.display = '';
    h264.active = true;
    h264.canvas = canvas;
    h264.ctx = canvas.getContext('2d');
    h264.serial = serial;
    h264.sps = null;
    h264.pps = null;
    h264.configuredKey = '';
    h264.tail = null;
    h264.pending = [];
    h264.frames = 0;
    h264.lastDataAt = Date.now();

    sendMsg('video_start', { serial });

    // 看门狗：8 秒没收到任何视频数据 → 回退 MJPEG
    h264.watchdog = setInterval(() => {
      if (!h264.active) return;
      if (h264.frames === 0 && Date.now() - h264.lastDataAt > 8000) {
        console.warn('[H264] 8s 无数据，回退 MJPEG');
        fallbackFromH264();
      }
    }, 2000);
  }

  // ===== Auth =====
  function showAuthError(msg) {
    const el = $('auth-message');
    el.textContent = msg;
    el.className = 'message error';
    el.classList.remove('hidden');
  }

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = $('password-input').value;
    if (!pwd) return;
    
    try {
      await connectWS();
      sendMsg('auth', { password: pwd });
    } catch (err) {
      showAuthError('连接失败: ' + err.message);
    }
  });

  // ===== Device List =====
  function renderDeviceList(devices) {
    const list = $('device-list');
    list.innerHTML = '';
    
    if (!devices || devices.length === 0) {
      list.innerHTML = '<p class="no-devices">没有发现设备<br><small>请确保设备已开启并在同一网络</small></p>';
      return;
    }
    
    devices.forEach(dev => {
      const online = !!dev.online;
      const item = document.createElement('div');
      item.className = 'device-item' + (online ? '' : ' offline');
      item.innerHTML = `
        <div class="icon">${getDeviceIcon(dev.type, dev.name)}</div>
        <div class="info">
          <div class="name">${dev.name || dev.serial}</div>
          <div class="serial">${dev.serial} · ${online ? '可连接' : '离线'}</div>
        </div>
        <div class="status">
          <span class="status-dot ${online ? 'online' : 'offline'}"></span>
          ${online ? '在线' : '离线'}
        </div>
      `;
      // 无论 online 与否都允许点击：在线状态可能因 ADB 查询超时而误判，
      // 真正的可用性由服务端连接结果决定
      item.addEventListener('click', () => selectDevice(dev));
      list.appendChild(item);
    });
  }

  function getDeviceIcon(type, name) {
    const lower = (type || name || '').toLowerCase();
    if (lower.includes('tv') || lower.includes('电视') || lower.includes('tcl')) return '📺';
    if (lower.includes('project') || lower.includes('投影')) return '🎬';
    return '📱';
  }

  async function refreshDeviceList() {
    sendMsg('refresh_devices');
  }

  $('refresh-btn').addEventListener('click', refreshDeviceList);

  // ===== Device Connect =====
  function selectDevice(dev) {
    console.log('[DEVICE] select', dev.serial, 'online=', dev.online);
    currentSerial = dev.serial;
    $('current-device-name').textContent = dev.name || dev.serial;
    showScreen('control-screen');
    showLoading();
    sendMsg('connect_device', { serial: dev.serial });
  }

  function onDeviceConnected(serial) {
    hideLoading();
    // Start MJPEG fallback stream
    startVideoStream(serial);
  }

  function onDeviceDisconnected() {
    stopVideoStream();
  }

  $('back-btn').addEventListener('click', () => {
    if (currentSerial) {
      sendMsg('disconnect_device');
    }
    stopVideoStream();
    showScreen('device-screen');
    refreshDeviceList();
  });

  // ===== Video Stream: 优先 H264(WebCodecs)，不支持则回退 MJPEG =====
  function startVideoStream(serial) {
    stopVideoStream();
    if (typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined') {
      startH264Stream(serial);
    } else {
      console.warn('[VIDEO] 浏览器不支持 WebCodecs，回退 MJPEG');
      startMjpegStream(serial);
    }
  }

  function startMjpegStream(serial) {
    const canvas = $('video-canvas');
    const videoArea = canvas.parentElement;

    if (!mjpegImg) {
      mjpegImg = document.createElement('img');
      mjpegImg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:100%;max-height:100%;width:auto;height:auto;background:#000;';
      videoArea.insertBefore(mjpegImg, canvas);
    }
    mjpegImg.src = `/video/mjpeg?serial=${encodeURIComponent(serial)}&t=${Date.now()}`;
    mjpegImg.onerror = () => console.error('MJPEG stream error');
  }

  function stopVideoStream() {
    // 通知后端停止 H264 采集
    if (ws && ws.readyState === 1) {
      sendMsg('video_stop');
    }
    stopH264();
    if (mjpegImg) {
      mjpegImg.remove();
      mjpegImg = null;
    }
    const canvas = $('video-canvas');
    if (canvas) {
      canvas.style.display = '';
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function showLoading() {
    $('loading-overlay').classList.remove('hidden');
    $('error-overlay').classList.add('hidden');
  }

  function hideLoading() {
    $('loading-overlay').classList.add('hidden');
  }

  function showControlError(msg) {
    hideLoading();
    const overlay = $('error-overlay');
    $('error-message').textContent = msg || '连接失败';
    overlay.classList.remove('hidden');
  }

  $('retry-btn').addEventListener('click', () => {
    if (currentSerial) {
      $('error-overlay').classList.add('hidden');
      showLoading();
      sendMsg('connect_device', { serial: currentSerial });
    }
  });

  // ===== Touch / Click Control =====
  const videoArea = document.querySelector('.video-area');
  let lastTouch = null;
  let touchStartTime = 0;
  let touchStartX = 0, touchStartY = 0;

  function getImageCoords(clientX, clientY) {
    const el = h264.active ? h264.canvas : mjpegImg;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // 源图尺寸（权威）：
    //   H264 → 优先用服务端 video_meta 声明的编码尺寸 streamW/streamH，
    //          其次 canvas 缓冲尺寸，避免首帧前 canvas 默认 300x150 导致坐标错误
    //   MJPEG → img.naturalWidth/Height（设备原生截图尺寸）
    const naturalW = h264.active
      ? (h264.streamW || el.width || rect.width)
      : (el.naturalWidth || rect.width);
    const naturalH = h264.active
      ? (h264.streamH || el.height || rect.height)
      : (el.naturalHeight || rect.height);
    if (!naturalW || !naturalH) return null;

    // object-fit: contain 映射（rect 是 canvas/img 在屏幕上的实际渲染矩形，横竖屏通用）
    const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
    const displayedW = naturalW * scale;
    const displayedH = naturalH * scale;
    const offsetX = (rect.width - displayedW) / 2;
    const offsetY = (rect.height - displayedH) / 2;

    const relX = clientX - rect.left - offsetX;
    const relY = clientY - rect.top - offsetY;

    if (relX < 0 || relY < 0 || relX > displayedW || relY > displayedH) {
      return null;
    }

    const imgX = (relX / displayedW) * naturalW;
    const imgY = (relY / displayedH) * naturalH;

    // 调试日志：定位横屏坐标偏差（可在 DevTools Console 过滤 [COORD]）
    const orient = (screen.orientation && screen.orientation.type) ||
      (window.orientation !== undefined ? window.orientation : '?');
    console.log('[COORD]', h264.active ? 'H264' : 'MJPEG',
      'client=', Math.round(clientX), Math.round(clientY),
      'rect=', Math.round(rect.width), 'x', Math.round(rect.height),
      'src=', naturalW, 'x', naturalH,
      '→ img=', Math.round(imgX), Math.round(imgY),
      'orientation=', orient);

    return { x: Math.round(imgX), y: Math.round(imgY), srcW: naturalW, srcH: naturalH };
  }

  // 点击坐标可视化标记：在点击位置短暂显示算出的坐标，方便定位横屏/偏移问题（定位后可移除）
  function showTapMarker(clientX, clientY, coords) {
    if (!coords) return;
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;left:' + clientX + 'px;top:' + clientY +
      'px;transform:translate(-50%,-50%);z-index:9999;pointer-events:none;' +
      'color:#0f0;font-size:11px;font-family:monospace;text-shadow:0 0 3px #000;' +
      'background:rgba(0,0,0,.55);padding:2px 5px;border-radius:4px;white-space:nowrap';
    const orient = (screen.orientation && screen.orientation.type) ||
      (window.orientation !== undefined ? window.orientation : '?');
    m.textContent = coords.x + ',' + coords.y + ' src' + coords.srcW + 'x' + coords.srcH + ' ' + orient;
    document.body.appendChild(m);
    setTimeout(() => m.remove(), 1200);
  }

  // Track active pointers
  let activePointers = 0;          // # of fingers currently on screen
  let lastMoveX = 0, lastMoveY = 0;
  let lastMoveTime = 0;
  let isPanScrolling = false;      // true = we're in an ongoing scroll gesture

  videoArea.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!currentSerial) return;
    activePointers = e.touches.length;
    const t = e.touches[0];
    touchStartTime = Date.now();
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    lastMoveX = t.clientX;
    lastMoveY = t.clientY;
    lastMoveTime = Date.now();
    isPanScrolling = false;
  }, { passive: false });

  videoArea.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!currentSerial) return;
    if (!e.touches.length) return;

    const now = Date.now();
    const t = e.touches[0];
    const dx = t.clientX - lastMoveX;
    const dy = t.clientY - lastMoveY;
    const dt = now - lastMoveTime;

    // Only send if there's meaningful movement
    if (Math.abs(dx) >= 4 || Math.abs(dy) >= 4) {
      const moved = Math.sqrt(dx*dx + dy*dy);
      activePointers = e.touches.length;
      const coordsFrom = getImageCoords(lastMoveX, lastMoveY);
      const coordsTo = getImageCoords(t.clientX, t.clientY);
      if (coordsFrom && coordsTo) {
        isPanScrolling = true;
        sendMsg('control', {
          control: {
            action: 'swipe',
            x1: coordsFrom.x, y1: coordsFrom.y,
            x2: coordsTo.x,   y2: coordsTo.y,
            srcW: coordsFrom.srcW, srcH: coordsFrom.srcH,
            duration: Math.max(30, dt)
          }
        });
      }
    }
    lastMoveX = t.clientX;
    lastMoveY = t.clientY;
    lastMoveTime = now;
  }, { passive: false });

  videoArea.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!currentSerial) return;

    // If we were in a continuous scroll gesture, don't send tap at the end
    if (isPanScrolling) {
      activePointers = 0;
      isPanScrolling = false;
      return;
    }

    const t = e.changedTouches[0];
    const duration = Date.now() - touchStartTime;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const distance = Math.sqrt(dx*dx + dy*dy);

    const coordsStart = getImageCoords(touchStartX, touchStartY);
    const coordsEnd = getImageCoords(t.clientX, t.clientY);

    if (!coordsStart) return;

    activePointers = 0;

    if (distance > 30 && duration < 1000) {
      sendMsg('control', {
        control: {
          action: 'swipe',
          x1: coordsStart.x, y1: coordsStart.y,
          x2: coordsEnd ? coordsEnd.x : coordsStart.x,
          y2: coordsEnd ? coordsEnd.y : coordsStart.y,
          srcW: coordsStart.srcW, srcH: coordsStart.srcH,
          duration: Math.max(100, duration)
        }
      });
    } else {
      showTapMarker(touchStartX, touchStartY, coordsStart);
      sendMsg('control', {
        control: { action: 'tap', x: coordsStart.x, y: coordsStart.y, srcW: coordsStart.srcW, srcH: coordsStart.srcH }
      });
    }
  }, { passive: false });

  // Mouse support for desktop testing
  let mouseDown = false;
  let mouseDownTime = 0;
  let mouseDownX = 0, mouseDownY = 0;

  videoArea.addEventListener('mousedown', (e) => {
    mouseDown = true;
    mouseDownTime = Date.now();
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
  });

  videoArea.addEventListener('mouseup', (e) => {
    if (!mouseDown || !currentSerial) { mouseDown = false; return; }
    mouseDown = false;
    
    const duration = Date.now() - mouseDownTime;
    const dx = e.clientX - mouseDownX;
    const dy = e.clientY - mouseDownY;
    const distance = Math.sqrt(dx*dx + dy*dy);
    
    const coordsStart = getImageCoords(mouseDownX, mouseDownY);
    const coordsEnd = getImageCoords(e.clientX, e.clientY);
    
    if (!coordsStart) return;
    
    if (distance > 30 && duration < 1000) {
      sendMsg('control', {
        control: {
          action: 'swipe',
          x1: coordsStart.x, y1: coordsStart.y,
          x2: coordsEnd ? coordsEnd.x : coordsStart.x,
          y2: coordsEnd ? coordsEnd.y : coordsStart.y,
          srcW: coordsStart.srcW, srcH: coordsStart.srcH,
          duration: Math.max(100, duration)
        }
      });
    } else {
      showTapMarker(mouseDownX, mouseDownY, coordsStart);
      sendMsg('control', {
        control: { action: 'tap', x: coordsStart.x, y: coordsStart.y, srcW: coordsStart.srcW, srcH: coordsStart.srcH }
      });
    }
  });

  // ===== Mouse wheel → swipe up/down =====
  let wheelCooldown = 0;
  videoArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!currentSerial) return;
    const now = Date.now();
    if (now - wheelCooldown < 120) return; // debounce 120ms
    wheelCooldown = now;

    // swipe distance proportional to deltaY, clamp
    const dy = Math.max(100, Math.min(800, Math.abs(e.deltaY) * 4));
    const up = e.deltaY < 0;
    const coords = getImageCoords(e.clientX, e.clientY) || { x: 540, y: 900 };
    const y1 = coords.y;
    const y2 = up ? y1 + dy : Math.max(0, y1 - dy); // scroll up = content goes down = swipe up
    sendMsg('control', {
      control: {
        action: 'swipe',
        x1: coords.x, y1,
        x2: coords.x, y2,
        srcW: coords.srcW, srcH: coords.srcH,
        duration: 150
      }
    });
  }, { passive: false });

  // ===== Global keyboard → send Android keyevents =====
  document.addEventListener('keydown', (e) => {
    // Ignore if typing in input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (!currentSerial) return;

    const keyMap = {
      'ArrowUp': 19,
      'ArrowDown': 20,
      'ArrowLeft': 21,
      'ArrowRight': 22,
      'Enter': 66,
      'Escape': 4,
      'Backspace': 67,
      ' ': 62,        // space → play/pause
      'MediaPlay': 126,
      'MediaPause': 127,
      'MediaPlayPause': 85,
      'Home': 3,
      'BrowserBack': 4,
    };

    // Single-character keys → send as text input (useful for Android TV search)
    // But only when a modifier is NOT held, to avoid hijacking Ctrl+R etc.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // We support sending printable chars via adb shell input text
      sendMsg('control', { control: { action: 'text', text: e.key } });
      e.preventDefault();
      return;
    }

    const keycode = keyMap[e.key];
    if (keycode !== undefined) {
      sendMsg('control', { control: { action: 'key', keycode } });
      e.preventDefault();
    }
  });

  // ===== Control Buttons (含 D-pad 方向键) =====
  document.querySelectorAll('[data-keycode]').forEach(btn => {
    // 移动端用 touchstart 立即响应（无 300ms 延迟），同时阻止后续 click 重复发送
    let touched = false;
    btn.addEventListener('touchstart', (e) => {
      if (!currentSerial) return;
      touched = true;
      const keycode = btn.dataset.keycode;
      sendMsg('control', { control: { action: 'key', keycode } });
      e.preventDefault();
    }, { passive: false });
    btn.addEventListener('click', () => {
      if (touched) { touched = false; return; } // 已由 touchstart 处理
      if (!currentSerial) return;
      const keycode = btn.dataset.keycode;
      sendMsg('control', { control: { action: 'key', keycode } });
    });
  });

  $('screenshot-btn').addEventListener('click', () => {
    if (!currentSerial) return;
    // Fetch and download screenshot
    fetch(`/video/screenshot?serial=${encodeURIComponent(currentSerial)}`)
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `screenshot_${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(err => console.error('Screenshot failed', err));
  });

})();
