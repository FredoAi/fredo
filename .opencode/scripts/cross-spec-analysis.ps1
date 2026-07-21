param(
  [int]$LastN = 10,
  [switch]$Json,
  [switch]$Verbose
)

. $PSScriptRoot\_Common.ps1

Invoke-WithLogging -Source "cross-spec-analysis.ps1" -ScriptBlock {
  $metricsPath = ".opencode/metrics.json"
  if (-not (Test-Path $metricsPath)) {
    throw "No metrics file found at $metricsPath"
  }

  $metrics = Get-Content $metricsPath -Raw | ConvertFrom-Json
  $allSpecs = @()
  foreach ($prop in ($metrics.specs | Get-Member -MemberType NoteProperty)) {
    $spec = $metrics.specs.$($prop.Name)
    $allSpecs += @{
      number = [int]$prop.Name
      spec = $spec
    }
  }

  if ($allSpecs.Count -eq 0) {
    Write-Host "No specs recorded yet."
    return
  }

  $sortedSpecs = $allSpecs | Sort-Object -Property number -Descending
  $recentSpecs = $sortedSpecs | Select-Object -First $LastN

  $totalRecent = $recentSpecs.Count

  $topFailureCount = @{}
  $topFailureTypesCount = @{}
  $originPhaseCount = @{}
  $detectionPhaseCount = @{}
  $scriptErrorSources = @{}
  $resultCount = @{}
  $humanVerifiedCount = 0
  $leakySpecs = @()
  $firstPassTotal = 0
  $firstPassSum = 0
  $capsuleTotalSum = 0
  $totalBugs = 0
  $totalCyclesSum = 0
  $specsWithImprovements = 0
  $totalImprovementAttempts = 0
  $effectiveImprovements = 0

  foreach ($entry in $recentSpecs) {
    $s = $entry.spec

    if ($s.top_failure -and $s.top_failure -ne "none") {
      $topFailureCount[$s.top_failure] = if ($topFailureCount.Contains($s.top_failure)) { $topFailureCount[$s.top_failure] + 1 } else { 1 }
    }

    if ($s.top_failure_types -and $s.top_failure_types.Count -gt 0) {
      foreach ($ft in $s.top_failure_types) {
        $topFailureTypesCount[$ft] = if ($topFailureTypesCount.Contains($ft)) { $topFailureTypesCount[$ft] + 1 } else { 1 }
      }
    }

    if ($s.defect_origin_phase -and $s.defect_origin_phase -ne "none") {
      $originPhaseCount[$s.defect_origin_phase] = if ($originPhaseCount.Contains($s.defect_origin_phase)) { $originPhaseCount[$s.defect_origin_phase] + 1 } else { 1 }
    }

    if ($s.defect_detection_phase -and $s.defect_detection_phase -ne "none") {
      $detectionPhaseCount[$s.defect_detection_phase] = if ($detectionPhaseCount.Contains($s.defect_detection_phase)) { $detectionPhaseCount[$s.defect_detection_phase] + 1 } else { 1 }
    }

    if ($s.result) {
      if (-not $resultCount[$s.result]) { $resultCount[$s.result] = 0 }
      $resultCount[$s.result]++
    }
    if ($s.human_verified) { $humanVerifiedCount++ }
    if ($s.result -eq "leaky") { $leakySpecs += "#$($entry.number)" }

    if ($s.capsules_first_pass -and $s.capsules_total -and $s.capsules_total -gt 0) {
      $firstPassSum += $s.capsules_first_pass
      $capsuleTotalSum += $s.capsules_total
    }
    $firstPassTotal++

    $totalBugs += if ($s.bugs) { $s.bugs } else { 0 }
    $totalCyclesSum += if ($s.total_cycles) { $s.total_cycles } else { 0 }

    if ($s.improvements -and $s.improvements.Count -gt 0) {
      $specsWithImprovements++
      $totalImprovementAttempts += $s.improvements.Count
      foreach ($imp in $s.improvements) {
        if ($imp.validation -and $imp.validation.improvement -eq "improved") {
          $effectiveImprovements++
        }
      }
    }
  }

  $cleanCount = if ($resultCount["clean"]) { $resultCount["clean"] } else { 0 }
  $acceptedCount = if ($resultCount["accepted"]) { $resultCount["accepted"] } else { 0 }
  $leakyCount = if ($resultCount["leaky"]) { $resultCount["leaky"] } else { 0 }
  $failedCount = if ($resultCount["failed"]) { $resultCount["failed"] } else { 0 }
  $cleanRate = if ($totalRecent -gt 0) { [math]::Round(($cleanCount / $totalRecent) * 100, 1) } else { 0 }
  $humanVerifiedRate = if ($totalRecent -gt 0) { [math]::Round(($humanVerifiedCount / $totalRecent) * 100, 1) } else { 0 }
  $leakRate = if ($totalRecent -gt 0) { [math]::Round(($leakyCount / $totalRecent) * 100, 1) } else { 0 }
  $firstPassRate = if ($capsuleTotalSum -gt 0) { [math]::Round(($firstPassSum / $capsuleTotalSum) * 100, 1) } else { 0 }
  $avgBugs = if ($totalRecent -gt 0) { [math]::Round($totalBugs / $totalRecent, 2) } else { 0 }
  $avgCycles = if ($totalRecent -gt 0) { [math]::Round($totalCyclesSum / $totalRecent, 2) } else { 0 }
  $improvementEffectiveness = if ($totalImprovementAttempts -gt 0) { [math]::Round(($effectiveImprovements / $totalImprovementAttempts) * 100, 1) } else { 0 }

  $sortedFailures = $topFailureCount.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5
  $sortedTypes = $topFailureTypesCount.GetEnumerator() | Sort-Object Value -Descending

  $phaseLeakPairs = @()
  foreach ($entry in $recentSpecs) {
    $s = $entry.spec
    if ($s.defect_origin_phase -and $s.defect_detection_phase -and $s.defect_origin_phase -ne $s.defect_detection_phase) {
      $phaseLeakPairs += @{
        spec = $entry.number
        origin = $s.defect_origin_phase
        detection = $s.defect_detection_phase
      }
    }
  }

  $scriptErrorReport = @()
  $errorLog = ".opencode/state/script-errors.jsonl"
  if (Test-Path $errorLog) {
    $allErrors = Get-Content $errorLog -ErrorAction SilentlyContinue | Where-Object { $_ -match "^\{" } | ForEach-Object { $_ | ConvertFrom-Json }
    $sourceGroups = $allErrors | Group-Object -Property source
    $totalErrors = $allErrors.Count

    $recentTimestamps = $allErrors | Where-Object { $_.timestamp } | Sort-Object timestamp -Descending | Select-Object -First 1
    $oldestRecent = $recentTimestamps

    $sortedErrors = $sourceGroups | Sort-Object Count -Descending | Select-Object -First 8
    foreach ($group in $sortedErrors) {
      $scriptErrorReport += @{
        source = $group.Name
        count = $group.Count
        pct = if ($totalErrors -gt 0) { [math]::Round(($group.Count / $totalErrors) * 100, 1) } else { 0 }
      }
    }

    $devEnvErrors = $allErrors | Where-Object { $_.source -eq "dev-tauri-manager.ps1" }
    $devEnvErrorCount = ($devEnvErrors | Measure-Object).Count
    $devEnvReliability = if ($totalErrors -gt 0) { [math]::Round((1 - ($devEnvErrorCount / $totalErrors)) * 100, 1) } else { 100 }
  } else {
    $totalErrors = 0
    $devEnvReliability = 100
  }

  if ($Json) {
    $output = @{
      analysis_window = $totalRecent
      result_distribution = ($resultCount.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ result = $_.Key; count = $_.Value } })
      clean_rate_pct = $cleanRate
      accepted_rate_pct = if ($totalRecent -gt 0) { [math]::Round(($acceptedCount / $totalRecent) * 100, 1) } else { 0 }
      leaky_rate_pct = $leakRate
      failed_rate_pct = if ($totalRecent -gt 0) { [math]::Round(($failedCount / $totalRecent) * 100, 1) } else { 0 }
      human_verified_rate_pct = $humanVerifiedRate
      leaky_specs = $leakySpecs
      first_pass_rate_pct = $firstPassRate
      avg_bugs_per_spec = $avgBugs
      avg_cycles_per_spec = $avgCycles
      improvement_effectiveness_pct = $improvementEffectiveness
      top_failures = ($sortedFailures | ForEach-Object { @{ reason = $_.Key; count = $_.Value } })
      top_failure_types = ($sortedTypes | ForEach-Object { @{ type = $_.Key; count = $_.Value } })
      defect_origin_phases = ($originPhaseCount.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ phase = $_.Key; count = $_.Value } })
      defect_detection_phases = ($detectionPhaseCount.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { @{ phase = $_.Key; count = $_.Value } })
      phase_leaks = ($phaseLeakPairs | ForEach-Object { @{ spec = $_.spec; origin = $_.origin; detection = $_.detection } })
      script_errors_total = $totalErrors
      script_error_sources = $scriptErrorReport
      dev_env_reliability_pct = $devEnvReliability
      specs_with_improvements = $specsWithImprovements
    }
    $output | ConvertTo-Json -Depth 4
    return
  }

  Write-Host ""
  Write-Host "=== Cross-Spec Analysis (last $totalRecent specs) ==="
  Write-Host ""
  Write-Host "Quality Trends:"
  Write-Host "  Result distribution: clean=$cleanCount accepted=$acceptedCount leaky=$leakyCount failed=$failedCount (of $totalRecent)"
  Write-Host "  Clean rate (true one-shot): ${cleanRate}%"
  Write-Host "  Human-verified rate: ${humanVerifiedRate}% ($humanVerifiedCount/$totalRecent)"
  Write-Host "  Leak rate (automated passed, human found issues): ${leakRate}%"
  Write-Host "  First-pass capsule rate: ${firstPassRate}%"
  Write-Host "  Avg bugs per spec: $avgBugs"
  Write-Host "  Avg e2e cycles per spec: $avgCycles"
  Write-Host "  Improvement effectiveness: ${improvementEffectiveness}% ($effectiveImprovements/$totalImprovementAttempts attempts effective)"
  Write-Host ""

  if ($leakySpecs.Count -gt 0) {
    Write-Host "Leaky specs (automated passed, human found issues): $($leakySpecs -join ', ')"
    Write-Host ""
  }

  if ($sortedFailures.Count -gt 0) {
    Write-Host "Top recurring failures (by top_failure):"
    foreach ($f in $sortedFailures) {
      Write-Host "  $($f.Key): $($f.Value) spec(s) in window"
    }
    Write-Host ""
  }

  if ($sortedTypes.Count -gt 0) {
    Write-Host "Top failure types (from top_failure_types[] across all specs):"
    foreach ($t in $sortedTypes) {
      Write-Host "  $($t.Key): $($t.Value) spec(s)"
    }
    Write-Host ""
  }

  if ($originPhaseCount.Count -gt 0) {
    Write-Host "Defect origins (where defects were introduced):"
    $sortedOrigins = $originPhaseCount.GetEnumerator() | Sort-Object Value -Descending
    foreach ($o in $sortedOrigins) {
      Write-Host "  $($o.Key): $($o.Value) spec(s)"
    }
    Write-Host ""
  }

  if ($phaseLeakPairs.Count -gt 0) {
    Write-Host "Phase leaks (defect escaped origin and was caught later):"
    foreach ($p in $phaseLeakPairs) {
      Write-Host "  Spec #$($p.spec): introduced in $($p.origin), caught in $($p.detection)"
    }
    Write-Host ""
  }

  if ($scriptErrorReport.Count -gt 0) {
    Write-Host "Script error hotspots (total: $totalErrors):"
    foreach ($se in $scriptErrorReport) {
      Write-Host "  $($se.source): $($se.count) errors ($($se.pct)%)"
    }
    Write-Host "  Dev environment reliability: ${devEnvReliability}%"
    Write-Host ""
  }

  Write-Host "=== Recommendations ==="
  Write-Host ""
  if ($sortedFailures.Count -gt 0 -and ($sortedFailures | Select-Object -First 1).Value -ge 2) {
    $topRecurring = $sortedFailures | Select-Object -First 1
    Write-Host "1. Recurring failure: '$($topRecurring.Key)' appears in $($topRecurring.Value) of the last $totalRecent specs. Prioritize this for improvement targeting."
  }
  if ($phaseLeakPairs.Count -gt 0) {
    Write-Host "2. $($phaseLeakPairs.Count) phase leak(s) detected. Defects escaping their origin phase suggest gaps in phase gate checks."
    $leakOrigins = $phaseLeakPairs | Group-Object origin
    foreach ($lo in $leakOrigins) {
      Write-Host "   - $($lo.Name) defects leaked to detection in $($lo.Count) case(s)"
    }
  }
  if ($devEnvReliability -lt 80) {
    Write-Host "3. Dev environment reliability (${devEnvReliability}%) is below 80%. Investigate dev-tauri-manager.ps1 failures."
  }
  if ($cleanRate -lt 50) {
    Write-Host "4. Clean rate (true one-shot) is ${cleanRate}%. Below 50%. Research Phase enforcement may need strengthening."
  }
  if ($leakRate -gt 10) {
    Write-Host "5. Leak rate is ${leakRate}%. Automated e2e is missing real issues. Investigate test coverage gaps."
  }
  if ($humanVerifiedRate -lt 80) {
    Write-Host "6. Human-verified rate is ${humanVerifiedRate}%. Too many specs lack manual confirmation."
  }
  Write-Host ""
}
