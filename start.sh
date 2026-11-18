#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Auto-detect best available python3 binary
if command -v python3.12 >/dev/null 2>&1; then
  PY_BIN="python3.12"
elif [ -x "/opt/homebrew/bin/python3.12" ]; then
  PY_BIN="/opt/homebrew/bin/python3.12"
else
  PY_BIN="python3"
fi

if [ ! -d ".venv" ]; then
  echo "正在创建 Python 虚拟环境并安装依赖..."
  "$PY_BIN" -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

exec .venv/bin/python server.py
