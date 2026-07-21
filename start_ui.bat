@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_CMD="
rem Prefer the Windows Python Launcher. On this PC, `python` can point to a
rem different application's virtual environment and fail to start http.server.
where py >nul 2>nul && set "PYTHON_CMD=py -3"
if not defined PYTHON_CMD (
  where python >nul 2>nul && set "PYTHON_CMD=python"
)
if not defined PYTHON_CMD goto :no_python

echo ==================================================
echo i3DWEB UI server is starting.
echo URL: http://localhost:8080/index.html
echo.
echo Keep this window open while using i3DWEB.
echo Close this window to stop the server.
echo ==================================================
echo.

rem Open the browser after the foreground server has had time to start.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:8080/index.html'"
%PYTHON_CMD% -m http.server 8080 --bind 127.0.0.1

echo.
echo [ERROR] The UI server stopped or failed to start.
echo If port 8080 is already in use, close the other program and retry.
pause
exit /b 1

:no_python
echo [ERROR] Python was not found.
echo Install Python or add python.exe to PATH, then run this file again.
pause
exit /b 1
