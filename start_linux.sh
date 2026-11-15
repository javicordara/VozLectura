#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  VozLectura - Local Neural EPUB Reader & Audiobooks"
echo "========================================================"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 is required (3.10+)."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[NOTE] ffmpeg not found. Install ffmpeg + espeak-ng for M4B export & Kokoro TTS."
fi

if [ ! -d ".venv" ]; then
  echo "Creating virtual environment (.venv)..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
echo ""
echo "Server starting on:"
echo "  - This PC : http://localhost:8085"
echo "  - Wi-Fi   : http://${LAN_IP}:8085"
echo ""

exec .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8085
