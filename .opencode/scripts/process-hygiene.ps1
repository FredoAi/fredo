<#
.SYNOPSIS
  Read-only process inventory (-List) and opt-in, narrowly scoped orphan
  cleanup (-KillOrphans) for leftover opencode / node processes around a
  Fredo dev or served instance.

.DESCRIPTION
  Pipeline tooling for live e2e hygiene (#2762 fix plan round 5, item D1).
  Prior rounds' kill paths (Run CLI close, dev-env Down) kill only the direct
  child; on Windows opencode resolves to a .cmd/.bat shim whose cmd.exe ->
  node.exe descendants can survive, hold locks in the fixture workdir, and
  block a fresh `opencode run` before its first byte.

  Modes (exactly one required):

    -List         Read-only inventory of every opencode/node/fredo process
                  (PID, PPID, creation time, CommandLine) plus the PIDs
                  owning the Fredo ports (9223 MCP bridge, 4317 OTLP gRPC,
                  4318 OTLP HTTP, 5174 Vite). Also flags orphan candidates.

    -KillOrphans  OPT-IN, single pass, narrowly scoped kill. A process is a
                  kill candidate only when ALL of the following hold:
                    1. Its name is opencode(.exe) or node(.exe).
                    2. It is in a DEAD tree: its parent PID is no longer
                       alive, or an ancestor's parent is no longer alive
                       (transitive closure), or its CommandLine references
                       the fixture workdir (\.serve\2762).
                  Protected (NEVER killed, printed as SKIP with the reason):
                    - the invoking shell's own ancestry and any descendant
                      of it (the tester's session tree);
                    - any process with a LIVE fredo.exe ancestor (the
                      current run's legitimate children, e.g. the active
                      Run CLI PTY);
                    - fredo.exe itself is never a candidate (name scope).
                  Every kill decision (KILL / SKIP / failure) is printed
                  with its reason, followed by a summary line.

  PowerShell 5.1-safe: Get-CimInstance Win32_Process (not Get-WmiObject),
  full cmdlet names, no aliases, ASCII-only output.

  Exit codes:
    0  success (inventory produced, or kill pass completed with no failures)
    1  kill pass completed but one or more kill attempts failed
    2  usage error (no mode specified, or both modes specified)
    3  process enumeration failure

.EXAMPLE
  powershell -File .opencode/scripts/process-hygiene.ps1 -List

.EXAMPLE
  powershell -File .opencode/scripts/process-hygiene.ps1 -KillOrphans
#>

param(
  [switch]$List,
  [switch]$KillOrphans
)

$ErrorActionPreference = "Stop"

function Write-Info {
  param([string]$Message, [string]$Color = "Gray")
  Write-Host $Message -ForegroundColor $Color
}

function Write-Fail {
  param([string]$Message)
  Write-Host "ERROR: $Message" -ForegroundColor Red
}

# ---- Mode gate ----------------------------------------------------------------
if (-not $List -and -not $KillOrphans) {
  Write-Fail "specify exactly one mode: -List (read-only inventory) or -KillOrphans (opt-in orphan cleanup)."
  exit 2
}
if ($List -and $KillOrphans) {
  Write-Fail "specify exactly one mode: -List and -KillOrphans are mutually exclusive."
  exit 2
}

# ---- Scope (fix plan #2762 round 5, item D1) ----------------------------------
$targetNamePattern = '^(opencode|node)(\.exe)?$'   # kill candidates: opencode/node only
$fredoNamePattern = '^fredo(\.exe)?$'              # fredo.exe: inventoried, never killed
$serveRefPattern = '\.serve\\2762'                 # fixture workdir reference in a CommandLine
$maxCommandLineChars = 160
$fredoPorts = @(
  @{ Port = 9223; Label = "MCP bridge" },
  @{ Port = 4317; Label = "OTLP gRPC" },
  @{ Port = 4318; Label = "OTLP HTTP" },
  @{ Port = 5174; Label = "Vite dev server" }
)

# ---- Enumerate processes once --------------------------------------------------
$procs = @()
try {
  $procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
} catch {
  Write-Fail "process enumeration via Get-CimInstance Win32_Process failed: $($_.Exception.Message)"
  exit 3
}

$byPid = @{}
foreach ($proc in $procs) {
  $byPid[[int]$proc.ProcessId] = $proc
}

function Get-AncestorPids {
  param([int]$StartPid)
  $chain = New-Object 'System.Collections.Generic.HashSet[int]'
  $current = $StartPid
  $steps = 0
  while ($steps -lt 64 -and $current -ne 0 -and $byPid.ContainsKey($current)) {
    [void]$chain.Add($current)
    $current = [int]$byPid[$current].ParentProcessId
    $steps++
  }
  return $chain
}

# The invoking powershell process and every live ancestor of it.
$ownAncestry = Get-AncestorPids -StartPid $PID

# Dead-tree closure: a process is in a dead tree when its parent PID is not
# alive, or when its parent is itself in a dead tree (orphaned descendants of
# orphaned shims are caught by iterating to a fixpoint).
$deadTree = @{}
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($proc in $procs) {
    $procPid = [int]$proc.ProcessId
    if ($deadTree.ContainsKey($procPid)) { continue }
    $parentPid = [int]$proc.ParentProcessId
    if ($parentPid -eq 0 -or -not $byPid.ContainsKey($parentPid) -or $deadTree.ContainsKey($parentPid)) {
      $deadTree[$procPid] = $true
      $changed = $true
    }
  }
}

# Pinned-port serving-tree protection. The live serving instance is ANY process
# owning a pinned port, plus all of its ancestors and descendants. A detached
# `pnpm dev:tauri` launcher exits right after spawning, so the whole serving
# tree reads as a "dead tree" by ancestry alone — and the Vite listener is a
# SIBLING of fredo.exe, not its descendant, so a fredo-ancestor check never
# covers it. Port ownership is the ground truth that a process belongs to the
# current run (#2762 round 7: the :5174 node owner was classified ORPHAN and
# killed, severing the webview mid-round). Stale port owners from a previous
# run are NOT hygiene's job — `dev-env.ps1 -Action Down` is the sanctioned
# clearing path; hygiene never kills port owners.
$childrenOf = @{}
foreach ($proc in $procs) {
  $pp = [int]$proc.ParentProcessId
  if (-not $childrenOf.ContainsKey($pp)) {
    $childrenOf[$pp] = New-Object 'System.Collections.Generic.HashSet[int]'
  }
  [void]$childrenOf[$pp].Add([int]$proc.ProcessId)
}
$protectedPids = @{}
foreach ($entry in $fredoPorts) {
  $port = [int]$entry.Port
  $conns = @()
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    Write-Info ("  port-owner protection unavailable for port {0} on this host ({1})" -f $port, $_.Exception.Message) "DarkGray"
    continue
  }
  foreach ($conn in $conns) {
    $ownerPid = [int]$conn.OwningProcess
    if ($ownerPid -le 0 -or -not $byPid.ContainsKey($ownerPid)) { continue }
    # owner + every live ancestor
    foreach ($ancPid in (Get-AncestorPids -StartPid $ownerPid)) {
      $protectedPids[$ancPid] = $true
    }
    # owner + every descendant (BFS over the children map)
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    $queue.Enqueue($ownerPid)
    while ($queue.Count -gt 0) {
      $curPid = $queue.Dequeue()
      $protectedPids[$curPid] = $true
      if ($childrenOf.ContainsKey($curPid)) {
        foreach ($childPid in $childrenOf[$curPid]) { $queue.Enqueue($childPid) }
      }
    }
  }
}

function Test-Protected {
  param($Proc)
  $procPid = [int]$Proc.ProcessId
  if ($protectedPids.ContainsKey($procPid)) {
    return "pinned-port serving tree (owns or shares the process tree of a live dev-instance port owner)"
  }
  if ($ownAncestry.Contains($procPid)) {
    return "own shell ancestry of the invoking process"
  }
  $ancestors = Get-AncestorPids -StartPid $procPid
  foreach ($ancestorPid in $ancestors) {
    if ($ownAncestry.Contains($ancestorPid)) {
      return "descendant of the invoking shell tree"
    }
  }
  foreach ($ancestorPid in $ancestors) {
    if ($ancestorPid -ne $procPid -and $byPid.ContainsKey($ancestorPid)) {
      $ancestorName = [string]$byPid[$ancestorPid].Name
      if ($ancestorName -match $fredoNamePattern) {
        return "live fredo.exe ancestor (pid $ancestorPid) -- belongs to the current run"
      }
    }
  }
  return $null
}

function Get-OrphanReason {
  param($Proc)
  $reasons = @()
  if ($deadTree.ContainsKey([int]$Proc.ProcessId)) {
    $reasons += "dead process tree (ancestral parent expired)"
  }
  $commandLine = [string]$Proc.CommandLine
  if ($commandLine -ne "" -and $commandLine -imatch $serveRefPattern) {
    $reasons += "CommandLine references .serve\2762"
  }
  return ($reasons -join "; ")
}

function Format-CommandLine {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return "(none)" }
  if ($Text.Length -gt $maxCommandLineChars) {
    return $Text.Substring(0, $maxCommandLineChars) + "..."
  }
  return $Text
}

function Format-Creation {
  param($Proc)
  if ($null -eq $Proc.CreationDate) { return "(unknown)" }
  return ([datetime]$Proc.CreationDate).ToString("yyyy-MM-dd HH:mm:ss")
}

function Show-PortOwners {
  Write-Info ""
  Write-Info "== Fredo port owners ==" "Cyan"
  foreach ($entry in $fredoPorts) {
    $port = [int]$entry.Port
    $label = [string]$entry.Label
    $ownerPids = @()
    try {
      $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
      foreach ($conn in $conns) {
        $ownerPids += [int]$conn.OwningProcess
      }
    } catch {
      Write-Info ("  port {0,5} ({1}): Get-NetTCPConnection unavailable on this host ({2})" -f $port, $label, $_.Exception.Message) "DarkGray"
      continue
    }
    $ownerPids = @($ownerPids | Sort-Object -Unique)
    if ($ownerPids.Count -eq 0) {
      Write-Info ("  port {0,5} ({1}): (no listener)" -f $port, $label) "DarkGray"
      continue
    }
    foreach ($ownerPid in $ownerPids) {
      $ownerName = "(unknown process)"
      $ownerCreated = "(unknown start time)"
      if ($byPid.ContainsKey($ownerPid)) {
        $ownerName = [string]$byPid[$ownerPid].Name
        $ownerCreated = Format-Creation $byPid[$ownerPid]
      }
      Write-Info ("  port {0,5} ({1}): pid {2} {3} (started {4})" -f $port, $label, $ownerPid, $ownerName, $ownerCreated) "White"
    }
  }
}

$script:relevantProcs = @()

function Show-Inventory {
  param([bool]$WithOrphanFlags)
  Write-Info ""
  Write-Info "== opencode / node / fredo processes ==" "Cyan"
  $script:relevantProcs = @(
    $procs | Where-Object {
      $name = [string]$_.Name
      ($name -match $targetNamePattern) -or ($name -match $fredoNamePattern)
    } | Sort-Object -Property ProcessId
  )
  if ($script:relevantProcs.Count -eq 0) {
    Write-Info "  (none found)" "DarkGray"
    return
  }
  foreach ($proc in $script:relevantProcs) {
    $procPid = [int]$proc.ProcessId
    $parentPid = [int]$proc.ParentProcessId
    $name = [string]$proc.Name
    $created = Format-Creation $proc
    $line = "  pid {0,-7} ppid {1,-7} started {2}  {3,-14} {4}" -f $procPid, $parentPid, $created, $name, (Format-CommandLine $proc.CommandLine)
    Write-Host $line
    if ($WithOrphanFlags -and $name -match $targetNamePattern) {
      $orphanReason = Get-OrphanReason $proc
      if ($orphanReason -ne "") {
        $protection = Test-Protected $proc
        if ($null -ne $protection) {
          Write-Host "      flag: ORPHAN-SCOPE but PROTECTED ($protection)" -ForegroundColor Yellow
        } else {
          Write-Host "      flag: ORPHAN ($orphanReason)" -ForegroundColor Yellow
        }
      }
    }
  }
}

# ---- Mode: -KillOrphans (opt-in, single pass) ----------------------------------
if ($KillOrphans) {
  Write-Info "process-hygiene: -KillOrphans (opt-in single pass) at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" "Cyan"
  Show-Inventory -WithOrphanFlags $true
  Show-PortOwners

  $orphansFound = 0
  $killed = 0
  $killFailures = 0
  $skipped = 0

  Write-Info ""
  Write-Info "== Kill decisions ==" "Cyan"

  foreach ($proc in $script:relevantProcs) {
    if (([string]$proc.Name) -notmatch $targetNamePattern) { continue }  # fredo.exe: never a candidate
    $orphanReason = Get-OrphanReason $proc
    if ($orphanReason -eq "") { continue }                               # healthy opencode/node: out of scope

    $procPid = [int]$proc.ProcessId
    $name = [string]$proc.Name
    $orphansFound++
    $protection = Test-Protected $proc

    if ($null -ne $protection) {
      $skipped++
      Write-Host ("  SKIP pid {0} ({1}): matches orphan scope ({2}) but protected -- {3}" -f $procPid, $name, $orphanReason, $protection) -ForegroundColor Yellow
      continue
    }

    Write-Host ("  KILL pid {0} ({1}): {2}" -f $procPid, $name, $orphanReason) -ForegroundColor Red
    try {
      Stop-Process -Id $procPid -Force -ErrorAction Stop
      $killed++
      Write-Host ("    killed pid {0}" -f $procPid) -ForegroundColor Green
    } catch {
      $killFailures++
      Write-Fail ("    kill FAILED for pid {0}: {1}" -f $procPid, $_.Exception.Message)
    }
  }

  if ($orphansFound -eq 0) {
    Write-Info "  no orphaned opencode/node processes matched the kill scope." "Green"
  }

  Write-Info ""
  Write-Info ("Summary: orphans found: {0}, killed: {1}, kill failures: {2}, skipped (protected): {3}" -f $orphansFound, $killed, $killFailures, $skipped) "Cyan"

  if ($killFailures -gt 0) { exit 1 }
  exit 0
}

# ---- Mode: -List (read-only) ----------------------------------------------------
Write-Info "process-hygiene: -List (read-only inventory) at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" "Cyan"
Show-Inventory -WithOrphanFlags $true
Show-PortOwners

$targetCount = 0
$fredoCount = 0
$orphanCount = 0
foreach ($proc in $script:relevantProcs) {
  $name = [string]$proc.Name
  if ($name -match $targetNamePattern) {
    $targetCount++
    $orphanReason = Get-OrphanReason $proc
    if ($orphanReason -ne "" -and $null -eq (Test-Protected $proc)) {
      $orphanCount++
    }
  } elseif ($name -match $fredoNamePattern) {
    $fredoCount++
  }
}

Write-Info ""
Write-Info ("Summary: {0} opencode/node process(es), {1} fredo process(es); {2} unprotected orphan candidate(s) detected." -f $targetCount, $fredoCount, $orphanCount) "Cyan"
if ($orphanCount -gt 0) {
  Write-Info "Run 'powershell -File .opencode/scripts/process-hygiene.ps1 -KillOrphans' to remove them (opt-in, single pass)." "Yellow"
} else {
  Write-Info "Process tree is clean for the current run." "Green"
}
exit 0
