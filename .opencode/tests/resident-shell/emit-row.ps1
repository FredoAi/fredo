<#
.SYNOPSIS
  Environment-correct `fredo emit` producer for the resident-shell suite (issue #3192).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). Runs as a child powershell so the CLI resolves the TARGET
  environment's IPC pipe (the `fredo` CLI resolves FREDO_CLI_PIPE from ITS OWN process environment;
  the app listens on its per-env pipe - ipc.rs socket_name()).

  Emits one QUALIFYING chat turn for `-SessionId`:
    1. chat init    (payload carries userMessage + agentReply + model + token counts)
    2. chat response
    3. agent_session response

  The classifier reads the payload's `userMessage` / `agentReply` / `model` / `promptTokens` /
  `completionTokens` keys for the chat row (rtdb/ingest.rs chat patch), so the emitted row is
  Mission-Monitor-QUALIFYING (non-empty user message AND assistant reply).

  Prerequisite (still true while the main window is destroyed): the app PROCESS is running and
  owns its per-env IPC pipe. The GUI window does not need to exist.

.EXAMPLE
  powershell -File .opencode/tests/resident-shell/emit-row.ps1 -ManifestPath .opencode/tmp/envs/spec3192/manifest.json -SessionId e2e-resident-ab12cd34

  Exit codes: 0 all emits accepted; 1 an emit was rejected; 2 usage / manifest / CLI missing.
#>
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$SessionId,
  [string]$PayloadFile = ".opencode/tests/resident-shell/fixtures/chat-payload.json",
  [string]$Provider = "open_code"
)

$ErrorActionPreference = "Stop"

function Write-Fail {
  param([string]$Message)
  Write-Output ("ERROR: " + $Message)
  exit 2
}

if (-not (Test-Path -LiteralPath $ManifestPath)) { Write-Fail ("manifest not found: " + $ManifestPath) }
try {
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
} catch {
  Write-Fail ("manifest is not valid JSON: " + $ManifestPath)
}

$pipeProp = $manifest.PSObject.Properties["cliPipe"]
if ($null -eq $pipeProp -or [string]::IsNullOrWhiteSpace([string]$pipeProp.Value)) {
  Write-Fail "manifest carries no cliPipe - refusing to emit onto the legacy pipe"
}
$cliPipe = [string]$pipeProp.Value

$envIdProp = $manifest.PSObject.Properties["envId"]
if ($null -ne $envIdProp -and -not [string]::IsNullOrWhiteSpace([string]$envIdProp.Value)) {
  $env:FREDO_ENV_ID = [string]$envIdProp.Value
}
$env:FREDO_CLI_PIPE = $cliPipe

if (-not (Test-Path -LiteralPath $PayloadFile)) { Write-Fail ("payload file not found: " + $PayloadFile) }

$cli = Get-Command "fredo" -ErrorAction SilentlyContinue
if ($null -eq $cli) { Write-Fail "the 'fredo' CLI is not on PATH" }

$correlationId = $SessionId + "-1"
$failures = 0

Write-Output ("CLI_PIPE=" + $cliPipe)
Write-Output ("SESSION_ID=" + $SessionId)
Write-Output ("CORRELATION_ID=" + $correlationId)

Write-Output "EMIT STAGE=chat-init"
& fredo emit --event-type chat --state init --provider $Provider --session-id $SessionId --correlation-id $correlationId --file $PayloadFile
$chatInitCode = $LASTEXITCODE
Write-Output ("EMIT_EXITCODE stage=chat-init code=" + $chatInitCode)
if ($chatInitCode -ne 0) { $failures++ }

Write-Output "EMIT STAGE=chat-response"
& fredo emit --event-type chat --state response --provider $Provider --session-id $SessionId --correlation-id $correlationId --file $PayloadFile
$chatResponseCode = $LASTEXITCODE
Write-Output ("EMIT_EXITCODE stage=chat-response code=" + $chatResponseCode)
if ($chatResponseCode -ne 0) { $failures++ }

Write-Output "EMIT STAGE=agent-session-response"
& fredo emit --event-type agent_session --state response --provider $Provider --session-id $SessionId --correlation-id $correlationId
$agentSessionCode = $LASTEXITCODE
Write-Output ("EMIT_EXITCODE stage=agent-session-response code=" + $agentSessionCode)
if ($agentSessionCode -ne 0) { $failures++ }

if ($failures -eq 0) {
  Write-Output "RESULT=PASS"
  exit 0
}

Write-Output ("FAILURES=" + $failures)
Write-Output "RESULT=FAIL"
exit 1
