<#
.SYNOPSIS
  Unified dev environment lifecycle manager for Fredo.

.DESCRIPTION
  Manages the pnpm dev:tauri instance — start, stop, status, restart, and process logs.
  No state files. Ports are the source of truth. Dual-stack (IPv4 + IPv6) port probing.

.PARAMETER Action
  Up       — Ensure dev instance is running and ready. Auto-starts if not running.
  Down     — Stop dev instance by killing the process tree.
  Status   — Read-only check: running / starting / stopped.
  Restart  — Down then Up.
  Logs     — Tail process stdout/stderr.

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

  [int]$VitePort = 5174,
  [int]$McpPort = 9223,
  [int]$TimeoutSecs = 120,
  [int]$Lines = 50
)

$ErrorActionPreference = "Stop"

# ── Logging ──────────────────────────────────────────────────────────────────

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $ts = Get-Date -Format "HH:mm:ss"
  switch ($Level) {
    "ERROR" { Write-Host "[$ts] $Message" -ForegroundColor Red }
    "WARN"  { Write-Host "[$ts] $Message" -ForegroundColor Yellow }
    default { Write-Host "[$ts] $Message" }
  }
}

# ── Port Probe (dual-stack: IPv4 then IPv6) ─────────────────────────────────

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

# ── Find PID by listening port ───────────────────────────────────────────────

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

# ── Actions ──────────────────────────────────────────────────────────────────

$LogDir  = Join-Path $PSScriptRoot "..\logs"
$Stdout  = Join-Path $LogDir "dev-env-stdout.log"
$Stderr  = Join-Path $LogDir "dev-env-stderr.log"

switch ($Action) {

  # ── Up ──────────────────────────────────────────────────────────────────────
  "Up" {
    $ports = Test-BothPorts $VitePort $McpPort
    if ($ports.Vite -and $ports.Mcp) {
      Write-Log "dev:tauri already running (Vite :$VitePort OK, MCP :$McpPort OK)"
      exit 0
    }

    Write-Log "Starting pnpm dev:tauri..."

    if (-not (Test-Path $LogDir)) {
      New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }

    # Telemetry prerequisites (G-046): force the OPENCODE_* OTEL vars into the
    # dev instance's environment so fredo.exe AND every opencode session it
    # spawns via Run CLI inherit them — independent of the launching agent's
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
      -ArgumentList "/c pnpm dev:tauri > `"$Stdout`" 2> `"$Stderr`"" `
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

  # ── Down ────────────────────────────────────────────────────────────────────
  "Down" {
    $killed = $false

    foreach ($port in @($McpPort, $VitePort)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Found process $targetPid on port $port. Killing..."
        & taskkill /PID $targetPid /T /F 2>$null
        $killed = $true
      }
    }

    if (-not $killed) {
      Write-Log "No dev:tauri instance found on ports $VitePort / $McpPort"
    } else {
      Write-Log "dev:tauri stopped"
    }
  }

  # ── Status ──────────────────────────────────────────────────────────────────
  "Status" {
    $ports = Test-BothPorts $VitePort $McpPort

    if ($ports.Vite -and $ports.Mcp) {
      Write-Host "running"
    } elseif ($ports.Vite -or $ports.Mcp) {
      $up = @()
      if ($ports.Vite) { $up += "Vite" }
      if ($ports.Mcp)  { $up += "MCP" }
      Write-Host "starting ($($up -join ', ') ready, waiting for more)"
    } else {
      Write-Host "stopped"
    }
  }

  # ── Restart ─────────────────────────────────────────────────────────────────
  "Restart" {
    Write-Log "Restarting dev:tauri..."

    foreach ($port in @($McpPort, $VitePort)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Killing process $targetPid on port $port"
        & taskkill /PID $targetPid /T /F 2>$null
      }
    }

    Start-Sleep -Seconds 2

    # Re-invoke Up
    & $PSCommandPath -Action Up -VitePort $VitePort -McpPort $McpPort -TimeoutSecs $TimeoutSecs
    exit $LASTEXITCODE
  }

  # ── Logs ────────────────────────────────────────────────────────────────────
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
