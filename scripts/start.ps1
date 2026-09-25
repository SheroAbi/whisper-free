# =============================================================================
# Whisper Free - one-command launcher.
#
#   npm start            -> fast: launches the prebuilt app (no dev server)
#   npm run start:dev    -> dev:  electron-vite dev (HMR, recompiles on launch)
#
# Does everything needed for a working app in one go:
#   1. Finds a compatible CPython (3.9-3.13) - including uv-managed installs
#      that the `py` launcher does NOT expose as `py -3.x`.
#   2. Creates python/.venv and installs the inference deps on first run.
#   3. Builds the app once (and again only when the source changed), then
#      launches the prebuilt Electron app directly - no Vite dev server, no
#      per-launch recompile, so re-runs are near-instant.
# =============================================================================

param([switch]$Dev)

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$pythonDir = Join-Path $root 'python'
$venvDir   = Join-Path $pythonDir '.venv'
$venvPy    = Join-Path $venvDir 'Scripts\python.exe'
$req       = Join-Path $pythonDir 'requirements.txt'

function Test-Compatible([string]$exe, [string[]]$pre) {
    try {
        $v = (& $exe @pre --version 2>&1 | Out-String)
        if ($LASTEXITCODE -eq 0 -and $v -match '(\d+)\.(\d+)\.(\d+)') {
            if ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 9 -and [int]$Matches[2] -le 13) {
                return $v.Trim()
            }
        }
    } catch { }
    return $null
}

function Find-Python {
    # 1) explicit override
    if ($env:WHISPER_FREE_PYTHON -and (Test-Path $env:WHISPER_FREE_PYTHON)) {
        if (Test-Compatible $env:WHISPER_FREE_PYTHON @()) { return $env:WHISPER_FREE_PYTHON }
    }
    # 2) classic py launcher versions
    foreach ($v in '3.12','3.11','3.10','3.13','3.9') {
        if (Test-Compatible 'py' @("-$v")) {
            $p = (& py "-$v" -c 'import sys;print(sys.executable)' 2>&1 | Out-String).Trim()
            if ($p -and (Test-Path $p)) { return $p }
        }
    }
    # 3) uv-managed pythons (not visible to `py -3.x`)
    $uvRoot = Join-Path $env:APPDATA 'uv\python'
    if (Test-Path $uvRoot) {
        $dirs = Get-ChildItem $uvRoot -Directory -Filter 'cpython-3.*' -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending
        foreach ($d in $dirs) {
            $exe = Join-Path $d.FullName 'python.exe'
            if ((Test-Path $exe) -and (Test-Compatible $exe @())) { return $exe }
        }
    }
    # 4) bare python on PATH
    if (Test-Compatible 'python' @()) {
        $p = (& python -c 'import sys;print(sys.executable)' 2>&1 | Out-String).Trim()
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

# --- ensure the Python sidecar venv exists --------------------------------
if (-not (Test-Path $venvPy)) {
    Write-Host '== First run: setting up Python sidecar ==' -ForegroundColor Cyan
    $py = Find-Python
    if ($null -eq $py) {
        Write-Host 'ERROR: No CPython 3.9-3.13 found.' -ForegroundColor Red
        Write-Host 'Install Python 3.12 (64-bit) from https://www.python.org/downloads/ and re-run.' -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Using $py" -ForegroundColor Green
    & $py -m venv $venvDir
    if (-not (Test-Path $venvPy)) {
        Write-Host 'ERROR: venv python not found after creation.' -ForegroundColor Red
        exit 1
    }
    Write-Host 'Installing inference dependencies (a few minutes, one time only) ...' -ForegroundColor Cyan
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r $req
    Write-Host 'Python sidecar ready. (The ~600 MB model downloads on first dictation.)' -ForegroundColor Green
}

# Belt-and-suspenders: also hand the app an explicit interpreter.
$env:WHISPER_FREE_PYTHON = $venvPy

# --- dev mode: electron-vite dev (HMR, recompiles each launch) -------------
if ($Dev) {
    Write-Host '== Starting Whisper Free (dev / HMR) ==' -ForegroundColor Cyan
    Set-Location $root
    & npm.cmd run dev
    exit $LASTEXITCODE
}

# --- fast mode: build once, then launch the prebuilt app -------------------
$outMain = Join-Path $root 'out\main\index.js'

function Newest-Mtime([string[]]$paths) {
    $newest = [datetime]::MinValue
    foreach ($p in $paths) {
        if (-not (Test-Path $p)) { continue }
        $item = Get-Item $p
        if ($item.PSIsContainer) {
            $m = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue |
                  Measure-Object LastWriteTime -Maximum).Maximum
            if ($m -and $m -gt $newest) { $newest = $m }
        } elseif ($item.LastWriteTime -gt $newest) {
            $newest = $item.LastWriteTime
        }
    }
    return $newest
}

# Rebuild only when out/ is missing or any source/config is newer than the build.
$needsBuild = $true
if (Test-Path $outMain) {
    $srcNewest = Newest-Mtime @(
        (Join-Path $root 'src'),
        (Join-Path $root 'electron.vite.config.ts'),
        (Join-Path $root 'package.json'),
        (Join-Path $root 'tailwind.config.js'),
        (Join-Path $root 'postcss.config.js')
    )
    $needsBuild = $srcNewest -gt (Get-Item $outMain).LastWriteTime
}

if ($needsBuild) {
    Write-Host '== Building app (only runs when the code changed) ==' -ForegroundColor Cyan
    Set-Location $root
    & npm.cmd run build:fast
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: build failed.' -ForegroundColor Red
        exit 1
    }
}

# --- launch the prebuilt app (no dev server, no recompile) -----------------
# Start Electron's GUI binary (electron.exe, /SUBSYSTEM:WINDOWS) DETACHED and
# return immediately, so this console closes instead of sitting around for the
# whole session. Native-app feel: click, app appears, no terminal anywhere.
Write-Host '== Starting Whisper Free ==' -ForegroundColor Cyan
Set-Location $root
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
    Write-Host 'ERROR: electron.exe not found - run "npm install".' -ForegroundColor Red
    exit 1
}
Start-Process -FilePath $electron -ArgumentList "`"$root`"" -WorkingDirectory $root | Out-Null
exit 0
