param(
  [Parameter(Mandatory=$true)][int]$SpecNumber
)

Write-Host ""
Write-Host "=== Spec #$SpecNumber Status ==="
Write-Host ""

$spec = gh issue view $SpecNumber --json title,state,labels,url -q '{title: .title, state: .state, labels: [.labels[].name], url: .url}' 2>$null
if ($spec) {
  $s = $spec | ConvertFrom-Json
  Write-Host "Spec: $($s.title)"
  Write-Host "State: $($s.state)"
  Write-Host "Labels: $($s.labels -join ', ')"
  Write-Host "URL: $($s.url)"
} else {
  Write-Host "Spec issue #$SpecNumber not found or inaccessible."
  exit 1
}

Write-Host ""

$branch = git branch -r --list "origin/spec/$SpecNumber-*" 2>$null | ForEach-Object { $_.Trim() -replace '^origin/', '' }
if ($branch) {
  Write-Host "Branch: $branch"

  $commits = git log --oneline "origin/main..origin/$branch" 2>$null | Measure-Object | Select-Object -ExpandProperty Count
  Write-Host "Commits ahead of main: $commits"
} else {
  Write-Host "Branch: not found"
}

Write-Host ""

$mainPR = gh pr list --base main --head "spec/$SpecNumber-*" --json number,state,title,labels,isDraft -q '.[0]' 2>$null
if ($mainPR) {
  $mp = $mainPR | ConvertFrom-Json
  $draftMark = if ($mp.isDraft) { " [DRAFT]" } else { "" }
  Write-Host "Main PR: #$($mp.number) ($($mp.state))$draftMark"
  Write-Host "Main PR labels: $($mp.labels.name -join ', ')"
} else {
  Write-Host "Main PR: none"
}

Write-Host ""
Write-Host "Task Issues:"
Write-Host "-------------"

$tasks = gh issue list --search "SP#$SpecNumber-Task" --json number,title,state,labels -q '.[]' 2>$null
if ($tasks) {
  $taskItems = $tasks | ConvertFrom-Json
  if ($taskItems -is [array]) {
    foreach ($task in $taskItems) {
      $taskLabels = if ($task.labels) { ($task.labels | ForEach-Object { $_.name }) -join ', ' } else { "none" }
      Write-Host "  #$($task.number): $($task.title) [$($task.state)] {$taskLabels}"
    }
  } else {
    $taskLabels = if ($taskItems.labels) { ($taskItems.labels | ForEach-Object { $_.name }) -join ', ' } else { "none" }
    Write-Host "  #$($taskItems.number): $($taskItems.title) [$($taskItems.state)] {$taskLabels}"
  }
} else {
  Write-Host "  No task issues found"
}

Write-Host ""
Write-Host "Task PRs:"
Write-Host "---------"

$taskPRs = gh pr list --base "spec/$SpecNumber-*" --json number,state,title,headRefName,labels -q '.[]' 2>$null
if ($taskPRs) {
  $prItems = $taskPRs | ConvertFrom-Json
  if ($prItems -is [array]) {
    foreach ($pr in $prItems) {
      $prLabels = if ($pr.labels) { ($pr.labels | ForEach-Object { $_.name }) -join ', ' } else { "none" }
      Write-Host "  #$($pr.number): $($pr.title) [$($pr.state)] {$prLabels}"
      Write-Host "    Branch: $($pr.headRefName)"
    }
  } else {
    $prLabels = if ($prItems.labels) { ($prItems.labels | ForEach-Object { $_.name }) -join ', ' } else { "none" }
    Write-Host "  #$($prItems.number): $($prItems.title) [$($prItems.state)] {$prLabels}"
    Write-Host "    Branch: $($prItems.headRefName)"
  }
} else {
  Write-Host "  No task PRs found"
}

Write-Host ""
Write-Host "Bugs:"
Write-Host "-----"

$bugs = gh issue list --search "BUG-SP#$SpecNumber" --json number,title,state -q '.[]' 2>$null
if ($bugs) {
  $bugItems = $bugs | ConvertFrom-Json
  if ($bugItems -is [array]) {
    foreach ($bug in $bugItems) {
      Write-Host "  #$($bug.number): $($bug.title) [$($bug.state)]"
    }
  } else {
    Write-Host "  #$($bugItems.number): $($bugItems.title) [$($bugItems.state)]"
  }
} else {
  Write-Host "  No bugs"
}

Write-Host ""
Write-Host "Worktrees:"
Write-Host "----------"

git worktree list 2>$null | ForEach-Object { Write-Host "  $_" }
