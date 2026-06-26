param(
  [Parameter(Mandatory=$true)][ValidateSet("chat","tool_use","agent_session","infrastructure","ui","custom")]
  [string]$EventType,
  [Parameter(Mandatory=$true)][ValidateSet("init","update","response","error")]
  [string]$State,
  [Parameter(Mandatory=$true)][string]$ToolName,
  [Parameter(Mandatory=$true)][ValidateSet("open-code","claude-code","internal")]
  [string]$Provider,
  [Parameter(Mandatory=$true)][string]$SessionId,
  [string]$CorrelationId,
  [string]$PayloadFile
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "e2e-inject.ps1" -Body {
  $fredoBin = Get-ChildItem -Path "apps/tauri/src-tauri/target" -Recurse -Filter "fredo.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if (-not $fredoBin) {
    throw "fredo binary not found in apps/tauri/src-tauri/target/. Run pnpm dev:tauri first to build it."
  }

  $args = @(
    "emit",
    "--event-type", $EventType,
    "--state", $State,
    "--provider", $Provider,
    "--session-id", $SessionId
  )

  if ($ToolName) {
    $args += "--tool-name"
    $args += $ToolName
  }

  if ($CorrelationId) {
    $args += "--correlation-id"
    $args += $CorrelationId
  }

  if ($PayloadFile) {
    if (-not (Test-Path $PayloadFile)) {
      throw "Payload file not found: $PayloadFile"
    }
    # Strip BOM if present
    $bytes = [System.IO.File]::ReadAllBytes($PayloadFile)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $tmpFile = [System.IO.Path]::GetTempFileName()
      $utf8 = New-Object System.Text.UTF8Encoding $false
      $content = $utf8.GetString($bytes, 3, $bytes.Length - 3)
      [System.IO.File]::WriteAllText($tmpFile, $content, $utf8)
      $args += "--file"
      $args += $tmpFile
      try {
        $result = & $fredoBin $args 2>&1
      } finally {
        Remove-Item $tmpFile -ErrorAction SilentlyContinue
      }
    } else {
      $args += "--file"
      $args += $PayloadFile
      $result = & $fredoBin $args 2>&1
    }
  } else {
    $result = & $fredoBin $args 2>&1
  }

  if ($LASTEXITCODE -ne 0) {
    throw "fredo emit failed: $result"
  }

  Write-Output $result
}
