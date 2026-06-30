param(
  [Parameter(ParameterSetName='SubIssue', Mandatory=$true)][int]$SubIssueNumber,
  [Parameter(ParameterSetName='ListSubIssues', Mandatory=$true)][int]$ParentIssue
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "capsule-get.ps1" -ScriptBlock {
  # --- Read a single capsule from a sub-issue ---
  if ($SubIssueNumber) {
    $body = gh issue view $SubIssueNumber --json body --jq '.body' 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to fetch sub-issue #$SubIssueNumber`: $body"
    }
    Write-Output $body
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
      subIssues(first: 100) {
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
