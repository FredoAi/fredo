param()

$labels = @(
  @{ Name = "pr:approved";           Color = "0E8A16"; Description = "Reviewer approved - merge gate" },
  @{ Name = "spec:ready-for-e2e";    Color = "5319E7"; Description = "Spec branch ready for final review + manual e2e" }
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