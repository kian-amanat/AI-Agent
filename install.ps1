<#
.SYNOPSIS
  Install Kodo on Windows x64.

.DESCRIPTION
  The Windows counterpart to install.sh. Downloads a release artifact, verifies
  its SHA256, and installs it under %LOCALAPPDATA% — no Administrator rights, no
  Git Bash, no WSL.

  There is no public Kodo release host yet, so this needs -BaseUrl pointing at
  wherever the artifacts are served. See docs/installation.md.

.EXAMPLE
  # Against a local release host (what scripts/test-release.sh stands up):
  powershell -ExecutionPolicy Bypass -File install.ps1 -BaseUrl http://127.0.0.1:8000

.NOTES
  VERIFICATION STATUS: this script has NOT been executed on Windows. It was
  written against the same release layout install.sh consumes and reviewed, but
  no Windows machine was available. Treat it as unverified until it has been run
  — see docs/installation.md.
#>

[CmdletBinding()]
param(
  [string]$BaseUrl = $env:KODO_BASE_URL,
  [string]$Version = $env:KODO_VERSION,
  [string]$InstallDir = $env:KODO_INSTALL_DIR,
  [switch]$SkipChecksum
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  $msg" }
function Die($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Installing Kodo..." -ForegroundColor Cyan
Write-Host ""

# ── Platform ────────────────────────────────────────────────────────────────
if ([Environment]::Is64BitOperatingSystem -ne $true) {
  Die "Kodo requires 64-bit Windows. 32-bit is not supported."
}
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') {
  Die "Windows on ARM is not supported: no arm64 Windows artifact is published. See docs/installation.md."
}
Write-Step "Detected Windows x64"

# ── Node ────────────────────────────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "Node.js is required but was not found on PATH.`n  Install Node.js 20.12 or newer from https://nodejs.org and re-run."
}
$nodeVersion = (& node --version).TrimStart('v')
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt 20 -or ([int]$parts[0] -eq 20 -and [int]$parts[1] -lt 12)) {
  Die "Node.js $nodeVersion is too old. Kodo needs 20.12 or newer."
}
Write-Step "Node.js v$nodeVersion"

# ── Release host ────────────────────────────────────────────────────────────
if (-not $BaseUrl) {
  Die @"
No release host configured.

There is no public Kodo release host yet, so this installer needs to be told
where the artifacts are:

  powershell -ExecutionPolicy Bypass -File install.ps1 -BaseUrl <url>

To install from source instead, see docs/installation.md.
"@
}
$BaseUrl = $BaseUrl.TrimEnd('/')

if (-not $Version) {
  try {
    $Version = (Invoke-WebRequest -Uri "$BaseUrl/releases/latest.txt" -UseBasicParsing).Content.Trim()
  } catch {
    Die "Could not determine the latest version from $BaseUrl/releases/latest.txt`n  $($_.Exception.Message)"
  }
}
Write-Info "Version: $Version"

# ── Download ────────────────────────────────────────────────────────────────
$artifact = "kodo-$Version-win32-x64.tar.gz"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kodo-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  $archive = Join-Path $tmp $artifact
  try {
    Invoke-WebRequest -Uri "$BaseUrl/releases/$Version/$artifact" -OutFile $archive -UseBasicParsing
  } catch {
    Die "Download failed: $BaseUrl/releases/$Version/$artifact`n  $($_.Exception.Message)"
  }
  Write-Step "Downloaded Kodo $Version"

  # ── Verify BEFORE anything is extracted or executed ───────────────────────
  if ($SkipChecksum -or $env:KODO_SKIP_CHECKSUM -eq '1') {
    Write-Host "! skipping checksum verification" -ForegroundColor Yellow
  } else {
    $sumsPath = Join-Path $tmp 'SHA256SUMS'
    try {
      Invoke-WebRequest -Uri "$BaseUrl/releases/$Version/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
    } catch {
      Die "Could not fetch checksums. Refusing to install an unverified download."
    }

    $expected = (Select-String -Path $sumsPath -Pattern ([regex]::Escape($artifact)) |
                 ForEach-Object { ($_.Line -split '\s+')[0] } | Select-Object -First 1)
    if (-not $expected) { Die "No checksum published for $artifact. Refusing to install." }

    $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
      Die @"
Checksum mismatch for $artifact.
  expected: $expected
  actual:   $actual
The download was corrupted or tampered with. Nothing was installed.
"@
    }
    Write-Step "Verified checksum"
  }

  # ── Extract ───────────────────────────────────────────────────────────────
  # tar.exe ships with Windows 10 1803+ and understands .tar.gz.
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tarExe)) { $tarExe = 'tar' }
  & $tarExe -xzf $archive -C $tmp
  if ($LASTEXITCODE -ne 0) { Die "Could not extract $artifact." }

  $payload = Join-Path $tmp 'kodo'
  if (-not (Test-Path (Join-Path $payload 'cli\bin\kodo.mjs'))) {
    Die "The artifact is missing cli\bin\kodo.mjs — it may be corrupt or built with an older script."
  }
  if (-not (Test-Path (Join-Path $payload 'backend1\node_modules'))) {
    Die "The artifact has no bundled dependencies. Rebuild with: node scripts/build-release.mjs"
  }

  # ── Install into a versioned directory ────────────────────────────────────
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Kodo\bin' }
  $libDir = Join-Path $env:LOCALAPPDATA 'Kodo\lib'
  $target = Join-Path $libDir $Version
  $partial = "$target.partial"

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  New-Item -ItemType Directory -Path $libDir -Force | Out-Null
  if (Test-Path $partial) { Remove-Item -Recurse -Force $partial }
  Move-Item -Path $payload -Destination $partial

  # Swap last, so an interrupted install leaves the previous version working.
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item -Path $partial -Destination $target

  # ── Launcher ──────────────────────────────────────────────────────────────
  # A .cmd shim, with the interpreter pinned to the Node that installed Kodo —
  # a bare `node` breaks whenever PATH differs from the installing shell's.
  $nodePath = $node.Source
  $launcher = Join-Path $InstallDir 'kodo.cmd'
  @"
@echo off
setlocal
set "KODO_NODE=$nodePath"
if not exist "%KODO_NODE%" set "KODO_NODE=node"
"%KODO_NODE%" "$target\cli\bin\kodo.mjs" %*
"@ | Set-Content -Path $launcher -Encoding ASCII
  Write-Step "Installed kodo $Version"

  # ── PATH ──────────────────────────────────────────────────────────────────
  # User-level PATH only; never the machine PATH, which needs Administrator.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    Write-Step "Added $InstallDir to your user PATH"
    Write-Info ""
    Write-Info "Open a NEW terminal for the PATH change to take effect."
  }

  Write-Host ""
  Write-Host "Run:" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  kodo --version"
  Write-Host "  kodo doctor"
  Write-Host ""
  Write-Info "Documentation: docs/installation.md"
  Write-Host ""
}
finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
