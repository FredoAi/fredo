# clean-fredo-db.ps1 - Live Fredo DB lifecycle: clean (default), back up, or restore.
#
# The tester cannot `Remove-Item` the live DB directly (sandbox allowlist only permits
# `.opencode/*` paths). This script is the sanctioned one-command way to manage Fredo's
# live SQLite store for a live e2e run.
#
# - Stops the dev instance first (fredo.db is locked while the app runs).
# - Default: deletes `%APPDATA%\com.fredo.app\fredo.db` (+ `-wal` / `-shm`).
# - `-Backup`: copies the live DB (+ `-wal` / `-shm`) into an in-repo snapshot folder.
# - `-Restore`: copies a snapshot back over the live DB.
# - Optional `-Restart` brings the dev instance back up (`dev-env.ps1 -Action Up`).
#
# Why `-Backup` / `-Restore`: an AC that compares behavior across corpus sizes (small vs
# large stored history) needs a small corpus and then the real corpus back. Snapshots live
# under `.opencode/tmp/db-snapshots/<name>/` (gitignored) so the real corpus is never lost.
#
# The backup/restore branches stop the app but do NOT delete the live DB unless restoring.
#
# ASCII-only (PowerShell 5.1 parses .ps1 as ANSI): no em-dashes or non-ASCII literals.
#
# Usage (allowed for tester + self-improver):
#   powershell -File .opencode/scripts/clean-fredo-db.ps1                        # clean only
#   powershell -File .opencode/scripts/clean-fredo-db.ps1 -Restart              # clean + restart
#   powershell -File .opencode/scripts/clean-fredo-db.ps1 -Backup               # snapshot live DB
#   powershell -File .opencode/scripts/clean-fredo-db.ps1 -Backup -Name big     # named snapshot
#   powershell -File .opencode/scripts/clean-fredo-db.ps1 -Restore -Name big -Restart

param(
  [switch]$Restart,
  [switch]$Backup,
  [switch]$Restore,
  [string]$Name
)
$ErrorActionPreference = "Stop"

if ($Backup -and $Restore) {
  Write-Error "-Backup and -Restore are mutually exclusive"
  exit 1
}

$devEnv = Join-Path $PSScriptRoot "dev-env.ps1"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$dbDir = Join-Path $env:APPDATA "com.fredo.app"
$db = Join-Path $dbDir "fredo.db"
$snapshotRoot = Join-Path $repoRoot ".opencode\tmp\db-snapshots"
if (-not $Name) { $Name = Get-Date -Format "yyyyMMdd-HHmmss" }
$snapshotDir = Join-Path $snapshotRoot $Name

$dbFiles = @("fredo.db", "fredo.db-wal", "fredo.db-shm")

function Stop-DevInstance {
  & powershell -NoProfile -File $devEnv -Action Down
  if ($LASTEXITCODE -ne 0) {
    Write-Error "dev-env Down failed (exit $LASTEXITCODE)"
    exit 1
  }
}

function Start-DevInstance {
  if ($Restart) {
    & powershell -NoProfile -File $devEnv -Action Up
    if ($LASTEXITCODE -ne 0) {
      Write-Error "dev-env Up failed (exit $LASTEXITCODE)"
      exit 1
    }
    Write-Output "dev instance restarted"
  }
}

# --- Backup branch -----------------------------------------------------------
if ($Backup) {
  Stop-DevInstance
  if (-not (Test-Path -LiteralPath $db)) {
    Write-Error "no live fredo.db at $db - nothing to back up"
    exit 1
  }
  New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
  $copied = @()
  foreach ($f in $dbFiles) {
    $src = Join-Path $dbDir $f
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $snapshotDir $f) -Force
      $copied += $f
    }
  }
  Write-Output "fredo.db snapshot saved: $snapshotDir"
  foreach ($f in $copied) { Write-Output "  copied: $f" }
  Start-DevInstance
  exit 0
}

# --- Restore branch ----------------------------------------------------------
if ($Restore) {
  if (-not (Test-Path -LiteralPath $snapshotDir)) {
    $available = @()
    if (Test-Path -LiteralPath $snapshotRoot) {
      $available = @(Get-ChildItem -LiteralPath $snapshotRoot -Directory | ForEach-Object { $_.Name })
    }
    Write-Error "snapshot '$Name' not found under $snapshotRoot. Available: $($available -join ', ')"
    exit 1
  }
  Stop-DevInstance
  foreach ($f in $dbFiles) {
    $target = Join-Path $dbDir $f
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  }
  foreach ($f in $dbFiles) {
    $src = Join-Path $snapshotDir $f
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $dbDir $f) -Force
    }
  }
  if (-not (Test-Path -LiteralPath $db)) {
    Write-Error "restore failed - fredo.db not present at $db"
    exit 1
  }
  Write-Output "fredo.db restored from: $snapshotDir"
  Start-DevInstance
  exit 0
}

# --- Default clean branch (unchanged behavior) -------------------------------
Stop-DevInstance

$deleted = @()
foreach ($f in @($db, "$db-wal", "$db-shm")) {
  if (Test-Path -LiteralPath $f) {
    Remove-Item -LiteralPath $f -Force
    $deleted += $f
  }
}

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

Start-DevInstance
