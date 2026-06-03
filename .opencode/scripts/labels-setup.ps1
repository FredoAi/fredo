param()

$labels = @(
  @{ Name = "backlog";             Color = "0E8A16"; Description = "Planner-created: planned but not started" },
  @{ Name = "in-progress";         Color = "D876E3"; Description = "Architect has begun: spec and branch created" },
  @{ Name = "spec";                Color = "1D76DB"; Description = "Architect has decomposed: Coders are working" },
  @{ Name = "active";              Color = "D93F0B"; Description = "Main PR spec to main is open and accumulating" },
  @{ Name = "ready-for-testing";   Color = "5319E7"; Description = "Merged into spec branch: ready for user e2e" },
  @{ Name = "bug";                 Color = "B60205"; Description = "RCA bug from Coder failure (over 4 attempts)" }
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
