#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Run a Fredo CLI / dev-env command with a fixture `opencode` shim that SHADOWS
  the host's installed runtimes (issue #3198 ST-S6 / L-1 — the committed PATH
  forwarder the QA rows call; round 2 makes -ShimDir shadowing).

.DESCRIPTION
  The `-EnvVar` seam of dev-env.ps1 takes `NAME=value` STRINGS (it cannot
  compose a PATH), and the sandbox forbids command chaining, so nothing else can
  put `fredo` AND a fake `opencode` on ONE PATH for a single invocation. This
  script is that one lever:

    * it PREPENDS -ShimDir to this child's PATH (the caller's environment is
      never mutated — the rewrite is this process's, inherited only by the
      child),
    * it DROPS every pre-existing PATH entry that holds a resolvable
      `opencode.*` (`.exe`, `.cmd`, `.bat`), for that child only. The product
      probes `opencode.exe` FIRST and `where.exe` scans the WHOLE PATH per
      candidate (`apps/tauri/src-tauri/src/infrastructure/opencode_version.rs`
      `resolve_opencode_binary()`, same order as
      `applications/terminal/commands.rs` `cli_candidates`), so a prepended dir
      holding only `opencode.cmd` otherwise LOSES to a real binary further down
      — round 1's L-1, which left AC1's in-app face undriven,
    * it BRIDGES the build tools that lived in a dropped entry (`bun`, `bunx`,
      `node`, `npm`, `npx`, `pnpm`, `pnpx`, `corepack`, `yarn`) into
      `.opencode/tmp/[<Spec>/]pathbridge`, so `-Mode Up` still finds `bun` for
      the `beforeDevCommand` plugin build (round 1 dropped all of `.bun\bin` and
      broke the boot). An `opencode.*` is NEVER bridged back — that is the whole
      point. Other tools sharing a dropped entry are NOT bridged,
    * then it runs the target (`fredo <Args>` for -Mode Cli, or
      `powershell -File dev-env.ps1 -Action <Up|Restart> ...` otherwise),
    * and PASSES THE CHILD'S EXIT CODE THROUGH unmasked.

  It prints three receipts on stdout BEFORE the child's output, so a tester can
  paste proof that the fixture actually won:

    SHADOWED=<dropped PATH entry>   (one line per dropped entry, or SHADOWED=none)
    BRIDGED=<bridge dir> <- <names> (or BRIDGED=none)
    RESOLVED=<path the product's own candidate order now lands on> (or none)

  The drive gate is RESOLVED: it MUST name a file inside -ShimDir. A RESOLVED
  naming the host's installed runtime, or SHADOWED=none while `where opencode.exe`
  names a path, means the lever did not engage — a FAILED DRIVE, never a product
  verdict. Never gate on the child's exit code alone.

  When the caller has ALREADY filtered PATH (the QA fixture
  `boot-with-shim.ps1` does, and bridges the build tools itself before
  delegating here), `SHADOWED=none` is expected: nothing is left to drop. In
  that composition the drive gate is boot-with-shim's own `resolved =` line.

  It CONSUMES the QA-authored fixture directories under
  `.opencode/tests/setup/fixtures/shim-opencode-*`; it never generates them
  (QA is the sole test author).

  Exit codes: the child's own code always wins; `1` is returned ONLY for this
  forwarder's own failure (missing -ShimDir, unresolvable `fredo`/`dev-env.ps1`/
  `powershell`) with a `setup-version-shim: ` line on stderr and NO child
  spawned.

  Windows PowerShell 5.1 safe: no `??`, no ternary, no -ErrorAction on a native
  command, and every exit path reads $LASTEXITCODE explicitly.

.PARAMETER Mode
  Cli     -- run `fredo setup <Args>` with the shim on PATH. The `setup`
             subcommand is IMPLIED: the QA rows pass `-Args "--check"` /
             `-Args "--install-plugin"` and expect `fredo setup --check`.
  Up      -- run dev-env.ps1 -Action Up with the shim on PATH.
  Restart -- run dev-env.ps1 -Action Restart with the shim on PATH.

.PARAMETER ShimDir
  Fixture directory holding the fake `opencode.cmd`
  (e.g. `.opencode/tests/setup/fixtures/shim-opencode-1x`). It SHADOWS: the
  child's PATH is this directory first, then every caller entry that does not
  resolve an `opencode.*`.

.PARAMETER Args
  CLI arguments for -Mode Cli, as one string (e.g. `"--check"`). Split on
  whitespace; quoting beyond that is not interpreted.

.PARAMETER Spec
  Forwarded to dev-env.ps1 -Spec when > 0.

.PARAMETER EnvId
  Forwarded to dev-env.ps1 -EnvId when non-blank.

.PARAMETER EnvSlot
  Forwarded to dev-env.ps1 -EnvSlot when >= 0.

.PARAMETER RequireIsolation
  Forwarded to dev-env.ps1 -RequireIsolation. NOTE: this arms dev-env's own
  shared-cluster guard only; it does NOT export FREDO_REQUIRE_ENV_ISOLATION —
  pass that explicitly with -ExtraEnvVar "FREDO_REQUIRE_ENV_ISOLATION=1".

.PARAMETER ExtraEnvVar
  Additional repeatable `NAME=value` strings for the launched instance,
  forwarded to dev-env.ps1 -EnvVar.

.EXAMPLE
  powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Cli -ShimDir .opencode/tests/setup/fixtures/shim-opencode-1x -Args "--check"

.EXAMPLE
  powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Up -ShimDir .opencode/tests/setup/fixtures/shim-opencode-1x -Spec 3198 -EnvId spec3198 -EnvSlot 1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Cli', 'Up', 'Restart')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$ShimDir,

    # `-Args` is the documented call shape; `$args` is a PowerShell automatic
    # variable, so the parameter carries the name as an ALIAS.
    [Alias('Args')]
    [string]$CliArgs = '',

    [uint64]$Spec = 0,
    [string]$EnvId = '',
    [int]$EnvSlot = -1,
    [switch]$RequireIsolation,
    [string[]]$ExtraEnvVar = @()
)

$ErrorActionPreference = 'Continue'

function Exit-ForwarderFailure {
    param([string]$Message)
    [Console]::Error.WriteLine("setup-version-shim: $Message")
    exit 1
}

# Case/trailing-slash-insensitive directory comparison (a PATH entry and a
# `where.exe` result name the same directory in different spellings).
function Test-SameDirectory {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    $a = $Left.Trim().Trim('"').TrimEnd('\')
    $b = $Right.Trim().Trim('"').TrimEnd('\')
    if ([string]::IsNullOrWhiteSpace($a) -or [string]::IsNullOrWhiteSpace($b)) { return $false }
    return [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase)
}

# Every existing FILE `where.exe` returns for one name, in PATH order. `where.exe`
# is invoked by absolute path: the product spawns `where` off PATH, and this
# lever must not depend on the PATH it is rewriting.
function Get-WhereMatches {
    param([string]$Name)
    $found = @()
    $lines = @()
    try { $lines = @(& $script:WhereExe $Name 2>$null) } catch { $lines = @() }
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $candidate = $line.Trim()
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $found += $candidate }
    }
    return $found
}

$script:WhereExe = Join-Path -Path $env:SystemRoot -ChildPath 'System32\where.exe'
if (-not (Test-Path -LiteralPath $script:WhereExe -PathType Leaf)) { $script:WhereExe = 'where.exe' }

# ── 1. The shim directory (the forwarder's own failure if absent) ────────────
if (-not (Test-Path -LiteralPath $ShimDir -PathType Container)) {
    Exit-ForwarderFailure "shim directory not found: $ShimDir"
}
$shimRoot = (Resolve-Path -LiteralPath $ShimDir).Path
$originalPath = $env:PATH

# The product's Windows candidate order for the shadow test — the same three
# names `resolve_opencode_binary()` probes before the bare candidate.
$opencodeCandidates = @('opencode.exe', 'opencode.cmd', 'opencode.bat')
# Build tools that must survive a shadowed entry: dev-env runs `pnpm dev:tauri`,
# whose beforeDevCommand builds the plugin with `bun build`; Vite needs node.
$buildToolStems = @('bun', 'bunx', 'node', 'npm', 'npx', 'pnpm', 'pnpx', 'corepack', 'yarn')

# `fredo` must survive the shadowing: resolve it from the CALLER's PATH before
# the rewrite, so a `.bun\bin`-style entry that holds both `fredo` and
# `opencode.exe` cannot take the CLI away with the binary.
$fredo = $null
if ($Mode -eq 'Cli') {
    $fredo = Get-Command -Name 'fredo' -ErrorAction SilentlyContinue
}

# ── 2. Which PATH entries resolve an `opencode.*`? ──────────────────────────
$shadowDirs = @()
foreach ($name in $opencodeCandidates) {
    foreach ($match in @(Get-WhereMatches -Name $name)) {
        $dir = Split-Path -Parent $match
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        # The fixture is not a host runtime: never shadow (or report) it.
        if (Test-SameDirectory $dir $shimRoot) { continue }
        $known = $false
        foreach ($existing in $shadowDirs) {
            if (Test-SameDirectory $existing $dir) { $known = $true }
        }
        if (-not $known) { $shadowDirs += $dir }
    }
}

# ── 3. Partition the caller's PATH: the fixture first, shadowed entries out ──
$allEntries = @()
if (-not [string]::IsNullOrWhiteSpace($originalPath)) {
    foreach ($piece in ($originalPath -split ';')) {
        if (-not [string]::IsNullOrWhiteSpace($piece)) { $allEntries += $piece.Trim() }
    }
}

$shadowed = @()
$keptEntries = @()
foreach ($entry in $allEntries) {
    # Never drop the fixture itself: it may already be on PATH (boot-with-shim).
    if (Test-SameDirectory $entry $shimRoot) { $keptEntries += $entry; continue }
    $drop = $false
    foreach ($dir in $shadowDirs) {
        if (Test-SameDirectory $entry $dir) { $drop = $true }
    }
    if ($drop) { $shadowed += $entry } else { $keptEntries += $entry }
}

# ── 4. Bridge back the build tools a shadowed entry carried ─────────────────
$bridgeRoot = ''
$bridgedNames = @()
foreach ($dir in $shadowed) {
    $files = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)
    foreach ($file in $files) {
        $extension = [System.IO.Path]::GetExtension($file.Name).ToLower()
        if ($extension -ne '.exe' -and $extension -ne '.cmd' -and $extension -ne '.bat') { continue }
        $stem = [System.IO.Path]::GetFileNameWithoutExtension($file.Name).ToLower()
        # NEVER bridge an opencode binary back — that is the whole point.
        if ($stem -eq 'opencode') { continue }
        if (-not ($buildToolStems -contains $stem)) { continue }
        if ([string]::IsNullOrWhiteSpace($bridgeRoot)) {
            $tmpRoot = Join-Path -Path (Split-Path -Parent $PSScriptRoot) -ChildPath 'tmp'
            if ($Spec -gt 0) { $tmpRoot = Join-Path -Path $tmpRoot -ChildPath $Spec.ToString() }
            $bridgeRoot = Join-Path -Path $tmpRoot -ChildPath 'pathbridge'
            if (-not (Test-Path -LiteralPath $bridgeRoot -PathType Container)) {
                New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null
            }
        }
        Copy-Item -LiteralPath $file.FullName -Destination $bridgeRoot -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot $file.Name) -PathType Leaf)) {
            [Console]::Error.WriteLine('setup-version-shim: could not bridge ' + $file.Name + ' from the shadowed entry ' + $dir)
            continue
        }
        if (-not ($bridgedNames -contains $file.Name)) { $bridgedNames += $file.Name }
    }
}

# ── 5. The child's PATH (this process only; the caller is untouched) ────────
$launchedEntries = @($shimRoot)
if (-not [string]::IsNullOrWhiteSpace($bridgeRoot)) { $launchedEntries += $bridgeRoot }
foreach ($entry in $keptEntries) { $launchedEntries += $entry }
$launchedPath = $launchedEntries -join ';'
$env:PATH = $launchedPath

# ── 6. Receipts — paste these as proof the fixture won ─────────────────────
if ($shadowed.Count -gt 0) {
    foreach ($entry in $shadowed) { Write-Output ('SHADOWED=' + $entry) }
} else {
    Write-Output 'SHADOWED=none'
}
if ($bridgedNames.Count -gt 0) {
    Write-Output ('BRIDGED=' + $bridgeRoot + ' <- ' + ($bridgedNames -join ','))
} else {
    Write-Output 'BRIDGED=none'
}
$resolvedOpencode = 'none'
foreach ($name in $opencodeCandidates) {
    $hits = @(Get-WhereMatches -Name $name)
    if ($hits.Count -gt 0) { $resolvedOpencode = $hits[0]; break }
}
Write-Output ('RESOLVED=' + $resolvedOpencode)

# ── 7. Mode Cli: the shimmed `fredo` invocation ─────────────────────────────
if ($Mode -eq 'Cli') {
    if ($null -eq $fredo) {
        # The fixture directory may itself provide `fredo` (the documented
        # fixtures hold only `opencode.cmd`, so this is only a safety net).
        $fredo = Get-Command -Name 'fredo' -ErrorAction SilentlyContinue
    }
    if ($null -eq $fredo) {
        Exit-ForwarderFailure "could not resolve 'fredo' on PATH (shim dir: $shimRoot)"
    }

    $cliTokens = @('setup')
    if (-not [string]::IsNullOrWhiteSpace($CliArgs)) {
        $cliTokens += @($CliArgs.Trim() -split '\s+')
    }

    & $fredo.Path @cliTokens
    $childCode = $LASTEXITCODE
    if ($null -eq $childCode) {
        # A PowerShell (non-native) `fredo` sets no exit code; treat it as success.
        $childCode = 0
    }
    exit $childCode
}

# ── 8. Mode Up|Restart: forward to dev-env.ps1 on the same PATH ─────────────
$devEnv = Join-Path -Path $PSScriptRoot -ChildPath 'dev-env.ps1'
if (-not (Test-Path -LiteralPath $devEnv -PathType Leaf)) {
    Exit-ForwarderFailure "dev-env.ps1 not found next to this script: $devEnv"
}

$psExe = 'powershell'
$psCommand = Get-Command -Name 'powershell' -ErrorAction SilentlyContinue
if ($null -eq $psCommand) {
    $psFallback = Join-Path $PSHOME 'powershell.exe'
    if (Test-Path -LiteralPath $psFallback -PathType Leaf) {
        $psExe = $psFallback
    } else {
        Exit-ForwarderFailure 'could not resolve powershell to run dev-env.ps1'
    }
}

# The launched instance inherits the SAME shadowed PATH (fixture first, every
# entry that resolved an `opencode.*` dropped), so the app's own `where
# opencode.*` can only land on the fixture.
$forwardedPath = $launchedPath

$devEnvArgs = @(
    '-NoProfile',
    '-File', $devEnv,
    '-Action', $Mode,
    '-EnvVar', ("PATH=" + $forwardedPath)
)

foreach ($pair in $ExtraEnvVar) {
    if (-not [string]::IsNullOrWhiteSpace($pair)) {
        $devEnvArgs += @('-EnvVar', $pair)
    }
}
if ($Spec -gt 0) {
    $devEnvArgs += @('-Spec', $Spec.ToString())
}
if (-not [string]::IsNullOrWhiteSpace($EnvId)) {
    $devEnvArgs += @('-EnvId', $EnvId)
}
if ($EnvSlot -ge 0) {
    $devEnvArgs += @('-EnvSlot', $EnvSlot.ToString())
}
if ($RequireIsolation) {
    $devEnvArgs += '-RequireIsolation'
}

& $psExe @devEnvArgs
$childCode = $LASTEXITCODE
if ($null -eq $childCode) {
    $childCode = 0
}
exit $childCode
