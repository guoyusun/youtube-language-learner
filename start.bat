@echo off
cd /d "%~dp0"
if not exist ".venv" (
    echo Creating Python virtual environment and installing dependencies...
    python -m venv .venv
    .venv\Scripts\pip install -r requirements.txt
)
.venv\Scripts\python server.py
pause
