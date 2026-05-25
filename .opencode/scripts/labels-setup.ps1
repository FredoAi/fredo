param()

$labels = @(
  @{ Name = "spec:active";          Color = "0E8A16"; Description = "Spec is being worked on" },
  @{ Name = "spec:ready-for-e2e";  Color = "5319E7"; Description = "Spec branch ready for manual testing" },
  @{ Name = "spec:done";            Color = "BFD4F2"; Description = "Merged to main, closed" },
  @{ Name = "task:in-progress";     Color = "207DE5"; Description = "Coder is working on it" },
  @{ Name = "task:done";             Color = "006B75"; Description = "PR merged, task complete" },
  @{ Name = "pr:needs-review";      Color = "FBCA04"; Description = "Ready for reviewer" },
  @{ Name = "pr:approved";           Color = "0E8A16"; Description = "Reviewer approved" },
  @{ Name = "pr:changes-requested"; Color = "D93F0B"; Description = "Reviewer wants changes" }
)

foreach ($label in $labels) {
  $result = gh label create $label.Name --color $label.Color --description $label.Description --force 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Created: $($label.Name)"
  } else {
    Write-Host "Exists or error: $($label.Name) - $result"
  }
}

Write-Host ""
Write-Host "Label setup complete. Created $($labels.Count) labels."