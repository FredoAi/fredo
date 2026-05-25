param(
  [Parameter(Mandatory=$true)][int]$Number,
  [Parameter(Mandatory=$true)][ValidateSet("issue","pr")][string]$Type,
  [string[]]$Add,
  [string[]]$Remove
)

$addLabels = if ($Add) { $Add -join "," } else { "" }
$removeLabels = if ($Remove) { $Remove -join "," } else { "" }

if ($Type -eq "issue") {
  if ($Add) {
    gh issue edit $Number --add-label $addLabels
  }
  if ($Remove) {
    foreach ($label in $Remove) {
      gh issue edit $Number --remove-label $label
    }
  }
}

if ($Type -eq "pr") {
  if ($Add) {
    gh pr edit $Number --add-label $addLabels
  }
  if ($Remove) {
    foreach ($label in $Remove) {
      gh pr edit $Number --remove-label $label
    }
  }
}

Write-Host "Labels updated on $Type #$Number"