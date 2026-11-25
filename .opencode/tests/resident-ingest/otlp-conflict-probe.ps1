<#
.SYNOPSIS
  Non-destructive OTLP port-conflict / second-instance lever for the resident
  ingest spec (Spec #3194, AC3 + AC1c).

.DESCRIPTION
  `-Mode conflict` (AC3 - a configured OTLP port already bound at startup):

    1. derives the WHOLE environment block from the env manifest + the documented
       env layout, asserts every derived path is INSIDE the env root and exists,
       CLEARS inherited seats that would sabotage the reading
       (`FREDO_STREAM_HEALTH_FORCE`, `FREDO_PG_PASSWORD_FILE`,
       `FREDO_PG_KEYCHAIN_DISABLED`) and REFUSES rather than falling back to the
       shared profile (G-470);
    2. binds a bounded `TcpListener` (ExclusiveAddressUse) on ONE configured OTLP
       port of the target env and PROVES the hold with a second bind attempt from
       its own process (`HOLD_PROVEN=true`) - a hold that is not exclusive would
       let the app bind and the row would pass on nothing;
    3. launches the built artifact through the repo's ONE handle-whitelist spawn
       (`detach-process.psm1`), bounded wait for it to own the env's MCP port;
    4. prints the listener census for BOTH OTLP ports (`TARGET_*` = the held one,
       `SIBLING_*` = the other receiver: 0 rows is the R-3c property), releases
       the holder and exits.

  Nothing is killed. The app is LEFT RUNNING: the typed ingest failure is latched
  for the process lifetime (no retry - R-6), so the tester reads `stream_health`,
  the `fredo-stream-event` heartbeat and the DOM AFTER this script returns, then
  quits through the PRODUCT's own path (which is also the AC5 receipt).

  `-Mode second-instance` (AC1c - the exclusive data-dir lock is already held):
  launches a second copy of the same artifact with the SAME derived env block
  while the incumbent is healthy; the second instance must publish `state:"failed"`
  with a lock error and MUST NOT publish the incumbent's pid/port.

.PARAMETER Manifest
  Required. `<env-root>/manifest.json` from dev-env.ps1.

.PARAMETER Exe
  Required (except with -DryRun). The built artifact to launch. Both the debug
  build (what the env serves) and a release build are accepted; `EXE_KIND=` says
  which was launched.

.PARAMETER Mode
  `conflict` (default) or `second-instance`.

.PARAMETER Receiver
  conflict mode: which configured OTLP receiver to occupy - `grpc` (default) or
  `http`. The second leg of the row runs the OTHER one.

.PARAMETER HoldSecs
  conflict mode: how long the holder stays bound after the app reports ready.
  Default 15 (covers a late bind attempt). 1..600.

.PARAMETER TimeoutSecs
  Bounded wait for the launched app to own the env MCP port. Default 180.

.PARAMETER DryRun
  Print the resolved env block, executable and arguments and the isolation
  checks; spawn NOTHING, bind NOTHING. Exit 0. This is the isolation receipt the
  row pastes BEFORE any child exists (G-470).

.PARAMETER LogDir
  Where the launched app's stdout/stderr go. Default
  `.opencode/tmp/3194/conflict-<stamp>`.

.EXIT CODES
  0  the lever ran and its own preconditions held (`RESULT=PASS`)
  1  the lever ran but its discrimination FAILED (hold not proven, app never
     ready) - a FAILED DRIVE, not a product verdict
  2  REFUSED precondition (manifest missing/unreadable, derived path outside the
     env root, target port already bound, incumbent app still running, frontend
     not serving) - NOTHING was launched

.EXAMPLE
  powershell -File .opencode/tests/resident-ingest/otlp-conflict-probe.ps1 -Manifest .opencode/tmp/envs/spec3194/manifest.json -Exe apps/tauri/src-tauri/target/debug/fredo.exe -DryRun

.EXAMPLE
  powershell -File .opencode/tests/resident-ingest/otlp-conflict-probe.ps1 -Manifest .opencode/tmp/envs/spec3194/manifest.json -Exe apps/tauri/src-tauri/target/debug/fredo.exe -Mode conflict -Receiver grpc
#>
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$Exe = '',
  [ValidateSet('conflict', 'second-instance')][string]$Mode = 'conflict',
  [ValidateSet('grpc', 'http')][string]$Receiver = 'grpc',
  [ValidateRange(1, 600)][int]$HoldSecs = 15,
  [int]$TimeoutSecs = 180,
  [switch]$DryRun,
  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'

function Write-Line { param([string]$Text) Write-Output $Text }

function Refuse {
  param([string]$Reason)
  Write-Line "ERROR=$Reason"
  Write-Line 'RESULT=REFUSED'
  exit 2
}

function Fail {
  param([string]$Reason)
  Write-Line "FAILURE=$Reason"
  Write-Line 'RESULT=FAIL'
  exit 1
}

function Test-PathInside {
  param([string]$Candidate, [string]$Root)
  if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $c = $Candidate.TrimEnd('\', '/').ToLowerInvariant()
  $r = $Root.TrimEnd('\', '/').ToLowerInvariant()
  return ($c -eq $r) -or $c.StartsWith($r + '\') -or $c.StartsWith($r + '/')
}

function Get-ListenerTable {
  param([int]$Timeout)
  $result = @{ Rows = @(); Error = '' }
  $tmpOut = Join-Path ([System.IO.Path]::GetTempPath()) ('conflict-netstat-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $tmpErr = $tmpOut + '.err'
  try {
    $proc = Start-Process -FilePath 'netstat.exe' -ArgumentList '-ano' -NoNewWindow -PassThru -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
    if (-not $proc.WaitForExit($Timeout * 1000)) {
      try { $proc.Kill() } catch {}
      $result.Error = "netstat timed out after ${Timeout}s"
      return $result
    }
  } catch {
    $result.Error = "netstat could not be started: $($_.Exception.Message)"
    return $result
  }
  try {
    if (Test-Path -LiteralPath $tmpOut) { $result.Rows = @(Get-Content -LiteralPath $tmpOut -ErrorAction SilentlyContinue) }
  } catch {
    $result.Error = "netstat output unreadable: $($_.Exception.Message)"
  } finally {
    foreach ($path in @($tmpOut, $tmpErr)) {
      try { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } } catch {}
    }
  }
  return $result
}

function Get-PortOwners {
  param([object[]]$Rows, [string]$ErrorText, [int]$Port)
  if ($ErrorText) { return @{ Rows = 0; Pids = @(); Error = $ErrorText } }
  if ($Port -le 0) { return @{ Rows = 0; Pids = @(); Error = 'port 0 - not a reading' } }
  $ownerPids = New-Object System.Collections.ArrayList
  $count = 0
  foreach ($row in @($Rows)) {
    if (-not $row) { continue }
    $tokens = @(([string]$row).Trim() -split '\s+')
    if ($tokens.Count -lt 5) { continue }
    if ($tokens[0] -ne 'TCP') { continue }
    if ($tokens[3] -ne 'LISTENING') { continue }
    $local = [string]$tokens[1]
    $idx = $local.LastIndexOf(':')
    if ($idx -lt 0) { continue }
    $localPort = 0
    if (-not [int]::TryParse($local.Substring($idx + 1), [ref]$localPort)) { continue }
    if ($localPort -ne $Port) { continue }
    $count++
    $ownerId = 0
    if ([int]::TryParse([string]$tokens[4], [ref]$ownerId) -and $ownerId -gt 0) {
      if (-not $ownerPids.Contains($ownerId)) { [void]$ownerPids.Add($ownerId) }
    }
  }
  return @{ Rows = $count; Pids = @($ownerPids); Error = '' }
}

# --- Resolve + derive ---------------------------------------------------------

$manifestPath = $Manifest
if (-not [System.IO.Path]::IsPathRooted($manifestPath)) { $manifestPath = Join-Path (Get-Location).Path $manifestPath }
$manifestPath = [System.IO.Path]::GetFullPath($manifestPath)
Write-Line "MANIFEST=$manifestPath"
Write-Line "MANIFEST_RESOLVED_FROM=$Manifest"
if (-not (Test-Path -LiteralPath $manifestPath)) { Refuse 'MANIFEST_NOT_FOUND' }
$manifestData = $null
try { $manifestData = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { Refuse 'MANIFEST_UNREADABLE' }
if (-not $manifestData) { Refuse 'MANIFEST_EMPTY' }

$envRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $manifestPath))
$dataDir = ''
if ($manifestData.dataDir) { $dataDir = [System.IO.Path]::GetFullPath([string]$manifestData.dataDir) }
$pgDataDir = Join-Path $envRoot 'postgres'
$pgLockDir = Join-Path $envRoot 'lock'
$webviewDir = Join-Path $envRoot 'webview'
$grpcPort = 0; $httpPort = 0; $mcpPort = 0; $vitePort = 0
if ($manifestData.ports) {
  if ($manifestData.ports.otlpGrpc) { $grpcPort = [int]$manifestData.ports.otlpGrpc }
  if ($manifestData.ports.otlpHttp) { $httpPort = [int]$manifestData.ports.otlpHttp }
  if ($manifestData.ports.mcp) { $mcpPort = [int]$manifestData.ports.mcp }
  if ($manifestData.ports.vite) { $vitePort = [int]$manifestData.ports.vite }
}

Write-Line "ENV_ROOT=$envRoot"
Write-Line "ENV_ID=$($manifestData.envId)"
Write-Line "DERIVED_DATA_DIR=$dataDir"
Write-Line "DERIVED_PG_DATA_DIR=$pgDataDir"
Write-Line "DERIVED_PG_LOCK_DIR=$pgLockDir"
Write-Line "DERIVED_WEBVIEW_DIR=$webviewDir"
Write-Line "DERIVED_OTLP_GRPC=$grpcPort"
Write-Line "DERIVED_OTLP_HTTP=$httpPort"
Write-Line "DERIVED_MCP=$mcpPort"
Write-Line "DERIVED_VITE=$vitePort"

$isolationOk = $true
foreach ($pair in @(
    @{ Name = 'data_dir'; Path = $dataDir; MustExist = $true },
    @{ Name = 'pg_data_dir'; Path = $pgDataDir; MustExist = $true },
    @{ Name = 'pg_lock_dir'; Path = $pgLockDir; MustExist = $true },
    @{ Name = 'webview_dir'; Path = $webviewDir; MustExist = $true })) {
  $inside = Test-PathInside -Candidate $pair.Path -Root $envRoot
  $exists = if ($pair.MustExist) { Test-Path -LiteralPath $pair.Path } else { $true }
  $ok = ($inside -and $exists -and (-not [string]::IsNullOrWhiteSpace($pair.Path)))
  if (-not $ok) { $isolationOk = $false }
  Write-Line ("CHECK={0}_inside_env_root={1} exists={2} path={3}" -f $pair.Name, $inside, $exists, $pair.Path)
}
if (-not $isolationOk) {
  Refuse 'ENV_NOT_ISOLATED: a derived path is missing or outside the env root - refusing rather than falling back to a shared profile (G-470)'
}
if (-not (Test-Path -LiteralPath (Join-Path $pgDataDir 'PG_VERSION'))) {
  Refuse 'CLUSTER_NOT_INITIALISED: the env has no warm cluster (PG_VERSION absent) - run dev-env.ps1 -Action Up once for this env first'
}

# Inherited seats that would sabotage (or silently re-target) the reading.
$clearedNames = New-Object System.Collections.ArrayList
foreach ($name in @('FREDO_STREAM_HEALTH_FORCE', 'FREDO_PG_PASSWORD_FILE', 'FREDO_PG_KEYCHAIN_DISABLED', 'FREDO_INGEST_RUN_MS', 'FREDO_INGEST_SHUTDOWN_FILE')) {
  $existing = [Environment]::GetEnvironmentVariable($name, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
    [void]$clearedNames.Add($name)
  }
}
Write-Line "CLEARED_INHERITED_ENV=$($clearedNames -join ',')"

# One writer per value: everything below comes from the manifest + the layout.
$envBlock = [ordered]@{
  FREDO_ENV_ID                = [string]$manifestData.envId
  FREDO_ENV_ROOT              = $envRoot
  FREDO_DATA_DIR              = $dataDir
  FREDO_PG_DATA_DIR           = $pgDataDir
  FREDO_PG_LOCK_DIR           = $pgLockDir
  WEBVIEW2_USER_DATA_FOLDER   = $webviewDir
  FREDO_MCP_BASE_PORT         = [string]$mcpPort
  FREDO_INGEST_GRPC_PORT      = [string]$grpcPort
  FREDO_INGEST_HTTP_PORT      = [string]$httpPort
  FREDO_CLI_PIPE              = [string]$manifestData.pipe
  FREDO_REQUIRE_ENV_ISOLATION = '1'
}
foreach ($key in $envBlock.Keys) {
  Write-Line ("ENV {0}={1}" -f $key, $envBlock[$key])
}

$targetPort = if ($Receiver -eq 'grpc') { $grpcPort } else { $httpPort }
$siblingPort = if ($Receiver -eq 'grpc') { $httpPort } else { $grpcPort }
Write-Line "MODE=$Mode"
Write-Line "RECEIVER=$Receiver"
Write-Line "TARGET_PORT=$targetPort"
Write-Line "SIBLING_PORT=$siblingPort"
if ($targetPort -le 0 -or $siblingPort -le 0) { Refuse 'OTLP_PORTS_NOT_RECORDED' }

$exePath = ''
if (-not [string]::IsNullOrWhiteSpace($Exe)) {
  if (-not [System.IO.Path]::IsPathRooted($Exe)) { $Exe = Join-Path (Get-Location).Path $Exe }
  $exePath = [System.IO.Path]::GetFullPath($Exe)
  Write-Line "EXE=$exePath"
  $exeKind = if ($exePath.ToLowerInvariant().Contains('\debug\')) { 'debug' } else { 'release' }
  Write-Line "EXE_KIND=$exeKind"
  Write-Line 'ARGS=<none>'
}

# --- Dry run: the isolation receipt, taken BEFORE any child exists (G-470) ----

if ($DryRun) {
  Write-Line 'DRYRUN=true'
  Write-Line 'DRYRUN_ISOLATION=all derived paths inside the env root and present'
  if (-not [string]::IsNullOrWhiteSpace($Exe) -and -not (Test-Path -LiteralPath $exePath)) { Refuse 'EXE_NOT_FOUND' }
  Write-Line 'RESULT=PASS'
  exit 0
}

if ($exePath -eq '') { Refuse 'EXE_REQUIRED: pass -Exe <built fredo.exe> (or -DryRun to review the block only)' }
if (-not (Test-Path -LiteralPath $exePath)) { Refuse 'EXE_NOT_FOUND' }

# apply the block in-process: detach-process.psm1 passes lpEnvironment = NULL, so
# the launched child inherits exactly this process's environment.
foreach ($key in $envBlock.Keys) { Set-Item ("Env:" + $key) $envBlock[$key] }

$tableRead = Get-ListenerTable -Timeout 10
if ($tableRead.Error) { Refuse ('LISTENER_TABLE_UNAVAILABLE: ' + $tableRead.Error) }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ([string]::IsNullOrWhiteSpace($LogDir)) { $LogDir = Join-Path (Get-Location).Path (".opencode\tmp\3194\conflict-" + $stamp) }
$LogDir = [System.IO.Path]::GetFullPath($LogDir)
try { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null } catch { Refuse "LOG_DIR_UNWRITABLE: $LogDir" }
Write-Line "LOG_DIR=$LogDir"

$appOut = Join-Path $LogDir 'app-stdout.log'
$appErr = Join-Path $LogDir 'app-stderr.log'

Import-Module (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts\detach-process.psm1') -ErrorAction Stop

# --- Mode: second-instance (AC1c) --------------------------------------------

if ($Mode -eq 'second-instance') {
  $incumbentPid = 0
  foreach ($proc in @($manifestData.processes)) {
    if ($proc -and ([string]$proc.role -eq 'app')) {
      $candidate = 0
      if ([int]::TryParse([string]$proc.pid, [ref]$candidate)) {
        if (Get-Process -Id $candidate -ErrorAction SilentlyContinue) { $incumbentPid = $candidate }
      }
    }
  }
  if ($incumbentPid -le 0) { Refuse 'NO_INCUMBENT: the manifest records no LIVE app pid - run dev-env.ps1 -Action Up first' }
  Write-Line "INCUMBENT_APP_PID=$incumbentPid"

  $childPid = Start-DetachedProcess -FilePath $exePath -ArgumentString '' -WorkingDirectory (Split-Path -Parent $exePath) -StdOutPath $appOut -StdErrPath $appErr
  Write-Line "APP_PID=$childPid"
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $alive = $false
  $scannedBridge = ''
  while ($watch.Elapsed.TotalSeconds -lt $TimeoutSecs) {
    $alive = [bool](Get-Process -Id $childPid -ErrorAction SilentlyContinue)
    if (-not $alive) { break }
    if (Test-Path -LiteralPath $appOut) {
      try {
        $hit = Select-String -LiteralPath $appOut -Pattern 'WebSocket server listening on: 127\.0\.0\.1:(\d+)' -AllMatches -ErrorAction SilentlyContinue | Select-Object -Last 1
        if ($hit -and $hit.Matches.Count -gt 0) { $scannedBridge = $hit.Matches[0].Groups[1].Value }
      } catch {}
    }
    if ($scannedBridge) { break }
    Start-Sleep -Milliseconds 500
  }
  Write-Line "APP_ALIVE=$alive"
  Write-Line "APP_SECONDS=$([Math]::Round($watch.Elapsed.TotalSeconds, 1))"
  Write-Line "SCANNED_MCP_PORT=$scannedBridge"
  $incumbentAfter = [bool](Get-Process -Id $incumbentPid -ErrorAction SilentlyContinue)
  Write-Line "INCUMBENT_STILL_ALIVE=$incumbentAfter"
  Write-Line "NEXT=attach the MCP driver to appIdentifier=$scannedBridge (or tauri_manage_window action=list), then read pg_supervisor_status on the SECOND instance; it must be state=failed with a lock error and pid/port null"
  if (-not $alive) { Fail 'SECOND_INSTANCE_EXITED: the second copy exited instead of publishing a failed state' }
  if (-not $incumbentAfter) { Fail 'INCUMBENT_DIED: the second copy killed or replaced the incumbent' }
  Write-Line 'RESULT=PASS'
  exit 0
}

# --- Mode: conflict (AC3) -----------------------------------------------------

$recordedAppPid = 0
foreach ($proc in @($manifestData.processes)) {
  if ($proc -and ([string]$proc.role -eq 'app')) {
    $candidate = 0
    if ([int]::TryParse([string]$proc.pid, [ref]$candidate)) {
      if (Get-Process -Id $candidate -ErrorAction SilentlyContinue) { $recordedAppPid = $candidate }
    }
  }
}
if ($recordedAppPid -gt 0) {
  Refuse "APP_STILL_RUNNING pid=$recordedAppPid - stop it through the product's own quit path first (the conflict leg needs the env's ONE app slot free)"
}

$viteRead = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $vitePort
Write-Line "VITE_LISTENER_ROWS=$($viteRead.Rows)"
if ($viteRead.Rows -lt 1) {
  Refuse "NO_FRONTEND_SERVING port=$vitePort - the relaunched app would paint nothing; keep the env's Vite server up (dev-env.ps1 -Action Up, then quit only the app)"
}

$targetBefore = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $targetPort
Write-Line "TARGET_LISTENER_ROWS_BEFORE=$($targetBefore.Rows)"
if ($targetBefore.Rows -ne 0) { Refuse "TARGET_PORT_ALREADY_BOUND port=$targetPort owners=$(($targetBefore.Pids) -join ',')" }

$holder = $null
try {
  $holder = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $targetPort)
  $holder.ExclusiveAddressUse = $true
  $holder.Start()
} catch {
  if ($holder) { try { $holder.Stop() } catch {} }
  Refuse ("HOLDER_BIND_FAILED port=$targetPort: " + $_.Exception.Message)
}
Write-Line "HOLDER_PORT=$targetPort"
Write-Line "HOLDER_PID=$PID"

# The discrimination control: a hold that is not exclusive proves nothing.
$holdProven = $false
$probe = $null
try {
  $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $targetPort)
  $probe.Start()
  $holdProven = $false
} catch {
  $holdProven = $true
} finally {
  if ($probe) { try { $probe.Stop() } catch {} }
}
Write-Line "HOLD_PROVEN=$holdProven"
if (-not $holdProven) {
  try { $holder.Stop() } catch {}
  Fail "HOLD_NOT_PROVEN port=$targetPort - a second bind succeeded, so the app could bind too and this drive proves nothing"
}

$childPid = 0
try {
  $childPid = Start-DetachedProcess -FilePath $exePath -ArgumentString '' -WorkingDirectory (Split-Path -Parent $exePath) -StdOutPath $appOut -StdErrPath $appErr
} catch {
  try { $holder.Stop() } catch {}
  Refuse ("APP_LAUNCH_FAILED: " + $_.Exception.Message)
}
Write-Line "APP_PID=$childPid"

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$ready = $false
$appAlive = $true
while ($watch.Elapsed.TotalSeconds -lt $TimeoutSecs) {
  $appAlive = [bool](Get-Process -Id $childPid -ErrorAction SilentlyContinue)
  if (-not $appAlive) { break }
  $reRead = Get-ListenerTable -Timeout 10
  $mcpRead = Get-PortOwners -Rows $reRead.Rows -ErrorText $reRead.Error -Port $mcpPort
  if (($mcpRead.Rows -ge 1) -and ($mcpRead.Pids -contains $childPid)) { $ready = $true; break }
  Start-Sleep -Milliseconds 750
}
Write-Line "APP_ALIVE=$appAlive"
Write-Line "APP_READY=$ready"
Write-Line "APP_READY_SECONDS=$([Math]::Round($watch.Elapsed.TotalSeconds, 1))"

# The state is latched for the process lifetime (no retry, R-6): keep the holder
# bound through a settle window so a late bind attempt cannot slip in, then
# release and let the tester read.
Start-Sleep -Seconds $HoldSecs

$finalRead = Get-ListenerTable -Timeout 10
$targetNow = Get-PortOwners -Rows $finalRead.Rows -ErrorText $finalRead.Error -Port $targetPort
$siblingNow = Get-PortOwners -Rows $finalRead.Rows -ErrorText $finalRead.Error -Port $siblingPort
Write-Line "TARGET_LISTENER_ROWS=$($targetNow.Rows)"
Write-Line "TARGET_LISTENER_OWNER_PIDS=$(($targetNow.Pids) -join ',')"
Write-Line "SIBLING_LISTENER_ROWS=$($siblingNow.Rows)"
Write-Line "SIBLING_LISTENER_OWNER_PIDS=$(($siblingNow.Pids) -join ',')"
try { $holder.Stop() } catch {}
Write-Line 'HOLDER_RELEASED=true'
Write-Line "NEXT=read stream_health + the next fredo-stream-event heartbeat + [data-testid=health-line-telemetry] NOW (failures are latched); then quit through the product's own path"

if (-not $ready) { Fail 'APP_NOT_READY: the launched app never owned the env MCP port inside the bound' }
if ($targetNow.Rows -ne 1) { Fail "TARGET_LISTENER_NOT_HELD rows=$($targetNow.Rows)" }
if ($siblingNow.Rows -ne 0) { Fail "SIBLING_STILL_BOUND port=$siblingPort rows=$($siblingNow.Rows) - a half pipeline survived (R-3c)" }
Write-Line 'RESULT=PASS'
exit 0
