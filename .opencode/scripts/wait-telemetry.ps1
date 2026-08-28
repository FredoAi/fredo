<#
.SYNOPSIS
  Bounded polling helper: run a readonly sqlite3 query against the live Fredo
  telemetry DB until it returns at least one row, or the attempt budget is spent.

.DESCRIPTION
  Pipeline tooling for telemetry CONFIRM gates (e.g. `telemetry_spans`
  fixture-session / task-edge queries during live e2e). Replaces dozens of
  manual query roundtrips with ONE deterministic bounded-poll command.
  Start-Sleep happens INSIDE this script, so callers whose sandbox bans direct
  sleep can still poll safely.

  Success criterion: the query returns at least one row. A bare `0` aggregate
  result (e.g. `SELECT COUNT(*) ...` with zero matches) counts as zero rows,
  so COUNT-style gates behave the same as row-returning gates.

  Exit codes:
    0  condition met (query returned >= 1 row)
    1  timeout (attempts exhausted, condition never met)
    2  usage error (query rejected, sqlite3 not found, or fredo.db not found)
    3  sqlite3 execution error on some attempt

  Readonly guardrail: only SELECT / PRAGMA / WITH statements are accepted;
  DDL/DML keywords are rejected before any execution. The connection uses
  sqlite3 -readonly, so the running Fredo app (WAL mode) is never blocked.

.PARAMETER Query
  SQL query to poll. Required. Must start with SELECT, PRAGMA, or WITH.

.PARAMETER Attempts
  Maximum number of polling attempts. Default: 20.

.PARAMETER IntervalSec
  Seconds to sleep between attempts. Default: 15.

.EXAMPLE
  powershell -File .opencode/scripts/wait-telemetry.ps1 -Query "SELECT session_id, span_name FROM telemetry_spans WHERE span_name='fredo.session'" -Attempts 20 -IntervalSec 15
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$Query,

  [ValidateRange(1, 1000)]
  [int]$Attempts = 20,

  [ValidateRange(1, 3600)]
  [int]$IntervalSec = 15
)

$ErrorActionPreference = "Stop"

function Write-Info {
  param([string]$Message, [string]$Color = "Gray")
  Write-Host $Message -ForegroundColor $Color
}

function Write-Fail {
  param([string]$Message)
  Write-Host "ERROR: $Message" -ForegroundColor Red
}

# -- Guardrail: readonly queries only (mirrors telemetry-query.ps1) -----------
# Strip quoted string literals and identifiers BEFORE scanning, so legitimate
# SELECTs whose literals mention DML (e.g. a receiver log message containing
# the word "insert") are not false-positived (#2762 round 7: the QA-6 P2
# receiver-log receipt was rejected because its message literal contained
# INSERT). Keywords must appear as whole words — a column named updated_at
# is not UPDATE. The statement-shape check below (must start with SELECT /
# PRAGMA / WITH) remains the primary readonly guarantee.
$forbiddenKeywords = @("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "ATTACH", "DETACH", "REPLACE")
$scanText = $Query -replace "'(?:[^']|'')*'", "''" -replace '"(?:[^"]|"")*"', '""'

foreach ($keyword in $forbiddenKeywords) {
  if ($scanText -match "(?i)\b$keyword\b") {
    Write-Fail "query rejected: contains forbidden keyword '$keyword'. Only readonly SELECT / PRAGMA / WITH permitted."
    exit 2
  }
}

$trimmedQuery = $Query.Trim()
if ($trimmedQuery -notmatch '^(?i)(SELECT\s|PRAGMA\s|WITH\s)') {
  Write-Fail "query rejected: must start with SELECT, PRAGMA, or WITH."
  exit 2
}

# -- Locate the sqlite3 binary ------------------------------------------------
$sqlite3Bin = $null

try {
  $cmd = Get-Command "sqlite3" -ErrorAction Stop
  $sqlite3Bin = $cmd.Source
} catch {
}

if (-not $sqlite3Bin) {
  $commonPaths = @(
    "C:\sqlite3\sqlite3.exe",
    "$env:ProgramFiles\sqlite3\sqlite3.exe",
    "${env:ProgramFiles(x86)}\sqlite3\sqlite3.exe",
    "$env:ChocolateyInstall\lib\sqlite\*\sqlite3.exe",
    "$env:USERPROFILE\scoop\apps\sqlite\current\sqlite3.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\SQLite.SQLite_*\sqlite3.exe"
  )
  foreach ($pathPattern in $commonPaths) {
    $resolved = Resolve-Path $pathPattern -ErrorAction SilentlyContinue
    if ($resolved) {
      $sqlite3Bin = $resolved.Path
      break
    }
  }
}

if (-not $sqlite3Bin) {
  Write-Fail "sqlite3 CLI not found. Install it (e.g. 'choco install sqlite' / 'winget install SQLite.SQLite')."
  exit 2
}

# -- Locate fredo.db (primary AppData path, then LOCALAPPDATA fallback) -------
$dbPath = "$env:APPDATA\com.fredo.app\fredo.db"
if (-not (Test-Path -LiteralPath $dbPath)) {
  $dbPath = "$env:LOCALAPPDATA\com.fredo.app\fredo.db"
}
if (-not (Test-Path -LiteralPath $dbPath)) {
  Write-Fail "fredo.db not found (searched %APPDATA%\com.fredo.app and %LOCALAPPDATA%\com.fredo.app). Run the Fredo app at least once to create it."
  exit 2
}

Write-Info "wait-telemetry: polling fredo.db ($dbPath) every ${IntervalSec}s, up to $Attempts attempt(s)" "Cyan"
Write-Info "  query: $trimmedQuery" "DarkGray"

# -- Polling loop --------------------------------------------------------------
for ($attempt = 1; $attempt -le $Attempts; $attempt++) {

  # PS 5.1: a native command with 2>&1 under $ErrorActionPreference = "Stop"
  # turns any stderr write into a terminating error -- run under "Continue"
  # and surface the exit code instead (same pattern as dev-env.ps1).
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $result = & $sqlite3Bin -readonly -batch -cmd ".timeout 3000" $dbPath $trimmedQuery 2>&1
  } finally {
    $ErrorActionPreference = $prev
  }
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0) {
    Write-Fail "sqlite3 failed (exit $exitCode) on attempt $attempt/$Attempts."
    foreach ($line in @($result)) {
      Write-Host "  $line" -ForegroundColor Red
    }
    exit 3
  }

  # Count result rows: non-empty output lines. A bare "0" is the aggregate
  # zero case (SELECT COUNT(*) with no matches) -- counts as zero rows so
  # COUNT-style gates do not trivially succeed.
  $rowCount = 0
  foreach ($line in @($result)) {
    $lineStr = "$line"
    if ([string]::IsNullOrWhiteSpace($lineStr)) { continue }
    if ($lineStr.Trim() -eq "0") { continue }
    $rowCount++
  }

  if ($rowCount -gt 0) {
    Write-Info "attempt $attempt/$Attempts : $rowCount row(s) -- condition met" "Green"
    foreach ($line in @($result)) {
      Write-Host "  $line"
    }
    exit 0
  }

  Write-Info "attempt $attempt/$Attempts : 0 rows"

  if ($attempt -lt $Attempts) {
    Start-Sleep -Seconds $IntervalSec
  }
}

Write-Host "TIMEOUT after $Attempts attempt(s) (interval ${IntervalSec}s) -- condition not met." -ForegroundColor Red
exit 1
