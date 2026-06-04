param(
  [Parameter(ParameterSetName='Single', Mandatory=$true)][string]$CommentUrl,
  [Parameter(ParameterSetName='List', Mandatory=$true)][int]$IssueNumber
)

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
}
