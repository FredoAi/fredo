<#
.SYNOPSIS
  Error-path induction levers for the multi-env isolation suites
  (Spec #2944 ST-14 / CU-H, guardrail G-275).

.DESCRIPTION
  TEST-ONLY and INERT BY DEFAULT. No product code path depends on this script:
  nothing here is imported, dot-sourced, or invoked by dev-env.ps1 or
  pipeline-state.rs. It exists so the Tester can INDUCE the error-path
  acceptance criteria that have no natural trigger and prove the
  fail-closed / no-cross-env-kill behavior live.

  Every artifact it writes is rooted under .opencode/tmp/2944/ (gitignored
  scratch); the script itself lives under .opencode/tests/multi-env-isolation/
  so the lever is version-controlled and reusable. It never pins a bare `main`.

  Levers:
    NoImageKill    (AC3 / R-3.3, static pin) Assert dev-env.ps1 contains no
                   global image-name kill (/IM) and that the manifest teardown
                   is image-guarded.
    DecoyManifest  (AC3 / R-3.1, R-3.3) Start a long-running Start-Sleep
                   process and write a decoy manifest that records its PID under
                   role `app` (which expects fredo.exe). Run the target env's
                   Down with FREDO_ENV_MANIFEST pointing at the decoy; the image
                   guard must REFUSE to kill the decoy PID (a stand-in for env
                   B's live PID). PASS = the decoy is still alive after Down.
    PortCollision  (AC4 / R-4.3) Bind a recorded port with a TcpListener and run
                   `dev-env.ps1 -Action Up` configured to that exact port; Up
                   must exit non-zero with the fail-closed collision message and
                   must NOT scan to / bind a different port.
    ForgedEvidence (AC5 / R-5.2) Write a tampered evidence.json (envId of A but
                   B's checkout/DB path and a bogus servedCommit) under
                   .opencode/tmp/2944/ and, with -RunAudit, run the audit with
                   FREDO_EVIDENCE_FILE set; the audit must reject it.

  Boundedness (G-263): every child process is waited on with a wall-clock bound
  and hard-killed on timeout. This script never starts/stops a real environment:
  the DecoyManifest lever's Down acts only on the decoy manifest's own PID, and
  the PortCollision lever's Up fails closed before launching anything.

  Usage (through the allowlisted run-exitcode wrapper):
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever NoImageKill"
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever DecoyManifest -Stage Run"
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever PortCollision"
    powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever ForgedEvidence -RunAudit"
#>
param(
  [ValidateSet("List", "DecoyManifest", "PortCollision", "ForgedEvidence", "NoImageKill")]
  [string]$Lever = "List",
  [ValidateSet("Run", "Prepare", "Verify", "Cleanup")]
  [string]$Stage = "Run",
  [string]$EnvId = "spec2944",
  [uint64]$Spec = 2944,
  [int]$EnvSlot = 1,
  [int]$VitePort = 0,
  [int]$HoldSecs = 900,
  [int]$TimeoutSecs = 30,
  [string]$ProbeEnvId = "collisionprobe",
  [uint64]$ProbeSpec = 2945,
  [switch]$RunAudit,
  [switch]$Keep
)

$ErrorActionPreference = "Continue"

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$script:TmpDir = Join-Path $script:RepoRoot ".opencode\tmp\2944"
$script:DevEnv = Join-Path $script:RepoRoot ".opencode\scripts\dev-env.ps1"
$script:DecoyManifest = Join-Path $script:TmpDir "decoy-manifest.json"
$script:DecoyPidFile = Join-Path $script:TmpDir "decoy-pid.txt"
$script:CollisionFile = Join-Path $script:TmpDir "port-collision.json"
$script:ForgedEvidence = Join-Path $script:TmpDir "evidence-forged.json"
$script:PowerShellExe = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $script:PowerShellExe)) { $script:PowerShellExe = "powershell.exe" }

function Ensure-TmpDir {
  if (-not (Test-Path -LiteralPath $script:TmpDir)) {
    New-Item -ItemType Directory -Path $script:TmpDir -Force | Out-Null
  }
}

function Write-Kv {
  param([string]$Key, [string]$Value)
  Write-Host "$Key=$Value"
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
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

function Get-DecoyPid {
  if (-not (Test-Path -LiteralPath $script:DecoyPidFile)) { return 0 }
  $raw = (Get-Content -LiteralPath $script:DecoyPidFile -Raw).Trim()
  $pidVal = 0
  if ([int]::TryParse($raw, [ref]$pidVal)) { return $pidVal }
  return 0
}

function Start-DecoyProcess {
  Ensure-TmpDir
  $decoyArgs = @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds $HoldSecs")
  $p = Start-Process -FilePath $script:PowerShellExe -ArgumentList $decoyArgs -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 400
  if (-not (Test-ProcessAlive $p.Id)) { return 0 }
  [System.IO.File]::WriteAllText($script:DecoyPidFile, "$($p.Id)", (New-Object System.Text.UTF8Encoding($false)))
  return [int]$p.Id
}

function Write-DecoyManifest {
  param([int]$DecoyPid)
  Ensure-TmpDir
  $startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $obj = [ordered]@{
    envId           = $EnvId
    spec            = 0
    servingCheckout = $script:RepoRoot
    servedCommit    = ""
    ports           = [ordered]@{ vite = 0; mcp = 0; otlpGrpc = 0; otlpHttp = 0; llama = 0 }
    dataDir         = (Join-Path $script:TmpDir "decoy-data")
    dbPath          = (Join-Path $script:TmpDir "decoy-data")
    pipe            = "\\.\pipe\fredo-ipc-$EnvId"
    webviewProfile  = (Join-Path $script:TmpDir "decoy-webview")
    appIdentity     = "com.fredo.app#$EnvId"
    processes       = @([ordered]@{ pid = $DecoyPid; role = "app"; startedAt = $startedAt })
  }
  [System.IO.File]::WriteAllText($script:DecoyManifest, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}

function Remove-DecoyArtifacts {
  $decoyPid = Get-DecoyPid
  if (Test-ProcessAlive $decoyPid) { & taskkill /PID $decoyPid /T /F 2>$null | Out-Null }
  Remove-Item -LiteralPath $script:DecoyManifest -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $script:DecoyPidFile -ErrorAction SilentlyContinue
}

# -- Dispatch -----------------------------------------------------------------

if ($Lever -eq "List") {
  Write-Host "error-path-levers: test-only induction levers for the multi-env isolation suites (Spec #2944 ST-14)."
  Write-Host "Tmp dir: $script:TmpDir"
  Write-Host "Levers:"
  Write-Host "  -Lever NoImageKill                                             (AC3: static pin, no /IM kill)"
  Write-Host "  -Lever DecoyManifest [-Stage Run|Prepare|Verify|Cleanup]       (AC3: no cross-env kill)"
  Write-Host "  -Lever PortCollision                                           (AC4: fail-closed port collision)"
  Write-Host "  -Lever ForgedEvidence [-RunAudit]                              (AC5: audit rejects forged evidence)"
  Write-Kv "RESULT" "NOOP"
  exit 0
}

if ($Lever -eq "NoImageKill") {
  if (-not (Test-Path -LiteralPath $script:DevEnv)) {
    Write-Kv "RESULT" "FAIL"
    Write-Host "dev-env.ps1 not found at $script:DevEnv"
    exit 1
  }
  $src = Get-Content -LiteralPath $script:DevEnv -Raw
  $imageKill = [bool]($src -match "(?i)/IM\b")
  $hasStop = [bool]($src -match "function Stop-EnvManifest\b")
  $hasGuard = [bool]($src -match "Test-RoleImageMatch")
  Write-Kv "IMAGE_KILL_PRESENT" "$imageKill"
  Write-Kv "MANIFEST_TEARDOWN_PRESENT" "$hasStop"
  Write-Kv "IMAGE_GUARD_PRESENT" "$hasGuard"
  if ((-not $imageKill) -and $hasStop -and $hasGuard) { Write-Kv "RESULT" "PASS"; exit 0 }
  Write-Kv "RESULT" "FAIL"
  exit 1
}

if ($Lever -eq "DecoyManifest") {
  if ($Stage -eq "Prepare") {
    $decoyPid = Start-DecoyProcess
    if ($decoyPid -le 0) { Write-Kv "RESULT" "FAIL"; Write-Host "decoy process did not stay alive"; exit 1 }
    Write-DecoyManifest -DecoyPid $decoyPid
    Write-Kv "DECOY_PID" "$decoyPid"
    Write-Kv "FREDO_ENV_MANIFEST" $script:DecoyManifest
    Write-Kv "RESULT" "PREPARED"
    exit 0
  }
  if ($Stage -eq "Verify") {
    $decoyPid = Get-DecoyPid
    $alive = Test-ProcessAlive $decoyPid
    Write-Kv "DECOY_PID" "$decoyPid"
    Write-Kv "DECOY_ALIVE" "$alive"
    if ($alive) { Write-Kv "RESULT" "PASS"; exit 0 }
    Write-Kv "RESULT" "FAIL"
    exit 1
  }
  if ($Stage -eq "Cleanup") {
    Remove-DecoyArtifacts
    Write-Kv "RESULT" "CLEANED"
    exit 0
  }

  # Stage Run (default): prepare -> Down with the decoy manifest -> assert alive.
  $decoyPid = Start-DecoyProcess
  if ($decoyPid -le 0) { Write-Kv "RESULT" "FAIL"; Write-Host "decoy process did not stay alive"; exit 1 }
  Write-DecoyManifest -DecoyPid $decoyPid

  $env:FREDO_ENV_MANIFEST = $script:DecoyManifest
  $res = Invoke-BoundedChild -FilePath $script:PowerShellExe `
    -Arguments @("-NoProfile", "-NonInteractive", "-File", "`"$script:DevEnv`"", "-Action", "Down", "-EnvId", $EnvId, "-TimeoutSecs", "$TimeoutSecs") `
    -BoundSecs ($TimeoutSecs + 15) -WorkingDirectory $script:RepoRoot
  Remove-Item Env:\FREDO_ENV_MANIFEST -ErrorAction SilentlyContinue

  $alive = Test-ProcessAlive $decoyPid
  $text = "$($res.StdOut)`n$($res.StdErr)"
  # A PowerShell PARSE error (dev-env.ps1 failing to load) echoes the source line
  # containing the literal "REFUSING to kill", which would otherwise look like a
  # refusal. Treat a parse error as a hard lever FAILURE so a broken dev-env.ps1
  # can never produce a spurious PASS (the teardown never actually ran).
  $parseError = [bool]($text -match "(?i)ParserError|Variable reference is not valid")
  $refused = [bool](($text -match "(?i)REFUSING to kill PID \d+") -and (-not $parseError))
  Write-Kv "DECOY_PID" "$decoyPid"
  Write-Kv "DOWN_EXITCODE" "$($res.ExitCode)"
  Write-Kv "DOWN_BOUNDED" "$($res.Exited)"
  Write-Kv "DOWN_PARSE_ERROR" "$parseError"
  Write-Kv "DOWN_REFUSED_KILL" "$refused"
  Write-Kv "DECOY_ALIVE" "$alive"

  if (-not $Keep) { Remove-DecoyArtifacts }

  # A correct manifest-scoped teardown: runs to completion (exit 0), refuses the
  # foreign-image PID, and leaves the decoy alive.
  if ($res.Exited -and ($res.ExitCode -eq 0) -and $refused -and $alive -and (-not $parseError)) {
    Write-Kv "RESULT" "PASS"; exit 0
  }
  Write-Kv "RESULT" "FAIL"
  exit 1
}

if ($Lever -eq "PortCollision") {
  Ensure-TmpDir
  $port = if ($VitePort -gt 0) { $VitePort } else { 16000 + 10 * ($EnvSlot - 1) }
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
  } catch {
    Write-Kv "COLLIDING_PORT" "$port"
    Write-Kv "RESULT" "FAIL"
    Write-Host "could not bind the collision port (another owner?): $($_.Exception.Message)"
    exit 1
  }
  $obj = [ordered]@{
    port    = $port
    ownerPid = $PID
    kind    = "tcp-listener"
    boundAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  [System.IO.File]::WriteAllText($script:CollisionFile, ($obj | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

  $res = @{ Exited = $false; ExitCode = -1; StdOut = ""; StdErr = "" }
  try {
    $res = Invoke-BoundedChild -FilePath $script:PowerShellExe `
      -Arguments @("-NoProfile", "-NonInteractive", "-File", "`"$script:DevEnv`"", "-Action", "Up", "-Spec", "$ProbeSpec", "-EnvId", $ProbeEnvId, "-EnvSlot", "$EnvSlot", "-VitePort", "$port", "-TimeoutSecs", "$TimeoutSecs") `
      -BoundSecs ($TimeoutSecs + 15) -WorkingDirectory $script:RepoRoot
  } finally {
    try { $listener.Stop() } catch {}
  }

  $text = "$($res.StdOut)`n$($res.StdErr)"
  $parseError = [bool]($text -match "(?i)ParserError|Variable reference is not valid")
  $failClosed = [bool](($text -match "(?i)already bound") -and ($text -match "(?i)fail-closed"))
  $scanned = [bool](($text -match "(?i)dev:tauri ready") -or ($text -match "(?i)already running"))
  Write-Kv "COLLIDING_PORT" "$port"
  Write-Kv "UP_EXITCODE" "$($res.ExitCode)"
  Write-Kv "UP_BOUNDED" "$($res.Exited)"
  Write-Kv "UP_PARSE_ERROR" "$parseError"
  Write-Kv "UP_FAIL_CLOSED_MESSAGE" "$failClosed"
  Write-Kv "UP_SCANNED_OR_READY" "$scanned"

  if (-not $Keep) { Remove-Item -LiteralPath $script:CollisionFile -ErrorAction SilentlyContinue }

  if ($res.Exited -and ($res.ExitCode -ne 0) -and $failClosed -and (-not $scanned) -and (-not $parseError)) {
    Write-Kv "RESULT" "PASS"; exit 0
  }
  Write-Kv "RESULT" "FAIL"
  exit 1
}

if ($Lever -eq "ForgedEvidence") {
  Ensure-TmpDir
  $otherRoot = Join-Path $script:RepoRoot ".opencode\tmp\envs\spec2945"
  $obj = [ordered]@{
    envId           = "spec2944"
    servingCheckout = $otherRoot
    servedCommit    = "0000000000000000000000000000000000000000"
    dbPath          = (Join-Path $otherRoot "data")
    endpoints       = [ordered]@{
      vite     = 16000
      mcp      = 16001
      otlpGrpc = 16002
      otlpHttp = 16003
      llama    = 16004
      pipe     = "\\.\pipe\fredo-ipc-spec2945"
    }
    manifestPath = (Join-Path $otherRoot "manifest.json")
    appIdentity  = "com.fredo.app#spec2945"
  }
  [System.IO.File]::WriteAllText($script:ForgedEvidence, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Write-Kv "EVIDENCE_FILE" $script:ForgedEvidence
  Write-Kv "FREDO_EVIDENCE_FILE" $script:ForgedEvidence

  if (-not $RunAudit) {
    Write-Kv "RESULT" "PREPARED"
    exit 0
  }

  $env:FREDO_EVIDENCE_FILE = $script:ForgedEvidence
  $res = Invoke-BoundedChild -FilePath "rust-script" `
    -Arguments @(".opencode/scripts/pipeline-state.rs", "--action", "audit", "--issue", "$Spec") `
    -BoundSecs 120 -WorkingDirectory $script:RepoRoot
  Remove-Item Env:\FREDO_EVIDENCE_FILE -ErrorAction SilentlyContinue

  $text = "$($res.StdOut)`n$($res.StdErr)"
  $rejected = [bool](($res.ExitCode -ne 0) -or ($text -match "(?i)reject|cross-env|mismatch|unattributable|env.?tag"))
  Write-Kv "AUDIT_EXITCODE" "$($res.ExitCode)"
  Write-Kv "AUDIT_BOUNDED" "$($res.Exited)"
  Write-Kv "AUDIT_REJECTED" "$rejected"

  if (-not $Keep) { Remove-Item -LiteralPath $script:ForgedEvidence -ErrorAction SilentlyContinue }

  if ($res.Exited -and $rejected) { Write-Kv "RESULT" "PASS"; exit 0 }
  Write-Kv "RESULT" "FAIL"
  exit 1
}
