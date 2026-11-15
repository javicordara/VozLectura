@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "%~dp0backend\main.py" if exist "%~dp0..\start_windows.bat" (
    call "%~dp0..\start_windows.bat"
    exit /b %ERRORLEVEL%
)

echo ========================================================
echo   VozLectura Portable - Starting Server...
echo ========================================================
echo.

if exist "%~dp0bin" (
    set "PATH=%~dp0bin;%PATH%"
)

set "PY_EXE="
if exist "%~dp0python\python.exe" (
    set "PY_EXE=%~dp0python\python.exe"
) else if exist "%~dp0.venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0.venv\Scripts\python.exe"
) else (
    where python >nul 2>nul
    if not errorlevel 1 set "PY_EXE=python"
)

if "%PY_EXE%"=="" (
    echo [ERROR] Embedded Python runtime not found in .\python\python.exe
    pause
    exit /b 1
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

echo   PC Browser     : http://localhost:%PORT%
echo   Android Wi-Fi  : http://%LAN_IP%:%PORT%
echo.
echo Keep this window open while reading/listening, or close it to stop.
echo (Tip: Use VozLectura_SinConsola.vbs to run silently in background.)
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; try { $r = Invoke-WebRequest -Uri ('http://127.0.0.1:%PORT%/api/ping') -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { Start-Process ('http://localhost:%PORT%'); break } } catch {} }"
"%PY_EXE%" -m uvicorn backend.main:app --host 0.0.0.0 --port %PORT%
pause
