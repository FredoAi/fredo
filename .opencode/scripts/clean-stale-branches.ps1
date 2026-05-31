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
      $labels = ($specState | ConvertFrom-Json).labels
      
      if ($state -eq "closed") {
        $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Spec #$specNumber is closed" }
      } elseif ($labels -contains "ready-for-testing") {
        $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Spec #$specNumber is ready for testing" }
      } else {
        $activeSpecs += @{ Branch = $branchName; Spec = $specNumber }
      }
    } else {
      $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Spec #$specNumber not found" }
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