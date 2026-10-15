<#
.SYNOPSIS
  Error-path induction levers for the env-isolation suites (Spec #3066 ST-5,
  guardrail G-275).

.DESCRIPTION
  TEST-ONLY and INERT BY DEFAULT. No product code path depends on this script:
  nothing here is imported, dot-sourced, or invoked by dev-env.ps1,
  verify-env-isolation.ps1, or pipeline-state.rs. It exists so the Tester can
  INDUCE the error-path acceptance criteria that have no natural trigger and prove
  the fail-closed / no-shared-cluster behavior live.

  Every artifact it writes is rooted under .opencode/tmp/3066/ (gitignored
  scratch); the script itself lives under .opencode/tests/env-isolation/ so the
  lever is version-controlled and reusable. It NEVER reads or writes the REAL
  shared dir %APPDATA%\com.fredo.app -- FREDO_SHARED_APPDATA_DIR always points at
  a FIXTURE shared dir under .opencode/tmp/3066/.

  Levers:
    SharedDirRefusal    (R-2, R-5a) FREDO_SHARED_APPDATA_DIR = fixture shared dir
                        and FREDO_DATA_DIR = that same fixture dir, then run
                        dev-env.ps1 -Action AssertIsolation -RequireIsolation
                        (legacy -- no -EnvId/-EnvSlot/-ServingCheckout). PASS =
                        exit 3 + "ISOLATION REFUSED (shared-dir):" + audit
                        refused/shared-dir + no postgres.exe spawned.
    SentinelRefusal     (R-3, R-5a) As above PLUS FREDO_PG_PASSWORD_FILE = an
                        in-repo fixture sentinel file. PASS = exit 3 +
                        "ISOLATION REFUSED (sentinel-seam):" + audit
                        refused/sentinel-seam naming the seam + no postgres.exe.
    IsolatedControl     (R-3a, R-1a) FREDO_SHARED_APPDATA_DIR = fixture shared
                        dir, FREDO_ENV_ROOT = .opencode/tmp/3066/env-root, the
                        sentinel SET, then dev-env.ps1 -Action AssertIsolation
                        -EnvId spec3066 -EnvSlot 1. PASS = exit 0 + audit
                        "isolated" (the seams stay ALLOWED off the shared dir).
                        A refusal here = FAIL (the guard is over-broad).
    NoGlobalImageKill   (R-5, R-5b, R-5a) Static leg: dev-env.ps1 contains no
                        global image-name kill (/IM) and the manifest teardown
                        (Stop-EnvManifest) + image guard (Test-RoleImageMatch)
                        are present. Live leg: after a SharedDirRefusal-style
                        refusal run, no postgres.exe was spawned under the fixture
                        shared dir. Prints IMAGE_KILL_PRESENT,
                        MANIFEST_TEARDOWN_PRESENT, IMAGE_GUARD_PRESENT,
                        POSTGRES_SPAWNED.
    SharedRootViolation (R-1b) Write a fixture manifest under
                        .opencode/tmp/3066/ whose dataDir = the fixture shared
                        dir, then run verify-env-isolation.ps1 -ManifestPath
                        <fixture> with FREDO_SHARED_APPDATA_DIR = the fixture dir.
                        PASS = exit 1 + stdout contains "is the SHARED cluster dir".
    List                Print the levers (default).

  Boundedness (G-263): every child process is waited on with a wall-clock bound
  and hard-killed on timeout. This script never starts/stops a real environment:
  the refusal legs exit before any PostgreSQL start, and the control leg is
  guard-only (AssertIsolation, no PG/app launch).

  Usage (through the allowlisted run-exitcode wrapper):
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/env-isolation/error-path-levers.ps1 -Lever SharedDirRefusal"
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/env-isolation/error-path-levers.ps1 -Lever SentinelRefusal"
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/env-isolation/error-path-levers.ps1 -Lever IsolatedControl"
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/env-isolation/error-path-levers.ps1 -Lever NoGlobalImageKill"
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/env-isolation/error-path-levers.ps1 -Lever SharedRootViolation"
#>
param(
  [ValidateSet("List", "SharedDirRefusal", "SentinelRefusal", "IsolatedControl", "NoGlobalImageKill", "SharedRootViolation")]
  [string]$Lever = "List",
  [uint64]$Spec = 3066,
  [string]$EnvId = "spec3066",
  [int]$EnvSlot = 1,
  [int]$TimeoutSecs = 60,
  [switch]$Keep
)

$ErrorActionPreference = "Continue"

$script:RepoRoot        = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$script:TmpDir          = Join-Path $script:RepoRoot ".opencode\tmp\3066"
$script:FixtureShared   = Join-Path $script:TmpDir "fixture-shared"
$script:FixtureSentinel = Join-Path $script:TmpDir "fixture-sentinel.txt"
$script:EnvRoot         = Join-Path $script:TmpDir "env-root"
$script:FixtureManifest = Join-Path $script:TmpDir "fixture-manifest.json"
$script:DevEnv          = Join-Path $script:RepoRoot ".opencode\scripts\dev-env.ps1"
$script:VerifyEnv       = Join-Path $script:RepoRoot ".opencode\scripts\verify-env-isolation.ps1"
$script:AuditFile       = Join-Path $script:RepoRoot ".opencode\state\env-isolation.jsonl"
$script:PowerShellExe   = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $script:PowerShellExe)) { $script:PowerShellExe = "powershell.exe" }

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Ensure-TmpDir {
  if (-not (Test-Path -LiteralPath $script:TmpDir)) {
    New-Item -ItemType Directory -Path $script:TmpDir -Force | Out-Null
  }
  if (-not (Test-Path -LiteralPath $script:FixtureShared)) {
    New-Item -ItemType Directory -Path $script:FixtureShared -Force | Out-Null
  }
}

function Write-Kv {
  param([string]$Key, [string]$Value)
  Write-Host "$Key=$Value"
}

# Bounded child execution (G-263): wall-clock bound + hard-kill fallback.
function Invoke-BoundedChild {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$BoundSecs,
    [string]$WorkingDirectory = ""
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = ($Arguments -join " ")
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  try {
    $child = [System.Diagnostics.Process]::Start($psi)
  } catch {
    return @{ Exited = $false; ExitCode = -1; StdOut = ""; StdErr = "could not start ${FilePath}: $($_.Exception.Message)" }
  }
  $outTask = $child.StandardOutput.ReadToEndAsync()
  $errTask = $child.StandardError.ReadToEndAsync()
  $exited = $child.WaitForExit([Math]::Max(1, $BoundSecs) * 1000)
  if (-not $exited) {
    try { & taskkill /PID $child.Id /T /F 2>$null | Out-Null } catch {}
    return @{ Exited = $false; ExitCode = -1; StdOut = ""; StdErr = "timed out after ${BoundSecs}s (hard-killed)" }
  }
  $out = ""
  $err = ""
  try { $out = $outTask.Result } catch {}
  try { $err = $errTask.Result } catch {}
  return @{ Exited = $true; ExitCode = $child.ExitCode; StdOut = $out; StdErr = $err }
}

# Set / clear PROCESS env vars for the child (Invoke-BoundedChild's child inherits
# the parent process environment). Always cleared after a leg so no leg leaks env
# into the next.
function Set-LeverEnv {
  param([hashtable]$Vars)
  foreach ($k in @($Vars.Keys)) {
    [Environment]::SetEnvironmentVariable([string]$k, [string]$Vars[$k], "Process")
  }
}

function Clear-LeverEnv {
  param([string[]]$Names)
  foreach ($n in @($Names)) {
    [Environment]::SetEnvironmentVariable([string]$n, $null, "Process")
  }
}

function Get-PostgresPids {
  $pids = @()
  try {
    $procs = Get-Process -Name postgres -ErrorAction SilentlyContinue
    if ($procs) { $pids = @($procs | ForEach-Object { [int]$_.Id }) }
  } catch {}
  return $pids
}

# A PG spawn is detected either by a NEW postgres.exe PID or by a data dir under
# the fixture shared dir (the launched app resolves <app-data>\postgres). A
# refusal leg exits before any PG start, so both must be false.
function Test-FixturePgSpawned {
  param([int[]]$BeforePids)
  $after = @(Get-PostgresPids)
  $new = @($after | Where-Object { @($BeforePids) -notcontains $_ })
  $pgVersion = Join-Path (Join-Path $script:FixtureShared "postgres") "PG_VERSION"
  $pgDataDirExists = Test-Path -LiteralPath $pgVersion
  return @{ Spawned = (($new.Count -gt 0) -or $pgDataDirExists); NewPids = $new; PgDataDirExists = $pgDataDirExists }
}

function Get-AuditLineCount {
  if (-not (Test-Path -LiteralPath $script:AuditFile)) { return 0 }
  $lines = @(Get-Content -LiteralPath $script:AuditFile -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  return $lines.Count
}

function Read-LastAuditJson {
  if (-not (Test-Path -LiteralPath $script:AuditFile)) { return $null }
  $lines = @(Get-Content -LiteralPath $script:AuditFile -ErrorAction SilentlyContinue | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($lines.Count -eq 0) { return $null }
  try { return ($lines[$lines.Count - 1] | ConvertFrom-Json) } catch { return $null }
}

# Run a guard-only AssertIsolation leg with the given process env, capturing the
# bounded result, the audit-line delta and the PG-spawn observation.
function Invoke-GuardLeg {
  param([hashtable]$LegEnv, [string[]]$ExtraArgs = @())
  Ensure-TmpDir
  $before = Get-AuditLineCount
  $beforePids = @(Get-PostgresPids)
  Set-LeverEnv -Vars $LegEnv
  # Spec #3066 round 2 (F-1): every guard leg MUST arm the guard. In legacy mode
  # (no -EnvId/-EnvSlot/-ServingCheckout) ONLY the -RequireIsolation switch arms it
  # -- without it a refusal leg runs un-armed and never refuses (the round-1 defect).
  # Env-mode legs (IsolatedControl) are armed by $IsEnvMode as well, and still
  # resolve to their own env root (isolated) rather than refusing (F-3).
  $childArgs = @("-NoProfile", "-NonInteractive", "-File", "`"$script:DevEnv`"", "-Action", "AssertIsolation", "-RequireIsolation") + $ExtraArgs
  $res = Invoke-BoundedChild -FilePath $script:PowerShellExe -Arguments $childArgs -BoundSecs ($TimeoutSecs + 15) -WorkingDirectory $script:RepoRoot
  Clear-LeverEnv -Names @($LegEnv.Keys)
  $after = Get-AuditLineCount
  $pg = Test-FixturePgSpawned -BeforePids $beforePids
  return @{ Res = $res; AuditBefore = $before; AuditAfter = $after; Pg = $pg }
}

function Write-AuditLast {
  param($Audit)
  if ($null -ne $Audit) {
    try { Write-Kv "AUDIT_LAST" ($Audit | ConvertTo-Json -Compress -Depth 4) } catch {}
  }
}

# -- Dispatch -----------------------------------------------------------------

if ($Lever -eq "List") {
  Write-Host "error-path-levers: test-only induction levers for the env-isolation suites (Spec #3066 ST-5)."
  Write-Host "Tmp dir:      $script:TmpDir"
  Write-Host "Fixture shared dir: $script:FixtureShared"
  Write-Host "Levers:"
  Write-Host "  -Lever SharedDirRefusal     (R-2, R-5a: shared-dir refusal, exit 3)"
  Write-Host "  -Lever SentinelRefusal      (R-3, R-5a: sentinel-seam refusal, exit 3)"
  Write-Host "  -Lever IsolatedControl      (R-3a, R-1a: isolated-env ALLOWED control, exit 0)"
  Write-Host "  -Lever NoGlobalImageKill    (R-5, R-5b, R-5a: static /IM pin + live no-PG-spawn)"
  Write-Host "  -Lever SharedRootViolation  (R-1b: verify-env-isolation.ps1 exit 1)"
  Write-Kv "RESULT" "PASS"
  exit 0
}

if ($Lever -eq "SharedDirRefusal") {
  if (-not (Test-Path -LiteralPath $script:DevEnv)) {
    Write-Kv "RESULT" "FAIL"
    Write-Host "dev-env.ps1 not found at $script:DevEnv"
    exit 1
  }
  $leg = Invoke-GuardLeg -LegEnv @{ FREDO_SHARED_APPDATA_DIR = $script:FixtureShared; FREDO_DATA_DIR = $script:FixtureShared }
  $res = $leg.Res
  $text = "$($res.StdOut)`n$($res.StdErr)"
  $msgPresent = [bool]($text -match [regex]::Escape("ISOLATION REFUSED (shared-dir):"))
  $audit = Read-LastAuditJson
  $auditOk = ($null -ne $audit) -and ($leg.AuditAfter -gt $leg.AuditBefore) -and ([string]$audit.decision -eq "refused") -and ([string]$audit.code -eq "shared-dir")
  $pgSpawned = [bool]$leg.Pg.Spawned

  Write-Kv "REFUSAL_EXITCODE" "$($res.ExitCode)"
  Write-Kv "REFUSAL_BOUNDED" "$($res.Exited)"
  Write-Kv "REFUSAL_MESSAGE_PRESENT" "$msgPresent"
  Write-Kv "AUDIT_REFUSED" "$auditOk"
  Write-Kv "AUDIT_LINES_BEFORE" "$($leg.AuditBefore)"
  Write-Kv "AUDIT_LINES_AFTER" "$($leg.AuditAfter)"
  Write-Kv "PG_SPAWNED" "$pgSpawned"
  Write-Kv "PG_DATA_DIR_EXISTS" "$($leg.Pg.PgDataDirExists)"
  Write-Kv "FIXTURE_SHARED_DIR" "$script:FixtureShared"
  Write-AuditLast $audit

  if ($res.Exited -and ($res.ExitCode -eq 3) -and $msgPresent -and $auditOk -and (-not $pgSpawned)) {
    Write-Kv "RESULT" "PASS"; exit 0
  }
  Write-Kv "RESULT" "FAIL"
  exit 1
}

if ($Lever -eq "SentinelRefusal") {
  if (-not (Test-Path -LiteralPath $script:DevEnv)) {
    Write-Kv "RESULT" "FAIL"
    Write-Host "dev-env.ps1 not found at $script:DevEnv"
    exit 1
  }
  Ensure-TmpDir
  [System.IO.File]::WriteAllText($script:FixtureSentinel, "spec3066-fixture-sentinel`n", $script:Utf8NoBom)

  $leg = Invoke-GuardLeg -LegEnv @{
    FREDO_SHARED_APPDATA_DIR = $script:FixtureShared
    FREDO_DATA_DIR           = $script:FixtureShared
    FREDO_PG_PASSWORD_FILE   = $script:FixtureSentinel
  }
  $res = $leg.Res
  $text = "$($res.StdOut)`n$($res.StdErr)"
  $msgPresent = [bool]($text -match [regex]::Escape("ISOLATION REFUSED (sentinel-seam):"))
  $audit = Read-LastAuditJson
  $seams = @()
  if ($null -ne $audit) { $seams = @($audit.seams) }
  $auditOk = ($null -ne $audit) -and ($leg.AuditAfter -gt $leg.AuditBefore) -and ([string]$audit.decision -eq "refused") -and ([string]$audit.code -eq "sentinel-seam") -and ($seams -contains "FREDO_PG_PASSWORD_FILE")
  $pgSpawned = [bool]$leg.Pg.Spawned

  Write-Kv "SENTINEL_EXITCODE" "$($res.ExitCode)"
  Write-Kv "SENTINEL_BOUNDED" "$($res.Exited)"
  Write-Kv "SENTINEL_MESSAGE_PRESENT" "$msgPresent"
  Write-Kv "SENTINEL_SEAM_NAMED" "$([bool]($text -match 'FREDO_PG_PASSWORD_FILE'))"
  Write-Kv "AUDIT_SENTINEL" "$auditOk"
  Write-Kv "AUDIT_LINES_BEFORE" "$($leg.AuditBefore)"
  Write-Kv "AUDIT_LINES_AFTER" "$($leg.AuditAfter)"
  Write-Kv "PG_SPAWNED" "$pgSpawned"
  Write-Kv "FIXTURE_SENTINEL_FILE" "$script:FixtureSentinel"
  Write-AuditLast $audit

  if ($res.Exited -and ($res.ExitCode -eq 3) -and $msgPresent -and $auditOk -and (-not $pgSpawned)) {
    Write-Kv "RESULT" "PASS"; exit 0
  }
  Write-Kv "RESULT" "FAIL"
  exit 1
}

if ($Lever -eq "IsolatedControl") {
  if (-not (Test-Path -LiteralPath $script:DevEnv)) {
    Write-Kv "RESULT" "FAIL"
    Write-Host "dev-env.ps1 not found at $script:DevEnv"
    exit 1
  }
  Ensure-TmpDir
  [System.IO.File]::WriteAllText($script:FixtureSentinel, "spec3066-fixture-sentinel`n", $script:Utf8NoBom)

  # The resolved dir is the env root (NOT the fixture shared dir); the sentinel is
  # set, so this proves the credential seams stay ALLOWED off the shared dir.
  $leg = Invoke-GuardLeg -LegEnv @{
    FREDO_SHARED_APPDATA_DIR = $script:FixtureShared
    FREDO_ENV_ROOT           = $script:EnvRoot
    FREDO_PG_PASSWORD_FILE   = $script:FixtureSentinel
  } -ExtraArgs @("-EnvId", $EnvId, "-EnvSlot", "$EnvSlot")
  $res = $leg.Res
  $audit = Read-LastAuditJson
  $seams = @()
  if ($null -ne $audit) { $seams = @($audit.seams) }
  $auditOk = ($null -ne $audit) -and ($leg.AuditAfter -gt $leg.AuditBefore) -and ([string]$audit.decision -eq "isolated")
  $seamsAllowed = ($res.Exited -and ($res.ExitCode -eq 0)) -and $auditOk -and ($seams -contains "FREDO_PG_PASSWORD_FILE")
  $rad = ""
  $rpd = ""
  if ($null -ne $audit) { $rad = [string]$audit.resolvedAppDataDir; $rpd = [string]$audit.resolvedPgDataDir }

  Write-Kv "CONTROL_EXITCODE" "$($res.ExitCode)"
  Write-Kv "CONTROL_BOUNDED" "$($res.Exited)"
  Write-Kv "AUDIT_ISOLATED" "$auditOk"
  Write-Kv "SEAMS_ALLOWED" "$seamsAllowed"
  Write-Kv "AUDIT_LINES_BEFORE" "$($leg.AuditBefore)"
  Write-Kv "AUDIT_LINES_AFTER" "$($leg.AuditAfter)"
  Write-Kv "RESOLVED_APP_DATA_DIR" "$rad"
  Write-Kv "RESOLVED_PG_DATA_DIR" "$rpd"
  Write-Kv "FIXTURE_ENV_ROOT" "$script:EnvRoot"
  Write-AuditLast $audit

  if ($res.Exited -and ($res.ExitCode -eq 0) -and $auditOk -and $seamsAllowed) {
    Write-Kv "RESULT" "PASS"; exit 0
  }
  Write-Kv "RESULT" "FAIL"
  exit 1
}

if ($Lever -eq "NoGlobalImageKill") {
  if (-not (Test-Path -LiteralPath $script:DevEnv)) {
    Write-Kv "RESULT" "FAIL"
    Write-Host "dev-env.ps1 not found at $script:DevEnv"
    exit 1
  }
  # Static leg: the whole file must carry no global image-name kill (/IM), and the
  # manifest-scoped teardown + image guard must be present.
  $src = Get-Content -LiteralPath $script:DevEnv -Raw
  $imageKill = [bool]($src -match "(?i)/IM\b")
  $hasStop = [bool]($src -match "function Stop-EnvManifest\b")
  $hasGuard = [bool]($src -match "function Test-RoleImageMatch\b")

  # Live leg: a SharedDirRefusal-style refusal must spawn no postgres.exe.
  $leg = Invoke-GuardLeg -LegEnv @{ FREDO_SHARED_APPDATA_DIR = $script:FixtureShared; FREDO_DATA_DIR = $script:FixtureShared }
  $pgSpawned = [bool]$leg.Pg.Spawned

  Write-Kv "IMAGE_KILL_PRESENT" "$imageKill"
  Write-Kv "MANIFEST_TEARDOWN_PRESENT" "$hasStop"
  Write-Kv "IMAGE_GUARD_PRESENT" "$hasGuard"
  Write-Kv "REFUSAL_EXITCODE" "$($leg.Res.ExitCode)"
  Write-Kv "REFUSAL_BOUNDED" "$($leg.Res.Exited)"
  Write-Kv "POSTGRES_SPAWNED" "$pgSpawned"
  Write-Kv "PG_DATA_DIR_EXISTS" "$($leg.Pg.PgDataDirExists)"
  Write-Kv "FIXTURE_SHARED_DIR" "$script:FixtureShared"

  if ((-not $imageKill) -and $hasStop -and $hasGuard -and $leg.Res.Exited -and ($leg.Res.ExitCode -eq 3) -and (-not $pgSpawned)) {
    Write-Kv "RESULT" "PASS"; exit 0
  }
  Write-Kv "RESULT" "FAIL"
  exit 1
}

if ($Lever -eq "SharedRootViolation") {
  if (-not (Test-Path -LiteralPath $script:VerifyEnv)) {
    Write-Kv "RESULT" "FAIL"
    Write-Host "verify-env-isolation.ps1 not found at $script:VerifyEnv"
    exit 1
  }
  Ensure-TmpDir
  # Fixture manifest whose dataDir IS the fixture shared dir -- passed explicitly
  # so it lands in verify-env-isolation.ps1's active set.
  $obj = [ordered]@{
    envId     = $EnvId
    dataDir   = $script:FixtureShared
    dbPath    = $script:FixtureShared
    ports     = [ordered]@{}
    processes = @()
  }
  [System.IO.File]::WriteAllText($script:FixtureManifest, ($obj | ConvertTo-Json -Depth 6), $script:Utf8NoBom)

  Set-LeverEnv -Vars @{ FREDO_SHARED_APPDATA_DIR = $script:FixtureShared }
  $res = Invoke-BoundedChild -FilePath $script:PowerShellExe `
    -Arguments @("-NoProfile", "-NonInteractive", "-File", "`"$script:VerifyEnv`"", "-ManifestPath", "`"$script:FixtureManifest`"") `
    -BoundSecs ($TimeoutSecs + 15) -WorkingDirectory $script:RepoRoot
  Clear-LeverEnv -Names @("FREDO_SHARED_APPDATA_DIR")

  $text = "$($res.StdOut)`n$($res.StdErr)"
  $present = [bool]($text -match [regex]::Escape("is the SHARED cluster dir"))

  Write-Kv "VIOLATION_EXITCODE" "$($res.ExitCode)"
  Write-Kv "VIOLATION_BOUNDED" "$($res.Exited)"
  Write-Kv "SHARED_ROOT_VIOLATION_PRESENT" "$present"
  Write-Kv "FIXTURE_MANIFEST" "$script:FixtureManifest"

  if (-not $Keep) { Remove-Item -LiteralPath $script:FixtureManifest -ErrorAction SilentlyContinue }

  if ($res.Exited -and ($res.ExitCode -eq 1) -and $present) {
    Write-Kv "RESULT" "PASS"; exit 0
  }
  Write-Kv "RESULT" "FAIL"
  exit 1
}
