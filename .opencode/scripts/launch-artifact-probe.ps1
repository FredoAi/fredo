<#
.SYNOPSIS
  Launch a built Fredo GUI artifact, prove a set of TCP ports stays CLOSED, and
  tear the app + its embedded PostgreSQL down with no orphans.

.DESCRIPTION
  Committed replacement for the recurring ad-hoc
  `.opencode/tmp/<issue>/e2e/release-launch.ps1` script (Spec #3077). The job is
  deterministic, repeated and audited (the release MCP-bridge-closed AC), so it
  is a committed, allowlisted tool.

  Contract:
    * REFUSES an exe whose path contains a `\debug\` segment. A production /
      negative assertion MUST run against the release artifact.
    * Waits a BOUNDED time (default 40 s) with the app running.
    * Probes each port with a FAST TCP connect: TcpClient.BeginConnect + a
      600 ms wait. NEVER Test-NetConnection -- it stalls on CLOSED ports and was
      exactly the #3077 hang.
    * Scans stdout/stderr for the MCP bridge line `WebSocket server listening`.
    * Tears down the launched app, its descendant tree, and the embedded
      PostgreSQL that appeared during the launch window (scoped to the app-data
      dir). It NEVER kills a pre-existing postgres, so a live dev environment's
      cluster is not collateral damage.
    * Exits non-zero on a crash, an open port under -RequireClosed, the bridge
      log line under -RequireClosed, or leftover orphans.

  Windows-only (Win32 process enumeration). PowerShell 5.1-safe.

  Exit codes:
    0  PASS
    1  assertion failure (app exited / open port / bridge log line / probe error)
    2  refused precondition (debug exe, missing exe, bad args, stale listener)
    3  teardown left orphans (assertions may also have failed; FAILURE= lines say so)

.PARAMETER Exe
  Path to the built GUI app executable (the release `fredo.exe`), NOT the
  installer. A `\debug\` path is refused.

.PARAMETER Ports
  Comma-separated TCP ports to probe, e.g. `16932,9223`.

.PARAMETER McpPort
  The port exported as FREDO_MCP_BASE_PORT. Default: the first -Ports value, so a
  release build that wrongly registered the bridge WOULD target a probed port.

.PARAMETER RequireClosed
  Fail (exit 1) when any probed port is open or the bridge log line appears.
  This is the mode for the release webview-security AC.

.PARAMETER WaitSecs
  Bounded observation window, seconds. Default 40. Clamped to 1..300.

.PARAMETER DataDir
  Optional FREDO_DATA_DIR for the launched process. Isolates its PostgreSQL
  cluster and scopes teardown. Default: inherit the caller's FREDO_DATA_DIR,
  else the OS app-data dir.

.PARAMETER LogDir
  Directory for the captured stdout/stderr. Default:
  `.opencode/tmp/launch-artifact-probe/<timestamp>-<id>`.

.EXAMPLE
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe apps\tauri\src-tauri\target\release\fredo.exe -Ports 16932,9223 -RequireClosed

.EXAMPLE
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe .\fredo.exe -Ports 16932 -McpPort 16932 -WaitSecs 20 -DataDir .opencode\tmp\probe-data
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][int[]]$Ports,
  [int]$McpPort = 0,
  [switch]$RequireClosed,
  [int]$WaitSecs = 40,
  [string]$DataDir = '',
  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'

function Write-Probe {
  param([string]$Line)
  Write-Output $Line
}

# ---- Resolve / validate inputs ------------------------------------------------
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

if ($null -eq $Ports -or $Ports.Count -eq 0) {
  Write-Probe 'ERROR: -Ports must name at least one TCP port.'
  Write-Probe 'RESULT=REFUSED'
  exit 2
}

$seen = @{}
$probePorts = @()
foreach ($port in $Ports) {
  if ($port -lt 1 -or $port -gt 65535) {
    Write-Probe "ERROR: port out of range: $port"
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }
  if (-not $seen.ContainsKey($port)) {
    $seen[$port] = $true
    $probePorts += [int]$port
  }
}

if ($WaitSecs -lt 1 -or $WaitSecs -gt 300) {
  Write-Probe "ERROR: -WaitSecs must be 1..300 (got $WaitSecs)."
  Write-Probe 'RESULT=REFUSED'
  exit 2
}

if (-not (Test-Path -LiteralPath $Exe)) {
  Write-Probe "ERROR: missing exe: $Exe"
  Write-Probe 'RESULT=REFUSED'
  exit 2
}

$exePath = (Resolve-Path -LiteralPath $Exe).Path
$exeNormalized = $exePath.ToLowerInvariant().Replace('/', '\')
if ($exeNormalized.Contains('\debug\')) {
  Write-Probe "ERROR: refusing a debug artifact (a production/negative AC must use the release build): $exePath"
  Write-Probe 'RESULT=REFUSED'
  exit 2
}

if ($McpPort -eq 0) { $McpPort = $probePorts[0] }
if ($McpPort -lt 1 -or $McpPort -gt 65535) {
  Write-Probe "ERROR: -McpPort out of range: $McpPort"
  Write-Probe 'RESULT=REFUSED'
  exit 2
}

# ---- Log directory ------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $LogDir = Join-Path $repoRoot ".opencode\tmp\launch-artifact-probe\$stamp-$suffix"
} else {
  $LogDir = [System.IO.Path]::GetFullPath($LogDir)
}
try {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
} catch {
  Write-Probe "ERROR: cannot create log dir ${LogDir}: $($_.Exception.Message)"
  Write-Probe 'RESULT=REFUSED'
  exit 2
}
$stdoutPath = Join-Path $LogDir 'stdout.log'
$stderrPath = Join-Path $LogDir 'stderr.log'

# ---- Process / port helpers ---------------------------------------------------
function Test-TcpPortOpen {
  param([int]$Port, [int]$TimeoutMs = 600)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch {}
  }
}

function Get-AllProcesses {
  try {
    return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    return @()
  }
}

function Get-DescendantPids {
  param([int]$RootPid)
  $all = Get-AllProcesses
  $children = @{}
  foreach ($proc in $all) {
    $ppid = [int]$proc.ParentProcessId
    if (-not $children.ContainsKey($ppid)) {
      $children[$ppid] = New-Object System.Collections.ArrayList
    }
    [void]$children[$ppid].Add([int]$proc.ProcessId)
  }
  $result = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $current = [int]$queue.Dequeue()
    if ($children.ContainsKey($current)) {
      foreach ($child in $children[$current]) {
        [void]$result.Add($child)
        $queue.Enqueue($child)
      }
    }
  }
  return @($result)
}

function Get-PostgresPids {
  try {
    return @(Get-Process -Name 'postgres' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
  } catch {
    return @()
  }
}

function Read-LogHits {
  param([string[]]$Files, [string]$Pattern, [int]$Attempts = 10)
  $total = 0
  $complete = $true
  foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $ok = $false
    for ($i = 0; $i -lt $Attempts; $i++) {
      try {
        $total += @(Select-String -LiteralPath $file -Pattern $Pattern -SimpleMatch -ErrorAction Stop).Count
        $ok = $true
        break
      } catch {
        Start-Sleep -Milliseconds 200
      }
    }
    if (-not $ok) { $complete = $false }
  }
  return @{ Hits = $total; Complete = $complete }
}

# ---- Preconditions: no stale listener may be attributed to this launch -------
foreach ($port in $probePorts) {
  $open = Test-TcpPortOpen -Port $port
  Write-Probe ("PRECHECK_PORT_{0}={1}" -f $port, $(if ($open) { 'open' } else { 'closed' }))
  if ($open) {
    Write-Probe "ERROR: port $port is already open -- a stale app or dev instance owns it; stop the owner and re-run. The probe will not attribute a pre-existing listener to this launch."
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }
}

$exeItem = Get-Item -LiteralPath $exePath
Write-Probe 'PROBE=launch-artifact'
Write-Probe "EXE=$exePath"
Write-Probe "EXE_SIZE_BYTES=$($exeItem.Length)"
Write-Probe "EXE_LAST_WRITE_UTC=$($exeItem.LastWriteTimeUtc.ToString('o'))"
Write-Probe "MCP_PORT=$McpPort"
Write-Probe "WAIT_SECONDS=$WaitSecs"

# ---- Environment --------------------------------------------------------------
$env:FREDO_MCP_BASE_PORT = "$McpPort"
if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
  $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
  try {
    New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
  } catch {
    Write-Probe "ERROR: cannot create -DataDir ${resolvedDataDir}: $($_.Exception.Message)"
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }
  $env:FREDO_DATA_DIR = $resolvedDataDir
}
if (-not [string]::IsNullOrWhiteSpace($env:FREDO_DATA_DIR)) {
  $appDataDir = $env:FREDO_DATA_DIR
} elseif (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  $appDataDir = Join-Path $env:APPDATA 'com.fredo.app'
} else {
  $appDataDir = ''
}
Write-Probe "APP_DATA_DIR=$appDataDir"

$pgMatchDirs = @()
if (-not [string]::IsNullOrWhiteSpace($appDataDir)) { $pgMatchDirs += $appDataDir.ToLowerInvariant() }
if (-not [string]::IsNullOrWhiteSpace($env:FREDO_PG_DATA_DIR)) { $pgMatchDirs += $env:FREDO_PG_DATA_DIR.ToLowerInvariant() }

$beforePg = Get-PostgresPids

# ---- Launch + bounded observation --------------------------------------------
$p = $null
$launchError = $null
$appExited = $false
$appExitCode = $null
$elapsedSeconds = 0.0
$portState = @{}
$bridgeHits = 0
$logComplete = $false
$descendants = @()
$targetPg = @()
$descendantsKilled = 0
$postgresKilled = 0

try {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $p = Start-Process -FilePath $exePath -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  } catch {
    $launchError = "launch failed: $($_.Exception.Message)"
    throw
  }
  Write-Probe "PID=$($p.Id)"

  $deadline = (Get-Date).AddSeconds($WaitSecs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) {
      $appExited = $true
      break
    }
  }
  $elapsedSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1)
  if ($appExited) { $appExitCode = $p.ExitCode }

  foreach ($port in $probePorts) {
    $portState[$port] = Test-TcpPortOpen -Port $port
  }

  $descendants = @(Get-DescendantPids -RootPid $p.Id)

  $firstRead = Read-LogHits -Files @($stdoutPath, $stderrPath) -Pattern 'WebSocket server listening'
  $bridgeHits = [int]$firstRead.Hits
  $logComplete = [bool]$firstRead.Complete
} catch {
  if ($null -eq $p) {
    $launchError = "launch failed: $($_.Exception.Message)"
  } else {
    $launchError = "probe error: $($_.Exception.Message)"
  }
} finally {
  if ($null -ne $p) {
    # 1) Kill the app's descendant tree, deepest first, before the parent dies
    #    (a reparented child would otherwise escape the tree).
    [array]::Reverse($descendants)
    foreach ($childPid in $descendants) {
      try {
        Stop-Process -Id $childPid -Force -ErrorAction Stop
        $descendantsKilled++
      } catch {}
    }

    # 2) Kill ONLY postgres processes that appeared during this launch window
    #    and belong to this app-data dir. A pre-existing cluster (a live dev
    #    environment) is never touched.
    $afterPg = Get-PostgresPids
    $newPg = @($afterPg | Where-Object { $beforePg -notcontains $_ })
    foreach ($pgPid in $newPg) {
      $commandLine = $null
      try {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$pgPid" -ErrorAction SilentlyContinue
        if ($null -ne $cim) { $commandLine = $cim.CommandLine }
      } catch {}
      $attributable = $true
      if ($pgMatchDirs.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($commandLine)) {
        $attributable = $false
        foreach ($dir in $pgMatchDirs) {
          if ($commandLine.ToLowerInvariant().Contains($dir)) { $attributable = $true; break }
        }
      }
      if ($attributable) {
        try {
          Stop-Process -Id $pgPid -Force -ErrorAction Stop
          $postgresKilled++
          $targetPg += [int]$pgPid
        } catch {
          $targetPg += [int]$pgPid
        }
      }
    }

    # 3) Stop the app itself.
    if (-not $p.HasExited) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    $exitDeadline = (Get-Date).AddSeconds(5)
    while (-not $p.HasExited -and (Get-Date) -lt $exitDeadline) {
      Start-Sleep -Milliseconds 200
    }
  }
}

if ($null -eq $p) {
  Write-Probe "ERROR: $launchError"
  Write-Probe 'RESULT=REFUSED'
  exit 2
}

# ---- Post-teardown evidence ---------------------------------------------------
$secondRead = Read-LogHits -Files @($stdoutPath, $stderrPath) -Pattern 'WebSocket server listening'
if ([int]$secondRead.Hits -gt $bridgeHits) { $bridgeHits = [int]$secondRead.Hits }
$logComplete = $logComplete -and [bool]$secondRead.Complete

$stdoutBytes = 0
$stderrBytes = 0
try { $stdoutBytes = (Get-Item -LiteralPath $stdoutPath -ErrorAction SilentlyContinue).Length } catch {}
try { $stderrBytes = (Get-Item -LiteralPath $stderrPath -ErrorAction SilentlyContinue).Length } catch {}

$appAlive = -not $p.HasExited
$orphanDescendants = @()
foreach ($childPid in $descendants) {
  try {
    if ($null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) { $orphanDescendants += [int]$childPid }
  } catch {}
}
$orphanPostgres = @()
foreach ($pgPid in $targetPg) {
  try {
    if ($null -ne (Get-Process -Id $pgPid -ErrorAction SilentlyContinue)) { $orphanPostgres += [int]$pgPid }
  } catch {}
}
$orphans = $orphanPostgres.Count + $orphanDescendants.Count
if ($appAlive) { $orphans++ }

# ---- Assertions ---------------------------------------------------------------
$failures = New-Object System.Collections.ArrayList
if ($null -ne $launchError) { [void]$failures.Add("probe-error: $launchError") }
if ($appExited) { [void]$failures.Add('app-exited') }
if ($RequireClosed) {
  foreach ($port in $probePorts) {
    if ($portState[$port]) { [void]$failures.Add("port-open:$port") }
  }
  if ($bridgeHits -gt 0) { [void]$failures.Add('bridge-log-line') }
}

# ---- Report -------------------------------------------------------------------
Write-Probe "ELAPSED_SECONDS=$elapsedSeconds"
Write-Probe "HAS_EXITED=$appExited"
if ($null -ne $appExitCode) { Write-Probe "EXIT_CODE=$appExitCode" }
foreach ($port in $probePorts) {
  Write-Probe ("PORT_{0}={1}" -f $port, $(if ($portState[$port]) { 'open' } else { 'closed' }))
}
Write-Probe "BRIDGE_LOG_HITS=$bridgeHits"
Write-Probe "LOG_READ_COMPLETE=$logComplete"
Write-Probe "STDOUT=$stdoutPath"
Write-Probe "STDERR=$stderrPath"
Write-Probe "STDOUT_BYTES=$stdoutBytes"
Write-Probe "STDERR_BYTES=$stderrBytes"
Write-Probe "DESCENDANTS_KILLED=$descendantsKilled"
Write-Probe "POSTGRES_KILLED=$postgresKilled"
Write-Probe "ORPHANS_LEFT=$orphans"
if ($orphanPostgres.Count -gt 0) { Write-Probe "ORPHAN_POSTGRES_PIDS=$($orphanPostgres -join ',')" }
if ($orphanDescendants.Count -gt 0) { Write-Probe "ORPHAN_DESCENDANT_PIDS=$($orphanDescendants -join ',')" }
foreach ($failure in $failures) { Write-Probe "FAILURE=$failure" }

if ($failures.Count -gt 0) {
  Write-Probe 'RESULT=FAIL'
  exit 1
}
if ($orphans -gt 0) {
  Write-Probe 'RESULT=FAIL'
  exit 3
}
Write-Probe 'RESULT=PASS'
exit 0
