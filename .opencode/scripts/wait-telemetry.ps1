<#
.SYNOPSIS
  Bounded polling helper: run a read-only query against the live Fredo
  PostgreSQL telemetry store until it returns at least one row, or the attempt
  budget is spent.

.DESCRIPTION
  Pipeline tooling for telemetry CONFIRM gates (e.g. `telemetry_spans`
  fixture-session / task-edge queries during live e2e). Replaces dozens of
  manual query roundtrips with ONE deterministic bounded-poll command.
  Start-Sleep happens INSIDE this script, so callers whose sandbox bans direct
  sleep can still poll safely.

  Pipeline state is served by the embedded PostgreSQL cluster (the only store
  since Spec #3005). Reads go through the managed `psql` (database `postgres`)
  at the env's ephemeral PG port. Resolve the port with -PgPort, or -Manifest
  (which records ports.pg); when the port reads 0 a re-resolve is required
  (G-307) - re-run dev-env.ps1 -Action Up (or Status) and pass the fresh port.

  Password resolution (never logged): -PgPassword, then $env:PGPASSWORD, then
  the first non-blank line of $env:FREDO_PG_PASSWORD_FILE (the product seam),
  then the documented loopback-only fallback. In a running app the password
  lives in the OS keychain (service `fredo.postgres`, account
  `loopback:password`); supply it via -PgPassword / $env:PGPASSWORD.

  Success criterion: the query returns at least one row. A bare `0` aggregate
  result (e.g. `SELECT COUNT(*) ...` with zero matches) counts as zero rows,
  so COUNT-style gates behave the same as row-returning gates.

  Exit codes:
    0  condition met (query returned >= 1 row)
    1  timeout (attempts exhausted, condition never met)
    2  usage error (query rejected, psql not found, or PG port unresolved)
    3  psql execution error on some attempt

  Read-only guardrail: only SELECT / WITH statements are accepted; DDL/DML
  keywords are rejected before any execution. The connection sets
  `default_transaction_read_only=on` and `ON_ERROR_STOP=1`, so the running app
  is never written to (the `telemetry_spans` READ-ONLY invariant holds).

.PARAMETER Query
  SQL query to poll. Required. Must start with SELECT or WITH.

.PARAMETER Attempts
  Maximum number of polling attempts. Default: 20.

.PARAMETER IntervalSec
  Seconds to sleep between attempts. Default: 15.

.PARAMETER PgPort
  PostgreSQL loopback port. >0 selects the managed-psql engine. 0 => resolve
  from -Manifest (ports.pg); if still 0 => usage error (G-307 re-resolve).

.PARAMETER Manifest
  Env process-manifest path (<env-root>/manifest.json). Resolves ports.pg when
  -PgPort is not given.

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
  powershell -File .opencode/scripts/wait-telemetry.ps1 -Query "SELECT session_id, span_name FROM telemetry_spans WHERE span_name='fredo.session'" -PgPort 64217 -Attempts 20 -IntervalSec 15
.EXAMPLE
  powershell -File .opencode/scripts/wait-telemetry.ps1 -Query "SELECT 1" -Manifest ".opencode/tmp/envs/spec3005/manifest.json" -Attempts 10 -IntervalSec 5
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$Query,

  [ValidateRange(1, 1000)]
  [int]$Attempts = 20,

  [ValidateRange(1, 3600)]
  [int]$IntervalSec = 15,

  # PostgreSQL read lever (G-284/G-307): >0 selects the managed-psql engine.
  [int]$PgPort = 0,

  # Env process-manifest path; resolves ports.pg when -PgPort is not given.
  [string]$Manifest = "",

  [string]$PgHost = "127.0.0.1",
  [string]$PgUser = "postgres",
  [string]$PgDatabase = "postgres",
  [string]$PgPassword = $env:PGPASSWORD
)

$ErrorActionPreference = "Stop"

# Documented loopback-only fallback (never the live secret; used when the OS
# keychain is unavailable and no password was supplied).
$FallbackPassword = "fredo-loopback-fallback"

function Write-Info {
  param([string]$Message, [string]$Color = "Gray")
  Write-Host $Message -ForegroundColor $Color
}

function Write-Fail {
  param([string]$Message)
  Write-Host "ERROR: $Message" -ForegroundColor Red
}

# -- Guardrail: read-only queries only (mirrors telemetry-query.ps1) -----------
# Strip quoted string literals and identifiers BEFORE scanning, so legitimate
# SELECTs whose literals mention DML (e.g. a receiver log message containing
# the word "insert") are not false-positived (#2762 round 7). Keywords must
# appear as whole words - a column named updated_at is not UPDATE. The
# statement-shape check below (must start with SELECT / WITH) remains the
# primary read-only guarantee.
$forbiddenKeywords = @("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "ATTACH", "DETACH", "REPLACE", "TRUNCATE", "GRANT", "REVOKE", "COPY", "VACUUM", "REINDEX", "CLUSTER", "REFRESH", "SET", "RESET")
$scanText = $Query -replace "'(?:[^']|'')*'", "''" -replace '"(?:[^"]|"")*"', '""'

foreach ($keyword in $forbiddenKeywords) {
  if ($scanText -match "(?i)\b$keyword\b") {
    Write-Fail "query rejected: contains forbidden keyword '$keyword'. Only read-only SELECT / WITH permitted."
    exit 2
  }
}

$trimmedQuery = $Query.Trim()
if ($trimmedQuery -notmatch '^(?i)(SELECT\s|WITH\s)') {
  Write-Fail "query rejected: must start with SELECT or WITH."
  exit 2
}

# -- Resolve the env manifest (ports.pg) when -PgPort is not supplied ----------
$manifestPgPort = 0
if ($Manifest) {
  if (-not (Test-Path -LiteralPath $Manifest)) {
    Write-Fail "env manifest not found: $Manifest"
    exit 2
  }
  try {
    $manifestObj = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
  } catch {
    Write-Fail "env manifest is not valid JSON: $Manifest"
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
  Write-Fail "PostgreSQL port unresolved (0). Re-resolve it (G-307): read pg_supervisor_status, or re-run dev-env.ps1 -Action Up / Status, then pass the fresh -PgPort (or -Manifest with ports.pg)."
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
  Write-Fail "psql CLI not found (managed embedded PostgreSQL or PATH)."
  exit 2
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

# G-263: never block on an interactive password prompt; bound the connect.
$env:PGPASSWORD = $PgPassword
if (-not $env:PGCONNECT_TIMEOUT) {
  $env:PGCONNECT_TIMEOUT = "10"
}
# Read-only invariant: every transaction defaults to READ ONLY.
$env:PGOPTIONS = "-c default_transaction_read_only=on"

Write-Info "wait-telemetry: polling PostgreSQL ($PgHost`:$pgPortResolved/$PgDatabase) every ${IntervalSec}s, up to $Attempts attempt(s)" "Cyan"
Write-Info "  query: $trimmedQuery" "DarkGray"

# -- Polling loop --------------------------------------------------------------
for ($attempt = 1; $attempt -le $Attempts; $attempt++) {

  # PS 5.1: a native command with 2>&1 under $ErrorActionPreference = "Stop"
  # turns any stderr write into a terminating error - run under "Continue"
  # and surface the exit code instead (same pattern as dev-env.ps1).
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $result = & $psqlBin -X -q --no-psqlrc -w -h $PgHost -p "$pgPortResolved" -U $PgUser -d $PgDatabase -v ON_ERROR_STOP=1 --csv -c $trimmedQuery 2>&1
  } finally {
    $ErrorActionPreference = $prev
  }
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0) {
    Write-Fail "psql failed (exit $exitCode) on attempt $attempt/$Attempts."
    foreach ($line in @($result)) {
      Write-Host "  $line" -ForegroundColor Red
    }
    exit 3
  }

  # Count result rows: non-empty output lines minus the CSV header. A bare "0"
  # is the aggregate zero case (SELECT COUNT(*) with no matches) - counts as
  # zero rows so COUNT-style gates do not trivially succeed.
  $lines = @($result | Where-Object { $_ -ne $null -and "$_".Trim() -ne "" })
  $rowCount = 0
  if ($lines.Count -gt 0) {
    # First non-empty line is the CSV header row.
    $rowCount = $lines.Count - 1
    if ($rowCount -eq 1 -and "$($lines[1])".Trim() -eq "0") {
      $rowCount = 0
    }
  }

  if ($rowCount -gt 0) {
    Write-Info "attempt $attempt/$Attempts : $rowCount row(s) - condition met" "Green"
    foreach ($line in @($lines)) {
      Write-Host "  $line"
    }
    exit 0
  }

  Write-Info "attempt $attempt/$Attempts : 0 rows"

  if ($attempt -lt $Attempts) {
    Start-Sleep -Seconds $IntervalSec
  }
}

Write-Host "TIMEOUT after $Attempts attempt(s) (interval ${IntervalSec}s) - condition not met." -ForegroundColor Red
exit 1
