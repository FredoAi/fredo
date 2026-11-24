#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Run a Fredo CLI / dev-env command with a fixture `opencode` shim prepended to
  PATH (issue #3198 ST-1 — the committed PATH forwarder the QA rows call).

.DESCRIPTION
  The `-EnvVar` seam of dev-env.ps1 takes `NAME=value` STRINGS (it cannot
  compose a PATH), and the sandbox forbids command chaining, so nothing else can
  put `fredo` AND a fake `opencode` on ONE PATH for a single invocation. This
  script is that one lever:

    * it PREPENDS -ShimDir to this process's PATH only (the caller's
      environment is never mutated, and nothing is written outside the child),
    * then runs the target (`fredo <Args>` for -Mode Cli, or
      `powershell -File dev-env.ps1 -Action <Up|Restart> ...` otherwise),
    * and PASSES THE CHILD'S EXIT CODE THROUGH unmasked.

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
  (e.g. `.opencode/tests/setup/fixtures/shim-opencode-1x`).

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

# ── 1. The shim directory (the forwarder's own failure if absent) ────────────
if (-not (Test-Path -LiteralPath $ShimDir -PathType Container)) {
    Exit-ForwarderFailure "shim directory not found: $ShimDir"
}
$shimRoot = (Resolve-Path -LiteralPath $ShimDir).Path
$originalPath = $env:PATH
if ([string]::IsNullOrEmpty($originalPath)) {
    $env:PATH = $shimRoot
} else {
    $env:PATH = $shimRoot + ';' + $originalPath
}

# ── 2. Mode Cli: the shimmed `fredo` invocation ──────────────────────────────
if ($Mode -eq 'Cli') {
    $fredo = Get-Command -Name 'fredo' -ErrorAction SilentlyContinue
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

# ── 3. Mode Up|Restart: forward to dev-env.ps1 on the same PATH ──────────────
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

# The launched instance inherits the SAME PATH the shim was prepended to, so
# the app's own `where opencode` resolves the fixture.
$forwardedPath = $shimRoot
if (-not [string]::IsNullOrEmpty($originalPath)) {
    $forwardedPath = $shimRoot + ';' + $originalPath
}

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
