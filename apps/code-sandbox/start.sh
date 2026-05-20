#!/usr/bin/env sh
# start.sh — starts both the Python sandbox service and the Bun MCP server
# Used as the container CMD in Dockerfile

set -e

echo "[start.sh] Starting Python sandbox service..."
python3 /app/sandbox_service.py &
PYTHON_PID=$!

echo "[start.sh] Starting Bun MCP server..."
bun run /app/src/index.ts &
BUN_PID=$!

# Propagate SIGTERM/SIGINT to children
trap 'echo "[start.sh] Signal received, shutting down..."; kill $PYTHON_PID $BUN_PID 2>/dev/null; exit 0' TERM INT

# Wait for both — exits when EITHER process dies
wait $PYTHON_PID &
WAIT_PYTHON=$!
wait $BUN_PID &
WAIT_BUN=$!

# Poll until one exits
while kill -0 $PYTHON_PID 2>/dev/null && kill -0 $BUN_PID 2>/dev/null; do
    sleep 2
done

echo "[start.sh] A process exited. Shutting down..."
kill $PYTHON_PID $BUN_PID 2>/dev/null || true
wait $PYTHON_PID $BUN_PID 2>/dev/null || true
