param(
  [switch]$DryRun,
  [int]$IssueNumber
)

. $PSScriptRoot\_Common.ps1

function Test-IssueClosed {
  param([int]$N)
  $result = gh issue view $N --json state 2>$null
  if (-not $result) { return $null }
  $state = ($result | ConvertFrom-Json).state
  return ($state -eq "CLOSED")
}

Invoke-WithLogging -Source "clean-stale-branches.ps1" -IssueNumber "$(if ($IssueNumber) { $IssueNumber })" -Body {
  if ($IssueNumber) {
    Write-Host "Cleaning branches for spec #$IssueNumber..."
    $closed = Test-IssueClosed -N $IssueNumber
    if ($null -eq $closed) {
      throw "Issue #$IssueNumber not found"
    }
    if (-not $closed) {
      throw "Issue #$IssueNumber is still OPEN — refusing to clean"
    }

    $deleted = 0

    # Remote spec branch
    $remoteSpec = (git branch -r 2>$null) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match "^origin/spec/$IssueNumber-" }
    foreach ($rb in $remoteSpec) {
      $branchName = $rb -replace '^origin/', ''
      Write-Host "  Deleting remote: $rb"
      if (-not $DryRun) {
        git push origin --delete $branchName 2>$null
        if ($LASTEXITCODE -eq 0) { $deleted++ } else { Write-Host "  Failed to delete $rb" }
      }
    }

    # Local spec branch
    $localSpec = (git branch 2>$null) -split "`n" | ForEach-Object { $_.Trim() -replace '^[* ]+', '' } | Where-Object { $_ -match "^spec/$IssueNumber-" }
    foreach ($lb in $localSpec) {
      Write-Host "  Deleting local: $lb"
      if (-not $DryRun) {
        git branch -D $lb 2>$null
        if ($LASTEXITCODE -eq 0) { $deleted++ } else { Write-Host "  Failed to delete $lb" }
      }
    }

    # Local feat branches for this spec
    $featBranches = (git branch 2>$null) -split "`n" | ForEach-Object { $_.Trim() -replace '^[* ]+', '' } | Where-Object { $_ -match "^feat/$IssueNumber-" }
    foreach ($fb in $featBranches) {
      Write-Host "  Deleting local feat: $fb"
      if (-not $DryRun) {
        git branch -D $fb 2>$null
        if ($LASTEXITCODE -eq 0) { $deleted++ } else { Write-Host "  Failed to delete $fb" }
      }
    }

    # Worktrees for this spec
    $worktrees = git worktree list 2>$null
    foreach ($line in ($worktrees -split "`n")) {
      if ($line -match "workspace-${IssueNumber}-") {
        $wtPath = ($line -split '\s+')[0]
        Write-Host "  Removing worktree: $wtPath"
        if (-not $DryRun) {
          git worktree remove $wtPath --force 2>$null
          if ($LASTEXITCODE -eq 0) { $deleted++ } else { Write-Host "  Failed to remove $wtPath" }
        }
      }
    }

    Write-Host ""
    if ($DryRun) {
      Write-Host "Dry run — $deleted branch(es)/worktree(s) would be deleted."
    } else {
      Write-Host "Deleted $deleted branch(es)/worktree(s) for spec #$IssueNumber."
    }
    return
  }

  Write-Host "Scanning for stale branches..."
  Write-Host ""

  $remoteBranches = git branch -r 2>$null
  $staleBranches = @()
  $activeSpecs = @()

  foreach ($line in ($remoteBranches -split "`n")) {
    $branch = $line.Trim()
    $branchName = $branch -replace '^origin/', ''

    if ($branchName -notmatch '^spec/(\d+)-') { continue }
    $specNumber = $Matches[1]

    $closed = Test-IssueClosed -N $specNumber
    if ($null -eq $closed) {
      $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Issue #$specNumber not found" }
    } elseif ($closed) {
      $staleBranches += @{ Branch = $branchName; Spec = $specNumber; Reason = "Issue #$specNumber is CLOSED" }
    } else {
      $activeSpecs += @{ Branch = $branchName; Spec = $specNumber }
    }
  }

  Write-Host "Remote spec branches scanned: $($staleBranches.Count + $activeSpecs.Count)"

  if ($staleBranches.Count -eq 0) {
    Write-Host "No stale remote spec branches found."
  } else {
    Write-Host "Stale remote spec branches ($($staleBranches.Count)):"
    foreach ($sb in $staleBranches) {
      Write-Host "  $($sb.Branch) - $($sb.Reason)"
    }
    Write-Host ""
    if ($DryRun) {
      Write-Host "Dry run — no branches deleted. Run without -DryRun to delete."
    } else {
      foreach ($sb in $staleBranches) {
        Write-Host "Deleting remote: $($sb.Branch)"
        git push origin --delete ($sb.Branch -replace '^origin/', '') 2>$null
      }
    }
  }

  Write-Host ""
  Write-Host "Active spec branches ($($activeSpecs.Count)):"
  foreach ($as in $activeSpecs) {
    Write-Host "  $($as.Branch) - Spec #$($as.Spec) (OPEN)"
  }

  Write-Host ""
  Write-Host "Scanning for stale local feat branches..."
  $staleLocal = @()
  $localBranches = (git branch 2>$null) -split "`n" | ForEach-Object { $_.Trim() -replace '^[* ]+', '' }

  foreach ($lb in $localBranches) {
    if ($lb -notmatch '^feat/(\d+)-') { continue }
    $featSpecNumber = $Matches[1]

    $closed = Test-IssueClosed -N $featSpecNumber
    if ($null -eq $closed -or $closed) {
      $staleLocal += @{ Branch = $lb; Spec = $featSpecNumber; Reason = if ($null -eq $closed) { "Issue not found" } else { "Issue CLOSED" } }
    }
  }

  if ($staleLocal.Count -eq 0) {
    Write-Host "No stale local feat branches found."
  } else {
    Write-Host "Stale local feat branches ($($staleLocal.Count)):"
    foreach ($sl in $staleLocal) {
      Write-Host "  $($sl.Branch) - $($sl.Reason)"
    }
    Write-Host ""
    if (-not $DryRun) {
      foreach ($sl in $staleLocal) {
        Write-Host "Deleting local: $($sl.Branch)"
        git branch -D $sl.Branch 2>$null
      }
    }
  }

  Write-Host ""
  Write-Host "Scanning for stale worktrees..."

  $staleWorktrees = @()
  $worktrees = git worktree list 2>$null

  foreach ($line in ($worktrees -split "`n")) {
    if ($line -notmatch '\.worktrees') { continue }
    $wtPath = ($line -split '\s+')[0]

    if ($line -match 'workspace-(\d+)-') {
      $wtSpec = $Matches[1]
      $closed = Test-IssueClosed -N $wtSpec
      if ($null -eq $closed -or $closed) {
        $staleWorktrees += @{ Path = $wtPath; Spec = $wtSpec; Reason = if ($null -eq $closed) { "Issue not found" } else { "Issue CLOSED" } }
      }
    } else {
      $staleWorktrees += @{ Path = $wtPath; Spec = "?"; Reason = "Unrecognized worktree name" }
    }
  }

  if ($staleWorktrees.Count -eq 0) {
    Write-Host "No stale worktrees found."
  } else {
    Write-Host "Stale worktrees ($($staleWorktrees.Count)):"
    foreach ($sw in $staleWorktrees) {
      Write-Host "  $($sw.Path) - $($sw.Reason)"
    }
    Write-Host ""
    if (-not $DryRun) {
      foreach ($sw in $staleWorktrees) {
        Write-Host "Removing worktree: $($sw.Path)"
        git worktree remove $sw.Path --force 2>$null
      }
    }
  }

  Write-Host ""
  Write-Host "Pruning tracking refs..."
  git remote prune origin 2>$null
  git worktree prune 2>$null

  Write-Host ""
  Write-Host "Done."
}