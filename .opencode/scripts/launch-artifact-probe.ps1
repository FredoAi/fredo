<#
.SYNOPSIS
  Launch a built Fredo GUI artifact, prove a set of TCP ports stays CLOSED, and
  tear the app + its embedded PostgreSQL down with no orphans.

.DESCRIPTION
  Committed replacement for the recurring ad-hoc
  `.opencode/tmp/<issue>/e2e/release-launch.ps1` script (Spec #3077). The job is
  deterministic, repeated and audited (the release MCP-bridge-closed AC), so it
  is a committed, allowlisted tool.

  Contract:
    * REFUSES an exe whose path contains a `\debug\` segment. A production /
      negative assertion MUST run against the release artifact.
    * Waits a BOUNDED time (default 40 s) with the app running.
    * Probes each port with a FAST TCP connect: TcpClient.BeginConnect + a
      600 ms wait. NEVER Test-NetConnection -- it stalls on CLOSED ports and was
      exactly the #3077 hang.
    * Scans stdout/stderr for the MCP bridge line `WebSocket server listening`.
    * Tears down the launched app, its descendant tree, and the embedded
      PostgreSQL that appeared during the launch window (scoped to the app-data
      dir). It NEVER kills a pre-existing postgres, so a live dev environment's
      cluster is not collateral damage.
    * Exits non-zero on a crash, an open port under -RequireClosed, the bridge
      log line under -RequireClosed, or leftover orphans.

  AC4 instrument extensions (Spec #3172 ST-5; the base launch contract above is
  unchanged):
    * -SanitizePath sets PATH for the launched process and every child probe to
      `C:\Windows\System32;C:\Windows` and prints `PATH_SANITISED=`.
    * Whenever a CLI leg below runs, its child process also runs with that
      sanitised PATH (Windows resolves a DLL import from the EXE's own directory
      first, so the install-dir payload is the only non-system source).
    * -CompanionProbe runs `<exe> companion probe` from the exe's directory and
      prints `PROBE_EXIT=`, `PROBE_SUCCESS=` and `PROBE_JSON=` (one line).
    * -RemoveDll copies the exe's directory to a temp dir under
      `.opencode/tmp/3172/`, deletes the named DLL FROM THE COPY ONLY, runs
      `<copy>\<exe> --version` with cwd = the copy, and prints
      `CONTROL_REMOVED_DLL=`, `CONTROL_EXIT=` and `CONTROL_EXPECTED_EXIT=`. The
      original tree is never touched.
    * The `--version` leg prints `VERSION_EXIT=` and `VERSION_STDOUT=` (first
      stdout line).

  DETACHMENT -- why the GUI app is launched by `Start-DetachedProcess`, not by
  `Start-Process` (Spec #3172 ST-5):
    PowerShell 5.1's `Start-Process -RedirectStandardOutput/-RedirectStandardError`
    calls Win32 `CreateProcess` with handle inheritance ON and NO handle
    whitelist, so the GUI child inherits EVERY inheritable handle of this
    process -- including the stdout/stderr PIPE handles of whoever invoked this
    script. The script then finishes and prints `RESULT=PASS`, yet an INLINE
    caller that reads this script's stdout to EOF (a tool call, `$(...)`,
    `Tee-Object`, `& powershell ... | ...`) blocks forever on the pipe, held open
    by the leftover app / WebView2 process tree.
    `Start-DetachedProcess` is a `CreateProcess` P/Invoke that passes
    EXTENDED_STARTUPINFO_PRESENT + STARTF_USESTDHANDLES +
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST whitelisting exactly THREE inheritable
    handles (stdin=NUL, stdout=<stdout.log>, stderr=<stderr.log>). The whitelist
    is the guarantee: no other handle of this process -- above all its own
    stdout/stderr pipe -- is inherited, so the launched app can never hold the
    caller's console. The helper returns the PID and the rest of the script keeps
    its `Get-Process -Id` semantics (HasExited / ExitCode / teardown).
    `.opencode/scripts/test-scripts.ps1` gates this by invoking `-SelfTest`
    INLINE with its stdout captured: if inheritance ever regresses, the harness
    itself blocks for the child's lifetime.

  DURATION AND PHASES (Spec #3172 ST-5):
    A normal run is TWO INDEPENDENT phases, each announced by a `PHASE=` marker
    carrying SINCE_START_SECONDS:
      PHASE=launch-window  the bounded GUI observation (-WaitSecs, default 40 s, 1..900)
                           plus the port/bridge assertions and teardown -- SECONDS.
      PHASE=cli-legs       `<exe> --version`, then, when asked,
                           PHASE=companion-probe and PHASE=dll-control.
    `-CompanionProbe` DOMINATES wall-clock time: it is a FULL model load plus one
    real engine turn -- MINUTES, not seconds. Immediately before it starts the
    script prints `COMPANION_PROBE_HINT=full model load + one turn; expect
    minutes`, so a reviewer cannot read that wait as "it hung".
    `-ProbeOnly` runs the CLI legs ALONE (no GUI launch, no port precheck, no
    bridge scan, no teardown) -- the expensive leg becomes independently
    re-runnable without spending the bounded window again. It is ADDITIVE: the
    combined invocation the durable suite prescribes
    (`-SanitizePath -CompanionProbe -RemoveDll llama-common.dll`) is unchanged
    and is still the AC4 invocation.

  CDP AND IN-WINDOW HOOK (Spec #3181 ST-2; additive, the base contract above is
  unchanged):
    * -CdpPort <n> (default 0/off) exports
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n> for the
      launched child. The detachment helper passes lpEnvironment = NULL, so the
      child inherits this process's environment and needs no new Win32 call. It
      prints `CDP_PORT=<n>` and REFUSES (RESULT=REFUSED, exit 2,
      ERROR=CDP_PORT_IN_USE) when the port is already listening, so a lingering
      webview can never be attributed to this launch. The CDP port is never part
      of -Ports.
    * -CdpProbe <path> runs that hook script INSIDE the same bounded launch
      window (the app process is still running; there is NO second launch
      primitive) with the GATE_* environment: GATE_EXE, GATE_CDP_PORT,
      GATE_DATA_DIR, GATE_LOG_DIR, GATE_WINDOW_SECS, GATE_ASSERTIONS. It prints
      `WINDOW_HOOK_EXIT=<n>` and `WINDOW_HOOK_SECONDS=<s>`. A non-zero hook exit
      folds into `FAILURE=window-hook:<n>`; a hook that outlives the bounded
      window is killed and folds into `FAILURE=window-hook-timeout:<s>`.
      A long hook -- the companion turn, bound 600 s -- needs a wider window:
      pass -WaitSecs = <companion bound> + settle time (up to 900); the hook's
      GATE_WINDOW_SECS inherits that bound.

  SELF-TEST (`-SelfTest`, hermetic -- no GUI artifact, no model, no ports):
      1 - DETACHED-LAUNCH  a deliberately long-lived child (`powershell.exe
                           -NoProfile -Command "Start-Sleep -Seconds 20"`, no
                           output) is launched THROUGH THE SAME detachment helper
                           the GUI uses. The helper must RETURN IN <= 5 s
                           (`DETACH_RETURN_SECONDS=`) while the child is still
                           alive. The child is NOT killed -- a leaked handle
                           would otherwise be masked by the kill; it exits on its
                           own 20 s later.
      2 - REFUSALS         a `\debug\` exe, `-RemoveDll 'a\b.dll'` and
                           `-WaitSecs 0` each still exit 2 with `RESULT=REFUSED`
                           (each invoked as a child of this script).
      3 - SELF-REFERENCE   the GUI launch site actually calls the detachment
                           helper (and the source still spells the handle-list
                           mechanism), so a future edit cannot silently revert to
                           plain `Start-Process`.
      4 - CDP-HOOK         a hermetic hook prints a token, exits 0 and asserts
                           GATE_CDP_PORT was passed; the runner reports
                           `WINDOW_HOOK_EXIT=0` and `WINDOW_HOOK_SECONDS=`.
      5 - CDP-HOOK-FAIL    a hermetic hook exits 1; the runner folds it into
                           `FAILURE=window-hook:1` (the named failure the live
                           path reports).
      6 - WAITSECS-RANGE   the real entry path accepts `-WaitSecs 900` and
                           rejects `901` (the upper clamp for a long hook).
      7 - PORTS-BIND       the COMMA-JOINED three-port form the release gate
                           passes (`-Ports 9223,16932,19631`) BINDS: it reaches
                           the typed missing-exe refusal (exit 2) instead of a
                           parameter-binder error. Also pins the single-port
                           form, the `;` and whitespace separators, and a
                           non-integer token refusal.
     8 - DETACHED-EXIT-CODE (`cmd /c exit 42` through Start-DetachedProcess) the
                           retained process handle makes
                           `Get-DetachedChildExitCode` return the SIGNED exit
                           code 42 -- the ONE exit-code seam.
     `SELFTEST: PASS` + exit 0 when every control passes.

  Windows-only (Win32 process enumeration). PowerShell 5.1-safe.

  Exit codes:
    0  PASS (with -SelfTest: every control passed)
    1  assertion failure (app exited / open port / bridge log line / probe error)
    2  refused precondition (debug exe, missing exe, bad args, stale listener)
    3  teardown left orphans (assertions may also have failed; FAILURE= lines say so)
       (with -SelfTest: a control failed)

.PARAMETER Exe
  Path to the built GUI app executable (the release `fredo.exe`), NOT the
  installer. A `\debug\` path is refused. Not required by -SelfTest.

.PARAMETER Ports
  TCP ports to probe, given as a specification: one or more decimal ports
  separated by `,`, `;` or whitespace (e.g. `9223,16932,19631`). Duplicates are
  deduped and order is preserved. It is a STRING, not an int array: under the
  native `powershell -File` boundary a comma-joined list arrives as one token,
  which an [int[]] parameter cannot bind. A PowerShell caller may still pass an
  int array -- PowerShell binds it as a space-joined string and the parser
  accepts it. Required unless -ProbeOnly (which launches nothing) is given.

.PARAMETER McpPort
  The port exported as FREDO_MCP_BASE_PORT. Default: the first -Ports value, so a
  release build that wrongly registered the bridge WOULD target a probed port.

.PARAMETER RequireClosed
  Fail (exit 1) when any probed port is open or the bridge log line appears.
  This is the mode for the release webview-security AC.

.PARAMETER WaitSecs
  Bounded observation window, seconds. Default 40. Clamped to 1..900.

  The upper bound is 900 (raised from 300) so a LONG in-window hook can run
  inside the window: when -CdpProbe drives the companion turn (bound 600 s), the
  caller passes -WaitSecs = <companion bound> + settle time and the hook's
  GATE_WINDOW_SECS inherits it. The launch-survival observation is still bounded
  by the caller -- a launch-only pass uses <= 300 s.

.PARAMETER DataDir
  Optional FREDO_DATA_DIR for the launched process. Isolates its PostgreSQL
  cluster and scopes teardown. Default: inherit the caller's FREDO_DATA_DIR,
  else the OS app-data dir.

.PARAMETER LogDir
  Directory for the captured stdout/stderr. Default:
  `.opencode/tmp/launch-artifact-probe/<timestamp>-<id>`.

.PARAMETER SanitizePath
  Set PATH for the launched process (and every child probe) to
  `C:\Windows\System32;C:\Windows`, and print `PATH_SANITISED=`. Needed for an
  AC4 receipt: a developer PATH exposes the Cargo target / Vulkan SDK, so a
  success there is not attributable to the install-dir payload.

.PARAMETER CompanionProbe
  After the launch observation (or alone under -ProbeOnly), run
  `<exe> companion probe` with the working directory set to the exe's directory
  and print `PROBE_EXIT=`, `PROBE_SUCCESS=` and `PROBE_JSON=`. This leg is a FULL
  model load plus one engine turn and DOMINATES wall-clock time (minutes).

.PARAMETER RemoveDll
  Name of a payload DLL (e.g. `llama-common.dll`) to delete from a COPY of the
  exe's directory, then run `<copy>\<exe> --version` and assert the loader exit
  `-1073741515` (`0xC0000135`; the unsigned form `3221225781` is accepted).
  The copy lives under `.opencode/tmp/3172/`; the original tree is never touched.

.PARAMETER ProbeOnly
  Skip the GUI launch, the port precheck, the bridge scan and teardown; run only
  the CLI legs (`--version`, and -CompanionProbe / -RemoveDll when supplied).
  The report prints `MODE=probe-only` and `ORPHANS_LEFT=0` (nothing was
  launched). Refused in combination with -RequireClosed, which has nothing to
  assert without a launch. Additive: without it the script behaves exactly as
  before.

.PARAMETER CdpPort
  Optional WebView2 DevTools port. Default 0 (off). When set, the launched child
  receives WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>, and
  the probe prints `CDP_PORT=<n>`. A port that is already listening is refused
  (exit 2, ERROR=CDP_PORT_IN_USE). The CDP port is not a -Ports value.

.PARAMETER CdpProbe
  Optional path to a hook script run INSIDE the bounded launch window, while the
  app is still running, with the GATE_* environment (GATE_EXE, GATE_CDP_PORT,
  GATE_DATA_DIR, GATE_LOG_DIR, GATE_WINDOW_SECS, GATE_ASSERTIONS). Prints
  `WINDOW_HOOK_EXIT=` and `WINDOW_HOOK_SECONDS=`; a non-zero exit becomes
  `FAILURE=window-hook:<n>` and a timeout becomes
  `FAILURE=window-hook-timeout:<s>`. Refused with -ProbeOnly (nothing is
  launched to run the hook inside).

.PARAMETER SelfTest
  Hermetic self-test of the detachment helper and the refusals (see the
  DESCRIPTION). Needs no artifact, no ports and no model. Exits 0 when every
  control passes, 3 on a control failure.

.PARAMETER DbReadySecs
  Database-ready bound handed to the -CdpProbe hook as GATE_DB_READY_SECS.
  Default 180.

.PARAMETER BootSettleSecs
  Boot-settle bound handed to the -CdpProbe hook as GATE_BOOT_SETTLE_SECS.
  Default 60.

.EXAMPLE
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe apps\tauri\src-tauri\target\release\fredo.exe -Ports 16932,9223 -RequireClosed

.EXAMPLE
  # -Ports is one or more decimal ports separated by , ; or whitespace. This is
  # the form the release gate passes; the native -File boundary delivers it as a
  # single comma-joined token, which the parser splits.
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe C:\install\fredo.exe -Ports 9223,16932,19631 -RequireClosed

.EXAMPLE
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe .\fredo.exe -Ports 16932 -McpPort 16932 -WaitSecs 20 -DataDir .opencode\tmp\probe-data

.EXAMPLE
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe C:\install\fredo.exe -Ports 16932 -SanitizePath -CompanionProbe -RemoveDll llama-common.dll

.EXAMPLE
  # The expensive leg alone, no bounded GUI window (expect MINUTES for the probe).
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe C:\install\fredo.exe -ProbeOnly -SanitizePath -CompanionProbe -RemoveDll llama-common.dll

.EXAMPLE
  powershell -File .opencode/scripts/launch-artifact-probe.ps1 -SelfTest
#>
param(
  [string]$Exe = '',
  [string]$Ports = '',
  [int]$McpPort = 0,
  [switch]$RequireClosed,
  [int]$WaitSecs = 40,
  [string]$DataDir = '',
  [string]$LogDir = '',
  [switch]$SanitizePath,
  [switch]$CompanionProbe,
  [string]$RemoveDll = '',
  [switch]$ProbeOnly,
  [switch]$SelfTest,
  [int]$CdpPort = 0,
  [string]$CdpProbe = '',
  [int]$DbReadySecs = 180,
  [int]$BootSettleSecs = 60
)

$ErrorActionPreference = 'Stop'

# The AC4 sanitised PATH: only the Windows system dirs, so the install-dir
# payload beside the exe is the only non-system DLL source.
$sanitizedPath = 'C:\Windows\System32;C:\Windows'

function Write-Probe {
  param([string]$Line)
  Write-Output $Line
}

# Wall-clock phase markers. A long run must be legible as a sequence of named
# phases (Spec #3172 ST-5): "it hung" is otherwise indistinguishable from "it is
# loading the model".
$script:ProbeWatch = [System.Diagnostics.Stopwatch]::StartNew()
function Write-Phase {
  param([string]$Name)
  Write-Probe ("PHASE={0} SINCE_START_SECONDS={1}" -f $Name, [Math]::Round($script:ProbeWatch.Elapsed.TotalSeconds, 1))
}

# ---- Resolve / validate inputs ------------------------------------------------
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$probePorts = @()
$exePath = ''

# Assertion selection forwarded to the -CdpProbe hook via GATE_ASSERTIONS. A
# caller (the release-artifact gate) may narrow it; the default is the full set
# the hook understands.
$gateAssertions = $env:GATE_ASSERTIONS
if ([string]::IsNullOrWhiteSpace($gateAssertions)) {
  $gateAssertions = 'styled,database,companion,screenshot'
}

# -SelfTest is hermetic: it needs no artifact, no ports and no model, so none of
# the artifact preconditions below apply to it.
if (-not $SelfTest) {
  if ($ProbeOnly -and $RequireClosed) {
    Write-Probe 'ERROR: -ProbeOnly launches nothing, so -RequireClosed (a port/bridge assertion) has nothing to assert. Drop one of them.'
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  # -Ports is a SPECIFICATION, not an [int[]]. Under the native
  # `powershell -File` boundary a comma-joined list (9223,16932,19631) arrives
  # as ONE string token; an [int[]] parameter cannot bind it and the child dies
  # in the parameter binder before any probe line is printed (the round-1
  # defect). Accept one or more decimal ports separated by ',', ';' or
  # whitespace; dedupe and preserve order. A PowerShell caller that still passes
  # an int[] is bound to a space-joined string by PowerShell and parses here.
  $probeSeen = @{}
  foreach ($token in @($Ports -split '[,;\s]+')) {
    if ([string]::IsNullOrWhiteSpace($token)) { continue }
    $value = 0
    if (-not [int]::TryParse($token, [ref]$value)) {
      Write-Probe "ERROR: port is not an integer: $token"
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
    if ($value -lt 1 -or $value -gt 65535) {
      Write-Probe "ERROR: port out of range: $value"
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
    if (-not $probeSeen.ContainsKey($value)) {
      $probeSeen[$value] = $true
      $probePorts += [int]$value
    }
  }

  if ($probePorts.Count -eq 0 -and -not $ProbeOnly) {
    Write-Probe 'ERROR: -Ports must name at least one TCP port.'
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  if ($WaitSecs -lt 1 -or $WaitSecs -gt 900) {
    Write-Probe "ERROR: -WaitSecs must be 1..900 (got $WaitSecs)."
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  if ($DbReadySecs -lt 1 -or $DbReadySecs -gt 3600) {
    Write-Probe "ERROR: -DbReadySecs must be 1..3600 (got $DbReadySecs)."
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  if ($BootSettleSecs -lt 1 -or $BootSettleSecs -gt 3600) {
    Write-Probe "ERROR: -BootSettleSecs must be 1..3600 (got $BootSettleSecs)."
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  if ([string]::IsNullOrWhiteSpace($Exe)) {
    Write-Probe "ERROR: missing exe: $Exe"
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  if (-not (Test-Path -LiteralPath $Exe)) {
    Write-Probe "ERROR: missing exe: $Exe"
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  $exePath = (Resolve-Path -LiteralPath $Exe).Path
  $exeNormalized = $exePath.ToLowerInvariant().Replace('/', '\')
  if ($exeNormalized.Contains('\debug\')) {
    Write-Probe "ERROR: refusing a debug artifact (a production/negative AC must use the release build): $exePath"
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  if (-not $ProbeOnly) {
    if ($McpPort -eq 0) { $McpPort = $probePorts[0] }
    if ($McpPort -lt 1 -or $McpPort -gt 65535) {
      Write-Probe "ERROR: -McpPort out of range: $McpPort"
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($RemoveDll)) {
    if ($RemoveDll.Contains('\') -or $RemoveDll.Contains('/') -or $RemoveDll -eq '.' -or $RemoveDll -eq '..') {
      Write-Probe "ERROR: -RemoveDll must be a bare DLL file name (got '$RemoveDll')."
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
  }

  if ($CdpPort -ne 0 -and ($CdpPort -lt 1 -or $CdpPort -gt 65535)) {
    Write-Probe "ERROR: -CdpPort out of range (got $CdpPort)."
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }

  if (-not [string]::IsNullOrWhiteSpace($CdpProbe)) {
    if ($ProbeOnly) {
      Write-Probe 'ERROR: -CdpProbe runs inside the bounded launch window, but -ProbeOnly launches nothing. Drop one of them.'
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
    if (-not (Test-Path -LiteralPath $CdpProbe -PathType Leaf)) {
      Write-Probe "ERROR: -CdpProbe hook script not found: $CdpProbe"
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
    $CdpProbe = (Resolve-Path -LiteralPath $CdpProbe).Path
  }
}

# ---- Log directory ------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $LogDir = Join-Path $repoRoot ".opencode\tmp\launch-artifact-probe\$stamp-$suffix"
} else {
  $LogDir = [System.IO.Path]::GetFullPath($LogDir)
}
try {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
} catch {
  Write-Probe "ERROR: cannot create log dir ${LogDir}: $($_.Exception.Message)"
  Write-Probe 'RESULT=REFUSED'
  exit 2
}
$stdoutPath = Join-Path $LogDir 'stdout.log'
$stderrPath = Join-Path $LogDir 'stderr.log'

# ---- Process / port helpers ---------------------------------------------------
function Test-TcpPortOpen {
  param([int]$Port, [int]$TimeoutMs = 600)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch {}
  }
}

# Ask the OS for an ephemeral loopback port by binding 127.0.0.1:0, then release
# it. Retries a bounded number of times; returns 0 when no port could be bound.
# The release gate uses this to hand the launched profile deterministic, free
# OTLP ingest ports so two runs (or a live dev instance) never collide.
function Get-FreeTcpPort {
  param([int]$Attempts = 5)
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    try {
      $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
      $listener.Start()
      $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
      $listener.Stop()
      return [int]$port
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  return 0
}

function Get-AllProcesses {
  try {
    return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    return @()
  }
}

function Get-DescendantPids {
  param([int]$RootPid)
  $all = Get-AllProcesses
  $children = @{}
  foreach ($proc in $all) {
    $ppid = [int]$proc.ParentProcessId
    if (-not $children.ContainsKey($ppid)) {
      $children[$ppid] = New-Object System.Collections.ArrayList
    }
    [void]$children[$ppid].Add([int]$proc.ProcessId)
  }
  $result = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $current = [int]$queue.Dequeue()
    if ($children.ContainsKey($current)) {
      foreach ($child in $children[$current]) {
        [void]$result.Add($child)
        $queue.Enqueue($child)
      }
    }
  }
  return @($result)
}

function Get-PostgresPids {
  try {
    return @(Get-Process -Name 'postgres' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
  } catch {
    return @()
  }
}

function Read-LogHits {
  param([string[]]$Files, [string]$Pattern, [int]$Attempts = 10)
  $total = 0
  $complete = $true
  foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $ok = $false
    for ($i = 0; $i -lt $Attempts; $i++) {
      try {
        $total += @(Select-String -LiteralPath $file -Pattern $Pattern -SimpleMatch -ErrorAction Stop).Count
        $ok = $true
        break
      } catch {
        Start-Sleep -Milliseconds 200
      }
    }
    if (-not $ok) { $complete = $false }
  }
  return @{ Hits = $total; Complete = $complete }
}

# ---------------------------------------------------------------------------
# Detachment helper (Spec #3172 ST-5; extracted to detach-process.psm1 in Spec
# #3181 round 3 so the gate, the negative module and the exit-code wrapper all
# share the ONE whitelist spawn).
#
# WHY / HOW: see the module header in detach-process.psm1. The module
# CreateProcess's with EXTENDED_STARTUPINFO_PRESENT + STARTF_USESTDHANDLES +
# PROC_THREAD_ATTRIBUTE_HANDLE_LIST (exactly stdin=NUL, stdout=<log>,
# stderr=<log>), so no caller pipe handle crosses the process boundary. The GUI
# launch calls Start-DetachedProcess; every bounded child runner calls
# Start-DetachedProcess + Wait-DetachedChild. There is no second spawn path
# (G-450).
# ---------------------------------------------------------------------------
Import-Module (Join-Path $PSScriptRoot 'detach-process.psm1') -ErrorAction Stop

# Run a CLI child to completion with explicit stdio and return its exit code
# (null when the launch itself failed). A release build is a windows-subsystem
# binary: its stdout is only reachable through redirected handles, never through
# the console. The child is spawned through the shared handle-whitelist helper
# (G-450), so even a CLI child that starts a grandchild can never hold the
# caller's pipe; Wait-DetachedChild waits for THIS direct child only.
function Invoke-ArtifactCli {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$StdOutPath,
    [string]$StdErrPath
  )
  try {
    $argString = ''
    foreach ($argument in @($ArgumentList)) {
      $text = [string]$argument
      if ($text -match '[\s"]') { $text = '"' + $text.Replace('"', '\"') + '"' }
      if ($argString.Length -gt 0) { $argString += ' ' }
      $argString += $text
    }
    $childPid = Start-DetachedProcess -FilePath $FilePath -ArgumentString $argString -WorkingDirectory $WorkingDirectory -StdOutPath $StdOutPath -StdErrPath $StdErrPath
    $code = Wait-DetachedChild -ProcessId $childPid
    if ($null -eq $code) {
      # [Console]::Out.Write* (never Write-Probe/Write-Output): the caller captures
      # this function's entire output stream as the child's exit code, so a
      # pipeline write would become an element of THAT value instead of reaching
      # the probe's stdout. Route human lines to the process console (Stream B).
      [Console]::Out.WriteLine("ERROR: child exited without a readable code ${FilePath}")
      return $null
    }
    return [int]$code
  } catch {
    [Console]::Out.WriteLine("ERROR: child launch failed ${FilePath}: $($_.Exception.Message)")
    return $null
  }
}

function Get-FirstOutputLine {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try {
    $lines = @(Get-Content -LiteralPath $Path -TotalCount 1)
  } catch {
    return ''
  }
  if ($lines.Count -eq 0) { return '' }
  return ([string]$lines[0]).Trim()
}

# Run the -CdpProbe hook INSIDE the bounded launch window, while the app process
# is still running. The hook is a child PowerShell process so a hung hook can be
# KILLED at the window bound -- a child launched through Start-DetachedProcess
# would outlive the bound and defeat the "bounded window" contract. This is NOT a
# GUI launch: the ONE GUI primitive remains Start-DetachedProcess above.
function Invoke-WindowHook {
  param(
    [string]$HookPath,
    [string]$ExePath,
    [int]$CdpPort,
    [string]$DataDir,
    [string]$ProbeLogDir,
    [int]$WindowSecs,
    [string]$Assertions,
    [string]$PgDataDir = '',
    [int]$DbReadySecs = 180,
    [int]$BootSettleSecs = 60
  )

  if ([string]::IsNullOrWhiteSpace($Assertions)) {
    $Assertions = 'styled,database,companion,screenshot'
  }

  # Binding hook environment (Spec #3181, section A; round 4 adds the profile
  # seams). The child inherits these.
  $env:GATE_EXE = $ExePath
  $env:GATE_CDP_PORT = [string]$CdpPort
  $env:GATE_DATA_DIR = $DataDir
  $env:GATE_LOG_DIR = $ProbeLogDir
  $env:GATE_WINDOW_SECS = [string]$WindowSecs
  $env:GATE_ASSERTIONS = $Assertions
  $env:GATE_PG_DATA_DIR = $PgDataDir
  $env:GATE_DB_READY_SECS = [string]$DbReadySecs
  $env:GATE_BOOT_SETTLE_SECS = [string]$BootSettleSecs

  $hookOut = Join-Path $ProbeLogDir 'window-hook-stdout.log'
  $hookErr = Join-Path $ProbeLogDir 'window-hook-stderr.log'
  $hookExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

  $exitCode = $null
  $timedOut = $false
  $seconds = 0.0
  $stdoutText = ''
  $stderrText = ''
  $stdoutComplete = $true
  $stderrComplete = $true
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = $null
  try {
    # System.Diagnostics.Process (not Start-Process -PassThru): the latter closes
    # the child handle when -Wait is absent, leaving ExitCode unreadable -- which
    # would silently turn a failing hook into a pass. This keeps the handle, so
    # the exit code IS the hook's own under the bounded wait.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $hookExe
    $psi.Arguments = '-NoProfile -File "' + $HookPath + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $boundMs = $WindowSecs * 1000
    if (-not $proc.WaitForExit($boundMs)) {
      $timedOut = $true
      try { $proc.Kill() } catch {}
      try { $proc.WaitForExit(5000) | Out-Null } catch {}
    }
    # The int overload does not flush the redirected streams; the no-arg one does.
    try { $proc.WaitForExit() } catch {}
    # BOUNDED read (G-450): ReadToEndAsync completes on EOF. A grandchild the hook
    # started can hold the hook's stdout pipe past the hook's own exit, so .Result
    # would block indefinitely. Wait(5000) bounds the read; on expiry keep what we
    # have ('') and surface the incompleteness rather than hanging the caller.
    try {
      if ($outTask.Wait(5000)) { $stdoutText = $outTask.Result } else { $stdoutText = ''; $stdoutComplete = $false }
    } catch { $stdoutText = ''; $stdoutComplete = $false }
    try {
      if ($errTask.Wait(5000)) { $stderrText = $errTask.Result } else { $stderrText = ''; $stderrComplete = $false }
    } catch { $stderrText = ''; $stderrComplete = $false }
  } catch {
    [Console]::Out.WriteLine("ERROR: window hook launch failed: $($_.Exception.Message)")
    $timedOut = $true
  } finally {
    $watch.Stop()
    $seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1)
  }

  # Persist the hook transcript as evidence, beside the run logs.
  try { [System.IO.File]::WriteAllText($hookOut, $stdoutText) } catch {}
  try { [System.IO.File]::WriteAllText($hookErr, $stderrText) } catch {}

  if (-not $timedOut -and $null -ne $proc -and $proc.HasExited) {
    try { $exitCode = [int]$proc.ExitCode } catch { $exitCode = $null }
  }
  # Surface the hook's own stdout so a caller sees the token/line it printed.
  # CRITICAL (Stream B): this function's return value IS the output stream the
  # live caller captures (`$hookResult = Invoke-WindowHook ...`), so emitting a
  # hook line through the PowerShell pipeline here would fold it into
  # `$hookResult` and never reach the probe's stdout file. Emit to the process
  # console instead, so the documented CHECK / BOOT_SETTLE / DB_EFFECTIVE_DIR /
  # WINDOW_HOOK_* literals land in run-*/launch-report.log (and the negative
  # leg's probe.stdout.log), and `$hookResult` is exactly one object.
  foreach ($line in ($stdoutText -split "`r?`n")) {
    if (-not [string]::IsNullOrWhiteSpace($line)) { [Console]::Out.WriteLine($line) }
  }
  [Console]::Out.Flush()

  $exitText = if ($null -ne $exitCode) { [string]$exitCode } else { 'timeout' }
  [Console]::Out.WriteLine("WINDOW_HOOK_EXIT=$exitText")
  [Console]::Out.WriteLine("WINDOW_HOOK_SECONDS=$seconds")
  if (-not $stdoutComplete) { [Console]::Out.WriteLine('WINDOW_HOOK_STDOUT_INCOMPLETE=true') }
  if (-not $stderrComplete) { [Console]::Out.WriteLine('WINDOW_HOOK_STDERR_INCOMPLETE=true') }

  $failureName = ''
  if ($timedOut) {
    $failureName = "window-hook-timeout:$seconds"
  } elseif ($null -eq $exitCode) {
    $failureName = 'window-hook:error'
  } elseif ($exitCode -ne 0) {
    $failureName = "window-hook:$exitCode"
  }

  return [pscustomobject]@{
    Exit = $exitCode
    Seconds = $seconds
    TimedOut = $timedOut
    StdOut = $stdoutText
    FailureName = $failureName
  }
}

# ---- AC4 CLI legs (--version / companion probe / remove-one-DLL control) ------
# Shared by the combined run and -ProbeOnly so ONE implementation emits the
# VERSION_* / PROBE_* / CONTROL_* literals. Each phase announces itself: a
# minutes-long companion probe must be legible as a phase, never as a hang.
function Invoke-CliLegs {
  param(
    [string]$ExePath,
    [string]$LegsLogDir,
    [switch]$DoCompanionProbe,
    [string]$RemoveDllName,
    [System.Collections.ArrayList]$Failures
  )

  # Every child probe runs with the sanitised PATH: a developer PATH exposes the
  # Cargo target dir / Vulkan SDK, which is exactly the false pass AC4 rejects.
  $env:PATH = $sanitizedPath
  $exeDir = Split-Path -Parent $ExePath
  $exeLeaf = Split-Path -Leaf $ExePath

  Write-Phase 'cli-legs'

  # 1) --version leg (R-4.1).
  $versionOut = Join-Path $LegsLogDir 'version-stdout.log'
  $versionErr = Join-Path $LegsLogDir 'version-stderr.log'
  $versionExit = Invoke-ArtifactCli -FilePath $ExePath -ArgumentList @('--version') -WorkingDirectory $exeDir -StdOutPath $versionOut -StdErrPath $versionErr
  $versionStdout = Get-FirstOutputLine -Path $versionOut
  $versionExitText = if ($null -ne $versionExit) { [string]$versionExit } else { 'error' }
  Write-Probe "VERSION_EXIT=$versionExitText"
  Write-Probe "VERSION_STDOUT=$versionStdout"
  if ($null -eq $versionExit -or $versionExit -ne 0) {
    [void]$Failures.Add("version-exit:$versionExitText")
  }

  # 2) companion probe leg (R-4.2): cwd = the exe's directory so the sibling
  #    payload DLLs resolve. This is a FULL model load + one engine turn, so the
  #    hint line names the expected duration BEFORE the wait begins.
  if ($DoCompanionProbe) {
    Write-Phase 'companion-probe'
    Write-Probe 'COMPANION_PROBE_HINT=full model load + one turn; expect minutes'
    $probeOut = Join-Path $LegsLogDir 'companion-probe-stdout.log'
    $probeErr = Join-Path $LegsLogDir 'companion-probe-stderr.log'
    $probeExit = Invoke-ArtifactCli -FilePath $ExePath -ArgumentList @('companion', 'probe') -WorkingDirectory $exeDir -StdOutPath $probeOut -StdErrPath $probeErr
    $probeJson = ''
    if (Test-Path -LiteralPath $probeOut) {
      try {
        foreach ($line in @(Get-Content -LiteralPath $probeOut)) {
          $trimmed = ([string]$line).Trim()
          if ($trimmed.StartsWith('{')) { $probeJson = $trimmed; break }
        }
      } catch {
        $probeJson = ''
      }
    }
    $probeSuccess = $false
    if (-not [string]::IsNullOrWhiteSpace($probeJson)) {
      try {
        $probeReport = $probeJson | ConvertFrom-Json
        if ($null -ne $probeReport.PSObject.Properties['success']) {
          $probeSuccess = [bool]$probeReport.success
        }
      } catch {
        $probeSuccess = $false
      }
    }
    $probeExitText = if ($null -ne $probeExit) { [string]$probeExit } else { 'error' }
    $probeSuccessText = if ($probeSuccess) { 'true' } else { 'false' }
    Write-Probe "PROBE_EXIT=$probeExitText"
    Write-Probe "PROBE_SUCCESS=$probeSuccessText"
    Write-Probe "PROBE_JSON=$probeJson"
    if ($null -eq $probeExit -or $probeExit -ne 0) {
      [void]$Failures.Add("probe-exit:$probeExitText")
    }
    if (-not $probeSuccess) {
      [void]$Failures.Add('probe-success-false')
    }
  }

  # 3) remove-one-DLL loader control (R-4.3). The copy is the ONLY thing
  #    mutated; the install tree under test is never touched.
  if (-not [string]::IsNullOrWhiteSpace($RemoveDllName)) {
    Write-Phase 'dll-control'
    $controlExpectedExit = -1073741515
    $copyRoot = Join-Path $repoRoot (".opencode\tmp\3172\control-copy-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $controlExit = $null
    $dllRemoved = $false
    try {
      New-Item -ItemType Directory -Path $copyRoot -Force | Out-Null
      Copy-Item -Path (Join-Path $exeDir '*') -Destination $copyRoot -Recurse -Force -ErrorAction Stop
      $copyExe = Join-Path $copyRoot $exeLeaf
      $copyDll = Join-Path $copyRoot $RemoveDllName
      if (Test-Path -LiteralPath $copyDll) {
        Remove-Item -LiteralPath $copyDll -Force -ErrorAction Stop
        $dllRemoved = $true
      }
      $controlOut = Join-Path $LegsLogDir 'control-stdout.log'
      $controlErr = Join-Path $LegsLogDir 'control-stderr.log'
      $controlExit = Invoke-ArtifactCli -FilePath $copyExe -ArgumentList @('--version') -WorkingDirectory $copyRoot -StdOutPath $controlOut -StdErrPath $controlErr
    } catch {
      Write-Probe "ERROR: remove-one-DLL control failed: $($_.Exception.Message)"
    } finally {
      # A just-exited child can still hold its image file for a moment (image
      # section release / AV scan), so ONE Remove-Item can leave a partial copy
      # behind. Bounded retry; the source install tree is never touched either way.
      for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if (-not (Test-Path -LiteralPath $copyRoot)) { break }
        Remove-Item -LiteralPath $copyRoot -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $copyRoot)) { break }
        Start-Sleep -Milliseconds 300
      }
    }
    $controlExitText = if ($null -ne $controlExit) { [string]$controlExit } else { 'error' }
    Write-Probe "CONTROL_REMOVED_DLL=$RemoveDllName"
    Write-Probe "CONTROL_EXIT=$controlExitText"
    Write-Probe "CONTROL_EXPECTED_EXIT=$controlExpectedExit"
    if (-not $dllRemoved) {
      [void]$Failures.Add("control-dll-missing:$RemoveDllName")
    }
    $controlMatched = $false
    if ($null -ne $controlExit) {
      $observedUnsigned = [int64]$controlExit
      if ($observedUnsigned -lt 0) { $observedUnsigned += 4294967296 }
      if ($observedUnsigned -eq 3221225781) { $controlMatched = $true }
    }
    if (-not $controlMatched) {
      [void]$Failures.Add("control-exit:$controlExitText")
    }
  }
}

# ---- Self-test (hermetic: no GUI artifact, no model, no ports) ---------------
# This mode is the regression gate for the inline-caller hang: the harness runs
# it INLINE with the stdout captured, so a reverted (inheriting) launch would
# block the harness for the control child's lifetime.
if ($SelfTest) {
  Write-Probe '=== launch-artifact-probe : SelfTest ==='
  $selfPath = $PSCommandPath
  if ([string]::IsNullOrWhiteSpace($selfPath)) { $selfPath = $MyInvocation.MyCommand.Path }
  $controlFailures = 0
  $detachChildPid = 0
  $selfTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("fredo-probe-selftest-" + [Guid]::NewGuid().ToString('N'))

  try {
    # ---- CONTROL 1 - DETACHED-LAUNCH ------------------------------------
    # The child is deliberately long-lived and produces NO output. It is NOT
    # killed: the helper must return while the child is still alive, because a
    # leaked stdout handle would otherwise be masked by the kill. It exits on its
    # own 20 s later.
    Write-Probe 'CONTROL 1 - DETACHED-LAUNCH'
    $childExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $detachSeconds = $null
    try {
      $detachWatch = [System.Diagnostics.Stopwatch]::StartNew()
      $detachChildPid = Start-DetachedProcess -FilePath $childExe -ArgumentString '-NoProfile -Command "Start-Sleep -Seconds 20"' -WorkingDirectory '' -StdOutPath '' -StdErrPath ''
      $detachWatch.Stop()
      $detachSeconds = [Math]::Round($detachWatch.Elapsed.TotalSeconds, 1)
    } catch {
      Write-Probe ("  [FAIL] the detachment helper threw: {0}" -f $_.Exception.Message)
      $controlFailures++
    }
    if ($null -ne $detachSeconds) {
      Write-Probe "DETACH_RETURN_SECONDS=$detachSeconds"
      Write-Probe "DETACH_CHILD_PID=$detachChildPid"
      $detachChildAlive = $false
      try {
        $detachChildAlive = ($null -ne (Get-Process -Id $detachChildPid -ErrorAction SilentlyContinue))
      } catch {
        $detachChildAlive = $false
      }
      Write-Probe "DETACH_CHILD_ALIVE=$detachChildAlive"
      if ($detachSeconds -gt 5) {
        Write-Probe ("  [FAIL] the helper took {0}s (must return in <= 5s while the child lives)" -f $detachSeconds)
        $controlFailures++
      } elseif (-not $detachChildAlive) {
        Write-Probe '  [FAIL] the 20-second child had already exited - the control measured nothing'
        $controlFailures++
      } else {
        Write-Probe ("  [PASS] returned in {0}s with the child (pid {1}) still running; it is NOT killed and exits on its own" -f $detachSeconds, $detachChildPid)
      }
    }

    # ---- CONTROL 2 - REFUSALS -------------------------------------------
    # Each refusal is asserted by invoking THIS script as a child, so the exit
    # code and the RESULT= line are observed exactly as a caller sees them.
    Write-Probe 'CONTROL 2 - REFUSALS'
    New-Item -ItemType Directory -Path (Join-Path $selfTmp 'debug') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $selfTmp 'release') -Force | Out-Null
    $debugExe = Join-Path $selfTmp 'debug\fredo.exe'
    $releaseExe = Join-Path $selfTmp 'release\fredo.exe'
    [System.IO.File]::WriteAllText($debugExe, '')
    [System.IO.File]::WriteAllText($releaseExe, '')
    $refusalCases = @(
      @{ Name = 'debug-exe'; Args = @('-Exe', $debugExe, '-Ports', '16932') },
      @{ Name = 'remove-dll-path'; Args = @('-Exe', $releaseExe, '-Ports', '16932', '-RemoveDll', 'a\b.dll') },
      @{ Name = 'waitsecs-zero'; Args = @('-Exe', $releaseExe, '-Ports', '16932', '-WaitSecs', '0') }
    )
    foreach ($refusalCase in $refusalCases) {
      $childArgs = $refusalCase.Args
      try {
        $refusalOut = & powershell -NoProfile -File $selfPath @childArgs 2>&1
        $refusalCode = $LASTEXITCODE
        $refusalText = if ($refusalOut -is [array]) { $refusalOut -join "`n" } else { "$refusalOut" }
        $refused = $refusalText.Contains('RESULT=REFUSED')
        if ($refusalCode -eq 2 -and $refused) {
          Write-Probe ("  [PASS] {0}: exit 2 + RESULT=REFUSED" -f $refusalCase.Name)
        } else {
          Write-Probe ("  [FAIL] {0}: exit {1}, RESULT=REFUSED={2}" -f $refusalCase.Name, $refusalCode, $refused)
          $controlFailures++
        }
      } catch {
        Write-Probe ("  [FAIL] {0}: the child invocation threw: {1}" -f $refusalCase.Name, $_.Exception.Message)
        $controlFailures++
      }
    }

    # ---- CONTROL 3 - SELF-REFERENCE -------------------------------------
    # The GUI launch site must call the detachment helper, the WHITELIST MECHANISM
    # must still be spelled in the shared module (it moved there in Spec #3181
    # round 3, so a future edit cannot silently revert to plain Start-Process),
    # and this script must import the module.
    Write-Probe 'CONTROL 3 - SELF-REFERENCE'
    $selfSource = ''
    if (-not [string]::IsNullOrWhiteSpace($selfPath) -and (Test-Path -LiteralPath $selfPath)) {
      $selfSource = [System.IO.File]::ReadAllText($selfPath)
    }
    $modulePath = Join-Path $PSScriptRoot 'detach-process.psm1'
    $moduleSource = ''
    if (Test-Path -LiteralPath $modulePath) {
      $moduleSource = [System.IO.File]::ReadAllText($modulePath)
    }
    $launchUsesHelper = ($selfSource -match '(?m)^\s*\$launchPid\s*=\s*Start-DetachedProcess\b')
    $importsModule = $selfSource.Contains("detach-process.psm1")
    # Built by concatenation so this assertion's own text is not the needle it
    # searches for (a literal here would match itself and never regress).
    $plainLaunchNeedle = 'Start-Process -FilePath ' + '$exePath'
    $plainLaunchOfExe = $selfSource.Contains($plainLaunchNeedle)
    $hasHandleList = $moduleSource.Contains('PROC_THREAD_ATTRIBUTE_HANDLE_LIST')
    $hasExtendedStartup = $moduleSource.Contains('EXTENDED_STARTUPINFO_PRESENT')
    $hasStdHandlesFlag = $moduleSource.Contains('STARTF_USESTDHANDLES')
    Write-Probe ("  launch site uses the helper: {0}; imports module: {1}; plain Start-Process of the exe: {2}; whitelist mechanism present in module: {3}/{4}/{5}" -f $launchUsesHelper, $importsModule, $plainLaunchOfExe, $hasHandleList, $hasExtendedStartup, $hasStdHandlesFlag)
    if (-not $launchUsesHelper) {
      Write-Probe '  [FAIL] the GUI launch site does not call Start-DetachedProcess'
      $controlFailures++
    } elseif (-not $importsModule) {
      Write-Probe '  [FAIL] the script does not import detach-process.psm1'
      $controlFailures++
    } elseif ($plainLaunchOfExe) {
      Write-Probe '  [FAIL] the source still launches $exePath through a plain Start-Process'
      $controlFailures++
    } elseif (-not ($hasHandleList -and $hasExtendedStartup -and $hasStdHandlesFlag)) {
      Write-Probe '  [FAIL] the handle-whitelist mechanism is gone from detach-process.psm1'
      $controlFailures++
    } else {
      Write-Probe '  [PASS] the GUI launch site calls the detachment helper, imports the module, and the whitelist mechanism is intact'
    }

    # ---- CONTROL 4 - CDP-HOOK -------------------------------------------
    # The hook runs through the SAME runner the live path uses and receives the
    # binding GATE_* environment. The hermetic hook asserts GATE_CDP_PORT and
    # prints a token; a missing/mispassed value is a control failure.
    Write-Probe 'CONTROL 4 - CDP-HOOK'
    try {
      $hookDir = Join-Path $selfTmp 'cdp-hook-ok'
      New-Item -ItemType Directory -Path $hookDir -Force | Out-Null
      $hookOkPath = Join-Path $hookDir 'hook-ok.ps1'
      $hookOkSource = @'
param()
if ($env:GATE_CDP_PORT -ne '9411') { Write-Output ("GATE_CDP_PORT_MISMATCH=" + $env:GATE_CDP_PORT); exit 4 }
Write-Output 'CDP_HOOK_TOKEN=OK'
Write-Output ("GATE_CDP_PORT_SEEN=" + $env:GATE_CDP_PORT)
exit 0
'@
      [System.IO.File]::WriteAllText($hookOkPath, $hookOkSource, [System.Text.UTF8Encoding]::new($false))
      $hookOk = Invoke-WindowHook -HookPath $hookOkPath -ExePath $childExe -CdpPort 9411 -DataDir $hookDir -ProbeLogDir $hookDir -WindowSecs 30 -Assertions 'styled'
      $okToken = $hookOk.StdOut.Contains('CDP_HOOK_TOKEN=OK')
      $okPort = $hookOk.StdOut.Contains('GATE_CDP_PORT_SEEN=9411')
      if (($hookOk.Exit -eq 0) -and $okToken -and $okPort -and [string]::IsNullOrWhiteSpace($hookOk.FailureName)) {
        Write-Probe '  [PASS] the hook ran with GATE_CDP_PORT=9411 and exited 0'
      } else {
        Write-Probe ("  [FAIL] exit={0} token={1} port={2} stdout={3}" -f $hookOk.Exit, $okToken, $okPort, $hookOk.StdOut)
        $controlFailures++
      }
    } catch {
      Write-Probe ("  [FAIL] CDP hook control threw: {0}" -f $_.Exception.Message)
      $controlFailures++
    }

    # ---- CONTROL 5 - CDP-HOOK-FAIL --------------------------------------
    # A non-zero hook exit must fold into the named FAILURE=window-hook:<n>.
    Write-Probe 'CONTROL 5 - CDP-HOOK-FAIL'
    try {
      $hookDirFail = Join-Path $selfTmp 'cdp-hook-fail'
      New-Item -ItemType Directory -Path $hookDirFail -Force | Out-Null
      $hookFailPath = Join-Path $hookDirFail 'hook-fail.ps1'
      $hookFailSource = @'
param()
Write-Output 'CDP_HOOK_TOKEN=FAIL'
exit 1
'@
      [System.IO.File]::WriteAllText($hookFailPath, $hookFailSource, [System.Text.UTF8Encoding]::new($false))
      $hookFail = Invoke-WindowHook -HookPath $hookFailPath -ExePath $childExe -CdpPort 9411 -DataDir $hookDirFail -ProbeLogDir $hookDirFail -WindowSecs 30 -Assertions 'styled'
      if (($hookFail.Exit -eq 1) -and ($hookFail.FailureName -eq 'window-hook:1')) {
        Write-Probe '  [PASS] a hook exiting 1 folds into FAILURE=window-hook:1'
      } else {
        Write-Probe ("  [FAIL] exit={0} failure={1} stdout={2}" -f $hookFail.Exit, $hookFail.FailureName, $hookFail.StdOut)
        $controlFailures++
      }
    } catch {
      Write-Probe ("  [FAIL] CDP hook-fail control threw: {0}" -f $_.Exception.Message)
      $controlFailures++
    }

    # ---- CONTROL 6 - WAITSECS-RANGE -------------------------------------
    # The upper clamp is 900 (not 300) so a long in-window hook (the companion
    # turn, bound 600 s) fits. Both legs drive the REAL entry path as a child:
    #   * 900 is ACCEPTED -- with a missing exe the refusal is "missing exe",
    #     which can only happen if the -WaitSecs guard let 900 through;
    #   * 901 is REJECTED by the upper clamp.
    Write-Probe 'CONTROL 6 - WAITSECS-RANGE'
    try {
      $missingExe = Join-Path $selfTmp 'no-such-dir\fredo.exe'
      $out900 = & powershell -NoProfile -File $selfPath @('-Exe', $missingExe, '-Ports', '16932', '-WaitSecs', '900') 2>&1
      $code900 = $LASTEXITCODE
      $text900 = if ($out900 -is [array]) { $out900 -join "`n" } else { "$out900" }
      $accepted900 = ($code900 -eq 2) -and
                     $text900.Contains('missing exe') -and
                     (-not $text900.Contains('-WaitSecs must be'))

      $out901 = & powershell -NoProfile -File $selfPath @('-Exe', $missingExe, '-Ports', '16932', '-WaitSecs', '901') 2>&1
      $code901 = $LASTEXITCODE
      $text901 = if ($out901 -is [array]) { $out901 -join "`n" } else { "$out901" }
      $rejected901 = ($code901 -eq 2) -and
                     $text901.Contains('-WaitSecs must be 1..900') -and
                     $text901.Contains('RESULT=REFUSED')

      if ($accepted900 -and $rejected901) {
        Write-Probe '  [PASS] -WaitSecs accepts 900 and rejects 901'
      } else {
        Write-Probe ("  [FAIL] accepted900={0} rejected901={1} out900={2} out901={3}" -f $accepted900, $rejected901, $text900, $text901)
        $controlFailures++
      }
    } catch {
      Write-Probe ("  [FAIL] WaitSecs range control threw: {0}" -f $_.Exception.Message)
      $controlFailures++
    }

    # ---- CONTROL 7 - PORTS-BIND -----------------------------------------
    # The release gate passes the port list as ONE comma-joined token over the
    # native `powershell -File` boundary. An [int[]] parameter cannot bind that
    # token (the round-1 defect: the child died in the parameter binder before
    # printing any probe line). The string spec + parser must instead reach the
    # typed missing-exe refusal. Every leg drives the REAL entry path as a child
    # with a non-existent exe, so nothing is launched; the single-port leg is
    # the one-variable discriminator, and the non-int leg proves the parser is
    # real (not a pass-through).
    Write-Probe 'CONTROL 7 - PORTS-BIND'
    try {
      $portMissingExe = Join-Path $selfTmp 'no-such-dir\fredo.exe'

      $outComma = & powershell -NoProfile -File $selfPath @('-Exe', $portMissingExe, '-Ports', '9223,16932,19631') 2>&1
      $codeComma = $LASTEXITCODE
      $textComma = if ($outComma -is [array]) { $outComma -join "`n" } else { "$outComma" }
      $commaBinds = ($codeComma -eq 2) -and
                    $textComma.Contains('ERROR: missing exe') -and
                    $textComma.Contains('RESULT=REFUSED') -and
                    (-not $textComma.Contains('Cannot convert value')) -and
                    (-not $textComma.Contains('ParameterArgumentTransformationError')) -and
                    (-not $textComma.Contains('must name at least one TCP port'))

      $outSingle = & powershell -NoProfile -File $selfPath @('-Exe', $portMissingExe, '-Ports', '9223') 2>&1
      $codeSingle = $LASTEXITCODE
      $textSingle = if ($outSingle -is [array]) { $outSingle -join "`n" } else { "$outSingle" }
      $singleBinds = ($codeSingle -eq 2) -and $textSingle.Contains('ERROR: missing exe')

      $outSemi = & powershell -NoProfile -File $selfPath @('-Exe', $portMissingExe, '-Ports', '9223;16932') 2>&1
      $codeSemi = $LASTEXITCODE
      $textSemi = if ($outSemi -is [array]) { $outSemi -join "`n" } else { "$outSemi" }
      $semiBinds = ($codeSemi -eq 2) -and $textSemi.Contains('ERROR: missing exe')

      $outSpace = & powershell -NoProfile -File $selfPath @('-Exe', $portMissingExe, '-Ports', '9223 16932') 2>&1
      $codeSpace = $LASTEXITCODE
      $textSpace = if ($outSpace -is [array]) { $outSpace -join "`n" } else { "$outSpace" }
      $spaceBinds = ($codeSpace -eq 2) -and $textSpace.Contains('ERROR: missing exe')

      $outBad = & powershell -NoProfile -File $selfPath @('-Exe', $portMissingExe, '-Ports', '9223,x') 2>&1
      $codeBad = $LASTEXITCODE
      $textBad = if ($outBad -is [array]) { $outBad -join "`n" } else { "$outBad" }
      $badRejected = ($codeBad -eq 2) -and
                     $textBad.Contains('ERROR: port is not an integer: x') -and
                     $textBad.Contains('RESULT=REFUSED')

      if ($commaBinds -and $singleBinds -and $semiBinds -and $spaceBinds -and $badRejected) {
        Write-Probe '  [PASS] -Ports 9223,16932,19631 binds (single-port control + ; and whitespace separators + non-int refusal)'
      } else {
        Write-Probe ("  [FAIL] comma={0} single={1} semicolon={2} space={3} badToken={4}" -f $commaBinds, $singleBinds, $semiBinds, $spaceBinds, $badRejected)
        Write-Probe ("    comma exit={0} text={1}" -f $codeComma, $textComma)
        Write-Probe ("    bad exit={0} text={1}" -f $codeBad, $textBad)
        $controlFailures++
      }
    } catch {
      Write-Probe ("  [FAIL] ports-bind control threw: {0}" -f $_.Exception.Message)
      $controlFailures++
    }

    # ---- CONTROL 8 - DETACHED-EXIT-CODE --------------------------------
    # The ONE exit-code seam (A1): a child is launched through the SAME primitive
    # the GUI uses, `cmd /c exit 42` exits, and the non-blocking handle read must
    # return the SIGNED exit code -- never a Process object re-opened by PID.
    Write-Probe 'CONTROL 8 - DETACHED-EXIT-CODE'
    try {
      $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
      $exitChildPid = 0
      $detachedExit = $null
      $detachedStatus = 'unreadable'
      $exitChildPid = Start-DetachedProcess -FilePath $cmdExe -ArgumentString '/c exit 42' -WorkingDirectory '' -StdOutPath '' -StdErrPath ''
      $exitDeadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $exitDeadline) {
        $exitProbe = Get-DetachedChildExitCode -ProcessId $exitChildPid
        $detachedStatus = $exitProbe.Status
        if ($exitProbe.Status -eq 'observed') { $detachedExit = $exitProbe.Code; break }
        if ($exitProbe.Status -eq 'unreadable') { break }
        Start-Sleep -Milliseconds 100
      }
      Write-Probe "DETACHED_CHILD_EXIT=$detachedExit"
      Write-Probe "DETACHED_CHILD_EXIT_STATUS=$detachedStatus"
      if ($detachedStatus -eq 'observed' -and $detachedExit -eq 42) {
        Write-Probe '  [PASS] the retained handle returns the signed exit code 42'
      } else {
        Write-Probe ("  [FAIL] status={0} exit={1} (expected observed 42)" -f $detachedStatus, $detachedExit)
        $controlFailures++
      }
      if ($exitChildPid -gt 0) { Close-DetachedChild -ProcessId $exitChildPid }
    } catch {
      Write-Probe ("  [FAIL] detached exit-code control threw: {0}" -f $_.Exception.Message)
      $controlFailures++
    }

    # ---- CONTROL 9 - HOOK-TRANSCRIPT-SURFACED --------------------------
    # Stream B regression pin. Invoke-WindowHook's return value IS the output
    # stream the live caller captures ($hookResult = Invoke-WindowHook ...), so a
    # pipeline write inside that function folds every hook line into $hookResult
    # and the driver never sees CHECK / BOOT_SETTLE / DB_EFFECTIVE_DIR /
    # WINDOW_HOOK_*. This is a SOURCE invariant (the CONTROL 3 pattern): read the
    # function's own slice and require it to emit to the process console, with
    # zero pipeline writes. It needs no artifact and launches nothing.
    Write-Probe 'CONTROL 9 - HOOK-TRANSCRIPT-SURFACED'
    $hookSource = $selfSource
    if ([string]::IsNullOrWhiteSpace($hookSource) -and (Test-Path -LiteralPath $selfPath)) {
      $hookSource = [System.IO.File]::ReadAllText($selfPath)
    }
    $hookFnText = ''
    if (-not [string]::IsNullOrWhiteSpace($hookSource)) {
      $hookFnMatch = [regex]::Match($hookSource, '(?ms)^function Invoke-WindowHook\b.*?^\}')
      if ($hookFnMatch.Success) { $hookFnText = $hookFnMatch.Value }
    }
    $hookHasConsoleWrite = $hookFnText.Contains('[Console]::Out.WriteLine')
    $hookHasProbeWrite = $hookFnText.Contains('Write-Probe')
    $hookHasOutputWrite = $hookFnText.Contains('Write-Output')
    Write-Probe ("  Invoke-WindowHook slice chars={0}; console-write={1}; pipeline-write={2}/{3}" -f $hookFnText.Length, $hookHasConsoleWrite, $hookHasProbeWrite, $hookHasOutputWrite)
    if ($hookFnText.Length -eq 0) {
      Write-Probe '  [FAIL] could not locate the function Invoke-WindowHook slice in the source'
      $controlFailures++
    } elseif (-not $hookHasConsoleWrite) {
      Write-Probe '  [FAIL] Invoke-WindowHook never emits to the process console (its transcript would fold into the return value)'
      $controlFailures++
    } elseif ($hookHasProbeWrite -or $hookHasOutputWrite) {
      Write-Probe '  [FAIL] Invoke-WindowHook still writes through the pipeline (Write-Probe/Write-Output)'
      $controlFailures++
    } else {
      Write-Probe '  [PASS] Invoke-WindowHook emits its transcript to the process console and never through the pipeline'
    }
  } finally {
    if ($detachChildPid -gt 0) {
      # Deliberately NOT killed: the child must outlive this script, so a leaked
      # handle cannot be masked by the kill. Report whether it is still alive.
      $leftRunning = $false
      try {
        $leftRunning = ($null -ne (Get-Process -Id $detachChildPid -ErrorAction SilentlyContinue))
      } catch {
        $leftRunning = $false
      }
      Write-Probe "DETACH_CHILD_LEFT_RUNNING=$leftRunning"
    }
    if (Test-Path -LiteralPath $selfTmp) {
      Remove-Item -LiteralPath $selfTmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  if ($controlFailures -eq 0) {
    Write-Probe 'SELFTEST: PASS'
    exit 0
  }
  Write-Probe ("SELFTEST: FAIL ({0} control failure(s))" -f $controlFailures)
  exit 3
}

# ---- Preconditions: no stale listener may be attributed to this launch -------
$exeItem = Get-Item -LiteralPath $exePath
Write-Probe 'PROBE=launch-artifact'
Write-Probe "EXE=$exePath"
Write-Probe "EXE_SIZE_BYTES=$($exeItem.Length)"
Write-Probe "EXE_LAST_WRITE_UTC=$($exeItem.LastWriteTimeUtc.ToString('o'))"

if ($ProbeOnly) {
  # No launch, so no precheck and no attribution question: the ports are simply
  # not probed (that is the point of -ProbeOnly).
  Write-Probe 'MODE=probe-only'
} else {
  Write-Probe "MCP_PORT=$McpPort"
  Write-Probe "WAIT_SECONDS=$WaitSecs"

  Write-Phase 'launch-window'
  foreach ($port in $probePorts) {
    $open = Test-TcpPortOpen -Port $port
    Write-Probe ("PRECHECK_PORT_{0}={1}" -f $port, $(if ($open) { 'open' } else { 'closed' }))
    if ($open) {
      Write-Probe "ERROR: port $port is already open -- a stale app or dev instance owns it; stop the owner and re-run. The probe will not attribute a pre-existing listener to this launch."
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
  }

  # The DevTools port must be free BEFORE the launch, so a lingering webview from
  # a previous run can never be read as this artifact's CDP endpoint.
  if ($CdpPort -ne 0) {
    $cdpOpen = Test-TcpPortOpen -Port $CdpPort
    Write-Probe ("PRECHECK_CDP_PORT_{0}={1}" -f $CdpPort, $(if ($cdpOpen) { 'open' } else { 'closed' }))
    if ($cdpOpen) {
      Write-Probe "ERROR=CDP_PORT_IN_USE port=$CdpPort"
      Write-Probe 'RESULT=REFUSED'
      exit 2
    }
  }
}

# ---- Environment --------------------------------------------------------------
if (-not $ProbeOnly) { $env:FREDO_MCP_BASE_PORT = "$McpPort" }
if ($CdpPort -ne 0) {
  # The detachment helper passes lpEnvironment = NULL, so the launched child
  # inherits this variable and WebView2 opens its DevTools endpoint on the port.
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
  Write-Probe "CDP_PORT=$CdpPort"
}
if ($SanitizePath) {
  # Applied BEFORE the launch so the child inherits it; the child CLI legs below
  # inherit it too.
  $env:PATH = $sanitizedPath
  Write-Probe "PATH_SANITISED=$sanitizedPath"
}
if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
  $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
  try {
    New-Item -ItemType Directory -Path $resolvedDataDir -Force | Out-Null
  } catch {
    Write-Probe "ERROR: cannot create -DataDir ${resolvedDataDir}: $($_.Exception.Message)"
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }
  $env:FREDO_DATA_DIR = $resolvedDataDir
}
if (-not [string]::IsNullOrWhiteSpace($env:FREDO_DATA_DIR)) {
  $appDataDir = $env:FREDO_DATA_DIR
} elseif (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  $appDataDir = Join-Path $env:APPDATA 'com.fredo.app'
} else {
  $appDataDir = ''
}

# ---- Profile seams (DB / WebView2 / OTLP) ------------------------------------
# The gate drives a RELEASE profile. Point the product's own override knobs at
# the run's -DataDir so the cluster, its lock and the WebView2 user data are all
# inside the profile teardown owns (and the dirty seed at
# <DataDir>\postgres\cluster\start.log is exactly <FREDO_PG_DATA_DIR>\start.log).
# The seams apply only when a data dir is supplied; without one the caller is
# using the real profile and this probe must not create anything in it.
$pgDataDir = ''
$pgLockDir = ''
$webview2Dir = ''
if (-not [string]::IsNullOrWhiteSpace($env:FREDO_DATA_DIR)) {
  $profileBase = $env:FREDO_DATA_DIR
  $pgDataDir = Join-Path (Join-Path $profileBase 'postgres') 'cluster'
  $pgLockDir = Join-Path $profileBase 'pg-lock'
  $webview2Dir = Join-Path $profileBase 'webview2'
  try {
    New-Item -ItemType Directory -Path $pgDataDir -Force | Out-Null
    New-Item -ItemType Directory -Path $pgLockDir -Force | Out-Null
    New-Item -ItemType Directory -Path $webview2Dir -Force | Out-Null
  } catch {
    Write-Probe "ERROR: cannot create the profile dirs under ${profileBase}: $($_.Exception.Message)"
    Write-Probe 'RESULT=REFUSED'
    exit 2
  }
  $env:FREDO_PG_DATA_DIR = $pgDataDir
  $env:FREDO_PG_LOCK_DIR = $pgLockDir
  $env:WEBVIEW2_USER_DATA_FOLDER = $webview2Dir
}

# Deterministic, FREE OTLP ingest ports, so the launched profile owns them for
# this run and can never collide with a live dev instance or a prior run.
$otlpGrpcPort = 0
$otlpHttpPort = 0
$otlpOk = $false
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  $otlpGrpcPort = Get-FreeTcpPort
  $otlpHttpPort = Get-FreeTcpPort
  if ($otlpGrpcPort -gt 0 -and $otlpHttpPort -gt 0 -and $otlpGrpcPort -ne $otlpHttpPort) {
    $otlpOk = $true
    break
  }
}
if (-not $otlpOk) {
  Write-Probe 'ERROR=OTLP_PORTS_UNAVAILABLE'
  Write-Probe 'RESULT=REFUSED'
  exit 2
}
$env:FREDO_INGEST_GRPC_PORT = "$otlpGrpcPort"
$env:FREDO_INGEST_HTTP_PORT = "$otlpHttpPort"

Write-Probe "APP_DATA_DIR=$appDataDir"
Write-Probe "PG_DATA_DIR=$pgDataDir"
Write-Probe "WEBVIEW2_USER_DATA_DIR=$webview2Dir"
Write-Probe "OTLP_PORTS=$otlpGrpcPort,$otlpHttpPort"

# ---- -ProbeOnly: the CLI legs alone, no bounded window -----------------------
# Same leg implementation as the combined run, minus the launch/port/bridge/
# teardown phases. Nothing was launched, so ORPHANS_LEFT is honestly 0.
if ($ProbeOnly) {
  Write-Phase 'probe-only'
  $probeOnlyFailures = New-Object System.Collections.ArrayList
  Invoke-CliLegs -ExePath $exePath -LegsLogDir $LogDir -DoCompanionProbe:$CompanionProbe -RemoveDllName $RemoveDll -Failures $probeOnlyFailures
  Write-Phase 'report'
  Write-Probe ("ELAPSED_SECONDS={0}" -f [Math]::Round($script:ProbeWatch.Elapsed.TotalSeconds, 1))
  Write-Probe 'ORPHANS_LEFT=0'
  Write-Probe "LOG_DIR=$LogDir"
  foreach ($failure in $probeOnlyFailures) { Write-Probe "FAILURE=$failure" }
  if ($probeOnlyFailures.Count -gt 0) {
    Write-Probe 'RESULT=FAIL'
    exit 1
  }
  Write-Probe 'RESULT=PASS'
  exit 0
}

$pgMatchDirs = @()
if (-not [string]::IsNullOrWhiteSpace($appDataDir)) { $pgMatchDirs += $appDataDir.ToLowerInvariant() }
if (-not [string]::IsNullOrWhiteSpace($env:FREDO_PG_DATA_DIR)) { $pgMatchDirs += $env:FREDO_PG_DATA_DIR.ToLowerInvariant() }

$beforePg = Get-PostgresPids

# ---- Launch + bounded observation --------------------------------------------
$p = $null
$launchPid = 0
$launchError = $null
$appExited = $false
$appExitCode = $null
$exitCodeStatus = 'not-exited'
$elapsedSeconds = 0.0
$portState = @{}
$bridgeHits = 0
$logComplete = $false
$descendants = @()
$targetPg = @()
$descendantsKilled = 0
$postgresKilled = 0
$windowHookFailure = ''

try {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    # DETACHED launch: only stdin=NUL / stdout=<stdout.log> / stderr=<stderr.log>
    # may be inherited, so this script's own stdout/stderr pipe is never handed
    # to the app (see the Start-DetachedProcess comment). Plain Start-Process
    # here is what hung inline callers.
    $launchPid = Start-DetachedProcess -FilePath $exePath -ArgumentString '' -WorkingDirectory '' -StdOutPath $stdoutPath -StdErrPath $stderrPath
    $p = Get-Process -Id $launchPid -ErrorAction Stop
  } catch {
    $launchError = "launch failed: $($_.Exception.Message)"
    throw
  }
  Write-Probe "PID=$($p.Id)"

  # -CdpProbe: run the hook INSIDE the launch window, while the app is still
  # running. A non-zero exit or a timeout becomes a FAILURE= line in the report.
  if (-not [string]::IsNullOrWhiteSpace($CdpProbe)) {
    Write-Phase 'window-hook'
    $hookResult = Invoke-WindowHook -HookPath $CdpProbe -ExePath $exePath -CdpPort $CdpPort -DataDir $appDataDir -ProbeLogDir $LogDir -WindowSecs $WaitSecs -Assertions $gateAssertions -PgDataDir $pgDataDir -DbReadySecs $DbReadySecs -BootSettleSecs $BootSettleSecs
    if (-not [string]::IsNullOrWhiteSpace($hookResult.FailureName)) {
      $windowHookFailure = $hookResult.FailureName
    }
  }

  $deadline = (Get-Date).AddSeconds($WaitSecs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) {
      $appExited = $true
      break
    }
  }
  $elapsedSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1)
  if ($appExited) {
    # The ONE exit-code read: the retained launch handle (A1). A re-opened
    # Process object cannot read ExitCode after the detached child exits here.
    $exitProbe = Get-DetachedChildExitCode -ProcessId $launchPid
    if ($exitProbe.Status -eq 'observed') {
      $appExitCode = [int]$exitProbe.Code
      $exitCodeStatus = 'observed'
    } else {
      $exitCodeStatus = 'unreadable'
    }
  }

  foreach ($port in $probePorts) {
    $portState[$port] = Test-TcpPortOpen -Port $port
  }

  $descendants = @(Get-DescendantPids -RootPid $p.Id)

  $firstRead = Read-LogHits -Files @($stdoutPath, $stderrPath) -Pattern 'WebSocket server listening'
  $bridgeHits = [int]$firstRead.Hits
  $logComplete = [bool]$firstRead.Complete
} catch {
  if ($null -eq $p) {
    $launchError = "launch failed: $($_.Exception.Message)"
  } else {
    $launchError = "probe error: $($_.Exception.Message)"
  }
} finally {
  if ($null -ne $p) {
    # 1) Kill the app's descendant tree, deepest first, before the parent dies
    #    (a reparented child would otherwise escape the tree).
    [array]::Reverse($descendants)
    foreach ($childPid in $descendants) {
      try {
        Stop-Process -Id $childPid -Force -ErrorAction Stop
        $descendantsKilled++
      } catch {}
    }

    # 2) Kill ONLY postgres processes that appeared during this launch window
    #    and belong to this app-data dir. A pre-existing cluster (a live dev
    #    environment) is never touched.
    $afterPg = Get-PostgresPids
    $newPg = @($afterPg | Where-Object { $beforePg -notcontains $_ })
    foreach ($pgPid in $newPg) {
      $commandLine = $null
      try {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$pgPid" -ErrorAction SilentlyContinue
        if ($null -ne $cim) { $commandLine = $cim.CommandLine }
      } catch {}
      $attributable = $true
      if ($pgMatchDirs.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($commandLine)) {
        $attributable = $false
        foreach ($dir in $pgMatchDirs) {
          if ($commandLine.ToLowerInvariant().Contains($dir)) { $attributable = $true; break }
        }
      }
      if ($attributable) {
        try {
          Stop-Process -Id $pgPid -Force -ErrorAction Stop
          $postgresKilled++
          $targetPg += [int]$pgPid
        } catch {
          $targetPg += [int]$pgPid
        }
      }
    }

    # 3) Stop the app itself.
    if (-not $p.HasExited) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    $exitDeadline = (Get-Date).AddSeconds(5)
    while (-not $p.HasExited -and (Get-Date) -lt $exitDeadline) {
      Start-Sleep -Milliseconds 200
    }

    # 4) Release the retained launch handle (A1). Done LAST so the exit-code read
    #    during the window used the handle, not a re-opened Process object.
    if ($launchPid -gt 0) {
      try { Close-DetachedChild -ProcessId $launchPid } catch {}
    }
  }
}

if ($null -eq $p) {
  Write-Probe "ERROR: $launchError"
  Write-Probe 'RESULT=REFUSED'
  exit 2
}

# ---- Post-teardown evidence ---------------------------------------------------
$secondRead = Read-LogHits -Files @($stdoutPath, $stderrPath) -Pattern 'WebSocket server listening'
if ([int]$secondRead.Hits -gt $bridgeHits) { $bridgeHits = [int]$secondRead.Hits }
$logComplete = $logComplete -and [bool]$secondRead.Complete

$stdoutBytes = 0
$stderrBytes = 0
try { $stdoutBytes = (Get-Item -LiteralPath $stdoutPath -ErrorAction SilentlyContinue).Length } catch {}
try { $stderrBytes = (Get-Item -LiteralPath $stderrPath -ErrorAction SilentlyContinue).Length } catch {}

$appAlive = -not $p.HasExited
$orphanDescendants = @()
foreach ($childPid in $descendants) {
  try {
    if ($null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) { $orphanDescendants += [int]$childPid }
  } catch {}
}
$orphanPostgres = @()
foreach ($pgPid in $targetPg) {
  try {
    if ($null -ne (Get-Process -Id $pgPid -ErrorAction SilentlyContinue)) { $orphanPostgres += [int]$pgPid }
  } catch {}
}
$orphans = $orphanPostgres.Count + $orphanDescendants.Count
if ($appAlive) { $orphans++ }

# ---- Assertions ---------------------------------------------------------------
$failures = New-Object System.Collections.ArrayList
if ($null -ne $launchError) { [void]$failures.Add("probe-error: $launchError") }
if ($appExited) { [void]$failures.Add('app-exited') }
if (-not [string]::IsNullOrWhiteSpace($windowHookFailure)) { [void]$failures.Add($windowHookFailure) }

# ---- AC4 CLI legs (--version / companion probe / remove-one-DLL control) ------
# ONE implementation (Invoke-CliLegs), shared with -ProbeOnly, so the VERSION_* /
# PROBE_* / CONTROL_* literals cannot drift between the two entry points.
$runCliLegs = $SanitizePath -or $CompanionProbe -or (-not [string]::IsNullOrWhiteSpace($RemoveDll))
if ($runCliLegs) {
  Invoke-CliLegs -ExePath $exePath -LegsLogDir $LogDir -DoCompanionProbe:$CompanionProbe -RemoveDllName $RemoveDll -Failures $failures
}

if ($RequireClosed) {
  foreach ($port in $probePorts) {
    if ($portState[$port]) { [void]$failures.Add("port-open:$port") }
  }
  if ($bridgeHits -gt 0) { [void]$failures.Add('bridge-log-line') }
}

# ---- Report -------------------------------------------------------------------
Write-Phase 'report'
Write-Probe "ELAPSED_SECONDS=$elapsedSeconds"
Write-Probe "HAS_EXITED=$appExited"
Write-Probe "EXIT_CODE_STATUS=$exitCodeStatus"
if ($null -ne $appExitCode) { Write-Probe "EXIT_CODE=$appExitCode" }
foreach ($port in $probePorts) {
  Write-Probe ("PORT_{0}={1}" -f $port, $(if ($portState[$port]) { 'open' } else { 'closed' }))
}
Write-Probe "BRIDGE_LOG_HITS=$bridgeHits"
Write-Probe "LOG_READ_COMPLETE=$logComplete"
Write-Probe "STDOUT=$stdoutPath"
Write-Probe "STDERR=$stderrPath"
Write-Probe "STDOUT_BYTES=$stdoutBytes"
Write-Probe "STDERR_BYTES=$stderrBytes"
Write-Probe "DESCENDANTS_KILLED=$descendantsKilled"
Write-Probe "POSTGRES_KILLED=$postgresKilled"
Write-Probe "ORPHANS_LEFT=$orphans"
if ($orphanPostgres.Count -gt 0) { Write-Probe "ORPHAN_POSTGRES_PIDS=$($orphanPostgres -join ',')" }
if ($orphanDescendants.Count -gt 0) { Write-Probe "ORPHAN_DESCENDANT_PIDS=$($orphanDescendants -join ',')" }
foreach ($failure in $failures) { Write-Probe "FAILURE=$failure" }

if ($failures.Count -gt 0) {
  Write-Probe 'RESULT=FAIL'
  exit 1
}
if ($orphans -gt 0) {
  Write-Probe 'RESULT=FAIL'
  exit 3
}
Write-Probe 'RESULT=PASS'
exit 0
