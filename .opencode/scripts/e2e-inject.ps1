<#
.SYNOPSIS
    Inject a FredoEvent into the running application via the fredo emit CLI.

.DESCRIPTION
    Validates event-type and state arguments, handles payload ingestion (inline JSON
    or file with BOM stripping), and calls `fredo emit` to inject the event into the
    real event pipeline (IPC socket → InternalAdapter → ContractEngine → UI).

.PARAMETER EventType
    Event type: tool_use, agent_session, or chat.

.PARAMETER State
    Event state: init, update, response, or error.

.PARAMETER ToolName
    Tool name (optional, recommended for tool_use events).

.PARAMETER SessionId
    Session identifier. Defaults to "e2e-<yyyyMMdd-HHmmss>" if not provided.

.PARAMETER CorrelationId
    Correlation identifier for linking Init↔Response pairs. Defaults to a new UUID.

.PARAMETER Provider
    Event provider (hyphenated): open-code, claude-code, or internal (default).

.PARAMETER Payload
    Inline JSON payload string.

.PARAMETER PayloadFile
    Path to a JSON payload file (BOM is stripped automatically).

.EXAMPLE
    PS> .opencode/scripts/e2e-inject.ps1 -EventType tool_use -State init -ToolName Bash -SessionId e2e-test-1 -CorrelationId e2e-corr-1

.EXAMPLE
    PS> .opencode/scripts/e2e-inject.ps1 -EventType chat -State init -ToolName assistant -Provider open-code -SessionId e2e-test-1 -CorrelationId e2e-corr-1 -PayloadFile .opencode/tmp/e2e-payload.json
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$EventType,

    [Parameter(Mandatory = $true)]
    [string]$State,

    [string]$ToolName,

    [string]$SessionId,

    [string]$CorrelationId,

    [string]$Provider = "internal",

    [string]$Payload,

    [string]$PayloadFile
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "e2e-inject.ps1" -ScriptBlock {
    # ----------------------------------------------------------------
    # Validate EventType
    # ----------------------------------------------------------------
    $validEventTypes = @('tool_use', 'agent_session', 'chat')
    if ($validEventTypes -notcontains $EventType) {
        throw "Invalid -EventType '$EventType'. Must be one of: $($validEventTypes -join ', ')"
    }

    # ----------------------------------------------------------------
    # Validate State
    # ----------------------------------------------------------------
    $validStates = @('init', 'update', 'response', 'error')
    if ($validStates -notcontains $State) {
        throw "Invalid -State '$State'. Must be one of: $($validStates -join ', ')"
    }

    # ----------------------------------------------------------------
    # Validate Provider
    # ----------------------------------------------------------------
    $validProviders = @('open-code', 'claude-code', 'internal')
    if ($validProviders -notcontains $Provider) {
        throw "Invalid -Provider '$Provider'. Must be one of: $($validProviders -join ', ')"
    }

    # ----------------------------------------------------------------
    # Default SessionId
    # ----------------------------------------------------------------
    if (-not $SessionId) {
        $SessionId = "e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    }

    # ----------------------------------------------------------------
    # Default CorrelationId
    # ----------------------------------------------------------------
    if (-not $CorrelationId) {
        $CorrelationId = [guid]::NewGuid().ToString()
    }

    # ----------------------------------------------------------------
    # Handle payload: inline JSON or file (strip BOM, validate JSON)
    # ----------------------------------------------------------------
    $jsonPayload = $null
    if ($PayloadFile) {
        # Resolve to a full path (supports relative paths)
        $resolvedFile = Resolve-Path -LiteralPath $PayloadFile -ErrorAction Stop
        # Read raw bytes to strip UTF-8 BOM manually
        $bytes = [System.IO.File]::ReadAllBytes($resolvedFile.Path)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            $jsonPayload = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
        } else {
            $jsonPayload = [System.Text.Encoding]::UTF8.GetString($bytes)
        }
        # Validate JSON
        $null = $jsonPayload | ConvertFrom-Json
    } elseif ($Payload) {
        $jsonPayload = $Payload
        # Validate JSON
        $null = $jsonPayload | ConvertFrom-Json
    }

    # ----------------------------------------------------------------
    # Convert event type to CLI kebab-case (tool_use → tool-use)
    # ----------------------------------------------------------------
    $cliEventType = $EventType -replace '_', '-'

    # ----------------------------------------------------------------
    # Find fredo binary
    # ----------------------------------------------------------------
    $fredoDebug = Join-Path -Path $PSScriptRoot -ChildPath '..\..\apps\tauri\src-tauri\target\debug\fredo.exe'
    $fredoExe = $null

    if (Test-Path -LiteralPath $fredoDebug) {
        $fredoExe = (Resolve-Path -LiteralPath $fredoDebug).Path
    } else {
        $resolved = Get-Command 'fredo.exe' -ErrorAction SilentlyContinue -CommandType Application
        if (-not $resolved) {
            $resolved = Get-Command 'fredo' -ErrorAction SilentlyContinue -CommandType Application
        }
        if ($resolved) {
            $fredoExe = $resolved.Source
        }
    }

    if (-not $fredoExe) {
        throw "fredo binary not found. Tried: debug build at '$fredoDebug' and 'fredo' on PATH."
    }

    # ----------------------------------------------------------------
    # Build fredo emit arguments
    # ----------------------------------------------------------------
    $fredoArgs = @(
        'emit',
        '--event-type', $cliEventType,
        '--state', $State,
        '--session-id', $SessionId,
        '--correlation-id', $CorrelationId,
        '--provider', $Provider
    )

    if ($ToolName) {
        $fredoArgs += '--tool-name', $ToolName
    }

    if ($jsonPayload) {
        $fredoArgs += '--payload', $jsonPayload
    }

    # ----------------------------------------------------------------
    # Execute fredo emit
    # ----------------------------------------------------------------
    $output = & $fredoExe $fredoArgs
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        $errorMsg = "fredo emit failed with exit code $exitCode"
        if ($output) {
            $errorMsg += "`n$output"
        }
        throw $errorMsg
    }

    # ----------------------------------------------------------------
    # Output summary
    # ----------------------------------------------------------------
    Write-Output "Injected ${EventType}/${State} event"
    Write-Output "  SessionId: $SessionId"
    Write-Output "  CorrelationId: $CorrelationId"
    Write-Output "  Provider: $Provider"
    if ($ToolName) {
        Write-Output "  ToolName: $ToolName"
    }
    if ($jsonPayload) {
        # Show a compact summary of payload length instead of the full JSON
        $payloadPreview = if ($jsonPayload.Length -gt 80) {
            $jsonPayload.Substring(0, 77) + '...'
        } else {
            $jsonPayload
        }
        Write-Output "  Payload: $payloadPreview"
    }
    if ($output) {
        Write-Output $output
    }
}
