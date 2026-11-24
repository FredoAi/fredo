<#
.SYNOPSIS
  Launch / window-visibility / stop probe for the background-capture suite (issue #3193).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). The spec's launch contract is "argv is exactly
  [<exe>, --background]", and NO committed lever can produce that argv: `dev-env.ps1` (the
  sanctioned environment harness, param block :143-201) has no app-argument passthrough - it runs
  `pnpm tauri dev` with a merged config only - and `second-launch.ps1` (resident-shell suite)
  deliberately launches with NO argument and requires a resident instance to already exist.

  So this script owns the one missing lever: start the env's OWN binary with `--background` as its
  SOLE argument, with that environment's `FREDO_*` resolution injected into the child (exactly the
  seam vocabulary `resident-shell/second-launch.ps1` established, via the shared
  `manifest-facts.ps1` manifest reader).

  WHY THE WINDOW READING IS NATIVE. The feature declares `tauri.conf.json app.windows[0].visible =
  false`, so the `main` window EXISTS from launch while nothing is shown. Two product-side reads
  therefore CANNOT witness "no window shown":
    * `app_lifecycle_status.mainWindowOpen` is `app.get_webview_window("main").is_some()` -
      EXISTENCE, not visibility (infrastructure/tray.rs:342-347);
    * the window list (`tauri_manage_window action="list"`) lists a hidden window too (the
      resident-shell suite's own N-1 states this).
  The instrument that can witness it is OUTSIDE the process: `Get-Process.MainWindowHandle` is the
  handle of the first VISIBLE, unowned, titled top-level window of that PID (0 when none), and
  `tasklist /FO LIST` reports the same window title independently. A hidden-at-launch window reads
  0 / empty; a shown one reads nonzero / the per-env title. That reading is available whether or
  not the claim holds - it is not produced by the surface under test.

  MODES (-Action)
    Launch     Inject the env seams, start `<exe> --background`, and wait (bounded) until the
               process is alive AND owns the env's own OTLP gRPC, OTLP HTTP and MCP ports. Prints the
               native window reading at that instant (expected 0 for the background contract; the
               ROW judges it - this script does not pass the AC for you). RESULT=PASS means
               "started and ready".
    Windows    Read the native window state of a live PID (default: the manifest's `app` PID).
               Hard-fails when the PID is not live - a zero from a dead PID is not a reading.
    Kill       Bounded force-stop of a PID (cleanup for a background instance that never shows a
               window). Prints ALIVE_AFTER.

  MANIFEST KEYS come only from `manifest-facts.ps1` (dot-sourced from the resident-shell suite -
  one vocabulary, not a copy): `envId`, `pipe`, `dataDir`, `webviewProfile`, `servedCommit`,
  `ports.*`, `processes[]`.

.EXAMPLE
  powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Launch -ManifestPath .opencode/tmp/envs/spec3193/manifest.json -Exe apps/tauri/src-tauri/target/debug/fredo.exe

.EXAMPLE
  powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Windows -ManifestPath .opencode/tmp/envs/spec3193/manifest.json

.EXAMPLE
  powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Kill -TargetPid 12345

  Exit codes: 0 success (Launch: started and ready); 1 Launch did not become ready inside the bound
  (row signal; the started PID is printed so the tester can stop it); 2 usage / manifest / exe /
  absent-input failure.

  PowerShell 5.1-safe. ASCII only outside comments.
#>
param(
  [ValidateSet("Launch", "Windows", "Kill")][string]$Action = "Launch",
  [string]$ManifestPath = "",
  [string]$Exe = "",
  [int]$TargetPid = 0,
  [int]$TimeoutSecs = 180
)

$ErrorActionPreference = "Stop"

function Write-Fail {
  param([string]$Message)
  Write-Output ("ERROR: " + $Message)
  exit 2
}

$factsScript = Join-Path $PSScriptRoot "..\resident-shell\manifest-facts.ps1"
$factsResolved = Resolve-Path -LiteralPath $factsScript -ErrorAction SilentlyContinue
if ($null -eq $factsResolved) {
  Write-Fail ("shared manifest reader not found: " + $factsScript + " (the resident-shell suite owns the manifest-key vocabulary)")
}
. ([string]$factsResolved.Path)

$manifest = $null
if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
  if (-not (Test-Path -LiteralPath $ManifestPath)) { Write-Fail ("manifest not found: " + $ManifestPath) }
  $manifest = Read-ManifestFile -Path $ManifestPath
  if ($null -eq $manifest) { Write-Fail ("manifest is not valid JSON: " + $ManifestPath) }
}

function Get-WindowReading {
  param([int]$ReadPid)
  $proc = Get-Process -Id $ReadPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    Write-Fail ("PID " + $ReadPid + " is not live: a window reading from a dead process is not a reading")
  }
  $handle = 0
  $title = ""
  try {
    $pointer = $proc.MainWindowHandle
    if ($null -ne $pointer) { $handle = $pointer.ToInt64() }
  } catch {
    $handle = 0
  }
  try { $title = [string]$proc.MainWindowTitle } catch { $title = "" }
  Write-Output ("TARGET_PID=" + $ReadPid)
  Write-Output "TARGET_ALIVE=True"
  Write-Output ("MAIN_WINDOW_HANDLE=" + $handle)
  Write-Output ("MAIN_WINDOW_TITLE=" + $title)
  Write-Output ("WINDOW_SHOWN=" + ($handle -ne 0))
  Write-Output "WINDOW_SOURCE=Get-Process.MainWindowHandle (first VISIBLE unowned titled top-level window; 0 when none)"
  Write-Output "WINDOW_CORROBORATION=tasklist /FI \"IMAGENAME eq fredo.exe\" /FO LIST -> Window Title for this PID"
}

function Test-PortListening {
  param([int]$Port)
  if ($Port -le 0) { return $false }
  $connections = @()
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
  return ($connections.Count -gt 0)
}

function Get-PortOwnerPid {
  param([int]$Port)
  if ($Port -le 0) { return 0 }
  $owner = 0
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) { $owner = [int]$connection.OwningProcess }
  } catch {
    $owner = 0
  }
  return $owner
}

if ($Action -eq "Kill") {
  $target = $TargetPid
  if ($target -le 0) {
    if ($null -ne $manifest) { $target = Get-ManifestAppPid -Manifest $manifest }
  }
  if ($target -le 0) { Write-Fail "Kill needs -TargetPid or a manifest carrying an 'app' process (no PID to stop)" }
  $proc = Get-Process -Id $target -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    Write-Fail ("PID " + $target + " is not live: nothing to stop (an absent target must not read as 'stopped')")
  }
  Write-Output ("KILL_TARGET_PID=" + $target)
  try { Stop-Process -Id $target -Force -ErrorAction Stop } catch { Write-Fail ("Stop-Process failed for PID " + $target + ": " + $_.Exception.Message) }
  $deadline = (Get-Date).AddSeconds(30)
  $alive = $true
  while ((Get-Date) -lt $deadline) {
    $still = Get-Process -Id $target -ErrorAction SilentlyContinue
    if ($null -eq $still) { $alive = $false; break }
    Start-Sleep -Milliseconds 250
  }
  Write-Output ("ALIVE_AFTER=" + $alive)
  if ($alive) {
    Write-Output "RESULT=FAIL"
    exit 1
  }
  Write-Output "RESULT=OK"
  exit 0
}

if ($Action -eq "Windows") {
  Write-Output "ACTION=Windows"
  $target = $TargetPid
  if ($target -le 0) {
    if ($null -eq $manifest) { Write-Fail ("Windows needs -TargetPid or -ManifestPath (no PID to read)") }
    $target = Get-ManifestAppPid -Manifest $manifest
    if ($target -le 0) { Write-Fail ("manifest carries no 'app' process PID: " + $ManifestPath + " (a zero from an unmatched predicate is not a window reading)") }
  }
  Get-WindowReading -ReadPid $target
  if ($null -ne $manifest) {
    Write-Output ("ENV_ID=" + (Get-ManifestEnvId -Manifest $manifest))
    Write-Output ("SERVED_COMMIT=" + (Get-ManifestServedCommit -Manifest $manifest))
  }
  Write-Output "RESULT=OK"
  exit 0
}

# ---- Launch -------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  Write-Fail "Launch needs -ManifestPath (the env's process manifest: pipe/ports/dataDir)"
}
if ([string]::IsNullOrWhiteSpace($Exe)) {
  Write-Fail "Launch needs -Exe (the env's own binary, e.g. apps/tauri/src-tauri/target/debug/fredo.exe)"
}
$resolvedExe = Resolve-Path -LiteralPath $Exe -ErrorAction SilentlyContinue
if ($null -eq $resolvedExe) { Write-Fail ("exe not found: " + $Exe) }
$exePath = [string]$resolvedExe.Path

$envId = Get-ManifestEnvId -Manifest $manifest
$cliPipe = Get-ManifestPipe -Manifest $manifest
$dataDir = Get-ManifestDataDir -Manifest $manifest
$webviewProfile = Get-ManifestWebviewProfile -Manifest $manifest
$envRoot = Get-ManifestEnvRoot -ManifestPath $ManifestPath
$grpcPort = Get-ManifestPort -Manifest $manifest -Name "otlpGrpc"
$httpPort = Get-ManifestPort -Manifest $manifest -Name "otlpHttp"
$mcpPort = Get-ManifestPort -Manifest $manifest -Name "mcp"
$vitePort = Get-ManifestPort -Manifest $manifest -Name "vite"

if ([string]::IsNullOrWhiteSpace($cliPipe)) {
  Write-Fail "manifest carries no 'pipe' - refusing to launch onto the legacy/shared pipe (env isolation)"
}
if ([string]::IsNullOrWhiteSpace($dataDir)) {
  Write-Fail "manifest carries no 'dataDir' - refusing to launch without the env resolution"
}
if ($grpcPort -le 0 -or $httpPort -le 0 -or $mcpPort -le 0) {
  Write-Fail ("manifest ports are incomplete (otlpGrpc=" + $grpcPort + " otlpHttp=" + $httpPort + " mcp=" + $mcpPort + "): the readiness gates cannot be evaluated")
}

$env:FREDO_CLI_PIPE = $cliPipe
$env:FREDO_DATA_DIR = $dataDir
if (-not [string]::IsNullOrWhiteSpace($envId)) { $env:FREDO_ENV_ID = $envId }
if (-not [string]::IsNullOrWhiteSpace($envRoot)) { $env:FREDO_ENV_ROOT = $envRoot }
if (-not [string]::IsNullOrWhiteSpace($webviewProfile)) { $env:FREDO_WEBVIEW_PROFILE_DIR = $webviewProfile }
$env:FREDO_MCP_BASE_PORT = [string]$mcpPort
$env:FREDO_INGEST_GRPC_PORT = [string]$grpcPort
$env:FREDO_INGEST_HTTP_PORT = [string]$httpPort
if ($vitePort -gt 0) { $env:FREDO_VITE_PORT = [string]$vitePort }

function Get-FredoPids {
  $found = @()
  try {
    $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'fredo.exe'" -ErrorAction Stop)
    foreach ($proc in $procs) { $found += [int]$proc.ProcessId }
  } catch {
    Write-Fail ("fredo process enumeration failed: " + $_.Exception.Message)
  }
  return @($found | Sort-Object -Unique)
}

$before = Get-FredoPids
Write-Output "ACTION=Launch"
Write-Output ("ENV_ID=" + $envId)
Write-Output ("SERVED_COMMIT=" + (Get-ManifestServedCommit -Manifest $manifest))
Write-Output ("CLI_PIPE=" + $cliPipe)
Write-Output ("DATA_DIR=" + $dataDir)
Write-Output ("EXE=" + $exePath)
Write-Output "ARGV=exactly one argument: --background"
Write-Output ("OTLP_GRPC_PORT=" + $grpcPort)
Write-Output ("OTLP_HTTP_PORT=" + $httpPort)
Write-Output ("MCP_PORT=" + $mcpPort)
Write-Output ("FREDO_PIDS_BEFORE=" + ($before -join ","))

$workingDirectory = Split-Path -Parent $exePath
$process = Start-Process -FilePath $exePath -ArgumentList "--background" -WorkingDirectory $workingDirectory -PassThru
$startPid = [int]$process.Id
Write-Output ("START_PID=" + $startPid)

$startedAt = Get-Date
$deadline = $startedAt.AddSeconds($TimeoutSecs)
$ready = $false
$exited = $false
while ((Get-Date) -lt $deadline) {
  $probe = Get-Process -Id $startPid -ErrorAction SilentlyContinue
  if ($null -eq $probe) { $exited = $true; break }
  $grpcReady = Test-PortListening -Port $grpcPort
  $httpReady = Test-PortListening -Port $httpPort
  $mcpOwner = Get-PortOwnerPid -Port $mcpPort
  if ($grpcReady -and $httpReady -and ($mcpOwner -eq $startPid)) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
$elapsed = ((Get-Date) - $startedAt).TotalSeconds
$alive = ($null -ne (Get-Process -Id $startPid -ErrorAction SilentlyContinue))

$grpcReadyFinal = Test-PortListening -Port $grpcPort
$httpReadyFinal = Test-PortListening -Port $httpPort
$mcpOwnerFinal = Get-PortOwnerPid -Port $mcpPort
$grpcOwner = Get-PortOwnerPid -Port $grpcPort
$httpOwner = Get-PortOwnerPid -Port $httpPort
$after = Get-FredoPids
$newPids = @()
foreach ($candidate in $after) { if ($before -notcontains $candidate) { $newPids += $candidate } }

Write-Output ("ALIVE=" + $alive)
Write-Output ("EXITED=" + $exited)
Write-Output ("READY_SECONDS=" + [math]::Round($elapsed, 1))
Write-Output ("OTLP_GRPC_READY=" + $grpcReadyFinal)
Write-Output ("OTLP_GRPC_OWNER_PID=" + $grpcOwner)
Write-Output ("OTLP_HTTP_READY=" + $httpReadyFinal)
Write-Output ("OTLP_HTTP_OWNER_PID=" + $httpOwner)
Write-Output ("MCP_READY=" + ($mcpOwnerFinal -eq $startPid))
Write-Output ("MCP_OWNER_PID=" + $mcpOwnerFinal)
Write-Output ("PORT_OWNERS_SAME_PID=" + (($grpcOwner -eq $startPid) -and ($httpOwner -eq $startPid) -and ($mcpOwnerFinal -eq $startPid)))
Write-Output ("FREDO_PIDS_AFTER=" + ($after -join ","))
Write-Output ("NEW_FREDO_PIDS=" + ($newPids -join ","))

if ($alive) {
  Get-WindowReading -ReadPid $startPid
} else {
  Write-Output "MAIN_WINDOW_HANDLE=(process exited)"
  Write-Output "MAIN_WINDOW_TITLE=(process exited)"
  try { Write-Output ("EXITCODE=" + $process.ExitCode) } catch { Write-Output "EXITCODE=(unknown)" }
}

if (-not $alive) {
  Write-Output "RESULT=FAIL"
  Write-Output "FAIL_REASON=the background process exited instead of staying resident"
  exit 1
}
if (-not $ready) {
  Write-Output "RESULT=FAIL"
  Write-Output ("FAIL_REASON=not ready inside " + $TimeoutSecs + "s (otlpGrpc=" + $grpcReadyFinal + " otlpHttp=" + $httpReadyFinal + " mcp owned by start pid=" + ($mcpOwnerFinal -eq $startPid) + "); the started PID is " + $startPid)
  exit 1
}
Write-Output "RESULT=PASS"
exit 0
