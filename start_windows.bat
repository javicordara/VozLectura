@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ========================================================
echo   VozLectura - Local Neural EPUB Reader ^& Audiobooks
echo ========================================================
echo.

set "PY_CMD="
set "PY_ARG="
py -3.11 -c "import sys" >nul 2>nul && (set "PY_CMD=py" & set "PY_ARG=-3.11")
if not defined PY_CMD py -3.12 -c "import sys" >nul 2>nul && (set "PY_CMD=py" & set "PY_ARG=-3.12")
if not defined PY_CMD py -3.13 -c "import sys" >nul 2>nul && (set "PY_CMD=py" & set "PY_ARG=-3.13")
if not defined PY_CMD (
    where python >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Python 3.11 - 3.13 was not found in PATH.
        echo Please install Python 3.13 from https://www.python.org/downloads/
        pause
        exit /b 1
    )
    set "PY_CMD=python"
)

set "VENV_DIR=%~dp0.venv"
if not exist "%VENV_DIR%\Scripts\python.exe" (
    if /i not "%~d0"=="C:" (
        set "VENV_DIR=%LOCALAPPDATA%\VozLectura\.venv"
    )
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo Creating isolated virtual environment in "%VENV_DIR%" ...
    if /i not "%~d0"=="C:" if not exist "%LOCALAPPDATA%\VozLectura" mkdir "%LOCALAPPDATA%\VozLectura"
    "%PY_CMD%" %PY_ARG% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

"%VENV_DIR%\Scripts\python.exe" -c "import fastapi, uvicorn, piper, kokoro_onnx" >nul 2>nul
if errorlevel 1 (
    echo Installing Python dependencies ^(CPU ONNX^) into "%VENV_DIR%" ...
    "%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip
    "%VENV_DIR%\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
)

if exist "%~dp0bin" (
    set "PATH=%~dp0bin;%PATH%"
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo [NOTE] ffmpeg was not detected in PATH. M4B export and audiobook sync need ffmpeg.
    echo        Install via: winget install Gyan.FFmpeg
    echo.
)

set "PORT=%VOZLECTURA_PORT%"
if "%PORT%"=="" (
    for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "$free = 8086; foreach ($p in 8085..8095) { $busy = $false; foreach ($h in @('127.0.0.1','::1')) { $c = New-Object System.Net.Sockets.TcpClient; try { $c.Connect($h, $p); $c.Close(); $busy = $true; break } catch { try { $c.Close() } catch {} } }; if (-not $busy) { $free = $p; break } }; Write-Output $free"`) do set "PORT=%%p"
)

if not "%PORT%"=="8085" (
    echo [INFO] Port 8085 is already in use by another app. Starting VozLectura isolated on http://localhost:%PORT%
    echo.
)

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $ip=(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet' -and $_.IPAddress -notmatch '^169\.254' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1 -ExpandProperty IPAddress); if ($ip) { $ip } else { '127.0.0.1' } } catch { '127.0.0.1' }"`) do set "LAN_IP=%%i"

echo Server starting on:
echo   - This PC : http://localhost:%PORT%
echo   - Android : http://%LAN_IP%:%PORT% (same Wi-Fi network)
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; try { $r = Invoke-WebRequest -Uri ('http://127.0.0.1:%PORT%/api/ping') -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { Start-Process ('http://localhost:%PORT%'); break } } catch {} }"
"%VENV_DIR%\Scripts\python.exe" -m uvicorn backend.main:app --host 0.0.0.0 --port %PORT%
pause
