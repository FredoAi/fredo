<#
.SYNOPSIS
  Read-only lifecycle probe for the resident-shell suite (issue #3192).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). Enumerates the process / PID / port facts the
  resident-shell rows need, scoped to ONE isolated environment via its process manifest. Read-only:
  no mutations, no kills, no P/Invoke, no network I/O.

  MANIFEST KEYS come ONLY from `manifest-facts.ps1` (dot-sourced next to this file; shipped names
  `envId`, `servedCommit`, `dataDir`, `pipe`, `webviewProfile`, `ports.*`, `processes[]`). No key
  name is spelled in this script.

  THE PG DIR IS THE CLUSTER DIR, NOT THE APP-DATA DIR. `PG_DATA_DIR` is `<manifest parent>/postgres`
  (`dev-env.ps1:733,1535,1553`; product `pg_supervisor/state.rs:113-116`) or the `-PgDataDir`
  override - normally the product's `pg_supervisor_status.dataDir`. Postmasters are matched against
  THAT directory. When the probed directory is absent the probe prints
  `ERROR: probed PG data dir does not exist: <path>` and EXITS 2, because a zero from a predicate
  that matched nothing is not a postmaster count (the #3192 round-1 vacuous pass).

  `PG_PORT=unrecorded` is deliberate: `ports.pg` is written as a constant 0 (`dev-env.ps1:584`), so
  the live PG port is only knowable from `pg_supervisor_status.port`. Never probe port 0 and call it
  "closed" - `-Action Port` refuses a non-positive `-PortNumber` for that reason.

  Modes (-Action):
    Inventory    Env summary + app PID (alive? started?) + every fredo process + the postmasters
                 that belong to this env + the app's msedgewebview2 descendant count + working set.
    App          APP_PID / APP_ALIVE / APP_STARTED only.
    WebviewCount WEBVIEW_COUNT = msedgewebview2(.exe) descendants of the app PID.
    Postmaster   POSTMASTER_PIDS for this env (postgres.exe whose command line references the
                 cluster dir, minus the `forkchild` children PostgreSQL spawns on Windows).
    Descendants  Descendant process list for -TargetPid (orphan / PTY-child checks).
    Port         Listener owner PID(s) for -PortNumber.

  Facts printed by every action: ENV_ID, CLI_PIPE, DATA_DIR (app-data), PG_DATA_DIR,
  PG_DATA_DIR_SOURCE=manifest|product, PG_DATA_DIR_EXISTS, SERVED_COMMIT, PORTS (pg deliberately
  absent), PG_PORT=unrecorded. The postmaster actions add POSTGRES_TREE_COUNT (every postgres.exe
  referencing the cluster dir, children included), POSTGRES_CHILD_PIDS (the excluded `forkchild`
  processes), POSTMASTER_COUNT / POSTMASTER_PIDS / POSTMASTER=..., the `postmaster.pid` cross-check
  (PG_POSTMASTER_PIDFILE_PID / PG_POSTMASTER_PIDFILE_MATCH) and PG_DATA_DIR_USED.

  NON-VACUITY CONTROL: while the cluster is up, `POSTMASTER_COUNT` must be at least 1 and
  `PG_POSTMASTER_PIDFILE_MATCH=True`. The probe HARD-FAILS (exit 2) when `postmaster.pid` names a
  LIVE postgres PID that the predicate did not return - that combination means the instrument is
  wrong, and reading it as "no postmaster" would be the same vacuous pass this guard prevents.

  A process whose CommandLine is unreadable (owned by another / an elevated user) is invisible to
  this probe; run it as the user that owns the env, exactly as `dev-env.ps1` launched it.

  Every value is printed as a `KEY=value` line so a verdict can quote it verbatim.

  PROXIES: WEBVIEW_COUNT and APP_WORKINGSET_MB corroborate "the webview was destroyed, not hidden".
  They are PROCESS-OBSERVABLE PROXIES for released JS heap - there is no memory profiler here and
  none is claimed. The structural proof is the window list (a destroyed window is absent; a hidden
  window is still listed).

.EXAMPLE
  powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Inventory -ManifestPath .opencode/tmp/envs/spec3192/manifest.json

.EXAMPLE
  powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Postmaster -PgDataDir C:\Code\fredo\.opencode\tmp\envs\spec3192\postgres

  Exit codes: 0 success; 2 usage / manifest read failure / probed PG data dir absent /
  postmaster cross-check failed; 3 process enumeration failure.
#>
param(
  [ValidateSet("Inventory", "App", "WebviewCount", "Postmaster", "Descendants", "Port")]
  [string]$Action = "Inventory",
  [string]$ManifestPath = "",
  [string]$PgDataDir = "",
  [int]$TargetPid = 0,
  [int]$PortNumber = 0
)

$ErrorActionPreference = "Stop"

function Write-Fail {
  param([string]$Message)
  Write-Output ("ERROR: " + $Message)
  exit 2
}

$factsScript = Join-Path $PSScriptRoot "manifest-facts.ps1"
if (-not (Test-Path -LiteralPath $factsScript)) {
  Write-Fail ("shared manifest reader not found: " + $factsScript)
}
. $factsScript

function Read-ManifestOrFail {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { Write-Fail ("manifest not found: " + $Path) }
  $parsed = Read-ManifestFile -Path $Path
  if ($null -eq $parsed) { Write-Fail ("manifest is not valid JSON: " + $Path) }
  return $parsed
}

function Format-Creation {
  param($Proc)
  if ($null -eq $Proc.CreationDate) { return "(unknown)" }
  try { return ([datetime]$Proc.CreationDate).ToString("yyyy-MM-dd HH:mm:ss") } catch { return "(unknown)" }
}

function Format-CommandLine {
  param($Proc)
  $text = [string]$Proc.CommandLine
  if ([string]::IsNullOrEmpty($text)) { return "(none)" }
  if ($text.Length -gt 160) { return $text.Substring(0, 160) + "..." }
  return $text
}

# ---- Enumerate once -----------------------------------------------------------
$manifest = Read-ManifestOrFail -Path $ManifestPath
$pgFacts = Resolve-PgDataDir -ManifestPath $ManifestPath -PgDataDir $PgDataDir

try {
  $procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
} catch {
  Write-Output ("ERROR: process enumeration failed: " + $_.Exception.Message)
  exit 3
}

$byPid = @{}
foreach ($proc in $procs) { $byPid[[int]$proc.ProcessId] = $proc }

$childrenOf = @{}
foreach ($proc in $procs) {
  $parentPid = [int]$proc.ParentProcessId
  if (-not $childrenOf.ContainsKey($parentPid)) {
    $childrenOf[$parentPid] = New-Object 'System.Collections.Generic.HashSet[int]'
  }
  [void]$childrenOf[$parentPid].Add([int]$proc.ProcessId)
}

function Get-DescendantPids {
  param([int]$RootPid)
  $result = New-Object 'System.Collections.Generic.List[int]'
  if (-not $childrenOf.ContainsKey($RootPid)) { return $result }
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if (-not $childrenOf.ContainsKey($current)) { continue }
    foreach ($childPid in $childrenOf[$current]) {
      $result.Add($childPid)
      $queue.Enqueue($childPid)
    }
  }
  return $result
}

$dataDir = Get-ManifestDataDir -Manifest $manifest
$appPid = Get-ManifestAppPid -Manifest $manifest

function Test-PidAlive {
  param([int]$CheckPid)
  if ($CheckPid -le 0) { return $false }
  return $byPid.ContainsKey($CheckPid)
}

# The postmaster rows are meaningless without a real cluster dir: fail closed, never a confident 0.
function Assert-PgDataDirUsable {
  param($Facts)
  if ([string]::IsNullOrWhiteSpace($Facts.Path)) {
    Write-Fail "cannot resolve the PG cluster dir: pass -ManifestPath (the env manifest) or -PgDataDir"
  }
  if (-not $Facts.Exists) {
    Write-Fail ("probed PG data dir does not exist: " + $Facts.Path + " (source=" + $Facts.Source + ") - pass -PgDataDir with pg_supervisor_status.dataDir; a zero from a predicate that matched nothing is NOT a postmaster count")
  }
}

# Every postgres.exe referencing the cluster dir (children included). Local is named `$found`, never
# `$matches`: PowerShell rewrites the automatic `$matches` on the next -match/-notmatch, so a
# `$matches.Add(...)` after a match test throws (the round-1 `Cannot find an overload for "Add"`).
function Get-PostgresTreeProcs {
  return @(Get-PostgresProcList -Procs $procs -PgDataDir $pgFacts.Path)
}

function Get-FredoProcList {
  $found = @()
  foreach ($proc in $procs) {
    $name = [string]$proc.Name
    if ($name -match '^fredo(\.exe)?$') { $found += $proc }
  }
  return $found
}

function Write-EnvSummary {
  Write-Output ("ENV_ID=" + (Get-ManifestEnvId -Manifest $manifest))
  Write-Output ("CLI_PIPE=" + (Get-ManifestPipe -Manifest $manifest))
  Write-Output ("DATA_DIR=" + $dataDir)
  Write-Output ("PG_DATA_DIR=" + $pgFacts.Path)
  Write-Output ("PG_DATA_DIR_SOURCE=" + $pgFacts.Source)
  Write-Output ("PG_DATA_DIR_EXISTS=" + $pgFacts.Exists)
  Write-Output ("SERVED_COMMIT=" + (Get-ManifestServedCommit -Manifest $manifest))
  Write-Output ("PORTS=mcp=" + (Get-ManifestPort -Manifest $manifest -Name "mcp") +
    ";otlpGrpc=" + (Get-ManifestPort -Manifest $manifest -Name "otlpGrpc") +
    ";otlpHttp=" + (Get-ManifestPort -Manifest $manifest -Name "otlpHttp") +
    ";vite=" + (Get-ManifestPort -Manifest $manifest -Name "vite"))
  # ports.pg is a constant 0 in the manifest (dev-env.ps1:584). Label it; never emit a port number,
  # so no row can probe port 0 and report it "closed".
  Write-Output "PG_PORT=unrecorded"
  Write-Output "PG_PORT_SOURCE=pg_supervisor_status.port (manifest ports.pg is a constant 0)"
}

function Write-AppFacts {
  Write-Output ("APP_PID=" + $appPid)
  Write-Output ("APP_ALIVE=" + (Test-PidAlive -CheckPid $appPid))
  if (Test-PidAlive -CheckPid $appPid) {
    $appProc = $byPid[$appPid]
    Write-Output ("APP_STARTED=" + (Format-Creation -Proc $appProc))
    Write-Output ("APP_IMAGE=" + [string]$appProc.Name)
    $workingSetBytes = 0
    try { $workingSetBytes = [double]$appProc.WorkingSetSize } catch { $workingSetBytes = 0 }
    $workingSetMb = [math]::Round($workingSetBytes / 1MB, 1)
    Write-Output ("APP_WORKINGSET_MB=" + $workingSetMb)
  }
}

function Write-WebviewCount {
  $count = 0
  if (Test-PidAlive -CheckPid $appPid) {
    foreach ($descendantPid in (Get-DescendantPids -RootPid $appPid)) {
      if (-not $byPid.ContainsKey([int]$descendantPid)) { continue }
      $name = [string]$byPid[[int]$descendantPid].Name
      if ($name -match '^msedgewebview2(\.exe)?$') { $count++ }
    }
  }
  Write-Output ("WEBVIEW_COUNT=" + $count)
  Write-Output ("WEBVIEW_PROXY=True")
}

function Write-PostmasterFacts {
  $tree = @(Get-PostgresTreeProcs)
  $masters = @(Get-PostmasterProcList -Procs $procs -PgDataDir $pgFacts.Path)

  $masterPids = @()
  foreach ($proc in $masters) { $masterPids += [int]$proc.ProcessId }
  $masterPidText = @()
  foreach ($pidValue in $masterPids) { $masterPidText += [string]$pidValue }

  $childPidText = @()
  foreach ($proc in $tree) {
    if (Test-PostgresChildProc -Proc $proc) { $childPidText += ([string][int]$proc.ProcessId) }
  }

  Write-Output ("PG_DATA_DIR_USED=" + $pgFacts.Path)
  Write-Output ("POSTGRES_TREE_COUNT=" + $tree.Count)
  Write-Output ("POSTGRES_TREE_PIDS=" + ((@($tree) | ForEach-Object { [string][int]$_.ProcessId }) -join ","))
  Write-Output ("POSTGRES_CHILD_PIDS=" + ($childPidText -join ","))
  Write-Output ("POSTMASTER_COUNT=" + $masterPids.Count)
  Write-Output ("POSTMASTER_PIDS=" + ($masterPidText -join ","))
  foreach ($proc in $masters) {
    Write-Output ("POSTMASTER=pid=" + [int]$proc.ProcessId + " ppid=" + [int]$proc.ParentProcessId +
      " started=" + (Format-Creation -Proc $proc))
  }

  # `postmaster.pid` (first line = postmaster PID) is the independent control that catches a
  # predicate which silently matches nothing: if it names a LIVE postgres.exe that the predicate did
  # not return, the instrument is wrong and the reading must not be reported as a count.
  $pidFile = Join-Path $pgFacts.Path "postmaster.pid"
  $pidFilePid = 0
  $pidFileExists = $false
  try { $pidFileExists = Test-Path -LiteralPath $pidFile } catch { $pidFileExists = $false }
  if ($pidFileExists) {
    try {
      $firstLine = Get-Content -LiteralPath $pidFile -TotalCount 1
      if ($null -ne $firstLine) {
        $firstText = ([string]$firstLine).Trim()
        if ($firstText -ne "") { $pidFilePid = [int]$firstText }
      }
    } catch {
      $pidFilePid = 0
    }
  }
  Write-Output ("PG_POSTMASTER_PIDFILE_EXISTS=" + $pidFileExists)
  Write-Output ("PG_POSTMASTER_PIDFILE_PID=" + $pidFilePid)
  $pidFileMatch = "n/a"
  if ($pidFilePid -gt 0) {
    if ($masterPids -contains $pidFilePid) { $pidFileMatch = "True" } else { $pidFileMatch = "False" }
  }
  Write-Output ("PG_POSTMASTER_PIDFILE_MATCH=" + $pidFileMatch)

  $pidFileIsLivePostgres = $false
  if (Test-PidAlive -CheckPid $pidFilePid) {
    $pidFileProc = $byPid[$pidFilePid]
    if ([string]$pidFileProc.Name -match '^postgres(\.exe)?$') { $pidFileIsLivePostgres = $true }
  }
  if ($pidFileIsLivePostgres -and -not ($masterPids -contains $pidFilePid)) {
    Write-Fail ("probed postmaster set does not contain the LIVE postmaster.pid PID " + $pidFilePid + " (" + $pidFile + ") - either the postmaster predicate against " + $pgFacts.Path + " missed it, or that process's CommandLine is unreadable (run the probe as the app's owner); do not read this run as 'no postmaster'")
  }
}

function Write-PortFacts {
  param([int]$Port)
  Write-Output ("PORT=" + $Port)
  $owners = @()
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    foreach ($connection in $connections) { $owners += [int]$connection.OwningProcess }
  } catch {
    Write-Output "PORT_QUERY_UNAVAILABLE=1"
  }
  $owners = @($owners | Sort-Object -Unique)
  Write-Output ("PORT_LISTENER_PIDS=" + ($owners -join ","))
  foreach ($ownerPid in $owners) {
    $ownerName = "(unknown)"
    if ($byPid.ContainsKey([int]$ownerPid)) { $ownerName = [string]$byPid[[int]$ownerPid].Name }
    Write-Output ("PORT_LISTENER=pid=" + $ownerPid + " name=" + $ownerName)
  }
}

function Write-DescendantFacts {
  param([int]$RootPid)
  Write-Output ("ROOT_PID=" + $RootPid)
  Write-Output ("ROOT_ALIVE=" + (Test-PidAlive -CheckPid $RootPid))
  $descendantPids = Get-DescendantPids -RootPid $RootPid
  Write-Output ("DESCENDANT_COUNT=" + $descendantPids.Count)
  foreach ($descendantPid in $descendantPids) {
    if (-not $byPid.ContainsKey([int]$descendantPid)) { continue }
    $proc = $byPid[[int]$descendantPid]
    Write-Output ("DESCENDANT=pid=" + [int]$proc.ProcessId + " ppid=" + [int]$proc.ParentProcessId +
      " name=" + [string]$proc.Name + " started=" + (Format-Creation -Proc $proc))
  }
}

switch ($Action) {
  "App" {
    Write-Output "ACTION=App"
    Write-EnvSummary
    Write-AppFacts
  }
  "WebviewCount" {
    Write-Output "ACTION=WebviewCount"
    Write-EnvSummary
    Write-AppFacts
    Write-WebviewCount
  }
  "Postmaster" {
    Assert-PgDataDirUsable -Facts $pgFacts
    Write-Output "ACTION=Postmaster"
    Write-EnvSummary
    Write-PostmasterFacts
    if ($PortNumber -gt 0) { Write-PortFacts -Port $PortNumber }
  }
  "Port" {
    Assert-PgDataDirUsable -Facts $pgFacts
    if ($PortNumber -le 0) {
      Write-Fail "Port needs a positive -PortNumber; manifest ports.pg is a constant 0 - read the live PG port from pg_supervisor_status.port"
    }
    Write-Output "ACTION=Port"
    Write-EnvSummary
    Write-PortFacts -Port $PortNumber
    Write-PostmasterFacts
  }
  "Descendants" {
    Write-Output "ACTION=Descendants"
    Write-EnvSummary
    Write-AppFacts
    $rootPid = $TargetPid
    if ($rootPid -le 0) { $rootPid = $appPid }
    Write-DescendantFacts -RootPid $rootPid
  }
  default {
    Assert-PgDataDirUsable -Facts $pgFacts
    Write-Output "ACTION=Inventory"
    Write-EnvSummary
    Write-AppFacts
    Write-WebviewCount
    Write-PostmasterFacts
    $fredoProcs = @(Get-FredoProcList)
    Write-Output ("FREDO_PROCS=" + $fredoProcs.Count)
    foreach ($proc in $fredoProcs) {
      Write-Output ("FREDO_PROC=pid=" + [int]$proc.ProcessId + " ppid=" + [int]$proc.ParentProcessId +
        " started=" + (Format-Creation -Proc $proc) + " cmd=" + (Format-CommandLine -Proc $proc))
    }
  }
}

Write-Output "RESULT=OK"
exit 0
