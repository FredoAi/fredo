#Requires -Version 5.1
<#
.SYNOPSIS
    Build the RESTful-DOOM engine from source and stage it for Fredo (Spec #2968, ST-2).

.DESCRIPTION
    Reproducible, idempotent Windows build of `mkschreder/restful-doom` — the
    Chocolate-Doom-derived fork that exposes the HTTP+JSON API Fredo drives
    (`GET /api/state`, `POST /api/step`, `GET /api/frame`).

    The build runs inside an MSYS2 "MINGW64" environment. This script:

      1. locates the MSYS2 MINGW64 toolchain (exit 2 when absent — TOOLING GAP),
      2. refuses all network access when `FREDO_DOOM_BUILD_OFFLINE=1` (exit 3),
      3. ensures the pinned pacman dependency set (idempotent, `--needed`),
      4. clones / updates the fork and checks out the pinned commit,
      5. runs `./autogen.sh && ./configure --prefix=/mingw64 && make`,
      6. stages `src/restful-doom.exe` at `<InstallDir>/engine/restful-doom.exe`.

    The built binary and the WAD are NEVER committed and NEVER bundled. This is a
    development / QA-time producer for the resolver's staged engine candidate
    (`<install_dir>/engine/restful-doom.exe`, see
    `apps/tauri/src-tauri/src/features/doom/resolver.rs`); the runtime does NOT
    build and does NOT depend on an end-user toolchain.

.PARAMETER InstallDir
    Staging directory. Defaults to `{app_data_dir}/doom`, i.e.
    `%APPDATA%\com.fredo.app\doom` on Windows (Tauri identifier `com.fredo.app`).

.PARAMETER EngineCommit
    The pinned `mkschreder/restful-doom` commit to build. Defaults to the ST-1 pin.

.PARAMETER Msys2Root
    Explicit MSYS2 install root (e.g. `C:\msys64`). When omitted, `%MSYS2_ROOT%`,
    `%MSYS2%`, `C:\msys64`, and `%ProgramFiles%\msys64` are probed in order.

.PARAMETER RepoUrl
    Engine fork clone URL. Defaults to the pinned upstream fork.

.PARAMETER ScratchDir
    Build scratch directory (clone + objects). Defaults to
    `<InstallDir>\build\restful-doom`. Never committed.

.OUTPUTS
    Exit 0  staged OK — stdout is the staged engine path (one line).
    Exit 2  MSYS2 MINGW64 toolchain not found (TOOLING GAP).
    Exit 3  offline requested, or clone/fetch/checkout failed.
    Exit 4  autogen/configure/make failed.

.EXAMPLE
    powershell -File scripts/doom/build-restful-doom.ps1
    powershell -File scripts/doom/build-restful-doom.ps1 -InstallDir D:\doom -EngineCommit eded41b5
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:APPDATA 'com.fredo.app\doom'),
    [string]$EngineCommit = 'eded41b5597b7738ec1fa06d24f62b53db982c2c',
    [string]$Msys2Root,
    [string]$RepoUrl = 'https://github.com/mkschreder/restful-doom.git',
    [string]$ScratchDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Exit codes (typed contract, ST-2) ────────────────────────────────────────
$ExitOk        = 0
$ExitToolchain = 2
$ExitClone     = 3
$ExitBuild     = 4

# The pinned pacman dependency set (docs/doom-mode-acquisition.md §6.1).
$Dependencies = @(
    'base-devel',
    'git',
    'mingw-w64-x86_64-toolchain',
    'mingw-w64-x86_64-SDL2',
    'mingw-w64-x86_64-SDL2_mixer',
    'mingw-w64-x86_64-SDL2_net',
    'mingw-w64-x86_64-libsamplerate',
    'mingw-w64-x86_64-libpng'
)

function Write-Log([string]$Message) {
    [Console]::Error.WriteLine("[build-restful-doom] $Message")
}

function Stop-With([int]$Code, [string]$Message) {
    Write-Log "ERROR ($Code): $Message"
    exit $Code
}

# Locate the MSYS2 root: the first candidate whose `usr\bin\bash.exe` exists.
function Find-Msys2Root {
    $candidates = @()
    if ($Msys2Root) { $candidates += $Msys2Root }
    if ($env:MSYS2_ROOT) { $candidates += $env:MSYS2_ROOT }
    if ($env:MSYS2) { $candidates += $env:MSYS2 }
    $candidates += 'C:\msys64'
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'msys64') }
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (Test-Path -LiteralPath (Join-Path $candidate 'usr\bin\bash.exe')) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }
    return $null
}

# Convert a Windows path to its MSYS2 POSIX form (`C:\a\b` -> `/c/a/b`).
function ConvertTo-MsysPath([string]$WindowsPath) {
    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    if ($full.Length -lt 2 -or $full[1] -ne ':') {
        return ($full -replace '\\', '/')
    }
    $drive = $full.Substring(0, 1).ToLowerInvariant()
    $rest = $full.Substring(2) -replace '\\', '/'
    return "/$drive$rest"
}

# Run one command through the MSYS2 MINGW64 login shell; returns its exit code.
function Invoke-Msys2Bash([string]$Root, [string]$Command) {
    $bash = Join-Path $Root 'usr\bin\bash.exe'
    $env:MSYSTEM = 'MINGW64'
    $env:CHERE_INVOKING = '1'
    Write-Log "msys2> $Command"
    & $bash -lc $Command
    return $LASTEXITCODE
}

# ── 1. Offline gate (before ANY network or filesystem mutation) ──────────────
if ($env:FREDO_DOOM_BUILD_OFFLINE -eq '1') {
    Stop-With $ExitClone 'FREDO_DOOM_BUILD_OFFLINE=1 is set: refusing network access. Unset it to clone and build the engine.'
}

# ── 2. Locate the toolchain (TOOLING GAP when absent) ────────────────────────
$root = Find-Msys2Root
if (-not $root) {
    Stop-With $ExitToolchain "MSYS2 MINGW64 not found (no <root>\usr\bin\bash.exe under: -Msys2Root, %MSYS2_ROOT%, %MSYS2%, C:\msys64, %ProgramFiles%\msys64). Install MSYS2 from https://www.msys2.org/ — this is a TOOLING GAP, not a script error."
}
Write-Log "MSYS2 root: $root"

# ── 3. Idempotent short-circuit: an already-staged pinned engine wins ─────────
$engineDir = Join-Path $InstallDir 'engine'
$stagedExe = Join-Path $engineDir 'restful-doom.exe'
$markerFile = Join-Path $engineDir '.restful-doom-commit'
if ((Test-Path -LiteralPath $stagedExe) -and (Test-Path -LiteralPath $markerFile)) {
    $stagedCommit = (Get-Content -LiteralPath $markerFile -Raw).Trim()
    if ($stagedCommit -eq $EngineCommit) {
        Write-Log "Already staged from $EngineCommit; nothing to do."
        Write-Output $stagedExe
        exit $ExitOk
    }
    Write-Log "Staged engine is from $stagedCommit, want $EngineCommit — rebuilding."
}

# ── 4. Ensure the pinned MSYS2 dependency set (idempotent) ───────────────────
# `-Sy` refreshes the package DB non-interactively; `--needed` makes a re-run a
# no-op. The docs' `pacman -Syu` full-system upgrade is intentionally narrowed to
# a bounded, non-interactive refresh so the script never blocks on a TTY.
$depList = ($Dependencies -join ' ')
$refresh = Invoke-Msys2Bash $root 'pacman -Sy --noconfirm'
if ($refresh -ne 0) {
    Stop-With $ExitToolchain "pacman database refresh failed (exit $refresh). MSYS2 is present but unusable — this is a TOOLING GAP."
}
Write-Log "Ensuring MSYS2 dependencies: $depList"
$install = Invoke-Msys2Bash $root "pacman -S --needed --noconfirm $depList"
if ($install -ne 0) {
    Stop-With $ExitToolchain "pacman failed to install the MSYS2 dependency set (exit $install). This is a TOOLING GAP."
}

# ── 5. Clone / update the fork at the pinned commit ──────────────────────────
if (-not $ScratchDir) {
    $ScratchDir = Join-Path $InstallDir 'build\restful-doom'
}
$scratchPosix = ConvertTo-MsysPath $ScratchDir

if (Test-Path -LiteralPath (Join-Path $ScratchDir '.git')) {
    Write-Log "Updating existing clone at $ScratchDir"
    $fetch = Invoke-Msys2Bash $root "git -C '$scratchPosix' fetch --all --tags --prune"
    if ($fetch -ne 0) {
        Stop-With $ExitClone "git fetch failed (exit $fetch) in $ScratchDir."
    }
} else {
    Write-Log "Cloning $RepoUrl -> $ScratchDir"
    $parent = Split-Path -Parent $ScratchDir
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $clone = Invoke-Msys2Bash $root "git clone '$RepoUrl' '$scratchPosix'"
    if ($clone -ne 0) {
        Stop-With $ExitClone "git clone of $RepoUrl failed (exit $clone)."
    }
}

$checkout = Invoke-Msys2Bash $root "git -C '$scratchPosix' checkout --force '$EngineCommit'"
if ($checkout -ne 0) {
    Stop-With $ExitClone "git checkout $EngineCommit failed (exit $checkout)."
}

# ── 6. Build (autogen -> configure -> make) ──────────────────────────────────
# `--prefix=/mingw64` picks up the MSYS2 SDL2/SDL2_mixer/SDL2_net packages.
$buildCmd = "cd '$scratchPosix' && ./autogen.sh && ./configure --prefix=/mingw64 && make -j`$(nproc)"
$build = Invoke-Msys2Bash $root $buildCmd
if ($build -ne 0) {
    Stop-With $ExitBuild "autogen/configure/make failed (exit $build). Fix the build output above and re-run."
}

# ── 7. Stage the built engine at the resolver's candidate path ───────────────
$builtExe = Join-Path $ScratchDir 'src\restful-doom.exe'
if (-not (Test-Path -LiteralPath $builtExe)) {
    Stop-With $ExitBuild "build reported success but $builtExe does not exist."
}
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
Copy-Item -LiteralPath $builtExe -Destination $stagedExe -Force
Set-Content -LiteralPath $markerFile -Value $EngineCommit -NoNewline
Write-Log "Staged $builtExe -> $stagedExe (commit $EngineCommit)"
Write-Output $stagedExe
exit $ExitOk
