#!/usr/bin/env bash
set -e

export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

if [ ! -d "$BACKEND_DIR" ]; then
  echo "[HATA] backend klasoru bulunamadi: $BACKEND_DIR"
  exit 1
fi

cd "$BACKEND_DIR"

PYTHON_CMD=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >/dev/null 2>&1; then
      PYTHON_CMD="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON_CMD" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >/dev/null 2>&1; then
        PYTHON_CMD="$candidate"
        break
      fi
    fi
  done
fi

if [ -z "$PYTHON_CMD" ]; then
  echo "[HATA] Python 3.9+ bulunamadi. Lutfen Python 3.10+ kurun (ornek: brew install python)."
  exit 1
fi

if [ ! -x ".venv/bin/python" ] || ! ".venv/bin/python" --version >/dev/null 2>&1; then
  rm -rf ".venv"
  echo "[KURULUM] Sanal ortam olusturuluyor ($PYTHON_CMD)..."
  "$PYTHON_CMD" -m venv .venv
  echo "[KURULUM] Bagimliliklar yukleniyor..."
  ".venv/bin/python" -m pip install -r requirements.txt
else
  if ! ".venv/bin/python" -c "import fastapi, uvicorn, httpx, dotenv, pydantic, cryptography" >/dev/null 2>&1; then
    echo "[GUNCELLEME] Yeni Python paketleri yukleniyor..."
    ".venv/bin/python" -m pip install -r requirements.txt
  fi
fi

if ".venv/bin/python" -c "import sys; raise SystemExit(0 if sys.version_info < (3, 10) else 1)" >/dev/null 2>&1; then
  if ! ".venv/bin/python" -c "import eval_type_backport" >/dev/null 2>&1; then
    echo "[KURULUM] Python 3.9 uyumluluk paketi (eval_type_backport) yukleniyor..."
    ".venv/bin/python" -m pip install eval_type_backport
  fi
fi

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp ".env.example" ".env"
  echo "[KURULUM] .env dosyasi .env.example uzerinden olusturuldu."
fi

FAKE_PID=""
MAIN_PID=""
STOPPING=0

cleanup() {
  if [ "$STOPPING" -eq 1 ]; then
    return
  fi
  STOPPING=1
  echo ""
  echo "[DURDURULUYOR] Sunucular kapatiliyor..."
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true
  [ -n "$MAIN_PID" ] && kill "$MAIN_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}

on_signal() {
  cleanup
  exit 0
}

trap on_signal INT TERM HUP
trap cleanup EXIT

check_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 1 "http://127.0.0.1:8000/health" >/dev/null 2>&1
  else
    ".venv/bin/python" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=1)" >/dev/null 2>&1
  fi
}

echo "[BASLATILIYOR] Mock AI sunucusu (http://127.0.0.1:8001)..."
".venv/bin/python" fake_claude.py &
FAKE_PID=$!

echo "[BASLATILIYOR] Burner Key Proxy & Arayuz (http://127.0.0.1:8000)..."
".venv/bin/python" main.py &
MAIN_PID=$!

ATTEMPTS=0
READY=0
while [ "$ATTEMPTS" -lt 40 ]; do
  if ! kill -0 "$MAIN_PID" 2>/dev/null; then
    echo "[HATA] Burner Key Proxy (:8000) beklenmedik sekilde kapandi."
    exit 1
  fi
  if ! kill -0 "$FAKE_PID" 2>/dev/null; then
    echo "[HATA] Mock AI sunucusu (:8001) beklenmedik sekilde kapandi."
    exit 1
  fi
  if check_health; then
    READY=1
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 0.5
done

if [ "$READY" -ne 1 ]; then
  echo "[HATA] Sunucu 20 saniye icinde hazir olmadi (http://127.0.0.1:8000/health)."
  exit 1
fi

if [ "${BURNER_KEY_NO_BROWSER:-0}" != "1" ]; then
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:8000" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:8000" >/dev/null 2>&1 || true
  fi
fi

echo ""
echo "[HAZIR] Burner Key calisiyor: http://127.0.0.1:8000"
echo "Durdurmak icin Ctrl+C tuslarina basin."

wait
