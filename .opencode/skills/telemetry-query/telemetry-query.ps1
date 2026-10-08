<#
.SYNOPSIS
  Query Fredo's telemetry store (the embedded PostgreSQL cluster).

.DESCRIPTION
  Read-only query interface for the managed PostgreSQL store (the only store
  since Spec #3005). The cluster holds `telemetry_spans`, `telemetry_metrics`,
  `telemetry_logs`, the canonical RTDB tables, and the settings KV. Rejects
  DDL/DML. Defaults to LIMIT 1000. Supports json, markdown, and table output.

  Engine (Spec #3005, closes G-284): PostgreSQL ONLY. The script connects with
  the managed `psql` (database `postgres`) at the env's ephemeral PG port.
  Resolve the port with -PgPort or -Manifest (ports.pg); when the port reads 0
  a re-resolve is required (G-307) - re-run dev-env.ps1 -Action Up / Status and
  pass the fresh port.

  Password resolution (never logged): -PgPassword, then $env:PGPASSWORD, then
  the first non-blank line of $env:FREDO_PG_PASSWORD_FILE (the product seam),
  then the documented loopback-only fallback. In a running app the password
  lives in the OS keychain (service `fredo.postgres`, account
  `loopback:password`).

  Read-only enforcement: the statement-shape check + forbidden-keyword scan
  reject anything but SELECT/WITH before execution; the connection sets
  `default_transaction_read_only=on` and `ON_ERROR_STOP=1`, so the
  `telemetry_spans` READ-ONLY invariant holds and the running app is never
  written to.

.PARAMETER Query
  SQL SELECT statement. Required. Must start with SELECT or WITH.
.PARAMETER Format
  Output format: json, md, or table. Default: table.
.PARAMETER Limit
  Maximum number of rows. Default: 1000. Only applied if query lacks LIMIT.
.PARAMETER Manifest
  Env process-manifest path (Spec #2944). Resolves ports.pg. Explicit -PgPort
  wins when both are given.
.PARAMETER PgPort
  PostgreSQL loopback port (G-284/G-307). >0 selects the managed-psql engine at
  this port. 0 => the -Manifest ports.pg when present; else a usage error.
.PARAMETER PgHost
  PostgreSQL host. Default: 127.0.0.1.
.PARAMETER PgUser
  PostgreSQL user. Default: postgres.
.PARAMETER PgDatabase
  PostgreSQL database. Default: postgres.
.PARAMETER PgPassword
  PostgreSQL password. Default: $env:PGPASSWORD (then FREDO_PG_PASSWORD_FILE,
  then the loopback-only fallback). Never printed.
.EXAMPLE
  .\telemetry-query.ps1 -Query "SELECT * FROM telemetry_spans WHERE status_code='ERROR'" -Format json -PgPort 64217
.EXAMPLE
  .\telemetry-query.ps1 -Query "SELECT count(*) FROM telemetry_spans" -Manifest ".opencode/tmp/envs/spec3005/manifest.json"
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$Query,

  [ValidateSet("json", "md", "table")]
  [string]$Format = "table",

  [int]$Limit = 1000,

  # Env process-manifest path (Spec #2944). Resolves ports.pg.
  [string]$Manifest = "",

  # PostgreSQL read lever (G-284/G-307): >0 selects the managed-psql engine.
  [int]$PgPort = 0,
  [string]$PgHost = "127.0.0.1",
  [string]$PgUser = "postgres",
  [string]$PgDatabase = "postgres",
  [string]$PgPassword = $env:PGPASSWORD
)

$ErrorActionPreference = "Stop"

# Documented loopback-only fallback (never the live secret).
$FallbackPassword = "fredo-loopback-fallback"

function Write-ErrorMsg {
  param([string]$Message)
  Write-Host "ERROR: $Message" -ForegroundColor Red
}

# -- Guardrail 1: Reject DDL/DML keywords -------------------------------------
# Match each keyword as a WHOLE word (\b...\b) so column names such as
# `updated_at` / `created_at` / `alternate` do not trip the DML scan on a
# substring (e.g. \bUPDATE matched the "update" inside "updated_at").
$forbiddenKeywords = @("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "GRANT", "REVOKE", "COPY", "VACUUM", "REINDEX", "CLUSTER", "REFRESH")

foreach ($keyword in $forbiddenKeywords) {
  if ($Query -match "(?i)\b$keyword\b") {
    Write-ErrorMsg "Query rejected: contains forbidden keyword '$keyword'. Only SELECT and WITH permitted."
    exit 121
  }
}

$trimmedQuery = $Query.Trim()
if ($trimmedQuery -notmatch '^(?i)(SELECT\s|WITH\s)') {
  Write-ErrorMsg "Query rejected: must start with SELECT or WITH (CTE)."
  exit 122
}

# -- Resolve the env manifest (ports.pg) ---------------------------------------
$manifestPgPort = 0
if ($Manifest) {
  if (-not (Test-Path -LiteralPath $Manifest)) {
    Write-ErrorMsg "env manifest not found: $Manifest"
    exit 2
  }
  try {
    $manifestObj = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
  } catch {
    Write-ErrorMsg "env manifest is not valid JSON: $Manifest"
    exit 2
  }
  if ($manifestObj -and $manifestObj.ports) {
    $pgProp = $manifestObj.ports.PSObject.Properties["pg"]
    if ($pgProp -and $pgProp.Value) {
      $manifestPgPort = [int]$pgProp.Value
    }
  }
}

$pgPortResolved = 0
if ($PgPort -gt 0) {
  $pgPortResolved = $PgPort
} elseif ($manifestPgPort -gt 0) {
  $pgPortResolved = $manifestPgPort
}

if ($pgPortResolved -le 0) {
  Write-ErrorMsg "PostgreSQL port unresolved (0). Re-resolve it (G-307): read pg_supervisor_status, or re-run dev-env.ps1 -Action Up / Status, then pass the fresh -PgPort (or -Manifest with ports.pg)."
  exit 2
}

# -- Locate the managed psql binary -------------------------------------------
function Find-PsqlBinary {
  $paths = @()

  try {
    $cmd = Get-Command "psql" -ErrorAction Stop
    $paths += $cmd.Source
  } catch {
  }

  # Embedded PostgreSQL distribution (shared install dir; per-env data dirs).
  $installRoots = @(
    "$env:APPDATA\com.fredo.app\postgres-install",
    "$env:LOCALAPPDATA\com.fredo.app\postgres-install"
  )
  foreach ($root in $installRoots) {
    if (Test-Path -LiteralPath $root) {
      try {
        $found = Get-ChildItem -LiteralPath $root -Recurse -Filter "psql.exe" -ErrorAction SilentlyContinue
        foreach ($f in $found) {
          $paths += $f.FullName
        }
      } catch {
      }
    }
  }

  foreach ($p in $paths) {
    if (Test-Path -LiteralPath $p) {
      return $p
    }
  }
  return $null
}

$psqlBin = Find-PsqlBinary
if (-not $psqlBin) {
  Write-ErrorMsg "psql CLI not found (managed embedded PostgreSQL or PATH)."
  exit 1
}

# -- Resolve the password (never logged) ---------------------------------------
if (-not $PgPassword) {
  $pwFile = $env:FREDO_PG_PASSWORD_FILE
  if ($pwFile -and (Test-Path -LiteralPath $pwFile)) {
    try {
      foreach ($line in Get-Content -LiteralPath $pwFile) {
        if ($line -and $line.Trim() -ne "") {
          $PgPassword = $line.Trim()
          break
        }
      }
    } catch {
    }
  }
}
if (-not $PgPassword) {
  $PgPassword = $FallbackPassword
}

$env:PGPASSWORD = $PgPassword
# G-263: never block on an interactive password prompt; bound the connect.
if (-not $env:PGCONNECT_TIMEOUT) {
  $env:PGCONNECT_TIMEOUT = "10"
}
# Read-only invariant: every transaction defaults to READ ONLY.
$env:PGOPTIONS = "-c default_transaction_read_only=on"

# -- Apply LIMIT if not already present ---------------------------------------
$finalQuery = $Query
if ($Query -notmatch '(?i)\bLIMIT\s+\d+') {
  $finalQuery = "$Query LIMIT $Limit"
}

$psqlArgs = @(
  "-X", "-q", "--no-psqlrc", "-w",
  "-h", $PgHost, "-p", "$pgPortResolved",
  "-U", $PgUser, "-d", $PgDatabase,
  "-v", "ON_ERROR_STOP=1"
)
if ($Format -eq "table") {
  $psqlArgs += @("-P", "pager=off", "-c", $finalQuery)
} else {
  $psqlArgs += @("--csv", "-c", $finalQuery)
}

# PS 5.1: a native command with 2>&1 under "Stop" can turn a stderr write into a
# terminating error - run under "Continue" and check the exit code.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $pgResult = & $psqlBin @psqlArgs 2>&1
} finally {
  $ErrorActionPreference = $prevEap
}
$pgExit = $LASTEXITCODE

if ($pgExit -ne 0) {
  Write-ErrorMsg "PostgreSQL query failed (exit code $pgExit)."
  Write-Host "Query was: $finalQuery" -ForegroundColor DarkGray
  foreach ($line in @($pgResult)) {
    Write-Host "  $line" -ForegroundColor Red
  }
  exit 3
}

if ($Format -eq "table") {
  $pgResult
} else {
  $rows = @($pgResult | Where-Object { $_ -ne $null -and "$_" -ne "" } | ConvertFrom-Csv | Where-Object { $_ -ne $null })
  if ($Format -eq "json") {
    if ($rows.Count -eq 0) {
      "[]"
    } else {
      ConvertTo-Json -InputObject @($rows) -Depth 6
    }
  } else {
    if ($rows.Count -eq 0) {
      "(no rows)"
    } else {
      $cols = @($rows[0].PSObject.Properties.Name)
      $mdLines = @(
        "| " + ($cols -join " | ") + " |",
        "| " + (($cols | ForEach-Object { "---" }) -join " | ") + " |"
      )
      foreach ($r in $rows) {
        $cells = @()
        foreach ($c in $cols) {
          $cells += "$($r.$c)"
        }
        $mdLines += "| " + ($cells -join " | ") + " |"
      }
      $mdLines -join "`r`n"
    }
  }
}
exit 0
