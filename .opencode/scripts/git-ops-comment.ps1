param(
  [Parameter(Mandatory=$true)][int]$IssueNumber,
  [Parameter(Mandatory=$true)][string]$BodyFile
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "git-ops-comment.ps1" -IssueNumber "$IssueNumber" -ScriptBlock {
  if (-not (Test-Path $BodyFile)) {
    throw "Body file not found: $BodyFile"
  }

  $temp = [System.IO.Path]::GetTempFileName()
  Copy-Item $BodyFile $temp -Force

  $ghOutput = gh issue comment $IssueNumber --body-file $temp 2>&1
  $exitCode = $LASTEXITCODE
  Remove-Item $temp -ErrorAction SilentlyContinue

  if ($exitCode -ne 0) {
    throw "Failed to post comment on issue #${IssueNumber}: $ghOutput"
  }

  Write-Host "Comment posted on issue #$IssueNumber"
}
