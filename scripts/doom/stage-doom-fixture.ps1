#Requires -Version 5.1
<#
.SYNOPSIS
    Stage the real RESTful-DOOM engine + the Freedoom IWAD into an in-repo fixture
    directory and print the exact environment exports (Spec #2968, ST-6).

.DESCRIPTION
    QA needs the real engine and the libre game data staged somewhere the runtime
    can be pointed at, plus a deterministic way to induce every AC4 error path.
    This script is that producer. It is idempotent: a re-run copies nothing it
    already has.

    Layout (under -FixtureDir, default <repo>/.opencode/tmp/2968/fixtures):

        engine/restful-doom.exe          the real built engine (ST-2 build script)
        engine/*.dll                     its MSYS2 runtime dependencies (self-contained)
        engine/doom-engine.invalid.exe   a non-PE file -> FREDO_DOOM_ENGINE_PATH spawnFailed lever
        freedoom/freedoom1.wad           the pinned Freedoom 0.13.0 IWAD
        freedoom/freedoom-0.13.0.zip     the verified archive (when downloaded here)

    The built binary and the WAD are NEVER committed and NEVER bundled (G-172).
    .opencode/tmp/ is gitignored, so everything this script writes stays local.

    Engine acquisition order (each step verified, no filesystem hunt):
      1. already staged at <FixtureDir>/engine/restful-doom.exe  -> reuse
      2. already staged at <SourceInstallDir>/engine/...         -> copy
      3. otherwise invoke the committed scripts/doom/build-restful-doom.ps1
         (MSYS2 MINGW64; exit 2 is a TOOLING GAP to block on, per G-172)

    Freedoom acquisition order:
      1. already staged at <FixtureDir>/freedoom/freedoom1.wad and SHA-256 matches -> reuse
      2. already staged at <SourceInstallDir>/freedoom/freedoom1.wad and matches  -> copy
      3. otherwise download the pinned 0.13.0 archive, verify size + SHA-256, extract

    Output: a machine-readable block of `NAME=value` environment exports (the happy
    path first, then one line per AC4 / R-1.4 induction lever), plus the exact
    `dev-env.ps1 -EnvVar "NAME=value"` invocation.

.PARAMETER FixtureDir
    Destination. Defaults to <repo>/.opencode/tmp/2968/fixtures.

.PARAMETER EngineCommit
    Pinned RESTful-DOOM commit to build when the engine is not already staged.
    Defaults to the ST-1 pin.

.PARAMETER SourceInstallDir
    Where an already-built engine/WAD may be reused from. Defaults to the runtime's
    install dir: %APPDATA%\com.fredo.app\doom.

.PARAMETER Msys2Root
    Explicit MSYS2 root (e.g. C:\msys64) forwarded to the build script.

.PARAMETER SkipEngine
    Do not build/copy the engine (require it to already be staged).

.PARAMETER SkipIwad
    Do not download/copy the IWAD (require it to already be staged).

.PARAMETER PlanOnly
    Print the resolved paths + exports and the actions that WOULD run, without
    touching the network or the filesystem. Used to validate the script.

.OUTPUTS
    Exit 0  staged OK -- stdout carries the env exports.
    Exit 2  TOOLING GAP -- engine toolchain absent / engine could not be produced.
    Exit 3  offline requested, or a download failed.
    Exit 4  WAD verification/extraction failed.

.EXAMPLE
    powershell -File scripts/doom/stage-doom-fixture.ps1
    powershell -File scripts/doom/stage-doom-fixture.ps1 -PlanOnly
#>
[CmdletBinding()]
param(
    [string]$FixtureDir,
    [string]$EngineCommit = 'eded41b5597b7738ec1fa06d24f62b53db982c2c',
    [string]$SourceInstallDir,
    [string]$Msys2Root,
    [switch]$SkipEngine,
    [switch]$SkipIwad,
    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- Exit codes (typed contract, ST-6) ----------------------------------------
$ExitOk        = 0
$ExitToolchain = 2
$ExitDownload  = 3
$ExitIwad      = 4

# -- Pinned constants (MUST match acquisition.rs + the ST-1 capture) ----------
$EngineExeName   = 'restful-doom.exe'
$FreedoomUrl     = 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip'
$FreedoomArchive = 'freedoom-0.13.0.zip'
$FreedoomSha256  = '3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59'
$FreedoomBytes   = 24143781
$FreedoomWad     = 'freedoom1.wad'
$FreedoomWadSha  = '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d'
$FreedoomWadBytes = 28795076

# The AC4 / R-1.4 induction levers this fixture supports.
$InvalidEngineName = 'doom-engine.invalid.exe'
$MissingWadName    = 'missing.wad'

function Write-Log([string]$Message) {
    [Console]::Error.WriteLine("[stage-doom-fixture] $Message")
}

function Stop-With([int]$Code, [string]$Message) {
    Write-Log "ERROR ($Code): $Message"
    exit $Code
}

# SHA-256 (lowercase hex) of a file, or $null when it is absent.
function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# True when the file exists AND matches the expected SHA-256.
function Test-Sha256([string]$Path, [string]$Expected) {
    return ((Get-Sha256 $Path) -eq $Expected.ToLowerInvariant())
}

# -- Resolve paths ------------------------------------------------------------
if (-not $FixtureDir) {
    $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    $FixtureDir = Join-Path $repoRoot '.opencode\tmp\2968\fixtures'
}
$FixtureDir = [System.IO.Path]::GetFullPath($FixtureDir)

if (-not $SourceInstallDir) {
    if ($env:APPDATA) {
        $SourceInstallDir = Join-Path $env:APPDATA 'com.fredo.app\doom'
    } else {
        $SourceInstallDir = $null
    }
}

$engineDir    = Join-Path $FixtureDir 'engine'
$engineExe    = Join-Path $engineDir $EngineExeName
$invalidExe   = Join-Path $engineDir $InvalidEngineName
$freedoomDir  = Join-Path $FixtureDir 'freedoom'
$iwadPath     = Join-Path $freedoomDir $FreedoomWad
$missingWad   = Join-Path $freedoomDir $MissingWadName
$archivePath  = Join-Path $freedoomDir $FreedoomArchive
$buildScript  = Join-Path $PSScriptRoot 'build-restful-doom.ps1'

# -- Stage the engine ---------------------------------------------------------
$engineSource = $null
if ($SkipEngine) {
    if (-not (Test-Path -LiteralPath $engineExe -PathType Leaf)) {
        Stop-With $ExitToolchain "-SkipEngine was set but no engine is staged at $engineExe."
    }
    Write-Log "Engine present (SkipEngine): $engineExe"
} elseif (Test-Path -LiteralPath $engineExe -PathType Leaf) {
    Write-Log "Engine already staged: $engineExe"
} elseif ($SourceInstallDir -and (Test-Path -LiteralPath (Join-Path $SourceInstallDir "engine\$EngineExeName") -PathType Leaf)) {
    $engineSource = Join-Path $SourceInstallDir "engine\$EngineExeName"
    Write-Log "Copying staged engine $engineSource -> $engineExe"
    if (-not $PlanOnly) {
        New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
        Copy-Item -LiteralPath $engineSource -Destination $engineExe -Force
    }
} else {
    Write-Log "No staged engine found; invoking build-restful-doom.ps1 -InstallDir $FixtureDir"
    if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf)) {
        Stop-With $ExitToolchain "the committed build script $buildScript is missing."
    }
    if (-not $PlanOnly) {
        $buildArgs = @{
            InstallDir    = $FixtureDir
            EngineCommit  = $EngineCommit
        }
        if ($Msys2Root) { $buildArgs['Msys2Root'] = $Msys2Root }
        & $buildScript @buildArgs
        if ($LASTEXITCODE -ne 0) {
            Stop-With $ExitToolchain "build-restful-doom.ps1 exited $LASTEXITCODE -- see its output. This is a TOOLING GAP (G-172), not a fixture error."
        }
    }
}

# The engine's MSYS2 runtime DLLs must sit beside it (ST-1 section 6: without them
# the child exits immediately, indistinguishable from a failed launch). Copy the
# transitive closure reported by ntldd when available, plus a curated fallback.
function Stage-EngineDlls([string]$Root, [string]$EngineDir, [string]$Engine) {
    $mingwBin = Join-Path $Root 'mingw64\bin'
    if (-not (Test-Path -LiteralPath $mingwBin -PathType Container)) { return }
    $wanted = New-Object System.Collections.Generic.HashSet[string]
    $curated = @(
        'SDL2.dll', 'SDL2_mixer.dll', 'SDL2_net.dll', 'libpng16-16.dll',
        'libsamplerate-0.dll', 'zlib1.dll', 'libgcc_s_seh-1.dll',
        'libwinpthread-1.dll', 'libstdc++-6.dll'
    )
    foreach ($name in $curated) { [void]$wanted.Add($name) }

    $ntldd = Join-Path $mingwBin 'ntldd.exe'
    if (Test-Path -LiteralPath $ntldd -PathType Leaf) {
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $report = & $ntldd -R $Engine 2>$null } finally { $ErrorActionPreference = $previousEap }
        foreach ($line in @($report)) {
            $match = [regex]::Match([string]$line, '=>\s+(.+?\.dll)')
            if ($match.Success) { [void]$wanted.Add($match.Groups[1].Value.Trim()) }
        }
    }

    $copied = 0
    foreach ($dll in $wanted) {
        if ($dll -match '[\\/]') { $source = $dll } else { $source = Join-Path $mingwBin $dll }
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $sourceFull = (Resolve-Path -LiteralPath $source).Path
        # Only MSYS2-provided DLLs -- never a Windows system DLL.
        if (-not $sourceFull.StartsWith($mingwBin, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        Copy-Item -LiteralPath $sourceFull -Destination (Join-Path $EngineDir (Split-Path -Leaf $sourceFull)) -Force
        $copied++
    }
    Write-Log "Staged $copied engine runtime DLL(s) beside $Engine"
}

if (-not $PlanOnly -and (Test-Path -LiteralPath $engineExe -PathType Leaf)) {
    $msys2Roots = @()
    if ($Msys2Root) { $msys2Roots += $Msys2Root }
    if ($env:MSYS2_ROOT) { $msys2Roots += $env:MSYS2_ROOT }
    if ($env:MSYS2) { $msys2Roots += $env:MSYS2 }
    $msys2Roots += 'C:\msys64'
    if ($env:ProgramFiles) { $msys2Roots += (Join-Path $env:ProgramFiles 'msys64') }
    foreach ($candidate in $msys2Roots) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'usr\bin\bash.exe') -PathType Leaf)) {
            Stage-EngineDlls -Root (Get-Item -LiteralPath $candidate).FullName -EngineDir $engineDir -Engine $engineExe
            break
        }
    }
}

# A deliberately invalid engine (exists, but is not a Windows PE) so
# FREDO_DOOM_ENGINE_PATH surfaces spawnFailed without a filesystem hunt.
if (-not $PlanOnly -and -not (Test-Path -LiteralPath $invalidExe -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
    Set-Content -LiteralPath $invalidExe -Value 'not a windows executable' -NoNewline
}

# -- Stage the Freedoom IWAD --------------------------------------------------
if ($SkipIwad) {
    if (-not (Test-Sha256 $iwadPath $FreedoomWadSha)) {
        Stop-With $ExitIwad "-SkipIwad was set but no verified IWAD is staged at $iwadPath."
    }
    Write-Log "IWAD present and verified (SkipIwad): $iwadPath"
} elseif (Test-Sha256 $iwadPath $FreedoomWadSha) {
    Write-Log "IWAD already staged and verified: $iwadPath"
} elseif ($SourceInstallDir -and (Test-Sha256 (Join-Path $SourceInstallDir "freedoom\$FreedoomWad") $FreedoomWadSha)) {
    $sourceWad = Join-Path $SourceInstallDir "freedoom\$FreedoomWad"
    Write-Log "Copying verified IWAD $sourceWad -> $iwadPath"
    if (-not $PlanOnly) {
        New-Item -ItemType Directory -Force -Path $freedoomDir | Out-Null
        Copy-Item -LiteralPath $sourceWad -Destination $iwadPath -Force
    }
} else {
    if ($env:FREDO_DOOM_BUILD_OFFLINE -eq '1') {
        Stop-With $ExitDownload "FREDO_DOOM_BUILD_OFFLINE=1 is set and no verified IWAD is staged -- refusing the network download."
    }
    Write-Log "Downloading pinned Freedoom $FreedoomUrl"
    if (-not $PlanOnly) {
        New-Item -ItemType Directory -Force -Path $freedoomDir | Out-Null
        try {
            Invoke-WebRequest -Uri $FreedoomUrl -OutFile $archivePath -UseBasicParsing
        } catch {
            Stop-With $ExitDownload "download of $FreedoomUrl failed: $($_.Exception.Message)"
        }
        $actualBytes = (Get-Item -LiteralPath $archivePath).Length
        if ($actualBytes -ne $FreedoomBytes) {
            Stop-With $ExitDownload "archive size mismatch: got $actualBytes, expected $FreedoomBytes."
        }
        if (-not (Test-Sha256 $archivePath $FreedoomSha256)) {
            Stop-With $ExitDownload "archive SHA-256 mismatch against the pinned digest $FreedoomSha256."
        }
        Write-Log "Archive verified ($FreedoomBytes bytes, SHA-256 ok); extracting $FreedoomWad"
        $extractDir = Join-Path $freedoomDir 'extract'
        if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
        try {
            Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
        } catch {
            Stop-With $ExitIwad "extracting $archivePath failed: $($_.Exception.Message)"
        }
        $found = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter $FreedoomWad -File | Select-Object -First 1
        if (-not $found) {
            Stop-With $ExitIwad "$FreedoomWad not found inside $archivePath."
        }
        Copy-Item -LiteralPath $found.FullName -Destination $iwadPath -Force
        Remove-Item -LiteralPath $extractDir -Recurse -Force
        if (-not (Test-Sha256 $iwadPath $FreedoomWadSha)) {
            Stop-With $ExitIwad "extracted $FreedoomWad failed its SHA-256 check ($FreedoomWadSha)."
        }
        Write-Log "IWAD staged + verified: $iwadPath ($FreedoomWadBytes bytes)"
    }
}

# -- Print the exact environment exports --------------------------------------
# Machine-readable: one `NAME=value` per line. The happy path first, then the
# AC4 / R-1.4 induction levers (set ONE at a time).
$out = [Console]::Out
$out.WriteLine("# stage-doom-fixture: $FixtureDir")
$out.WriteLine("# Happy path (real engine + real IWAD):")
$out.WriteLine("FREDO_DOOM_INSTALL_DIR=$FixtureDir")
$out.WriteLine("FREDO_DOOM_ENGINE_PATH=$engineExe")
$out.WriteLine("FREDO_DOOM_IWAD_PATH=$iwadPath")
$out.WriteLine("# AC4 / R-1.4 induction levers (inject ONE at a time via dev-env.ps1 -EnvVar):")
$out.WriteLine("# spawnFailed        FREDO_DOOM_ENGINE_PATH=$invalidExe")
$out.WriteLine("# notConfigured      FREDO_DOOM_IWAD_PATH=$missingWad")
$out.WriteLine("# acquireFailed      FREDO_DOOM_ARCHIVE_URL=https://127.0.0.1:1/restful-doom.zip")
$out.WriteLine("#                    FREDO_DOOM_ARCHIVE_SHA256=0000000000000000000000000000000000000000000000000000000000000000")
$out.WriteLine("#                    FREDO_DOOM_ARCHIVE_BYTES=1")
$out.WriteLine("# anti-stub refusal  FREDO_DOOM_REQUIRE_REAL_ENGINE=1  +  FREDO_DOOM_ENGINE_PATH=<the built stub path>")
$out.WriteLine("# build failure      FREDO_DOOM_BUILD_OFFLINE=1  (run build-restful-doom.ps1)")
$out.WriteLine("# frameNotReady      FREDO_DOOM_STUB_FRAME_503=10  (stub only; a count or 250ms/2s/1m)")
$out.WriteLine("#")
$out.WriteLine("# Example: powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2968 -EnvVar `"FREDO_DOOM_ENGINE_PATH=$engineExe`" -EnvVar `"FREDO_DOOM_IWAD_PATH=$iwadPath`"")
$out.WriteLine("stage-doom-fixture: OK")

exit $ExitOk
