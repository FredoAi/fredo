<#
.SYNOPSIS
  AC4 second-launch probe for the resident-shell suite (issue #3192).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). Launches the SAME build a SECOND time so the resident
  single-instance guard is exercised, with the environment's OWN FREDO_* resolution injected into the
  child (so the second process targets the SAME per-environment IPC pipe). Never launches without a
  manifest-resolved pipe: an unresolvable pipe aborts rather than risking the legacy/shared pipe.

  The child inherits this script's environment (Start-Process inherits the parent's env).

  Receipts printed as KEY=value lines:
    SECOND_PID / SECOND_EXITED / SECOND_EXITCODE / SECOND_STILL_RUNNING / SECOND_PID_GONE
    PRIMARY_PID / PRIMARY_ALIVE
    FREDO_PIDS_BEFORE / FREDO_PIDS_AFTER / NEW_FREDO_PIDS
    POSTMASTER_BEFORE / POSTMASTER_AFTER
    RESULT=PASS|FAIL  and FAIL_REASON=<...>

  PASS requires ALL of:
    - the second process exited (bounded; on timeout it is killed and the row FAILs),
    - the primary (manifest role 'app') is still alive,
    - the second PID is gone,
    - no NEW fredo.exe PID appeared,
    - the env's postmaster PID set is unchanged (one postmaster).

.EXAMPLE
  powershell -File .opencode/tests/resident-shell/second-launch.ps1 -ManifestPath .opencode/tmp/envs/spec3192/manifest.json -Exe apps/tauri/src-tauri/target/debug/fredo.exe

  Exit codes: 0 PASS; 1 FAIL (row signal); 2 usage / manifest / exe failure.
#>
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$TimeoutSecs = 20
)

$ErrorActionPreference = "Stop"

function Write-Fail {
  param([string]$Message)
  Write-Output ("ERROR: " + $Message)
  exit 2
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

if (-not (Test-Path -LiteralPath $ManifestPath)) { Write-Fail ("manifest not found: " + $ManifestPath) }
try {
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
} catch {
  Write-Fail ("manifest is not valid JSON: " + $ManifestPath)
}

$resolvedExe = Resolve-Path -LiteralPath $Exe -ErrorAction SilentlyContinue
if ($null -eq $resolvedExe) { Write-Fail ("exe not found: " + $Exe) }
$exePath = [string]$resolvedExe.Path

$envId = Get-ManifestText -Manifest $manifest -Name "envId"
$cliPipe = Get-ManifestText -Manifest $manifest -Name "cliPipe"
$dataDir = Get-ManifestText -Manifest $manifest -Name "dataDir"
if ([string]::IsNullOrWhiteSpace($cliPipe)) {
  Write-Fail "manifest carries no cliPipe - refusing to launch a second instance onto the legacy pipe"
}
if ([string]::IsNullOrWhiteSpace($dataDir)) {
  Write-Fail "manifest carries no dataDir - refusing to launch without the env resolution"
}

$envRoot = Split-Path -Parent (Resolve-Path -LiteralPath $ManifestPath).Path
$webviewDir = Get-ManifestText -Manifest $manifest -Name "webviewDir"

# ---- Inject the environment's own resolution (env.rs variable names) -----------
$env:FREDO_CLI_PIPE = $cliPipe
$env:FREDO_DATA_DIR = $dataDir
if (-not [string]::IsNullOrWhiteSpace($envId)) { $env:FREDO_ENV_ID = $envId }
if (-not [string]::IsNullOrWhiteSpace($envRoot)) { $env:FREDO_ENV_ROOT = $envRoot }
if (-not [string]::IsNullOrWhiteSpace($webviewDir)) { $env:FREDO_WEBVIEW_PROFILE_DIR = $webviewDir }
$mcpPort = Get-ManifestPort -Manifest $manifest -Name "mcp"
$vitePort = Get-ManifestPort -Manifest $manifest -Name "vite"
$grpcPort = Get-ManifestPort -Manifest $manifest -Name "otlpGrpc"
$httpPort = Get-ManifestPort -Manifest $manifest -Name "otlpHttp"
if ($mcpPort -gt 0) { $env:FREDO_MCP_BASE_PORT = [string]$mcpPort }
if ($vitePort -gt 0) { $env:FREDO_VITE_PORT = [string]$vitePort }
if ($grpcPort -gt 0) { $env:FREDO_INGEST_GRPC_PORT = [string]$grpcPort }
if ($httpPort -gt 0) { $env:FREDO_INGEST_HTTP_PORT = [string]$httpPort }

function Get-FredoPids {
  $pids = @()
  try {
    $found = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'fredo.exe'" -ErrorAction Stop)
    foreach ($proc in $found) { $pids += [int]$proc.ProcessId }
  } catch {
    Write-Output ("WARN: fredo enumeration failed: " + $_.Exception.Message)
  }
  return @($pids | Sort-Object -Unique)
}

function Get-PostmasterPids {
  $pids = @()
  try {
    $found = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'postgres.exe'" -ErrorAction Stop)
    foreach ($proc in $found) {
      $commandLine = [string]$proc.CommandLine
      if ($commandLine -and $commandLine.ToLowerInvariant().Contains($dataDir.ToLowerInvariant())) {
        $pids += [int]$proc.ProcessId
      }
    }
  } catch {
    Write-Output ("WARN: postgres enumeration failed: " + $_.Exception.Message)
  }
  return @($pids | Sort-Object -Unique)
}

$primaryPid = Get-ManifestAppPid -Manifest $manifest
$fredoBefore = Get-FredoPids
$postmasterBefore = Get-PostmasterPids

Write-Output ("ENV_ID=" + $envId)
Write-Output ("CLI_PIPE=" + $cliPipe)
Write-Output ("EXE=" + $exePath)
Write-Output ("PRIMARY_PID=" + $primaryPid)
Write-Output ("FREDO_PIDS_BEFORE=" + ($fredoBefore -join ","))
Write-Output ("POSTMASTER_BEFORE=" + ($postmasterBefore -join ","))

$workingDirectory = Split-Path -Parent $exePath
$process = Start-Process -FilePath $exePath -WorkingDirectory $workingDirectory -PassThru
$secondPid = [int]$process.Id
Write-Output ("SECOND_PID=" + $secondPid)

$exited = $false
$exitCodeKnown = $false
$exitCode = ""
try {
  $exited = $process.WaitForExit($TimeoutSecs * 1000)
} catch {
  $exited = $false
}

if ($exited) {
  try { $exitCode = [string]$process.ExitCode; $exitCodeKnown = $true } catch { $exitCodeKnown = $false }
} else {
  Write-Output "SECOND_STILL_RUNNING=True"
  try { Stop-Process -Id $secondPid -Force -ErrorAction Stop } catch { }
  try { $process.WaitForExit(5000) | Out-Null } catch { }
}

$secondAlive = [bool](Get-Process -Id $secondPid -ErrorAction SilentlyContinue)
$fredoAfter = Get-FredoPids
$postmasterAfter = Get-PostmasterPids
$primaryAlive = [bool](Get-Process -Id $primaryPid -ErrorAction SilentlyContinue)

$newFredoPids = @()
foreach ($candidate in $fredoAfter) {
  if ($fredoBefore -notcontains $candidate) { $newFredoPids += $candidate }
}

Write-Output ("SECOND_EXITED=" + $exited)
if ($exitCodeKnown) { Write-Output ("SECOND_EXITCODE=" + $exitCode) } else { Write-Output "SECOND_EXITCODE=(unknown)" }
Write-Output ("SECOND_PID_GONE=" + (-not $secondAlive))
Write-Output ("PRIMARY_ALIVE=" + $primaryAlive)
Write-Output ("FREDO_PIDS_AFTER=" + ($fredoAfter -join ","))
Write-Output ("NEW_FREDO_PIDS=" + ($newFredoPids -join ","))
Write-Output ("POSTMASTER_AFTER=" + ($postmasterAfter -join ","))

$failReasons = @()
if (-not $exited) { $failReasons += "second process did not exit within ${TimeoutSecs}s" }
if ($secondAlive) { $failReasons += "second PID still alive" }
if (-not $primaryAlive) { $failReasons += "primary app PID is not alive" }
if ($newFredoPids.Count -gt 0) { $failReasons += ("new fredo PID(s): " + ($newFredoPids -join ",")) }
if (($postmasterBefore -join ",") -ne ($postmasterAfter -join ",")) {
  $failReasons += "env postmaster set changed"
}
if ($exitCodeKnown -and $exitCode -ne "0") {
  # A non-zero exit is reported but NOT a hard fail by itself: the guard's contract is "exit without
  # starting a stack", and the row records the observed code. The stack-level checks above decide.
  Write-Output ("SECOND_EXITCODE_NONZERO=" + $exitCode)
}

if ($failReasons.Count -eq 0) {
  Write-Output "RESULT=PASS"
  exit 0
}

Write-Output ("FAIL_REASON=" + ($failReasons -join " | "))
Write-Output "RESULT=FAIL"
exit 1
