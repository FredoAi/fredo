param(
  [Parameter(Mandatory=$true)][int]$IssueNumber,
  [Parameter(Mandatory=$true)][ValidateSet("attempts","bugs","e2e")][string]$Mode
)

Write-Host "=== Gate Check: Issue #$IssueNumber ($Mode) ==="

if ($Mode -eq "attempts") {
  $query = @"
query {
  node(id: $(gh issue view $IssueNumber --json id --jq '.id')) {
    ... on Issue {
      comments(last: 100) {
        nodes {
          body
        }
      }
    }
  }
}
"@
  $result = gh api graphql -f query=$query 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "GraphQL query failed: $result"
    exit 1
  }

  $attempts = ([regex]::Matches($result, '### Attempt (\d+)/4')).Count
  Write-Output $attempts
  Write-Host "  Attempts found: $attempts"
}
elseif ($Mode -eq "bugs") {
  $result = gh issue list --label bug --search "BUG-SP#$IssueNumber" --json number --jq 'length' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Bug query failed: $result"
    exit 1
  }
  Write-Output $result
  Write-Host "  Bugs found: $result"
}
elseif ($Mode -eq "e2e") {
  $query = @"
query {
  node(id: $(gh issue view $IssueNumber --json id --jq '.id')) {
    ... on Issue {
      comments(last: 100) {
        nodes {
          body
        }
      }
    }
  }
}
"@
  $result = gh api graphql -f query=$query 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "GraphQL query failed: $result"
    exit 1
  }

  $e2eFailures = ([regex]::Matches($result, 'Bug — E2E Failure')).Count
  Write-Output $e2eFailures
  Write-Host "  E2E failure cycles: $e2eFailures"
}
