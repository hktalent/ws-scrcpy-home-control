# ws-scrcpy-home-control

通过浏览器远程控制家里的 Android TV / 投影仪。

服务端暴露 HTTPS（Cloudflare Tunnel），手机/电脑打开网页 → 输入密码 → 选设备 → 实时画面 + 触摸控制 + 键盘按键。

## 功能

- **实时画面**：`adb screencap` → MJPEG 流（10fps）
- **触摸控制**：单指 tap / 滑动 / 双指滚屏（touchmove 连续 swipe）
- **键盘控制**：方向键、Enter/Esc/HOME、播放/暂停、文本输入
- **鼠标控制**：点击 / 滑动 / 滚轮滚屏
- **设备发现**：配置文件 + ADB listDevices 自动匹配 online 状态
- **零 App 安装**：设备只需要开启开发者选项 → USB 调试 + TCP/IP 调试

## 架构

```
┌──────────────────┐      ┌──────────────────────┐       ┌────────────────────────┐
│  TV / Projector  │◄────►│  Host ADB Daemon      │◄────►│  Container (Node.js)    │
│  Android 9+      │:5555 │  adb -a start-server │:5037 │  ADB_HOST=host.docker  │
└──────────────────┘      └──────────────────────┘       └───────────┬────────────┘
                                                                     │ HTTP+WS
                                                                     ▼
                                                         ┌───────────────────────┐
                                                         │  Cloudflare Tunnel     │
                                                         │  tv.51pwn.com → :8080 │
                                                         └───────────┬───────────┘
                                                                     │
                                                         📱 Browser (任何设备)
```

**关键点**：Docker Desktop 容器扫不到宿主 LAN 192.168.0.0/24 网段的设备，所以容器内的 Node.js **不自己起 ADB daemon**，而是通过 `host.docker.internal:5037` 复用宿主的 ADB daemon（宿主已 `adb -a start-server` 监听所有接口）。

## 快速开始

### 前置条件

| 依赖 | 说明 |
|---|---|
| Docker Desktop（macOS / Linux） | 运行容器 |
| 宿主 ADB + platform-tools | `brew install android-platform-tools` |
| Cloudflare Tunnel | 可选，公网访问用 |
| Android 9+ 设备 | 开启 USB 调试 + TCP/IP 调试 |

### 1. 宿主 ADB daemon

必须先让宿主的 ADB daemon 监听所有接口，并连上设备：

```bash
adb kill-server
adb -a start-server                    # -a 才会监听 0.0.0.0:5037
adb connect 192.168.0.131:5555         # 你的电视/投影仪 IP
adb devices                            # 应看到 "device" 状态
```

#### 设备持久化调试模式

让电视/投影仪断电重启后仍保持 ADB 无线调试：

```bash
adb -s 192.168.0.131:5555 shell setprop persist.service.adb.tcp.port 5555
adb -s 192.168.0.131:5555 shell setprop persist.service.adb.enable 1
adb -s 192.168.0.131:5555 shell setprop persist.sys.usb.config adb
adb -s 192.168.0.131:5555 shell settings put global adb_enabled 1
adb -s 192.168.0.131:5555 shell settings put global adb_wifi_enabled 1
```

### 2. 配置设备

编辑 `config/default.json`：

```json
{
  "auth": { "password": "xxyxx" },
  "devices": [
    { "name": "TCL电视",   "ip": "192.168.0.131", "port": 5555, "type": "tv" },
    { "name": "投影仪",    "ip": "192.168.0.120", "port": 5555, "type": "projector" }
  ]
}
```

### 3. 启动

```bash
cd ws-scrcpy-home-control
docker compose build --no-cache ws-scrcpy-home
docker compose up -d
docker ps                              # 应看到 healthy
```

### 4. 访问

- **本地**：`http://localhost:8080` → 输入密码
- **公网（Cloudflare Tunnel）**：配置见下方

## Cloudflare Tunnel

复用现有 tunnel（推荐，省资源）：

```yaml
# 在 cloudflared 容器的 config.yml ingress 里追加：
- hostname: tv.51pwn.com
  service: http://ws-scrcpy-home:8080
```

DNS route（一次性）：

```bash
cloudflared tunnel route dns <tunnel-name> tv.51pwn.com
```

如果需要本项目**独立**跑一个 tunnel connector：

```bash
cp cloudflare/config.yml.example cloudflare/config.yml
# 放 credentials.json 到 cloudflare/
docker compose up -d cloudflared
```

## API

### HTTP

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/devices` | 所有配置设备 + ADB online 状态 |
| `GET /video/mjpeg?serial=...&fps=10` | MJPEG 实时视频流（multipart/x-mixed-replace） |
| `GET /video/screenshot?serial=...` | 单帧 PNG 截图 |

### WebSocket

路径：`/ws`

**认证**：

```json
{ "type": "auth", "password": "xxyxx" }
// → { "type": "auth_ok" }
```

**设备列表**：

```json
{ "type": "list_devices" }
// → { "type": "device_list", "devices": [...] }
```

**连接设备**：

```json
{ "type": "connect_device", "serial": "192.168.0.131:5555" }
// → { "type": "connected", "serial": "192.168.0.131:5555" }
```

**控制事件**：

```json
// 点击
{ "type": "control", "control": { "action": "tap",    "x": 540,  "y": 960  } }

// 滑动 / 滚屏（touchmove 连续发送短段）
{ "type": "control", "control": { "action": "swipe",   "x1": 540, "y1": 1400, "x2": 540, "y2": 400, "duration": 150 } }

// 键盘按键
{ "type": "control", "control": { "action": "key",    "keycode": 3 } }

// 文本输入（Android TV 搜索框）
{ "type": "control", "control": { "action": "text",   "text": "ok" } }
```

### Android keycode 速查

| keycode | 按键 |
|---|---|
| 3 | HOME |
| 4 | BACK |
| 19 / 20 / 21 / 22 | ↑ ↓ ← → |
| 66 | Enter |
| 67 | Backspace |
| 62 | Space |
| 85 | MediaPlayPause |
| 126 | MediaPlay |
| 127 | MediaPause |

## 目录结构

```
ws-scrcpy-home-control/
├── Dockerfile                 # Node 20 + ADB + OpenJDK
├── docker-compose.yml         # container 服务定义
├── config/
│   └── default.json           # 设备列表 + 密码（volume mount）
├── server/
│   └── index.js               # Express + WebSocket + adbkit
├── public/
│   ├── index.html             # 前端
│   ├── css/style.css
│   └── js/app.js              # 触摸/鼠标/键盘 → WS control
├── scripts/
│   ├── docker-entrypoint.sh   # 宿主 ADB daemon 启动
│   └── scrcpy-server.jar      # 备用（当前 MJPEG 方案未使用）
├── cloudflare/
│   └── config.yml             # Cloudflare Tunnel ingress
└── package.json               # express, ws, adbkit
```

## 常见问题

### Q：容器里 `adb devices` 空的？

容器 Docker Desktop bridge 扫不到 LAN。**别让容器自己起 ADB daemon**。让宿主起：

```bash
adb kill-server && adb -a start-server
```

compose 里已设 `ADB_HOST=host.docker.internal`，Node.js server 会复用宿主 daemon。

### Q：设备 online=False？

1. 宿主 `adb devices` 看到 `device` 了吗？
2. 配置里 IP 正确吗？
3. 电视 `5555` 端口开了吗？`nc -z 192.168.0.131 5555`

### Q：画面不动 / 点击没反应？

看容器日志：`docker logs ws-scrcpy-home -f`

- `[CONTROL]` 日志有 → adb shell 命令在发
- `[MJPEG] Stream started` → 视频流正常
- 没 `[CONTROL]` → 前端 WS 消息没到，检查浏览器控制台

### Q：iPhone 双指滚屏失效？

已在 `public/js/app.js` 改造 touchmove handler：每帧移动 4px 以上就发小段 swipe，而不是只在 touchend 时发一次。确保用了最新版本（`docker compose build --no-cache`）。

### Q：换 IP / 改密码后不生效？

配置文件是 volume mount，但 Node.js 启动时读一次内存。**改完必须重启容器**：

```bash
docker compose restart ws-scrcpy-home
```

## 技术栈

| 组件 | 技术 |
|---|---|
| 服务端 | Node.js 20, Express 4, ws (WebSocket) |
| ADB | adbkit 2.11.1（宿主 daemon 代理：`ADB_HOST=host.docker.internal`） |
| 视频 | MJPEG（`multipart/x-mixed-replace`），adbkit `screencap()` → Stream → PNG Buffer |
| 控制 | `adb shell input tap/swipe/keyevent/text` |
| 前端 | 原生 JS, MJPEG `<img>` 自动刷新, touch/mouse/keyboard 事件 → WS control messages |
| 公网访问 | Cloudflare Tunnel |
| 容器 | Docker Compose, `node:20-bookworm-slim`, platform-tools, OpenJDK 17 |

## License

MIT
