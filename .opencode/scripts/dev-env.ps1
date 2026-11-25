<#
.SYNOPSIS
  Unified dev environment lifecycle manager for Fredo.

.DESCRIPTION
  Manages the pnpm dev:tauri instance -- start, stop, status, restart, and process logs.
  Legacy single-env mode uses no state files; ports are the source of truth, with
  dual-stack (IPv4 + IPv6) port probing. Env-aware mode (Spec #2944: -EnvId /
  -EnvSlot / -ServingCheckout) allocates a disjoint port block, isolates the data
  root / CLI pipe / WebView2 profile / OTLP endpoint, and records a per-env
  process manifest at <env-root>/manifest.json.

.PARAMETER Action
  Up       -- Ensure dev instance is running and ready. Auto-starts if not running.
              On the COLD start path (stale instance killed, ports free), the
              WebView2 HTTP cache (Cache, Code Cache, GPUCache only -- app state
              like localStorage/IndexedDB is preserved) is cleared before launch:
              a corrupt cached localhost:<VitePort> response otherwise paints raw
              HTTP headers as the document (white screen) and survives restarts
              (observed #2770 rounds 2-5 on 4+ consecutive cold boots).
  Down     -- Stop dev instance. Env mode (-EnvId) stops ONLY that environment's
              own manifest PIDs, image-guarded (R-3.1/R-3.3): no port-owner
              enumeration, no global image-name kill. Legacy mode stops the
              single instance by port owner.
  Status   -- Read-only check: running / starting / stopped. Env mode also
              prints an `isolation` line: the result of the read-only
              verify-env-isolation.ps1 continuous invariant check (distinct
              data roots, disjoint ports, each recorded endpoint owned by its
              own manifest PID). Status semantics are unchanged.
  Restart  -- Down then Up.
  Logs     -- Tail process stdout/stderr.
  Clean    -- Env mode only: stop the environment, then remove ONLY its
              manifest, DB, and cache (R-3.2). Sibling environments are never
              touched.
  Hygiene  -- Passthrough to process-hygiene.ps1 (see -Kill). Resolves the
             sibling copy next to this script first, then the served worktree
             copy .serve/<Spec>/.opencode/scripts/process-hygiene.ps1 when
             -Spec is given. Prints which copy was invoked and its exit code;
             a non-zero child exit becomes this script's exit code; a clear
             error + exit 1 when no copy is found.
  AssertIsolation -- Guard-only (Spec #3066). Resolves the effective app-data /
             PG data dirs (env + -EnvVar aware) and asserts they are NOT the
             shared %APPDATA%\com.fredo.app cluster. Prints
             `ISOLATION REFUSED (<code>): ...` and exits 3 when they are; exits 0
             when isolated. NEVER starts PostgreSQL or the app, and does NOT run
             the G-052 root-currency check (it serves nothing). Records the
             decision in .opencode/state/env-isolation.jsonl.
  WebviewOnly -- Frontend-only serving for the POST-QUIT window. Starts ONLY the
             environment's Vite dev server on the Vite port RECORDED in its
             manifest, with the env's variable block derived the same way Up
             derives it. Several test legs need "the app is quit (so its OTLP
             ports are free) BUT a webview still loads"; the product's own
             quit_app tears down the dev launcher tree AND Vite, so nothing
             serves on the env's port afterwards (#3194/#3195/#3206). Refuses
             when the env has no manifest / no recorded Vite port, when the
             env's app is still running, or when the recorded port is bound by
             a foreign owner (fail-closed, never a port scan/fallback). NEVER
             starts the app, the embedded PostgreSQL cluster, MCP or OTLP, and
             never touches the machine-global services or another env.
             Idempotent: a second call reports the already-serving PID and
             exits 0. Records the server in the manifest under the distinct
             roles `vite-only` (+ `vite-only-launcher`), so the env-scoped
             Down/Clean reap it. Prints
             `WEBVIEW-ONLY SERVING port=<p> pid=<pid>` + an HTTP readiness
             line, so a probe can prove the precondition.

.PARAMETER Stop
  WebviewOnly only. Stop the frontend-only server this verb recorded (manifest
  roles `vite-only` / `vite-only-launcher`) instead of starting it. Env-scoped
  and image-guarded like the rest of the env teardown; never touches the app,
  PostgreSQL, the machine-global services, or another env. Down/Clean already
  reap the same roles.

.PARAMETER RequireIsolation
  Arms the env-isolation guard (Spec #3066) on the Up path: refuse (exit 3,
  `ISOLATION REFUSED (shared-dir)` / `ISOLATION REFUSED (sentinel-seam)`) when the
  resolved app-data OR PG data dir equals-or-is-under the shared cluster dir, and
  refuse the FREDO_PG_PASSWORD_FILE / FREDO_PG_KEYCHAIN_DISABLED seams there.
  Default OFF -- a legacy Up without the marker is byte-identical to today.
  Env equivalent: FREDO_REQUIRE_ENV_ISOLATION (non-blank, not 0/false). Env mode
  arms the guard regardless of the marker.

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
  tooling request to the Orchestrator (new script/param), not an ad-hoc agent
  script. The next standard Up (without -At) FULLY restores apps/ to the spec/<Spec>
  tip for the AFTER legs (G-163: tracked content reset to HEAD, baseline-only files
  deleted, and the restore fails closed if apps/ still differs from HEAD -- a plain
  `git checkout HEAD -- apps` left files the tip deletes behind). Without -At the
  strict G-052 origin-tip check applies (the normal flow).

.PARAMETER EnvId
  Local test-environment id (Spec #2944). Optional. When set -- or when
  -EnvSlot >= 1 / -ServingCheckout is given -- Up runs the ENV-AWARE path:
  per-env port block, data root, process manifest, log dir, CLI pipe, WebView2
  profile and OTLP endpoint. When omitted in env mode it derives from -Spec as
  "spec<N>". Must match ^[a-z0-9][a-z0-9_-]{0,31}$. Unset with no -EnvSlot and
  no -ServingCheckout keeps the legacy single-env path byte-identical. Up holds
  a same-issue lease at .opencode/state/env-leases/<Spec>.json while the
  environment is live: a second Up for the SAME issue fails closed, a dead-PID
  lease is reclaimed (bounded), and different issues never block each other
  (R-3.4). Down/Clean release the lease.

.PARAMETER EnvSlot
  Port-block slot (Spec #2944). 0 = legacy defaults (Vite 5174 / MCP 9223 /
  OTLP gRPC 4317 + HTTP 4318). Slot n >= 1 = base
  P = 16000 + 10*(n-1), with Vite=P, MCP=P+1, OTLP/gRPC=P+2, OTLP/HTTP=P+3.
  Default: 0. The companion `llama` port was retired (Spec #3141): inference
  runs in-process, so there is no fifth endpoint to isolate.

.PARAMETER ServingCheckout
  Serving checkout for the environment (Spec #2944). Default: the repo root
  (byte-identical legacy behavior). When it is the repo root the G-052
  root-currency check still applies; a different checkout's HEAD is recorded as
  the manifest servedCommit.

.PARAMETER Manifest
  Process-manifest path override (Spec #2944; test seam). Default:
  <env-root>/manifest.json (also overridable via FREDO_ENV_MANIFEST).

.PARAMETER VitePort
  Vite dev server port. Default: 0 => derived (legacy 5174; env slot P). A
  positive value is an explicit override recorded in the manifest.

.PARAMETER McpPort
  MCP Bridge WebSocket port. Default: 0 => derived (legacy 9223; env slot P+1).
  A positive value is an explicit override recorded in the manifest.

.PARAMETER TimeoutSecs
  Max seconds to wait for ports during Up. Default: 120.

.PARAMETER Lines
  Number of log lines to tail for Logs action. Default: 50.

.EXAMPLE
  powershell -File .opencode/scripts/dev-env.ps1 -Action Up
  powershell -File .opencode/scripts/dev-env.ps1 -Action Status
  powershell -File .opencode/scripts/dev-env.ps1 -Action Logs -Lines 100
  powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2835 -At 296f881
  powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2944 -EnvId spec2944 -EnvSlot 1
  powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2944 -EnvId spec2944 -ServingCheckout .serve/2944
  powershell -File .opencode/scripts/dev-env.ps1 -Action Down -EnvId spec2944
  powershell -File .opencode/scripts/dev-env.ps1 -Action Clean -EnvId spec2944
  powershell -File .opencode/scripts/dev-env.ps1 -Action Hygiene -Spec 2762
  powershell -File .opencode/scripts/dev-env.ps1 -Action Hygiene -Kill -Spec 2762
  powershell -File .opencode/scripts/dev-env.ps1 -Action WebviewOnly -Spec 3195
  powershell -File .opencode/scripts/dev-env.ps1 -Action WebviewOnly -Spec 3195 -EnvId qa3195-a
  powershell -File .opencode/scripts/dev-env.ps1 -Action WebviewOnly -Stop -Spec 3195 -EnvId qa3195-a
#>

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Up", "Down", "Status", "Restart", "Logs", "Clean", "Hygiene", "AssertIsolation", "WebviewOnly")]
  [string]$Action,

  [ValidateRange(1, [uint64]::MaxValue)]
  [uint64]$Spec = 0,

  # Baseline-leg serving commit (Up only): a PRE-FIX ancestor of spec/<Spec>.
  # Optional -- the normal flow serves the origin/spec/<Spec> tip (G-052).
  [string]$At = "",

  # -- Spec #2944 (CU-C) environment selectors ---------------------------------
  # Local test-environment id. Empty => legacy single-env path UNLESS -EnvSlot
  # (>= 1) or -ServingCheckout is supplied, in which case it derives as
  # "spec<N>" from -Spec.
  [string]$EnvId = "",

  # Port-block slot: 0 = legacy defaults; n >= 1 = 16000 + 10*(n-1) block.
  [int]$EnvSlot = 0,

  # Serving checkout path (default: repo root, byte-identical legacy behavior).
  [string]$ServingCheckout = "",

  # Process-manifest path override (test seam); default <env-root>/manifest.json.
  [string]$Manifest = "",

  # 0 => derived (legacy 5174 / env slot P); a positive value is an explicit
  # override recorded in the manifest.
  [int]$VitePort = 0,
  [int]$McpPort = 0,
  [int]$TimeoutSecs = 120,
  [int]$Lines = 50,

  # Hygiene passthrough: forward -Kill as process-hygiene.ps1 -KillOrphans.
  [switch]$Kill,

  # WebviewOnly only: stop the recorded frontend-only server instead of starting
  # it (env-scoped, image-guarded; Down/Clean reap the same roles).
  [switch]$Stop,

  # Spec #3066: env-isolation guard. Arms the shared-cluster refusal on the Up
  # path (default OFF => byte-identical legacy behavior). Env equivalent:
  # FREDO_REQUIRE_ENV_ISOLATION (non-blank, not 0/false); env mode arms it too.
  [switch]$RequireIsolation,

  # Extra environment variables for the LAUNCHED dev instance (Up only).
  # PREFERRED form — repeatable `NAME=value` strings; this is the form that
  # works under `powershell -File`:
  #   -EnvVar "FREDO_STT_FEED_WAV=C:\repo\...\fixture.wav"
  # The launched app (and the opencode sessions it spawns) inherit them.
  # This exists because a tester/agent shell has no other way to set a process
  # env var for the app: every script invocation is a fresh shell and shell
  # chaining/metacharacters are sandbox-denied, so an env-gated app seam is
  # otherwise undrivable (see G-172 / the STT deterministic-feed seam).
  [string[]]$EnvVar = @(),

  # Hashtable form — for DOT-SOURCED callers only. `powershell -File x.ps1
  # -EnvVars @{ K = "v" }` hands the outer shell a literal that reaches the
  # script as a STRING, so it fails ("Cannot convert the ... Hashtable value").
  # Under `powershell -File`, use -EnvVar instead.
  [hashtable]$EnvVars = @{}
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

# Merge the repeatable `-EnvVar NAME=value` form into the hashtable so all
# callers share one injection path. Fails closed on a malformed pair rather
# than silently launching without the requested seam.
# Accepts BOTH the repeatable flag form (`-EnvVar "A=1" -EnvVar "B=2"`) and a
# single comma-delimited token (`-EnvVar "A=1,B=2,C=3"`) — some shells deliver
# the comma form as ONE argument under `powershell -File`, which previously
# bound only the first pair (observed #2968 round 1). Values must not contain a
# comma; pipeline seams are paths/ints/enums, so this is safe.
if ($EnvVar -and $EnvVar.Count -gt 0) {
  $pairs = @()
  foreach ($raw in $EnvVar) {
    if ($null -eq $raw) { continue }
    if (([string]$raw) -match ',') { $pairs += (([string]$raw) -split ',') } else { $pairs += [string]$raw }
  }
  foreach ($pair in $pairs) {
    $pair = ([string]$pair).Trim()
    if ([string]::IsNullOrWhiteSpace($pair)) { continue }
    $eq = $pair.IndexOf("=")
    if ($eq -lt 1) {
      Write-Log "ERROR: -EnvVar must be NAME=value (got '$pair')" "ERROR"
      exit 2
    }
    $name = $pair.Substring(0, $eq).Trim()
    $value = $pair.Substring($eq + 1)
    $EnvVars[$name] = $value
  }
}

# -Stop is a WebviewOnly-only switch: fail closed on a mistaken pairing rather
# than silently ignoring it on (say) a Down that had a different intent.
if ($Stop -and $Action -ne "WebviewOnly") {
  Write-Log "ERROR: -Stop is only valid with -Action WebviewOnly (got -Action $Action)." -Level ERROR
  exit 2
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
  param([string]$ProfileRoot = "")
  if ($ProfileRoot) {
    # Env mode: WEBVIEW2_USER_DATA_FOLDER points at the per-env profile. The
    # profile's `Default\...` may sit directly under it or under an `EBWebView`
    # subfolder (the legacy nesting) -- pick whichever actually holds `Default`.
    $root = $ProfileRoot
    if ((-not (Test-Path -LiteralPath (Join-Path $root "Default"))) -and
        (Test-Path -LiteralPath (Join-Path $root "EBWebView\Default"))) {
      $root = Join-Path $root "EBWebView"
    }
  } else {
    $root = Join-Path $env:LOCALAPPDATA "com.fredo.app\EBWebView"
  }
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
      $ok = $false
      try { $tcp.EndConnect($ar); $ok = $true } catch {}
      $tcp.Close()
      if ($ok) { return $true }
    } else {
      $tcp.Close()
    }
  } catch {}

  # Try IPv6 (a refusal on IPv4 must NOT short-circuit the dual-stack probe:
  # Vite bound to `localhost` can listen on ::1 only).
  try {
    $tcp = [System.Net.Sockets.TcpClient]::new([System.Net.Sockets.AddressFamily]::InterNetworkV6)
    $ar  = $tcp.BeginConnect("::1", $Port, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne(2000)) {
      $ok = $false
      try { $tcp.EndConnect($ar); $ok = $true } catch {}
      $tcp.Close()
      if ($ok) { return $true }
    } else {
      $tcp.Close()
    }
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

# Kill the process listening on $Port (and its tree), retrying because a
# native-abort instance can survive a first /PID kill and keep the socket.
# LEGACY single-env only -- the env-aware teardown never enumerates ports
# (Spec #2944 R-3.3). Returns $true when the port is free afterwards.
function Clear-Port {
  param([int]$Port)

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if (-not (Test-Port $Port)) { return $true }
    $owner = Get-PidByPort $Port
    if ($owner) {
      $alive = $null -ne (Get-Process -Id $owner -ErrorAction SilentlyContinue)
      Write-Log "Reclaiming port ${Port}: owner PID $owner (alive: $alive), attempt $attempt"
      Invoke-NativeQuiet taskkill /PID $owner /T /F | Out-Null
    }
    Start-Sleep -Milliseconds 800
  }
  return (-not (Test-Port $Port))
}

# Last-resort reclaim for bridge/Vite helpers that outlive the app: an
# npx-launched MCP or Vite server (node.exe/bun.exe) can hold a port after the
# app is gone. Kill ONLY helpers whose command line references THIS repo, so
# unrelated Node processes are never touched.
function Stop-RepoNodeHolders {
  try {
    $root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$root*" } |
      ForEach-Object {
        Write-Log "Killing orphaned dev helper PID $($_.ProcessId) on this repo (node/bun)..."
        Invoke-NativeQuiet taskkill /PID $_.ProcessId /T /F | Out-Null
      }
  } catch {}
}

# -- Root serving currency (G-052) ---------------------------------------------

# The repo root IS the serving checkout: during implementation/testing it must
# sit on spec/<Spec> at the origin tip. No dedicated worktree, no state file.
function Assert-RootServingCurrency {
  param([uint64]$SpecIssue, [string]$RepoDir = "")
  if (-not $RepoDir) { $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }

  $branch = (git -C $RepoDir rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne "spec/$SpecIssue") {
    Write-Log "ERROR: repo root is on '$branch' -- checkout spec/$SpecIssue before serving/testing (G-052)." -Level ERROR
    exit 1
  }
  Write-Log "Fetching origin/spec/$SpecIssue..."
  if ((Invoke-NativeQuiet git -C $RepoDir fetch origin "spec/$SpecIssue") -ne 0) { throw "git fetch origin spec/$SpecIssue failed" }
  $tip = (git -C $RepoDir rev-parse "origin/spec/$SpecIssue").Trim()
  if (-not $tip) { throw "cannot resolve origin/spec/$SpecIssue" }
  $head = (git -C $RepoDir rev-parse HEAD).Trim()
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
  param([uint64]$SpecIssue, [string]$At, [string]$RepoDir = "")
  if (-not $RepoDir) { $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }

  $branch = (git -C $RepoDir rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne "spec/$SpecIssue") {
    Write-Log "ERROR: repo root is on '$branch' -- a baseline leg still requires the root on spec/$SpecIssue (G-052); baseline legs NEVER serve main." -Level ERROR
    exit 1
  }
  Write-Log "Fetching origin/spec/$SpecIssue..."
  if ((Invoke-NativeQuiet git -C $RepoDir fetch origin "spec/$SpecIssue") -ne 0) { throw "git fetch origin spec/$SpecIssue failed" }

  # Resolve -At to a commit SHA (capture stdout; native stderr must not throw).
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $revOut = (& git -C $RepoDir rev-parse --verify "${At}^{commit}") 2>&1
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
  & git -C $RepoDir merge-base --is-ancestor $atSha "origin/spec/$SpecIssue" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: -At $($atSha.Substring(0, [Math]::Min(8, $atSha.Length))) is NOT reachable from origin/spec/$SpecIssue -- baseline legs serve only PRE-FIX ancestors of the spec branch, never main or foreign commits. A genuine cross-branch measurement is a tooling request to the Orchestrator." -Level ERROR
    exit 1
  }

  # Materialize ONLY the product code at the pre-fix commit. apps/ is gitignored-
  # free tracked source (node_modules untracked) so this reverts exactly the
  # product diff; tooling/opencode.json stay at the spec/<Spec> tip.
  if ((Invoke-NativeQuiet git -C $RepoDir checkout $atSha -- apps) -ne 0) {
    Write-Log "ERROR: could not materialize pre-fix product code from $($atSha.Substring(0, [Math]::Min(8, $atSha.Length))) into apps/ (git checkout failed)." -Level ERROR
    exit 1
  }
  Write-Log "Materialized PRE-FIX product code (apps/) from $($atSha.Substring(0, [Math]::Min(12, $atSha.Length)))."
  return $atSha
}

# Restore apps/ to the current HEAD (spec/<Spec> tip) after a baseline leg. Runs
# automatically on the standard Up path when the product tree carries baseline
# residue; never touches anything outside apps/.
#
# G-163: `git checkout HEAD -- apps` alone is NOT a full restore. Files that exist
# at the baseline (-At) commit but were DELETED at the tip are staged as additions;
# they are not paths in HEAD, so a checkout of HEAD never removes them -- the
# serving tree silently kept the pre-fix file set and the AFTER legs could run
# against contaminated code (observed #2882). Capture those stale paths, force the
# tree+index back to HEAD, delete the stale files, and FAIL CLOSED if anything
# under apps/ still differs from HEAD (never serve a contaminated tree).
function Restore-ProductTree {
  param([uint64]$SpecIssue, [string]$RepoDir = "")
  if (-not $RepoDir) { $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
  $dirty = ((& git -C $RepoDir status --porcelain -- apps 2>$null) | Out-String).Trim()
  if (-not $dirty) { return }

  Write-Log "Restoring product code (apps/) to spec/$SpecIssue tip after a baseline leg..."
  $staleAdds = @(
    (& git -C $RepoDir diff --cached --name-only --diff-filter=A -- apps 2>$null) |
      Where-Object { $_ -and $_.Trim() } |
      ForEach-Object { $_.Trim() }
  )
  if ((Invoke-NativeQuiet git -C $RepoDir checkout -f HEAD -- apps) -ne 0) {
    Write-Log "ERROR: could not restore apps/ from HEAD (git checkout failed)." -Level ERROR
    exit 1
  }
  if ((Invoke-NativeQuiet git -C $RepoDir reset -q HEAD -- apps) -ne 0) {
    Write-Log "ERROR: could not reset the apps/ index to HEAD (git reset failed)." -Level ERROR
    exit 1
  }
  foreach ($f in $staleAdds) {
    $abs = if ([System.IO.Path]::IsPathRooted($f)) { $f } else { Join-Path $RepoDir $f }
    if (Test-Path -LiteralPath $abs) {
      Write-Log "Removing baseline-only file not present at the tip: $f"
      Remove-Item -LiteralPath $abs -Force -ErrorAction SilentlyContinue
    }
  }
  $leftover = ((& git -C $RepoDir status --porcelain -- apps 2>$null) | Out-String).Trim()
  if ($leftover) {
    Write-Log "ERROR: apps/ still differs from HEAD after the baseline restore -- refusing to serve a contaminated tree:" -Level ERROR
    Write-Log $leftover -Level ERROR
    exit 1
  }
  Write-Log "Product code (apps/) restored to spec/$SpecIssue tip (G-163 full restore)."
}

# -- Environment resolution (Spec #2944 ST-4 / CU-C) --------------------------

# Resolve one port: explicit -VitePort/-McpPort override > FREDO_* process env
# (which includes the caller's -EnvVar seam, applied below before resolution) >
# slot/legacy default. Fail-closed on an out-of-range override.
function Resolve-PortValue {
  param([int]$Override, [string]$EnvName, [int]$Default)
  if ($Override -gt 0) {
    if ($Override -gt 65535) {
      Write-Log "ERROR: $EnvName override $Override is out of range (1-65535)." -Level ERROR
      exit 1
    }
    return $Override
  }
  $raw = [Environment]::GetEnvironmentVariable($EnvName, "Process")
  if ($raw) {
    $parsed = 0
    if ([int]::TryParse(([string]$raw).Trim(), [ref]$parsed) -and $parsed -gt 0 -and $parsed -le 65535) {
      return $parsed
    }
  }
  return $Default
}

function Read-EnvManifest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-EnvManifest {
  param(
    [string]$ManifestPath, [string]$EnvId, [uint64]$Spec, [string]$ServingCheckout, [string]$ServedCommit,
    [int]$VitePort, [int]$McpPort, [int]$OtlpGrpcPort, [int]$OtlpHttpPort,
    [string]$DataDir, [string]$DbPath, [string]$CliPipe, [string]$WebviewDir, [string]$AppIdentity,
    [object[]]$Processes
  )
  $dir = Split-Path -Parent $ManifestPath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $obj = [ordered]@{
    envId           = $EnvId
    spec            = $Spec
    servingCheckout = $ServingCheckout
    servedCommit    = $ServedCommit
    ports           = [ordered]@{
      vite     = $VitePort
      mcp      = $McpPort
      otlpGrpc = $OtlpGrpcPort
      otlpHttp = $OtlpHttpPort
      pg       = 0
    }
    dataDir         = $DataDir
    dbPath          = $DbPath
    pipe            = $CliPipe
    webviewProfile  = $WebviewDir
    appIdentity     = $AppIdentity
    processes       = @($Processes)
  }
  $json = $obj | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# Write the environment's evidence record (Spec #2944 ST-12 / CU-G, R-5.1) at
# <env-root>/evidence.json (overridable via FREDO_EVIDENCE_FILE). It records the
# env id, serving checkout, served commit, DB path, endpoints/MCP port, manifest
# path, and app identity so the state machine's audit can attribute evidence to
# THIS environment and reject cross-environment evidence (R-5.2). BEST-EFFORT:
# any failure is a warning and must never fail Up (the env is already serving).
function Write-EnvEvidence {
  param(
    [string]$EvidenceFile, [string]$EnvId, [string]$ServingCheckout, [string]$ServedCommit,
    [string]$DbPath, [int]$VitePort, [int]$McpPort, [int]$OtlpGrpcPort, [int]$OtlpHttpPort,
    [string]$CliPipe, [string]$ManifestPath, [string]$AppIdentity
  )
  try {
    $dir = Split-Path -Parent $EvidenceFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $obj = [ordered]@{
      envId           = $EnvId
      servingCheckout = $ServingCheckout
      servedCommit    = $ServedCommit
      dbPath          = $DbPath
      endpoints       = [ordered]@{
        vite     = $VitePort
        mcp      = $McpPort
        otlpGrpc = $OtlpGrpcPort
        otlpHttp = $OtlpHttpPort
        pipe     = $CliPipe
      }
      manifestPath    = $ManifestPath
      appIdentity     = $AppIdentity
    }
    $json = $obj | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($EvidenceFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Log "Wrote env evidence: $EvidenceFile"
  } catch {
    Write-Log "WARNING: could not write env evidence to ${EvidenceFile}: $($_.Exception.Message)" -Level WARN
  }
}

# Env-aware cold start (Spec #2944 ST-4). Fail-closed on port collisions
# (R-4.3); manifest-scoped (NO global image-name kill); per-env paths/logs; the
# Tauri devUrl override via `--config <env-root>/tauri.env.conf.json`. Reads the
# resolved script-scope values (EnvId/EnvRoot/ServingDir/ports/...).
function Invoke-EnvUp {
  if ($Spec -eq 0) {
    Write-Log "ERROR: -Action Up requires -Spec <N> (the manifest records the spec; G-052 root currency)." -Level ERROR
    exit 1
  }

  # Idempotency: OUR recorded app still owns the recorded MCP port => already up.
  $existing = Read-EnvManifest $ManifestPath
  if ($existing -and $existing.envId -eq $EnvId -and $existing.processes) {
    $appProc = $existing.processes | Where-Object { $_.role -eq "app" } | Select-Object -First 1
    if ($appProc) {
      $owner = Get-PidByPort $McpPort
      if ($owner -and ([int]$owner -eq [int]$appProc.pid) -and (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
        Write-Log "env '$EnvId' already running (app PID $owner owns recorded MCP :$McpPort) -- nothing to do"
        exit 0
      }
    }
  }

  # Same-issue serialization (R-3.4): one environment per issue/spec. A LIVE
  # lease for THIS issue fails closed; a lease whose recorded PID is dead is
  # stale and reclaimed (bounded -- a single process-existence probe). Different
  # issues use different lease files and are never blocked.
  $leasePath = Get-EnvLeasePath $Spec
  $existingLease = Read-EnvLease $leasePath
  if ($existingLease) {
    if (Test-EnvLeaseLive $existingLease) {
      Write-Log "ERROR: issue $Spec already holds a LIVE env lease (env '$($existingLease.envId)', PID $($existingLease.pid); $leasePath) -- refusing a second environment for the same issue (R-3.4). Down it first: dev-env.ps1 -Action Down -EnvId $($existingLease.envId)." -Level ERROR
      exit 1
    }
    Write-Log "Reclaiming stale env lease for issue $Spec (recorded PID $($existingLease.pid) is dead)."
    Remove-EnvLease $leasePath
  }

  # Fail-closed collision gate (R-4.3): any bound recorded port means a foreign
  # owner. Never scan to / bind a different port; never kill a sibling env.
  $conflicts = @()
  foreach ($p in @($VitePort, $McpPort, $OtlpGrpcPort, $OtlpHttpPort)) {
    if (Test-Port $p) { $conflicts += $p }
  }
  if ($conflicts.Count -gt 0) {
    Write-Log "ERROR: env '$EnvId' recorded port(s) $($conflicts -join ', ') already bound -- fail-closed (R-4.3): refusing to start and never scanning/falling back to another port. Stop the owner (dev-env.ps1 -Action Down -EnvId <id>) and retry." -Level ERROR
    exit 1
  }

  # Serving currency / served commit.
  if ($ServingDir -eq $script:RepoRoot) {
    if ($At) {
      $servedCommit = Prepare-BaselineServing -SpecIssue $Spec -At $At -RepoDir $ServingDir
      Write-Log "BASELINE LEG (env '$EnvId'): serving pre-fix product code of $($servedCommit.Substring(0, [Math]::Min(12, $servedCommit.Length))) on spec/$Spec."
    } else {
      Restore-ProductTree -SpecIssue $Spec -RepoDir $ServingDir
      $servedCommit = Assert-RootServingCurrency -SpecIssue $Spec -RepoDir $ServingDir
    }
  } else {
    if ($At) {
      $servedCommit = Prepare-BaselineServing -SpecIssue $Spec -At $At -RepoDir $ServingDir
      Write-Log "BASELINE LEG (env '$EnvId'): serving pre-fix product code of $($servedCommit.Substring(0, [Math]::Min(12, $servedCommit.Length))) from $ServingDir."
    } else {
      Restore-ProductTree -SpecIssue $Spec -RepoDir $ServingDir
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      $servedCommit = (& git -C $ServingDir rev-parse HEAD 2>$null | Out-String).Trim()
      $ErrorActionPreference = $prevEap
      if (-not $servedCommit) {
        Write-Log "ERROR: cannot resolve HEAD of serving checkout $ServingDir." -Level ERROR
        exit 1
      }
    }
  }

  # Per-env directories (data root, PG dirs, db-client, WebView2 profile,
  # companion dir, log dir).
  foreach ($d in @($EnvRoot, $DataDir, $PgDataDir, $PgLockDir, $DbClientDir, $WebviewDir, $CompanionDir, $LogDir)) {
    if (-not (Test-Path -LiteralPath $d)) {
      New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
  }

  # Tauri devUrl override: the static tauri.conf.json points at 5174; this
  # per-env config merges the env's Vite port (ST-3 proved the CLI merge).
  $confPath = Join-Path $EnvRoot "tauri.env.conf.json"
  $confJson = (@{ build = @{ devUrl = "http://localhost:$VitePort" }; app = @{ withGlobalTauri = $true } } | ConvertTo-Json -Depth 4)
  [System.IO.File]::WriteAllText($confPath, $confJson, (New-Object System.Text.UTF8Encoding($false)))

  # Inject the Names-Block environment (the app + every opencode session it
  # spawns inherit it).
  $env:FREDO_ENV_ID                     = $EnvId
  $env:FREDO_ENV_ROOT                   = $EnvRoot
  $env:FREDO_ENV_MANIFEST               = $ManifestPath
  $env:FREDO_EVIDENCE_FILE              = $EvidencePath
  $env:FREDO_DATA_DIR                   = $DataDir
  $env:FREDO_PG_DATA_DIR                = $PgDataDir
  $env:FREDO_PG_LOCK_DIR                = $PgLockDir
  $env:FREDO_DBCLIENT_STATE_DIR         = $DbClientDir
  $env:FREDO_CLI_PIPE                   = $CliPipe
  $env:FREDO_MCP_BASE_PORT              = "$McpPort"
  $env:FREDO_VITE_PORT                  = "$VitePort"
  $env:FREDO_WEBVIEW_PROFILE_DIR        = $WebviewDir
  $env:FREDO_LLAMA_SERVER_COMPANION_DIR = $CompanionDir
  $env:FREDO_INGEST_GRPC_PORT           = "$OtlpGrpcPort"
  $env:FREDO_INGEST_HTTP_PORT           = "$OtlpHttpPort"
  $env:OPENCODE_ENABLE_TELEMETRY        = "1"
  $env:OPENCODE_OTLP_ENDPOINT           = "http://localhost:$OtlpGrpcPort"
  $env:OPENCODE_OTLP_PROTOCOL           = "grpc"
  $env:WEBVIEW2_USER_DATA_FOLDER        = $WebviewDir

  # Caller -EnvVar seam wins over the computed values (legacy parity).
  if ($EnvVars -and $EnvVars.Count -gt 0) {
    foreach ($envKey in @($EnvVars.Keys)) {
      [Environment]::SetEnvironmentVariable([string]$envKey, [string]$EnvVars[$envKey], "Process")
      Write-Log "Injected env var $envKey for the dev instance"
    }
  }

  # HTTP cache only (app state preserved); the per-env WebView2 profile.
  Clear-WebView2HttpCache -ProfileRoot $WebviewDir

  # Per-env log files; fall back to a per-launch log if a wedged instance holds
  # the primary handle.
  $stdout = Join-Path $LogDir "dev-env-stdout.log"
  $stderr = Join-Path $LogDir "dev-env-stderr.log"
  try {
    $probe = [System.IO.File]::Open($stdout, 'Append', 'Write', 'None')
    $probe.Close()
  } catch {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $stdout = Join-Path $LogDir "dev-env-stdout-$stamp.log"
    $stderr = Join-Path $LogDir "dev-env-stderr-$stamp.log"
    Write-Log "Primary env log is locked by a wedged instance -- falling back to $stdout" -Level WARN
  }

  $shortCommit = $servedCommit.Substring(0, [Math]::Min(8, $servedCommit.Length))
  Write-Log "Starting pnpm dev:tauri (env '$EnvId' from $ServingDir @ $shortCommit, Vite :$VitePort, MCP :$McpPort)..."
  if (-not (Test-Path -LiteralPath (Join-Path $ServingDir "node_modules"))) {
    Write-Log "WARNING: $ServingDir has no node_modules -- run 'pnpm install --frozen-lockfile' there or tauri dev will fail." -Level WARN
  }

  $launchCmd = "/c cd /d `"$ServingDir`" && pnpm --filter @fredo/tauri exec tauri dev --config `"$confPath`" > `"$stdout`" 2> `"$stderr`""
  $proc = Start-Process -FilePath "cmd" -ArgumentList $launchCmd -WindowStyle Hidden -PassThru
  Write-Log "Launched launcher PID $($proc.Id). Waiting for env ports + app..."

  # Record the same-issue lease immediately (launcher PID) so a concurrent Up for
  # this issue fails closed even during the startup window; the app PID replaces
  # it once ready (R-3.4).
  Write-EnvLease -Path $leasePath -SpecIssue $Spec -LeaseEnvId $EnvId -ServingCheckout (Get-RepoRelativePath $ServingDir) -LeasePid $proc.Id

  $startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Write-EnvManifest -ManifestPath $ManifestPath -EnvId $EnvId -Spec $Spec -ServingCheckout $ServingDir `
    -ServedCommit $servedCommit -VitePort $VitePort -McpPort $McpPort -OtlpGrpcPort $OtlpGrpcPort `
    -OtlpHttpPort $OtlpHttpPort -DataDir $DataDir -DbPath $DbPath `
    -CliPipe $CliPipe -WebviewDir $WebviewDir -AppIdentity $AppIdentity `
    -Processes @(@{ pid = $proc.Id; role = "launcher"; startedAt = $startedAt })

  $deadline = (Get-Date).AddSeconds($TimeoutSecs)
  $viteReady = $false; $mcpReady = $false; $grpcReady = $false; $httpReady = $false; $appReady = $false
  while ((Get-Date) -lt $deadline) {
    if (-not $viteReady) { $viteReady = Test-Port $VitePort; if ($viteReady) { Write-Log "Vite :$VitePort ready" } }
    if (-not $grpcReady) { $grpcReady = Test-Port $OtlpGrpcPort; if ($grpcReady) { Write-Log "OTLP/gRPC :$OtlpGrpcPort ready" } }
    if (-not $httpReady) { $httpReady = Test-Port $OtlpHttpPort; if ($httpReady) { Write-Log "OTLP/HTTP :$OtlpHttpPort ready" } }
    if (-not $mcpReady) { $mcpReady = Test-Port $McpPort; if ($mcpReady) { Write-Log "MCP Bridge :$McpPort ready" } }
    # G-304 + recorded-port gate: ports alone are a FALSE-READY -- the app
    # process must be alive (`Get-Process -Name "fredo"`) AND own the RECORDED
    # MCP port. A scanned port (the MCP crate's collision auto-scan) leaves the
    # recorded port unbound => not ready.
    if (-not $appReady) {
      $appAlive = [bool](Get-Process -Name "fredo" -ErrorAction SilentlyContinue)
      $owner = Get-PidByPort $McpPort
      $appOwnsPort = $false
      if ($owner) {
        $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq "fredo") { $appOwnsPort = $true }
      }
      if ($appAlive -and $appOwnsPort) {
        $appReady = $true
        Write-Log "app process 'fredo' (PID $owner) owns recorded MCP :$McpPort"
      }
    }
    if ($viteReady -and $mcpReady -and $grpcReady -and $httpReady -and $appReady) {
      $appPid = Get-PidByPort $McpPort
      $vitePid = Get-PidByPort $VitePort
      $procs = @(@{ pid = $proc.Id; role = "launcher"; startedAt = $startedAt })
      if ($appPid) { $procs += @{ pid = $appPid; role = "app"; startedAt = $startedAt } }
      if ($vitePid) { $procs += @{ pid = $vitePid; role = "vite"; startedAt = $startedAt } }
      Write-EnvManifest -ManifestPath $ManifestPath -EnvId $EnvId -Spec $Spec -ServingCheckout $ServingDir `
        -ServedCommit $servedCommit -VitePort $VitePort -McpPort $McpPort -OtlpGrpcPort $OtlpGrpcPort `
        -OtlpHttpPort $OtlpHttpPort -DataDir $DataDir -DbPath $DbPath `
        -CliPipe $CliPipe -WebviewDir $WebviewDir -AppIdentity $AppIdentity -Processes $procs
      # The app process is the live lease holder (a crash frees the lease for a
      # bounded stale reclaim, R-3.4).
      if ($appPid) {
        Write-EnvLease -Path $leasePath -SpecIssue $Spec -LeaseEnvId $EnvId -ServingCheckout (Get-RepoRelativePath $ServingDir) -LeasePid ([int]$appPid)
      }
      # Environment-tagged evidence (R-5.1). Best-effort: never fails Up.
      Write-EnvEvidence -EvidenceFile $EvidencePath -EnvId $EnvId -ServingCheckout $ServingDir `
        -ServedCommit $servedCommit -DbPath $DbPath -VitePort $VitePort -McpPort $McpPort `
        -OtlpGrpcPort $OtlpGrpcPort -OtlpHttpPort $OtlpHttpPort `
        -CliPipe $CliPipe -ManifestPath $ManifestPath -AppIdentity $AppIdentity
      Write-Log "env '$EnvId' ready (manifest: $ManifestPath)"
      exit 0
    }
    Start-Sleep -Seconds 2
  }

  $missing = @()
  if (-not $viteReady) { $missing += "Vite :$VitePort" }
  if (-not $mcpReady)  { $missing += "MCP Bridge :$McpPort" }
  if (-not $grpcReady) { $missing += "OTLP/gRPC :$OtlpGrpcPort" }
  if (-not $httpReady) { $missing += "OTLP/HTTP :$OtlpHttpPort" }
  if (-not $appReady)  { $missing += "app process 'fredo' owning MCP :$McpPort" }
  Write-Log "ERROR: env '$EnvId' timed out after ${TimeoutSecs}s waiting for: $($missing -join ', ')" -Level ERROR
  # Bounded hard-kill fallback (G-263): the readiness wait is wall-clock bounded;
  # reap the failed launch's own manifest PIDs (image-guarded, PID-scoped).
  Stop-EnvManifest -Path $ManifestPath | Out-Null
  # Release the lease: the failed launch no longer holds this issue (R-3.4).
  Remove-EnvLease $leasePath $EnvId
  Write-Log "Manifest left at $ManifestPath for teardown: dev-env.ps1 -Action Down -EnvId $EnvId" -Level WARN
  Write-Log "Check logs: powershell -File .opencode/scripts/dev-env.ps1 -Action Logs -EnvId $EnvId" -Level WARN
  exit 1
}

# -- Env-scoped teardown (Spec #2944 ST-5 / CU-C) ------------------------------

# Role -> accepted live image name(s). A recorded manifest PID is killed ONLY
# when its live image matches the role (the stale-PID guard). An unknown role, a
# gone process, or a mismatched image is NEVER killed -- so a stale/wrong
# manifest can never take out an unrelated process (R-3.1/R-3.3). The two named
# roles (app/postgres) are exact; the dev-helper roles accept their launcher
# images. There is no `llama` role any more: the companion engine is in-process
# (Spec #3141), so no companion child process can be recorded in the manifest.
$script:RoleImage = @{
  app      = @("fredo.exe")
  postgres = @("postgres.exe")
  vite     = @("node.exe", "bun.exe")
  "vite-only"          = @("node.exe", "bun.exe")
  "vite-only-launcher" = @("cmd.exe", "powershell.exe", "pwsh.exe")
  launcher = @("cmd.exe", "powershell.exe", "pwsh.exe")
}

# Live image name (with .exe) for a PID, or $null when the process is gone /
# unreadable. Uses Win32_Process so the name matches the role map exactly.
function Get-ProcessImageName {
  param([int]$ProcessId)
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($p -and $p.Name) { return [string]$p.Name }
  } catch {}
  return $null
}

function Test-RoleImageMatch {
  param([string]$Role, [string]$Image)
  if (-not $Role -or -not $Image) { return $false }
  $expected = $script:RoleImage[$Role]
  if (-not $expected) { return $false }
  foreach ($e in @($expected)) {
    if ($Image.Trim() -ieq $e) { return $true }
  }
  return $false
}

# Stop every process recorded in an env manifest: PID-scoped and image-guarded,
# with a bounded wait (G-263) and a hard-kill fallback. NO port-owner
# enumeration and NO global image-name kill (R-3.1/R-3.3). Returns $true when
# every recorded process is gone.
function Stop-EnvManifest {
  param([string]$Path)

  $manifest = Read-EnvManifest $Path
  if (-not $manifest) {
    Write-Log "No readable env manifest at $Path -- nothing to stop (safe no-op)."
    return $true
  }
  $procs = @($manifest.processes)
  if ($procs.Count -eq 0) {
    Write-Log "env manifest $Path records no processes -- nothing to stop."
    return $true
  }

  $targets = @()
  foreach ($p in $procs) {
    $procId = 0
    if (-not [int]::TryParse([string]$p.pid, [ref]$procId) -or $procId -le 0) { continue }
    $role = [string]$p.role
    $image = Get-ProcessImageName $procId
    if (-not $image) {
      Write-Log "manifest $role PID $procId is gone -- skip"
      continue
    }
    if (-not (Test-RoleImageMatch -Role $role -Image $image)) {
      $expectedList = $script:RoleImage[$role]
      if (-not $expectedList) {
        Write-Log "REFUSING to kill PID ${procId}: manifest role '$role' is not a known role (R-3.3)." -Level WARN
      } else {
        Write-Log "REFUSING to kill PID ${procId}: role '$role' expects image '$($expectedList -join '/')' but live image is '$image' (stale/reused PID, R-3.3)." -Level WARN
      }
      continue
    }
    $targets += @{ pid = $procId; role = $role; image = $image }
  }

  if ($targets.Count -eq 0) {
    Write-Log "No manifest process matched its role image -- nothing killed (safe no-op)."
    return $true
  }

  # Bounded stop (G-263): a short graceful window (capped so a wedged console
  # cannot stretch Down), then a /F hard-kill fallback with its own bound.
  $boundSecs = [Math]::Min([Math]::Max($TimeoutSecs, 1), 5)
  foreach ($t in $targets) {
    Write-Log "Stopping env '$EnvId' $($t.role) PID $($t.pid) ($($t.image))..."
    Invoke-NativeQuiet taskkill /PID $t.pid /T | Out-Null
  }
  $deadline = (Get-Date).AddSeconds($boundSecs)
  while ((Get-Date) -lt $deadline) {
    if (@($targets | Where-Object { Get-ProcessImageName $_.pid }).Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }

  # Hard-kill fallback for survivors, with its own bounded wait (G-263).
  $survivors = @($targets | Where-Object { Get-ProcessImageName $_.pid })
  if ($survivors.Count -gt 0) {
    Write-Log "Graceful stop left $($survivors.Count) process(es) after ${boundSecs}s -- hard-kill fallback (taskkill /PID <pid> /T /F)." -Level WARN
    foreach ($t in $survivors) {
      Invoke-NativeQuiet taskkill /PID $t.pid /T /F | Out-Null
    }
    $deadline2 = (Get-Date).AddSeconds($boundSecs)
    while ((Get-Date) -lt $deadline2) {
      if (@($survivors | Where-Object { Get-ProcessImageName $_.pid }).Count -eq 0) { break }
      Start-Sleep -Milliseconds 500
    }
  }

  $left = @($targets | Where-Object { Get-ProcessImageName $_.pid })
  if ($left.Count -gt 0) {
    foreach ($t in $left) {
      Write-Log "WARNING: env '$EnvId' $($t.role) PID $($t.pid) still alive after the hard-kill fallback." -Level WARN
    }
    return $false
  }
  Write-Log "env '$EnvId' processes stopped (manifest-scoped, image-guarded)."
  return $true
}

# Env-scoped Down: ONLY the manifest's own PIDs (R-3.1). Refuses when the
# manifest belongs to a different env (fail-closed, R-3.2 edge (c)).
function Invoke-EnvDown {
  $leaseIssue = 0
  if ($Spec -gt 0) { $leaseIssue = [uint64]$Spec }

  if (-not (Test-Path -LiteralPath $ManifestPath)) {
    Write-Log "env '$EnvId' has no manifest at $ManifestPath -- nothing to stop (safe no-op)."
    if ($leaseIssue -gt 0) { Remove-EnvLease (Get-EnvLeasePath $leaseIssue) $EnvId }
    return $true
  }
  $manifest = Read-EnvManifest $ManifestPath
  if (-not $manifest) {
    Write-Log "env '$EnvId' manifest at $ManifestPath is unreadable -- nothing to stop (safe no-op)." -Level WARN
    if ($leaseIssue -gt 0) { Remove-EnvLease (Get-EnvLeasePath $leaseIssue) $EnvId }
    return $true
  }
  if ($leaseIssue -eq 0 -and $manifest.spec) { $leaseIssue = [uint64]$manifest.spec }
  if ($manifest.envId -and ([string]$manifest.envId -ne $EnvId)) {
    Write-Log "ERROR: manifest $ManifestPath belongs to env '$($manifest.envId)', not '$EnvId' -- refusing to stop another env's processes (R-3.1)." -Level ERROR
    return $false
  }
  $stopped = Stop-EnvManifest -Path $ManifestPath
  # Release the same-issue lease (R-3.4) once the env's own processes are stopped.
  # The envId guard never clobbers a sibling env's record.
  if ($leaseIssue -gt 0) { Remove-EnvLease (Get-EnvLeasePath $leaseIssue) $EnvId }
  return $stopped
}

# -- Frontend-only serving (WebviewOnly) --------------------------------------
#
# Post-quit test legs need a webview served while the app is gone (its OTLP
# ports free). The product's own quit path tears down the dev launcher tree AND
# Vite, so nothing serves on the env's Vite port afterwards (#3194/#3195/#3206).
# This action starts ONLY the env's Vite dev server on the Vite port RECORDED in
# its manifest, with the same variable block Up derives. It never starts the
# app, the embedded PostgreSQL cluster, MCP or OTLP, never touches the
# machine-global services or another env, and records the server in the manifest
# under roles `vite-only` / `vite-only-launcher` so the env-scoped Down/Clean
# (and the -Stop switch) reap it.

$script:WebviewOnlyRoles = @("vite-only", "vite-only-launcher")

# The manifest records whose role is in $Roles (never a port scan).
function Get-ManifestRoleRecords {
  param([object]$Manifest, [string[]]$Roles)
  $out = @()
  if (-not $Manifest) { return $out }
  foreach ($p in @($Manifest.processes)) {
    if (-not $p) { continue }
    if ($Roles -contains [string]$p.role) { $out += $p }
  }
  return $out
}

# Add/replace ONE process record in the env manifest, preserving every other
# field and process. BOM-free UTF-8, matching Write-EnvManifest.
function Add-EnvManifestProcess {
  param([string]$Path, [string]$Role, [int]$ProcessId, [string]$StartedAt)
  $manifest = Read-EnvManifest $Path
  if (-not $manifest) { return $false }
  $procs = @($manifest.processes | Where-Object { $_ -and ([string]$_.role -ne $Role) })
  $procs += [pscustomobject]@{ pid = $ProcessId; role = $Role; startedAt = $StartedAt }
  $manifest.processes = @($procs)
  $json = $manifest | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

# Remove ONLY the named roles from the env manifest; every other record and every
# other field is preserved.
function Remove-EnvManifestRoles {
  param([string]$Path, [string[]]$Roles)
  $manifest = Read-EnvManifest $Path
  if (-not $manifest) { return }
  $kept = @($manifest.processes | Where-Object { $_ -and ($Roles -notcontains [string]$_.role) })
  $manifest.processes = @($kept)
  $json = $manifest | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# HTTP readiness probe: a REAL HTTP status line from the dev server, not just a
# bound socket. Raw TCP + `GET /` keeps the probe independent of PowerShell's
# HTTP stack (no proxy autodiscovery) and bounds BOTH the connect and the read.
# Returns the status code (0 when unreachable). The three targets cover
# `localhost` resolving to IPv4 or IPv6 (Vite binds only one on Windows).
function Get-HttpStatus {
  param([int]$Port, [int]$TimeoutSec = 2)
  $timeoutMs = [Math]::Max(500, $TimeoutSec * 1000)
  foreach ($target in @(
      @{ Host = "localhost"; V6 = $false },
      @{ Host = "127.0.0.1"; V6 = $false },
      @{ Host = "::1"; V6 = $true }
    )) {
    $client = $null
    try {
      if ($target.V6) {
        $client = [System.Net.Sockets.TcpClient]::new([System.Net.Sockets.AddressFamily]::InterNetworkV6)
      } else {
        $client = [System.Net.Sockets.TcpClient]::new()
      }
      $iar = $client.BeginConnect($target.Host, $Port, $null, $null)
      if (-not $iar.AsyncWaitHandle.WaitOne($timeoutMs)) { continue }
      try { $client.EndConnect($iar) } catch { continue }
      $client.ReceiveTimeout = $timeoutMs
      $stream = $client.GetStream()
      $reqBytes = [System.Text.Encoding]::ASCII.GetBytes("GET / HTTP/1.0`r`nHost: localhost`r`nConnection: close`r`n`r`n")
      $stream.Write($reqBytes, 0, $reqBytes.Length)
      $stream.Flush()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
      $statusLine = $reader.ReadLine()
      if ($statusLine -and $statusLine -match '^HTTP/\d\.\d\s+(\d{3})') { return [int]$Matches[1] }
    } catch {
    } finally {
      if ($client) { try { $client.Close() } catch {} }
    }
  }
  return 0
}

# The serving checkout recorded in the env manifest (absolute as written by Up; a
# relative value is anchored at the repo root). $null when it is not a directory.
function Resolve-ManifestServingDir {
  param([object]$Manifest)
  $raw = ""
  if ($Manifest -and $Manifest.servingCheckout) { $raw = [string]$Manifest.servingCheckout }
  if (-not $raw) { $raw = $script:RepoRoot }
  $dir = if ([System.IO.Path]::IsPathRooted($raw)) { $raw } else { Join-Path $script:RepoRoot $raw }
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  return (Resolve-Path -LiteralPath $dir).Path
}

# Stop ONLY the roles this verb records: manifest-scoped and image-guarded
# (R-3.1/R-3.3), with the same bounded graceful -> hard-kill ladder as Down.
# Returns $true when no recorded target is alive afterwards.
function Stop-WebviewOnlyRoles {
  param([object]$Manifest)
  $targets = @()
  foreach ($p in (Get-ManifestRoleRecords -Manifest $Manifest -Roles $script:WebviewOnlyRoles)) {
    $procId = 0
    if (-not [int]::TryParse([string]$p.pid, [ref]$procId) -or $procId -le 0) { continue }
    $role = [string]$p.role
    $image = Get-ProcessImageName $procId
    if (-not $image) {
      Write-Log "webview-only $role PID $procId is gone -- skip"
      continue
    }
    if (-not (Test-RoleImageMatch -Role $role -Image $image)) {
      Write-Log "REFUSING to kill webview-only PID ${procId}: role '$role' expects image '$($script:RoleImage[$role] -join '/')' but live image is '$image' (stale/reused PID)." -Level WARN
      continue
    }
    $targets += @{ pid = $procId; role = $role; image = $image }
  }

  if ($targets.Count -eq 0) { return $true }

  $boundSecs = [Math]::Min([Math]::Max($TimeoutSecs, 1), 5)
  foreach ($t in $targets) {
    Write-Log "Stopping webview-only $($t.role) PID $($t.pid) ($($t.image))..."
    Invoke-NativeQuiet taskkill /PID $t.pid /T | Out-Null
  }
  $deadline = (Get-Date).AddSeconds($boundSecs)
  while ((Get-Date) -lt $deadline) {
    if (@($targets | Where-Object { Get-ProcessImageName $_.pid }).Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }

  $survivors = @($targets | Where-Object { Get-ProcessImageName $_.pid })
  foreach ($t in $survivors) {
    Write-Log "webview-only $($t.role) PID $($t.pid) survived the graceful stop -- hard-kill fallback." -Level WARN
    Invoke-NativeQuiet taskkill /PID $t.pid /T /F | Out-Null
  }
  $deadline2 = (Get-Date).AddSeconds($boundSecs)
  while ((Get-Date) -lt $deadline2) {
    if (@($survivors | Where-Object { Get-ProcessImageName $_.pid }).Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }

  $left = @($targets | Where-Object { Get-ProcessImageName $_.pid })
  return ($left.Count -eq 0)
}

# WebviewOnly -Stop: env-scoped teardown of ONLY this verb's recorded server.
function Invoke-WebviewOnlyStop {
  $manifest = Read-EnvManifest $ManifestPath
  if (-not $manifest) {
    Write-Log "env '$EnvId' has no manifest at $ManifestPath -- nothing to stop (safe no-op)."
    return $true
  }
  if ($manifest.envId -and ([string]$manifest.envId -ne $EnvId)) {
    Write-Log "ERROR: manifest $ManifestPath belongs to env '$($manifest.envId)', not '$EnvId' -- refusing to stop another env's server (R-3.1)." -Level ERROR
    return $false
  }
  $records = @(Get-ManifestRoleRecords -Manifest $manifest -Roles $script:WebviewOnlyRoles)
  if ($records.Count -eq 0) {
    Write-Log "env '$EnvId' manifest records no webview-only server -- nothing to stop."
  }
  $stopped = Stop-WebviewOnlyRoles -Manifest $manifest
  Remove-EnvManifestRoles -Path $ManifestPath -Roles $script:WebviewOnlyRoles

  $vite = 0
  if ($manifest.ports -and $manifest.ports.vite) { $vite = [int]$manifest.ports.vite }
  if ($vite -gt 0) {
    if (Test-Port $vite) {
      $owner = Get-PidByPort $vite
      Write-Log "WARNING: Vite port $vite is STILL BOUND after the webview-only stop (owner PID $owner) -- not this verb's recorded role, so it was not killed." -Level WARN
    } else {
      Write-Log "Vite port $vite closed."
    }
  }
  if (-not $stopped) {
    Write-Log "ERROR: a recorded webview-only process survived the hard-kill fallback." -Level ERROR
    return $false
  }
  Write-Log "env '$EnvId' webview-only server stopped."
  return $true
}

# WebviewOnly start: start ONLY the env's Vite dev server (idempotent).
function Invoke-WebviewOnlyStart {
  $manifest = Read-EnvManifest $ManifestPath
  if (-not $manifest) {
    Write-Log "WEBVIEW-ONLY REFUSED: env '$EnvId' has no manifest at $ManifestPath." -Level ERROR
    Write-Log "This verb serves an EXISTING env's recorded Vite port -- start the env once with -Action Up -Spec <N> [-EnvId <id>], or pass the env's actual -EnvId (see .opencode/state/env-leases/<N>.json)." -Level ERROR
    return $false
  }
  if ($manifest.envId -and ([string]$manifest.envId -ne $EnvId)) {
    Write-Log "WEBVIEW-ONLY REFUSED: manifest $ManifestPath belongs to env '$($manifest.envId)', not '$EnvId' (never another env's server)." -Level ERROR
    return $false
  }
  $vite = 0
  if ($manifest.ports -and $manifest.ports.vite) { $vite = [int]$manifest.ports.vite }
  if ($vite -le 0) {
    Write-Log "WEBVIEW-ONLY REFUSED: env '$EnvId' manifest records no Vite port (ports.vite is 0/absent)." -Level ERROR
    return $false
  }
  $serving = Resolve-ManifestServingDir -Manifest $manifest
  if (-not $serving) {
    Write-Log "WEBVIEW-ONLY REFUSED: the manifest's serving checkout does not exist." -Level ERROR
    return $false
  }
  if (-not (Test-Path -LiteralPath (Join-Path $serving "pnpm-workspace.yaml")) -or
      -not (Test-Path -LiteralPath (Join-Path $serving "apps\tauri\vite.config.ts"))) {
    Write-Log "WEBVIEW-ONLY REFUSED: $serving is not a Fredo workspace (pnpm-workspace.yaml / apps/tauri/vite.config.ts missing)." -Level ERROR
    return $false
  }
  if (-not (Test-Path -LiteralPath (Join-Path $serving "node_modules"))) {
    Write-Log "WEBVIEW-ONLY REFUSED: $serving has no node_modules -- run 'pnpm install --frozen-lockfile' there first." -Level ERROR
    return $false
  }

  # Idempotency: OUR recorded server alive AND owning the recorded port AND
  # answering HTTP => report it and exit 0. A second call never starts a second
  # server.
  foreach ($rec in (Get-ManifestRoleRecords -Manifest $manifest -Roles @("vite-only"))) {
    $procId = 0
    if (-not [int]::TryParse([string]$rec.pid, [ref]$procId) -or $procId -le 0) { continue }
    $image = Get-ProcessImageName $procId
    if (-not $image -or -not (Test-RoleImageMatch -Role "vite-only" -Image $image)) { continue }
    $owner = Get-PidByPort $vite
    if ($owner -and ([int]$owner -eq $procId)) {
      $code = Get-HttpStatus $vite
      Write-Log "webview-only idempotency probe: recorded PID $procId owns :$vite, HTTP status $code"
      if ($code -gt 0) {
        Write-Host "WEBVIEW-ONLY ALREADY SERVING port=$vite pid=$procId"
        Write-Host "READY (Vite dev server already serving at http://localhost:$vite/; http=$code; the app and PostgreSQL were NOT started)"
        return $true
      }
    } else {
      Write-Log "webview-only idempotency probe: recorded PID $procId does not own :$vite (owner '$owner')" -Level WARN
    }
  }

  # Any stale record of ours (alive but not owning the port) is reaped before a
  # fresh start -- manifest-scoped and image-guarded, never a port scan.
  $stale = @(Get-ManifestRoleRecords -Manifest $manifest -Roles $script:WebviewOnlyRoles)
  if ($stale.Count -gt 0) {
    Write-Log "Clearing stale webview-only record(s) before a fresh start..."
    if (-not (Stop-WebviewOnlyRoles -Manifest $manifest)) {
      Write-Log "WEBVIEW-ONLY REFUSED: a stale recorded webview-only process survived the stop; not starting a second server." -Level ERROR
      return $false
    }
    Remove-EnvManifestRoles -Path $ManifestPath -Roles $script:WebviewOnlyRoles
    $manifest = Read-EnvManifest $ManifestPath
  }

  # The env's app must be gone: this verb is for the POST-QUIT window.
  foreach ($rec in (Get-ManifestRoleRecords -Manifest $manifest -Roles @("app"))) {
    $procId = 0
    if (-not [int]::TryParse([string]$rec.pid, [ref]$procId) -or $procId -le 0) { continue }
    $image = Get-ProcessImageName $procId
    if ($image -and (Test-RoleImageMatch -Role "app" -Image $image)) {
      Write-Log "WEBVIEW-ONLY REFUSED: env '$EnvId' app (PID $procId) is still RUNNING." -Level ERROR
      Write-Log "This verb is for the post-quit window (OTLP ports free, webview still served). Quit the app first, then retry." -Level ERROR
      return $false
    }
  }

  # Fail-closed collision gate: never scan to another port, never kill a foreign
  # owner, never touch another env.
  if (Test-Port $vite) {
    $owner = Get-PidByPort $vite
    Write-Log "WEBVIEW-ONLY REFUSED: recorded Vite port $vite is already bound by PID $owner (not this verb's recorded server)." -Level ERROR
    Write-Log "Fail-closed: no port scan/fallback and no foreign-owner kill. Stop the owner or use the env that owns it." -Level ERROR
    return $false
  }

  # The env's variable block, derived the same way Up derives it (the manifest's
  # recorded values are authoritative; per-env paths come from the same Names
  # Block).
  $mcpRec   = if ($manifest.ports -and $manifest.ports.mcp) { [int]$manifest.ports.mcp } else { $McpPort }
  $grpcRec  = if ($manifest.ports -and $manifest.ports.otlpGrpc) { [int]$manifest.ports.otlpGrpc } else { $OtlpGrpcPort }
  $httpRec  = if ($manifest.ports -and $manifest.ports.otlpHttp) { [int]$manifest.ports.otlpHttp } else { $OtlpHttpPort }
  $dataRec  = if ($manifest.dataDir) { [string]$manifest.dataDir } else { $DataDir }
  $pipeRec  = if ($manifest.pipe) { [string]$manifest.pipe } else { $CliPipe }
  $wvRec    = if ($manifest.webviewProfile) { [string]$manifest.webviewProfile } else { $WebviewDir }

  $env:FREDO_ENV_ID                     = $EnvId
  $env:FREDO_ENV_ROOT                   = $EnvRoot
  $env:FREDO_ENV_MANIFEST               = $ManifestPath
  $env:FREDO_EVIDENCE_FILE              = $EvidencePath
  $env:FREDO_DATA_DIR                   = $dataRec
  $env:FREDO_PG_DATA_DIR                = $PgDataDir
  $env:FREDO_PG_LOCK_DIR                = $PgLockDir
  $env:FREDO_DBCLIENT_STATE_DIR         = $DbClientDir
  $env:FREDO_CLI_PIPE                   = $pipeRec
  $env:FREDO_MCP_BASE_PORT              = "$mcpRec"
  $env:FREDO_VITE_PORT                  = "$vite"
  $env:FREDO_WEBVIEW_PROFILE_DIR        = $wvRec
  $env:FREDO_LLAMA_SERVER_COMPANION_DIR = $CompanionDir
  $env:FREDO_INGEST_GRPC_PORT           = "$grpcRec"
  $env:FREDO_INGEST_HTTP_PORT           = "$httpRec"
  $env:WEBVIEW2_USER_DATA_FOLDER        = $wvRec
  $env:OPENCODE_ENABLE_TELEMETRY        = "1"
  $env:OPENCODE_OTLP_ENDPOINT           = "http://localhost:$grpcRec"
  $env:OPENCODE_OTLP_PROTOCOL           = "grpc"

  # Caller -EnvVar seam wins (Up parity), except the recorded Vite port: the
  # manifest is the env contract and the readiness probe must match it.
  if ($EnvVars -and $EnvVars.Count -gt 0) {
    foreach ($envKey in @($EnvVars.Keys)) {
      if ([string]$envKey -eq "FREDO_VITE_PORT" -and ([string]$EnvVars[$envKey]).Trim() -ne "$vite") {
        Write-Log "WEBVIEW-ONLY REFUSED: -EnvVar FREDO_VITE_PORT=$($EnvVars[$envKey]) contradicts the manifest's recorded Vite port $vite." -Level ERROR
        return $false
      }
      [Environment]::SetEnvironmentVariable([string]$envKey, [string]$EnvVars[$envKey], "Process")
      Write-Log "Injected env var $envKey for the webview-only server"
    }
  }

  # Per-env log dir sits beside the manifest (<env-root>/logs), never elsewhere.
  $webviewLogDir = Join-Path (Split-Path -Parent $ManifestPath) "logs"
  if (-not (Test-Path -LiteralPath $webviewLogDir)) { New-Item -ItemType Directory -Path $webviewLogDir -Force | Out-Null }
  $webviewStdout = Join-Path $webviewLogDir "webview-only-stdout.log"
  $webviewStderr = Join-Path $webviewLogDir "webview-only-stderr.log"
  $startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

  Write-Log "Starting frontend-only Vite (env '$EnvId' from $serving, port :$vite; app/PostgreSQL are NOT started)..."
  # G-450 caller contract: use the ONE handle-whitelist spawn primitive. Plain
  # Start-Process (even with -RedirectStandardOutput) inherits EVERY inheritable
  # handle, so the long-lived cmd -> node/vite tree would keep an inline caller's
  # stdout pipe open after this script exits. Start-DetachedProcess passes exactly
  # stdin=NUL + the two declared log files.
  $detachModule = Join-Path $PSScriptRoot "detach-process.psm1"
  if (-not (Test-Path -LiteralPath $detachModule)) {
    Write-Log "WEBVIEW-ONLY REFUSED: detach-process.psm1 not found next to dev-env.ps1 (G-450 handle-whitelist spawn primitive)." -Level ERROR
    return $false
  }
  Import-Module $detachModule -Force
  $cmdExe = $env:ComSpec
  if (-not $cmdExe) { $cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe" }
  $launcherPid = Start-DetachedProcess -FilePath $cmdExe -ArgumentString "/c pnpm --filter @fredo/tauri exec vite" `
    -WorkingDirectory $serving -StdOutPath $webviewStdout -StdErrPath $webviewStderr
  if (-not $launcherPid -or $launcherPid -le 0) {
    Write-Log "ERROR: could not launch the frontend-only Vite process tree (Start-DetachedProcess returned $launcherPid)." -Level ERROR
    return $false
  }
  if (-not (Add-EnvManifestProcess -Path $ManifestPath -Role "vite-only-launcher" -ProcessId ([int]$launcherPid) -StartedAt $startedAt)) {
    Write-Log "ERROR: could not record the webview-only launcher in the env manifest -- reaping it rather than running unrecorded." -Level ERROR
    Invoke-NativeQuiet taskkill /PID $launcherPid /T /F | Out-Null
    return $false
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSecs)
  $code = 0
  $portSeen = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $vite) {
      if (-not $portSeen) {
        Write-Log "Vite port :$vite bound; waiting for an HTTP response..."
        $portSeen = $true
      }
      $code = Get-HttpStatus $vite
      if ($code -gt 0) { break }
    }
    Start-Sleep -Milliseconds 500
  }

  if ($code -le 0) {
    Write-Log "ERROR: frontend-only Vite did not answer on :$vite within ${TimeoutSecs}s." -Level ERROR
    $current = Read-EnvManifest $ManifestPath
    $survivors = @(Get-ManifestRoleRecords -Manifest $current -Roles $script:WebviewOnlyRoles)
    if ($survivors.Count -gt 0) {
      Stop-WebviewOnlyRoles -Manifest $current | Out-Null
    } elseif ($launcherPid -gt 0) {
      Invoke-NativeQuiet taskkill /PID $launcherPid /T /F | Out-Null
    }
    Remove-EnvManifestRoles -Path $ManifestPath -Roles $script:WebviewOnlyRoles
    Write-Log "Logs: $webviewStdout / $webviewStderr" -Level WARN
    return $false
  }

  $vitePid = Get-PidByPort $vite
  if (-not $vitePid) { $vitePid = $launcherPid }
  if (-not (Add-EnvManifestProcess -Path $ManifestPath -Role "vite-only" -ProcessId ([int]$vitePid) -StartedAt $startedAt)) {
    Write-Log "ERROR: the server answered but could not be recorded in the env manifest -- reaping it rather than running unrecorded." -Level ERROR
    $current = Read-EnvManifest $ManifestPath
    if ($current) { Stop-WebviewOnlyRoles -Manifest $current | Out-Null }
    Invoke-NativeQuiet taskkill /PID $launcherPid /T /F | Out-Null
    Remove-EnvManifestRoles -Path $ManifestPath -Roles $script:WebviewOnlyRoles
    return $false
  }
  Write-Host "WEBVIEW-ONLY SERVING port=$vite pid=$vitePid"
  Write-Host "READY (Vite dev server at http://localhost:$vite/; http=$code; app NOT started, PostgreSQL NOT started)"
  Write-Log "env '$EnvId' frontend-only server serving on :$vite (manifest: $ManifestPath)"
  return $true
}

# Remove one env artifact, refusing the repo root and any filesystem root.
function Remove-EnvPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return }
  if ($full -eq $script:RepoRoot) {
    Write-Log "REFUSING to remove the repo root ($full)." -Level WARN
    return
  }
  if ($full -eq [System.IO.Path]::GetPathRoot($full)) {
    Write-Log "REFUSING to remove a filesystem root ($full)." -Level WARN
    return
  }
  if (-not (Test-Path -LiteralPath $full)) { return }
  try { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  if (Test-Path -LiteralPath $full) {
    Write-Log "WARNING: could not fully remove $full (locked/in use)." -Level WARN
  } else {
    Write-Log "Removed $full"
  }
}

# Env-scoped Clean: stop the env, then remove ONLY its manifest, DB, and cache
# (R-3.2). Sibling environments' paths are distinct and never touched.
function Invoke-EnvClean {
  $stopped = Invoke-EnvDown
  $artifacts = @(
    $ManifestPath, $EvidencePath,
    (Join-Path $EnvRoot "tauri.env.conf.json"),
    $DataDir, $PgDataDir, $PgLockDir, $DbClientDir,
    $WebviewDir, $CompanionDir, $LogDir
  )
  foreach ($a in $artifacts) { Remove-EnvPath $a }
  # Drop the env root itself only when it is now empty (never a shared dir).
  if ((Test-Path -LiteralPath $EnvRoot) -and
      (@(Get-ChildItem -LiteralPath $EnvRoot -Force -ErrorAction SilentlyContinue).Count -eq 0)) {
    Remove-EnvPath $EnvRoot
  }
  if (-not $stopped) {
    Write-Log "WARNING: env '$EnvId' clean removed its artifacts but some recorded processes were still alive." -Level WARN
    return $false
  }
  Write-Log "env '$EnvId' cleaned (manifest, DB, cache removed)."
  return $true
}

# -- Same-issue env lease + env-aware Status/Logs (Spec #2944 ST-6 / CU-C) -----

# Per-issue env-lease path (Names Block): .opencode/state/env-leases/<issue>.json.
# The file is keyed by issue, so different issues never share a lease and may run
# concurrently (R-3.4).
function Get-EnvLeasePath {
  param([uint64]$SpecIssue)
  return (Join-Path $script:RepoRoot ".opencode\state\env-leases\$SpecIssue.json")
}

function Read-EnvLease {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

# A lease is LIVE when its recorded PID is a running process; a missing/dead PID
# is STALE. The probe is a single process-existence check -- bounded, never a
# wait loop (G-263). R-3.4: one environment per issue/spec.
function Test-EnvLeaseLive {
  param([object]$Lease)
  if (-not $Lease) { return $false }
  $leasePid = 0
  if (-not [int]::TryParse([string]$Lease.pid, [ref]$leasePid) -or $leasePid -le 0) { return $false }
  return ($null -ne (Get-Process -Id $leasePid -ErrorAction SilentlyContinue))
}

function Write-EnvLease {
  param([string]$Path, [uint64]$SpecIssue, [string]$LeaseEnvId, [string]$ServingCheckout, [int]$LeasePid)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $obj = [ordered]@{
    issue           = $SpecIssue
    envId           = $LeaseEnvId
    servingCheckout = $ServingCheckout
    pid             = $LeasePid
    startedAt       = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  $json = $obj | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# Remove the lease for an issue. When -LeaseEnvId is given, the lease is removed
# ONLY when it belongs to that env -- a teardown never clobbers a sibling env's
# record (R-3.1).
function Remove-EnvLease {
  param([string]$Path, [string]$LeaseEnvId = "")
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if ($LeaseEnvId) {
    $l = Read-EnvLease $Path
    if ($l -and $l.envId -and ([string]$l.envId -ne $LeaseEnvId)) { return }
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

# Repo-relative path for the lease's servingCheckout (Names Block: .serve/<issue>);
# falls back to the absolute path when the checkout is outside the repo.
function Get-RepoRelativePath {
  param([string]$Path)
  if (-not $Path) { return "" }
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetFullPath($script:RepoRoot)
    if ($full -ieq $root) { return "." }
    $prefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      return ($full.Substring($prefix.Length)).Replace('\', '/')
    }
  } catch {}
  return $Path
}

# HEAD of a checkout, or $null when it cannot be resolved (native stderr must
# not throw under $ErrorActionPreference = "Stop").
function Get-GitHead {
  param([string]$Dir)
  if (-not $Dir) { return $null }
  if (-not [System.IO.Path]::IsPathRooted($Dir)) { $Dir = Join-Path $script:RepoRoot $Dir }
  if (-not (Test-Path -LiteralPath $Dir)) { return $null }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = (& git -C $Dir rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    return $out
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Format-ShortSha {
  param([string]$Sha)
  if (-not $Sha) { return "" }
  return $Sha.Substring(0, [Math]::Min(8, $Sha.Length))
}

# Read-only isolation assertion for env-aware Status (Spec #2944 ST-7): invoke
# the sibling verify-env-isolation.ps1 checker in `-Scan -Summary` mode and
# return its single result line. This NEVER kills, binds, or mutates -- it is a
# pure read (manifests + process table + listening sockets, each bounded). The
# checker owns the CONTINUOUS invariant; Status merely surfaces it. Any failure
# to run the checker degrades to an "unknown" line and never fails Status.
function Get-EnvIsolationLine {
  $checker = Join-Path $PSScriptRoot "verify-env-isolation.ps1"
  if (-not (Test-Path -LiteralPath $checker)) {
    return "unknown (verify-env-isolation.ps1 not found)"
  }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    # Always include THIS env's manifest explicitly (covers a custom env root)
    # and -Scan for any siblings under the default envs root.
    $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $checker, "-Scan", "-Summary")
    if ($ManifestPath) { $psArgs += @("-ManifestPath", $ManifestPath) }
    $out = & powershell @psArgs 2>&1
    $exit = $LASTEXITCODE
    $line = ""
    foreach ($l in @($out)) {
      $s = ([string]$l).Trim()
      if ($s) { $line = $s }
    }
    if (-not $line) {
      if ($exit -eq 0) { $line = "OK" } else { $line = "FAILED (exit $exit)" }
    }
    return $line
  } catch {
    return "unknown ($($_.Exception.Message))"
  } finally {
    $ErrorActionPreference = $prev
  }
}

# Env-aware Status (Spec #2944 ST-6): env id + ports + manifest currency. The
# switch branches on $IsEnvMode first, so the legacy (unset -EnvId) Status
# strings stay byte-identical.
function Invoke-EnvStatus {
  $manifest = Read-EnvManifest $ManifestPath

  # The manifest is the recorded source of truth for an env's ports/paths; fall
  # back to the resolved script-scope values when it is absent.
  $vVite = $VitePort; $vMcp = $McpPort; $vGrpc = $OtlpGrpcPort; $vHttp = $OtlpHttpPort
  $vPipe = $CliPipe; $vServing = $ServingDir; $vDb = $DbPath
  $displayIssue = $Spec
  if ($manifest) {
    if ($manifest.ports) {
      if ($manifest.ports.vite)     { $vVite = [int]$manifest.ports.vite }
      if ($manifest.ports.mcp)      { $vMcp = [int]$manifest.ports.mcp }
      if ($manifest.ports.otlpGrpc) { $vGrpc = [int]$manifest.ports.otlpGrpc }
      if ($manifest.ports.otlpHttp) { $vHttp = [int]$manifest.ports.otlpHttp }
    }
    if ($manifest.pipe) { $vPipe = [string]$manifest.pipe }
    if ($manifest.servingCheckout) { $vServing = [string]$manifest.servingCheckout }
    if ($manifest.dbPath) { $vDb = [string]$manifest.dbPath }
    if ($displayIssue -eq 0 -and $manifest.spec) { $displayIssue = [uint64]$manifest.spec }
  }

  $ports = Test-BothPorts $vVite $vMcp
  $state = "stopped"
  if ($ports.Vite -and $ports.Mcp) { $state = "running" }
  elseif ($ports.Vite -or $ports.Mcp) { $state = "starting" }

  Write-Host "env $EnvId (issue $displayIssue) -- $state"
  Write-Host "  ports            : Vite $vVite  MCP $vMcp  OTLP/gRPC $vGrpc  OTLP/HTTP $vHttp"
  Write-Host "  pipe             : $vPipe"
  Write-Host "  serving checkout : $vServing"
  Write-Host "  db               : $vDb"
  Write-Host "  manifest         : $ManifestPath"
  # Spec #2944 ST-7: continuous isolation invariant, read-only. Surface it on
  # its own Status line; Status semantics (running/starting/stopped + exit 0)
  # are unchanged.
  Write-Host "  isolation        : $(Get-EnvIsolationLine)"

  if (-not $manifest) {
    Write-Host "  manifest currency: unknown (no manifest -- env not started)"
    return
  }

  $served = [string]$manifest.servedCommit
  $head = Get-GitHead $vServing
  if (-not $head) {
    Write-Host "  manifest currency: unknown (cannot resolve serving HEAD at $vServing)"
  } elseif ($served -and ($head -ieq $served)) {
    Write-Host "  manifest currency: current (servedCommit $(Format-ShortSha $served) == serving HEAD $(Format-ShortSha $head))"
  } else {
    Write-Host "  manifest currency: STALE (manifest $(Format-ShortSha $served) != serving HEAD $(Format-ShortSha $head)) -- re-run: dev-env.ps1 -Action Up -Spec $displayIssue -EnvId $EnvId"
  }
  if ($manifest.appIdentity) { Write-Host "  app identity     : $($manifest.appIdentity)" }

  $live = @()
  foreach ($p in @($manifest.processes)) {
    if (-not $p) { continue }
    $procId = 0
    if (-not [int]::TryParse([string]$p.pid, [ref]$procId)) { continue }
    $alive = $null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)
    $live += "$($p.role) $procId ($(if ($alive) { 'alive' } else { 'dead' }))"
  }
  if ($live.Count -gt 0) { Write-Host "  processes        : $($live -join ', ')" }
}

# Env-aware Logs (Spec #2944 ST-6): tail the env's OWN log dir, refusing to show
# another env's logs when the manifest disagrees, and discover the timestamped
# fallback logs Up uses when the primary handle is locked.
function Invoke-EnvLogs {
  $manifest = Read-EnvManifest $ManifestPath
  if ($manifest -and $manifest.envId -and ([string]$manifest.envId -ne $EnvId)) {
    Write-Host "env '$EnvId' manifest $ManifestPath belongs to env '$($manifest.envId)' -- refusing to show another env's logs."
    return
  }
  $displayIssue = $Spec
  if ($displayIssue -eq 0 -and $manifest -and $manifest.spec) { $displayIssue = [uint64]$manifest.spec }
  Write-Host "=== env '$EnvId' logs ($LogDir) ===" -ForegroundColor Cyan

  $stdout = $Stdout
  $stderr = $Stderr
  if (-not (Test-Path -LiteralPath $stdout) -and (Test-Path -LiteralPath $LogDir)) {
    $latest = Get-ChildItem -LiteralPath $LogDir -Filter "dev-env-stdout*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) { $stdout = $latest.FullName }
  }
  if (-not (Test-Path -LiteralPath $stderr) -and (Test-Path -LiteralPath $LogDir)) {
    $latest = Get-ChildItem -LiteralPath $LogDir -Filter "dev-env-stderr*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) { $stderr = $latest.FullName }
  }

  $hasOutput = $false
  if (Test-Path -LiteralPath $stdout) {
    Write-Host "=== stdout (last $Lines lines): $stdout ===" -ForegroundColor Cyan
    Get-Content -LiteralPath $stdout -Tail $Lines
    $hasOutput = $true
  }
  if (Test-Path -LiteralPath $stderr) {
    Write-Host ""
    Write-Host "=== stderr (last $Lines lines): $stderr ===" -ForegroundColor Cyan
    Get-Content -LiteralPath $stderr -Tail $Lines
    $hasOutput = $true
  }
  if (-not $hasOutput) {
    Write-Host "No log files found at $LogDir"
    Write-Host "Run 'dev-env.ps1 -Action Up -Spec $displayIssue -EnvId $EnvId' first to start this environment."
  }
}

# -- Env-isolation guard (Spec #3066) -----------------------------------------
#
# The shared app-data cluster lives at %APPDATA%\com.fredo.app, with its PG data
# dir at <shared>\postgres. A dev/test/pipeline ROUND must never resolve onto it:
# a legacy Up injects no FREDO_DATA_DIR, so the launched app resolves the shared
# dir; the FREDO_PG_PASSWORD_FILE sentinel is consulted FIRST by
# PgCredential::resolve() (credentials.rs) and feeds initdb, so a RESET there
# would re-password the shared cluster with a password the keychain does not hold
# -- the persistent 28P01 boot failure this guard prevents.
#
# The guard is a PRECONDITION on the round's launcher, not a product seam. It
# reads path STRINGS only (canonicalized, case-insensitive), NEVER the shared
# cluster, and refuses BEFORE any PostgreSQL/app start.

# True when $Candidate is equal-to-or-under $Base (canonicalized,
# case-insensitive). GetFullPath normalizes `..` and trailing separators; the
# separator-suffixed prefix check makes a lookalike sibling
# (`...\com.fredo.app-other`) NOT match (R-NF-5). A blank candidate/base is never
# a match.
function Test-PathUnderOrEqual {
  param([string]$Candidate, [string]$Base)
  if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Base)) { return $false }
  try { $c = [System.IO.Path]::GetFullPath($Candidate) } catch { return $false }
  try { $b = [System.IO.Path]::GetFullPath($Base) } catch { return $false }
  $c = $c.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $b = $b.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if ($c -ieq $b) { return $true }
  $prefix = $b + [System.IO.Path]::DirectorySeparatorChar
  return $c.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

# Pure decision: does the resolved app-data OR PG data dir land on the shared
# cluster? Returns a hashtable so the caller can name the offending dimension.
function Test-SharedClusterTarget {
  param([string]$EffAppDataDir, [string]$EffPgDataDir, [string]$SharedAppDataDir)
  $appHit = Test-PathUnderOrEqual -Candidate $EffAppDataDir -Base $SharedAppDataDir
  $pgHit  = Test-PathUnderOrEqual -Candidate $EffPgDataDir  -Base $SharedAppDataDir
  $dimension = ""
  if ($appHit) { $dimension = "app-data dir" } elseif ($pgHit) { $dimension = "pg-data dir" }
  return @{
    Refuse     = ($appHit -or $pgHit)
    AppDataHit = $appHit
    PgDataHit  = $pgHit
    Dimension  = $dimension
  }
}

# Append ONE JSON line (append-only, never rewritten/truncated) recording an
# isolation decision to .opencode/state/env-isolation.jsonl (R-NF-6).
function Write-EnvIsolationAudit {
  param(
    [string]$Decision, [string]$Code, [string]$Reason, [string]$EnvId,
    [string]$ResolvedAppDataDir, [string]$ResolvedPgDataDir, [string]$SharedAppDataDir,
    [object[]]$Seams, [string]$ActionName
  )
  try {
    $dir = Join-Path $script:RepoRoot ".opencode\state"
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $path = Join-Path $dir "env-isolation.jsonl"
    $obj = [ordered]@{
      ts                 = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
      decision           = $Decision
      code               = $Code
      reason             = $Reason
      envId              = $EnvId
      resolvedAppDataDir = $ResolvedAppDataDir
      resolvedPgDataDir  = $ResolvedPgDataDir
      sharedAppDataDir   = $SharedAppDataDir
      seams              = @($Seams)
      action             = $ActionName
    }
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    [System.IO.File]::AppendAllText($path, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Log "WARNING: could not append the env-isolation audit line: $($_.Exception.Message)" -Level WARN
  }
}

# The env-isolation guard. Called on the Up path (when armed) and on the
# AssertIsolation action. Refuses -- printing `ISOLATION REFUSED (<code>): ...`
# and exiting 3 -- BEFORE any PostgreSQL/app start; otherwise records an
# `isolated` audit line and returns.
#
# ARMED IFF the -RequireIsolation switch, FREDO_REQUIRE_ENV_ISOLATION (non-blank,
# not 0/false), or env mode (env mode arms it regardless of the marker). With the
# guard OFF and legacy mode the function returns before any resolution, output,
# or audit -- byte-identical legacy behavior (R-NF-1).
function Assert-NoSharedClusterTarget {
  param([string]$ActionName = "")

  if (-not $ActionName) { $ActionName = $Action }

  $envFlagRaw = [Environment]::GetEnvironmentVariable("FREDO_REQUIRE_ENV_ISOLATION", "Process")
  $envFlagOn = $false
  if (-not [string]::IsNullOrWhiteSpace($envFlagRaw)) {
    $flagVal = ([string]$envFlagRaw).Trim().ToLowerInvariant()
    if ($flagVal -ne "0" -and $flagVal -ne "false") { $envFlagOn = $true }
  }
  $armed = $RequireIsolation.IsPresent -or $envFlagOn -or $IsEnvMode
  if (-not $armed) { return }

  # Shared-cluster identity (canonicalized). FREDO_SHARED_APPDATA_DIR is a test
  # seam; the default is the real OS app-data dir.
  $sharedRaw = [Environment]::GetEnvironmentVariable("FREDO_SHARED_APPDATA_DIR", "Process")
  if ([string]::IsNullOrWhiteSpace($sharedRaw)) {
    $appDataRoot = $env:APPDATA
    if ([string]::IsNullOrWhiteSpace($appDataRoot)) { $appDataRoot = [Environment]::GetFolderPath("ApplicationData") }
    $sharedRaw = Join-Path $appDataRoot "com.fredo.app"
  }
  try { $sharedAppDataDir = [System.IO.Path]::GetFullPath($sharedRaw) } catch { $sharedAppDataDir = $sharedRaw }
  # SharedPgDataDir is the PG-data identity (<shared>\postgres, PG_DATA_SUBDIR);
  # the refusal rule compares each resolved dir against SharedAppDataDir
  # (equal-or-under), which subsumes the PG subdir.
  $sharedPgDataDir = Join-Path $sharedAppDataDir "postgres"

  # Effective resolved dirs the launched app WILL use (env + -EnvVar aware).
  $effAppDataDir = ""
  if ($EnvVars -and $EnvVars.ContainsKey("FREDO_DATA_DIR")) { $effAppDataDir = [string]$EnvVars["FREDO_DATA_DIR"] }
  if (-not $effAppDataDir) { $effAppDataDir = [Environment]::GetEnvironmentVariable("FREDO_DATA_DIR", "Process") }
  if (-not $effAppDataDir) {
    if ($IsEnvMode) { $effAppDataDir = $DataDir } else { $effAppDataDir = $sharedAppDataDir }
  }
  $effPgDataDir = ""
  if ($EnvVars -and $EnvVars.ContainsKey("FREDO_PG_DATA_DIR")) { $effPgDataDir = [string]$EnvVars["FREDO_PG_DATA_DIR"] }
  if (-not $effPgDataDir) { $effPgDataDir = [Environment]::GetEnvironmentVariable("FREDO_PG_DATA_DIR", "Process") }
  if (-not $effPgDataDir) {
    if ($IsEnvMode) { $effPgDataDir = $PgDataDir } else { $effPgDataDir = (Join-Path (Join-Path $effAppDataDir "postgres") "cluster") }
  }

  $verdict = Test-SharedClusterTarget -EffAppDataDir $effAppDataDir -EffPgDataDir $effPgDataDir -SharedAppDataDir $sharedAppDataDir

  # Credential sentinel/fallback seams set NON-BLANK (via -EnvVar or process env).
  # A blank value is NOT "set" (matches credentials.rs's non-blank sentinel rule).
  $seams = @()
  foreach ($seamName in @("FREDO_PG_PASSWORD_FILE", "FREDO_PG_KEYCHAIN_DISABLED")) {
    $seamVal = ""
    if ($EnvVars -and $EnvVars.ContainsKey($seamName)) { $seamVal = [string]$EnvVars[$seamName] }
    if (-not $seamVal) { $seamVal = [Environment]::GetEnvironmentVariable($seamName, "Process") }
    if (-not [string]::IsNullOrWhiteSpace($seamVal)) { $seams += $seamName }
  }

  if ($verdict.Refuse) {
    $offending = if ($verdict.AppDataHit) { $effAppDataDir } else { $effPgDataDir }
    if ($seams.Count -gt 0) {
      $seamHeader = ($seams -join ", ")
      Write-Host "ISOLATION REFUSED (sentinel-seam): $seamHeader is set while the resolved data dir is the shared cluster dir"
      Write-Host "  seam     : $seamHeader"
      Write-Host "  shared   : $sharedAppDataDir"
      Write-Host "The credential sentinel/fallback seam must never run against the shared cluster"
      Write-Host "(it seeds initdb with a password the keychain does not hold). Refusing (fail-closed, R-3)."
      Write-EnvIsolationAudit -Decision "refused" -Code "sentinel-seam" -Reason "$($seams -join ', ') set" `
        -EnvId $EnvId -ResolvedAppDataDir $effAppDataDir -ResolvedPgDataDir $effPgDataDir `
        -SharedAppDataDir $sharedAppDataDir -Seams $seams -ActionName $ActionName
      exit 3
    }
    $specArg = if ($Spec -gt 0) { "$Spec" } else { "<N>" }
    Write-Host "ISOLATION REFUSED (shared-dir): $($verdict.Dimension) resolves to the shared cluster dir"
    Write-Host "  resolved : $offending"
    Write-Host "  shared   : $sharedAppDataDir"
    Write-Host "A dev/test/pipeline round MUST run against its own isolated env slot. Re-run with:"
    Write-Host "  powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec $specArg -EnvId <id> -EnvSlot <n> -RequireIsolation"
    Write-Host "Refusing to start PostgreSQL (fail-closed, R-2)."
    Write-EnvIsolationAudit -Decision "refused" -Code "shared-dir" -Reason "$($verdict.Dimension) resolves to the shared cluster dir" `
      -EnvId $EnvId -ResolvedAppDataDir $effAppDataDir -ResolvedPgDataDir $effPgDataDir `
      -SharedAppDataDir $sharedAppDataDir -Seams $seams -ActionName $ActionName
    exit 3
  }

  Write-EnvIsolationAudit -Decision "isolated" -Code "" -Reason "resolved dirs are isolated" `
    -EnvId $EnvId -ResolvedAppDataDir $effAppDataDir -ResolvedPgDataDir $effPgDataDir `
    -SharedAppDataDir $sharedAppDataDir -Seams $seams -ActionName $ActionName
}

# -- Environment resolution (continues) ---------------------------------------

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
# WebviewOnly is env-schema by definition (it serves a recorded manifest), so a
# bare -Spec/-EnvId resolves the env block even without -EnvSlot/-ServingCheckout.
$IsEnvMode = ($EnvId -ne "") -or ($EnvSlot -ge 1) -or ($ServingCheckout -ne "") -or ($Action -eq "WebviewOnly")

if ($IsEnvMode) {
  # Apply the caller -EnvVar seam BEFORE port resolution so a port supplied via
  # -EnvVar (e.g. FREDO_MCP_BASE_PORT=...) is honored AND recorded.
  if ($EnvVars -and $EnvVars.Count -gt 0) {
    foreach ($envKey in @($EnvVars.Keys)) {
      [Environment]::SetEnvironmentVariable([string]$envKey, [string]$EnvVars[$envKey], "Process")
    }
  }

  if (-not $EnvId) {
    if ($Spec -eq 0) {
      Write-Log "ERROR: env mode requires -EnvId <id> (or -Spec <N> to derive 'spec<N>')." -Level ERROR
      exit 1
    }
    $EnvId = "spec$Spec"
  }
  if ($EnvId -notmatch '^[a-z0-9][a-z0-9_-]{0,31}$') {
    Write-Log "ERROR: -EnvId '$EnvId' is invalid (must match ^[a-z0-9][a-z0-9_-]{0,31}$)." -Level ERROR
    exit 1
  }
  if ($EnvSlot -lt 0) {
    Write-Log "ERROR: -EnvSlot must be >= 0 (got $EnvSlot)." -Level ERROR
    exit 1
  }

  if ($EnvSlot -ge 1) {
    $basePort = 16000 + 10 * ($EnvSlot - 1)
    if ($basePort + 3 -gt 65535) {
      Write-Log "ERROR: -EnvSlot $EnvSlot yields port $($basePort + 3) > 65535." -Level ERROR
      exit 1
    }
    $defVite = $basePort; $defMcp = $basePort + 1; $defGrpc = $basePort + 2; $defHttp = $basePort + 3
  } else {
    $defVite = 5174; $defMcp = 9223; $defGrpc = 4317; $defHttp = 4318
  }
  $VitePort     = Resolve-PortValue -Override $VitePort -EnvName "FREDO_VITE_PORT" -Default $defVite
  $McpPort      = Resolve-PortValue -Override $McpPort  -EnvName "FREDO_MCP_BASE_PORT" -Default $defMcp
  $OtlpGrpcPort = Resolve-PortValue -Override 0 -EnvName "FREDO_INGEST_GRPC_PORT" -Default $defGrpc
  $OtlpHttpPort = Resolve-PortValue -Override 0 -EnvName "FREDO_INGEST_HTTP_PORT" -Default $defHttp

  if ($env:FREDO_ENV_ROOT) {
    $EnvRoot = $env:FREDO_ENV_ROOT
  } else {
    $EnvRoot = Join-Path $script:RepoRoot ".opencode\tmp\envs\$EnvId"
  }
  # FREDO_DATA_DIR defaults to <env-root>/data (Names Block); a pre-set value
  # (via the environment or the -EnvVar seam) is honored and recorded.
  if ($env:FREDO_DATA_DIR) {
    $DataDir = $env:FREDO_DATA_DIR
  } else {
    $DataDir = Join-Path $EnvRoot "data"
  }
  $PgDataDir    = Join-Path $EnvRoot "postgres"
  $PgLockDir    = Join-Path $EnvRoot "lock"
  $DbClientDir  = Join-Path $EnvRoot "dbclient"
  $WebviewDir   = Join-Path $EnvRoot "webview"
  $CompanionDir = Join-Path $EnvRoot "companion"
  $CliPipe      = "\\.\pipe\fredo-ipc-$EnvId"
  $AppIdentity  = "com.fredo.app#$EnvId"
  # Spec #3005: the store is the embedded PostgreSQL cluster; the manifest
  # records the app-data dir (the cluster data dir is <env-root>/postgres and the
  # ephemeral port is ports.pg). No SQLite file exists.
  $DbPath       = $DataDir
  $LogDir       = Join-Path $EnvRoot "logs"

  if ($Manifest) {
    $ManifestPath = if ([System.IO.Path]::IsPathRooted($Manifest)) { $Manifest } else { Join-Path $script:RepoRoot $Manifest }
  } elseif ($env:FREDO_ENV_MANIFEST) {
    $ManifestPath = if ([System.IO.Path]::IsPathRooted($env:FREDO_ENV_MANIFEST)) { $env:FREDO_ENV_MANIFEST } else { Join-Path $script:RepoRoot $env:FREDO_ENV_MANIFEST }
  } else {
    $ManifestPath = Join-Path $EnvRoot "manifest.json"
  }

  if ($env:FREDO_EVIDENCE_FILE) {
    $EvidencePath = if ([System.IO.Path]::IsPathRooted($env:FREDO_EVIDENCE_FILE)) { $env:FREDO_EVIDENCE_FILE } else { Join-Path $script:RepoRoot $env:FREDO_EVIDENCE_FILE }
  } else {
    $EvidencePath = Join-Path $EnvRoot "evidence.json"
  }

  if ($ServingCheckout) {
    $ServingDir = if ([System.IO.Path]::IsPathRooted($ServingCheckout)) { $ServingCheckout } else { Join-Path $script:RepoRoot $ServingCheckout }
  } else {
    $ServingDir = $script:RepoRoot
  }
  if (-not (Test-Path -LiteralPath $ServingDir)) {
    Write-Log "ERROR: -ServingCheckout '$ServingCheckout' does not exist ($ServingDir)." -Level ERROR
    exit 1
  }
  $ServingDir = (Resolve-Path -LiteralPath $ServingDir).Path
} else {
  # Legacy single-env path: pre-#2944 literals, byte-identical.
  if ($VitePort -le 0) { $VitePort = 5174 }
  if ($McpPort -le 0)  { $McpPort = 9223 }
  $OtlpGrpcPort = 4317
  $OtlpHttpPort = 4318
  $CliPipe      = "\\.\pipe\fredo-ipc"
  $ServingDir   = $script:RepoRoot
  $LogDir       = Join-Path $PSScriptRoot "..\logs"
}

$Stdout = Join-Path $LogDir "dev-env-stdout.log"
$Stderr = Join-Path $LogDir "dev-env-stderr.log"

switch ($Action) {

  # -- Up ----------------------------------------------------------------------
  "Up" {
    # Spec #3066: fail closed BEFORE anything (env resolution already ran, but no
    # PostgreSQL/app start and no G-052 check yet) when the round resolves onto
    # the shared cluster. Guard OFF + legacy mode => returns immediately
    # (byte-identical legacy behavior, R-NF-1).
    Assert-NoSharedClusterTarget -ActionName "Up"
    if ($IsEnvMode) {
      # Spec #2944 ST-4: env-aware cold start (per-env ports/data/manifest/logs,
      # devUrl --config override, fail-closed collision gate, recorded-MCP-port
      # readiness). Invoke-EnvUp exits the script itself.
      Invoke-EnvUp
      exit 1
    }
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
        # fast-path exit skips the injection, so a Terminal child may inherit
        # a stale env and emit zero telemetry spans.
        Write-Log "WARNING: OPENCODE_* OTEL vars (telemetry env injection) are guaranteed only on a COLD start -- this fast-path exit does NOT inject them. If Terminal sessions emit zero telemetry spans, run: dev-env.ps1 -Action Down, then dev-env.ps1 -Action Up -Spec $Spec." -Level WARN
        exit 0
      }
    }

    # Kill any stale instance from a previous (possibly mismatched) run.
    # LEGACY single-env only: PID-scoped port-owner kills. NO global
    # image-name kill (Spec #2944 R-3.3 / AC3) -- an image-name sweep would
    # terminate sibling environments. A native-abort survivor is left to
    # process-hygiene.ps1 -KillOrphans (repo-scoped, G-280/G-297).
    foreach ($port in @($McpPort, $VitePort, 4317, 4318)) {
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

    # If a wedged previous instance still holds the primary log file handle,
    # the cmd `>` redirect below would fail to open it and the launch would die
    # silently (observed #2876: a stuck instance held dev-env-stdout.log while
    # :9223/:4318 stayed bound and Vite never came up). Fall back to a
    # per-launch log so a stale handle can never block a cold start.
    try {
      $probe = [System.IO.File]::Open($Stdout, 'Append', 'Write', 'None')
      $probe.Close()
    } catch {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $Stdout = Join-Path $LogDir "dev-env-stdout-$stamp.log"
      $Stderr = Join-Path $LogDir "dev-env-stderr-$stamp.log"
      Write-Log "Primary dev logs are locked by a wedged instance -- falling back to $Stdout" -Level WARN
    }

    # Telemetry prerequisites (G-046): force the OPENCODE_* OTEL vars into the
    # dev instance's environment so fredo.exe AND every opencode session it
    # spawns via Terminal inherit them -- independent of the launching agent's
    # shell state (User-level `setx` vars do NOT propagate into an already-
    # running parent chain). Values mirror setup::configure_opencode_otel.
    $env:OPENCODE_ENABLE_TELEMETRY = "1"
    $env:OPENCODE_OTLP_ENDPOINT    = "http://localhost:4317"
    $env:OPENCODE_OTLP_PROTOCOL    = "grpc"

    # Extra caller-supplied env vars (e.g. the env-gated STT deterministic feed
    # seam). Set on THIS process so the child started below inherits them.
    if ($EnvVars -and $EnvVars.Count -gt 0) {
      foreach ($envKey in @($EnvVars.Keys)) {
        [Environment]::SetEnvironmentVariable([string]$envKey, [string]$EnvVars[$envKey], "Process")
        Write-Log "Injected env var $envKey for the dev instance"
      }
    }

    $proc = Start-Process -FilePath "cmd" `
      -ArgumentList "/c cd /d `"$PWD`" && pnpm dev:tauri > `"$Stdout`" 2> `"$Stderr`"" `
      -WindowStyle Hidden -PassThru

    Write-Log "Launched PID $($proc.Id). Waiting for ports..."

    $deadline = (Get-Date).AddSeconds($TimeoutSecs)
    $viteReady = $ports.Vite
    $mcpReady  = $ports.Mcp
    $appReady  = $false

    while ((Get-Date) -lt $deadline) {
      if (-not $viteReady) {
        $viteReady = Test-Port $VitePort
        if ($viteReady) { Write-Log "Vite :$VitePort ready" }
      }
      if (-not $mcpReady) {
        $mcpReady = Test-Port $McpPort
        if ($mcpReady) { Write-Log "MCP Bridge :$McpPort ready" }
      }
      # G-304: ports alone are a FALSE-READY -- Vite/MCP helpers can outlive a
      # dead app (or the app binary can fail to launch). Require the app
      # process to actually be alive before declaring ready.
      if (-not $appReady) {
        $appReady = [bool](Get-Process -Name "fredo" -ErrorAction SilentlyContinue)
        if ($appReady) { Write-Log "app process 'fredo' alive" }
      }
      if ($viteReady -and $mcpReady -and $appReady) {
        Write-Log "dev:tauri ready"
        exit 0
      }
      Start-Sleep -Seconds 2
    }

    $missing = @()
    if (-not $viteReady) { $missing += "Vite :$VitePort" }
    if (-not $mcpReady)  { $missing += "MCP Bridge :$McpPort" }
    if ($viteReady -and $mcpReady -and -not $appReady) { $missing += "app process 'fredo' (ports bound but the app is not running -- a failed/absent launch is NOT ready)" }
    Write-Log "Timed out after ${TimeoutSecs}s waiting for: $($missing -join ', ')" -Level ERROR
    # Hard-kill fallback (G-263): the readiness wait is wall-clock bounded; reap
    # the failed launch's own tree by PID (never a global image-name kill).
    if ($proc -and $proc.Id) { Invoke-NativeQuiet taskkill /PID $proc.Id /T /F | Out-Null }
    Write-Log "Check logs: powershell -File .opencode/scripts/dev-env.ps1 -Action Logs" -Level WARN
    exit 1
  }

  # -- AssertIsolation (Spec #3066) --------------------------------------------
  # Guard-only: resolve the effective dirs + assert they are NOT the shared
  # cluster. NO PostgreSQL/app launch and NO G-052 root-currency check (it serves
  # nothing). The guard exits 3 on a refusal; otherwise this arm exits 0.
  "AssertIsolation" {
    Assert-NoSharedClusterTarget -ActionName "AssertIsolation"
    exit 0
  }

  # -- WebviewOnly -------------------------------------------------------------
  # Frontend-only serving for the POST-QUIT window (app quit => OTLP ports free,
  # webview still loads). Starts ONLY the env's recorded Vite dev server; never
  # the app, PostgreSQL, MCP or OTLP. -Stop tears down only this verb's roles.
  "WebviewOnly" {
    if (-not $IsEnvMode) {
      Write-Log "ERROR: -Action WebviewOnly requires env mode (-Spec <N> or -EnvId <id>)." -Level ERROR
      exit 1
    }
    if ($Stop) {
      if (Invoke-WebviewOnlyStop) { exit 0 } else { exit 1 }
    }
    if (Invoke-WebviewOnlyStart) { exit 0 } else { exit 1 }
  }

  # -- Down --------------------------------------------------------------------
  "Down" {
    if ($IsEnvMode) {
      # Spec #2944 ST-5: env-scoped teardown -- ONLY this environment's own
      # manifest PIDs, image-guarded. No port-owner enumeration, no global
      # image-name kill (R-3.1/R-3.3). Invoke-EnvDown returns $true when done.
      if (Invoke-EnvDown) { exit 0 } else { exit 1 }
    }

    $killed = $false

    foreach ($port in @($McpPort, $VitePort, 4317, 4318)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Found process $targetPid on port $port. Killing..."
        Invoke-NativeQuiet taskkill /PID $targetPid /T /F | Out-Null
        $killed = $true
      }
    }

    # LEGACY single-env only. NO global image-name kill (Spec #2944 R-3.3 /
    # AC3): an image-name sweep would terminate sibling environments. A
    # native-abort survivor is left to process-hygiene.ps1 -KillOrphans.

    if (-not $killed) {
      Write-Log "No dev:tauri instance found on ports $VitePort / $McpPort"
    } else {
      Write-Log "dev:tauri stopped"
    }

    # Reclaim any port a wedged instance still holds. Retries the targeted kill,
    # then sweeps repo-scoped node/bun dev helpers, so a stale :9223/:4318 socket
    # does not force a reboot (G-163). Only a genuinely orphaned OS socket survives
    # all of this -- surface that precisely, never vaguely.
    Start-Sleep -Seconds 1
    $stuck = @()
    foreach ($port in @($McpPort, $VitePort, 4317, 4318)) {
      if (Test-Port $port) {
        Write-Log "Port $port still bound after Down -- attempting to reclaim..."
        if (Clear-Port $port) {
          Write-Log "Port $port reclaimed."
          $killed = $true
        } else {
          $stuck += $port
        }
      }
    }
    if ($stuck.Count -gt 0) {
      Stop-RepoNodeHolders
      Start-Sleep -Seconds 1
      foreach ($port in $stuck) {
        if ((Test-Port $port) -and -not (Clear-Port $port)) {
          $owner = Get-PidByPort $port
          Write-Log "WARNING: port $port could not be reclaimed (owner PID $owner). This is an orphaned OS-level socket -- the MCP bridge falls back to the next port and the OTLP receiver cannot bind until it clears. Kill the holder (e.g. a node.exe MCP/Vite helper) or reboot." -Level WARN
        } else {
          Write-Log "Port $port reclaimed."
          $killed = $true
        }
      }
    }
  }

  # -- Clean -------------------------------------------------------------------
  "Clean" {
    # Spec #2944 ST-5: env mode only. Stop the environment (manifest-scoped),
    # then remove ONLY its manifest/DB/cache (R-3.2). Legacy mode has no
    # per-env artifacts -- use -Action Down there.
    if (-not $IsEnvMode) {
      Write-Log "ERROR: -Action Clean requires env mode (-EnvId <id> / -EnvSlot <n> / -ServingCheckout). Use -Action Down for the legacy single-env instance." -Level ERROR
      exit 1
    }
    if (Invoke-EnvClean) { exit 0 } else { exit 1 }
  }

  # -- Status ------------------------------------------------------------------
  "Status" {
    if ($IsEnvMode) {
      # Spec #2944 ST-6: env-aware status (env id + ports + manifest currency).
      # The legacy single-env strings below are untouched (R-3.4/R-5.1).
      Invoke-EnvStatus
      exit 0
    }

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
    # -Spec is required by the Up leg. Resolve it BEFORE stopping anything: with
    # the caller's omission previously forwarded as Spec=0, the Up re-invoke hit
    # the ValidateRange guard AFTER the running app had been killed, leaving the
    # instance DOWN (observed #2887 round 2).
    if ($Spec -eq 0) {
      $branch = (git rev-parse --abbrev-ref HEAD).Trim()
      if ($branch -match '^spec/(\d+)$') {
        $Spec = [uint64]$Matches[1]
        Write-Log "Resolved -Spec $Spec from the current branch ($branch)"
      } else {
        Write-Log "ERROR: -Action Restart requires -Spec <N> (the repo root is on '$branch', not spec/<N>). Nothing was stopped." -Level ERROR
        exit 1
      }
    }

    Write-Log "Restarting dev:tauri..."

    if ($IsEnvMode) {
      # Spec #2944 ST-6: env-aware Restart -- stop ONLY via this env's manifest
      # (image-guarded, no port-owner enumeration; R-3.3), then re-start the SAME
      # env. -Spec was resolved ABOVE, before anything was stopped (invariant).
      if (-not (Invoke-EnvDown)) {
        Write-Log "ERROR: env '$EnvId' could not be fully stopped -- refusing to restart (R-3.1)." -Level ERROR
        exit 1
      }
      & $PSCommandPath -Action Up -Spec $Spec -At $At -EnvId $EnvId -EnvSlot $EnvSlot `
        -ServingCheckout $ServingCheckout -Manifest $Manifest -VitePort $VitePort -McpPort $McpPort `
        -TimeoutSecs $TimeoutSecs -EnvVar $EnvVar -EnvVars $EnvVars
      exit $LASTEXITCODE
    }

    foreach ($port in @($McpPort, $VitePort)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Killing process $targetPid on port $port"
        Invoke-NativeQuiet taskkill /PID $targetPid /T /F | Out-Null
      }
    }

    Start-Sleep -Seconds 2

    # Re-invoke Up (forwarding the env forms so injected seams survive a Restart)
    & $PSCommandPath -Action Up -Spec $Spec -At $At -VitePort $VitePort -McpPort $McpPort -TimeoutSecs $TimeoutSecs -EnvVar $EnvVar -EnvVars $EnvVars
    exit $LASTEXITCODE
  }

  # -- Logs --------------------------------------------------------------------
  "Logs" {
    if ($IsEnvMode) {
      # Spec #2944 ST-6: env-aware Logs -- this env's own log dir/manifest.
      Invoke-EnvLogs
      exit 0
    }

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
