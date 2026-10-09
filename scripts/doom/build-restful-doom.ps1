#Requires -Version 5.1
<#
.SYNOPSIS
    Build the RESTful-DOOM engine from source and stage it for Fredo (Spec #2968, ST-2).

.DESCRIPTION
    Reproducible, idempotent Windows build of `mkschreder/restful-doom` -- the
    Chocolate-Doom-derived fork that exposes the HTTP+JSON API Fredo drives
    (`GET /api/state`, `POST /api/step`, `GET /api/frame`).

    The build runs inside an MSYS2 "MINGW64" environment. This script:

      1. locates the MSYS2 MINGW64 toolchain (exit 2 when absent -- TOOLING GAP),
      2. refuses all network access when `FREDO_DOOM_BUILD_OFFLINE=1` (exit 3),
      3. ensures the pinned pacman dependency set (idempotent, `--needed`),
      4. copies the vendored source tree (`-SourceDir`, default
         `<repo>/vendor/restful-doom`) into the scratch dir; when `-SourceDir` is
         empty it instead clones / updates `-RepoUrl` and checks out the pinned
         commit (the tracked tree is never mutated),
      5. applies the portability patches in `scripts/doom/patches` (the fork is
         POSIX-only and does not compile as-is against MinGW-w64 + gcc 16),
      6. runs `./autogen.sh`, `./configure --prefix=/mingw64 CFLAGS=-std=gnu11`,
         then `make`,
      7. stages `src/restful-doom.exe` at `<InstallDir>/engine/restful-doom.exe`,
      8. stages the MSYS2 runtime DLL closure (SDL2, SDL2_mixer, SDL2_net, libpng,
         libsamplerate + their transitive MinGW deps) beside the engine so the
         staged engine is SELF-CONTAINED. Windows searches the executable's own
         directory first, so the engine launches with NO `C:\msys64\mingw64\bin`
         on the child PATH (ST-1 finding: the engine exits silently without its
         MinGW DLLs).

    Machine-readable progress is emitted on stderr, one line per transition:
      [build-restful-doom] STEP <toolchain|deps|source|patch|autogen|configure|make|stage>

    The built binary and the WAD are NEVER committed and NEVER bundled. This is a
    development / QA-time producer for the resolver's staged engine candidate
    (`<install_dir>/engine/restful-doom.exe`, see
    `apps/tauri/src-tauri/src/applications/doom/resolver.rs`); the runtime does NOT
    build and does NOT depend on an end-user toolchain.

.PARAMETER InstallDir
    Staging directory. Defaults to `{app_data_dir}/doom`, i.e.
    `%APPDATA%\com.fredo.app\doom` on Windows (Tauri identifier `com.fredo.app`).

.PARAMETER EngineCommit
    The pinned `mkschreder/restful-doom` commit to build. Defaults to the ST-1 pin.

.PARAMETER SourceDir
    Build from this existing source tree instead of cloning: it is copied into
    `-ScratchDir` before patching, so the tracked tree is never mutated. Defaults to
    `<repo>/vendor/restful-doom` (the vendored source). Pass an empty string to fall
    back to the `-RepoUrl` clone path.

.PARAMETER Msys2Root
    Explicit MSYS2 install root (e.g. `C:\msys64`). When omitted, `%MSYS2_ROOT%`,
    `%MSYS2%`, `C:\msys64`, and `%ProgramFiles%\msys64` are probed in order.

.PARAMETER RepoUrl
    Engine fork clone URL. Used only when `-SourceDir` is empty.

.PARAMETER ScratchDir
    Build scratch directory (source copy + objects). Defaults to
    `<InstallDir>\build\restful-doom`. Never committed.

.OUTPUTS
    Exit 0  staged OK -- stdout is the staged engine path (one line).
    Exit 2  MSYS2 MINGW64 toolchain not found (TOOLING GAP).
    Exit 3  offline requested, or source acquisition (clone/fetch/checkout or the
            -SourceDir tree) failed.
    Exit 4  autogen/configure/make failed.

.EXAMPLE
    powershell -File scripts/doom/build-restful-doom.ps1
    powershell -File scripts/doom/build-restful-doom.ps1 -InstallDir D:\doom -EngineCommit eded41b5
    powershell -File scripts/doom/build-restful-doom.ps1 -SourceDir vendor/restful-doom
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:APPDATA 'com.fredo.app\doom'),
    [string]$EngineCommit = 'eded41b5597b7738ec1fa06d24f62b53db982c2c',
    [string]$SourceDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'vendor\restful-doom'),
    [string]$Msys2Root,
    [string]$RepoUrl = 'https://github.com/mkschreder/restful-doom.git',
    [string]$ScratchDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- Exit codes (typed contract, ST-2) ----------------------------------------
$ExitOk        = 0
$ExitToolchain = 2
$ExitClone     = 3
$ExitBuild     = 4

# The pinned pacman dependency set (docs/doom-mode-acquisition.md section 6.1).
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

# Emit one machine-readable progress marker per build transition (ST-2 parses these
# from stderr). Keep the ids stable: toolchain|deps|source|patch|autogen|configure|make|stage.
function Write-Step([string]$Step) {
    Write-Log "STEP $Step"
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
#
# The command's stdout/stderr are relayed to the host console rather than left on
# the success stream: a bare `& $bash ...` would otherwise prepend every output
# line to the function's return value, so callers comparing the result to 0 would
# see a non-empty array and misfire. Capture the exit code first, then relay.
function Invoke-Msys2Bash([string]$Root, [string]$Command) {
    $bash = Join-Path $Root 'usr\bin\bash.exe'
    $env:MSYSTEM = 'MINGW64'
    $env:CHERE_INVOKING = '1'
    Write-Log "msys2> $Command"
    # Native commands (pacman, configure, make) write progress/warnings to
    # stderr; under the script-level `ErrorActionPreference = 'Stop'` those would
    # be treated as terminating errors and abort the build. Relay both streams to
    # the host console under a locally relaxed preference, and capture the exit
    # code before any cmdlet can clobber $LASTEXITCODE.
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $bash -lc $Command 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($output) { $output | ForEach-Object { [Console]::Out.WriteLine($_) } }
    return $code
}

# Parse the direct PE import table of `Path` via the MSYS2 `objdump -p`.
function Get-PeImports([string]$Objdump, [string]$Path) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $dump = & $Objdump -p $Path 2>&1
    } finally {
        $ErrorActionPreference = $previousEap
    }
    $names = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in $dump) {
        $text = $line.ToString().Trim()
        if ($text.StartsWith('DLL Name:')) {
            $names.Add($text.Substring('DLL Name:'.Length).Trim())
        }
    }
    return $names
}

# The transitive closure of MinGW runtime DLLs the engine imports: BFS over the
# PE import tables, keeping only DLLs that live in `<root>\mingw64\bin`. System
# DLLs (KERNEL32, USER32, ...) resolve from Windows and are never staged.
#
# This is derived from the actual built binary rather than a hardcoded list, so
# a toolchain package change cannot silently drop a needed DLL.
function Get-RuntimeDllClosure([string]$Root, [string]$EngineExe) {
    $bin = Join-Path $Root 'mingw64\bin'
    $objdump = Join-Path $bin 'objdump.exe'
    if (-not (Test-Path -LiteralPath $objdump)) {
        Stop-With $ExitBuild "objdump not found at $objdump -- cannot compute the runtime DLL closure."
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    foreach ($name in (Get-PeImports $objdump $EngineExe)) { $queue.Enqueue($name) }
    $resolved = New-Object 'System.Collections.Generic.List[string]'
    while ($queue.Count -gt 0) {
        $name = $queue.Dequeue()
        if ($seen.Contains($name)) { continue }
        [void]$seen.Add($name)
        $candidate = Join-Path $bin $name
        if (Test-Path -LiteralPath $candidate) {
            $resolved.Add($name)
            foreach ($dep in (Get-PeImports $objdump $candidate)) { $queue.Enqueue($dep) }
        }
    }
    return @($resolved | Sort-Object)
}

# True when every DLL named in the manifest exists beside the engine.
function Test-RuntimeDllsStaged([string]$EngineDir, [string]$Manifest) {
    if (-not (Test-Path -LiteralPath $Manifest)) { return $false }
    $names = @(Get-Content -LiteralPath $Manifest | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($names.Count -eq 0) { return $false }
    foreach ($name in $names) {
        if (-not (Test-Path -LiteralPath (Join-Path $EngineDir $name.Trim()))) { return $false }
    }
    return $true
}

# Copy the runtime DLL closure beside the engine and record it in the manifest.
function Stage-RuntimeDlls([string]$Root, [string]$EngineExe, [string]$EngineDir, [string]$Manifest) {
    $bin = Join-Path $Root 'mingw64\bin'
    $dlls = @(Get-RuntimeDllClosure $Root $EngineExe)
    if ($dlls.Count -eq 0) {
        Stop-With $ExitBuild "the engine's runtime DLL closure is empty -- refusing to stage an engine that cannot load."
    }
    foreach ($dll in $dlls) {
        Copy-Item -LiteralPath (Join-Path $bin $dll) -Destination (Join-Path $EngineDir $dll) -Force
    }
    Set-Content -LiteralPath $Manifest -Value ($dlls -join "`n") -NoNewline
    Write-Log ("Staged {0} runtime DLLs beside the engine: {1}" -f $dlls.Count, ($dlls -join ', '))
}

# -- 1. Offline gate (before ANY network or filesystem mutation) --------------
if ($env:FREDO_DOOM_BUILD_OFFLINE -eq '1') {
    Stop-With $ExitClone 'FREDO_DOOM_BUILD_OFFLINE=1 is set: refusing network access. Unset it to clone and build the engine.'
}

# -- 2. Locate the toolchain (TOOLING GAP when absent) ------------------------
$root = Find-Msys2Root
if (-not $root) {
    Stop-With $ExitToolchain "MSYS2 MINGW64 not found (no <root>\usr\bin\bash.exe under: -Msys2Root, %MSYS2_ROOT%, %MSYS2%, C:\msys64, %ProgramFiles%\msys64). Install MSYS2 from https://www.msys2.org/ -- this is a TOOLING GAP, not a script error."
}
Write-Log "MSYS2 root: $root"
Write-Step 'toolchain'

# -- 3. Idempotent short-circuit: an already-staged pinned engine wins ---------
$engineDir = Join-Path $InstallDir 'engine'
$stagedExe = Join-Path $engineDir 'restful-doom.exe'
$markerFile = Join-Path $engineDir '.restful-doom-commit'
$dllManifest = Join-Path $engineDir '.restful-doom-runtime-dlls'
if ((Test-Path -LiteralPath $stagedExe) -and (Test-Path -LiteralPath $markerFile)) {
    $stagedCommit = (Get-Content -LiteralPath $markerFile -Raw).Trim()
    if ($stagedCommit -eq $EngineCommit) {
        if (Test-RuntimeDllsStaged $engineDir $dllManifest) {
            Write-Log "Already staged from $EngineCommit; nothing to do."
            Write-Output $stagedExe
            exit $ExitOk
        }
        # The exe is current but its runtime DLL closure is incomplete (e.g. a
        # stage produced before DLL staging existed). Re-stage the DLLs from the
        # existing binary without paying for a rebuild.
        Write-Log "Engine staged but its runtime DLLs are incomplete -- re-staging the DLL closure."
        Stage-RuntimeDlls $root $stagedExe $engineDir $dllManifest
        Write-Output $stagedExe
        exit $ExitOk
    }
    Write-Log "Staged engine is from $stagedCommit, want $EngineCommit -- rebuilding."
}

# -- 4. Ensure the pinned MSYS2 dependency set (idempotent) -------------------
Write-Step 'deps'
# `-Sy` refreshes the package DB non-interactively; `--needed` makes a re-run a
# no-op. The docs' `pacman -Syu` full-system upgrade is intentionally narrowed to
# a bounded, non-interactive refresh so the script never blocks on a TTY.
$depList = ($Dependencies -join ' ')
$refresh = Invoke-Msys2Bash $root 'pacman -Sy --noconfirm'
if ($refresh -ne 0) {
    Stop-With $ExitToolchain "pacman database refresh failed (exit $refresh). MSYS2 is present but unusable -- this is a TOOLING GAP."
}
Write-Log "Ensuring MSYS2 dependencies: $depList"
$install = Invoke-Msys2Bash $root "pacman -S --needed --noconfirm $depList"
if ($install -ne 0) {
    Stop-With $ExitToolchain "pacman failed to install the MSYS2 dependency set (exit $install). This is a TOOLING GAP."
}

# -- 5. Acquire the build source (vendored copy; clone when -SourceDir is empty)
Write-Step 'source'
if (-not $ScratchDir) {
    $ScratchDir = Join-Path $InstallDir 'build\restful-doom'
}
$scratchPosix = ConvertTo-MsysPath $ScratchDir
$scratchParent = Split-Path -Parent $ScratchDir

if ($SourceDir) {
    # Vendored tracked-source route (Spec #3012): copy the tree into scratch and
    # build from the copy, so the tracked tree is never mutated. A pristine tree is
    # copied every run, so a prior patch application cannot leak into this build.
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'configure.ac'))) {
        Stop-With $ExitClone "source tree '$SourceDir' not found or not a RESTful-DOOM checkout (no configure.ac)."
    }
    Write-Log "Copying vendored source $SourceDir -> $ScratchDir"
    if (Test-Path -LiteralPath $ScratchDir) {
        Remove-Item -LiteralPath $ScratchDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $scratchParent | Out-Null
    New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null
    Get-ChildItem -LiteralPath $SourceDir -Force | Copy-Item -Destination $ScratchDir -Recurse -Force
    # Make the scratch its own git repository root. Otherwise `git apply` below
    # discovers the ENCLOSING repository (the scratch lives inside the Fredo
    # worktree when -InstallDir is under the repo) and resolves the patch paths
    # against that root, silently skipping the engine patches. A clone carries
    # its own `.git`; the vendored copy must match that.
    $init = Invoke-Msys2Bash $root "git -C '$scratchPosix' init -q"
    if ($init -ne 0) {
        Stop-With $ExitBuild "git init in $ScratchDir failed (exit $init)."
    }
}
else {
    if (Test-Path -LiteralPath (Join-Path $ScratchDir '.git')) {
        Write-Log "Updating existing clone at $ScratchDir"
        $fetch = Invoke-Msys2Bash $root "git -C '$scratchPosix' fetch --all --tags --prune"
        if ($fetch -ne 0) {
            Stop-With $ExitClone "git fetch failed (exit $fetch) in $ScratchDir."
        }
    } else {
        Write-Log "Cloning $RepoUrl -> $ScratchDir"
        New-Item -ItemType Directory -Force -Path $scratchParent | Out-Null
        $clone = Invoke-Msys2Bash $root "git clone '$RepoUrl' '$scratchPosix'"
        if ($clone -ne 0) {
            Stop-With $ExitClone "git clone of $RepoUrl failed (exit $clone)."
        }
    }

    $checkout = Invoke-Msys2Bash $root "git -C '$scratchPosix' checkout --force '$EngineCommit'"
    if ($checkout -ne 0) {
        Stop-With $ExitClone "git checkout $EngineCommit failed (exit $checkout)."
    }
}

# -- 5b. Apply the in-repo portability patches -------------------------------
# The fork's HTTP/API layer is POSIX-only: it calls `fmemopen` and `strcasestr`,
# neither of which MinGW-w64 provides, and gcc 16 rejects the implicit
# declarations. The patches under scripts/doom/patches are the minimal,
# documented source fixes; they are applied to the scratch copy so the tracked
# tree keeps its upstream identity (F-75 reverse-applies them against it).
$patchDir = Join-Path $PSScriptRoot 'patches'
if (Test-Path -LiteralPath $patchDir) {
    Write-Step 'patch'
    $patchDirPosix = ConvertTo-MsysPath $patchDir
    $patchFiles = @(Get-ChildItem -LiteralPath $patchDir -Filter '*.patch' | Sort-Object Name)
    foreach ($patchFile in $patchFiles) {
        $patchPosix = "$patchDirPosix/$($patchFile.Name)"
        Write-Log "Applying patch $($patchFile.Name)"
        $apply = Invoke-Msys2Bash $root "git -C '$scratchPosix' apply --whitespace=nowarn '$patchPosix'"
        if ($apply -ne 0) {
            Stop-With $ExitBuild "failed to apply patch $($patchFile.Name) (exit $apply)."
        }
    }
}

# -- 6. Build (autogen -> configure -> make) ----------------------------------
# `--prefix=/mingw64` picks up the MSYS2 SDL2/SDL2_mixer/SDL2_net packages.
# `CFLAGS=-std=gnu11` is REQUIRED: this 2017-era fork predates C23, and gcc 16
# defaults to `-std=gnu23` where `false`/`true` are keywords, so its
# `doomtype.h` boolean enum (`false, true`) fails to compile. Pinning gnu11 is
# the minimal source-free fix and matches the era the fork targets.
Write-Step 'autogen'
$autogen = Invoke-Msys2Bash $root "cd '$scratchPosix' && ./autogen.sh"
if ($autogen -ne 0) {
    Stop-With $ExitBuild "autogen.sh failed (exit $autogen). Fix the build output above and re-run."
}
Write-Step 'configure'
$configure = Invoke-Msys2Bash $root "cd '$scratchPosix' && ./configure --prefix=/mingw64 CFLAGS='-std=gnu11'"
if ($configure -ne 0) {
    Stop-With $ExitBuild "configure failed (exit $configure). Fix the build output above and re-run."
}
Write-Step 'make'
$make = Invoke-Msys2Bash $root "cd '$scratchPosix' && make -j`$(nproc)"
if ($make -ne 0) {
    Stop-With $ExitBuild "make failed (exit $make). Fix the build output above and re-run."
}

# -- 7. Stage the built engine at the resolver's candidate path ---------------
Write-Step 'stage'
$builtExe = Join-Path $ScratchDir 'src\restful-doom.exe'
if (-not (Test-Path -LiteralPath $builtExe)) {
    Stop-With $ExitBuild "build reported success but $builtExe does not exist."
}
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
Copy-Item -LiteralPath $builtExe -Destination $stagedExe -Force
Set-Content -LiteralPath $markerFile -Value $EngineCommit -NoNewline
# -- 8. Stage the runtime DLL closure so the engine is self-contained ---------
Stage-RuntimeDlls $root $stagedExe $engineDir $dllManifest
Write-Log "Staged $builtExe -> $stagedExe (commit $EngineCommit)"
Write-Output $stagedExe
exit $ExitOk
