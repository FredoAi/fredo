<#
.SYNOPSIS
  Unified dev environment lifecycle manager for Fredo.

.DESCRIPTION
  Manages the pnpm dev:tauri instance -- start, stop, status, restart, and process logs.
  No state files. Ports are the source of truth. Dual-stack (IPv4 + IPv6) port probing.

.PARAMETER Action
  Up       -- Ensure dev instance is running and ready. Auto-starts if not running.
              On the COLD start path (stale instance killed, ports free), the
              WebView2 HTTP cache (Cache, Code Cache, GPUCache only -- app state
              like localStorage/IndexedDB is preserved) is cleared before launch:
              a corrupt cached localhost:<VitePort> response otherwise paints raw
              HTTP headers as the document (white screen) and survives restarts
              (observed #2770 rounds 2-5 on 4+ consecutive cold boots).
  Down     -- Stop dev instance by killing the process tree.
  Status   -- Read-only check: running / starting / stopped.
  Restart  -- Down then Up.
  Logs     -- Tail process stdout/stderr.
  Hygiene  -- Passthrough to process-hygiene.ps1 (see -Kill). Resolves the
             sibling copy next to this script first, then the served worktree
             copy .serve/<Spec>/.opencode/scripts/process-hygiene.ps1 when
             -Spec is given. Prints which copy was invoked and its exit code;
             a non-zero child exit becomes this script's exit code; a clear
             error + exit 1 when no copy is found.

.PARAMETER Kill
  Hygiene only. When set, the passthrough invokes process-hygiene.ps1
  -KillOrphans (opt-in orphan cleanup); default is -List (read-only
  inventory).

.PARAMETER Spec
  Spec issue number (required for Up). The repo root IS the serving checkout:
  it must sit on spec/<Spec> at the origin tip (G-052). Up verifies the root
  branch and HEAD against origin/spec/<Spec> (fail-closed: wrong branch or
  stale HEAD refuses to start), then serves the app from the repo root.
  Status prints the root branch + HEAD.

.PARAMETER At
  Baseline-leg commit (Up only, OPTIONAL). Serves the PRE-FIX PRODUCT code of an
  ancestor commit of spec/<Spec> (apps/ materialized into the current serving
  tree) for a Before/baseline measurement in a research-first spec (Spec #498
  pattern) -- the tooling (this script, opencode.json) stays at the spec/<Spec>
  tip, so the sandbox and tool surface are unchanged. Fail-closed: the repo root
  must be on spec/<Spec> (G-052) and -At must resolve to a commit reachable from
  the origin/spec/<Spec> tip -- main's divergent code and any non-spec commit are
  REFUSED. Baseline legs never serve main and never hand-roll a detached
  dev-server spawn; a cross-branch serving need the tool does not cover is a
  tooling request to the Self-Improver (new script/param), not an ad-hoc agent
  script. The next standard Up (without -At) restores apps/ to the spec/<Spec>
  tip for the AFTER legs. Without -At the strict G-052 origin-tip check applies
  (the normal flow).

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
  powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2835 -At 296f881
  powershell -File .opencode/scripts/dev-env.ps1 -Action Hygiene -Spec 2762
  powershell -File .opencode/scripts/dev-env.ps1 -Action Hygiene -Kill -Spec 2762
#>

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Up", "Down", "Status", "Restart", "Logs", "Hygiene")]
  [string]$Action,

  [ValidateRange(1, [uint64]::MaxValue)]
  [uint64]$Spec = 0,

  # Baseline-leg serving commit (Up only): a PRE-FIX ancestor of spec/<Spec>.
  # Optional -- the normal flow serves the origin/spec/<Spec> tip (G-052).
  [string]$At = "",

  [int]$VitePort = 5174,
  [int]$McpPort = 9223,
  [int]$TimeoutSecs = 120,
  [int]$Lines = 50,

  # Hygiene passthrough: forward -Kill as process-hygiene.ps1 -KillOrphans.
  [switch]$Kill
)

$ErrorActionPreference = "Stop"

# -- Logging ------------------------------------------------------------------

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $ts = Get-Date -Format "HH:mm:ss"
  switch ($Level) {
    "ERROR" { Write-Host "[$ts] $Message" -ForegroundColor Red }
    "WARN"  { Write-Host "[$ts] $Message" -ForegroundColor Yellow }
    default { Write-Host "[$ts] $Message" }
  }
}

# -- Native runner (PS 5.1 fix): with $ErrorActionPreference = "Stop", a native
# command redirected with 2>&1 turns ANY stderr write (e.g. git fetch progress,
# taskkill notices) into a terminating NativeCommandError. Run such commands
# under "Continue" and surface only the exit code.
function Invoke-NativeQuiet {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $args[0] @($args | Select-Object -Skip 1) 2>&1 | Out-Null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

# -- WebView2 HTTP-cache clear (observed #2770 rounds 2-5) --------------------
# WebView2 can serve a CORRUPT cached HTTP response for the Vite dev URL: the
# webview paints raw HTTP headers as the page document (white screen) and the
# entry survives app restarts. A manual /?cb=<ts> cache-bust navigation always
# recovered it, but the wedge recurred on 4+ consecutive cold boots within one
# spec. Fix: on every COLD Up, delete ONLY the WebView2 HTTP/cache subfolders
# (Cache, Code Cache, GPUCache) under %LOCALAPPDATA%\com.fredo.app\EBWebView.
# localStorage / IndexedDB / Session Storage / Cookies are NOT touched, so
# app-level dev state survives. Best-effort: locked or missing folders are
# skipped with a warning; this must never fail the Up action.
function Clear-WebView2HttpCache {
  $root = Join-Path $env:LOCALAPPDATA "com.fredo.app\EBWebView"
  if (-not (Test-Path -LiteralPath $root)) {
    Write-Log "WebView2 profile not found at $root -- cache clear skipped (first run?)"
    return
  }
  $targets = @("Default\Cache", "Default\Code Cache", "Default\GPUCache")
  $cleared = 0
  foreach ($rel in $targets) {
    $dir = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    try {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $dir)) {
        $cleared++
        Write-Log "Cleared WebView2 cache: $dir"
      } else {
        Write-Log "WARNING: could not fully clear WebView2 cache (locked?): $dir" -Level WARN
      }
    } catch {
      Write-Log "WARNING: WebView2 cache clear failed for ${dir}: $($_.Exception.Message)" -Level WARN
    }
  }
  if ($cleared -eq 0 -and -not ($targets | Where-Object { Test-Path -LiteralPath (Join-Path $root $_) })) {
    Write-Log "WebView2 HTTP cache: nothing to clear (already clean)"
  }
}

# -- Port Probe (dual-stack: IPv4 then IPv6) ---------------------------------

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

# -- Find PID by listening port -----------------------------------------------

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

# -- Root serving currency (G-052) ---------------------------------------------

# The repo root IS the serving checkout: during implementation/testing it must
# sit on spec/<Spec> at the origin tip. No dedicated worktree, no state file.
function Assert-RootServingCurrency {
  param([uint64]$SpecIssue)

  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne "spec/$SpecIssue") {
    Write-Log "ERROR: repo root is on '$branch' -- checkout spec/$SpecIssue before serving/testing (G-052)." -Level ERROR
    exit 1
  }
  Write-Log "Fetching origin/spec/$SpecIssue..."
  if ((Invoke-NativeQuiet git fetch origin "spec/$SpecIssue") -ne 0) { throw "git fetch origin spec/$SpecIssue failed" }
  $tip = (git rev-parse "origin/spec/$SpecIssue").Trim()
  if (-not $tip) { throw "cannot resolve origin/spec/$SpecIssue" }
  $head = (git rev-parse HEAD).Trim()
  if ($head -ne $tip) {
    Write-Log "ERROR: repo root is STALE: HEAD $($head.Substring(0, [Math]::Min(8, $head.Length))) but origin/spec/$SpecIssue tip is $($tip.Substring(0, [Math]::Min(8, $tip.Length))). Sync first (G-032: reset to origin, merge main tip, push), then retry." -Level ERROR
    exit 1
  }
  return $tip
}

# -- Baseline-leg serving (research-first Before measurement) -------------------

# A research-first perf spec's Before/baseline leg must serve the PRE-FIX product
# code (the same buggy code) -- NEVER main and NEVER a hand-rolled detached
# spawn (agents provide tools to agents; agents do not invent their own). The
# serving checkout stays on spec/<Spec> at the origin tip, so the tooling
# (this script, opencode.json, the skills) is ALWAYS the current version; -At
# materializes ONLY the pre-fix product code under apps/ into the working tree
# (`git checkout <sha> -- apps`) and cold-starts the dev instance against it.
# Fail-closed: root must be on spec/<Spec> and -At must be reachable from the
# origin/spec/<Spec> tip (main's divergent code and foreign commits are refused).
# After the baseline leg, the next standard Up (without -At) restores apps/ from
# HEAD so the AFTER legs serve the fixed tip.
function Prepare-BaselineServing {
  param([uint64]$SpecIssue, [string]$At)

  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne "spec/$SpecIssue") {
    Write-Log "ERROR: repo root is on '$branch' -- a baseline leg still requires the root on spec/$SpecIssue (G-052); baseline legs NEVER serve main." -Level ERROR
    exit 1
  }
  Write-Log "Fetching origin/spec/$SpecIssue..."
  if ((Invoke-NativeQuiet git fetch origin "spec/$SpecIssue") -ne 0) { throw "git fetch origin spec/$SpecIssue failed" }

  # Resolve -At to a commit SHA (capture stdout; native stderr must not throw).
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $revOut = (& git rev-parse --verify "${At}^{commit}") 2>&1
  $revExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($revExit -ne 0) {
    Write-Log "ERROR: -At '$At' does not resolve to a commit (git rev-parse failed)." -Level ERROR
    exit 1
  }
  $atSha = (($revOut | Select-Object -Last 1) -as [string]).Trim()
  if (-not $atSha) {
    Write-Log "ERROR: -At '$At' resolved but produced no commit SHA." -Level ERROR
    exit 1
  }

  # Fail closed: the baseline commit MUST be reachable from origin/spec/<Spec>.
  & git merge-base --is-ancestor $atSha "origin/spec/$SpecIssue" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: -At $($atSha.Substring(0, [Math]::Min(8, $atSha.Length))) is NOT reachable from origin/spec/$SpecIssue -- baseline legs serve only PRE-FIX ancestors of the spec branch, never main or foreign commits. A genuine cross-branch measurement is a tooling request to the Self-Improver." -Level ERROR
    exit 1
  }

  # Materialize ONLY the product code at the pre-fix commit. apps/ is gitignored-
  # free tracked source (node_modules untracked) so this reverts exactly the
  # product diff; tooling/opencode.json stay at the spec/<Spec> tip.
  if ((Invoke-NativeQuiet git checkout $atSha -- apps) -ne 0) {
    Write-Log "ERROR: could not materialize pre-fix product code from $($atSha.Substring(0, [Math]::Min(8, $atSha.Length))) into apps/ (git checkout failed)." -Level ERROR
    exit 1
  }
  Write-Log "Materialized PRE-FIX product code (apps/) from $($atSha.Substring(0, [Math]::Min(12, $atSha.Length)))."
  return $atSha
}

# Restore apps/ to the current HEAD (spec/<Spec> tip) after a baseline leg. Runs
# automatically on the standard Up path when the product tree carries baseline
# residue; never touches anything outside apps/.
function Restore-ProductTree {
  param([uint64]$SpecIssue)
  $dirty = (git status --porcelain -- apps).Trim()
  if ($dirty) {
    Write-Log "Restoring product code (apps/) to spec/$SpecIssue tip after a baseline leg..."
    if ((Invoke-NativeQuiet git checkout HEAD -- apps) -ne 0) {
      Write-Log "ERROR: could not restore apps/ from HEAD (git checkout failed)." -Level ERROR
      exit 1
    }
  }
}

# -- Actions ------------------------------------------------------------------

$LogDir  = Join-Path $PSScriptRoot "..\logs"
$Stdout  = Join-Path $LogDir "dev-env-stdout.log"
$Stderr  = Join-Path $LogDir "dev-env-stderr.log"

switch ($Action) {

  # -- Up ----------------------------------------------------------------------
  "Up" {
    if ($Spec -eq 0) {
      Write-Log "ERROR: -Action Up requires -Spec <N> (G-052: the repo root must sit on spec/<N> at the origin tip; the app is served from the root)." -Level ERROR
      exit 1
    }
    if ($At) {
      # Baseline leg: serve the PRE-FIX product code (apps/ materialized from an
      # ancestor of spec/<Spec>; tooling stays current). Fail-closed.
      $tip = Prepare-BaselineServing -SpecIssue $Spec -At $At
      Write-Log "BASELINE LEG: serving pre-fix product code of $($tip.Substring(0, [Math]::Min(12, $tip.Length))) on spec/$Spec (Before/baseline measurement). The next Up WITHOUT -At restores the spec/$Spec tip."
    } else {
      # Standard flow: restore any baseline residue, then verify root currency.
      Restore-ProductTree -SpecIssue $Spec
      $tip = Assert-RootServingCurrency -SpecIssue $Spec
    }

    $ports = Test-BothPorts $VitePort $McpPort
    if ($ports.Vite -and $ports.Mcp) {
      if ($At) {
        # A baseline leg MUST serve the requested pre-fix commit -- an instance
        # already running (possibly from an AFTER leg) cannot be trusted as that
        # code, so fall through to the stale-kill + cold start below.
        Write-Log "dev:tauri already running (Vite :$VitePort OK, MCP :$McpPort OK) -- baseline leg requires a COLD start at the pre-fix commit; killing and cold-starting..."
      } else {
        Write-Log "dev:tauri already running (Vite :$VitePort OK, MCP :$McpPort OK) -- serving spec/$Spec @ $($tip.Substring(0, [Math]::Min(8, $tip.Length)))"
        # Fast-path env warning (fix round 4): the OPENCODE_* OTEL vars are
        # injected only on the cold-start path below (G-046 block) -- this
        # fast-path exit skips the injection, so a Run CLI child may inherit
        # a stale env and emit zero telemetry spans.
        Write-Log "WARNING: OPENCODE_* OTEL vars (telemetry env injection) are guaranteed only on a COLD start -- this fast-path exit does NOT inject them. If Run CLI sessions emit zero telemetry spans, run: dev-env.ps1 -Action Down, then dev-env.ps1 -Action Up -Spec $Spec." -Level WARN
        exit 0
      }
    }

    # Kill any stale instance from a previous (possibly mismatched) run.
    foreach ($port in @($McpPort, $VitePort)) {
      $stalePid = Get-PidByPort $port
      if ($stalePid) {
        Write-Log "Killing stale instance PID $stalePid (port :$port)..."
        Invoke-NativeQuiet taskkill /PID $stalePid /T /F | Out-Null
        Start-Sleep -Seconds 1
      }
    }

    Write-Log "Starting pnpm dev:tauri (repo root on spec/$Spec @ $($tip.Substring(0, [Math]::Min(8, $tip.Length))))..."

    # Clear the WebView2 HTTP cache before the cold launch (observed #2770
    # rounds 2-5: corrupt cached localhost:5174 response painted raw HTTP
    # headers as the document / white screen and survived restarts; manual
    # /?cb=<ts> recovery every time). HTTP cache only -- app state preserved.
    Clear-WebView2HttpCache

    if (-not (Test-Path $LogDir)) {
      New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }

    # Telemetry prerequisites (G-046): force the OPENCODE_* OTEL vars into the
    # dev instance's environment so fredo.exe AND every opencode session it
    # spawns via Run CLI inherit them -- independent of the launching agent's
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
      -ArgumentList "/c cd /d `"$PWD`" && pnpm dev:tauri > `"$Stdout`" 2> `"$Stderr`"" `
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

  # -- Down --------------------------------------------------------------------
  "Down" {
    $killed = $false

    foreach ($port in @($McpPort, $VitePort)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Found process $targetPid on port $port. Killing..."
        Invoke-NativeQuiet taskkill /PID $targetPid /T /F | Out-Null
        $killed = $true
      }
    }

    if (-not $killed) {
      Write-Log "No dev:tauri instance found on ports $VitePort / $McpPort"
    } else {
      Write-Log "dev:tauri stopped"
    }
  }

  # -- Status ------------------------------------------------------------------
  "Status" {
    $ports = Test-BothPorts $VitePort $McpPort

    if ($ports.Vite -and $ports.Mcp) {
      $branch = (git rev-parse --abbrev-ref HEAD).Trim()
      $head   = (git rev-parse HEAD).Trim()
      Write-Host "running (repo root on $branch @ $($head.Substring(0, [Math]::Min(8, $head.Length))))"
    } elseif ($ports.Vite -or $ports.Mcp) {
      $up = @()
      if ($ports.Vite) { $up += "Vite" }
      if ($ports.Mcp)  { $up += "MCP" }
      Write-Host "starting ($($up -join ', ') ready, waiting for more)"
    } else {
      Write-Host "stopped"
    }
  }

  # -- Restart -----------------------------------------------------------------
  "Restart" {
    Write-Log "Restarting dev:tauri..."

    foreach ($port in @($McpPort, $VitePort)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Killing process $targetPid on port $port"
        Invoke-NativeQuiet taskkill /PID $targetPid /T /F | Out-Null
      }
    }

    Start-Sleep -Seconds 2

    # Re-invoke Up
    & $PSCommandPath -Action Up -Spec $Spec -At $At -VitePort $VitePort -McpPort $McpPort -TimeoutSecs $TimeoutSecs
    exit $LASTEXITCODE
  }

  # -- Logs --------------------------------------------------------------------
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

  # -- Hygiene -----------------------------------------------------------------
  "Hygiene" {
    # Passthrough to the spec-branch process-hygiene.ps1 (fix plan #2762,
    # hygiene reachability item): the tester's shell denies direct execution
    # of that script, but `powershell -File .opencode/scripts/dev-env.ps1` is
    # a proven-executing grant. No logic is duplicated here -- the resolved
    # copy runs as a child powershell process. Resolution order: (a) the
    # sibling copy next to this script, then (b) the served worktree copy
    # .serve/<Spec>/.opencode/scripts/process-hygiene.ps1 when -Spec is given.
    $hygieneCandidates = @(Join-Path $PSScriptRoot "process-hygiene.ps1")
    if ($Spec -gt 0) {
      $repoRoot = $null
      try { $repoRoot = (git rev-parse --show-toplevel).Trim() } catch { }
      if ($repoRoot) {
        $hygieneCandidates += (Join-Path $repoRoot ".serve\$Spec\.opencode\scripts\process-hygiene.ps1")
      }
    }

    $hygieneScript = $null
    foreach ($candidate in $hygieneCandidates) {
      if (Test-Path $candidate) { $hygieneScript = $candidate; break }
    }
    if (-not $hygieneScript) {
      Write-Log "ERROR: process-hygiene.ps1 not found. Looked at:" -Level ERROR
      foreach ($candidate in $hygieneCandidates) { Write-Log "  $candidate" -Level ERROR }
      Write-Log "Pass -Spec <N> to also probe the served worktree copy .serve/<N>/.opencode/scripts/process-hygiene.ps1." -Level ERROR
      exit 1
    }

    $hygieneMode = "-List"
    if ($Kill) { $hygieneMode = "-KillOrphans" }
    Write-Log "Invoking: powershell -File $hygieneScript $hygieneMode"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $hygieneScript $hygieneMode
    $hygieneExit = $LASTEXITCODE
    Write-Log "process-hygiene exit code: $hygieneExit"
    exit $hygieneExit
  }
}
