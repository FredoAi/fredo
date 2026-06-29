param(
  [switch]$Full,
  [string]$TestIssue = "221"
)

$ErrorActionPreference = "Continue"
$tests = 0
$passed = 0
$failed = 0
$skipped = 0
$results = @()

function Test-Script {
  param(
    [string]$Name,
    [ScriptBlock]$Test,
    [int]$ExpectedExitCode = 0
  )
  $global:tests++
  Write-Host -NoNewline "  $Name ... "
  try {
    $result = & $Test
    $exitCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    $resultStr = if ($result -is [array]) { $result -join "`n" } else { "$result" }
    if ($exitCode -ne $ExpectedExitCode) {
      Write-Host "FAIL (expected exit $ExpectedExitCode, got $exitCode)" -ForegroundColor Red
      $global:failed++
      $global:results += @{ Name = $Name; Status = "FAIL"; Detail = "expected exit $ExpectedExitCode, got $exitCode" }
    } else {
      Write-Host "PASS" -ForegroundColor Green
      $global:passed++
      $global:results += @{ Name = $Name; Status = "PASS"; Detail = $resultStr.Substring(0, [Math]::Min(80, $resultStr.Length)) }
    }
  } catch {
    Write-Host "FAIL ($($_.Exception.Message))" -ForegroundColor Red
    $global:failed++
    $global:results += @{ Name = $Name; Status = "FAIL"; Detail = $_.Exception.Message }
  }
}

function Test-Script-Syntax {
  param(
    [string]$Name,
    [string]$FilePath
  )
  $global:tests++
  Write-Host -NoNewline "  $Name ... "
  if (-not (Test-Path $FilePath)) {
    Write-Host "FAIL (file not found: $FilePath)" -ForegroundColor Red
    $global:failed++
    $global:results += @{ Name = $Name; Status = "FAIL"; Detail = "File not found: $FilePath" }
    return
  }
  try {
    $null = Get-Command $FilePath -ErrorAction Stop
    Write-Host "PASS" -ForegroundColor Green
    $global:passed++
    $global:results += @{ Name = $Name; Status = "PASS"; Detail = "Valid PowerShell script" }
  } catch {
    Write-Host "FAIL ($($_.Exception.Message))" -ForegroundColor Red
    $global:failed++
    $global:results += @{ Name = $Name; Status = "FAIL"; Detail = $_.Exception.Message }
  }
}

Write-Host ""
Write-Host "=== Pipeline Script Validation ==="
Write-Host ""

# --- capsule-get.ps1 ---
Write-Host "capsule-get.ps1:" -ForegroundColor Cyan

Test-Script "List sub-issues (-ParentIssue $TestIssue)" {
  $output = & powershell -File .opencode/scripts/capsule-get.ps1 -ParentIssue $TestIssue 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  if ($output -notmatch "sub-issues|no sub-issues") {
    throw "Unexpected output: $output"
  }
  return $output
}


# --- sub-issue-create.ps1 ---
Write-Host "sub-issue-create.ps1:" -ForegroundColor Cyan

Test-Script-Syntax "Syntax valid" ".opencode/scripts/sub-issue-create.ps1"

if ($Full) {
  Write-Host "  WARNING: -Full mode will create a real sub-issue under #$TestIssue" -ForegroundColor Yellow
  $tempFile = New-TemporaryFile
  "test capsule body" | Set-Content $tempFile
  Test-Script "Create sub-issue (-ParentIssue $TestIssue)" {
    $output = & powershell -File .opencode/scripts/sub-issue-create.ps1 -ParentIssue $TestIssue -Title "TEST-CAPSULE" -BodyFile $tempFile.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
    Remove-Item $tempFile.FullName
    return $output
  }
} else {
  Write-Host "  SKIP (-Full not set): sub-issue-create.ps1 creates real issues" -ForegroundColor DarkGray
  $global:skipped++
}

# --- metrics-summary.ps1 ---
Write-Host "metrics-summary.ps1:" -ForegroundColor Cyan

Test-Script "Read metrics.json" {
  $output = & powershell -File .opencode/scripts/metrics-summary.ps1 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "Specs:") { throw "Missing Specs: in output" }
  return $outputStr
}

Test-Script "JSON output" {
  $output = & powershell -File .opencode/scripts/metrics-summary.ps1 -Json 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $json = $output | ConvertFrom-Json
  if (-not $json.total_specs) { throw "Missing total_specs in JSON output" }
  return "total_specs: $($json.total_specs)"
}

# --- Other scripts (syntax check) ---
Write-Host "Other scripts:" -ForegroundColor Cyan

$scripts = @(
  "backlog-create.ps1",
  "spec-create.ps1",
  "pr-create.ps1",
  "pr-review.ps1",
  "project-status.ps1",
  "workspace-create.ps1",
  "workspace-cleanup.ps1",
  "clean-stale-branches.ps1",
  "dev-tauri-manager.ps1",
  "e2e-inject.ps1",
  "retro-append.ps1",
  "git-ops-comment.ps1",
  "sub-issue-create.ps1",
  "capsule-get.ps1",
  "_Common.ps1"
)

foreach ($script in $scripts) {
  $path = ".opencode/scripts/$script"
  Test-Script-Syntax $script $path
}

# --- Summary ---
Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
Write-Host "Total:  $tests"
Write-Host "Passed: $passed" -ForegroundColor Green
if ($failed -gt 0) { Write-Host "Failed: $failed" -ForegroundColor Red }
if ($skipped -gt 0) { Write-Host "Skipped: $skipped" -ForegroundColor DarkGray }
Write-Host ""

if ($failed -gt 0) {
  Write-Host "Failures:" -ForegroundColor Red
  foreach ($r in ($results | Where-Object { $_.Status -eq "FAIL" })) {
    Write-Host "  $($r.Name): $($r.Detail)" -ForegroundColor Red
  }
}

if ($failed -eq 0) {
  Write-Host "All pipeline scripts validated." -ForegroundColor Green
  exit 0
} else {
  exit 1
}
