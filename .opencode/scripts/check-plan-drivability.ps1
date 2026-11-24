<#
.SYNOPSIS
  Plan-time drivability census (audit A3 / P6).

  Reads the `## QA Expert` section of a converged triage plan and flags QA rows
  that cannot be driven as written: obvious placeholders, an empty evidence cell,
  or no QA table at all. Run before `transition planning -> implementation`.

.PARAMETER Issue
  Read `.opencode/tmp/<Issue>/triage.md`.

.PARAMETER File
  Read an explicit plan file.

.PARAMETER WarnOnly
  Report problems but exit 0 (advisory mode).

.PARAMETER SelfTest
  Run the built-in controls and exit 0 when they pass.
#>
[CmdletBinding()]
param(
  [int]$Issue = 0,
  [string]$File = "",
  [switch]$WarnOnly,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

function Get-PlanText {
  param([int]$Issue, [string]$File)
  if ($File) {
    if (-not (Test-Path -LiteralPath $File)) { throw "plan file not found: $File" }
    return (Get-Content -LiteralPath $File -Raw)
  }
  if ($Issue -gt 0) {
    $p = Join-Path (Get-Location) (".opencode/tmp/$Issue/triage.md")
    if (-not (Test-Path -LiteralPath $p)) { throw "plan file not found: $p" }
    return (Get-Content -LiteralPath $p -Raw)
  }
  throw "pass -File <path> or -Issue <N>"
}

function Get-QaSection {
  param([string]$Text)
  $lines = $Text -split "`r?`n"
  $start = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^##\s+QA Expert\b') { $start = $i; break }
  }
  if ($start -lt 0) { return $null }
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^##\s+') { break }
    $out.Add($lines[$i])
  }
  return ($out -join "`n")
}

function Test-QaSection {
  param([string]$Qa)
  $problems = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrWhiteSpace($Qa)) {
    $problems.Add("no '## QA Expert' section found")
    return $problems
  }
  if ($Qa -match '<executor>|<evidence>|<how>|\bTBD\b|\bTODO\b|upload-pending') {
    $problems.Add("QA section carries an undrivable placeholder (<executor>/<evidence>/<how>/TBD/TODO/upload-pending)")
  }
  $rows = @($Qa -split "`r?`n" | Where-Object { $_ -match '^\s*\|' })
  $dataRows = 0
  foreach ($r in $rows) {
    $cells = @($r.Trim().Trim('|') -split '\|' | ForEach-Object { $_.Trim() })
    if ($cells.Count -lt 3) { continue }
    if (($cells -join '').Trim().Length -eq 0) { continue }
    if (($cells[0] -match '^:?-{2,}:?$') -or ($cells[0] -match '^(case|id|ac)\b')) { continue }
    $dataRows++
    if ($cells[-1].Trim().Length -eq 0) { $problems.Add("QA row has an empty evidence cell: $($r.Trim())") }
  }
  if ($dataRows -eq 0) { $problems.Add("QA section has no table rows") }
  return $problems
}

if ($SelfTest) {
  $fail = 0
  $good = "## QA Expert`n| Case | Step | Evidence |`n|---|---|---|`n| A | click | telemetry_spans rows=1 |`n"
  $bad  = "## QA Expert`n| Case | Step | Evidence |`n|---|---|---|`n| A | click | <evidence> |`n"
  $p1 = Test-QaSection (Get-QaSection $good)
  if ($p1.Count -eq 0) { Write-Output "CONTROL 1 (good plan) PASS" } else { Write-Output "CONTROL 1 (good plan) FAIL: $($p1 -join '; ')"; $fail++ }
  $p2 = Test-QaSection (Get-QaSection $bad)
  if ($p2.Count -gt 0) { Write-Output "CONTROL 2 (placeholder plan) PASS" } else { Write-Output "CONTROL 2 (placeholder plan) FAIL: expected a refusal"; $fail++ }
  $p3 = Test-QaSection (Get-QaSection "## Summary`nno qa`n")
  if ($p3.Count -gt 0) { Write-Output "CONTROL 3 (missing QA) PASS" } else { Write-Output "CONTROL 3 (missing QA) FAIL: expected a refusal"; $fail++ }
  if ($fail -gt 0) { exit 1 }
  Write-Output "RESULT: CLEAN (3 controls)"
  exit 0
}

$text = Get-PlanText -Issue $Issue -File $File
$qa = Get-QaSection $text
$problems = Test-QaSection $qa
if ($problems.Count -eq 0) {
  Write-Output "RESULT: DRIVABLE (no undrivable QA rows)"
  exit 0
}
foreach ($p in $problems) { Write-Output "PROBLEM: $p" }
if ($WarnOnly) {
  Write-Output "RESULT: WARN (omit -WarnOnly to fail the check)"
  exit 0
}
Write-Output "RESULT: NOT DRIVABLE"
exit 1
