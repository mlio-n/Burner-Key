#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"

cd "$SCRIPT_DIR"

if ! bash "$SCRIPT_DIR/start.sh"; then
  echo ""
  echo "[HATA] Burner Key baslatilamadi."
  if [ -t 0 ]; then
    read -r -p "Pencereyi kapatmak icin Enter tusuna basin..." _
  fi
  exit 1
fi
