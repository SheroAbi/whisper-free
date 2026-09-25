# =============================================================================
# Whisper Free - Python sidecar setup (development convenience).
#
# Creates python/.venv and installs the inference dependencies. The packaged
# app does the same automatically on first launch into %APPDATA%, but running
# this once up front means the first `npm run dev` is instant.
#
# Usage:  npm run setup:python
#         powershell -ExecutionPolicy Bypass -File scripts/setup-python.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$pythonDir = Join-Path $root 'python'
$venvDir = Join-Path $pythonDir '.venv'
$req = Join-Path $pythonDir 'requirements.txt'

Write-Host '== Whisper Free: Python setup ==' -ForegroundColor Cyan

function Get-CompatiblePython {
    # onnxruntime ships wheels for CPython 3.9 - 3.13. Prefer those.
    $candidates = @(
        @('py', @('-3.12')),
        @('py', @('-3.11')),
        @('py', @('-3.10')),
        @('py', @('-3.13')),
        @('py', @('-3.9')),
        @('python', @()),
        @('py', @('-3'))
    )
    foreach ($c in $candidates) {
        $exe = $c[0]
        $pre = $c[1]
        try {
            $v = (& $exe @pre --version 2>&1)
            if ($LASTEXITCODE -eq 0 -and $v -match '(\d+)\.(\d+)\.(\d+)') {
                $minor = [int]$Matches[2]
                if ([int]$Matches[1] -eq 3 -and $minor -ge 9 -and $minor -le 13) {
                    Write-Host "Using $exe $($pre -join ' ') -> $v" -ForegroundColor Green
                    return @($exe, $pre)
                }
            }
        } catch { }
    }
    return $null
}

$py = Get-CompatiblePython
if ($null -eq $py) {
    Write-Host 'ERROR: No CPython 3.9-3.13 found.' -ForegroundColor Red
    Write-Host 'Install Python 3.12 (64-bit) from https://www.python.org/downloads/ and re-run.' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $venvDir)) {
    Write-Host "Creating virtual environment at $venvDir ..." -ForegroundColor Cyan
    & $py[0] @($py[1]) -m venv $venvDir
}

$venvPy = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    Write-Host 'ERROR: venv python not found after creation.' -ForegroundColor Red
    exit 1
}

Write-Host 'Upgrading pip ...' -ForegroundColor Cyan
& $venvPy -m pip install --upgrade pip

Write-Host 'Installing inference dependencies (this can take a few minutes) ...' -ForegroundColor Cyan
& $venvPy -m pip install -r $req

Write-Host ''
Write-Host 'Done. The speech model downloads once on first start and is kept in the model folder.' -ForegroundColor Green
Write-Host "venv: $venvDir" -ForegroundColor DarkGray
