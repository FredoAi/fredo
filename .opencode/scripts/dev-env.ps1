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
  no -ServingCheckout keeps the legacy single-env path byte-identical.

.PARAMETER EnvSlot
  Port-block slot (Spec #2944). 0 = legacy defaults (Vite 5174 / MCP 9223 /
  OTLP gRPC 4317 + HTTP 4318 / llama 8080). Slot n >= 1 = base
  P = 16000 + 10*(n-1), with Vite=P, MCP=P+1, OTLP/gRPC=P+2, OTLP/HTTP=P+3,
  llama=P+4. Default: 0.

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

# Kill the process listening on $Port (and its tree), retrying because a
# native-abort instance can survive a first /PID kill and keep the socket, and
# re-running the targeted /IM fredo.exe pass covers an owner already absent from
# Win32_Process enumeration. Returns $true when the port is free afterwards.
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
    Invoke-NativeQuiet taskkill /F /T /IM fredo.exe | Out-Null
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
    Write-Log "ERROR: -At $($atSha.Substring(0, [Math]::Min(8, $atSha.Length))) is NOT reachable from origin/spec/$SpecIssue -- baseline legs serve only PRE-FIX ancestors of the spec branch, never main or foreign commits. A genuine cross-branch measurement is a tooling request to the Self-Improver." -Level ERROR
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
    [int]$VitePort, [int]$McpPort, [int]$OtlpGrpcPort, [int]$OtlpHttpPort, [int]$LlamaPort,
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
      llama    = $LlamaPort
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

  # Fail-closed collision gate (R-4.3): any bound recorded port means a foreign
  # owner. Never scan to / bind a different port; never kill a sibling env.
  $conflicts = @()
  foreach ($p in @($VitePort, $McpPort, $OtlpGrpcPort, $OtlpHttpPort, $LlamaPort)) {
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
  $confJson = (@{ build = @{ devUrl = "http://localhost:$VitePort" } } | ConvertTo-Json -Depth 4)
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
  $env:FREDO_LLAMA_SERVER_PORT          = "$LlamaPort"
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

  $launchCmd = "/c cd /d `"$ServingDir`" && pnpm dev:tauri -- --config `"$confPath`" > `"$stdout`" 2> `"$stderr`""
  $proc = Start-Process -FilePath "cmd" -ArgumentList $launchCmd -WindowStyle Hidden -PassThru
  Write-Log "Launched launcher PID $($proc.Id). Waiting for env ports + app..."

  $startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Write-EnvManifest -ManifestPath $ManifestPath -EnvId $EnvId -Spec $Spec -ServingCheckout $ServingDir `
    -ServedCommit $servedCommit -VitePort $VitePort -McpPort $McpPort -OtlpGrpcPort $OtlpGrpcPort `
    -OtlpHttpPort $OtlpHttpPort -LlamaPort $LlamaPort -DataDir $DataDir -DbPath $DbPath `
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
        -OtlpHttpPort $OtlpHttpPort -LlamaPort $LlamaPort -DataDir $DataDir -DbPath $DbPath `
        -CliPipe $CliPipe -WebviewDir $WebviewDir -AppIdentity $AppIdentity -Processes $procs
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
  Write-Log "Manifest left at $ManifestPath for teardown: dev-env.ps1 -Action Down -EnvId $EnvId" -Level WARN
  Write-Log "Check logs: powershell -File .opencode/scripts/dev-env.ps1 -Action Logs -EnvId $EnvId" -Level WARN
  exit 1
}

# -- Environment resolution (continues) ---------------------------------------

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$IsEnvMode = ($EnvId -ne "") -or ($EnvSlot -ge 1) -or ($ServingCheckout -ne "")

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
    if ($basePort + 4 -gt 65535) {
      Write-Log "ERROR: -EnvSlot $EnvSlot yields port $($basePort + 4) > 65535." -Level ERROR
      exit 1
    }
    $defVite = $basePort; $defMcp = $basePort + 1; $defGrpc = $basePort + 2; $defHttp = $basePort + 3; $defLlama = $basePort + 4
  } else {
    $defVite = 5174; $defMcp = 9223; $defGrpc = 4317; $defHttp = 4318; $defLlama = 8080
  }
  $VitePort     = Resolve-PortValue -Override $VitePort -EnvName "FREDO_VITE_PORT" -Default $defVite
  $McpPort      = Resolve-PortValue -Override $McpPort  -EnvName "FREDO_MCP_BASE_PORT" -Default $defMcp
  $OtlpGrpcPort = Resolve-PortValue -Override 0 -EnvName "FREDO_INGEST_GRPC_PORT" -Default $defGrpc
  $OtlpHttpPort = Resolve-PortValue -Override 0 -EnvName "FREDO_INGEST_HTTP_PORT" -Default $defHttp
  $LlamaPort    = Resolve-PortValue -Override 0 -EnvName "FREDO_LLAMA_SERVER_PORT" -Default $defLlama

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
  $DbPath       = Join-Path $DataDir "fredo.db"
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
  $LlamaPort    = 8080
  $CliPipe      = "\\.\pipe\fredo-ipc"
  $ServingDir   = $script:RepoRoot
  $LogDir       = Join-Path $PSScriptRoot "..\logs"
}

$Stdout = Join-Path $LogDir "dev-env-stdout.log"
$Stderr = Join-Path $LogDir "dev-env-stderr.log"

switch ($Action) {

  # -- Up ----------------------------------------------------------------------
  "Up" {
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
    foreach ($port in @($McpPort, $VitePort, 4317, 4318)) {
      $stalePid = Get-PidByPort $port
      if ($stalePid) {
        Write-Log "Killing stale instance PID $stalePid (port :$port)..."
        Invoke-NativeQuiet taskkill /PID $stalePid /T /F | Out-Null
        Start-Sleep -Seconds 1
      }
    }
    # A terminating fredo.exe can hold its ports and its log handles while
    # being absent from Win32_Process enumeration (observed #2876: a
    # native-abort instance survived /PID kills and kept :9223/:4318 plus
    # dev-env-stdout.log). /IM reaches it by image name regardless.
    Invoke-NativeQuiet taskkill /F /T /IM fredo.exe | Out-Null

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
    Write-Log "Check logs: powershell -File .opencode/scripts/dev-env.ps1 -Action Logs" -Level WARN
    exit 1
  }

  # -- Down --------------------------------------------------------------------
  "Down" {
    $killed = $false

    foreach ($port in @($McpPort, $VitePort, 4317, 4318)) {
      $targetPid = Get-PidByPort $port
      if ($targetPid) {
        Write-Log "Found process $targetPid on port $port. Killing..."
        Invoke-NativeQuiet taskkill /PID $targetPid /T /F | Out-Null
        $killed = $true
      }
    }

    # Terminating fredo.exe instances can hold ports/log handles while being
    # absent from Win32_Process enumeration; /IM reaches them by image name
    # (observed #2876: a native-abort instance survived port-owner /PID kills).
    Invoke-NativeQuiet taskkill /F /T /IM fredo.exe | Out-Null

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
