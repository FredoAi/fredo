<#
.SYNOPSIS
  Query Fredo's telemetry database (fredo.db or the embedded PostgreSQL store).
.DESCRIPTION
  Read-only query interface for telemetry_spans and other tables. Rejects
  DDL/DML. Defaults to LIMIT 1000. Supports json, markdown, and table output.

  Two engines (Spec #2944, G-284):
    * SQLite (default) - sqlite3 -readonly against fredo.db. The default search
      order is unchanged; pass -DbPath (or -Manifest) to target an isolated
      env's own fredo.db.
    * PostgreSQL (post-#2979 envs) - the managed psql against the env's
      ephemeral PG port (database "postgres"). Select with -PgPort, or with
      -Manifest when the manifest records ports.pg (and the manifest's SQLite
      dbPath is absent). This is the engine-appropriate read lever; a
      post-#2979 env may have no fredo.db at all.

  The read-only guardrails (statement-shape check + forbidden-keyword scan) are
  identical for both engines; SQLite additionally runs sqlite3 -readonly.
.PARAMETER Query
  SQL SELECT statement. Required. Must start with SELECT or PRAGMA table_info.
.PARAMETER Format
  Output format: json, md, or table. Default: table.
.PARAMETER Limit
  Maximum number of rows. Default: 1000. Only applied if query lacks LIMIT.
.PARAMETER DbPath
  SQLite database path override (Spec #2944). Empty => the existing fixed
  search order (byte-identical legacy behavior).
.PARAMETER Manifest
  Env process-manifest path (Spec #2944). Resolves the env's dbPath (SQLite)
  and ports.pg (PostgreSQL). Explicit -DbPath / -PgPort win.
.PARAMETER PgPort
  PostgreSQL loopback port (Spec #2944, G-284). >0 selects the managed-psql
  engine at this port. 0 => SQLite (or the -Manifest ports.pg when selected).
.PARAMETER PgHost
  PostgreSQL host. Default: 127.0.0.1.
.PARAMETER PgUser
  PostgreSQL user. Default: postgres.
.PARAMETER PgDatabase
  PostgreSQL database. Default: postgres.
.PARAMETER PgPassword
  PostgreSQL password. Default: $env:PGPASSWORD. Only used by the PG engine.
.EXAMPLE
  .\telemetry-query.ps1 -Query "SELECT * FROM telemetry_spans WHERE status_code='ERROR'" -Format json
.EXAMPLE
  .\telemetry-query.ps1 -Query "PRAGMA table_info(telemetry_spans)" -Format md
.EXAMPLE
  .\telemetry-query.ps1 -Query "SELECT 1" -DbPath ".opencode/tmp/envs/spec2944/data/fredo.db"
.EXAMPLE
  .\telemetry-query.ps1 -Query "SELECT count(*) FROM telemetry_spans" -Manifest ".opencode/tmp/envs/spec2944/manifest.json"
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$Query,

  [ValidateSet("json", "md", "table")]
  [string]$Format = "table",

  [int]$Limit = 1000,

  # SQLite path override (Spec #2944). Empty => existing fixed search order.
  [string]$DbPath = "",

  # Env process-manifest path (Spec #2944). Resolves dbPath + ports.pg.
  [string]$Manifest = "",

  # PostgreSQL read lever (G-284): >0 selects the managed-psql engine.
  [int]$PgPort = 0,
  [string]$PgHost = "127.0.0.1",
  [string]$PgUser = "postgres",
  [string]$PgDatabase = "postgres",
  [string]$PgPassword = $env:PGPASSWORD
)

$ErrorActionPreference = "Stop"

function Write-ErrorMsg {
  param([string]$Message)
  Write-Host "ERROR: $Message" -ForegroundColor Red
}

# -- Guardrail 1: Reject DDL/DML keywords --
# Match each keyword as a WHOLE word (\b...\b) so column names such as
# `updated_at` / `created_at` / `alternate` do not trip the DML scan on a
# substring (e.g. \bUPDATE matched the "update" inside "updated_at").
$forbiddenKeywords = @("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE")

if ($Query -match '(?i)\bPRAGMA\b') {
  if ($Query -notmatch '(?i)\bPRAGMA\s+(table_info|page_count|page_size|index_list|index_info)\b') {
    Write-ErrorMsg "Query rejected: PRAGMA only allowed for table_info, page_count, page_size, index_list, index_info."
    exit 120
  }
}

foreach ($keyword in $forbiddenKeywords) {
  if ($Query -match "(?i)\b$keyword\b") {
    Write-ErrorMsg "Query rejected: contains forbidden keyword '$keyword'. Only SELECT and allowed PRAGMA permitted."
    exit 121
  }
}

$trimmedQuery = $Query.Trim()
if ($trimmedQuery -notmatch '^(?i)(SELECT\s|PRAGMA\s|WITH\s)') {
  Write-ErrorMsg "Query rejected: must start with SELECT, PRAGMA (table_info/page_count/page_size/index_list/index_info), or WITH (CTE)."
  exit 122
}

# -- Locate sqlite3 binary --
$sqlite3Paths = @()

try {
  $sqlite3Cmd = Get-Command "sqlite3" -ErrorAction Stop
  $sqlite3Paths += $sqlite3Cmd.Source
} catch {
}

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
    $sqlite3Paths += $resolved.Path
  }
}

$unixPaths = @("/usr/bin/sqlite3", "/usr/local/bin/sqlite3")

foreach ($p in $unixPaths) {
  if (Test-Path $p) {
    $sqlite3Paths += $p
  }
}

$sqlite3Bin = $null
foreach ($p in $sqlite3Paths) {
  if (Test-Path $p) {
    $sqlite3Bin = $p
    break
  }
}

# NOTE: the sqlite3-not-found exit is deferred to the SQLite branch below so the
# PostgreSQL lever still works on a machine without sqlite3 (post-#2979 envs).

# -- Locate the managed psql binary (PostgreSQL lever, Spec #2944) -----------
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

# -- Resolve the env manifest (Spec #2944) -----------------------------------
$manifestObj = $null
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
}

# -- Engine selection (G-284) ------------------------------------------------
$manifestPgPort = 0
if ($manifestObj -and $manifestObj.ports) {
  $pgProp = $manifestObj.ports.PSObject.Properties["pg"]
  if ($pgProp -and $pgProp.Value) {
    $manifestPgPort = [int]$pgProp.Value
  }
}

$usePg = $false
$pgPortResolved = 0
if ($PgPort -gt 0) {
  $usePg = $true
  $pgPortResolved = $PgPort
} elseif ($manifestPgPort -gt 0) {
  $sqliteCandidate = $null
  if ($DbPath) {
    $sqliteCandidate = $DbPath
  } elseif ($manifestObj.dbPath) {
    $sqliteCandidate = $manifestObj.dbPath
  }
  if ($sqliteCandidate -and (Test-Path -LiteralPath $sqliteCandidate)) {
    $usePg = $false
  } else {
    $usePg = $true
    $pgPortResolved = $manifestPgPort
  }
}

if ($usePg) {
  # -- PostgreSQL engine (managed psql; database "postgres") -----------------
  $psqlBin = Find-PsqlBinary
  if (-not $psqlBin) {
    Write-ErrorMsg "psql CLI not found (managed embedded PostgreSQL or PATH)."
    exit 1
  }

  if ($PgPassword) {
    $env:PGPASSWORD = $PgPassword
  }
  # G-263: never block on an interactive password prompt; bound the connect.
  if (-not $env:PGCONNECT_TIMEOUT) {
    $env:PGCONNECT_TIMEOUT = "10"
  }

  $pgFinalQuery = $Query
  if ($Query -notmatch '(?i)\bLIMIT\s+\d+') {
    $pgFinalQuery = "$Query LIMIT $Limit"
  }

  $psqlArgs = @(
    "-X", "-q", "--no-psqlrc", "-w",
    "-h", $PgHost, "-p", "$pgPortResolved",
    "-U", $PgUser, "-d", $PgDatabase,
    "-v", "ON_ERROR_STOP=1"
  )
  if ($Format -eq "table") {
    $psqlArgs += @("-P", "pager=off", "-c", $pgFinalQuery)
  } else {
    $psqlArgs += @("--csv", "-c", $pgFinalQuery)
  }

  # PS 5.1: a native command with 2>&1 under "Stop" can turn a stderr write
  # into a terminating error -- run under "Continue" and check the exit code.
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
    Write-Host "Query was: $pgFinalQuery" -ForegroundColor DarkGray
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
}

# -- Locate fredo.db (SQLite engine) -----------------------------------------
if (-not $sqlite3Bin) {
  Write-ErrorMsg "sqlite3 CLI not found. Install sqlite3 using:"
  Write-Host "    choco install sqlite" -ForegroundColor Yellow
  Write-Host "    scoop install sqlite" -ForegroundColor Yellow
  Write-Host "    winget install SQLite.SQLite" -ForegroundColor Yellow
  Write-Host "    apt install sqlite3   (WSL)" -ForegroundColor Yellow
  exit 1
}

$dbPaths = @()

if ($DbPath) {
  $dbPaths += $DbPath
} elseif ($manifestObj -and $manifestObj.dbPath) {
  $dbPaths += $manifestObj.dbPath
} else {
  $appDataPath = "$env:APPDATA\com.fredo.app\fredo.db"
  $dbPaths += $appDataPath

  $secondaryPaths = @(
    "$env:LOCALAPPDATA\com.fredo.app\fredo.db",
    "$env:APPDATA\fredo\fredo.db",
    "$env:USERPROFILE\.fredo\fredo.db",
    "$env:HOME\.fredo\fredo.db"
  )

  foreach ($p in $secondaryPaths) {
    $dbPaths += $p
  }

  $searchDirs = @(
    "$env:APPDATA",
    "$env:LOCALAPPDATA",
    "$env:USERPROFILE\.fredo"
  )

  foreach ($dir in $searchDirs) {
    if (Test-Path $dir) {
      try {
        $found = Get-ChildItem -Path $dir -Recurse -Filter "fredo.db" -Depth 5 -ErrorAction SilentlyContinue
        foreach ($f in $found) {
          $dbPaths += $f.FullName
        }
      } catch {
      }
    }
  }
}

$dbPath = $null
$dbPaths = $dbPaths | Select-Object -Unique

foreach ($p in $dbPaths) {
  if (Test-Path $p) {
    $dbPath = $p
    break
  }
}

if (-not $dbPath) {
  Write-ErrorMsg "fredo.db not found. Searched these paths:"
  foreach ($p in $dbPaths) {
    Write-Host "    $p" -ForegroundColor DarkGray
  }
  Write-Host ""
  Write-Host "Run the Fredo application at least once to create the database." -ForegroundColor Yellow
  exit 2
}

# -- Apply LIMIT if not already present --
$finalQuery = $Query
if ($Query -notmatch '(?i)\bLIMIT\s+\d+') {
  $finalQuery = "$Query LIMIT $Limit"
}

# -- Determine sqlite3 output mode --
switch ($Format) {
  "json" {
    $modeArg = ".mode json"
    $headersArg = ".headers on"
  }
  "md" {
    $modeArg = ".mode table"
    $headersArg = ".headers on"
  }
  "table" {
    $modeArg = ".mode table"
    $headersArg = ".headers on"
  }
}

# -- Execute query --
try {
  $result = & $sqlite3Bin -readonly -bail -cmd $headersArg -cmd $modeArg $dbPath $finalQuery 2>&1
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0) {
    Write-ErrorMsg "SQLite query failed (exit code $exitCode)."
    Write-Host "Query was: $finalQuery" -ForegroundColor DarkGray
    Write-Host "Error output:" -ForegroundColor DarkGray
    foreach ($line in $result) {
      Write-Host "  $line" -ForegroundColor Red
    }
    exit 3
  }

  # -- Post-process for markdown output --
  if ($Format -eq "md") {
    $lines = @($result)
    $cleanLines = @()
    $headerLine = $null

    foreach ($line in $lines) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }

      $lineStr = "$line"

      if ($lineStr -match '^\+[-+]+\+$') {
        continue
      }

      if ($null -eq $headerLine) {
        $headerLine = $lineStr
        continue
      }

      if ($lineStr -match '^\|.*\|$' -and $lineStr -match '\|[\s-]+\|') {
        if ($headerLine) {
          $columns = @()
          $parts = $headerLine -split '\|' | ForEach-Object { $_.Trim() }
          foreach ($part in $parts) {
            if ($part -ne '') {
              $columns += $part
            }
          }
          $mdHeader = "| " + ($columns -join " | ") + " |"
          $mdSep = "| " + ($columns | ForEach-Object { "---" }) -join " | " + " |"
          $cleanLines += $mdHeader
          $cleanLines += $mdSep
          $headerLine = $null
        }
        continue
      }

      if ($lineStr -match '^\|.*\|$') {
        $columns = @()
        $parts = $lineStr -split '\|' | ForEach-Object { $_.Trim() }
        foreach ($part in $parts) {
          if ($part -ne '') {
            $columns += $part
          }
        }
        $mdRow = "| " + ($columns -join " | ") + " |"
        $cleanLines += $mdRow
      } else {
        $cleanLines += $lineStr
      }
    }

    if ($cleanLines.Count -eq 0) {
      $result
    } else {
      $cleanLines -join "`r`n"
    }
  } elseif ($Format -eq "json") {
    $result
  } else {
    $result
  }

} catch {
  Write-ErrorMsg "Unexpected error: $($_.Exception.Message)"
  exit 4
}
