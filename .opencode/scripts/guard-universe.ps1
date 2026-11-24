<#
.SYNOPSIS
  Generic guard-universe instrument (audit C4 / P6).

  Scans a root for a token set and prints the scanned / excluded / hit counts.
  With -PristineRoot it also prints a built-vs-pristine equality receipt for the
  scanned and hit counts, so an absence guard's universe is auditable.

.PARAMETER Root
  The tree to scan (default: the current directory).

.PARAMETER Tokens
  A file with one token per line (blank lines ignored).

.PARAMETER PristineRoot
  Optional second tree to compare against (built-vs-pristine equality).

.PARAMETER AllowHits
  Exit 0 even when the scan finds hits (reporting mode).

.PARAMETER SelfTest
  Run the built-in controls and exit 0 when they pass.

.EXITCODES
  0 = scan ok, 1 = hits found (without -AllowHits), 2 = pristine mismatch, 3 = error.
#>
[CmdletBinding()]
param(
  [string]$Root = ".",
  [string]$Tokens = "",
  [string]$PristineRoot = "",
  [switch]$AllowHits,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

$ExcludedDirNames = @('.git', 'node_modules', 'target', 'dist', '.next')

function Get-TokenSet {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "tokens file not found: $Path" }
  return @(Get-Content -LiteralPath $Path | Where-Object { $_.Trim() -ne '' })
}

function Invoke-Scan {
  param([string]$Root, [string[]]$TokenSet)
  $resolved = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
  $scanned = 0
  $excluded = 0
  $hits = 0
  $files = Get-ChildItem -LiteralPath $resolved -Recurse -File -Force -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($resolved.Length).TrimStart('\', '/')
    $parts = $rel -split '[\\/]'
    if (@($parts | Where-Object { $ExcludedDirNames -contains $_ }).Count -gt 0) { $excluded++; continue }
    $scanned++
    $text = ''
    try { $text = [System.IO.File]::ReadAllText($f.FullName) } catch { continue }
    foreach ($tok in $TokenSet) {
      if ($text.Contains($tok)) { $hits++; break }
    }
  }
  return [pscustomobject]@{ Scanned = $scanned; Excluded = $excluded; Hits = $hits }
}

if ($SelfTest) {
  $fail = 0
  $tmp = Join-Path $env:TEMP ("guard-universe-" + [Guid]::NewGuid().ToString("N"))
  try {
    New-Item -ItemType Directory -Path (Join-Path $tmp "root/src") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tmp "root/node_modules") -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $tmp "root/src/a.txt"), "NEEDLE`n")
    [System.IO.File]::WriteAllText((Join-Path $tmp "root/node_modules/b.txt"), "NEEDLE`n")
    $tokFile = Join-Path $tmp "tokens.txt"
    [System.IO.File]::WriteAllText($tokFile, "NEEDLE`n")
    $tokens = Get-TokenSet $tokFile

    $r1 = Invoke-Scan -Root (Join-Path $tmp "root") -TokenSet $tokens
    if ($r1.Scanned -eq 1 -and $r1.Excluded -eq 1 -and $r1.Hits -eq 1) {
      Write-Output "CONTROL 1 (hit + excluded dir) PASS"
    } else {
      Write-Output "CONTROL 1 (hit + excluded dir) FAIL: scanned=$($r1.Scanned) excluded=$($r1.Excluded) hits=$($r1.Hits)"; $fail++
    }

    New-Item -ItemType Directory -Path (Join-Path $tmp "clean") -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $tmp "clean/ok.txt"), "nothing here`n")
    $r2 = Invoke-Scan -Root (Join-Path $tmp "clean") -TokenSet $tokens
    if ($r2.Hits -eq 0 -and $r2.Scanned -eq 1) {
      Write-Output "CONTROL 2 (clean tree) PASS"
    } else {
      Write-Output "CONTROL 2 (clean tree) FAIL: scanned=$($r2.Scanned) hits=$($r2.Hits)"; $fail++
    }

    $r3 = Invoke-Scan -Root (Join-Path $tmp "clean") -TokenSet $tokens
    if ($r2.Scanned -eq $r3.Scanned -and $r2.Hits -eq $r3.Hits) {
      Write-Output "CONTROL 3 (equality receipt) PASS"
    } else {
      Write-Output "CONTROL 3 (equality receipt) FAIL"; $fail++
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($fail -gt 0) { exit 1 }
  Write-Output "RESULT: CLEAN (3 controls)"
  exit 0
}

try {
  $tokenSet = Get-TokenSet $Tokens
  $r = Invoke-Scan -Root $Root -TokenSet $tokenSet
  Write-Output ("SCANNED: {0}" -f $r.Scanned)
  Write-Output ("EXCLUDED: {0} (dirs: {1})" -f $r.Excluded, ($ExcludedDirNames -join ', '))
  Write-Output ("HITS: {0}" -f $r.Hits)
  if ($PristineRoot) {
    $p = Invoke-Scan -Root $PristineRoot -TokenSet $tokenSet
    Write-Output ("PRISTINE SCANNED: {0}  HITS: {1}" -f $p.Scanned, $p.Hits)
    if ($p.Scanned -eq $r.Scanned -and $p.Hits -eq $r.Hits) {
      Write-Output "EQUALITY: MATCH"
    } else {
      Write-Output "EQUALITY: MISMATCH"
      exit 2
    }
  }
  if ($r.Hits -gt 0 -and -not $AllowHits) { exit 1 }
  exit 0
} catch {
  Write-Output ("ERROR: {0}" -f $_.Exception.Message)
  exit 3
}
