param(
  [Parameter(Mandatory=$true)][string[]]$CapsuleFiles
)

$CapsuleFiles = $CapsuleFiles | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$errors = @()
$capsules = @()

foreach ($file in $CapsuleFiles) {
  if (-not (Test-Path $file)) {
    $errors += "File not found: $file"
    continue
  }

  $body = Get-Content $file -Raw

  $hasRequirementIds = $body -match 'requirement_ids:\s*\[([^\]]+)\]'
  $hasAllowedFiles = $body -match 'allowed_files:'
  $hasForbidden = $body -match 'forbidden_changes:'
  $hasAcceptance = $body -match 'acceptance_criteria:'
  $hasPatterns = $body -match 'patterns:'
  $hasKeyFiles = $body -match 'key_files:'
  $hasSpecBranch = $body -match 'spec_branch:\s*\S+'

  $missing = @()
  if (-not $hasRequirementIds) { $missing += "requirement_ids" }
  if (-not $hasAllowedFiles) { $missing += "allowed_files" }
  if (-not $hasForbidden) { $missing += "forbidden_changes" }
  if (-not $hasAcceptance) { $missing += "acceptance_criteria" }
  if (-not $hasPatterns) { $missing += "patterns" }
  if (-not $hasKeyFiles) { $missing += "key_files" }
  if (-not $hasSpecBranch) { $missing += "spec_branch" }

  if ($missing.Count -gt 0) {
    $errors += "$file : missing fields: $($missing -join ', ')"
    continue
  }

  $allowedFiles = @()
  $inAllowedSection = $false
  foreach ($line in ($body -split "`n")) {
    if ($line -match '^allowed_files:') {
      $inAllowedSection = $true
      continue
    }
    if ($inAllowedSection) {
      if ($line -match '^\s*-\s+(.+)') {
        $allowedFiles += $Matches[1].Trim()
      } elseif ($line -match '^\w+:') {
        $inAllowedSection = $false
      }
    }
  }

  $forbiddenFiles = @()
  $inForbiddenSection = $false
  foreach ($line in ($body -split "`n")) {
    if ($line -match '^forbidden_changes:') {
      $inForbiddenSection = $true
      continue
    }
    if ($inForbiddenSection) {
      if ($line -match '^\s*-\s+(.+)') {
        $forbiddenFiles += $Matches[1].Trim()
      } elseif ($line -match '^\w+:') {
        $inForbiddenSection = $false
      }
    }
  }

  $capsules += @{
    File = $file
    Allowed = $allowedFiles
    Forbidden = $forbiddenFiles
  }
}

$infrastructureFiles = @(
  "tsconfig.json", "tsconfig.*.json",
  "Cargo.toml", "Cargo.lock",
  "tauri.conf.json",
  "lib.rs",
  "package.json",
  "pnpm-workspace.yaml",
  ".github/workflows/validate.yml"
)

function Test-InfrastructureFile {
  param([string]$Path)
  foreach ($pattern in $infrastructureFiles) {
    $regex = '^' + ($pattern -replace '\.', '\.' -replace '\*', '.*') + '$'
    if ($Path -match $regex) { return $true }
  }
  return $false
}

for ($i = 0; $i -lt $capsules.Count; $i++) {
  for ($j = $i + 1; $j -lt $capsules.Count; $j++) {
    $overlap = $capsules[$i].Allowed | Where-Object { $capsules[$j].Allowed -contains $_ }
    if ($overlap) {
      $nonInfra = @($overlap | Where-Object { -not (Test-InfrastructureFile $_) })
      if ($nonInfra.Count -gt 0) {
        $errors += "FILE OVERLAP: $($capsules[$i].File) and $($capsules[$j].File) both claim: $($nonInfra -join ', ')"
      } else {
        Write-Host "  INFO: Infrastructure file overlap ($($overlap -join ', ')) allowed - both capsules may need it"
      }
    }
  }
}

if ($errors.Count -gt 0) {
  $errorCount = $errors.Count
  Write-Host "Capsule validation FAILED ($errorCount issues):"
  Write-Host ""
  foreach ($err in $errors) {
    Write-Host "  ERROR: $err"
  }
  Write-Host ""
  exit 1
}

$capsuleCount = $capsules.Count
Write-Host "Capsule validation PASSED ($capsuleCount capsules, no overlaps, all fields present)"
