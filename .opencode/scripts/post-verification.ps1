param(
  [Parameter(Mandatory=$true)][int]$BacklogIssue,
  [Parameter(Mandatory=$true)][string]$CapsuleName,
  [Parameter(Mandatory=$true)][string]$BodyFile
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "post-verification.ps1" -IssueNumber "$BacklogIssue" -Body {
  if (-not (Test-Path $BodyFile)) {
    throw "Body file not found: $BodyFile"
  }

  $body = Get-Content $BodyFile -Raw

  $temp = [System.IO.Path]::GetTempFileName()
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($temp, $body, $utf8)
  
  gh issue comment $BacklogIssue --body-file $temp 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $temp -ErrorAction SilentlyContinue
    throw "Failed to post verification comment on issue #$BacklogIssue"
  }
  
  Remove-Item $temp -ErrorAction SilentlyContinue
  Write-Host "Verification comment posted on issue #$BacklogIssue"
}
