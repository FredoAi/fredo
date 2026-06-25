param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("Start", "Stop", "Status", "WaitForReady", "Logs", "Kill")]
  [string]$Action,
  [int]$Port = 5173,
  [int]$TauriPort = 9223,
  [int]$TimeoutSecs = 120
)

. $PSScriptRoot\_Common.ps1

function Write-State {
  param($StatePid, $Status)
  $StateDir = ".opencode/state"
  $StateFile = "$StateDir/dev-tauri.json"
  if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  }
  @{
    pid = $StatePid
    startTime = (Get-Date -Format "o")
    port = $Port
    tauriPort = $TauriPort
    status = $Status
  } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

function Read-State {
  $StateFile = ".opencode/state/dev-tauri.json"
  if (-not (Test-Path $StateFile)) { return $null }
  Get-Content $StateFile -Raw | ConvertFrom-Json
}

function Test-Port {
  param($P)
  try {
    $req = [System.Net.Sockets.TcpClient]::new()
    $conn = $req.BeginConnect("127.0.0.1", $P, $null, $null)
    if ($conn.AsyncWaitHandle.WaitOne(2000)) {
      $req.EndConnect($conn)
      $req.Close()
      $req.Dispose()
      return $true
    }
    $req.Close()
    $req.Dispose()
    return $false
  } catch { return $false }
}

function Test-ProcessAlive {
  param($StatePid)
  try {
    $proc = Get-Process -Id $StatePid -ErrorAction Stop
    return -not $proc.HasExited
  } catch { return $false }
}

Invoke-WithLogging -Source "dev-tauri-manager.ps1" -Body {
  $StateDir = ".opencode/state"
  $StateFile = "$StateDir/dev-tauri.json"

  switch ($Action) {
    "Start" {
      $state = Read-State
      if ($state -and (Test-ProcessAlive $state.pid)) {
        Write-Host "dev:tauri already running (PID $($state.pid), status $($state.status))"
        return
      }

      Write-Host "Starting pnpm dev:tauri in background..."
      $logOut = "$StateDir\dev-tauri-stdout.log"
      $logErr = "$StateDir\dev-tauri-stderr.log"
      $proc = Start-Process -FilePath "cmd" -ArgumentList "/c pnpm dev:tauri > `"$logOut`" 2> `"$logErr`"" -WindowStyle Hidden -PassThru

      Write-State -StatePid $proc.Id -Status "starting"
      Write-Host "Started PID $($proc.Id)"
      Write-Host "State file: $StateFile"
    }

    "WaitForReady" {
      $state = Read-State
      if (-not $state) {
        throw "No state file found. Start the dev instance first with -Action Start"
      }

      if (-not (Test-ProcessAlive $state.pid)) {
        throw "Process PID $($state.pid) is dead. Check logs with -Action Logs"
      }

      Write-Host "Waiting up to ${TimeoutSecs}s for Vite :$Port and MCP Bridge :$TauriPort..."
      $deadline = (Get-Date).AddSeconds($TimeoutSecs)
      $viteReady = $false
      $tauriReady = $false

      while ((Get-Date) -lt $deadline) {
        if (-not $viteReady) {
          $viteReady = Test-Port $Port
          if ($viteReady) { Write-Host "Vite :$Port ready" }
        }
        if (-not $tauriReady) {
          $tauriReady = Test-Port $TauriPort
          if ($tauriReady) { Write-Host "MCP Bridge :$TauriPort ready" }
        }
        if ($viteReady -and $tauriReady) {
          Write-State -StatePid $state.pid -Status "ready"
          Write-Host "dev:tauri ready"
          return
        }
        Start-Sleep -Seconds 2
      }

      $missing = @()
      if (-not $viteReady) { $missing += "Vite :$Port" }
      if (-not $tauriReady) { $missing += "MCP Bridge :$TauriPort" }
      throw "Timed out after ${TimeoutSecs}s waiting for: $($missing -join ', ')"
    }

    "Status" {
      $state = Read-State
      if (-not $state) {
        Write-Host "stopped"
        return
      }

      $alive = Test-ProcessAlive $state.pid
      $viteOk = Test-Port $Port
      $tauriOk = Test-Port $TauriPort

      if (-not $alive) {
        Write-Host "stopped (PID $($state.pid) dead)"
        return
      }

      if ($viteOk -and $tauriOk) {
        Write-Host "running (PID $($state.pid), started $($state.startTime))"
      } elseif ($viteOk) {
        Write-Host "starting (Vite ready, MCP Bridge not ready)"
      } else {
        Write-Host "starting (PID $($state.pid) alive, ports not ready)"
      }
    }

    "Logs" {
      $stdoutLog = "$StateDir/dev-tauri-stdout.log"
      $stderrLog = "$StateDir/dev-tauri-stderr.log"

      if (-not (Test-Path $stdoutLog) -and -not (Test-Path $stderrLog)) {
        throw "No log files found. Start the dev instance first."
      }

      Write-Host "=== stdout (last 50 lines) ==="
      if (Test-Path $stdoutLog) {
        Get-Content $stdoutLog -Tail 50
      } else {
        Write-Host "(no stdout log)"
      }

      Write-Host "`n=== stderr (last 50 lines) ==="
      if (Test-Path $stderrLog) {
        Get-Content $stderrLog -Tail 50
      } else {
        Write-Host "(no stderr log)"
      }
    }

    "Stop" {
      $state = Read-State
      if (-not $state) {
        Write-Host "No dev:tauri instance to stop"
        return
      }

      if (Test-ProcessAlive $state.pid) {
        Write-Host "Stopping PID $($state.pid)..."
        Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped"
      } else {
        Write-Host "Process already dead"
      }
    }

    "Kill" {
      $state = Read-State
      if ($state -and (Test-ProcessAlive $state.pid)) {
        Write-Host "Force killing PID $($state.pid) and children..."
        Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue
        taskkill /PID $state.pid /T /F 2>$null
      }
      if (Test-Path $StateDir) {
        Remove-Item -Recurse -Force "$StateDir/dev-tauri*" -ErrorAction SilentlyContinue
      }
      Write-Host "Killed"
    }
  }
}