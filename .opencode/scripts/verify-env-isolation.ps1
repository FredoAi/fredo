<#
.SYNOPSIS
  Continuous, read-only isolation-invariant checker for local Fredo test
  environments (Spec #2944 ST-7 / CU-C, guardrail G-123).

.DESCRIPTION
  While two or more environments (A, B, ...) are concurrently live, this script
  proves -- READ-ONLY -- that:

    * each environment's data root is distinct (R-2.3);
    * no port is recorded by two environments (R-1.3);
    * each recorded endpoint is bound ONLY by a PID recorded in that
      environment's own process manifest -- never by a sibling environment's
      PID and never by an unrecorded/foreign owner (R-1.3).

  It NEVER kills a process, NEVER binds a port, and NEVER starts/stops an
  environment. It reads manifests, the process table and listening sockets only,
  each native query wall-clock bounded (G-263). A single environment (or none)
  reports trivially OK.

  This checker owns the CONTINUOUS invariant as its own line, separate from the
  discrete Up/Down transitions in dev-env.ps1. `dev-env.ps1 -Action Status` also
  invokes it (read-only, `-Summary`) and prints an `isolation` assertion line.

.PARAMETER ManifestPath
  One or more explicit manifest.json paths.

.PARAMETER EnvRoot
  One or more environment roots; each resolves to <root>/manifest.json.

.PARAMETER Spec
  One or more issue numbers; each resolves to the default env root
  <repo>/.opencode/tmp/envs/spec<N>/manifest.json.

.PARAMETER Scan
  Discover every <repo>/.opencode/tmp/envs/*/manifest.json. Discovered
  environments that are not currently live are reported inactive and excluded
  from the cross-environment pair checks. Used when no explicit manifest is
  given.

.PARAMETER Summary
  Print a single result line (used by dev-env.ps1 -Action Status).

.PARAMETER TimeoutSecs
  Per native query (netstat) wall-clock bound, seconds. Default 5.

.EXAMPLE
  powershell -File .opencode/scripts/verify-env-isolation.ps1 -Spec 2944,2945
  powershell -File .opencode/scripts/verify-env-isolation.ps1 -EnvRoot .opencode/tmp/envs/spec2944 -EnvRoot .opencode/tmp/envs/spec2945
  powershell -File .opencode/scripts/verify-env-isolation.ps1 -Scan
  powershell -File .opencode/scripts/verify-env-isolation.ps1 -ManifestPath .opencode/tmp/envs/spec2944/manifest.json -ManifestPath .opencode/tmp/envs/spec2945/manifest.json
#>
param(
  [string[]]$ManifestPath = @(),
  [string[]]$EnvRoot = @(),
  [uint64[]]$Spec = @(),
  [switch]$Scan,
  [switch]$Summary,
  [int]$TimeoutSecs = 5
)

$ErrorActionPreference = "Continue"
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:TimeoutMs = [Math]::Max(1, $TimeoutSecs) * 1000
$script:Violations = New-Object System.Collections.ArrayList
$script:Warnings = New-Object System.Collections.ArrayList

function Add-Violation { param([string]$Reason) [void]$script:Violations.Add($Reason) }
function Add-Warning   { param([string]$Reason) [void]$script:Warnings.Add($Reason) }

# -- Bounded native read (G-263) ----------------------------------------------
# Run a read-only native command, capture stdout, and hard-kill it if it exceeds
# the wall-clock bound. Never blocks unboundedly.
function Invoke-BoundedNative {
  param([string]$FilePath, [string[]]$Arguments)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = ($Arguments -join " ")
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
  } catch {
    return @{ TimedOut = $false; Failed = $true; StdOut = "" }
  }
  $stdoutTask = $p.StandardOutput.ReadToEndAsync()
  $null = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($script:TimeoutMs)) {
    try { $p.Kill() } catch {}
    return @{ TimedOut = $true; Failed = $false; StdOut = "" }
  }
  $out = ""
  try { $out = $stdoutTask.Result } catch {}
  return @{ TimedOut = $false; Failed = $false; StdOut = $out }
}

# -- Port owner (read-only, one cached netstat read) --------------------------
$script:NetstatText = $null
$script:NetstatError = $null

function Get-NetstatText {
  if ($null -ne $script:NetstatText) { return $script:NetstatText }
  $res = Invoke-BoundedNative -FilePath "netstat.exe" -Arguments @("-ano")
  if ($res.TimedOut) {
    $script:NetstatError = "netstat timed out after ${TimeoutSecs}s"
    $script:NetstatText = ""
  } elseif ($res.Failed) {
    $script:NetstatError = "netstat could not be started"
    $script:NetstatText = ""
  } else {
    $script:NetstatText = $res.StdOut
  }
  return $script:NetstatText
}

# Owner PID of a LISTENING socket on $Port, or $null when unbound.
# Returns @{ Pid = <int|null>; Error = <string|null> }.
function Get-PortOwner {
  param([int]$Port)
  $text = Get-NetstatText
  if ($script:NetstatError) { return @{ Pid = $null; Error = $script:NetstatError } }
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match ":$Port\s+.*LISTENING") {
      $parts = @(($line -split '\s+') | Where-Object { $_ -ne '' })
      if ($parts.Count -ge 1) {
        $found = $parts[$parts.Count - 1]
        if ($found -match '^\d+$' -and [int]$found -gt 0) { return @{ Pid = [int]$found; Error = $null } }
      }
    }
  }
  return @{ Pid = $null; Error = $null }
}

# -- Manifest / process helpers ----------------------------------------------

function Read-EnvManifestFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-CanonicalPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  try {
    $p = $Path
    if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path $script:RepoRoot $p }
    return ([System.IO.Path]::GetFullPath($p)).TrimEnd('\', '/')
  } catch { return $Path }
}

# Role -> acceptable live image base names (without .exe), mirroring dev-env.ps1's
# stale-PID guard. Used to make the liveness probe PID-reuse resistant.
$script:RoleImages = @{
  app      = @("fredo")
  postgres = @("postgres")
  llama    = @("llama-server")
  vite     = @("node", "bun")
  launcher = @("cmd", "powershell", "pwsh")
}

function Get-ProcessImageBase {
  param([int]$ProcessId)
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName) { return [string]$p.ProcessName }
  } catch {}
  return $null
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

# True when the PID is alive AND (for a known role) its image matches the role,
# so a reused PID does not masquerade as a live environment process.
function Test-RecordedProcessLive {
  param([string]$Role, [int]$ProcessId)
  $image = Get-ProcessImageBase $ProcessId
  if (-not $image) { return $false }
  $expected = $script:RoleImages[$Role]
  if (-not $expected) { return $true }
  foreach ($e in @($expected)) {
    if ($image.Trim().ToLowerInvariant() -eq ([string]$e).ToLowerInvariant()) { return $true }
  }
  return $false
}

function Get-EnvPortEntries {
  param($Ports)
  $list = New-Object System.Collections.ArrayList
  $map = @(
    @{ Name = "vite";     Role = "vite";  Optional = $false },
    @{ Name = "mcp";      Role = "app";   Optional = $false },
    @{ Name = "otlpGrpc"; Role = "app";   Optional = $false },
    @{ Name = "otlpHttp"; Role = "app";   Optional = $false },
    @{ Name = "llama";    Role = "llama"; Optional = $true }
  )
  if (-not $Ports) { return $list }
  foreach ($m in $map) {
    $raw = $Ports.($m.Name)
    $val = 0
    if ($raw -and [int]::TryParse([string]$raw, [ref]$val) -and $val -gt 0) {
      [void]$list.Add(@{ Name = $m.Name; Port = $val; Role = $m.Role; Optional = $m.Optional })
    }
  }
  return $list
}

# -- Resolve manifests --------------------------------------------------------

$resolved = New-Object System.Collections.ArrayList
function Add-Resolved {
  param([string]$Path, [bool]$Explicit)
  $full = Get-CanonicalPath $Path
  [void]$resolved.Add(@{ Path = $full; Explicit = $Explicit })
}

foreach ($p in @($ManifestPath)) {
  if ([string]::IsNullOrWhiteSpace($p)) { continue }
  Add-Resolved $p $true
}
foreach ($r in @($EnvRoot)) {
  if ([string]::IsNullOrWhiteSpace($r)) { continue }
  Add-Resolved (Join-Path $r "manifest.json") $true
}
foreach ($s in @($Spec)) {
  if ($s -le 0) { continue }
  Add-Resolved (Join-Path $script:RepoRoot ".opencode\tmp\envs\spec$s\manifest.json") $true
}
$doScan = $Scan -or ($resolved.Count -eq 0)
if ($doScan) {
  $envsDir = Join-Path $script:RepoRoot ".opencode\tmp\envs"
  if (Test-Path -LiteralPath $envsDir) {
    foreach ($mf in @(Get-ChildItem -LiteralPath $envsDir -Directory -ErrorAction SilentlyContinue)) {
      $candidate = Join-Path $mf.FullName "manifest.json"
      if (Test-Path -LiteralPath $candidate) { Add-Resolved $candidate $false }
    }
  }
}

# Dedupe by canonical path (explicit wins).
$seen = @{}
$envs = New-Object System.Collections.ArrayList
foreach ($entry in $resolved) {
  $key = $entry.Path.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true

  if (-not (Test-Path -LiteralPath $entry.Path)) {
    if ($entry.Explicit) { Add-Violation "manifest not found: $($entry.Path)" }
    continue
  }
  $manifest = Read-EnvManifestFile $entry.Path
  if (-not $manifest) {
    if ($entry.Explicit) { Add-Violation "manifest unreadable (invalid JSON?): $($entry.Path)" }
    else { Add-Warning "manifest unreadable, skipped: $($entry.Path)" }
    continue
  }

  $envId = [string]$manifest.envId
  if (-not $envId) { $envId = Split-Path (Split-Path $entry.Path -Parent) -Leaf }

  $dataRoot = ""
  if ($manifest.dataDir) { $dataRoot = Get-CanonicalPath ([string]$manifest.dataDir) }
  elseif ($manifest.dbPath) { $dataRoot = Get-CanonicalPath (Split-Path ([string]$manifest.dbPath) -Parent) }

  $portEntries = Get-EnvPortEntries $manifest.ports

  $procEntries = New-Object System.Collections.ArrayList
  $pids = New-Object System.Collections.ArrayList
  $live = $false
  foreach ($proc in @($manifest.processes)) {
    if (-not $proc) { continue }
    $procId = 0
    if (-not [int]::TryParse([string]$proc.pid, [ref]$procId) -or $procId -le 0) { continue }
    $role = [string]$proc.role
    [void]$procEntries.Add(@{ Pid = $procId; Role = $role })
    [void]$pids.Add($procId)
    if (Test-RecordedProcessLive -Role $role -ProcessId $procId) { $live = $true }
  }

  [void]$envs.Add([pscustomobject]@{
    EnvId       = $envId
    Path        = $entry.Path
    Explicit    = $entry.Explicit
    DataRoot    = $dataRoot
    PortEntries = $portEntries
    Processes   = $procEntries
    Pids        = $pids
    Live        = $live
  })
}

# Active set for cross-environment pair checks: live environments plus any
# explicitly requested one (a stopped sibling's recorded data root/ports still
# matter to the caller). Discovered-but-inactive manifests are excluded so stale
# records never produce false violations.
$active = @($envs | Where-Object { $_.Live -or $_.Explicit })

if (-not $Summary) {
  Write-Host "verify-env-isolation: $($envs.Count) manifest(s) resolved, $($active.Count) active, $(@($envs | Where-Object { $_.Live }).Count) live"
  foreach ($e in $envs) {
    $portStr = (@($e.PortEntries | ForEach-Object { "$($_.Name):$($_.Port)" }) -join ",")
    if (-not $portStr) { $portStr = "(none recorded)" }
    $pidStr = (@($e.Pids) -join ",")
    if (-not $pidStr) { $pidStr = "(none)" }
    $liveStr = if ($e.Live) { "live" } else { "inactive" }
    Write-Host "  ENV $($e.EnvId) [$liveStr] dataRoot=$($e.DataRoot) ports=$portStr pids=$pidStr"
  }
}

# -- Invariant 1+2: cross-environment data roots + port/pid disjointness -------

for ($i = 0; $i -lt $active.Count; $i++) {
  for ($j = $i + 1; $j -lt $active.Count; $j++) {
    $a = $active[$i]; $b = $active[$j]

    if ($a.EnvId -eq $b.EnvId) {
      Add-Violation "duplicate environment id '$($a.EnvId)' recorded by two manifests ($($a.Path); $($b.Path))"
    }

    if ($a.DataRoot -and $b.DataRoot -and ($a.DataRoot.ToLowerInvariant() -eq $b.DataRoot.ToLowerInvariant())) {
      Add-Violation "shared data root '$($a.DataRoot)' between env '$($a.EnvId)' and env '$($b.EnvId)' (R-2.3)"
    }

    foreach ($pa in @($a.PortEntries)) {
      foreach ($pb in @($b.PortEntries)) {
        if ($pa.Port -eq $pb.Port) {
          Add-Violation "port :$($pa.Port) recorded by both env '$($a.EnvId)' ($($pa.Name)) and env '$($b.EnvId)' ($($pb.Name)) (R-1.3)"
        }
      }
    }

    foreach ($pidA in @($a.Pids)) {
      if (@($b.Pids) -contains $pidA) {
        Add-Violation "PID $pidA recorded in both env '$($a.EnvId)' and env '$($b.EnvId)' (process bleed)"
      }
    }
  }
}

# -- Invariant 3: each live env's recorded endpoints owned by its own manifest -

foreach ($e in @($envs | Where-Object { $_.Live })) {
  foreach ($pe in @($e.PortEntries)) {
    $owner = Get-PortOwner $pe.Port
    if ($owner.Error) {
      Add-Violation "env '$($e.EnvId)': could not query the port table for :$($pe.Port) -- $($owner.Error)"
      continue
    }
    if ($null -eq $owner.Pid) {
      if ($pe.Optional) {
        Add-Warning "env '$($e.EnvId)': optional endpoint $($pe.Name) :$($pe.Port) not bound (companion may be disabled)"
      } else {
        Add-Violation "env '$($e.EnvId)': recorded endpoint $($pe.Name) :$($pe.Port) is not bound while the env is live (R-1.3)"
      }
      continue
    }

    $ownerPid = [int]$owner.Pid

    # Cross-environment: the owner must not be a sibling env's recorded PID.
    $sibling = $null
    foreach ($other in @($envs | Where-Object { $_.Live -and ($_.EnvId -ne $e.EnvId) })) {
      if (@($other.Pids) -contains $ownerPid) { $sibling = $other; break }
    }
    if ($sibling) {
      Add-Violation "cross-env: env '$($e.EnvId)' endpoint $($pe.Name) :$($pe.Port) is owned by PID $ownerPid, recorded in env '$($sibling.EnvId)' (R-1.3)"
      continue
    }

    # Same-environment: the owner must be the manifest's recorded PID for the
    # endpoint's role (app/vite), else at minimum one of its recorded PIDs. The
    # companion llama-server PID is not tracked in the manifest today, so an
    # untracked owner of the optional llama port is a warning, never a violation
    # (the cross-env check above still catches a sibling owning it).
    $roleProc = @($e.Processes | Where-Object { $_.Role -eq $pe.Role }) | Select-Object -First 1
    if ($roleProc) {
      if ([int]$roleProc.Pid -ne $ownerPid) {
        Add-Violation "env '$($e.EnvId)' endpoint $($pe.Name) :$($pe.Port) owned by PID $ownerPid but manifest records role '$($pe.Role)' PID $($roleProc.Pid) (R-1.3)"
      }
    } elseif (@($e.Pids) -notcontains $ownerPid) {
      if ($pe.Optional) {
        Add-Warning "env '$($e.EnvId)': optional endpoint $($pe.Name) :$($pe.Port) is bound by PID $ownerPid, which is not recorded in its manifest (companion pid untracked)"
      } else {
        Add-Violation "env '$($e.EnvId)' endpoint $($pe.Name) :$($pe.Port) owned by PID $ownerPid, which is not recorded in its manifest (foreign owner, R-1.3)"
      }
    }
  }
}

# -- Report --------------------------------------------------------------------

if ($Summary) {
  if ($script:Violations.Count -eq 0) {
    Write-Host "OK: $($active.Count) env(s) isolated (distinct data roots; disjoint ports; endpoints owned by own manifest PIDs)"
  } else {
    Write-Host "VIOLATION: $($script:Violations.Count) -- $($script:Violations[0])"
  }
} else {
  foreach ($w in @($script:Warnings)) { Write-Host "  WARN: $w" -ForegroundColor Yellow }
  foreach ($v in @($script:Violations)) { Write-Host "  VIOLATION: $v" -ForegroundColor Red }
  if ($script:Violations.Count -eq 0) {
    Write-Host "OK: $($active.Count) env(s) isolated (distinct data roots; disjoint ports; endpoints owned by own manifest PIDs)" -ForegroundColor Green
  } else {
    Write-Host "FAILED: $($script:Violations.Count) isolation violation(s)" -ForegroundColor Red
  }
}

if ($script:Violations.Count -gt 0) { exit 1 }
exit 0
