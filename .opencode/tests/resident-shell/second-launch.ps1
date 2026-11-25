<#
.SYNOPSIS
  AC4 second-launch probe for the resident-shell suite (issue #3192).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). Launches the SAME build a SECOND time so the resident
  single-instance guard is exercised, with the environment's OWN FREDO_* resolution injected into the
  child (so the second process targets the SAME per-environment IPC pipe). Never launches without a
  manifest-resolved pipe: an unresolvable pipe aborts rather than risking the legacy/shared pipe.

  The child inherits this script's environment (Start-Process inherits the parent's env).

  MANIFEST KEYS come ONLY from `manifest-facts.ps1` (dot-sourced next to this file; shipped names
  `envId`, `dataDir`, `pipe`, `webviewProfile`, `servedCommit`, `ports.*`, `processes[]`). The pipe
  is the manifest's `pipe` (dev-env.ps1:588) and the WebView2 profile is `webviewProfile` (:589).

  THE POSTMASTER CLAUSE IS ENV-SCOPED, NOT VACUOUS. The env's postmasters are the `postgres.exe`
  processes whose command line references the CLUSTER dir - `<manifest parent>/postgres`
  (dev-env.ps1:733,1535,1553) or the `-PgDataDir` override (normally
  `pg_supervisor_status.dataDir`), never the manifest's app-data `dataDir`. The probed dir is printed
  (`PG_DATA_DIR`, `PG_DATA_DIR_SOURCE`) and the run ABORTS (exit 2) when that directory does not
  exist: a blank or empty postmaster pair must never read as "unchanged".

  Receipts printed as KEY=value lines:
    SECOND_PID / SECOND_EXITED / SECOND_EXITCODE / SECOND_STILL_RUNNING / SECOND_PID_GONE
    PRIMARY_PID / PRIMARY_ALIVE
    FREDO_PIDS_BEFORE / FREDO_PIDS_AFTER / NEW_FREDO_PIDS
    PG_DATA_DIR / PG_DATA_DIR_SOURCE
    POSTGRES_TREE_BEFORE / POSTGRES_TREE_AFTER   (children included)
    POSTMASTER_BEFORE / POSTMASTER_AFTER         (the postmasters themselves)
    RESULT=PASS|FAIL  and FAIL_REASON=<...>

  PASS requires ALL of:
    - the second process exited (bounded; on timeout it is killed and the row FAILs),
    - the primary (manifest role 'app') is still alive,
    - the second PID is gone,
    - no NEW fredo.exe PID appeared,
    - the env's postmaster set was NON-EMPTY before the launch and is unchanged (one owner).
  A blank POSTMASTER_BEFORE/POSTMASTER_AFTER pair is a FAIL of the row, not a pass.

.EXAMPLE
  powershell -File .opencode/tests/resident-shell/second-launch.ps1 -ManifestPath .opencode/tmp/envs/spec3192/manifest.json -Exe apps/tauri/src-tauri/target/debug/fredo.exe

  Exit codes: 0 PASS; 1 FAIL (row signal); 2 usage / manifest / exe / probed PG dir failure.
#>
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$PgDataDir = "",
  [int]$TimeoutSecs = 20
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

if (-not (Test-Path -LiteralPath $ManifestPath)) { Write-Fail ("manifest not found: " + $ManifestPath) }
$manifest = Read-ManifestFile -Path $ManifestPath
if ($null -eq $manifest) { Write-Fail ("manifest is not valid JSON: " + $ManifestPath) }

$resolvedExe = Resolve-Path -LiteralPath $Exe -ErrorAction SilentlyContinue
if ($null -eq $resolvedExe) { Write-Fail ("exe not found: " + $Exe) }
$exePath = [string]$resolvedExe.Path

$envId = Get-ManifestEnvId -Manifest $manifest
$cliPipe = Get-ManifestPipe -Manifest $manifest
$dataDir = Get-ManifestDataDir -Manifest $manifest
$webviewProfile = Get-ManifestWebviewProfile -Manifest $manifest
if ([string]::IsNullOrWhiteSpace($cliPipe)) {
  Write-Fail "manifest carries no 'pipe' - refusing to launch a second instance onto the legacy pipe"
}
if ([string]::IsNullOrWhiteSpace($dataDir)) {
  Write-Fail "manifest carries no 'dataDir' - refusing to launch without the env resolution"
}

$envRoot = Get-ManifestEnvRoot -ManifestPath $ManifestPath
$pgFacts = Resolve-PgDataDir -ManifestPath $ManifestPath -PgDataDir $PgDataDir
if ([string]::IsNullOrWhiteSpace($pgFacts.Path)) {
  Write-Fail "cannot resolve the PG cluster dir: pass -ManifestPath (the env manifest) or -PgDataDir"
}
if (-not $pgFacts.Exists) {
  Write-Fail ("probed PG data dir does not exist: " + $pgFacts.Path + " (source=" + $pgFacts.Source + ") - the postmaster clause cannot be evaluated; pass -PgDataDir with pg_supervisor_status.dataDir")
}

# ---- Inject the environment's own resolution (env.rs variable names) -----------
$env:FREDO_CLI_PIPE = $cliPipe
$env:FREDO_DATA_DIR = $dataDir
if (-not [string]::IsNullOrWhiteSpace($envId)) { $env:FREDO_ENV_ID = $envId }
if (-not [string]::IsNullOrWhiteSpace($envRoot)) { $env:FREDO_ENV_ROOT = $envRoot }
if (-not [string]::IsNullOrWhiteSpace($webviewProfile)) { $env:FREDO_WEBVIEW_PROFILE_DIR = $webviewProfile }
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

function Get-PostgresProcs {
  param([string]$FilterName)
  $found = @()
  try {
    $found = @(Get-CimInstance -ClassName Win32_Process -Filter ("Name = '" + $FilterName + "'") -ErrorAction Stop)
  } catch {
    Write-Output ("WARN: postgres enumeration failed: " + $_.Exception.Message)
  }
  return $found
}

function Get-PostmasterPids {
  param([object[]]$Procs, [string]$ClusterDir)
  $pids = @()
  $masters = @(Get-PostmasterProcList -Procs $Procs -PgDataDir $ClusterDir)
  foreach ($proc in $masters) { $pids += [int]$proc.ProcessId }
  return @($pids | Sort-Object -Unique)
}

function Get-PostgresTreePids {
  param([object[]]$Procs, [string]$ClusterDir)
  $pids = @()
  $tree = @(Get-PostgresProcList -Procs $Procs -PgDataDir $ClusterDir)
  foreach ($proc in $tree) { $pids += [int]$proc.ProcessId }
  return @($pids | Sort-Object -Unique)
}

$primaryPid = Get-ManifestAppPid -Manifest $manifest
$fredoBefore = Get-FredoPids
$postgresProcs = Get-PostgresProcs -FilterName "postgres.exe"
$postmasterBefore = Get-PostmasterPids -Procs $postgresProcs -ClusterDir $pgFacts.Path
$postgresTreeBefore = Get-PostgresTreePids -Procs $postgresProcs -ClusterDir $pgFacts.Path

Write-Output ("ENV_ID=" + $envId)
Write-Output ("CLI_PIPE=" + $cliPipe)
Write-Output ("DATA_DIR=" + $dataDir)
Write-Output ("WEBVIEW_PROFILE=" + $webviewProfile)
Write-Output ("PG_DATA_DIR=" + $pgFacts.Path)
Write-Output ("PG_DATA_DIR_SOURCE=" + $pgFacts.Source)
Write-Output ("EXE=" + $exePath)
Write-Output ("PRIMARY_PID=" + $primaryPid)
Write-Output ("FREDO_PIDS_BEFORE=" + ($fredoBefore -join ","))
Write-Output ("POSTGRES_TREE_BEFORE=" + ($postgresTreeBefore -join ","))
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
$postgresProcsAfter = Get-PostgresProcs -FilterName "postgres.exe"
$postmasterAfter = Get-PostmasterPids -Procs $postgresProcsAfter -ClusterDir $pgFacts.Path
$postgresTreeAfter = Get-PostgresTreePids -Procs $postgresProcsAfter -ClusterDir $pgFacts.Path
$primaryAlive = $false
if ($primaryPid -gt 0) { $primaryAlive = [bool](Get-Process -Id $primaryPid -ErrorAction SilentlyContinue) }

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
Write-Output ("POSTGRES_TREE_AFTER=" + ($postgresTreeAfter -join ","))
Write-Output ("POSTMASTER_AFTER=" + ($postmasterAfter -join ","))

$failReasons = @()
if (-not $exited) { $failReasons += "second process did not exit within ${TimeoutSecs}s" }
if ($secondAlive) { $failReasons += "second PID still alive" }
if (-not $primaryAlive) { $failReasons += "primary app PID is not alive" }
if ($newFredoPids.Count -gt 0) { $failReasons += ("new fredo PID(s): " + ($newFredoPids -join ",")) }
if (@($postmasterBefore).Count -eq 0) {
  $failReasons += ("no postmaster found in " + $pgFacts.Path + " before the second launch - the env must be UP for the AC4 postmaster clause to mean anything")
}
if (($postmasterBefore -join ",") -ne ($postmasterAfter -join ",")) {
  $failReasons += ("env postmaster set changed: before=" + ($postmasterBefore -join ",") + " after=" + ($postmasterAfter -join ","))
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
