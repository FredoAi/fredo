<#
.SYNOPSIS
  READ-ONLY single-owner census for the resident ingest process (Spec #3194).

.DESCRIPTION
  Proves AC1/AC2/AC5 (one owner, one bind per OTLP port, bounded teardown) from
  OUTSIDE the product, using INDEPENDENT readings that must AGREE:

    reading A  the product's own status view  (`pg_supervisor_status`, supplied as
               a JSON file the tester saves from the webview) -> state/pid/port
    reading B  the postmaster's own pid file, DISCOVERED under the environment
               root                                            -> pid/port
    reading C  the APP pid, resolved from the env manifest's
               `processes[]` entry with `role == "app"` (or an explicit
               `-AppPid`)                                     -> app pid

  A and B must be NON-EMPTY and name the SAME subject (G-469: an equality over
  two empty sets is not an instrument). A missing or unreadable input is an
  INSTRUMENT failure - exit 2, never a confident pass.

  TWO IDENTITIES, NEVER INTERCHANGED (the round-1 defect this fixes). The
  postmaster is the `postgres` process that owns the PG port; the APP is the
  desktop process. They are different pids:

    - the PG listener is owned by the POSTMASTER (`STATUS_PID` == the pid-file
      pid); `postmaster.pid` legitimately binds 127.0.0.1 AND [::1], so the PG
      port shows 1..2 listener ROWS owned by ONE pid - `one_pg_listener` is an
      OWNER-cardinality reading, not a row count;
    - the OTLP receivers and the MCP bridge are owned by the APP, so their
      clauses compare against `CENSUS_APP_PID` and say so in the key
      (`binder_is_app_pid_otlp_grpc` / `..._otlp_http` /
      `mcp_listener_owned_by_app_pid`).

  It derives its whole state from the environment manifest + the documented env
  layout and REFUSES when a derived path is outside the env root (G-470). It
  never kills, never binds, never starts or stops anything: every native read is
  bounded.

  G-469 requirements implemented here:
    (a) hard-fail (exit 2) when an input is absent - no confident zero;
    (b) refuse a blank/empty pair; both values must be non-empty;
    (c) print the resolved path of every input and how it was resolved
        (`MANIFEST_RESOLVED_FROM`, `STATUS_JSON_RESOLVED_FROM`,
        `CENSUS_APP_PID_SOURCE`);
    (d) cross-check ONE independent source (the postmaster pid file + the OS
        listener table + the app's MCP bind) so a probe aimed at a neighbouring
        path is visible;
    (e) the receipt line names every pair: `CENSUS_PID_STATUS` /
        `CENSUS_PID_POSTMASTER` (the postmaster) and `CENSUS_APP_PID` (the
        binder of the OTLP/MCP ports).

.PARAMETER Manifest
  Required. The environment process manifest, `<env-root>/manifest.json`
  (written by dev-env.ps1).

.PARAMETER StatusJson
  Running mode only. REQUIRED. A JSON file holding the object returned by
  `invoke('pg_supervisor_status')` in the webview, saved verbatim by the tester
  (e.g. `.opencode/tmp/<issue>/pg_supervisor_status.json`).

.PARAMETER AppPid
  Running mode only, optional. The pid of the desktop app that should own the
  OTLP receivers and the MCP bridge. Normally NOT needed: the app pid is resolved
  from the manifest's `processes[]` entry with `role == "app"`, re-deriving
  liveness (a recorded pid is a published field, never trusted as state). Pass
  this when the app under test was NOT started by dev-env.ps1 - e.g. an instance
  launched by otlp-conflict-probe.ps1 (F-6/F-7/F-8). Unresolvable -> REFUSED
  (`ERROR=APP_PID_REQUIRED`), never a silent fallback to the postmaster.

.PARAMETER ExpectStopped
  Teardown mode (AC5). Asserts: no live postmaster pid file under the env root,
  no listener on the PG port observed while running, no listener on either OTLP
  port, and no `postgres` process whose command line names the env root.

.PARAMETER PgPort
  Teardown mode only. REQUIRED (> 0): the PG port the RUNNING census printed.
  A teardown probe with no prior port is refused - "port 0 is closed" proves
  nothing.

.PARAMETER TimeoutSecs
  Wall-clock bound for the one native read (netstat). Default 10.

.EXIT CODES
  0  every clause OK
  1  at least one clause VIOLATION (named on a `CLAUSE=` line)
  2  REFUSED - instrument precondition failed (absent input, unreadable
     manifest, derived path outside the env root, undecidable app pid:
     `APP_PID_REQUIRED` / `APP_PID_AMBIGUOUS` / `APP_PID_NOT_LIVE`). NOT a
     product verdict.

.EXAMPLE
  powershell -File .opencode/tests/resident-ingest/owner-census.ps1 -Manifest .opencode/tmp/envs/spec3194/manifest.json -StatusJson .opencode/tmp/3194/pg_supervisor_status.json

.EXAMPLE
  powershell -File .opencode/tests/resident-ingest/owner-census.ps1 -Manifest .opencode/tmp/envs/spec3194/manifest.json -ExpectStopped -PgPort 64217

.EXAMPLE
  powershell -File .opencode/tests/resident-ingest/owner-census.ps1 -Manifest .opencode/tmp/envs/spec3194/manifest.json -StatusJson .opencode/tmp/3194/pg_supervisor_status.json -AppPid 4468
#>
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$StatusJson = '',
  [int]$AppPid = 0,
  [switch]$ExpectStopped,
  [int]$PgPort = 0,
  [int]$TimeoutSecs = 10
)

$ErrorActionPreference = 'Stop'

$script:Failures = New-Object System.Collections.ArrayList
$script:Checks = New-Object System.Collections.ArrayList

function Write-Line { param([string]$Text) Write-Output $Text }

function Refuse {
  param([string]$Reason)
  Write-Line "ERROR=$Reason"
  Write-Line 'CENSUS=REFUSED'
  exit 2
}

function Clause {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  if ($Ok) {
    Write-Line "CLAUSE=$Name OK"
  } else {
    Write-Line "CLAUSE=$Name VIOLATION: $Detail"
    [void]$script:Failures.Add($Name)
  }
}

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  $flag = if ($Ok) { 'true' } else { 'false' }
  # [Console]::Out (never Write-Output): this function's RETURN VALUE is the bool,
  # so a pipeline write here would be folded into it (the launch-artifact-probe
  # Stream-B trap).
  [Console]::Out.WriteLine("CHECK=$Name $flag $Detail")
  [void]$script:Checks.Add(@{ Name = $Name; Ok = $Ok })
}

# One bounded `netstat -ano` read: listener rows + distinct owning PIDs per port.
function Get-ListenerTable {
  param([int]$Timeout)
  $result = @{ Rows = @(); Error = '' }
  $tmpOut = Join-Path ([System.IO.Path]::GetTempPath()) ('census-netstat-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $tmpErr = $tmpOut + '.err'
  try {
    $proc = Start-Process -FilePath 'netstat.exe' -ArgumentList '-ano' -NoNewWindow -PassThru -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
    if (-not $proc.WaitForExit($Timeout * 1000)) {
      try { $proc.Kill() } catch {}
      $result.Error = "netstat timed out after ${Timeout}s"
      return $result
    }
  } catch {
    $result.Error = "netstat could not be started: $($_.Exception.Message)"
    return $result
  }
  try {
    if (Test-Path -LiteralPath $tmpOut) {
      $result.Rows = @(Get-Content -LiteralPath $tmpOut -ErrorAction SilentlyContinue)
    } else {
      $result.Error = 'netstat produced no output'
    }
  } catch {
    $result.Error = "netstat output unreadable: $($_.Exception.Message)"
  } finally {
    foreach ($path in @($tmpOut, $tmpErr)) {
      try { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } } catch {}
    }
  }
  return $result
}

function Get-PortOwners {
  param([object[]]$Rows, [string]$ErrorText, [int]$Port)
  if ($ErrorText) { return @{ Rows = 0; Pids = @(); Error = $ErrorText } }
  if ($Port -le 0) { return @{ Rows = 0; Pids = @(); Error = 'port 0 - not a reading' } }
  $ownerPids = New-Object System.Collections.ArrayList
  $count = 0
  foreach ($row in @($Rows)) {
    if (-not $row) { continue }
    $tokens = @(([string]$row).Trim() -split '\s+')
    if ($tokens.Count -lt 5) { continue }
    if ($tokens[0] -ne 'TCP') { continue }
    if ($tokens[3] -ne 'LISTENING') { continue }
    $local = [string]$tokens[1]
    $idx = $local.LastIndexOf(':')
    if ($idx -lt 0) { continue }
    $localPort = 0
    if (-not [int]::TryParse($local.Substring($idx + 1), [ref]$localPort)) { continue }
    if ($localPort -ne $Port) { continue }
    $count++
    $ownerId = 0
    if ([int]::TryParse([string]$tokens[4], [ref]$ownerId) -and $ownerId -gt 0) {
      if (-not $ownerPids.Contains($ownerId)) { [void]$ownerPids.Add($ownerId) }
    }
  }
  return @{ Rows = $count; Pids = @($ownerPids); Error = '' }
}

# Resolve the APP pid: the desktop process, NOT the postmaster. The manifest's
# processes[] carries { pid, role, startedAt }; role="app" is the desktop process
# dev-env.ps1 launched. A recorded pid is a published FIELD - liveness is
# re-derived here, never trusted (G-470: absence is a reading, not a default).
function Resolve-AppPid {
  param([object]$ManifestData, [int]$ExplicitPid)
  $live = New-Object System.Collections.ArrayList
  if ($ExplicitPid -gt 0) {
    if (Get-Process -Id $ExplicitPid -ErrorAction SilentlyContinue) { [void]$live.Add($ExplicitPid) }
    return @{ Pid = $(if ($live.Count -eq 1) { [int]$live[0] } else { 0 }); Source = 'parameter -AppPid'; Candidates = @($live) }
  }
  foreach ($proc in @($ManifestData.processes)) {
    if (-not $proc) { continue }
    if ([string]$proc.role -ne 'app') { continue }
    $candidate = 0
    if (-not [int]::TryParse([string]$proc.pid, [ref]$candidate)) { continue }
    if ($candidate -le 0) { continue }
    if (-not (Get-Process -Id $candidate -ErrorAction SilentlyContinue)) { continue }
    if (-not $live.Contains($candidate)) { [void]$live.Add($candidate) }
  }
  return @{ Pid = $(if ($live.Count -eq 1) { [int]$live[0] } else { 0 }); Source = 'manifest processes[] role="app"'; Candidates = @($live) }
}

function Test-PathInside {
  param([string]$Candidate, [string]$Root)
  if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $c = $Candidate.TrimEnd('\', '/').ToLowerInvariant()
  $r = $Root.TrimEnd('\', '/').ToLowerInvariant()
  return ($c -eq $r) -or $c.StartsWith($r + '\') -or $c.StartsWith($r + '/')
}

# --- Resolve + derive (G-470: derive, assert, refuse) -------------------------

$manifestPath = $Manifest
if (-not [System.IO.Path]::IsPathRooted($manifestPath)) {
  $manifestPath = Join-Path (Get-Location).Path $manifestPath
}
$manifestPath = [System.IO.Path]::GetFullPath($manifestPath)
Write-Line "MANIFEST=$manifestPath"
Write-Line "MANIFEST_RESOLVED_FROM=$Manifest"
if (-not (Test-Path -LiteralPath $manifestPath)) { Refuse 'MANIFEST_NOT_FOUND' }
$manifestData = $null
try { $manifestData = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { Refuse 'MANIFEST_UNREADABLE' }
if (-not $manifestData) { Refuse 'MANIFEST_EMPTY' }

$envRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $manifestPath))
$dataDir = ''
if ($manifestData.dataDir) { $dataDir = [System.IO.Path]::GetFullPath([string]$manifestData.dataDir) }
Write-Line "ENV_ROOT=$envRoot"
Write-Line "ENV_ID=$($manifestData.envId)"
Write-Line "DATA_DIR=$dataDir"

if (-not (Test-Path -LiteralPath $envRoot)) { Refuse 'ENV_ROOT_MISSING' }
Check 'env_root_exists' $true $envRoot
if ([string]::IsNullOrWhiteSpace($dataDir)) { Refuse 'DATA_DIR_MISSING_IN_MANIFEST' }
Check 'data_dir_present' $true 'manifest.dataDir'
$dataInside = Test-PathInside -Candidate $dataDir -Root $envRoot
Check 'data_dir_inside_env_root' $dataInside $dataDir
if (-not $dataInside) { Refuse 'DATA_DIR_OUTSIDE_ENV_ROOT' }

$grpcPort = 0
$httpPort = 0
$mcpPort = 0
if ($manifestData.ports) {
  if ($manifestData.ports.otlpGrpc) { $grpcPort = [int]$manifestData.ports.otlpGrpc }
  if ($manifestData.ports.otlpHttp) { $httpPort = [int]$manifestData.ports.otlpHttp }
  if ($manifestData.ports.mcp) { $mcpPort = [int]$manifestData.ports.mcp }
}
Write-Line "OTLP_GRPC_PORT=$grpcPort"
Write-Line "OTLP_HTTP_PORT=$httpPort"
Write-Line "MCP_PORT=$mcpPort"
Check 'otlp_ports_recorded' (($grpcPort -gt 0) -and ($httpPort -gt 0)) "grpc=$grpcPort http=$httpPort"
if (($grpcPort -le 0) -or ($httpPort -le 0)) { Refuse 'OTLP_PORTS_NOT_RECORDED' }

# --- The postmaster pid file, DISCOVERED under the env root (reading B) -------

$pidFiles = @(Get-ChildItem -LiteralPath $envRoot -Filter 'postmaster.pid' -Recurse -Force -File -ErrorAction SilentlyContinue)
Write-Line "POSTMASTER_PID_FILE_COUNT=$($pidFiles.Count)"
foreach ($file in $pidFiles) {
  Write-Line "POSTMASTER_PID_FILE=$($file.FullName)"
}

$postmasterPid = 0
$postmasterPort = 0
$livePostmasterPidFiles = 0
foreach ($file in $pidFiles) {
  $filePid = 0
  $filePort = 0
  try {
    $lines = @(Get-Content -LiteralPath $file.FullName -ErrorAction Stop)
    if ($lines.Count -ge 1) { [void][int]::TryParse(([string]$lines[0]).Trim(), [ref]$filePid) }
    if ($lines.Count -ge 4) { [void][int]::TryParse(([string]$lines[3]).Trim(), [ref]$filePort) }
  } catch {
    Write-Line "POSTMASTER_PID_FILE_UNREADABLE=$($file.FullName)"
  }
  $alive = $false
  if ($filePid -gt 0) {
    $proc = Get-Process -Id $filePid -ErrorAction SilentlyContinue
    if ($proc) { $alive = ($proc.ProcessName -eq 'postgres') }
  }
  Write-Line "POSTMASTER_PID_FILE_ENTRY=$($file.FullName) pid=$filePid port=$filePort alive=$alive"
  if ($alive) {
    $livePostmasterPidFiles++
    $postmasterPid = $filePid
    $postmasterPort = $filePort
  }
}
Write-Line "POSTMASTER_PID=$postmasterPid"
Write-Line "POSTMASTER_PG_PORT=$postmasterPort"
Write-Line "LIVE_POSTMASTER_PID_FILES=$livePostmasterPidFiles"

# Every `postgres` process whose command line names the env root (the cluster's
# whole process group, not a machine-wide name count - G-469/G-271).
$postgresUnderRoot = New-Object System.Collections.ArrayList
try {
  $envRootLower = $envRoot.ToLowerInvariant()
  foreach ($proc in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'postgres.exe'" -ErrorAction SilentlyContinue)) {
    $cmd = [string]$proc.CommandLine
    if ($cmd -and $cmd.ToLowerInvariant().Contains($envRootLower)) {
      [void]$postgresUnderRoot.Add([int]$proc.ProcessId)
    }
  }
} catch {
  Write-Line 'POSTGRES_PROCESS_SCAN=unavailable'
}
Write-Line "POSTGRES_PROCESSES_UNDER_ENV_ROOT=$($postgresUnderRoot -join ',')"
Write-Line "POSTGRES_PROCESS_COUNT_UNDER_ENV_ROOT=$($postgresUnderRoot.Count)"

# --- The one bounded listener read -------------------------------------------
$tableRead = Get-ListenerTable -Timeout $TimeoutSecs
if ($tableRead.Error) { Refuse ('LISTENER_TABLE_UNAVAILABLE: ' + $tableRead.Error) }

# --- Mode: teardown (AC5) ----------------------------------------------------
if ($ExpectStopped) {
  Write-Line 'CENSUS_MODE=stopped'
  if ($PgPort -le 0) {
    Refuse 'PG_PORT_REQUIRED: pass -PgPort <the port the running census printed> - a teardown probe with no prior port proves nothing'
  }
  Write-Line "PRIOR_PG_PORT=$PgPort"

  Clause 'no_live_postmaster_pid_file' ($livePostmasterPidFiles -eq 0) "live pid files=$livePostmasterPidFiles (pid=$postmasterPid)"
  Clause 'no_postgres_process_under_env_root' ($postgresUnderRoot.Count -eq 0) ("pids=" + ($postgresUnderRoot -join ','))

  $pgRead = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $PgPort
  Write-Line "PG_LISTENER_ROWS=$($pgRead.Rows)"
  Write-Line "PG_LISTENER_OWNER_PIDS=$(($pgRead.Pids) -join ',')"
  Clause 'prior_pg_port_closed' ($pgRead.Rows -eq 0) "port $PgPort still has $($pgRead.Rows) listener row(s): $(($pgRead.Pids) -join ',')"

  $grpcRead = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $grpcPort
  Write-Line "OTLP_GRPC_LISTENER_ROWS=$($grpcRead.Rows)"
  Clause 'otlp_grpc_port_closed' ($grpcRead.Rows -eq 0) "port $grpcPort still has $($grpcRead.Rows) listener row(s)"

  $httpRead = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $httpPort
  Write-Line "OTLP_HTTP_LISTENER_ROWS=$($httpRead.Rows)"
  Clause 'otlp_http_port_closed' ($httpRead.Rows -eq 0) "port $httpPort still has $($httpRead.Rows) listener row(s)"

  if ($script:Failures.Count -gt 0) {
    Write-Line "CENSUS=FAIL failures=$($script:Failures -join ',')"
    exit 1
  }
  Write-Line 'CENSUS=PASS'
  exit 0
}

# --- Mode: running (AC1/AC2) -------------------------------------------------
Write-Line 'CENSUS_MODE=running'

if ([string]::IsNullOrWhiteSpace($StatusJson)) {
  Refuse 'STATUS_JSON_REQUIRED: save the object returned by invoke("pg_supervisor_status") to a file and pass -StatusJson - without reading A there is no pair'
}
$statusPath = $StatusJson
if (-not [System.IO.Path]::IsPathRooted($statusPath)) {
  $statusPath = Join-Path (Get-Location).Path $statusPath
}
$statusPath = [System.IO.Path]::GetFullPath($statusPath)
Write-Line "STATUS_JSON=$statusPath"
Write-Line "STATUS_JSON_RESOLVED_FROM=$StatusJson"
if (-not (Test-Path -LiteralPath $statusPath)) { Refuse 'STATUS_JSON_NOT_FOUND' }

$statusData = $null
try { $statusData = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { Refuse 'STATUS_JSON_UNREADABLE' }
if (-not $statusData) { Refuse 'STATUS_JSON_EMPTY' }

$statusState = [string]$statusData.state
$statusPid = 0
$statusPort = 0
if ($null -ne $statusData.pid) { [void][int]::TryParse([string]$statusData.pid, [ref]$statusPid) }
if ($null -ne $statusData.port) { [void][int]::TryParse([string]$statusData.port, [ref]$statusPort) }
$statusKeys = @($statusData.PSObject.Properties.Name)
$attachedKeyPresent = $statusKeys -contains 'attached'

Write-Line "STATUS_STATE=$statusState"
Write-Line "STATUS_PID=$statusPid"
Write-Line "STATUS_PORT=$statusPort"
Write-Line "STATUS_KEYS=$($statusKeys -join ',')"
Write-Line "STATUS_ATTACHED_KEY=$(if ($attachedKeyPresent) { 'present' } else { 'absent' })"

# G-469(a)+(b): an absent reading is an INSTRUMENT failure, never a pass.
if ($statusPid -le 0) { Refuse 'STATUS_PID_ABSENT: the status view carried no pid - reading A is missing (INSTRUMENT FAILURE, not a verdict)' }
if ($statusPort -le 0) { Refuse 'STATUS_PORT_ABSENT: the status view carried no port - reading A is missing (INSTRUMENT FAILURE, not a verdict)' }
if ($postmasterPid -le 0) { Refuse 'POSTMASTER_PID_ABSENT: no LIVE postmaster pid file under the env root - reading B is missing (INSTRUMENT FAILURE, not a verdict)' }
if ($postmasterPort -le 0) { Refuse 'POSTMASTER_PORT_ABSENT: the postmaster pid file carried no port - reading B is missing' }

Write-Line "CENSUS_PID_STATUS=$statusPid"
Write-Line "CENSUS_PID_POSTMASTER=$postmasterPid"
Write-Line "CENSUS_PG_PORT=$postmasterPort"

# --- Reading C: the APP pid, the binder of the OTLP receivers + MCP bridge ----
# NOT the postmaster. `STATUS_PID` is the cluster's postmaster (it owns the PG
# port); the desktop APP binds the receivers. Comparing one against the other is
# unsatisfiable by construction - the round-1 defect this reading replaces.
$appResolution = Resolve-AppPid -ManifestData $manifestData -ExplicitPid $AppPid
$resolvedAppPid = [int]$appResolution.Pid
$appCandidates = @($appResolution.Candidates)
Write-Line "CENSUS_APP_PID_SOURCE=$($appResolution.Source)"
Write-Line "CENSUS_APP_PID_CANDIDATES=$($appCandidates -join ',')"
if ($resolvedAppPid -le 0) {
  if ($appCandidates.Count -eq 0) {
    Refuse 'APP_PID_REQUIRED: no LIVE process with role="app" in the env manifest and no -AppPid given - the OTLP/MCP binder identity cannot be read (INSTRUMENT FAILURE, not a verdict)'
  }
  Refuse ('APP_PID_AMBIGUOUS: ' + $appCandidates.Count + ' live app candidate(s) (' + ($appCandidates -join ',') + ') - pass -AppPid <the app serving this env> (INSTRUMENT FAILURE, not a verdict)')
}
if (-not (Get-Process -Id $resolvedAppPid -ErrorAction SilentlyContinue)) {
  Refuse ('APP_PID_NOT_LIVE: pid ' + $resolvedAppPid + ' (from ' + $appResolution.Source + ') is not running - a running census needs the live app; an exited app is -ExpectStopped territory (INSTRUMENT FAILURE, not a verdict)')
}
Write-Line "CENSUS_APP_PID=$resolvedAppPid"
Write-Line 'CENSUS_APP_PID_LIVE=true'

Clause 'status_state_ready' ($statusState -eq 'ready') "state=$statusState"
Clause 'status_has_no_attached_key' (-not $attachedKeyPresent) 'the status view still carries an `attached` key'
Clause 'exactly_one_live_postmaster' ($livePostmasterPidFiles -eq 1) "live pid files=$livePostmasterPidFiles"
Clause 'census_pair_non_empty' (($statusPid -gt 0) -and ($postmasterPid -gt 0)) "status=$statusPid postmaster=$postmasterPid"
Clause 'census_pair_agrees_on_pid' ($statusPid -eq $postmasterPid) "status=$statusPid postmaster=$postmasterPid"
Clause 'census_pair_agrees_on_port' ($statusPort -eq $postmasterPort) "status=$statusPort postmaster=$postmasterPort"

$pgOwners = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $statusPort
Write-Line "PG_LISTENER_ROWS=$($pgOwners.Rows)"
Write-Line "PG_LISTENER_DISTINCT_OWNERS=$($pgOwners.Pids.Count)"
Write-Line "PG_LISTENER_OWNER_PIDS=$(($pgOwners.Pids) -join ',')"
# The postmaster legitimately binds BOTH 127.0.0.1 and [::1] on the one port, so
# a correct tree shows 1..2 listener ROWS owned by exactly ONE pid. A row count of
# 1 would FAIL a healthy tree, so this clause is an OWNER-cardinality reading and
# prints the row count beside the owner set.
Clause 'one_pg_listener' (($pgOwners.Rows -ge 1) -and ($pgOwners.Rows -le 2) -and ($pgOwners.Pids.Count -eq 1)) "rows=$($pgOwners.Rows) distinct_owners=$($pgOwners.Pids.Count) owners=$(($pgOwners.Pids) -join ',')"
Clause 'pg_listener_owned_by_postmaster' (($pgOwners.Pids.Count -eq 1) -and ([int]$pgOwners.Pids[0] -eq $postmasterPid)) "owners=$(($pgOwners.Pids) -join ',') postmaster=$postmasterPid"

foreach ($pair in @(@{ Name = 'otlp_grpc'; Port = $grpcPort }, @{ Name = 'otlp_http'; Port = $httpPort })) {
  $read = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $pair.Port
  $upper = $pair.Name.ToUpperInvariant()
  Write-Line "$($upper)_LISTENER_ROWS=$($read.Rows)"
  Write-Line "$($upper)_LISTENER_OWNER_PIDS=$(($read.Pids) -join ',')"
  Clause "one_bind_$($pair.Name)" ($read.Rows -eq 1) "port $($pair.Port) rows=$($read.Rows)"
  # A receiver is bound by the APP (CENSUS_APP_PID), never by the postmaster.
  Clause "binder_is_app_pid_$($pair.Name)" (($read.Pids.Count -eq 1) -and ([int]$read.Pids[0] -eq $resolvedAppPid)) "port $($pair.Port) owners=$(($read.Pids) -join ',') expected_app_pid=$resolvedAppPid"
}

if ($mcpPort -gt 0) {
  $mcpRead = Get-PortOwners -Rows $tableRead.Rows -ErrorText '' -Port $mcpPort
  Write-Line "MCP_LISTENER_ROWS=$($mcpRead.Rows)"
  Write-Line "MCP_LISTENER_OWNER_PIDS=$(($mcpRead.Pids) -join ',')"
  Clause 'mcp_listener_owned_by_app_pid' (($mcpRead.Rows -ge 1) -and ($mcpRead.Pids -contains $resolvedAppPid)) "owners=$(($mcpRead.Pids) -join ',') expected_app_pid=$resolvedAppPid (cross-check: the resolved app pid really is the app serving this env)"
}

Clause 'postmaster_process_present' ($postgresUnderRoot.Count -ge 1) 'no postgres.exe names the env root'

if ($script:Failures.Count -gt 0) {
  Write-Line "CENSUS=FAIL failures=$($script:Failures -join ',')"
  exit 1
}
Write-Line 'CENSUS=PASS'
exit 0
