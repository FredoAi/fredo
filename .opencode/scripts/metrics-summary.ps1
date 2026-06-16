param(
  [switch]$Json
)

$metricsPath = ".opencode/metrics.json"

if (-not (Test-Path $metricsPath)) {
  Write-Host "No metrics file found at $metricsPath"
  exit 1
}

$metrics = Get-Content $metricsPath -Raw | ConvertFrom-Json
$specs = ($metrics.specs | Get-Member -MemberType NoteProperty).Count

if ($specs -eq 0) {
  Write-Host "No specs recorded yet."
  exit 0
}

$totalTasks = 0
$totalMerged = 0
$totalBugs = 0
$failureReasons = @{}
$passedSpecs = 0
$failedSpecs = 0
$totalRetries = 0
$oneShotSpecs = 0
$abandonedSpecs = 0
$fragileSpecs = @()
$totalCycles = 0
$retryArray = @()

foreach ($prop in ($metrics.specs | Get-Member -MemberType NoteProperty)) {
  $spec = $metrics.specs.$($prop.Name)
  $totalTasks += $spec.tasks
  $totalMerged += $spec.merged
  $totalBugs += $spec.bugs
  $totalRetries += ($spec.retries | Measure-Object -Sum).Sum

  if ($spec.passed) { $passedSpecs++ } else { $failedSpecs++ }

  if ($spec.one_shot) { $oneShotSpecs++ }
  if ($spec.closed_as -eq "abandoned") { $abandonedSpecs++ }
  if ($spec.total_cycles) { $totalCycles += $spec.total_cycles }
  if ($spec.follow_up_specs -and $spec.follow_up_specs.Count -gt 0) {
    $fragileSpecs += "#$($prop.Name)"
  }

  if ($spec.top_failure) {
    if (-not $failureReasons[$spec.top_failure]) {
      $failureReasons[$spec.top_failure] = 0
    }
    $failureReasons[$spec.top_failure]++
  }
}

$mergeRate = if ($totalTasks -gt 0) { [math]::Round(($totalMerged / $totalTasks) * 100, 1) } else { 0 }
$avgRetries = if ($specs -gt 0) { [math]::Round($totalRetries / $specs, 1) } else { 0 }
$oneShotRate = if ($specs -gt 0) { [math]::Round(($oneShotSpecs / $specs) * 100, 1) } else { 0 }
$abandonRate = if ($specs -gt 0) { [math]::Round(($abandonedSpecs / $specs) * 100, 1) } else { 0 }

if ($Json) {
  $output = @{
    total_specs = $specs
    passed = $passedSpecs
    failed = $failedSpecs
    total_tasks = $totalTasks
    merged = $totalMerged
    bugs = $totalBugs
    merge_rate_pct = $mergeRate
    avg_retries_per_spec = $avgRetries
    one_shot_rate_pct = $oneShotRate
    abandon_rate_pct = $abandonRate
    total_cycles_all_specs = $totalCycles
    fragile_specs = $fragileSpecs
    top_failures = ($failureReasons.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 | ForEach-Object { @{ reason = $_.Key; count = $_.Value } })
  }
  $output | ConvertTo-Json -Depth 3
  exit 0
}

Write-Host ""
Write-Host "=== Fredo SDD Metrics ==="
Write-Host ""
Write-Host "Specs: $specs ($passedSpecs passed, $failedSpecs failed)"
Write-Host "Tasks: $totalTasks ($totalMerged merged, $totalBugs bugs)"
Write-Host "Merge rate: ${mergeRate}%"
Write-Host "One-shot rate: ${oneShotRate}% ($oneShotSpecs/$specs)"
Write-Host "Abandon rate: ${abandonRate}% ($abandonedSpecs/$specs)"
Write-Host "Avg retries per spec: $avgRetries"
Write-Host ""

if ($fragileSpecs.Count -gt 0) {
  Write-Host "Fragile specs (needed follow-up specs): $($fragileSpecs -join ', ')"
  Write-Host ""
}

if ($failureReasons.Count -gt 0) {
  Write-Host "Top Failure Reasons:"
  $sorted = $failureReasons.GetEnumerator() | Sort-Object Value -Descending
  foreach ($item in $sorted) {
    Write-Host "  $($item.Key): $($item.Value) spec(s)"
  }
  Write-Host ""
}

Write-Host "=== Architecture Recommendations ==="
Write-Host ""
$topFailures = $failureReasons.GetEnumerator() | Sort-Object Value -Descending

if ($topFailures.Count -gt 0) {
  $top = $topFailures | Select-Object -First 1
  Write-Host "1. Focus on '$($top.Key)' — it is the #1 failure reason. Double-check this field in every capsule."
}

if ($oneShotRate -lt 50) {
  Write-Host "2. One-shot rate ($oneShotRate%) is below 50%. Consider adding a Research Phase before spec design."
}

if ($abandonRate -gt 10) {
  Write-Host "3. Abandon rate ($abandonRate%) is high. Review spec scoping and upfront research."
}

if ($avgRetries -ge 2) {
  Write-Host "4. Avg retries per spec ($avgRetries) is high. Consider smaller capsules or more key_files references."
}

if ($mergeRate -lt 80) {
  Write-Host "5. Merge rate ($mergeRate%) is low. Review task sizing and independence."
} else {
  Write-Host "Merge rate is healthy (${mergeRate}%). No task sizing changes needed."
}

if ($failedSpecs -gt $passedSpecs) {
  Write-Host "6. More specs failed than passed. Consider broader process review."
}
Write-Host ""
