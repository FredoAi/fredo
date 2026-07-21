param(
  [switch]$Json,
  [switch]$Verbose
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "metrics-summary.ps1" -ScriptBlock {
  $metricsPath = ".opencode/metrics.json"

  if (-not (Test-Path $metricsPath)) {
    throw "No metrics file found at $metricsPath"
  }

  $metrics = Get-Content $metricsPath -Raw | ConvertFrom-Json
  $specs = ($metrics.specs | Get-Member -MemberType NoteProperty).Count

  if ($specs -eq 0) {
    Write-Host "No specs recorded yet."
    return
  }

  $totalTasks = 0
  $totalMerged = 0
  $totalBugs = 0
  $failureReasons = @{}
  $failureTypesCount = @{}
  $passedSpecs = 0
  $failedSpecs = 0
  $totalRetries = 0
  $resultCount = @{}
  $humanVerifiedCount = 0
  $leakySpecs = @()
  $abandonedSpecs = 0
  $fragileSpecs = @()
  $totalCycles = 0
  $originPhaseCount = @{}
  $detectionPhaseCount = @{}
  $architectIssuesByCategory = @{}
  $reviewerIssuesByCategory = @{}
  $totalImprovements = 0
  $effectiveImprovements = 0

  foreach ($prop in ($metrics.specs | Get-Member -MemberType NoteProperty)) {
    $spec = $metrics.specs.$($prop.Name)
    $totalTasks += $spec.tasks
    $totalMerged += $spec.merged
    $totalBugs += $spec.bugs
    $totalRetries += ($spec.retries | Measure-Object -Sum).Sum

    if ($spec.passed) { $passedSpecs++ } else { $failedSpecs++ }

    if ($spec.result) {
      if (-not $resultCount[$spec.result]) { $resultCount[$spec.result] = 0 }
      $resultCount[$spec.result]++
    }
    if ($spec.human_verified) { $humanVerifiedCount++ }
    if ($spec.result -eq "leaky") { $leakySpecs += "#$($prop.Name)" }
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

    if ($spec.top_failure_types -and $spec.top_failure_types.Count -gt 0) {
      foreach ($ft in $spec.top_failure_types) {
        if (-not $failureTypesCount[$ft]) { $failureTypesCount[$ft] = 0 }
        $failureTypesCount[$ft]++
      }
    }

    if ($spec.defect_origin_phase -and $spec.defect_origin_phase -ne "none") {
      if (-not $originPhaseCount[$spec.defect_origin_phase]) { $originPhaseCount[$spec.defect_origin_phase] = 0 }
      $originPhaseCount[$spec.defect_origin_phase]++
    }

    if ($spec.defect_detection_phase -and $spec.defect_detection_phase -ne "none") {
      if (-not $detectionPhaseCount[$spec.defect_detection_phase]) { $detectionPhaseCount[$spec.defect_detection_phase] = 0 }
      $detectionPhaseCount[$spec.defect_detection_phase]++
    }

    if ($spec.architect_issues -and $spec.architect_issues.Count -gt 0) {
      foreach ($ai in $spec.architect_issues) {
        $cat = if ($ai.category) { $ai.category } else { "untyped" }
        if (-not $architectIssuesByCategory[$cat]) { $architectIssuesByCategory[$cat] = 0 }
        $architectIssuesByCategory[$cat]++
      }
    }

    if ($spec.reviewer_issues -and $spec.reviewer_issues.Count -gt 0) {
      foreach ($ri in $spec.reviewer_issues) {
        $cat = if ($ri.category) { $ri.category } else { "untyped" }
        if (-not $reviewerIssuesByCategory[$cat]) { $reviewerIssuesByCategory[$cat] = 0 }
        $reviewerIssuesByCategory[$cat]++
      }
    }

    if ($spec.improvements -and $spec.improvements.Count -gt 0) {
      $totalImprovements += $spec.improvements.Count
      foreach ($imp in $spec.improvements) {
        if ($imp.validation -and $imp.validation.improvement -eq "improved") {
          $effectiveImprovements++
        }
      }
    }
  }

  $mergeRate = if ($totalTasks -gt 0) { [math]::Round(($totalMerged / $totalTasks) * 100, 1) } else { 0 }
  $avgRetries = if ($specs -gt 0) { [math]::Round($totalRetries / $specs, 1) } else { 0 }
  $cleanCount = if ($resultCount["clean"]) { $resultCount["clean"] } else { 0 }
  $acceptedCount = if ($resultCount["accepted"]) { $resultCount["accepted"] } else { 0 }
  $leakyCount = if ($resultCount["leaky"]) { $resultCount["leaky"] } else { 0 }
  $failedCount = if ($resultCount["failed"]) { $resultCount["failed"] } else { 0 }
  $cleanRate = if ($specs -gt 0) { [math]::Round(($cleanCount / $specs) * 100, 1) } else { 0 }
  $humanVerifiedRate = if ($specs -gt 0) { [math]::Round(($humanVerifiedCount / $specs) * 100, 1) } else { 0 }
  $leakRate = if ($specs -gt 0) { [math]::Round(($leakyCount / $specs) * 100, 1) } else { 0 }
  $abandonRate = if ($specs -gt 0) { [math]::Round(($abandonedSpecs / $specs) * 100, 1) } else { 0 }

  $scriptErrorReport = @{}
  $devEnvReliability = 100
  $totalScriptErrors = 0
  $errorLog = ".opencode/state/script-errors.jsonl"
  if (Test-Path $errorLog) {
    $allErrors = Get-Content $errorLog -ErrorAction SilentlyContinue | Where-Object { $_ -match "^\{" }
    $totalScriptErrors = $allErrors.Count
    $sourceGroups = $allErrors | ForEach-Object { $_ | ConvertFrom-Json } | Group-Object -Property source
    foreach ($group in $sourceGroups) {
      $scriptErrorReport[$group.Name] = $group.Count
    }

    $devEnvErrors = $allErrors | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.source -eq "dev-tauri-manager.ps1" }
    $devEnvErrorCount = ($devEnvErrors | Measure-Object).Count
    $devEnvReliability = if ($totalScriptErrors -gt 0) { [math]::Round((1 - ($devEnvErrorCount / $totalScriptErrors)) * 100, 1) } else { 100 }
  }

  $sortedErrorSources = $scriptErrorReport.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5

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
      result_distribution = ($resultCount.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ result = $_.Key; count = $_.Value } })
      clean_rate_pct = $cleanRate
      leaky_rate_pct = $leakRate
      human_verified_rate_pct = $humanVerifiedRate
      leaky_specs = $leakySpecs
      abandon_rate_pct = $abandonRate
      total_cycles_all_specs = $totalCycles
      fragile_specs = $fragileSpecs
      top_failures = ($failureReasons.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 | ForEach-Object { @{ reason = $_.Key; count = $_.Value } })
      top_failure_types = ($failureTypesCount.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 | ForEach-Object { @{ type = $_.Key; count = $_.Value } })
      defect_origins = ($originPhaseCount.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ phase = $_.Key; count = $_.Value } })
      defect_detections = ($detectionPhaseCount.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ phase = $_.Key; count = $_.Value } })
      architect_issue_categories = ($architectIssuesByCategory.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ category = $_.Key; count = $_.Value } })
      reviewer_issue_categories = ($reviewerIssuesByCategory.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ category = $_.Key; count = $_.Value } })
      total_script_errors = $totalScriptErrors
      top_script_error_sources = ($sortedErrorSources | ForEach-Object { @{ source = $_.Key; count = $_.Value } })
      dev_env_reliability_pct = $devEnvReliability
      total_improvement_attempts = $totalImprovements
      effective_improvements = $effectiveImprovements
      improvement_effectiveness_pct = if ($totalImprovements -gt 0) { [math]::Round(($effectiveImprovements / $totalImprovements) * 100, 1) } else { 0 }
    }
    $output | ConvertTo-Json -Depth 4
    return
  }

  Write-Host ""
  Write-Host "=== Fredo SDD Metrics ==="
  Write-Host ""
  Write-Host "Specs: $specs ($passedSpecs passed, $failedSpecs failed)"
  Write-Host "Tasks: $totalTasks ($totalMerged merged, $totalBugs bugs)"
  Write-Host "Merge rate: ${mergeRate}%"
  Write-Host "Result distribution: clean=$cleanCount accepted=$acceptedCount leaky=$leakyCount failed=$failedCount"
  Write-Host "Clean rate (true one-shot): ${cleanRate}%"
  Write-Host "Human-verified rate: ${humanVerifiedRate}% ($humanVerifiedCount/$specs)"
  Write-Host "Leak rate (automated passed, human found issues): ${leakRate}%"
  Write-Host "Abandon rate: ${abandonRate}% ($abandonedSpecs/$specs)"
  Write-Host "Avg retries per spec: $avgRetries"
  Write-Host ""

  if ($leakySpecs.Count -gt 0) {
    Write-Host "Leaky specs (auto passed, human found issues): $($leakySpecs -join ', ')"
    Write-Host ""
  }

  if ($fragileSpecs.Count -gt 0) {
    Write-Host "Fragile specs (needed follow-up specs): $($fragileSpecs -join ', ')"
    Write-Host ""
  }

  if ($failureReasons.Count -gt 0) {
    Write-Host "Top Failure Reasons (top_failure):"
    $sorted = $failureReasons.GetEnumerator() | Sort-Object Value -Descending
    foreach ($item in $sorted) {
      Write-Host "  $($item.Key): $($item.Value) spec(s)"
    }
    Write-Host ""
  }

  if ($failureTypesCount.Count -gt 0) {
    Write-Host "Top Failure Types (from top_failure_types[]):"
    $sortedTypes = $failureTypesCount.GetEnumerator() | Sort-Object Value -Descending
    foreach ($t in $sortedTypes) {
      Write-Host "  $($t.Key): $($t.Value) spec(s)"
    }
    Write-Host ""
  }

  if ($originPhaseCount.Count -gt 0) {
    Write-Host "Defect Origins (where introduced):"
    $sortedOrigins = $originPhaseCount.GetEnumerator() | Sort-Object Value -Descending
    foreach ($o in $sortedOrigins) {
      Write-Host "  $($o.Key): $($o.Value) spec(s)"
    }
    Write-Host ""
  }

  if ($Verbose -and $architectIssuesByCategory.Count -gt 0) {
    Write-Host "Architect Issue Categories:"
    $sortedArch = $architectIssuesByCategory.GetEnumerator() | Sort-Object Value -Descending
    foreach ($a in $sortedArch) {
      Write-Host "  $($a.Key): $($a.Value)"
    }
    Write-Host ""

    Write-Host "Reviewer Issue Categories:"
    $sortedRev = $reviewerIssuesByCategory.GetEnumerator() | Sort-Object Value -Descending
    foreach ($r in $sortedRev) {
      Write-Host "  $($r.Key): $($r.Value)"
    }
    Write-Host ""
  }

  if ($totalScriptErrors -gt 0) {
    Write-Host "Script Errors: $totalScriptErrors total"
    foreach ($se in $sortedErrorSources) {
      Write-Host "  $($se.Key): $($se.Value)"
    }
    Write-Host "  Dev environment reliability: ${devEnvReliability}%"
    Write-Host ""
  }

  if ($totalImprovements -gt 0) {
    $effPct = if ($totalImprovements -gt 0) { [math]::Round(($effectiveImprovements / $totalImprovements) * 100, 1) } else { 0 }
    Write-Host "Improvement effectiveness: ${effPct}% ($effectiveImprovements/$totalImprovements attempts effective)"
    Write-Host ""
  }

  Write-Host "=== Architecture Recommendations ==="
  Write-Host ""
  $topFailures = $failureReasons.GetEnumerator() | Sort-Object Value -Descending

  if ($topFailures.Count -gt 0) {
    $top = $topFailures | Select-Object -First 1
    Write-Host "1. Focus on '$($top.Key)' — it is the #1 failure reason. Double-check this field in every capsule."
  }

  if ($cleanRate -lt 50) {
    Write-Host "2. Clean rate (true one-shot) is ${cleanRate}%. Below 50%. Consider adding a Research Phase before spec design."
  }
  $recNum = 3
  if ($leakRate -gt 10) {
    Write-Host "$($recNum). Leak rate is ${leakRate}%. Automated e2e is missing real issues. Review test coverage."
    $recNum++
  }

  if ($abandonRate -gt 10) {
    Write-Host "$($recNum). Abandon rate ($abandonRate%) is high. Review spec scoping and upfront research."
    $recNum++
  }

  if ($avgRetries -ge 2) {
    Write-Host "$($recNum). Avg retries per spec ($avgRetries) is high. Consider smaller capsules or more key_files references."
    $recNum++
  }

  if ($mergeRate -lt 80) {
    Write-Host "$($recNum). Merge rate ($mergeRate%) is low. Review task sizing and independence."
    $recNum++
  } else {
    Write-Host "$($recNum). Merge rate is healthy (${mergeRate}%). No task sizing changes needed."
    $recNum++
  }

  if ($failedSpecs -gt $passedSpecs) {
    Write-Host "$($recNum). More specs failed than passed. Consider broader process review."
    $recNum++
  }

  if ($originPhaseCount.Count -gt 0) {
    $topOrigin = $originPhaseCount.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
    Write-Host "$($recNum). Most defects originate in '$($topOrigin.Key)' phase ($($topOrigin.Value) specs). Consider strengthening that phase gate."
    $recNum++
  }

  if ($devEnvReliability -lt 80) {
    Write-Host "$($recNum). Dev environment reliability (${devEnvReliability}%) is below 80%. Investigate dev-tauri-manager.ps1 failures."
    $recNum++
  }
  Write-Host ""
}
