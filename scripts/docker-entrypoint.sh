#!/bin/bash
# Docker entrypoint for ws-scrcpy-home-control

echo "[ENTRYPOINT] Starting ADB server..."
# -a flag: listen on all interfaces so we can reach LAN devices from container
unset ADB_SERVER_SOCKET
adb -a start-server

sleep 2

echo "[ENTRYPOINT] ADB devices: $(adb devices | grep -v List || echo 'none')"

echo "[ENTRYPOINT] Starting ws-scrcpy-home-control server..."
exec "$@"
