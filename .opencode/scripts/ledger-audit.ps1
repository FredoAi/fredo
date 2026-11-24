<#
.SYNOPSIS
  Guardrail-ledger audit (audit E1 / P6).

  Reports the size and hygiene of `references.md`: record count, unresolved
  Pending records, machine stubs, duplicate ids, and Pending records older than
  a cutoff. Read-only — retirement stays a Curator judgment call.

.PARAMETER File
  The ledger path (default: docs/agentic-pipeline/playbooks/references.md).

.PARAMETER OlderThan
  Cutoff (yyyy-MM-dd) for "stale Pending" (default: 2026-10-01).

.PARAMETER SelfTest
  Run the built-in control and exit 0 when it passes.
#>
[CmdletBinding()]
param(
  [string]$File = "docs/agentic-pipeline/playbooks/references.md",
  [string]$OlderThan = "2026-10-01",
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

function Get-LedgerReport {
  param([string]$Path, [string]$Cutoff)
  if (-not (Test-Path -LiteralPath $Path)) { throw "ledger not found: $Path" }
  $lines = Get-Content -LiteralPath $Path
  $records = New-Object System.Collections.Generic.List[object]
  $cur = $null
  foreach ($l in $lines) {
    if ($l -match '^### (G-\d+):\s*(.*)$') {
      if ($cur) { $records.Add($cur) }
      $cur = [pscustomobject]@{ Id = $Matches[1]; Slug = $Matches[2].Trim(); Date = ''; Effectiveness = '' }
      continue
    }
    if ($l -match '^##\s+' -and $cur) { $records.Add($cur); $cur = $null; continue }
    if ($cur) {
      if ($l -match '^\- \*\*activation_date:\*\*\s*(\d{4}-\d{2}-\d{2})') { $cur.Date = $Matches[1] }
      elseif ($l -match '^\- \*\*effectiveness:\*\*\s*(.*)$') { $cur.Effectiveness = $Matches[1].Trim() }
    }
  }
  if ($cur) { $records.Add($cur) }
  $total = $records.Count
  $pending = @($records | Where-Object { $_.Effectiveness -match '^Pending' })
  $stale = @($pending | Where-Object { $_.Date -and $_.Date -lt $Cutoff })
  $stubs = @($records | Where-Object { $_.Slug -match 'on_the_go_improvement' })
  $dupes = @($records | Group-Object Id | Where-Object Count -gt 1 | ForEach-Object { $_.Name })
  return [pscustomobject]@{
    Total = $total
    Pending = $pending.Count
    StalePending = $stale.Count
    Stubs = $stubs.Count
    DuplicateIds = $dupes
    StaleIds = @($stale | ForEach-Object { $_.Id })
  }
}

if ($SelfTest) {
  $tmp = Join-Path $env:TEMP ("ledger-audit-" + [Guid]::NewGuid().ToString("N") + ".md")
  try {
    $fixture = @"
## Known Failure Modes

### G-001: good_rule
- **activation_date:** 2026-01-01
- **effectiveness:** Applied

### G-002: on_the_go_improvement
- **activation_date:** 2020-01-01
- **effectiveness:** Pending

### G-002: duplicate_rule
- **activation_date:** 2026-02-01
- **effectiveness:** Applied
"@
    [System.IO.File]::WriteAllText($tmp, $fixture)
    $r = Get-LedgerReport -Path $tmp -Cutoff '2026-10-01'
    $fail = 0
    if ($r.Total -eq 3) { Write-Output "CONTROL 1 (record count) PASS" } else { Write-Output "CONTROL 1 FAIL: total=$($r.Total)"; $fail++ }
    if ($r.StalePending -eq 1) { Write-Output "CONTROL 2 (stale pending) PASS" } else { Write-Output "CONTROL 2 FAIL: stale=$($r.StalePending)"; $fail++ }
    if ($r.Stubs -eq 1) { Write-Output "CONTROL 3 (stub) PASS" } else { Write-Output "CONTROL 3 FAIL: stubs=$($r.Stubs)"; $fail++ }
    if (@($r.DuplicateIds).Count -eq 1 -and @($r.DuplicateIds)[0] -eq 'G-002') { Write-Output "CONTROL 4 (duplicate id) PASS" } else { Write-Output "CONTROL 4 FAIL: dupes=$($r.DuplicateIds -join ',')"; $fail++ }
    if ($fail -gt 0) { exit 1 }
    Write-Output "RESULT: CLEAN (4 controls)"
    exit 0
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

try {
  $r = Get-LedgerReport -Path $File -Cutoff $OlderThan
  Write-Output ("RECORDS: {0}" -f $r.Total)
  Write-Output ("PENDING: {0}" -f $r.Pending)
  Write-Output ("STALE PENDING (<{0}): {1}" -f $OlderThan, $r.StalePending)
  Write-Output ("STUBS: {0}" -f $r.Stubs)
  $dupeText = if (@($r.DuplicateIds).Count -gt 0) { @($r.DuplicateIds) -join ', ' } else { 'none' }
  Write-Output ("DUPLICATE IDS: {0}" -f $dupeText)
  if (@($r.StaleIds).Count -gt 0) { Write-Output ("STALE IDS: {0}" -f (@($r.StaleIds) -join ', ')) }
  exit 0
} catch {
  Write-Output ("ERROR: {0}" -f $_.Exception.Message)
  exit 1
}
