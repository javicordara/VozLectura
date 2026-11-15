<#
.SYNOPSIS
Builds a self-contained, zero-DRM Windows Portable distribution of VozLectura.
Bundles Python 3.11 Embeddable Runtime, all pip dependencies (CPU ONNX),
FFmpeg + FFprobe essentials, backend/frontend code, and 1-click launchers.
#>
param(
    [string]$Version = "1.0.0",
    [switch]$SkipDownloads
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$DistRoot = Join-Path $ProjectRoot "dist"
$StagingDir = Join-Path $DistRoot "VozLectura-Windows-Portable"
$ZipPath = Join-Path $DistRoot ("VozLectura-v" + $Version + "-Windows-Portable.zip")
$TempDl = Join-Path $DistRoot "_download_cache"

$PythonEmbedUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

Write-Host "=== VozLectura Portable Builder v$Version ===" -ForegroundColor Cyan
Write-Host "Project root : $ProjectRoot"
Write-Host "Output folder: $StagingDir"

New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null
New-Item -ItemType Directory -Force -Path $TempDl | Out-Null

if (Test-Path $StagingDir) {
    Remove-Item -Recurse -Force $StagingDir
}
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

$PythonDir = Join-Path $StagingDir "python"
$BinDir = Join-Path $StagingDir "bin"
New-Item -ItemType Directory -Force -Path $PythonDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if (-not $SkipDownloads) {
    # 1. Python 3.11 Embeddable Runtime
    $PyZip = Join-Path $TempDl "python-3.11.9-embed-amd64.zip"
    if (-not (Test-Path $PyZip)) {
        Write-Host "[1/5] Downloading Python 3.11.9 Embeddable..."
        Invoke-WebRequest -Uri $PythonEmbedUrl -OutFile $PyZip -UseBasicParsing
    } else {
        Write-Host "[1/5] Using cached $PyZip"
    }
    Expand-Archive -Path $PyZip -DestinationPath $PythonDir -Force

    # Enable site-packages & parent directory imports in python311._pth
    $PthFile = Get-ChildItem -Path $PythonDir -Filter "python*._pth" | Select-Object -First 1
    if (-not $PthFile) { throw "Could not find python*._pth inside $PythonDir" }
    $PthLines = Get-Content -Path $PthFile.FullName -Encoding ASCII
    $UpdatedLines = @()
    foreach ($line in $PthLines) {
        if ($line -match "^#\s*import site") {
            $UpdatedLines += "import site"
        } else {
            $UpdatedLines += $line
        }
    }
    if ($UpdatedLines -notcontains "..") {
        $UpdatedLines = @("..") + $UpdatedLines
    }
    [System.IO.File]::WriteAllLines($PthFile.FullName, $UpdatedLines, [System.Text.Encoding]::ASCII)

    # 2. Install pip & requirements.txt into portable runtime
    $GetPipFile = Join-Path $TempDl "get-pip.py"
    if (-not (Test-Path $GetPipFile)) {
        Write-Host "[2/5] Downloading get-pip.py..."
        Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipFile -UseBasicParsing
    }
    $PyExe = Join-Path $PythonDir "python.exe"
    Write-Host "[3/5] Installing pip and CPU dependencies (this can take 1-2 minutes)..."
    & $PyExe $GetPipFile --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw "get-pip failed" }

    $ReqPath = Join-Path $ProjectRoot "requirements.txt"
    & $PyExe -m pip install --no-cache-dir --no-warn-script-location -r $ReqPath
    if ($LASTEXITCODE -ne 0) { throw "pip install requirements failed" }

    # Smoke import verification inside the portable runtime
    & $PyExe -c "import fastapi, uvicorn, piper, kokoro_onnx; print('PORTABLE_RUNTIME_IMPORTS_OK')"
    if ($LASTEXITCODE -ne 0) { throw "Portable import smoke test failed" }

    # 3. FFmpeg + FFprobe essentials
    $FfZip = Join-Path $TempDl "ffmpeg-release-essentials.zip"
    if (-not (Test-Path $FfZip)) {
        Write-Host "[4/5] Downloading FFmpeg Windows essentials..."
        Invoke-WebRequest -Uri $FfmpegUrl -OutFile $FfZip -UseBasicParsing
    } else {
        Write-Host "[4/5] Using cached $FfZip"
    }
    $FfExtract = Join-Path $TempDl "ffmpeg_extract"
    if (Test-Path $FfExtract) { Remove-Item -Recurse -Force $FfExtract }
    Expand-Archive -Path $FfZip -DestinationPath $FfExtract -Force
    $FfmpegBin = Get-ChildItem -Path $FfExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    $FfprobeBin = Get-ChildItem -Path $FfExtract -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
    if ($FfmpegBin) { Copy-Item $FfmpegBin.FullName -Destination (Join-Path $BinDir "ffmpeg.exe") -Force }
    if ($FfprobeBin) { Copy-Item $FfprobeBin.FullName -Destination (Join-Path $BinDir "ffprobe.exe") -Force }
    Remove-Item -Recurse -Force $FfExtract
} else {
    Write-Host "[SkipDownloads] Creating portable layout skeleton without downloading binaries..." -ForegroundColor Yellow
}

# 4. Copy clean application files & launchers
Write-Host "[5/5] Copying VozLectura app files and packaging ZIP..."
$DestBackend = Join-Path $StagingDir "backend"
$DestFrontend = Join-Path $StagingDir "frontend"
New-Item -ItemType Directory -Force -Path $DestBackend | Out-Null
New-Item -ItemType Directory -Force -Path $DestFrontend | Out-Null

Copy-Item (Join-Path $ProjectRoot "backend\*.py") -Destination $DestBackend -Force
Copy-Item (Join-Path $ProjectRoot "frontend\*") -Destination $DestFrontend -Recurse -Force
Copy-Item (Join-Path $ProjectRoot "requirements.txt") -Destination $StagingDir -Force
Copy-Item (Join-Path $ProjectRoot "LICENSE") -Destination $StagingDir -Force
Copy-Item (Join-Path $ProjectRoot "README.md") -Destination $StagingDir -Force

Copy-Item (Join-Path $ScriptDir "Iniciar_VozLectura.bat") -Destination $StagingDir -Force
Copy-Item (Join-Path $ScriptDir "VozLectura_SinConsola.vbs") -Destination $StagingDir -Force
Copy-Item (Join-Path $ScriptDir "Detener_VozLectura.bat") -Destination $StagingDir -Force

New-Item -ItemType Directory -Force -Path (Join-Path $StagingDir "data\books") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StagingDir "data\models") | Out-Null

if (Test-Path $ZipPath) {
    Remove-Item -Force $ZipPath
}
Compress-Archive -Path "$StagingDir\*" -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "BUILD COMPLETE:" -ForegroundColor Green
Write-Host "  Folder : $StagingDir"
Write-Host "  Archive: $ZipPath"
