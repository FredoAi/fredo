param(
  [switch]$DryRun
)

Write-Host "Scanning for stale spec branches..."
Write-Host ""

$remoteBranches = git branch -r 2>$null | Where-Object { $_ -match 'spec/' }

$staleBranches = @()
$activeSpecs = @()

foreach ($branch in $remoteBranches) {
  $branch = $branch.Trim()
  $branchName = $branch -replace '^origin/', ''
  
  $match = [regex]::Match($branchName, '^spec/(\d+)-')
  if ($match.Success) {
    $specNumber = $match.Groups[1].Value
    $specState = gh issue view $specNumber --json state,labels -q '{state: .state, labels: [.labels[].name]}' 2>$null
    
    if ($specState) {
      $state = ($specState | ConvertFrom-Json).state

      if ($state -eq "closed") {
        $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Issue #$specNumber is closed" }
      } else {
        $itemId = gh project item-list 1 --owner FredoAi --format json -q ".items[] | select(.content.url | endswith(\"/$specNumber\")) | .id" 2>$null
        if ($itemId) {
          $status = gh project field-list 1 --owner FredoAi --format json -q ".fields[] | select(.name==\"Status\")" 2>$null | ConvertFrom-Json
          $itemData = gh project item-view 1 --owner FredoAi --id $itemId --format json -q '{fields: .fieldValues.nodes}' 2>$null
          if ($itemData) {
            $itemObj = $itemData | ConvertFrom-Json
            $statusValue = $itemObj.fields | Where-Object { $_.field.name -eq "Status" } | Select-Object -First 1
            $statusName = if ($statusValue) { $statusValue.name } else { "Unknown" }
            if ($statusName -eq "Done") {
              $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Issue #$specNumber status: Done" }
            } else {
              $activeSpecs += @{ Branch = $branchName; Spec = $specNumber }
            }
          } else {
            $activeSpecs += @{ Branch = $branchName; Spec = $specNumber }
          }
        } else {
          $activeSpecs += @{ Branch = $branchName; Spec = $specNumber }
        }
      }
    } else {
      $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Issue #$specNumber not found" }
    }
  }
}

if ($staleBranches.Count -eq 0) {
  Write-Host "No stale spec branches found."
} else {
  Write-Host "Stale branches ($($staleBranches.Count)):"
  foreach ($sb in $staleBranches) {
    Write-Host "  $($sb.Branch) — $($sb.Reason)"
  }
  Write-Host ""
  
  if ($DryRun) {
    Write-Host "Dry run — no branches deleted. Run without -DryRun to delete."
  } else {
    foreach ($sb in $staleBranches) {
      Write-Host "Deleting remote branch: $($sb.Branch)"
      git push origin --delete ($sb.Branch -replace '^origin/', '') 2>$null
    }
  }
}

Write-Host ""
Write-Host "Active spec branches ($($activeSpecs.Count)):"
foreach ($as in $activeSpecs) {
  Write-Host "  $($as.Branch) — Spec #$($as.Spec) (active)"
}

Write-Host ""

$worktrees = git worktree list 2>$null | Select-String '.worktrees/'
$worktreeCount = ($worktrees | Measure-Object).Count
if ($worktreeCount -gt 0) {
  Write-Host "Worktrees found ($worktreeCount):"
  foreach ($wt in $worktrees) {
    $wtPath = ($wt -split '\s+')[0]
    Write-Host "  $wtPath"
  }
  
  if (-not $DryRun) {
    Write-Host ""
    Write-Host "Cleaning up worktrees..."
    foreach ($wt in $worktrees) {
      $wtPath = ($wt -split '\s+')[0]
      if (Test-Path $wtPath) {
        git worktree remove $wtPath --force 2>$null
      }
    }
  }
} else {
  Write-Host "No stale worktrees found."
}