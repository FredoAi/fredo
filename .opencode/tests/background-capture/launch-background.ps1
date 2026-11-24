<#
.SYNOPSIS
  Launch / window-visibility / stop probe for the background-capture suite (issue #3193).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). The spec's launch contract is "argv is exactly
  [<exe>, --background]", and NO committed lever can produce that argv: `dev-env.ps1` (the
  sanctioned environment harness) has no app-argument passthrough - it runs `pnpm tauri dev` with a
  merged config only - and `second-launch.ps1` (resident-shell suite) deliberately launches with NO
  argument and requires a resident instance to already exist.

  So this script owns the one missing lever: start the env's OWN binary with `--background` as its
  SOLE argument, with that environment's FULL `FREDO_*` resolution injected into the child.

  #3193 ROUND 1 DEFECT, FIXED BY CONSTRUCTION. The previous version injected only pipe/dataDir/ports
  from the manifest, so `FREDO_PG_DATA_DIR` was UNSET in the child - and the product's default for an
  unset override is the MACHINE-GLOBAL shared PostgreSQL cluster. A test launcher therefore wrote
  spans into the human's cluster (observed: the child ESTABLISHED to :56839 while the env cluster had
  POSTGRES_TREE_COUNT=0), and the round's ingestion receipt was unverifiable because the shared
  cluster is off-limits to read. `dev-env.ps1` computes the Names-Block for its OWN child only
  (`:728-746`) and does not persist it in the manifest, so an out-of-process launcher must RE-DERIVE
  it. It does so here from two documented sources and says which one each value came from:
    * the MANIFEST (`<env-root>/manifest.json`, written by `dev-env.ps1` Write-EnvManifest
      `:574-592`): envId, servingCheckout, servedCommit, dataDir, pipe, webviewProfile, ports.*;
    * the DOCUMENTED ENV-ROOT LAYOUT (`dev-env.ps1:1524-1546`): env root = the manifest's parent,
      and `<env-root>/postgres` (cluster), `<env-root>/lock`, `<env-root>/dbclient`,
      `<env-root>/companion`, `<env-root>/evidence.json`.
  The block is FAIL-CLOSED. A missing/unreadable manifest, an absent `servingCheckout`, a derived PG
  data dir that does not exist or that is NOT inside the env root - each prints `ERROR: ...` and
  exits 2 WITHOUT launching. It is impossible for this script to fall back to the shared cluster,
  because the fallback would require `FREDO_PG_DATA_DIR` to be unset or to point elsewhere, and both
  are refused before any process starts. `PORTS.PG IS NEVER A PORT` (it is constructed as a constant
  0; the cluster is found by the data dir, and its ephemeral port is only knowable from the product).

  WHY THE WINDOW READING IS NATIVE. The feature declares `tauri.conf.json app.windows[0].visible =
  false`, so the `main` window EXISTS from launch while nothing is shown. Two product-side reads
  therefore CANNOT witness "no window shown":
    * `app_lifecycle_status.mainWindowOpen` is `app.get_webview_window("main").is_some()` -
      EXISTENCE, not visibility (infrastructure/tray.rs:342-347);
    * the window list (`tauri_manage_window action="list"`) lists a hidden window too (the
      resident-shell suite's own N-1 states this).

  THE PREDICATE (replaces the round-1 `MAIN_WINDOW_HANDLE=0` literal, which a DEBUG build could never
  satisfy): "NO VISIBLE TOP-LEVEL WINDOW OWNED BY THE APP PID, EXCLUDING CLASS `ConsoleWindowClass`".
  A debug build's console window is a visible top-level window whose title is the exe path and whose
  class is `ConsoleWindowClass`; it is the QAs own build artifact, not a product surface, so it is
  excluded by CLASS (never by title text). The script prints every observation the predicate is
  judged on - the full per-PID window list with `visible`, `class` and `title` - plus the console
  window count, so a verdict can quote the raw enumeration instead of one magic handle.
  A reading is never fabricated from an empty enumeration: `DESKTOP_WINDOW_COUNT=0` (EnumWindows
  itself returned nothing) is an instrument failure, exit 2 (G-469 - two empty readings are equal).

  MODES (-Action)
    Launch     Resolve + inject the env Names-Block, start `<exe> --background`, and wait (bounded)
               until the process is alive AND owns the env's own OTLP gRPC, OTLP HTTP and MCP ports.
               Prints the Names-Block (isolation receipt), the native window enumeration and the
               env-cluster postmaster observation. This script does NOT pass the AC for you.
    Windows    Read the native window state of a live PID (default: the manifest's `app` PID).
               Hard-fails when the PID is not live - a zero from a dead PID is not a reading.
    Kill       Bounded force-stop of a PID (cleanup for a background instance that never shows a
               window). Prints ALIVE_AFTER.

  -DryRun (with -Action Launch): resolve and PRINT the exact env block (name=value, one per line),
  the resolved exe path and the exact argv, then exit 0 WITHOUT spawning. It runs the SAME
  isolation gates as a real launch (manifest, servingCheckout, derived cluster dir, containment), so
  if the block prints, the launch's cluster/pipe/profile resolution is the printed one. The ONE
  difference is the binary: a dry run reports `EXE_EXISTS=` instead of refusing, because a reviewer
  checking isolation must not need a built artifact - the LAUNCH path still refuses a missing exe
  with exit 2, and a dry run never spawns, so it cannot be used to skip that gate.

  MANIFEST KEYS come only from `manifest-facts.ps1` (dot-sourced from the resident-shell suite - one
  vocabulary, not a copy); `servingCheckout` is read through that file's generic key reader because
  the key is already in its documented table.

.EXAMPLE
  powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Launch -DryRun -ManifestPath .opencode/tmp/envs/spec3193/manifest.json

.EXAMPLE
  powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Launch -ManifestPath .opencode/tmp/envs/spec3193/manifest.json -Exe apps/tauri/src-tauri/target/debug/fredo.exe

.EXAMPLE
  powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Windows -ManifestPath .opencode/tmp/envs/spec3193/manifest.json

.EXAMPLE
  powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Kill -TargetPid 12345

  Exit codes: 0 success (Launch: started and ready; DryRun: resolved and printed); 1 Launch did not
  become ready inside the bound (row signal; the started PID is printed so the tester can stop it);
  2 usage / manifest / exe / absent-input / isolation failure (never launches when it exits 2).

  PowerShell 5.1-safe. ASCII only outside comments.
#>
param(
  [ValidateSet("Launch", "Windows", "Kill")][string]$Action = "Launch",
  [string]$ManifestPath = "",
  [string]$Exe = "",
  [int]$TargetPid = 0,
  [int]$TimeoutSecs = 180,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Fail {
  param([string]$Message)
  Write-Output ("ERROR: " + $Message)
  exit 2
}

if ($DryRun -and $Action -ne "Launch") {
  Write-Fail ("-DryRun only describes a launch; it cannot be combined with -Action " + $Action + " (use -Action Launch)")
}

$factsScript = Join-Path $PSScriptRoot "..\resident-shell\manifest-facts.ps1"
$factsResolved = Resolve-Path -LiteralPath $factsScript -ErrorAction SilentlyContinue
if ($null -eq $factsResolved) {
  Write-Fail ("shared manifest reader not found: " + $factsScript + " (the resident-shell suite owns the manifest-key vocabulary)")
}
. ([string]$factsResolved.Path)

# One derivation helper over the shared normalizer: is this path the root itself or under it?
# Written as an EQUALITY/PREFIX test on the normalized form, so a neighbouring path of a similar
# name (`...\envs\spec31930\...` vs `...\envs\spec3193\...`) cannot read as "inside".
function Test-PathUnderRoot {
  param([string]$Path, [string]$Root)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  if ([string]::IsNullOrWhiteSpace($Root)) { return $false }
  $normalizedPath = ConvertTo-MatchablePath -Path $Path
  $normalizedRoot = ConvertTo-MatchablePath -Path $Root
  if ([string]::IsNullOrWhiteSpace($normalizedPath)) { return $false }
  if ([string]::IsNullOrWhiteSpace($normalizedRoot)) { return $false }
  if ($normalizedPath -eq $normalizedRoot) { return $true }
  return $normalizedPath.StartsWith($normalizedRoot + "\")
}

$manifest = $null
$manifestFullPath = ""
if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
  if (-not (Test-Path -LiteralPath $ManifestPath)) { Write-Fail ("manifest not found: " + $ManifestPath + " (refusing to launch without the env resolution)") }
  $manifestResolved = Resolve-Path -LiteralPath $ManifestPath -ErrorAction SilentlyContinue
  if ($null -eq $manifestResolved) { Write-Fail ("manifest path could not be resolved: " + $ManifestPath) }
  $manifestFullPath = [string]$manifestResolved.Path
  $manifest = Read-ManifestFile -Path $manifestFullPath
  if ($null -eq $manifest) { Write-Fail ("manifest is not valid JSON: " + $manifestFullPath + " (refusing to launch without the env resolution)") }
}

# ---- Native window enumeration ------------------------------------------------
# Top-level windows of ONE pid, with the two properties the predicate needs (visibility + class).
# Get-Process.MainWindowHandle is NOT the instrument: it reports the FIRST visible titled window of
# the process, which for a debug build is the console window (so a hidden product window still read
# a non-zero handle in #3193 round 1).
$windowProbeSource = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class FredoWindowProbe
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    public static List<IntPtr> AllTopLevelWindows()
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) { found.Add(hWnd); return true; }, IntPtr.Zero);
        return found;
    }

    public static List<IntPtr> WindowsForProcess(int pid)
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint owner = 0;
            GetWindowThreadProcessId(hWnd, out owner);
            if ((int)owner == pid) { found.Add(hWnd); }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string ClassOf(IntPtr hWnd)
    {
        StringBuilder buffer = new StringBuilder(512);
        GetClassName(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static string TitleOf(IntPtr hWnd)
    {
        int length = GetWindowTextLength(hWnd);
        if (length <= 0) { return ""; }
        StringBuilder buffer = new StringBuilder(length + 2);
        GetWindowText(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }
}
"@

$windowProbeLoaded = $false
try {
  Add-Type -TypeDefinition $windowProbeSource -ErrorAction Stop
  $windowProbeLoaded = $true
} catch {
  if ([string]$_.Exception.Message -match 'already exists') {
    $windowProbeLoaded = $true
  } else {
    Write-Fail ("the native window enumerator could not be compiled: " + $_.Exception.Message + " (a zero from a broken enumerator is not a window reading)")
  }
}
if (-not $windowProbeLoaded) {
  Write-Fail "the native window enumerator is unavailable (a zero from a broken enumerator is not a window reading)"
}

function Get-WindowReading {
  param([int]$ReadPid)
  $proc = Get-Process -Id $ReadPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    Write-Fail ("PID " + $ReadPid + " is not live: a window reading from a dead process is not a reading")
  }

  $desktopWindows = @()
  try { $desktopWindows = @([FredoWindowProbe]::AllTopLevelWindows()) } catch { Write-Fail ("EnumWindows failed: " + $_.Exception.Message) }
  # THE CONTROL (G-469): if the enumerator itself sees no windows, "0 visible windows for the PID" is
  # a fabricated zero - two empty readings compared equal. Refuse to report it.
  if ($desktopWindows.Count -le 0) {
    Write-Fail ("EnumWindows returned no top-level windows at all on this desktop: the enumerator is broken, so 'no visible window' would be a fabricated zero")
  }

  $pidWindows = @()
  try { $pidWindows = @([FredoWindowProbe]::WindowsForProcess($ReadPid)) } catch { Write-Fail ("window enumeration for PID " + $ReadPid + " failed: " + $_.Exception.Message) }

  $consoleCount = 0
  $visibleConsoleCount = 0
  $visibleNonConsole = @()
  $lines = @()
  $index = 0
  foreach ($hwnd in $pidWindows) {
    $visible = $false
    $class = ""
    $title = ""
    try {
      $visible = [bool][FredoWindowProbe]::IsWindowVisible($hwnd)
      $class = [string][FredoWindowProbe]::ClassOf($hwnd)
      $title = [string][FredoWindowProbe]::TitleOf($hwnd)
    } catch {
      Write-Fail ("reading one enumerated window failed: " + $_.Exception.Message)
    }
    if ($class -eq "ConsoleWindowClass") {
      $consoleCount++
      if ($visible) { $visibleConsoleCount++ }
    }
    $lines += ("WINDOW index=" + $index + " hwnd=0x" + $hwnd.ToInt64().ToString("X") + " visible=" + $visible + " class=" + $class + " title=[" + $title + "]")
    if ($visible -and ($class -ne "ConsoleWindowClass")) {
      $visibleNonConsole += [pscustomobject]@{ Handle = ("0x" + $hwnd.ToInt64().ToString("X")); Class = $class; Title = $title }
    }
    $index++
  }

  $legacyHandle = 0
  $legacyTitle = ""
  try {
    $pointer = $proc.MainWindowHandle
    if ($null -ne $pointer) { $legacyHandle = $pointer.ToInt64() }
  } catch { $legacyHandle = 0 }
  try { $legacyTitle = [string]$proc.MainWindowTitle } catch { $legacyTitle = "" }

  $nonConsoleTitles = @()
  $nonConsoleHandles = @()
  $nonConsoleClasses = @()
  foreach ($entry in $visibleNonConsole) {
    $nonConsoleTitles += $entry.Title
    $nonConsoleHandles += $entry.Handle
    $nonConsoleClasses += $entry.Class
  }

  Write-Output ("TARGET_PID=" + $ReadPid)
  Write-Output "TARGET_ALIVE=True"
  Write-Output "WINDOW_SOURCE=EnumWindows + GetWindowThreadProcessId + IsWindowVisible + GetClassName + GetWindowText (native, out-of-process)"
  Write-Output "WINDOW_PREDICATE=no VISIBLE top-level window owned by the app PID, excluding class ConsoleWindowClass (a debug build's console)"
  Write-Output ("DESKTOP_WINDOW_COUNT=" + $desktopWindows.Count)
  Write-Output ("WINDOW_COUNT=" + $pidWindows.Count)
  Write-Output "WINDOW_LIST_BEGIN"
  foreach ($line in $lines) { Write-Output $line }
  Write-Output "WINDOW_LIST_END"
  Write-Output ("CONSOLE_WINDOW_COUNT=" + $consoleCount)
  Write-Output ("CONSOLE_WINDOW_VISIBLE_COUNT=" + $visibleConsoleCount)
  Write-Output ("CONSOLE_WINDOW_CLASS=ConsoleWindowClass")
  Write-Output ("VISIBLE_NON_CONSOLE_WINDOW_COUNT=" + $visibleNonConsole.Count)
  Write-Output ("VISIBLE_NON_CONSOLE_WINDOW_HANDLES=" + ($nonConsoleHandles -join ","))
  Write-Output ("VISIBLE_NON_CONSOLE_WINDOW_CLASSES=" + ($nonConsoleClasses -join ","))
  Write-Output ("VISIBLE_NON_CONSOLE_WINDOW_TITLES=" + ($nonConsoleTitles -join " ~ "))
  $shown = ($visibleNonConsole.Count -gt 0)
  Write-Output ("VISIBLE_PRODUCT_WINDOW=" + $shown)
  # Diagnostic only, kept so a receipt can quote what the round-1 row was reading. It is NOT the
  # predicate: it can be the console window's handle.
  Write-Output ("MAIN_WINDOW_HANDLE=" + $legacyHandle)
  Write-Output ("MAIN_WINDOW_TITLE=" + $legacyTitle)
  Write-Output "MAIN_WINDOW_HANDLE_NOTE=Get-Process.MainWindowHandle reports the FIRST visible titled window of the PID and can be the debug CONSOLE window; judge the row on VISIBLE_PRODUCT_WINDOW / the WINDOW_LIST, never on this handle"
  # Result is published through a script-scope fact, never as a pipeline object: the KEY=value lines
  # above must reach stdout, and a captured return value would swallow them.
  $script:LastVisibleProductWindow = [bool]$shown
  $script:LastVisibleWindowTitles = ($nonConsoleTitles -join " ~ ")
}

function Test-PortListening {
  param([int]$Port)
  if ($Port -le 0) { return $false }
  $connections = @()
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
  return ($connections.Count -gt 0)
}

function Get-PortOwnerPid {
  param([int]$Port)
  if ($Port -le 0) { return 0 }
  $owner = 0
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) { $owner = [int]$connection.OwningProcess }
  } catch {
    $owner = 0
  }
  return $owner
}

if ($Action -eq "Kill") {
  $target = $TargetPid
  if ($target -le 0) {
    if ($null -ne $manifest) { $target = Get-ManifestAppPid -Manifest $manifest }
  }
  if ($target -le 0) { Write-Fail "Kill needs -TargetPid or a manifest carrying an 'app' process (no PID to stop)" }
  $proc = Get-Process -Id $target -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    Write-Fail ("PID " + $target + " is not live: nothing to stop (an absent target must not read as 'stopped')")
  }
  Write-Output ("KILL_TARGET_PID=" + $target)
  try { Stop-Process -Id $target -Force -ErrorAction Stop } catch { Write-Fail ("Stop-Process failed for PID " + $target + ": " + $_.Exception.Message) }
  $deadline = (Get-Date).AddSeconds(30)
  $alive = $true
  while ((Get-Date) -lt $deadline) {
    $still = Get-Process -Id $target -ErrorAction SilentlyContinue
    if ($null -eq $still) { $alive = $false; break }
    Start-Sleep -Milliseconds 250
  }
  Write-Output ("ALIVE_AFTER=" + $alive)
  if ($alive) {
    Write-Output "RESULT=FAIL"
    exit 1
  }
  Write-Output "RESULT=OK"
  exit 0
}

if ($Action -eq "Windows") {
  Write-Output "ACTION=Windows"
  $target = $TargetPid
  if ($target -le 0) {
    if ($null -eq $manifest) { Write-Fail ("Windows needs -TargetPid or -ManifestPath (no PID to read)") }
    $target = Get-ManifestAppPid -Manifest $manifest
    if ($target -le 0) { Write-Fail ("manifest carries no 'app' process PID: " + $ManifestPath + " (a zero from an unmatched predicate is not a window reading)") }
  }
  Get-WindowReading -ReadPid $target
  if ($null -ne $manifest) {
    Write-Output ("ENV_ID=" + (Get-ManifestEnvId -Manifest $manifest))
    Write-Output ("SERVED_COMMIT=" + (Get-ManifestServedCommit -Manifest $manifest))
  }
  Write-Output "RESULT=OK"
  exit 0
}

# ---- Launch / DryRun: resolve the env Names-Block ------------------------------
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  Write-Fail "Launch needs -ManifestPath (the env's process manifest: see the documented key table)"
}

$envId = Get-ManifestEnvId -Manifest $manifest
$servedCommit = Get-ManifestServedCommit -Manifest $manifest
$servingCheckout = Get-ManifestKeyText -Manifest $manifest -Key "servingCheckout"
$cliPipe = Get-ManifestPipe -Manifest $manifest
$dataDir = Get-ManifestDataDir -Manifest $manifest
$webviewProfile = Get-ManifestWebviewProfile -Manifest $manifest
$envRoot = Get-ManifestEnvRoot -ManifestPath $manifestFullPath
$grpcPort = Get-ManifestPort -Manifest $manifest -Name "otlpGrpc"
$httpPort = Get-ManifestPort -Manifest $manifest -Name "otlpHttp"
$mcpPort = Get-ManifestPort -Manifest $manifest -Name "mcp"
$vitePort = Get-ManifestPort -Manifest $manifest -Name "vite"
$manifestPgPort = Get-ManifestPort -Manifest $manifest -Name "pg"

# --- fail-closed gates (nothing below this block may launch) --------------------
if ([string]::IsNullOrWhiteSpace($envId)) {
  Write-Fail ("manifest carries no 'envId' (" + $manifestFullPath + "): the env identity is required for an isolated launch")
}
if ([string]::IsNullOrWhiteSpace($envRoot)) {
  Write-Fail ("cannot derive the env root from the manifest path (" + $manifestFullPath + "): the documented layout is <env-root>/manifest.json")
}
if ([string]::IsNullOrWhiteSpace($servingCheckout)) {
  Write-Fail ("manifest carries no 'servingCheckout' (" + $manifestFullPath + "): refusing to launch without knowing which checkout is served")
}
if ([string]::IsNullOrWhiteSpace($cliPipe)) {
  Write-Fail "manifest carries no 'pipe' - refusing to launch onto the legacy/shared pipe (env isolation)"
}
if ([string]::IsNullOrWhiteSpace($dataDir)) {
  Write-Fail "manifest carries no 'dataDir' - refusing to launch without the env resolution"
}
if ([string]::IsNullOrWhiteSpace($webviewProfile)) {
  Write-Fail "manifest carries no 'webviewProfile' - refusing to launch onto the shared WebView2 profile (env isolation)"
}
if ($grpcPort -le 0 -or $httpPort -le 0 -or $mcpPort -le 0) {
  Write-Fail ("manifest ports are incomplete (otlpGrpc=" + $grpcPort + " otlpHttp=" + $httpPort + " mcp=" + $mcpPort + "): the readiness gates cannot be evaluated")
}

# The DERIVED cluster dir (`dev-env.ps1:1535`: FREDO_PG_DATA_DIR = <env-root>/postgres). This is the
# gate that makes a shared-cluster fallback impossible: an unset or elsewhere-pointing cluster dir is
# refused here, never defaulted by the product.
$pgDataDir = Join-Path $envRoot "postgres"
$pgLockDir = Join-Path $envRoot "lock"
$dbClientDir = Join-Path $envRoot "dbclient"
$companionDir = Join-Path $envRoot "companion"
$evidencePath = Join-Path $envRoot "evidence.json"

$pgDataDirExists = $false
try { $pgDataDirExists = Test-Path -LiteralPath $pgDataDir -PathType Container } catch { $pgDataDirExists = $false }
if (-not $pgDataDirExists) {
  Write-Fail ("the derived PG cluster dir does not exist: " + $pgDataDir + " (documented layout <env-root>/postgres; refusing to launch - an unset FREDO_PG_DATA_DIR would make the product open the MACHINE-GLOBAL shared cluster)")
}
$pgDataUnderRoot = Test-PathUnderRoot -Path $pgDataDir -Root $envRoot
if (-not $pgDataUnderRoot) {
  Write-Fail ("the derived PG cluster dir is NOT inside the env root (dir=" + $pgDataDir + " root=" + $envRoot + "): refusing to launch outside the env's own data")
}
$dataDirUnderRoot = Test-PathUnderRoot -Path $dataDir -Root $envRoot
if (-not $dataDirUnderRoot) {
  Write-Fail ("the manifest dataDir is NOT inside the env root (dir=" + $dataDir + " root=" + $envRoot + "): refusing to launch an app whose data escapes the env")
}
$webviewUnderRoot = Test-PathUnderRoot -Path $webviewProfile -Root $envRoot
if (-not $webviewUnderRoot) {
  Write-Fail ("the manifest webviewProfile is NOT inside the env root (dir=" + $webviewProfile + " root=" + $envRoot + "): refusing to launch onto a shared WebView2 profile")
}

# --- exe (parameter first, else the served checkout's own dev build) ------------
# RESOLVED, not gated here: `-DryRun` exists so a reviewer can check the DERIVATION (which cluster,
# which pipe, which profile) without a built binary, so its exe is reported plus an EXE_EXISTS flag.
# The LAUNCH path re-asserts existence and refuses (exit 2) when it is missing - a dry run never
# turns into a spawn, so it cannot be a way around the launch's own fail-closed gate.
$exeSource = ""
if (-not [string]::IsNullOrWhiteSpace($Exe)) {
  $exeSource = "param (-Exe)"
  $exeCandidate = $Exe
} else {
  $exeSource = "servingCheckout-default (apps/tauri/src-tauri/target/debug/fredo.exe)"
  $exeCandidate = Join-Path $servingCheckout "apps\tauri\src-tauri\target\debug\fredo.exe"
}
$exeResolved = Resolve-Path -LiteralPath $exeCandidate -ErrorAction SilentlyContinue
$exeExists = ($null -ne $exeResolved)
if ($exeExists) {
  $exePath = [string]$exeResolved.Path
} else {
  $exePath = $exeCandidate
}
$workingDirectory = Split-Path -Parent $exePath
$servingCheckoutExists = $false
try { $servingCheckoutExists = Test-Path -LiteralPath $servingCheckout -PathType Container } catch { $servingCheckoutExists = $false }

# --- the block: one entry per variable, each naming its SOURCE ------------------
$entries = @()
function Add-BlockEntry {
  param([string]$Name, [string]$Value, [string]$Source)
  $script:entries += [pscustomobject]@{ Name = $Name; Value = $Value; Source = $Source }
}

Add-BlockEntry -Name "FREDO_ENV_ID" -Value $envId -Source "manifest envId"
Add-BlockEntry -Name "FREDO_ENV_ROOT" -Value $envRoot -Source "derived: manifest parent dir (dev-env.ps1:1524-1527)"
Add-BlockEntry -Name "FREDO_ENV_MANIFEST" -Value $manifestFullPath -Source "derived: the resolved -ManifestPath (dev-env.ps1:731,1553)"
Add-BlockEntry -Name "FREDO_EVIDENCE_FILE" -Value $evidencePath -Source "derived: <env-root>/evidence.json (dev-env.ps1:731,1556-1560)"
Add-BlockEntry -Name "FREDO_DATA_DIR" -Value $dataDir -Source "manifest dataDir (dev-env.ps1:586)"
Add-BlockEntry -Name "FREDO_PG_DATA_DIR" -Value $pgDataDir -Source "derived: <env-root>/postgres (dev-env.ps1:733,1535)"
Add-BlockEntry -Name "FREDO_PG_LOCK_DIR" -Value $pgLockDir -Source "derived: <env-root>/lock (dev-env.ps1:734,1536)"
Add-BlockEntry -Name "FREDO_DBCLIENT_STATE_DIR" -Value $dbClientDir -Source "derived: <env-root>/dbclient (dev-env.ps1:735,1537)"
Add-BlockEntry -Name "FREDO_CLI_PIPE" -Value $cliPipe -Source "manifest pipe (dev-env.ps1:588)"
Add-BlockEntry -Name "FREDO_MCP_BASE_PORT" -Value ([string]$mcpPort) -Source "manifest ports.mcp (dev-env.ps1:581)"
Add-BlockEntry -Name "FREDO_WEBVIEW_PROFILE_DIR" -Value $webviewProfile -Source "manifest webviewProfile (dev-env.ps1:589)"
Add-BlockEntry -Name "FREDO_LLAMA_SERVER_COMPANION_DIR" -Value $companionDir -Source "derived: <env-root>/companion (dev-env.ps1:740,1539)"
Add-BlockEntry -Name "FREDO_INGEST_GRPC_PORT" -Value ([string]$grpcPort) -Source "manifest ports.otlpGrpc (dev-env.ps1:582)"
Add-BlockEntry -Name "FREDO_INGEST_HTTP_PORT" -Value ([string]$httpPort) -Source "manifest ports.otlpHttp (dev-env.ps1:583)"
Add-BlockEntry -Name "WEBVIEW2_USER_DATA_FOLDER" -Value $webviewProfile -Source "manifest webviewProfile (dev-env.ps1:746)"
Add-BlockEntry -Name "OPENCODE_ENABLE_TELEMETRY" -Value "1" -Source "constant (dev-env.ps1:743)"
Add-BlockEntry -Name "OPENCODE_OTLP_ENDPOINT" -Value ("http://localhost:" + $grpcPort) -Source "derived from manifest ports.otlpGrpc (dev-env.ps1:744)"
Add-BlockEntry -Name "OPENCODE_OTLP_PROTOCOL" -Value "grpc" -Source "constant (dev-env.ps1:745)"

$unsetNotes = @()
if ($vitePort -gt 0) {
  Add-BlockEntry -Name "FREDO_VITE_PORT" -Value ([string]$vitePort) -Source "manifest ports.vite (dev-env.ps1:580)"
} else {
  $unsetNotes += "FREDO_VITE_PORT: NOT SET - manifest ports.vite=" + $vitePort + " (dev-env.ps1:1518 only exports a resolved Vite port)"
}
$unsetNotes += "PG PORT: NOT EXPORTED - manifest ports.pg=" + $manifestPgPort + " is a CONSTANT 0 by construction (dev-env.ps1:584); the cluster is found through FREDO_PG_DATA_DIR and its ephemeral port is only knowable from the product (pg_supervisor_status.port). Never assume a PG port."

function Write-EnvBlock {
  Write-Output "ENV_BLOCK_BEGIN"
  foreach ($entry in $entries) { Write-Output ($entry.Name + "=" + $entry.Value) }
  Write-Output "ENV_BLOCK_END"
  Write-Output "ENV_BLOCK_SOURCES_BEGIN"
  foreach ($entry in $entries) { Write-Output ("SOURCE " + $entry.Name + " <- " + $entry.Source) }
  Write-Output "ENV_BLOCK_SOURCES_END"
  foreach ($note in $unsetNotes) { Write-Output ("ENV_UNSET_NOTE=" + $note) }
}

# Any `FREDO_*` left in THIS process would be inherited by the child and could silently re-point a
# seam the block does not own (a stale `FREDO_VITE_PORT`, or a `FREDO_PG_DATA_DIR` from another env).
# `dev-env.ps1` starts from its own resolution; this script starts from an arbitrary caller, so it
# must CLEAR the namespace it owns before injecting. Every cleared name is printed.
function Get-StaleFredoEnvNames {
  $names = @()
  $blockNames = @()
  foreach ($entry in $entries) { $blockNames += $entry.Name }
  $current = [Environment]::GetEnvironmentVariables("Process")
  foreach ($key in @($current.Keys)) {
    $name = [string]$key
    if ($name -notmatch '^FREDO_') { continue }
    if ($blockNames -contains $name) { continue }
    $names += $name
  }
  return @($names | Sort-Object -Unique)
}

function Write-IsolationChecks {
  Write-Output "ISOLATION_CHECKS_BEGIN"
  Write-Output ("FREDO_PG_DATA_DIR=" + $pgDataDir)
  Write-Output ("FREDO_PG_DATA_DIR_EXISTS=" + $pgDataDirExists)
  Write-Output ("FREDO_PG_DATA_DIR_UNDER_ENV_ROOT=" + $pgDataUnderRoot)
  Write-Output ("FREDO_DATA_DIR_UNDER_ENV_ROOT=" + $dataDirUnderRoot)
  Write-Output ("WEBVIEW_PROFILE_UNDER_ENV_ROOT=" + $webviewUnderRoot)
  Write-Output ("ENV_ROOT=" + $envRoot)
  Write-Output ("SERVING_CHECKOUT=" + $servingCheckout)
  Write-Output ("SERVING_CHECKOUT_EXISTS=" + $servingCheckoutExists)
  Write-Output "ISOLATION_CHECKS_END"
}

function Write-PostmasterObservation {
  # Independence: an env-scoped postmaster can only exist if the child resolved ITS OWN cluster dir,
  # so this is the cross-check that the Names-Block above was actually honoured by the product.
  # Membership uses the shared normalizer PLUS a path boundary: a plain substring test would also
  # match a SIBLING directory (`<env-root>/postgres.rejected-<ts>`, which dev-env leaves behind), and
  # a postmaster of that abandoned cluster is not this env's cluster.
  $pgProcs = @()
  $enumOk = $true
  try {
    $pgProcs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'postgres.exe'" -ErrorAction Stop)
  } catch {
    $enumOk = $false
    $pgProcs = @()
  }
  Write-Output ("PG_ENUM_OK=" + $enumOk)
  if (-not $enumOk) {
    Write-Output "ENV_POSTMASTER_PIDS=(enumeration failed; not a zero count)"
  } else {
    $needle = ConvertTo-MatchablePath -Path $pgDataDir
    $boundary = [regex]::Escape($needle) + '(?![\\a-z0-9._-])'
    $masters = @()
    foreach ($pgProc in $pgProcs) {
      if (Test-PostgresChildProc -Proc $pgProc) { continue }
      $commandLine = ConvertTo-MatchablePath -Path ([string]$pgProc.CommandLine)
      if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
      if ($commandLine -notmatch $boundary) { continue }
      $masters += $pgProc
    }
    $masterPids = @()
    foreach ($master in $masters) { $masterPids += [string]$master.ProcessId }
    Write-Output ("ENV_POSTMASTER_PIDS=" + ($masterPids -join ","))
    Write-Output ("ENV_POSTMASTER_COUNT=" + $masters.Count)
  }
  $pidFile = Join-Path $pgDataDir "postmaster.pid"
  $pidFilePid = "(none)"
  if (Test-Path -LiteralPath $pidFile) {
    try {
      $firstLine = Get-Content -LiteralPath $pidFile -TotalCount 1
      if ($null -ne $firstLine) { $pidFilePid = ([string]$firstLine).Trim() }
    } catch {
      $pidFilePid = "(unreadable)"
    }
  }
  Write-Output ("PG_POSTMASTER_PIDFILE_PID=" + $pidFilePid)
  Write-Output "PG_OBSERVATION_NOTE=ENV_POSTMASTER_* are matched against the DERIVED cluster dir only; any other cluster the child talks to is outside this env and outside the receipt"
}

# ---- DryRun: print the resolved launch, spawn nothing -------------------------
if ($DryRun) {
  Write-Output "ACTION=DryRun"
  Write-Output ("DRY_RUN=True (no process started)")
  Write-Output ("ENV_ID=" + $envId)
  Write-Output ("SERVED_COMMIT=" + $servedCommit)
  Write-Output ("MANIFEST_PATH=" + $manifestFullPath)
  Write-Output ("EXE=" + $exePath)
  Write-Output ("EXE_EXISTS=" + $exeExists)
  Write-Output ("EXE_SOURCE=" + $exeSource)
  Write-Output ("WORKING_DIRECTORY=" + $workingDirectory)
  Write-Output 'ARGV_JSON=["--background"]'
  Write-Output ("ARGV_DISPLAY=" + '"' + $exePath + '" --background')
  Write-Output ('ARGV_SOURCE=Start-Process -ArgumentList "--background"')
  if (-not $exeExists) {
    Write-Output "DRY_RUN_NOTE=the exe above does not exist on this host yet (build it with dev-env.ps1 -Action Up); the LAUNCH path refuses this same condition with exit 2"
  }
  Write-EnvBlock
  Write-IsolationChecks
  Write-Output ("ENV_CLEARED=" + ((Get-StaleFredoEnvNames) -join ","))
  Write-PostmasterObservation
  Write-Output "WILL_SPAWN=False"
  Write-Output "RESULT=OK"
  exit 0
}

# ---- Launch -------------------------------------------------------------------
function Get-FredoPids {
  $found = @()
  try {
    $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'fredo.exe'" -ErrorAction Stop)
    foreach ($proc in $procs) { $found += [int]$proc.ProcessId }
  } catch {
    Write-Fail ("fredo process enumeration failed: " + $_.Exception.Message)
  }
  return @($found | Sort-Object -Unique)
}

$before = Get-FredoPids
if (-not $exeExists) {
  Write-Fail ("exe not found: " + $exePath + " (source: " + $exeSource + "); pass -Exe with the env's own binary, or run -DryRun to inspect the derivation without a build")
}
Write-Output "ACTION=Launch"
Write-Output "DRY_RUN=False"
Write-Output ("ENV_ID=" + $envId)
Write-Output ("SERVED_COMMIT=" + $servedCommit)
Write-Output ("CLI_PIPE=" + $cliPipe)
Write-Output ("DATA_DIR=" + $dataDir)
Write-Output ("EXE=" + $exePath)
Write-Output ("EXE_EXISTS=" + $exeExists)
Write-Output ("EXE_SOURCE=" + $exeSource)
Write-Output ("WORKING_DIRECTORY=" + $workingDirectory)
Write-Output 'ARGV_JSON=["--background"]'
Write-Output ("OTLP_GRPC_PORT=" + $grpcPort)
Write-Output ("OTLP_HTTP_PORT=" + $httpPort)
Write-Output ("MCP_PORT=" + $mcpPort)
Write-Output ("FREDO_PIDS_BEFORE=" + ($before -join ","))
Write-EnvBlock
Write-IsolationChecks

# Inject the block into THIS process so the child inherits exactly what was printed above.
# Clear the rest of the FREDO_* namespace first: an inherited stale seam is the same class of defect
# as the missing cluster dir that wrote into the human's shared cluster in round 1.
$stale = Get-StaleFredoEnvNames
foreach ($staleName in $stale) {
  [Environment]::SetEnvironmentVariable($staleName, $null, "Process")
}
Write-Output ("ENV_CLEARED=" + ($stale -join ","))
foreach ($entry in $entries) {
  [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, "Process")
}
Write-Output ("ENV_INJECTED_COUNT=" + $entries.Count)

$process = Start-Process -FilePath $exePath -ArgumentList "--background" -WorkingDirectory $workingDirectory -PassThru
$startPid = [int]$process.Id
Write-Output ("START_PID=" + $startPid)

$startedAt = Get-Date
$deadline = $startedAt.AddSeconds($TimeoutSecs)
$ready = $false
$exited = $false
while ((Get-Date) -lt $deadline) {
  $probe = Get-Process -Id $startPid -ErrorAction SilentlyContinue
  if ($null -eq $probe) { $exited = $true; break }
  $grpcReady = Test-PortListening -Port $grpcPort
  $httpReady = Test-PortListening -Port $httpPort
  $mcpOwner = Get-PortOwnerPid -Port $mcpPort
  if ($grpcReady -and $httpReady -and ($mcpOwner -eq $startPid)) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
$elapsed = ((Get-Date) - $startedAt).TotalSeconds
$alive = ($null -ne (Get-Process -Id $startPid -ErrorAction SilentlyContinue))

$grpcReadyFinal = Test-PortListening -Port $grpcPort
$httpReadyFinal = Test-PortListening -Port $httpPort
$mcpOwnerFinal = Get-PortOwnerPid -Port $mcpPort
$grpcOwner = Get-PortOwnerPid -Port $grpcPort
$httpOwner = Get-PortOwnerPid -Port $httpPort
$after = Get-FredoPids
$newPids = @()
foreach ($candidate in $after) { if ($before -notcontains $candidate) { $newPids += $candidate } }

Write-Output ("ALIVE=" + $alive)
Write-Output ("EXITED=" + $exited)
Write-Output ("READY_SECONDS=" + [math]::Round($elapsed, 1))
Write-Output ("OTLP_GRPC_READY=" + $grpcReadyFinal)
Write-Output ("OTLP_GRPC_OWNER_PID=" + $grpcOwner)
Write-Output ("OTLP_HTTP_READY=" + $httpReadyFinal)
Write-Output ("OTLP_HTTP_OWNER_PID=" + $httpOwner)
Write-Output ("MCP_READY=" + ($mcpOwnerFinal -eq $startPid))
Write-Output ("MCP_OWNER_PID=" + $mcpOwnerFinal)
Write-Output ("PORT_OWNERS_SAME_PID=" + (($grpcOwner -eq $startPid) -and ($httpOwner -eq $startPid) -and ($mcpOwnerFinal -eq $startPid)))
Write-Output ("FREDO_PIDS_AFTER=" + ($after -join ","))
Write-Output ("NEW_FREDO_PIDS=" + ($newPids -join ","))

if ($alive) {
  Get-WindowReading -ReadPid $startPid
  Write-PostmasterObservation
} else {
  Write-Output "WINDOW_LIST_BEGIN"
  Write-Output "WINDOW_LIST_END"
  Write-Output "WINDOW_COUNT=(process exited)"
  Write-Output "VISIBLE_PRODUCT_WINDOW=(process exited)"
  Write-Output "MAIN_WINDOW_HANDLE=(process exited)"
  Write-Output "MAIN_WINDOW_TITLE=(process exited)"
  try { Write-Output ("EXITCODE=" + $process.ExitCode) } catch { Write-Output "EXITCODE=(unknown)" }
}

if (-not $alive) {
  Write-Output "RESULT=FAIL"
  Write-Output "FAIL_REASON=the background process exited instead of staying resident"
  exit 1
}
if (-not $ready) {
  Write-Output "RESULT=FAIL"
  Write-Output ("FAIL_REASON=not ready inside " + $TimeoutSecs + "s (otlpGrpc=" + $grpcReadyFinal + " otlpHttp=" + $httpReadyFinal + " mcp owned by start pid=" + ($mcpOwnerFinal -eq $startPid) + "); the started PID is " + $startPid)
  exit 1
}
Write-Output "RESULT=PASS"
exit 0
