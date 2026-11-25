<#
.SYNOPSIS
  Shared manifest facts for the resident-shell suite (issue #3192).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). This file is DOT-SOURCED, never executed. It owns, for
  the whole suite:
    (a) the ONE manifest-key vocabulary,
    (b) the ONE cluster-dir derivation,
    (c) the ONE postgres / postmaster process predicate.

  WHY IT EXISTS (#3192 round 2). Each suite script carried its own copy of the key reads and two of
  them invented key names `dev-env.ps1` never writes, so the AC4 and Q-1b legs could not run as
  committed. And the postmaster predicate in TWO scripts matched the postmaster command line against
  the manifest's APP-DATA dir, which no postmaster references - so it reported `0` and AC4's
  "postmaster unchanged" clause held `0 == 0`. One rule in three copies is how a suite reports a
  confident zero. The rule now lives here only.

  SHIPPED KEYS - read from `dev-env.ps1` Write-EnvManifest (:574-592). Never invent one:
    envId           :575
    spec            :576
    servingCheckout :577
    servedCommit    :578
    ports.vite      :580
    ports.mcp       :581
    ports.otlpGrpc  :582
    ports.otlpHttp  :583
    ports.pg        :584   <-- CONSTANT 0 by construction; never a real port
    dataDir         :586   <-- the APP-DATA dir, NOT the cluster dir
    dbPath          :587
    pipe            :588   <-- the CLI/IPC pipe       (NOT `cliPipe`)
    webviewProfile  :589   <-- the WebView2 profile   (NOT `webviewDir`)
    appIdentity     :590
    processes       :591
  There is deliberately NO alias for `pipe` / `webviewProfile`: a second key for one value is a
  second artifact pinning the same text, and `dev-env.ps1:1212` already reads `$manifest.pipe`, so
  the shipped name is load-bearing elsewhere. A missing key returns "" / 0 and the CALLER keeps its
  own fail-closed convention (`Write-Fail`, exit 2) - this file never calls `exit`.

  CLUSTER DIR. `dev-env.ps1` launches the app with `FREDO_PG_DATA_DIR = <env-root>/postgres`
  (:733, assigned at :1535) and writes the manifest at `<env-root>/manifest.json` (:1553), so the
  cluster dir is `<manifest parent>/postgres`. The product agrees: `pg_supervisor/state.rs:113-116`
  documents `data_dir` as the cluster (`initdb`) target, and the FS-1 override is applied verbatim.
  The APP-DATA dir (`dataDir`, `<env-root>/data`) is a DIFFERENT directory - matching a postmaster
  command line against it can never succeed.
  When the manifest lives outside `<env-root>` (a relocated `-Manifest` / `FREDO_ENV_MANIFEST`),
  pass `-PgDataDir` from the product's `pg_supervisor_status.dataDir`; `Resolve-PgDataDir` reports
  which source it used (`manifest` or `product`).

  POSTMASTER PREDICATE. A postmaster is a `postgres.exe` whose command line references the CLUSTER
  dir, excluding the children PostgreSQL spawns on Windows (their command line carries a
  `forkchild=<role>` token - e.g. `forkchild=syslogger`, see the #3049 record in references.md). The
  children are reported separately so the receipt stays complete. Without that exclusion the set
  would include per-connection backends and would change on any connect/disconnect.

  PowerShell 5.1 SAFE: no `??`, no ternary, no native command is run here, and NO non-ASCII
  character appears anywhere in this file (a non-ASCII em dash inside a string once truncated a
  `throw` and reddened this harness).
#>

# ---- Manifest read -----------------------------------------------------------
# Parse only: returns $null when the path is blank, missing or unparseable, so the caller can emit
# its own message and exit code (this file must never exit).
function Read-ManifestFile {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $parsed = $null
  try {
    $parsed = (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
  return $parsed
}

function Get-ManifestKeyText {
  param($Manifest, [string]$Key)
  if ($null -eq $Manifest) { return "" }
  if ([string]::IsNullOrWhiteSpace($Key)) { return "" }
  $prop = $Manifest.PSObject.Properties[$Key]
  if ($null -eq $prop) { return "" }
  if ($null -eq $prop.Value) { return "" }
  return [string]$prop.Value
}

# ---- Key accessors (the shipped names; see the table above) -------------------
function Get-ManifestEnvId {
  param($Manifest)
  return (Get-ManifestKeyText -Manifest $Manifest -Key "envId")
}

function Get-ManifestServedCommit {
  param($Manifest)
  return (Get-ManifestKeyText -Manifest $Manifest -Key "servedCommit")
}

# `pipe` - the per-env IPC pipe `\\.\pipe\fredo-ipc-<envId>` (dev-env.ps1:588).
function Get-ManifestPipe {
  param($Manifest)
  return (Get-ManifestKeyText -Manifest $Manifest -Key "pipe")
}

# `dataDir` - the APP-DATA dir. NOT the cluster dir; see Get-ManifestPgDataDir.
function Get-ManifestDataDir {
  param($Manifest)
  return (Get-ManifestKeyText -Manifest $Manifest -Key "dataDir")
}

# `webviewProfile` - the WebView2 profile dir (dev-env.ps1:589).
function Get-ManifestWebviewProfile {
  param($Manifest)
  return (Get-ManifestKeyText -Manifest $Manifest -Key "webviewProfile")
}

# `ports.<Name>`; 0 when the port is absent. `ports.pg` is a constant 0 (dev-env.ps1:584) - the live
# PG port is only knowable from `pg_supervisor_status.port`, so a caller must never treat 0 as a port.
function Get-ManifestPort {
  param($Manifest, [string]$Name)
  if ($null -eq $Manifest) { return 0 }
  if ($null -eq $Manifest.ports) { return 0 }
  if ([string]::IsNullOrWhiteSpace($Name)) { return 0 }
  $prop = $Manifest.ports.PSObject.Properties[$Name]
  if ($null -eq $prop) { return 0 }
  if ($null -eq $prop.Value) { return 0 }
  $value = 0
  try { $value = [int]$prop.Value } catch { $value = 0 }
  return $value
}

# The app PID from `processes[] | role -eq 'app'`; 0 when absent.
function Get-ManifestAppPid {
  param($Manifest)
  if ($null -eq $Manifest) { return 0 }
  if ($null -eq $Manifest.processes) { return 0 }
  foreach ($entry in @($Manifest.processes)) {
    if ($null -eq $entry) { continue }
    $role = ""
    $roleProp = $entry.PSObject.Properties["role"]
    if ($null -ne $roleProp -and $null -ne $roleProp.Value) { $role = [string]$roleProp.Value }
    if ($role -ne "app") { continue }
    $pidProp = $entry.PSObject.Properties["pid"]
    if ($null -ne $pidProp -and $pidProp.Value) { return [int]$pidProp.Value }
  }
  return 0
}

# ---- Cluster dir (env root) ---------------------------------------------------
# `<env-root>` = the manifest's parent directory (dev-env writes `<env-root>/manifest.json`, :1553).
# Returns an absolute path when it can resolve one, else the raw parent, else "".
function Get-ManifestEnvRoot {
  param([string]$ManifestPath)
  if ([string]::IsNullOrWhiteSpace($ManifestPath)) { return "" }
  $parent = ""
  try { $parent = Split-Path -Parent $ManifestPath } catch { $parent = "" }
  if ([string]::IsNullOrWhiteSpace($parent)) {
    try { $parent = (Get-Location).Path } catch { $parent = "" }
  }
  if ([string]::IsNullOrWhiteSpace($parent)) { return "" }
  $resolved = ""
  try { $resolved = (Resolve-Path -LiteralPath $parent -ErrorAction Stop).Path } catch { $resolved = "" }
  if ([string]::IsNullOrWhiteSpace($resolved)) { return $parent }
  return $resolved
}

# The PostgreSQL CLUSTER dir: `<env-root>/postgres` (dev-env.ps1:733,1535; product
# `pg_supervisor/state.rs:113-116`). This is the ONLY directory a postmaster command line contains.
function Get-ManifestPgDataDir {
  param([string]$ManifestPath)
  $envRoot = Get-ManifestEnvRoot -ManifestPath $ManifestPath
  if ([string]::IsNullOrWhiteSpace($envRoot)) { return "" }
  return (Join-Path $envRoot "postgres")
}

# Resolve the PG cluster dir the predicate should use, and say where it came from.
#   Path   : the override verbatim (trimmed) when supplied, else the manifest derivation
#   Source : "product" (-PgDataDir, normally pg_supervisor_status.dataDir) or "manifest"
#   Exists : whether the directory is there RIGHT NOW (a caller must hard-fail when it is not -
#            a zero from a predicate that matched nothing is not a postmaster count)
function Resolve-PgDataDir {
  param([string]$ManifestPath, [string]$PgDataDir)
  $path = ""
  $source = ""
  if (-not [string]::IsNullOrWhiteSpace($PgDataDir)) {
    $path = $PgDataDir.Trim()
    if ($path.Length -ge 2) {
      if ($path.Substring(0, 1) -eq '"' -and $path.Substring($path.Length - 1, 1) -eq '"') {
        $path = $path.Substring(1, $path.Length - 2)
      }
    }
    $source = "product"
  } else {
    $path = Get-ManifestPgDataDir -ManifestPath $ManifestPath
    $source = "manifest"
  }
  $exists = $false
  if (-not [string]::IsNullOrWhiteSpace($path)) {
    try { $exists = Test-Path -LiteralPath $path } catch { $exists = $false }
  }
  return [pscustomobject]@{
    Path   = $path
    Source = $source
    Exists = [bool]$exists
  }
}

# ---- Process predicates ------------------------------------------------------
# Normalize a path (or a whole command line) for a substring test: forward slashes become
# backslashes, a trailing separator is dropped, case is folded. Windows command lines may quote the
# dir and may use either separator, so a raw `Contains` on the manifest string is not enough.
function ConvertTo-MatchablePath {
  param([string]$Path)
  if ($null -eq $Path) { return "" }
  $text = $Path.Trim()
  if ($text.Length -eq 0) { return "" }
  $text = $text.Replace("/", "\")
  while ($text.EndsWith("\")) {
    $text = $text.Substring(0, $text.Length - 1)
  }
  return $text.ToLowerInvariant()
}

# THE postmaster-membership predicate: does this command line reference that directory?
function Test-CommandLineReferencesDir {
  param([string]$CommandLine, [string]$Dir)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $needle = ConvertTo-MatchablePath -Path $Dir
  if ([string]::IsNullOrWhiteSpace($needle)) { return $false }
  $haystack = ConvertTo-MatchablePath -Path $CommandLine
  if ([string]::IsNullOrWhiteSpace($haystack)) { return $false }
  return $haystack.Contains($needle)
}

# PostgreSQL's Windows children carry a `forkchild=<role>` token (e.g. `forkchild=syslogger`).
function Test-PostgresChildProc {
  param($Proc)
  if ($null -eq $Proc) { return $false }
  $commandLine = [string]$Proc.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
  return $commandLine.ToLowerInvariant().Contains("forkchild")
}

# Every postgres.exe whose command line references the cluster dir - children included.
function Get-PostgresProcList {
  param([object[]]$Procs, [string]$PgDataDir)
  $found = @()
  if ([string]::IsNullOrWhiteSpace($PgDataDir)) { return $found }
  if ($null -eq $Procs) { return $found }
  foreach ($proc in $Procs) {
    if ($null -eq $proc) { continue }
    $name = [string]$proc.Name
    if ($name -notmatch '^postgres(\.exe)?$') { continue }
    if (Test-CommandLineReferencesDir -CommandLine ([string]$proc.CommandLine) -Dir $PgDataDir) {
      $found += $proc
    }
  }
  return $found
}

# The postmaster itself: the same set minus the `forkchild` children. Exactly one entry per
# cluster while it is up (a `postmaster.pid` in the cluster dir names its PID).
# NOTE: never name a loop/local `$matches` in this file or its callers - PowerShell rewrites that
# automatic variable on the next `-match`/`-notmatch`, so a `$matches.Add(...)` after a match test
# throws (the #3192 round-1 `Cannot find an overload for "Add"` defect).
function Get-PostmasterProcList {
  param([object[]]$Procs, [string]$PgDataDir)
  $masters = @()
  $tree = @(Get-PostgresProcList -Procs $Procs -PgDataDir $PgDataDir)
  foreach ($proc in $tree) {
    if (Test-PostgresChildProc -Proc $proc) { continue }
    $masters += $proc
  }
  return $masters
}
