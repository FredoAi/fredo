<#
.SYNOPSIS
  Query Fredo's telemetry database (fredo.db) via sqlite3 CLI.
.DESCRIPTION
  Read-only query interface for telemetry_spans and other tables in fredo.db.
  Rejects DDL/DML. Defaults to LIMIT 1000. Supports json, markdown, and table output.
.PARAMETER Query
  SQL SELECT statement. Required. Must start with SELECT or PRAGMA table_info.
.PARAMETER Format
  Output format: json, md, or table. Default: table.
.PARAMETER Limit
  Maximum number of rows. Default: 1000. Only applied if query lacks LIMIT.
.EXAMPLE
  .\telemetry-query.ps1 -Query "SELECT * FROM telemetry_spans WHERE status_code='ERROR'" -Format json
.EXAMPLE
  .\telemetry-query.ps1 -Query "PRAGMA table_info(telemetry_spans)" -Format md
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$Query,

  [ValidateSet("json", "md", "table")]
  [string]$Format = "table",

  [int]$Limit = 1000
)

$ErrorActionPreference = "Stop"

function Write-ErrorMsg {
  param([string]$Message)
  Write-Host "ERROR: $Message" -ForegroundColor Red
}

# -- Guardrail 1: Reject DDL/DML keywords --
$forbiddenKeywords = @("CREATE ", "ALTER ", "DROP ", "INSERT ", "UPDATE ", "DELETE ")

if ($Query -match '(?i)\bPRAGMA\b') {
  if ($Query -notmatch '(?i)\bPRAGMA\s+(table_info|page_count|page_size|index_list|index_info)\b') {
    Write-ErrorMsg "Query rejected: PRAGMA only allowed for table_info, page_count, page_size, index_list, index_info."
    exit 120
  }
}

foreach ($keyword in $forbiddenKeywords) {
  if ($Query -match "(?i)\b$($keyword.TrimEnd())") {
    Write-ErrorMsg "Query rejected: contains forbidden keyword '$($keyword.Trim())'. Only SELECT and allowed PRAGMA permitted."
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

if (-not $sqlite3Bin) {
  Write-ErrorMsg "sqlite3 CLI not found. Install sqlite3 using:"
  Write-Host "    choco install sqlite" -ForegroundColor Yellow
  Write-Host "    scoop install sqlite" -ForegroundColor Yellow
  Write-Host "    winget install SQLite.SQLite" -ForegroundColor Yellow
  Write-Host "    apt install sqlite3   (WSL)" -ForegroundColor Yellow
  exit 1
}

# -- Locate fredo.db --
$dbPaths = @()

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
  $result = & $sqlite3Bin -readonly -bail $dbPath " $headersArg; $modeArg; $finalQuery;" 2>&1
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
