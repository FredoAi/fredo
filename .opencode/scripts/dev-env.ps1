<#
.SYNOPSIS
  Unified dev environment lifecycle manager for Fredo.

.DESCRIPTION
  Manages the pnpm dev:tauri instance -- start, stop, status, restart, and process logs.
  No state files. Ports are the source of truth. Dual-stack (IPv4 + IPv6) port probing.

.PARAMETER Action
  Up       -- Ensure dev instance is running and ready. Auto-starts if not running.
  Down     -- Stop dev instance by killing the process tree.
  Status   -- Read-only check: running / starting / stopped.
  Restart  -- Down then Up.
  Logs     -- Tail process stdout/stderr.

.PARAMETER Spec
  Spec issue number (optional, Up only). When set, the dev instance is served
  from a DEDICATED serving worktree `.serve/<Spec>` detached at the tip of
  `origin/spec/<Spec>` -- NOT from the repo-root checkout (which stays free for
  orchestrator work on main). Records `.opencode/state/serving.json`
  {issue, commit, ts}; the state machine's testing-entry guard verifies this
  record against the spec tip, so a stale/wrong-branch serving can never reach
  the tester (G-052 harness fix). Status prints the served commit.

.PARAMETER VitePort
  Vite dev server port. Default: 5174.

.PARAMETER McpPort
  MCP Bridge WebSocket port. Default: 9223.

.PARAMETER TimeoutSecs
  Max seconds to wait for ports during Up. Default: 120.

.PARAMETER Lines
  Number of log lines to tail for Logs action. Default: 50.

.EXAMPLE
  powershell -File .opencode/scripts/dev-env.ps1 -Action Up
  powershell -File .opencode/scripts/dev-env.ps1 -Action Status
  powershell -File .opencode/scripts/dev-env.ps1 -Action Logs -Lines 100
#>

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Up", "Down", "Status", "Restart", "Logs")]
  [string]$Action,

  [ValidateRange(1, [uint64]::MaxValue)]
  [uint64]$Spec = 0,

  [int]$VitePort = 5174,
  [int]$McpPort = 9223,
  [int]$TimeoutSecs = 120,
  [int]$Lines = 50
)

$ErrorActionPreference = "Stop"

# -- Logging ------------------------------------------------------------------

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $ts = Get-Date -Format "HH:mm:ss"
  switch ($Level) {
    "ERROR" { Write-Host "[$ts] $Message" -ForegroundColor Red }
    "WARN"  { Write-Host "[$ts] $Message" -ForegroundColor Yellow }
    default { Write-Host "[$ts] $Message" }
  }
}

# -- Native runner (PS 5.1 fix): with $ErrorActionPreference = "Stop", a native
# command redirected with 2>&1 turns ANY stderr write (e.g. git fetch progress,
# taskkill notices) into a terminating NativeCommandError. Run such commands
# under "Continue" and surface only the exit code.
function Invoke-NativeQuiet {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $args[0] @($args | Select-Object -Skip 1) 2>&1 | Out-Null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

# -- Port Probe (dual-stack: IPv4 then IPv6) ---------------------------------

function Test-Port {
  param([int]$Port)

  # Try IPv4
  try {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    $ar  = $tcp.BeginConnect("127.0.0.1", $Port, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne(2000)) {
      try { $tcp.EndConnect($ar) } catch { $tcp.Close(); return $false }
      $tcp.Close()
      return $true
    }
    $tcp.Close()
  } catch {}

  # Try IPv6
  try {
    $tcp = [System.Net.Sockets.TcpClient]::new([System.Net.Sockets.AddressFamily]::InterNetworkV6)
    $ar  = $tcp.BeginConnect("::1", $Port, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne(2000)) {
      try { $tcp.EndConnect($ar) } catch { $tcp.Close(); return $false }
      $tcp.Close()
      return $true
    }
    $tcp.Close()
  } catch {}

  return $false
}

function Test-BothPorts {
  param([int]$Vite, [int]$Mcp)
  $viteOk = Test-Port $Vite
  $mcpOk  = Test-Port $Mcp
  return @{ Vite = $viteOk; Mcp = $mcpOk }
}

# -- Find PID by listening port -----------------------------------------------

function Get-PidByPort {
  param([int]$Port)
  try {
    $lines = netstat -ano 2>$null | Select-String ":${Port}\s+.*LISTENING"
    foreach ($line in $lines) {
      $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
      $foundPid = $parts[-1]
      if ($foundPid -match '^\d+$' -and [int]$foundPid -gt 0) {
        return [int]$foundPid
      }
    }
  } catch {}
  return $null
}

# -- Serving record (G-052 harness fix) ---------------------------------------

function Read-ServingRecord {
  $p = Join-Path (Get-Location) ".opencode/state/serving.json"
  if (Test-Path $p) {
    try { return Get-Content $p -Raw | ConvertFrom-Json } catch { return $null }
  }
  return $null
}

function Write-ServingRecord {
  param([uint64]$SpecIssue, [string]$Commit)
  $p = Join-Path (Get-Location) ".opencode/state/serving.json"
  New-Item -ItemType Directory -Path (Split-Path $p) -Force | Out-Null
  @{ issue = $SpecIssue; commit = $Commit; ts = (Get-Date).ToUniversalTime().ToString("o") } |
    ConvertTo-Json | Set-Content -Path $p -Encoding Ascii
}

# -- Actions ------------------------------------------------------------------

$LogDir  = Join-Path $PSScriptRoot "..\logs"
$Stdout  = Join-Path $LogDir "dev-env-stdout.log"
$Stderr  = Join-Path $LogDir "dev-env-stderr.log"

# Serving-worktree prep (G-052 harness fix): when -Spec is set, the dev instance
# must serve a DEDICATED worktree detached at origin/spec/<Spec> -- never the
# repo-root checkout (which stays on main for orchestrator work). Returns the
# served commit SHA.
function Initialize-ServingWorktree {
  param([uint64]$SpecIssue)

  Write-Log "Fetching origin/spec/$SpecIssue..."
  if ((Invoke-NativeQuiet git fetch origin "spec/$SpecIssue") -ne 0) { throw "git fetch origin spec/$SpecIssue failed" }
  $tip = (git rev-parse "origin/spec/$SpecIssue").Trim()
  if (-not $tip) { throw "cannot resolve origin/spec/$SpecIssue" }

  $repoRoot = (git rev-parse --show-toplevel).Trim()
  $serveDir = Join-Path $repoRoot ".serve\$SpecIssue"
  if (Test-Path (Join-Path $serveDir ".git")) {
    Invoke-NativeQuiet git -C $serveDir reset --hard $tip | Out-Null
    Invoke-NativeQuiet git -C $serveDir clean -fd | Out-Null
  } else {
    New-Item -ItemType Directory -Path (Join-Path $repoRoot ".serve") -Force | Out-Null
    if ((Invoke-NativeQuiet git worktree add --detach $serveDir $tip) -ne 0) { throw "git worktree add failed for $serveDir" }
  }
  Write-Log "Serving worktree ready: $serveDir @ $($tip.Substring(0, [Math]::Min(8, $tip.Length)))"

  if (-not (Test-Path (Join-Path $serveDir "node_modules"))) {
    Write-Log "Installing dependencies in serving worktree (first run only, this takes a while)..."
    Push-Location $serveDir
    try { if ((Invoke-NativeQuiet pnpm install) -ne 0) { throw "pnpm install failed in serving worktree" } } finally { Pop-Location }
  }

  Write-ServingRecord -SpecIssue $SpecIssue -Commit $tip
  return $tip
}

switch ($Action) {

  # -- Up ----------------------------------------------------------------------
  "Up" {
    $ports = Test-BothPorts $VitePort $McpPort
    if ($ports.Vite -and $ports.Mcp) {
      if ($Spec -gt 0) {
        $rec = Read-ServingRecord
        if ($rec -and [uint64]$rec.issue -eq $Spec) {
          Write-Log "dev:tauri already running (Vite :$VitePort OK, MCP :$McpPort OK) -- serving spec/$Spec @ $($rec.commit.Substring(0, [Math]::Min(8, $rec.commit.Length)))"
          exit 0
        }
        Write-Log "Instance running but serving record mismatches spec/$Spec -- restarting against the spec tip..." -Level WARN
        # fall through to the stale-instance kill below
      } else {
        Write-Log "dev:tauri already running (Vite :$VitePort OK, MCP :$McpPort OK)"
        Write-Log "NOTE: no -Spec set -- tester preflight requires: dev-env.ps1 -Action Up -Spec <N>" -Level WARN
        exit 0
      }
    }
    if ($Spec -eq 0) {
      Write-Log "ERROR: -Action Up now requires -Spec <N> (serving worktree mode, G-052 fix). Legacy root serving was removed -- testers must drive the spec tip." -Level ERROR
      exit 1
    }

    # Kill any stale instance from a previous (possibly mismatched) run.
    foreach ($port in @($McpPort, $VitePort)) {
      $stalePid = Get-PidByPort $port
      if ($stalePid) {
        Write-Log "Killing stale instance PID $stalePid (port :$port)..."
        Invoke-NativeQuiet taskkill /PID $stalePid /T /F | Out-Null
        Start-Sleep -Seconds 1
      }
    }

    $serveTip = Initialize-ServingWorktree -SpecIssue $Spec
    $repoRoot = (git rev-parse --show-toplevel).Trim()
    $serveDir = Join-Path $repoRoot ".serve\$Spec"

    Write-Log "Starting pnpm dev:tauri (serving worktree .serve/$Spec)..."

    if (-not (Test-Path $LogDir)) {
      New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }

    # Telemetry prerequisites (G-046): force the OPENCODE_* OTEL vars into the
    # dev instance's environment so fredo.exe AND every opencode session it
    # spawns via Run CLI inherit them -- independent of the launching agent's
    # shell state (User-level `setx` vars do NOT propagate into an already-
    # running parent chain). Values mirror setup::configure_opencode_otel.
    $env:OPENCODE_ENABLE_TELEMETRY = "1"
    $env:OPENCODE_OTLP_ENDPOINT    = "http://localhost:4317"
    $env:OPENCODE_OTLP_PROTOCOL    = "grpc"

    # Native-build generator pin (observed 2026-08-26): llama-cpp-sys-2's CMake
    # auto-detection can pick "Visual Studio 18 2026" whose instance is unusable,
    # failing every fresh native rebuild with "could not find any instance of
    # Visual Studio". Pin the known-good installed generator for this machine's
    # cargo/cmake child processes (no-op on non-Windows).
    if ($IsWindows -or $env:OS -eq "Windows_NT") {
      $env:CMAKE_GENERATOR = "Visual Studio 17 2022"
    }

    $proc = Start-Process -FilePath "cmd" `
      -ArgumentList "/c cd /d `"$serveDir`" && pnpm dev:tauri > `"$Stdout`" 2> `"$Stderr`"" `
      -WindowStyle Hidden -PassThru

    Write-Log "Launched PID $($proc.Id). Waiting for ports..."

    $deadline = (Get-Date).AddSeconds($TimeoutSecs)
    $viteReady = $ports.Vite
    $mcpReady  = $ports.Mcp

    while ((Get-Date) -lt $deadline) {
      if (-not $viteReady) {
        $viteReady = Test-Port $VitePort
        if ($viteReady) { Write-Log "Vite :$VitePort ready" }
      }
      if (-not $mcpReady) {
        $mcpReady = Test-Port $McpPort
        if ($mcpReady) { Write-Log "MCP Bridge :$McpPort ready" }
      }
      if ($viteReady -and $mcpReady) {
        Write-Log "dev:tauri ready"
        exit 0
      }
      Start-Sleep -Seconds 2
    }

    $missing = @()
    if (-not $viteReady) { $missing += "Vite :$VitePort" }
    if (-not $mcpReady)  { $missing += "MCP Bridge :$McpPort" }
    Write-Log "Timed out after ${TimeoutSecs}s waiting for: $($missing -join ', ')" -Level ERROR
    Write-Log "Check logs: powershell -File .opencode/scripts/dev-env.ps1 -Action Logs" -Level WARN
    exit 1
  }

  # -- Down --------------------------------------------------------------------
  "Down" {
    $killed = $false

    foreach ($port in @($McpPort, $VitePort)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Found process $targetPid on port $port. Killing..."
        Invoke-NativeQuiet taskkill /PID $targetPid /T /F | Out-Null
        $killed = $true
      }
    }

    if (-not $killed) {
      Write-Log "No dev:tauri instance found on ports $VitePort / $McpPort"
    } else {
      Write-Log "dev:tauri stopped"
    }
  }

  # -- Status ------------------------------------------------------------------
  "Status" {
    $ports = Test-BothPorts $VitePort $McpPort

    if ($ports.Vite -and $ports.Mcp) {
      $rec = Read-ServingRecord
      if ($rec) {
        Write-Host "running (serving spec/$($rec.issue) @ $($rec.commit.Substring(0, [Math]::Min(8, $rec.commit.Length))))"
      } else {
        Write-Host "running (NO serving record -- restart with -Spec <N> for tester preflight)"
      }
    } elseif ($ports.Vite -or $ports.Mcp) {
      $up = @()
      if ($ports.Vite) { $up += "Vite" }
      if ($ports.Mcp)  { $up += "MCP" }
      Write-Host "starting ($($up -join ', ') ready, waiting for more)"
    } else {
      Write-Host "stopped"
    }
  }

  # -- Restart -----------------------------------------------------------------
  "Restart" {
    Write-Log "Restarting dev:tauri..."

    foreach ($port in @($McpPort, $VitePort)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Killing process $targetPid on port $port"
        Invoke-NativeQuiet taskkill /PID $targetPid /T /F | Out-Null
      }
    }

    Start-Sleep -Seconds 2

    # Re-invoke Up
    & $PSCommandPath -Action Up -VitePort $VitePort -McpPort $McpPort -TimeoutSecs $TimeoutSecs
    exit $LASTEXITCODE
  }

  # -- Logs --------------------------------------------------------------------
  "Logs" {
    $hasOutput = $false

    if (Test-Path $Stdout) {
      Write-Host "=== stdout (last $Lines lines) ===" -ForegroundColor Cyan
      Get-Content $Stdout -Tail $Lines
      $hasOutput = $true
    }

    if (Test-Path $Stderr) {
      Write-Host ""
      Write-Host "=== stderr (last $Lines lines) ===" -ForegroundColor Cyan
      Get-Content $Stderr -Tail $Lines
      $hasOutput = $true
    }

    if (-not $hasOutput) {
      Write-Host "No log files found at $LogDir"
      Write-Host "Run 'dev-env.ps1 -Action Up' first to start the dev instance."
    }
  }
}
