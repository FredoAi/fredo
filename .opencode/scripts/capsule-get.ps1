param(
  [Parameter(ParameterSetName='Comment', Mandatory=$true)][string]$CommentUrl,
  [Parameter(ParameterSetName='ListComments', Mandatory=$true)][int]$IssueNumber,
  [Parameter(ParameterSetName='SubIssue', Mandatory=$true)][int]$SubIssueNumber,
  [Parameter(ParameterSetName='ListSubIssues', Mandatory=$true)][int]$ParentIssue,
  [Parameter(ParameterSetName='Comment')][switch]$CapsuleOnly
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "capsule-get.ps1" -Body {
  # --- Read a single capsule from a comment URL (legacy) ---
  if ($CommentUrl) {
    if ($CommentUrl -match 'issues/(\d+)#issuecomment-(\d+)') {
      $issueNum = $Matches[1]
      $commentId = $Matches[2]
    } else {
      throw "Invalid comment URL: $CommentUrl. Expected format: https://github.com/owner/repo/issues/N#issuecomment-M"
    }

    $comment = gh api "repos/{owner}/{repo}/issues/comments/$commentId" --jq '.body' 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to fetch comment $commentId`: $comment"
    }

    Write-Output $comment
    return
  }

  # --- List capsule comments on an issue (legacy) ---
  if ($IssueNumber) {
    $comments = gh api "repos/{owner}/{repo}/issues/$IssueNumber/comments" --jq '.[] | {id: .id, url: .html_url, body: .body}' 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to fetch comments for issue #$IssueNumber`: $comments"
    }

    $items = $comments | ConvertFrom-Json
    if (-not ($items -is [array])) {
      Write-Host "#${IssueNumber}: no capsule comments found"
      return
    }

    foreach ($item in $items) {
      if ($item.body -match '^## Capsule:') {
        $name = ($item.body -split "`n")[0] -replace '^## Capsule:\s*', ''
        Write-Host "$($item.url) | Capsule: $name"
      }
    }
    return
  }

  # --- Read a single capsule from a sub-issue ---
  if ($SubIssueNumber) {
    $body = gh issue view $SubIssueNumber --json body --jq '.body' 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to fetch sub-issue #$SubIssueNumber`: $body"
    }

    if ($CapsuleOnly) {
      if ($body -match '(?s)## Capsule:.*') {
        Write-Output $Matches[0]
      } else {
        throw "Sub-issue #$SubIssueNumber body does not contain '## Capsule:' section"
      }
    } else {
      Write-Output $body
    }
    return
  }

  # --- List all sub-issues (capsules) under a parent issue ---
  if ($ParentIssue) {
    $parentId = gh issue view $ParentIssue --json id --jq '.id' 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to get parent issue #$ParentIssue`: $parentId"
    }

    $query = @'
query($id: ID!) {
  node(id: $id) {
    ... on Issue {
      subIssues(first: 50) {
        nodes { number title url }
      }
    }
  }
}
'@

    $children = gh api graphql -f query=$query -F id="$parentId" --jq '.data.node.subIssues.nodes[] | {number: .number, title: .title, url: .url}' 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to list sub-issues for parent #$ParentIssue`: $children"
    }

    if (-not $children) {
      Write-Host "#$($ParentIssue): no sub-issues found"
      return
    }

    $items = $children | ConvertFrom-Json
    if (-not ($items -is [array])) {
      $items = @($items)
    }

    foreach ($item in $items) {
      Write-Host "$($item.number) | $($item.url) | $($item.title)"
    }
    return
  }
}