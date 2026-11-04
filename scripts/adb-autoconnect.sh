#!/bin/bash
# 宿主 ADB 自动上线守护（TV / 投影仪离线后自动重连）
#
# 每 ADB_AUTOCONNECT_INTERVAL 秒（默认 5s）：
#   1) 确认宿主 ADB daemon 以 -a 模式监听 *:5037（容器通过 host.docker.internal:5037 复用，不能破坏）
#   2) 读取 config/default.json 的 devices 列表，只对不在 "device" 状态的设备执行 adb connect
#
# 特性：
#   - 单实例锁：同一时刻只允许一份脚本运行，避免进程堆积
#   - 日志精简：只在状态变化时写一行，1MB 自动清空
#   - 设备列表可配置：改 config/default.json 即可，无需改脚本
#
# 用法：
#   bash scripts/adb-autoconnect.sh           # 常驻（5s 一轮）
#   bash scripts/adb-autoconnect.sh --once    # 只跑一轮，用于排查/验证

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

CONFIG_PATH=${CONFIG_PATH:-$ROOT_DIR/config/default.json}
INTERVAL=${ADB_AUTOCONNECT_INTERVAL:-5}
LOG_FILE=${ADB_AUTOCONNECT_LOG:-/tmp/ws-scrcpy-adb-autoconnect.log}
LOCK_DIR=${ADB_AUTOCONNECT_LOCK:-/tmp/ws-scrcpy-adb-autoconnect.lock}
PID_FILE="$LOCK_DIR/pid"
STATE_DIR="$LOCK_DIR/state"
MAX_LOG_BYTES=${ADB_AUTOCONNECT_MAX_LOG:-1048576}
ADB_BIN=${ADB_BIN:-adb}

ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

log() {
    if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
        : > "$LOG_FILE"
    fi
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
    [ "$ONCE" = "1" ] && echo "$*"
}

# 单实例锁：目录原子创建；残留锁（pid 已不存在）自动清理
acquire_lock() {
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        _old=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$_old" ] && kill -0 "$_old" 2>/dev/null; then
            echo "[adb-autoconnect] 已在运行 pid=${_old}，本次退出（避免并发）" >&2
            exit 0
        fi
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR" 2>/dev/null || exit 0
    fi
    echo $$ > "$PID_FILE"
    mkdir -p "$STATE_DIR"
    trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM HUP
}

# 读配置里的设备：ip:port 一行一个
list_devices() {
    [ -f "$CONFIG_PATH" ] || return 0
    python3 - "$CONFIG_PATH" <<'PY' 2>/dev/null
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for d in cfg.get("devices", []):
    ip = d.get("ip")
    if not ip:
        continue
    print("%s:%s" % (ip, d.get("port", 5555)))
PY
}

# 宿主 ADB 是否监听所有网卡（容器依赖这一点）
server_ready() {
    lsof -nP -iTCP:5037 -sTCP:LISTEN 2>/dev/null | grep -qE '\*:5037|0\.0\.0\.0:5037|\[::\]:5037'
}

ensure_server() {
    server_ready && return 0
    log "宿主 ADB 未以 -a 监听 *:5037，重启 daemon（adb -a start-server）"
    "$ADB_BIN" kill-server >/dev/null 2>&1 || true
    "$ADB_BIN" -a start-server >/dev/null 2>&1 || true
    _i=0
    while [ "$_i" -lt 5 ]; do
        server_ready && return 0
        _i=$((_i + 1))
        sleep 1
    done
    return 1
}

state_of() {
    cat "$STATE_DIR/$1" 2>/dev/null || echo "unknown"
}

set_state() {
    mkdir -p "$STATE_DIR" 2>/dev/null
    printf '%s' "$2" > "$STATE_DIR/$1.tmp" 2>/dev/null && mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1" 2>/dev/null
}

# 先探 TCP 端口再 adb connect：离线设备端口不通时直接跳过，
# 避免 adb connect 长时间超时把 5s 循环拖慢
tcp_open() {
    _host=${1%%:*}
    _port=${1##*:}
    [ "$_port" = "$_host" ] && _port=5555
    if [ "$(uname)" = "Darwin" ]; then
        nc -z -G 1 -w 1 "$_host" "$_port" >/dev/null 2>&1   # macOS: -G 控制 connect 超时
    else
        nc -z -w 1 "$_host" "$_port" >/dev/null 2>&1
    fi
}

# 从 adb connect 输出推断新状态
result_state() {
    case "$1" in
        *"connected to"*) echo "device" ;;
        *"failed"*|*"unable"*|*"error"*|*"cannot"*) echo "failed" ;;
        *) echo "unknown" ;;
    esac
}

cycle() {
    if ! command -v "$ADB_BIN" >/dev/null 2>&1; then
        log "未找到 adb，退出（请 brew install android-platform-tools）"
        return 1
    fi
    ensure_server || { log "宿主 ADB daemon 启动失败，下一轮重试"; return 0; }

    # 一次 adb devices 拿到所有当前状态（避免每台设备各起一次进程）
    _devs=$("$ADB_BIN" devices 2>/dev/null | awk 'NR>1 && NF>=2 {print $1" "$2}')

    for _serial in $(list_devices); do
        _cur=$(printf '%s\n' "$_devs" | awk -v s="$_serial" '$1==s {print $2; exit}')
        _prev=$(state_of "$_serial")

        if [ "$_cur" = "device" ]; then
            if [ "$_prev" != "device" ]; then
                log "上线 $_serial"
            fi
            set_state "$_serial" "device"
            continue
        fi

        # 端口不通（设备关机/断网）：不发起 connect，避免长时间超时拖慢循环
        if ! tcp_open "$_serial"; then
            if [ "$_prev" != "unreachable" ]; then
                log "不可达 ${_serial}（端口未开放），继续探测"
            fi
            set_state "$_serial" "unreachable"
            continue
        fi

        # 端口可达但 ADB 未就绪 / offline / unauthorized：尝试连接
        _out=$("$ADB_BIN" connect "$_serial" 2>&1 | tail -1)
        _new=$(result_state "$_out")
        [ -z "$_new" ] && _new="unknown"

        if [ "$_new" = "device" ]; then
            log "上线 ${_serial}"
        elif [ "$_new" != "$_prev" ]; then
            # 只在失败状态首次出现时记录一次，避免每 5s 刷屏
            log "连接失败 ${_serial}（${_out}），继续重试"
        fi
        set_state "$_serial" "$_new"
    done
    return 0
}

acquire_lock

if [ "$ONCE" = "1" ]; then
    cycle
    exit $?
fi

# 常驻：首轮立即执行，之后按间隔循环；用 sleep 循环避免后台任务堆积
while :; do
    cycle
    sleep "$INTERVAL"
done
