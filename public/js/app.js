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
    // If we're using MJPEG fallback, video comes via img src, not WebSocket
    // For scrcpy H264 stream, we'd decode here.
    // Currently: H264 frames arriving via WS. Using simple approach:
    // Relay to MSE or Broadway decoder.
    if (videoDecoder) {
      videoDecoder.pushData(data);
    }
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
      if (online) {
        item.addEventListener('click', () => selectDevice(dev));
      }
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

  // ===== Video Stream (MJPEG fallback) =====
  function startVideoStream(serial) {
    stopVideoStream();
    
    const canvas = $('video-canvas');
    const videoArea = canvas.parentElement;
    
    // Create MJPEG img element
    mjpegImg = document.createElement('img');
    mjpegImg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;background:#000;';
    mjpegImg.src = `/video/mjpeg?serial=${encodeURIComponent(serial)}&t=${Date.now()}`;
    mjpegImg.onerror = () => {
      console.error('MJPEG stream error');
    };
    videoArea.insertBefore(mjpegImg, canvas);
    canvas.style.display = 'none';
  }

  function stopVideoStream() {
    if (mjpegImg) {
      mjpegImg.remove();
      mjpegImg = null;
    }
    const canvas = $('video-canvas');
    if (canvas) canvas.style.display = '';
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
    if (!mjpegImg) return null;
    const rect = mjpegImg.getBoundingClientRect();
    // Get image natural size
    const naturalW = mjpegImg.naturalWidth || rect.width;
    const naturalH = mjpegImg.naturalHeight || rect.height;
    
    // Calculate object-fit: contain mapping
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
    
    return { x: Math.round(imgX), y: Math.round(imgY) };
  }

  videoArea.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!currentSerial) return;
    const t = e.touches[0];
    touchStartTime = Date.now();
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }, { passive: false });

  videoArea.addEventListener('touchmove', (e) => {
    e.preventDefault();
  }, { passive: false });

  videoArea.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!currentSerial) return;
    const t = e.changedTouches[0];
    const duration = Date.now() - touchStartTime;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const distance = Math.sqrt(dx*dx + dy*dy);
    
    const coordsStart = getImageCoords(touchStartX, touchStartY);
    const coordsEnd = getImageCoords(t.clientX, t.clientY);
    
    if (!coordsStart) return;
    
    if (distance > 30 && duration < 1000) {
      // Swipe
      sendMsg('control', {
        control: {
          action: 'swipe',
          x1: coordsStart.x, y1: coordsStart.y,
          x2: coordsEnd ? coordsEnd.x : coordsStart.x,
          y2: coordsEnd ? coordsEnd.y : coordsStart.y,
          duration: Math.max(100, duration)
        }
      });
    } else {
      // Tap
      sendMsg('control', {
        control: { action: 'tap', x: coordsStart.x, y: coordsStart.y }
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
          duration: Math.max(100, duration)
        }
      });
    } else {
      sendMsg('control', {
        control: { action: 'tap', x: coordsStart.x, y: coordsStart.y }
      });
    }
  });

  // ===== Control Buttons =====
  document.querySelectorAll('.ctrl-btn[data-keycode]').forEach(btn => {
    btn.addEventListener('click', () => {
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

  // ===== Placeholder for H264 decoder =====
  // This will be enhanced with Broadway.js or WebCodecs in future
  let videoDecoder = null;
  
})();
