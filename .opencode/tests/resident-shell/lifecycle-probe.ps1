<#
.SYNOPSIS
  Read-only lifecycle probe for the resident-shell suite (issue #3192).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). Enumerates the process / PID / port facts the
  resident-shell rows need, scoped to ONE isolated environment via its process manifest. Read-only:
  no mutations, no kills, no P/Invoke, no network I/O.

  Modes (-Action):
    Inventory    Env summary + app PID (alive? started?) + every fredo process + postmasters that
                 belong to this env + the app's msedgewebview2 descendant count + working set.
    App          APP_PID / APP_ALIVE / APP_STARTED only.
    WebviewCount WEBVIEW_COUNT = msedgewebview2(.exe) descendants of the app PID.
    Postmaster   POSTMASTER_PIDS for this env (command line references the env data dir).
    Descendants  Descendant process list for -TargetPid (orphan / PTY-child checks).
    Port         Listener owner PID(s) for -PortNumber.

  Every value is printed as a `KEY=value` line so a verdict can quote it verbatim.

  PROXIES: WEBVIEW_COUNT and APP_WORKINGSET_MB corroborate "the webview was destroyed, not hidden".
  They are PROCESS-OBSERVABLE PROXIES for released JS heap - there is no memory profiler here and
  none is claimed. The structural proof is the window list (a destroyed window is absent; a hidden
  window is still listed).

.EXAMPLE
  powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Inventory -ManifestPath .opencode/tmp/envs/spec3192/manifest.json

.EXAMPLE
  powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Port -PortNumber 16002

  Exit codes: 0 success; 2 usage / manifest read failure; 3 process enumeration failure.
#>
param(
  [ValidateSet("Inventory", "App", "WebviewCount", "Postmaster", "Descendants", "Port")]
  [string]$Action = "Inventory",
  [string]$ManifestPath = "",
  [int]$TargetPid = 0,
  [int]$PortNumber = 0
)

$ErrorActionPreference = "Stop"

function Write-Fail {
  param([string]$Message)
  Write-Output ("ERROR: " + $Message)
  exit 2
}

function Read-Manifest {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { Write-Fail ("manifest not found: " + $Path) }
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    Write-Fail ("manifest is not valid JSON: " + $Path)
  }
}

function Get-ManifestText {
  param($Manifest, [string]$Name)
  if ($null -eq $Manifest) { return "" }
  $prop = $Manifest.PSObject.Properties[$Name]
  if ($null -eq $prop -or $null -eq $prop.Value) { return "" }
  return [string]$prop.Value
}

function Get-ManifestPort {
  param($Manifest, [string]$Name)
  if ($null -eq $Manifest -or $null -eq $Manifest.ports) { return 0 }
  $prop = $Manifest.ports.PSObject.Properties[$Name]
  if ($null -eq $prop -or -not $prop.Value) { return 0 }
  return [int]$prop.Value
}

function Get-ManifestAppPid {
  param($Manifest)
  if ($null -eq $Manifest -or $null -eq $Manifest.processes) { return 0 }
  foreach ($entry in @($Manifest.processes)) {
    if ($null -eq $entry) { continue }
    if ($null -ne $entry.role -and [string]$entry.role -eq "app" -and $entry.pid) {
      return [int]$entry.pid
    }
  }
  return 0
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
$manifest = Read-Manifest -Path $ManifestPath

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

$dataDir = Get-ManifestText -Manifest $manifest -Name "dataDir"
$appPid = Get-ManifestAppPid -Manifest $manifest

function Test-PidAlive {
  param([int]$CheckPid)
  if ($CheckPid -le 0) { return $false }
  return $byPid.ContainsKey($CheckPid)
}

function Get-PostmasterProcList {
  $matches = New-Object 'System.Collections.Generic.List[object]'
  if ([string]::IsNullOrWhiteSpace($dataDir)) { return $matches }
  foreach ($proc in $procs) {
    $name = [string]$proc.Name
    if ($name -notmatch '^postgres(\.exe)?$') { continue }
    $commandLine = [string]$proc.CommandLine
    if ($commandLine -and $commandLine.ToLowerInvariant().Contains($dataDir.ToLowerInvariant())) {
      $matches.Add($proc)
    }
  }
  return $matches
}

function Get-FredoProcList {
  $matches = New-Object 'System.Collections.Generic.List[object]'
  foreach ($proc in $procs) {
    $name = [string]$proc.Name
    if ($name -match '^fredo(\.exe)?$') { $matches.Add($proc) }
  }
  return $matches
}

function Write-EnvSummary {
  Write-Output ("ENV_ID=" + (Get-ManifestText -Manifest $manifest -Name "envId"))
  Write-Output ("CLI_PIPE=" + (Get-ManifestText -Manifest $manifest -Name "cliPipe"))
  Write-Output ("DATA_DIR=" + $dataDir)
  Write-Output ("SERVED_COMMIT=" + (Get-ManifestText -Manifest $manifest -Name "servedCommit"))
  Write-Output ("PORTS=pg=" + (Get-ManifestPort -Manifest $manifest -Name "pg") +
    ";mcp=" + (Get-ManifestPort -Manifest $manifest -Name "mcp") +
    ";otlpGrpc=" + (Get-ManifestPort -Manifest $manifest -Name "otlpGrpc") +
    ";otlpHttp=" + (Get-ManifestPort -Manifest $manifest -Name "otlpHttp") +
    ";vite=" + (Get-ManifestPort -Manifest $manifest -Name "vite"))
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
  $postmasters = Get-PostmasterProcList
  $pids = @()
  foreach ($proc in $postmasters) { $pids += ([string][int]$proc.ProcessId) }
  Write-Output ("POSTMASTER_COUNT=" + $pids.Count)
  Write-Output ("POSTMASTER_PIDS=" + ($pids -join ","))
  foreach ($proc in $postmasters) {
    Write-Output ("POSTMASTER=pid=" + [int]$proc.ProcessId + " ppid=" + [int]$proc.ParentProcessId +
      " started=" + (Format-Creation -Proc $proc))
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
    Write-Output "ACTION=Postmaster"
    Write-EnvSummary
    Write-PostmasterFacts
    if ($PortNumber -gt 0) { Write-PortFacts -Port $PortNumber }
  }
  "Port" {
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
    Write-Output "ACTION=Inventory"
    Write-EnvSummary
    Write-AppFacts
    Write-WebviewCount
    Write-PostmasterFacts
    $fredoProcs = Get-FredoProcList
    Write-Output ("FREDO_PROCS=" + $fredoProcs.Count)
    foreach ($proc in $fredoProcs) {
      Write-Output ("FREDO_PROC=pid=" + [int]$proc.ProcessId + " ppid=" + [int]$proc.ParentProcessId +
        " started=" + (Format-Creation -Proc $proc) + " cmd=" + (Format-CommandLine -Proc $proc))
    }
  }
}

Write-Output "RESULT=OK"
exit 0
