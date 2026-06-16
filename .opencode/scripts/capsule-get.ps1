param(
  [Parameter(ParameterSetName='Comment', Mandatory=$true)][string]$CommentUrl,
  [Parameter(ParameterSetName='ListComments', Mandatory=$true)][int]$IssueNumber,
  [Parameter(ParameterSetName='SubIssue', Mandatory=$true)][int]$SubIssueNumber,
  [Parameter(ParameterSetName='ListSubIssues', Mandatory=$true)][int]$ParentIssue,
  [Parameter(ParameterSetName='Comment')][switch]$CapsuleOnly
)

# --- Read a single capsule from a comment URL (legacy) ---
if ($CommentUrl) {
  if ($CommentUrl -match 'issues/(\d+)#issuecomment-(\d+)') {
    $issueNum = $Matches[1]
    $commentId = $Matches[2]
  } else {
    Write-Error "Invalid comment URL: $CommentUrl. Expected format: https://github.com/owner/repo/issues/N#issuecomment-M"
    exit 1
  }

  $comment = gh api "repos/{owner}/{repo}/issues/comments/$commentId" --jq '.body' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to fetch comment $commentId`: $comment"
    exit 1
  }

  Write-Output $comment
  exit 0
}

# --- List capsule comments on an issue (legacy) ---
if ($IssueNumber) {
  $comments = gh api "repos/{owner}/{repo}/issues/$IssueNumber/comments" --jq '.[] | {id: .id, url: .html_url, body: .body}' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to fetch comments for issue #$IssueNumber`: $comments"
    exit 1
  }

  $items = $comments | ConvertFrom-Json
  if (-not ($items -is [array])) {
    Write-Host "#$($IssueNumber): no capsule comments found"
    exit 0
  }

  foreach ($item in $items) {
    if ($item.body -match '^## Capsule:') {
      $name = ($item.body -split "`n")[0] -replace '^## Capsule:\s*', ''
      Write-Host "$($item.url) | Capsule: $name"
    }
  }
  exit 0
}

# --- Read a single capsule from a sub-issue ---
if ($SubIssueNumber) {
  $body = gh issue view $SubIssueNumber --json body --jq '.body' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to fetch sub-issue #$SubIssueNumber`: $body"
    exit 1
  }

  if ($CapsuleOnly) {
    if ($body -match '(?s)## Capsule:.*') {
      Write-Output $Matches[0]
    } else {
      Write-Error "Sub-issue #$SubIssueNumber body does not contain '## Capsule:' section"
      exit 1
    }
  } else {
    Write-Output $body
  }
  exit 0
}

# --- List all sub-issues (capsules) under a parent issue ---
if ($ParentIssue) {
  $children = gh issue list --parent $ParentIssue --state all --json number,title,url --jq '.[] | {number: .number, title: .title, url: .url}' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to list sub-issues for parent #$ParentIssue`: $children"
    exit 1
  }

  $items = $children | ConvertFrom-Json
  if (-not ($items -is [array])) {
    Write-Host "#$($ParentIssue): no sub-issues found"
    exit 0
  }

  foreach ($item in $items) {
    $capsuleName = $item.title -replace '^Capsule:\s*', ''
    Write-Host "$($item.number) | $($item.url) | $($item.title)"
  }
  exit 0
}
