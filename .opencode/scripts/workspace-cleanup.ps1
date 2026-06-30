param(
  [Parameter(Mandatory=$true)][string]$SpecBranch
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "workspace-cleanup.ps1" -ScriptBlock {
  Write-Host "Cleaning up worktrees for $SpecBranch..."

  $worktrees = git worktree list 2>$null
  $removed = 0

  foreach ($line in ($worktrees -split "`n")) {
    if ($line -match '^(.+?)\s+([0-9a-f]+)\s+\[(.+)\]') {
      $path = $Matches[1].Trim()
      $branch = $Matches[3].Trim()

      if ($branch -like "feat/*" -and $branch -notlike "*$SpecBranch*") {
        continue
      }

      if ($branch -notlike "*$SpecBranch*" -and $branch -notlike "feat/*") {
        continue
      }

      # Skip the main worktree — git worktree remove fails on it
      # (Specs #303, #311, #318, #326, #327, #339: "'C:/Code/fredo' is a main working tree")
      if ((git rev-parse --show-toplevel 2>$null) -eq $path) {
        Write-Host "  Skipping main worktree: $path ($branch)"
        continue
      }

      if (Test-Path $path) {
        Write-Host "  Removing: $path ($branch)"
        git worktree remove $path --force 2>$null
        if ($LASTEXITCODE -eq 0) {
          $removed++
        } else {
          Write-Host "  Failed to remove $path"
        }
      }
    }
  }

  Write-Host ""
  Write-Host "Removed $removed worktree(s)."
}