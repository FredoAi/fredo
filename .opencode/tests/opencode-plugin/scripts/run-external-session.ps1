<#
  run-external-session.ps1 — external-client lever for spec #3197 (AC1 / AC2 / AC5 / NFR-1).

  Why it exists
  -------------
  AC1 requires an OpenCode session launched *outside* Fredo. Fredo's Terminal feature cannot
  produce that, so this spec authorises exactly one external path: this script. It stamps the
  plugin-relevant variables into the CLIENT PROCESS's own environment and then launches the
  client, which is the only correct lever for "read the opt-out at `setup` in the plugin host's
  process environment" — a variable set in some other shell is invisible to a different process.

  It tees the client's stdout+stderr into one timestamped log whose HEADER records the effective
  environment, so the captured log is self-proving (a log with an EMPTY opt-out header cannot be
  used as evidence for the opt-out leg).

  Usage (run from the repo root). The tester copies this file into `.opencode/tmp/3197/` first,
  because only `.opencode/scripts/*` and `.opencode/tmp/*` script paths are executable there:

    Copy-Item .opencode/tests/opencode-plugin/scripts/run-external-session.ps1 .opencode/tmp/3197/

    # R-1 / R-2 / R-3  (default-on external session)
    powershell -File .opencode/tmp/3197/run-external-session.ps1 `
      -Prompt "Read apps/opencode-plugin/package.json and reply with its name plus AC1-MARK-abc" `
      -OtlpEndpoint "http://127.0.0.1:16002"

    # R-5 control  -> omit -TelemetryOptOut entirely (var stays UNSET)
    # R-5 opt-out  -> -TelemetryOptOut 0   (also try: false, off)
    # NFR-1        -> -OtlpEndpoint "http://127.0.0.1:<a port confirmed free>"
    # R-1.4        -> -CapturePath ".opencode/tmp/3197/e2e/ac1-events.jsonl"

  Printed lines to paste into the posted `## Tests Runs`:
    FREDO_TELEMETRY=<value|UNSET>
    OPENCODE_OTLP_ENDPOINT=<value>
    FREDO_CAPTURE_EVENTS=<value|UNSET>
    LOG=<path>
    EXITCODE=<n>

  Exit codes:
    0 = the client ran (whatever it printed; read EXITCODE= for the client's own code)
    3 = `opencode` is not resolvable -> TOOLING blocker (missing the `opencode*` sandbox grant).
        Report it to the Orchestrator. Do NOT substitute a Terminal session for the AC1 leg.
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
  [int]$TimeoutSecs = 600
)

$ErrorActionPreference = 'Stop'

$open = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $open) {
  Write-Output "BLOCKED: opencode not resolvable (missing the tester's opencode* grant; report to the Orchestrator as a TOOLING blocker, not a product defect)"
  exit 3
}

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $OutDir "opencode-$stamp.log"

# --- stamp the environment into THIS process, which becomes the client's environment ---
$env:OPENCODE_OTLP_ENDPOINT = $OtlpEndpoint

if ($TelemetryOptOut -ne "") {
  $env:FREDO_TELEMETRY = $TelemetryOptOut
} else {
  Remove-Item Env:\FREDO_TELEMETRY -ErrorAction SilentlyContinue
}

if ($CapturePath -ne "") {
  $env:FREDO_CAPTURE_EVENTS = $CapturePath
} else {
  Remove-Item Env:\FREDO_CAPTURE_EVENTS -ErrorAction SilentlyContinue
}

$effTelemetry = if ($env:FREDO_TELEMETRY) { $env:FREDO_TELEMETRY } else { "UNSET" }
$effCapture = if ($env:FREDO_CAPTURE_EVENTS) { $env:FREDO_CAPTURE_EVENTS } else { "UNSET" }

$header = @(
  "# run-external-session.ps1 - spec #3197 external-client leg",
  "# started: $(Get-Date -Format o)",
  "# client:  $($open.Source)",
  "# FREDO_TELEMETRY=$effTelemetry",
  "# OPENCODE_OTLP_ENDPOINT=$($env:OPENCODE_OTLP_ENDPOINT)",
  "# FREDO_CAPTURE_EVENTS=$effCapture",
  "# prompt: $Prompt",
  ""
) -join "`r`n"

Set-Content -LiteralPath $log -Value $header -Encoding utf8

# --- run the client, merging stdout+stderr into the same log ---
# The client writes its banner/progress to STDERR even on a successful run. Under
# PowerShell 5.1 `$ErrorActionPreference = 'Stop'` a native command's stderr write through
# `*>&1 | Tee-Object` becomes a terminating NativeCommandError, which aborted the lever
# before the client could finish (spec #3197 round 1). Run the native call under
# 'Continue' and read the exit code afterwards — the same pattern telemetry-query.ps1 uses.
#
# `--standalone` is required for the lever to mean what this script promises: OpenCode 2
# runs plugins inside its SERVER process, and by default that server is the shared
# background service (`opencode serve --service`) — a process this script's environment
# cannot reach. `--standalone` makes the CLI host its own server, so the variables stamped
# here ARE the plugin host's environment (spec #3197 round 1: without it the plugin loaded
# in the background service and none of the stamped variables applied).
Push-Location -LiteralPath (Get-Location).Path
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
Write-Output "LOG=$log"
Write-Output "EXITCODE=$code"

exit 0
