param(
  [Parameter(Mandatory=$true)][int]$PRNumber,
  [Parameter(Mandatory=$true)][string]$CapsuleFile,
  [switch]$SkipBuild
)

if (-not (Test-Path $CapsuleFile)) {
  Write-Error "Capsule file not found: $CapsuleFile"
  exit 1
}

$capsuleContent = Get-Content $CapsuleFile -Raw

function Extract-Field($field) {
  $pattern = "${field}:\s*\[([^\]]+)\]"
  if ($capsuleContent -match $pattern) {
    $raw = $Matches[1] -split ',' | ForEach-Object { $_.Trim() -replace '^"|"$' }
    return $raw
  }
  return @()
}

function Extract-Scalar($field) {
  $pattern = "${field}:\s*(.+)"
  if ($capsuleContent -match $pattern) {
    return $Matches[1].Trim()
  }
  return ""
}

$allowedFiles = Extract-Field "allowed_files"
$forbiddenFiles = Extract-Field "forbidden_changes"
$reqIds = Extract-Field "requirement_ids"
$specBranch = Extract-Scalar "spec_branch"

$allowedFiles += @("tsconfig.json", "tsconfig.*.json", "Cargo.toml", "tauri.conf.json", "lib.rs", "package.json")

Write-Host "=== Pre-Review Check for PR #$PRNumber ==="

Write-Host "`n[1/5] Reading PR diff..."
$diff = gh pr diff $PRNumber 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to get PR diff: $diff"
  exit 1
}

$changedFiles = ($diff | Select-String '^\+\+\+ b/(.+)$') | ForEach-Object { $_.Matches.Groups[1].Value }
$changedFiles = $changedFiles | Sort-Object -Unique
Write-Host "  Files changed:"
$changedFiles | ForEach-Object { Write-Host "    $_" }

Write-Host "`n[2/5] Checking allowed_files..."
$outOfScope = @()
foreach ($file in $changedFiles) {
  $allowed = $false
  foreach ($pattern in $allowedFiles) {
    $escaped = [regex]::Escape($pattern) -replace '\\\*\\\*', '.*' -replace '\\\*', '[^/\\]*'
    if ($file -match "^$escaped`$") {
      $allowed = $true
      break
    }
  }
  if (-not $allowed) {
    $outOfScope += $file
  }
}
if ($outOfScope) {
  Write-Error "FAIL: Files outside allowed_files:"
  $outOfScope | ForEach-Object { Write-Error "  $_" }
  Write-Output "FAIL: scope_violation"
  exit 1
}
Write-Host "  PASS"

Write-Host "`n[3/5] Checking forbidden_changes..."
$violations = @()
foreach ($file in $changedFiles) {
  foreach ($pattern in $forbiddenFiles) {
    $escaped = [regex]::Escape($pattern) -replace '\\\*\\\*', '.*' -replace '\\\*', '[^/\\]*'
    if ($file -match "^$escaped`$") {
      $violations += $file
    }
  }
}
if ($violations) {
  Write-Error "FAIL: Forbidden files touched:"
  $violations | ForEach-Object { Write-Error "  $_" }
  Write-Output "FAIL: forbidden_changes_violation"
  exit 1
}
Write-Host "  PASS"

Write-Host "`n[4/5] Checking Coder verification comment..."
$backlogIssue = if ($specBranch -match 'spec/(\d+)-') { $Matches[1] } else { "" }
if ($backlogIssue) {
  $comments = gh issue view $backlogIssue --comments --json comments --jq '.comments[].body' 2>&1
  $hasComment = $comments | Where-Object { $_ -match "Capsule:.*Implementation Notes" -and $_ -match "\[x\]|\[ \]" }
  if ($hasComment) {
    Write-Host "  PASS"
  } else {
    Write-Warning "  WARN: No implementation notes comment found on backlog #$backlogIssue"
  }
} else {
  Write-Warning "  WARN: Could not determine backlog issue from spec_branch: $specBranch"
}

if (-not $SkipBuild) {
  Write-Host "`n[5/5] Running build checks..."

  $projectRoot = (git rev-parse --show-toplevel 2>$null)
  $tauriDir = Join-Path $projectRoot "apps\tauri\src-tauri"

  $cargoResult = cargo check --manifest-path "$tauriDir\Cargo.toml" 2>&1
  $cargoCode = $LASTEXITCODE
  if ($cargoCode -ne 0) {
    Write-Error "FAIL: cargo check failed"
    Write-Output "FAIL: build_failure:rust"
    exit 1
  }
  Write-Host "  cargo check: PASS"

  $pnpmResult = pnpm --filter @fredo/ui build 2>&1
  $pnpmCode = $LASTEXITCODE
  if ($pnpmCode -ne 0) {
    Write-Error "FAIL: pnpm build failed"
    Write-Output "FAIL: build_failure:ui"
    exit 1
  }
  Write-Host "  pnpm build: PASS"
} else {
  Write-Host "`n[5/5] Build checks: SKIPPED (--SkipBuild)"
}

Write-Host "`n=== PR #$PRNumber PRE-REVIEW: ALL CHECKS PASSED ==="
Write-Output "PASS"
