#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

if [ ! -d "$BACKEND_DIR" ]; then
  echo "[HATA] backend klasoru bulunamadi: $BACKEND_DIR"
  exit 1
fi

cd "$BACKEND_DIR"

PYTHON_CMD=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "[HATA] Python 3 bulunamadi. Lutfen Python 3.10+ kurun."
  exit 1
fi

if [ ! -x ".venv/bin/python" ]; then
  echo "[KURULUM] Sanal ortam olusturuluyor..."
  "$PYTHON_CMD" -m venv .venv
  echo "[KURULUM] Bagimliliklar yukleniyor..."
  ".venv/bin/python" -m pip install -r requirements.txt
else
  if ! ".venv/bin/python" -c "import cryptography" >/dev/null 2>&1; then
    echo "[GUNCELLEME] Yeni Python paketleri yukleniyor..."
    ".venv/bin/python" -m pip install -r requirements.txt
  fi
fi

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp ".env.example" ".env"
  echo "[KURULUM] .env dosyasi .env.example uzerinden olusturuldu."
fi

FAKE_PID=""
MAIN_PID=""

cleanup() {
  echo ""
  echo "[DURDURULUYOR] Sunucular kapatiliyor..."
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true
  [ -n "$MAIN_PID" ] && kill "$MAIN_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[BASLATILIYOR] Mock AI sunucusu (http://127.0.0.1:8001)..."
".venv/bin/python" fake_claude.py &
FAKE_PID=$!

echo "[BASLATILIYOR] Burner Key Proxy & Arayuz (http://127.0.0.1:8000)..."
".venv/bin/python" main.py &
MAIN_PID=$!

sleep 2
if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:8000" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:8000" >/dev/null 2>&1 || true
fi

echo ""
echo "[HAZIR] Burner Key calisiyor: http://127.0.0.1:8000"
echo "Durdurmak icin Ctrl+C tuslarina basin."

wait
