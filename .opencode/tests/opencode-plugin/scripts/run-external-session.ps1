<#
  run-external-session.ps1 - external-client lever for spec #3197 (AC1 / AC2 / AC5 / NFR-1 / R-3.3).

  Why it exists
  -------------
  AC1 requires an OpenCode session launched *outside* Fredo. Fredo's Terminal feature cannot
  produce that, so this spec authorises exactly one external path: this script. It stamps the
  plugin-relevant variables into the CLIENT PROCESS's own environment and then launches the
  client, which is the only correct lever for "read the opt-out at `setup` in the plugin host's
  process environment" - a variable set in some other shell is invisible to a different process.

  It tees the client's stdout+stderr into one timestamped log whose HEADER records the effective
  environment, so the captured log is self-proving (a log with an EMPTY opt-out header cannot be
  used as evidence for the opt-out leg).

  Usage (run from the repo root). The tester copies this file into .opencode/tmp/3197/ first,
  because only .opencode/scripts/* and .opencode/tmp/* script paths are executable there:

    Copy-Item .opencode/tests/opencode-plugin/scripts/run-external-session.ps1 .opencode/tmp/3197/

    # R-1 / R-2 / R-3  (default-on external session)
    powershell -File .opencode/tmp/3197/run-external-session.ps1 `
      -Prompt "Read apps/opencode-plugin/package.json and reply with its name plus AC1-MARK-abc" `
      -OtlpEndpoint "http://127.0.0.1:16002"

    # R-5 control  -> omit -TelemetryOptOut entirely (var stays UNSET)
    # R-5 opt-out  -> -TelemetryOptOut 0   (also try: false, off)
    # NFR-1        -> -OtlpEndpoint "http://127.0.0.1:<a port confirmed free>"
    # R-1.4        -> -CapturePath ".opencode/tmp/3197/e2e/ac1-events.jsonl"

  -WorkDir (ROUND-2 REPAIR, spec #3197)
  -------------------------------------
  The round-1 lever could not drive the git-commit row (R-3.3 / F-34): it always ran the client in
  the caller's directory, so a `git commit` tool call would have written to the SERVED SPEC BRANCH
  checkout. -WorkDir makes the client operate in a caller-supplied THROWAWAY directory instead.

    # F-34 (a `commit` LOG body). One call builds the throwaway repo AND runs the session in it.
    # -InitRepo creates -WorkDir if needed, git-inits it, sets a local commit identity and seeds an
    # initial commit, so the session's own commit is distinguishable. A nested repo MUST have its
    # own .git, otherwise git walks up to the enclosing repository (the served spec branch) and the
    # commit lands there. .opencode/tmp/ is gitignored (.gitignore), so the scratch repo is
    # invisible to the spec branch's status - it cannot pollute the branch.
    powershell -File .opencode/tmp/3197/run-external-session.ps1 `
      -Prompt "Create a file AC3C-MARK-abc.txt, then git add it and git commit it with the message AC3C-MARK-abc. Reply with the commit hash." `
      -OtlpEndpoint "http://127.0.0.1:16002" `
      -WorkDir ".opencode/tmp/3197/e2e/scratch-repo" -InitRepo

    - "" (default) = the client runs in the directory this script was invoked from: EXACTLY the
      round-1 behaviour, unchanged.
    - A relative -WorkDir is resolved against the invocation directory; without -InitRepo a
      non-existent path is a BLOCKED tooling error (exit 3) - the script never silently falls back
      to the caller's directory.
    - -InitRepo (switch, requires -WorkDir) prepares the throwaway repo: creates the directory when
      absent, runs `git init` when there is no .git marker, sets a LOCAL user.name/user.email, and
      makes one seed commit when HEAD is unborn. Idempotent - it never re-inits or re-seeds a repo
      that already has .git (it only re-asserts the local identity). It exists because the tester's
      sandbox has no bare `git`; the script's child process is the sanctioned form (the same pattern
      as verify-contract-immutable.ps1).
    - When -WorkDir is supplied, -OutDir and -CapturePath are resolved to ABSOLUTE paths against
      the INVOCATION directory, so the log and the FREDO_CAPTURE_EVENTS JSONL still land in the
      repo tree instead of inside the scratch dir. Without -WorkDir both stay exactly as passed.

  REPORTED WORKDIR_GIT: whether -WorkDir is its own git repository (has a .git marker). A `false`
  here means a git tool call in that session would act on the ENCLOSING repository - do NOT use
  such a run for the git-commit row.

  Printed lines to paste into the posted `## Tests Runs`:
    FREDO_TELEMETRY=<value|UNSET>
    OPENCODE_OTLP_ENDPOINT=<value>
    FREDO_CAPTURE_EVENTS=<value|UNSET>
    WORKDIR=<effective client working directory>
    WORKDIR_GIT=true|false
    INITREPO=not-requested|done
    MODEL=<value|default>
    LOG=<path>
    EXITCODE=<n>       (the CLIENT's own exit code when it ran)

  Exit codes:
    0 = the client ran (whatever it printed; read EXITCODE= for the client's own code)
    3 = a tooling blocker, never a product defect: `opencode` is not resolvable (missing the
        `opencode*` sandbox grant), -WorkDir is not an existing directory, -InitRepo was passed
        without -WorkDir, or -InitRepo's git preparation failed (git unavailable / a non-zero
        git init|config|add|commit). Report it to the Orchestrator. Do NOT substitute a Terminal
        session for the AC1 leg.

  PowerShell 5.1 constraints honoured: no `??`, no ternary, no `-ErrorAction` on external
  commands, `$LASTEXITCODE` read immediately after the native call, ASCII-only output.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Prompt,
  [Parameter(Mandatory = $true)][string]$OtlpEndpoint,

  # "" (default) = leave FREDO_TELEMETRY UNSET (control / default-on leg).
  # "0" | "false" | "off" = the opt-out.
  [string]$TelemetryOptOut = "",

  [string]$CapturePath = "",
  [string]$OutDir = ".opencode/tmp/3197/e2e",
  [string]$Model = "",
  [int]$TimeoutSecs = 600,

  # ROUND-2: "" (default) = run the client in the invocation directory (round-1 behaviour).
  # Otherwise the client runs in this directory (relative paths resolve against the invocation dir).
  [string]$WorkDir = "",

  # ROUND-2: prepare -WorkDir as a throwaway git repo (dir, git init, local identity, seed commit).
  [switch]$InitRepo
)

$ErrorActionPreference = 'Stop'

# Structured native git call for the -InitRepo preparation. stderr is DISCARDED: under PowerShell
# 5.1 a native stderr write with $ErrorActionPreference='Stop' is a terminating
# NativeCommandError, and git writes routine advice there. 'Continue' is scoped to the call and
# $LASTEXITCODE is read on the immediately following statement.
function Invoke-Git {
  param([string[]]$GitArgs)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @()
  $code = -1
  try {
    $out = @(& git @GitArgs 2>$null)
    $code = $LASTEXITCODE
  } catch {
    $out = @()
    $code = -1
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($null -eq $code) { $code = -1 }
  return @{ Output = $out; Code = [int]$code }
}

$open = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $open) {
  Write-Output "BLOCKED: opencode not resolvable (missing the tester's opencode* grant; report to the Orchestrator as a TOOLING blocker, not a product defect)"
  Write-Output "EXITCODE=3"
  exit 3
}

# --- effective working directory (-WorkDir) -------------------------------------------------

$invokeRoot = (Get-Location).Path
$workRoot = $invokeRoot
$workDirGiven = ($WorkDir -ne "")

if ($InitRepo -and -not $workDirGiven) {
  Write-Output "BLOCKED: -InitRepo requires -WorkDir (it prepares THAT directory, never the caller's directory)"
  Write-Output "EXITCODE=3"
  exit 3
}

if ($workDirGiven) {
  if ([System.IO.Path]::IsPathRooted($WorkDir)) {
    $workRoot = $WorkDir
  } else {
    $workRoot = Join-Path $invokeRoot $WorkDir
  }
  if (-not (Test-Path -LiteralPath $workRoot -PathType Container)) {
    if ($InitRepo) {
      try {
        New-Item -ItemType Directory -Path $workRoot -Force -ErrorAction Stop | Out-Null
      } catch {
        Write-Output ("BLOCKED: -InitRepo could not create -WorkDir: " + $workRoot)
        Write-Output "EXITCODE=3"
        exit 3
      }
    } else {
      Write-Output ("BLOCKED: -WorkDir is not an existing directory: " + $workRoot)
      Write-Output ("WORKDIR=" + $workRoot)
      Write-Output "EXITCODE=3"
      exit 3
    }
  }
  try {
    $workRoot = (Resolve-Path -LiteralPath $workRoot -ErrorAction Stop).Path
  } catch {
    Write-Output ("BLOCKED: -WorkDir could not be resolved: " + $workRoot)
    Write-Output "EXITCODE=3"
    exit 3
  }
}

# --- optional throwaway-repo preparation (-InitRepo) ----------------------------------------

$initState = "not-requested"
if ($InitRepo) {
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if (-not $gitCmd) {
    Write-Output "BLOCKED: -InitRepo needs git on PATH (report the grant as tooling)"
    Write-Output "EXITCODE=3"
    exit 3
  }

  if (-not (Test-Path -LiteralPath (Join-Path $workRoot '.git'))) {
    $r = Invoke-Git -GitArgs @('-C', $workRoot, 'init')
    if ($r.Code -ne 0) {
      Write-Output ("BLOCKED: git init failed in -WorkDir (exit " + $r.Code + ")")
      Write-Output "EXITCODE=3"
      exit 3
    }
  }

  $r = Invoke-Git -GitArgs @('-C', $workRoot, 'config', 'user.email', 'tester@fredo.local')
  if ($r.Code -ne 0) {
    Write-Output ("BLOCKED: git config user.email failed in -WorkDir (exit " + $r.Code + ")")
    Write-Output "EXITCODE=3"
    exit 3
  }
  $r = Invoke-Git -GitArgs @('-C', $workRoot, 'config', 'user.name', 'Fredo Tester')
  if ($r.Code -ne 0) {
    Write-Output ("BLOCKED: git config user.name failed in -WorkDir (exit " + $r.Code + ")")
    Write-Output "EXITCODE=3"
    exit 3
  }

  # Seed one commit so the session's own commit is distinguishable in `git log`.
  $headRes = Invoke-Git -GitArgs @('-C', $workRoot, 'rev-parse', '--verify', 'HEAD^{commit}')
  if ($headRes.Code -ne 0) {
    $seedFile = Join-Path $workRoot 'seed.txt'
    if (-not (Test-Path -LiteralPath $seedFile)) {
      Set-Content -LiteralPath $seedFile -Value 'seed' -Encoding utf8
    }
    $r = Invoke-Git -GitArgs @('-C', $workRoot, 'add', '-A')
    if ($r.Code -ne 0) {
      Write-Output ("BLOCKED: git add failed in -WorkDir (exit " + $r.Code + ")")
      Write-Output "EXITCODE=3"
      exit 3
    }
    $r = Invoke-Git -GitArgs @('-C', $workRoot, 'commit', '-m', 'seed', '--no-gpg-sign')
    if ($r.Code -ne 0) {
      Write-Output ("BLOCKED: the seed commit failed in -WorkDir (exit " + $r.Code + ")")
      Write-Output "EXITCODE=3"
      exit 3
    }
  }
  $initState = "done"
}

$workIsGit = Test-Path -LiteralPath (Join-Path $workRoot '.git')
$workIsGitText = "false"
if ($workIsGit) { $workIsGitText = "true" }

# Evidence paths stay anchored to the INVOCATION directory when -WorkDir is used, so the log and
# the capture JSONL never land inside the scratch dir. Without -WorkDir they are used as passed
# (identical to round 1).
$outDirEff = $OutDir
$captureEff = $CapturePath
if ($workDirGiven) {
  if (-not [System.IO.Path]::IsPathRooted($outDirEff)) {
    $outDirEff = Join-Path $invokeRoot $outDirEff
  }
  if ($captureEff -ne "" -and -not [System.IO.Path]::IsPathRooted($captureEff)) {
    $captureEff = Join-Path $invokeRoot $captureEff
  }
}

if (-not (Test-Path -LiteralPath $outDirEff)) {
  New-Item -ItemType Directory -Path $outDirEff -Force | Out-Null
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $outDirEff "opencode-$stamp.log"

# --- stamp the environment into THIS process, which becomes the client's environment ---
$env:OPENCODE_OTLP_ENDPOINT = $OtlpEndpoint

if ($TelemetryOptOut -ne "") {
  $env:FREDO_TELEMETRY = $TelemetryOptOut
} else {
  Remove-Item Env:\FREDO_TELEMETRY -ErrorAction SilentlyContinue
}

if ($captureEff -ne "") {
  $env:FREDO_CAPTURE_EVENTS = $captureEff
} else {
  Remove-Item Env:\FREDO_CAPTURE_EVENTS -ErrorAction SilentlyContinue
}

$effTelemetry = if ($env:FREDO_TELEMETRY) { $env:FREDO_TELEMETRY } else { "UNSET" }
$effCapture = if ($env:FREDO_CAPTURE_EVENTS) { $env:FREDO_CAPTURE_EVENTS } else { "UNSET" }
$effModel = $Model
if ($effModel -eq "") { $effModel = "default" }

$header = @(
  "# run-external-session.ps1 - spec #3197 external-client leg",
  "# started: $(Get-Date -Format o)",
  "# client:  $($open.Source)",
  "# workdir: $workRoot",
  "# workdir-is-git: $workIsGitText",
  "# init-repo: $initState",
  "# model:   $effModel",
  "# FREDO_TELEMETRY=$effTelemetry",
  "# OPENCODE_OTLP_ENDPOINT=$($env:OPENCODE_OTLP_ENDPOINT)",
  "# FREDO_CAPTURE_EVENTS=$effCapture",
  "# prompt: $Prompt",
  ""
) -join "`r`n"

Set-Content -LiteralPath $log -Value $header -Encoding utf8

if ($workDirGiven -and -not $workIsGit) {
  Write-Output "WARN: WORKDIR_GIT=false - this directory is not its own git repository, so a git tool call in the session would act on the ENCLOSING repository. Do NOT use this run as evidence for the git-commit row (R-3.3); run 'git init' in -WorkDir first."
}

# --- run the client, merging stdout+stderr into the same log ---
# The client writes its banner/progress to STDERR even on a successful run. Under
# PowerShell 5.1 `$ErrorActionPreference = 'Stop'` a native command's stderr write through
# `*>&1 | Tee-Object` becomes a terminating NativeCommandError, which aborted the lever
# before the client could finish (spec #3197 round 1). Run the native call under
# 'Continue' and read the exit code afterwards - the same pattern telemetry-query.ps1 uses.
#
# `--standalone` is required for the lever to mean what this script promises: OpenCode 2
# runs plugins inside its SERVER process, and by default that server is the shared
# background service (`opencode serve --service`) - a process this script's environment
# cannot reach. `--standalone` makes the CLI host its own server, so the variables stamped
# here ARE the plugin host's environment (spec #3197 round 1: without it the plugin loaded
# in the background service and none of the stamped variables applied).
#
# The client's working directory is -WorkDir when supplied (default: the invocation
# directory), so a tool call that touches the filesystem/git acts there and never on the
# served spec-branch checkout.
try {
  Push-Location -LiteralPath $workRoot -ErrorAction Stop
} catch {
  Write-Output ("BLOCKED: could not enter the client working directory: " + $workRoot)
  Write-Output ("WORKDIR=" + $workRoot)
  Write-Output "EXITCODE=3"
  exit 3
}
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  if ($Model -ne "") {
    & $open.Source run --standalone --model $Model $Prompt *>&1 | Tee-Object -FilePath $log -Append
  } else {
    & $open.Source run --standalone $Prompt *>&1 | Tee-Object -FilePath $log -Append
  }
  $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
}
finally {
  $ErrorActionPreference = $prevEap
  Pop-Location
}

Write-Output "FREDO_TELEMETRY=$effTelemetry"
Write-Output "OPENCODE_OTLP_ENDPOINT=$($env:OPENCODE_OTLP_ENDPOINT)"
Write-Output "FREDO_CAPTURE_EVENTS=$effCapture"
Write-Output ("WORKDIR=" + $workRoot)
Write-Output ("WORKDIR_GIT=" + $workIsGitText)
Write-Output ("INITREPO=" + $initState)
Write-Output ("MODEL=" + $effModel)
Write-Output "LOG=$log"
Write-Output "EXITCODE=$code"

exit 0
