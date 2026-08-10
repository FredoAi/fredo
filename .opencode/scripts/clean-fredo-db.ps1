# clean-fredo-db.ps1 - Stop the dev instance, delete the live Fredo DB, verify, optionally restart.
#
# The tester cannot `Remove-Item` the live DB directly (sandbox allowlist only permits
# `.opencode/*` paths). This script is the sanctioned one-command way to reset Fredo's
# SQLite store to a clean slate for a live e2e run (spec ACs that require "fresh DBs").
#
# - Stops the dev instance first (fredo.db is locked while the app runs).
# - Deletes `%APPDATA%\com.fredo.app\fredo.db` (+ `-wal` / `-shm`).
# - The app recreates the schema on next launch (CREATE TABLE IF NOT EXISTS / ensure_schema).
# - Optional `-Restart` brings the dev instance back up (`dev-env.ps1 -Action Up`).
#
# ASCII-only (PowerShell 5.1 parses .ps1 as ANSI): no em-dashes or non-ASCII literals.
#
# Usage (allowed for tester + self-improver):
#   powershell -File .opencode/scripts/clean-fredo-db.ps1            # clean only
#   powershell -File .opencode/scripts/clean-fredo-db.ps1 -Restart   # clean + restart dev instance

param(
  [switch]$Restart
)
$ErrorActionPreference = "Stop"

$devEnv = Join-Path $PSScriptRoot "dev-env.ps1"
$dbDir = Join-Path $env:APPDATA "com.fredo.app"
$db = Join-Path $dbDir "fredo.db"

# 1. Stop the dev instance so fredo.db is not locked by the running app.
& powershell -NoProfile -File $devEnv -Action Down
if ($LASTEXITCODE -ne 0) {
  Write-Error "dev-env Down failed (exit $LASTEXITCODE)"
  exit 1
}

# 2. Delete the live DB files (fredo.db + WAL + SHM).
$deleted = @()
foreach ($f in @($db, "$db-wal", "$db-shm")) {
  if (Test-Path -LiteralPath $f) {
    Remove-Item -LiteralPath $f -Force
    $deleted += $f
  }
}

# 3. Verify deletion.
if (Test-Path -LiteralPath $db) {
  Write-Error "fredo.db still present at $db - is the app still running?"
  exit 1
}

Write-Output "fredo.db cleaned: $dbDir"
if ($deleted.Count -eq 0) {
  Write-Output "(no DB files existed - already clean)"
} else {
  foreach ($f in $deleted) { Write-Output "  deleted: $f" }
}

# 4. Optional restart.
if ($Restart) {
  & powershell -NoProfile -File $devEnv -Action Up
  if ($LASTEXITCODE -ne 0) {
    Write-Error "dev-env Up failed (exit $LASTEXITCODE)"
    exit 1
  }
  Write-Output "dev instance restarted"
}
