@echo off
chcp 65001 >nul
setlocal

echo Stopping VozLectura background server...
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'backend\.main:app' }; if (-not $procs) { Write-Host 'No running VozLectura server found.' } else { foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('Stopped PID ' + $p.ProcessId) } }"
timeout /t 2 >nul
