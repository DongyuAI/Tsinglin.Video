@echo off
REM ---------------------------------------------------------------
REM  H3 Studio launcher
REM    * backend  - FastAPI BFF (ComfyUI-embedded Python, isolated deps)
REM    * frontend - Astro dev server on http://127.0.0.1:4321
REM  The backend starts / supervises sd-server.exe (resident MiniMax-H3).
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PY=%~dp0..\ComfyUI_windows_portable\python_embeded\python.exe"
if not exist "%PY%" (
  echo [ERROR] ComfyUI embedded Python not found at:
  echo         %PY%
  echo         Set the path manually or run the backend with another Python.
  pause
  exit /b 1
)

echo [1/2] starting backend on http://127.0.0.1:8199 ...
start "H3 Studio backend" cmd /k ""%PY%" "%~dp0backend\run.py""

echo [2/2] starting frontend on http://127.0.0.1:4321 ...
cd /d "%~dp0frontend"
if not exist node_modules (
  echo       installing frontend dependencies ^(first run^) ...
  call npm install --no-audit --no-fund
)
start "H3 Studio frontend" cmd /k "npm run dev"

echo.
echo   open  http://127.0.0.1:4321
echo   press "Start engine" in the UI to load MiniMax-H3 into sd-server.
echo.
endlocal
