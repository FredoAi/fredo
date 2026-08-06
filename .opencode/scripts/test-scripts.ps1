param(
  [string]$TestIssue = "633"
)

$ErrorActionPreference = "Continue"
$tests = 0
$passed = 0
$failed = 0
$skipped = 0
$results = @()

function Test-Script {
  param(
    [string]$Name,
    [ScriptBlock]$Test,
    [int]$ExpectedExitCode = 0
  )
  $global:tests++
  Write-Host -NoNewline "  $Name ... "
  $global:LASTEXITCODE = 0
  try {
    $result = & $Test
    $exitCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    $resultStr = if ($result -is [array]) { $result -join "`n" } else { "$result" }
    if ($exitCode -ne $ExpectedExitCode) {
      Write-Host "FAIL (expected exit $ExpectedExitCode, got $exitCode)" -ForegroundColor Red
      $global:failed++
      $global:results += @{ Name = $Name; Status = "FAIL"; Detail = "expected exit $ExpectedExitCode, got $exitCode" }
    } else {
      Write-Host "PASS" -ForegroundColor Green
      $global:passed++
      $global:results += @{ Name = $Name; Status = "PASS"; Detail = $resultStr.Substring(0, [Math]::Min(80, $resultStr.Length)) }
    }
  } catch {
    Write-Host "FAIL ($($_.Exception.Message))" -ForegroundColor Red
    $global:failed++
    $global:results += @{ Name = $Name; Status = "FAIL"; Detail = $_.Exception.Message }
  }
}

function Test-Script-Syntax {
  param(
    [string]$Name,
    [string]$FilePath
  )
  $global:tests++
  Write-Host -NoNewline "  $Name ... "
  if (-not (Test-Path $FilePath)) {
    Write-Host "FAIL (file not found: $FilePath)" -ForegroundColor Red
    $global:failed++
    $global:results += @{ Name = $Name; Status = "FAIL"; Detail = "File not found: $FilePath" }
    return
  }
  try {
    $null = Get-Command $FilePath -ErrorAction Stop
    Write-Host "PASS" -ForegroundColor Green
    $global:passed++
    $global:results += @{ Name = $Name; Status = "PASS"; Detail = "Valid PowerShell script" }
  } catch {
    Write-Host "FAIL ($($_.Exception.Message))" -ForegroundColor Red
    $global:failed++
    $global:results += @{ Name = $Name; Status = "FAIL"; Detail = $_.Exception.Message }
  }
}

$ps = ".opencode/scripts/pipeline-state.rs"

Write-Host ""
Write-Host "=== Pipeline State Machine Validation ==="
Write-Host ""

Write-Host "pipeline-state.rs:" -ForegroundColor Cyan

Test-Script "Compile + health" {
  $output = & rust-script $ps --action health 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "issues") { throw "Missing issues: in output" }
  return $outputStr
}

Test-Script "Read context" {
  $output = & rust-script $ps --issue $TestIssue --agent tester 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "Phase:") { throw "Missing Phase: in output" }
  return $outputStr
}

Test-Script "Context block contract (all documented fields)" {
  $output = & rust-script $ps --issue $TestIssue --agent tester 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  foreach ($f in @("Phase:", "Feature:", "Phase owner:", "Triggering event:", "Previous phase:", "Goals:", "Playbook:", "Responsibilities:", "Handoff:", "Validation:", "Doc references:")) {
    if ($outputStr -notmatch [regex]::Escape($f)) { throw "Missing context field: $f" }
  }
  # Phase owner must be the configured owner for intake (product-owner), not the dispatched actor
  if ($outputStr -notmatch "Phase owner:\s+product-owner") { throw "Phase owner should be product-owner for intake, got: $outputStr" }
  return "context contract OK"
}

# The orchestrator (self-improver) gets an operational snapshot on context
Test-Script "Orchestration context snapshot (self-improver)" {
  $output = & rust-script $ps --issue $TestIssue --agent self-improver 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  foreach ($f in @("Impl plan:", "Spec branch ahead:", "Evidence on plan:", "A2A file:", "Spec branch:", "Open blocked:")) {
    if ($outputStr -notmatch [regex]::Escape($f)) { throw "Missing orchestration field: $f" }
  }
  # A non-self-improver actor must NOT get the snapshot
  $testerOut = & rust-script $ps --issue $TestIssue --agent tester 2>&1
  $testerStr = if ($testerOut -is [array]) { $testerOut -join "`n" } else { "$testerOut" }
  if ($testerStr -match "Spec branch ahead:") { throw "Tester should not get the orchestration snapshot" }
  return "orchestration snapshot present for self-improver only"
}

Test-Script "Per-issue metrics" {
  $output = & rust-script $ps --action metrics --issue $TestIssue 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "Agent calls") { throw "Missing Agent calls in output" }
  return $outputStr
}

Test-Script "Aggregate metrics (JSON)" {
  $output = & rust-script $ps --action metrics --all --json 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $json = $output | ConvertFrom-Json
  if (-not $json.events) { throw "Missing events in JSON output" }
  return "events: $($json.events)"
}

Test-Script "Audit bundle" {
  $output = & rust-script $ps --action audit --issue $TestIssue 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "Events recorded") { throw "Missing event count" }
  foreach ($f in @("Evidence on plan", "Spec PR merged", "Telemetry error spans")) {
    if ($outputStr -notmatch [regex]::Escape($f)) { throw "Missing audit field: $f" }
  }
  return $outputStr
}

Test-Script "Record integrity (verify)" {
  $output = & rust-script $ps --action verify 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "INTEGRITY: OK") { throw "Expected INTEGRITY: OK, got: $outputStr" }
  return "INTEGRITY: OK"
}

Test-Script "Action failures recorded as metric events" {
  $log = ".opencode/state/issues/$TestIssue.jsonl"
  $before = (Select-String -Path $log -Pattern 'state_machine.failure' -ErrorAction SilentlyContinue | Measure-Object).Count
  # Force a validation failure (nonexistent body file) on TestIssue.
  & rust-script $ps --issue $TestIssue --agent tester --action upload-evidence --body-file "$env:TEMP\missing-evidence-body" --image "$env:TEMP\missing-evidence-img" 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "Expected the action to fail" }
  $global:LASTEXITCODE = 0
  $after = (Select-String -Path $log -Pattern 'state_machine.failure' -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($after -le $before) { throw "Expected a state_machine.failure event, before=$before after=$after" }
  return "failure event recorded"
}

Test-Script "Prune stale branches (idempotent)" {
  $output = & rust-script $ps --action prune --agent self-improver 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Script failed: $output" }
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "PRUNED:") { throw "Expected PRUNED: in output, got: $outputStr" }
  return "PRUNED"
}

Test-Script "Create-worktree blocked for non-actionable issue" {
  $output = & rust-script $ps --action create-worktree --issue $TestIssue --worktree-path "$env:TEMP\fredo-wt-test" 2>&1
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  # Issue $TestIssue is not ready-for-dev/in-progress-dev, so the guard must block.
  if ($outputStr -notmatch "BLOCKED") { throw "Expected BLOCKED (not actionable), got: $outputStr" }
  return "BLOCKED as expected"
}

# --worktree-path is optional now (defaults to .worktrees/<issue>); the guard
# must still block a non-actionable issue rather than demand the path.
Test-Script "Create-worktree defaults path (guard still blocks)" {
  $output = & rust-script $ps --action create-worktree --issue $TestIssue 2>&1
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($outputStr -notmatch "BLOCKED") { throw "Expected BLOCKED without --worktree-path, got: $outputStr" }
  return "default path accepted, guard blocked"
}

Test-Script "upload-evidence role-gates + validates" {
  # non-tester/SM actor blocked
  $role = & rust-script $ps --issue $TestIssue --agent developer --action upload-evidence --body-file x --image y 2>&1
  $roleStr = if ($role -is [array]) { $role -join "`n" } else { "$role" }
  if ($roleStr -notmatch "not allowed to upload-evidence") { throw "Expected role-gate block, got: $roleStr" }
  # missing --image rejected
  $noimg = & rust-script $ps --issue $TestIssue --agent tester --action upload-evidence --body-file x 2>&1
  $noimgStr = if ($noimg -is [array]) { $noimg -join "`n" } else { "$noimg" }
  if ($noimgStr -notmatch "requires --image") { throw "Expected requires --image, got: $noimgStr" }
  return "upload-evidence validation verified"
} -ExpectedExitCode 1

Test-Script "upload-evidence requires a parent spec without --base" {
  $img = Join-Path $env:TEMP "fredo-ev-test.png"
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap(10, 10)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Red)
  $bmp.Save($img, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $bodyFile = Join-Path $env:TEMP "fredo-ev-body.md"
  Set-Content -Path $bodyFile -Value "AC-1: passes" -Encoding UTF8
  # Issue $TestIssue has no 'Parent: Implementation Plan #N', so without --base the
  # action must refuse to guess the spec branch rather than commit somewhere random.
  $out = & rust-script $ps --issue $TestIssue --agent tester --action upload-evidence --body-file $bodyFile --image $img 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($LASTEXITCODE -eq 0) { throw "Expected failure, got exit 0" }
  if ($outStr -notmatch "cannot resolve parent plan") { throw "Expected parent-resolution failure, got: $outStr" }
  Remove-Item $img, $bodyFile -ErrorAction SilentlyContinue
  return "parent-resolution failure verified"
} -ExpectedExitCode 1

Test-Script "set-label is removed (labels are state-machine side-effects)" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action set-label --label in-progress-dev 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "unknown action") { throw "Expected 'unknown action' for removed set-label, got: $outStr" }
  return "set-label removed"
} -ExpectedExitCode 1

# --- Intake draft validation (no GitHub write; expects INTAKE INVALID error path) ---
$badDraft = Join-Path $env:TEMP "fredo-bad-draft.md"
Set-Content -Path $badDraft -Value "## Title`nAs a user I want stuff." -Encoding UTF8

Test-Script "Create-issue rejects invalid draft"  {
  $output = & rust-script $ps --agent product-owner --action create-issue --title "validation-test" --body-file $badDraft --issue-type backlog 2>&1
  $outputStr = if ($output -is [array]) { $output -join "`n" } else { "$output" }
  if ($LASTEXITCODE -eq 0) { throw "Expected failure, got exit 0" }
  if ($outputStr -notmatch "INTAKE INVALID") { throw "Expected INTAKE INVALID, got: $outputStr" }
  return "INTAKE INVALID detected"
} -ExpectedExitCode 1

Test-Script "Write actions are role-gated" {
  # developer must NOT be able to upload-evidence / close-issue / audit-record
  $devEvidence = & rust-script $ps --issue $TestIssue --agent developer --action upload-evidence --body-file x --image y 2>&1
  $devClose  = & rust-script $ps --issue $TestIssue --agent developer --action close-issue --to-phase done 2>&1
  $testerAudit = & rust-script $ps --issue $TestIssue --agent tester --action audit-record --verdict success 2>&1
  foreach ($out in @($devEvidence, $devClose, $testerAudit)) {
    $s = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($s -notmatch "not allowed to") { throw "Expected role-gate block, got: $s" }
  }
  # product-owner may create-issue (intake-role); validate it gets PAST the role gate to intake validation
  $poCreate = & rust-script $ps --agent product-owner --action create-issue --title "x" --body-file $badDraft --issue-type backlog 2>&1
  $poStr = if ($poCreate -is [array]) { $poCreate -join "`n" } else { "$poCreate" }
  if ($poStr -notmatch "INTAKE INVALID" -or $poStr -match "not allowed to") { throw "PO should pass role gate to intake validation, got: $poStr" }
  return "role gating verified"
} -ExpectedExitCode 1

# audit-record must reject a restart targeting the terminal phase (no GitHub write —
# the done-rejection fires before any gh call), and refuse to post a Decision comment
# on an issue that is not in the audit phase.
Test-Script "audit-record rejects restart-to-done / non-audit issue (no mutation)" {
  $out = & rust-script $ps --issue $TestIssue --agent self-improver --action audit-record --verdict restart --phase done 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($LASTEXITCODE -eq 0) { throw "Expected non-zero exit, got 0" }
  if ($outStr -notmatch "illegal restart phase|audit phase") { throw "Expected rejection (illegal restart or audit-phase guard), got: $outStr" }
  return "audit-record restart-to-done rejected"
} -ExpectedExitCode 1

Remove-Item -LiteralPath $badDraft -Force -ErrorAction SilentlyContinue

# --- Positive-path coverage (self-contained scratch issues) ---
# Each test creates its own scratch issue(s), exercises the action, asserts the
# expected side-effect, then closes them. The shared $TestIssue fixture (633) is
# never mutated beyond the harmless Status comment test below.

Test-Script "Comment positive path (Status on fixture)" {
  $commentBody = Join-Path $env:TEMP "fredo-comment-body.md"
  Set-Content -Path $commentBody -Value "validation harness positive-path check" -Encoding UTF8
  try {
    $out = & rust-script $ps --issue $TestIssue --agent tester --action comment --prefix Status --body-file $commentBody 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "comment failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "COMMENTED:") { throw "Expected COMMENTED:, got: $outStr" }
    return "Status comment posted on #$TestIssue"
  } finally {
    Remove-Item -LiteralPath $commentBody -Force -ErrorAction SilentlyContinue
  }
}

Test-Script "Transition positive path (intake -> triage, scratch issue)" {
  $draft = Join-Path $env:TEMP "fredo-po-draft.md"
  $draftBody = @"
## Title
Transition positive-path scratch backlog

## Problem / Why now
The harness needs positive-path coverage of the transition action.

## Intended users
Pipeline automation and its maintainers.

## Proposed behavior / Scope
A scratch issue is created and transitioned from intake to triage, then closed.

## Success metrics
The scratch issue reaches the triage-plan label.

## Acceptance criteria
- The harness can create and transition a scratch issue end to end.

## Priority
P1

## Out of scope
Nothing beyond harness validation.
"@
  Set-Content -Path $draft -Value $draftBody -Encoding UTF8
  $issueNum = $null
  try {
    $create = & rust-script $ps --agent self-improver --action create-issue --title "temp: transition positive-path" --body-file $draft --issue-type backlog 2>&1
    if ($LASTEXITCODE -ne 0) { throw "create-issue failed: $create" }
    $createStr = if ($create -is [array]) { $create -join "`n" } else { "$create" }
    if ($createStr -notmatch "CREATED:") { throw "Expected CREATED:, got: $createStr" }
    $m = [regex]::Match($createStr, "issues/(\d+)")
    if (-not $m.Success) { throw "Could not parse issue number from: $createStr" }
    $issueNum = [int]$m.Groups[1].Value

    $trans = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $transStr = if ($trans -is [array]) { $trans -join "`n" } else { "$trans" }
    if ($LASTEXITCODE -ne 0) { throw "transition failed (exit $LASTEXITCODE): $transStr" }
    if ($transStr -notmatch "TRANSITIONED:") { throw "Expected TRANSITIONED:, got: $transStr" }
    $labels = @(& gh issue view $issueNum --json labels --jq ".labels[].name" 2>$null)
    if ($labels -notcontains "triage-plan") { throw "Expected triage-plan label after transition, got: $labels" }
    # intake -> triage auto-seeds the A2A deliberation file (was the SM's triage-init).
    $a2a = ".opencode/tmp/$issueNum/triage.md"
    if (-not (Test-Path $a2a)) { throw "A2A file not auto-seeded: $a2a" }
    $a2aContent = [System.IO.File]::ReadAllText($a2a)
    if ($a2aContent -notmatch "## Discussion") { throw "A2A file missing ## Discussion: $a2aContent" }
    return "transitioned #$issueNum intake -> triage (triage-plan; A2A auto-seeded)"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    if ($issueNum) { & gh issue close $issueNum 2>$null | Out-Null; Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue; Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue }
    $global:LASTEXITCODE = 0
  }
}

Test-Script "audit-record success positive path (self-closing)" {
  $url = & gh issue create --title "temp: audit-record success" --label audit --body "Positive-path audit scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    # The verification guardrail requires a PASS Evidence comment (with a live
    # telemetry_spans reference) before audit-record can close a feature as done.
    $evBody = Join-Path $env:TEMP "fredo-ar-success-evidence.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: PASS`nSELECT ... FROM telemetry_spans ... rows=1", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action audit-record --verdict success --reason "ok" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "audit-record failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "AUDIT -> DONE") { throw "Expected AUDIT -> DONE, got: $outStr" }
    $view = @(& gh issue view $issueNum --json state,labels 2>$null) | Out-String
    $parsed = $view | ConvertFrom-Json
    if ($parsed.state -ne "CLOSED") { throw "Expected CLOSED, got state $($parsed.state)" }
    $labels = @($parsed.labels | ForEach-Object { $_.name })
    if ($labels -notcontains "done") { throw "Expected done label, got: $labels" }
    return "audit-record success auto-closed #$issueNum as done"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# audit-record --verdict success fails CLOSED when verification is not OK
# (no valid Evidence) — the #1499 false-PASS enforcement.
Test-Script "audit-record success blocked without valid verification" {
  $url = & gh issue create --title "temp: audit-record fail-closed" --label audit --body "fail-closed scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    # static-only Evidence (no telemetry_spans) on a live-policy plan-like issue
    $evBody = Join-Path $env:TEMP "fredo-ar-failclosed-evidence.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: PASS (static source analysis)", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action audit-record --verdict success --reason "x" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "cannot record success") { throw "Expected cannot-record-success block, got: $outStr" }
    $state = & gh issue view $issueNum --json state --jq .state 2>$null
    if ($state -ne "OPEN") { throw "issue must stay OPEN after blocked audit-record, got $state" }
    return "audit-record fail-closed: static-only evidence blocked"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

Test-Script "audit-record restart positive path (audit -> implementation)" {
  $url = & gh issue create --title "temp: audit-record restart" --label audit --body "Positive-path audit restart scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action audit-record --verdict restart --phase implementation --reason "rework" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "audit-record failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "AUDIT -> implementation") { throw "Expected AUDIT -> implementation, got: $outStr" }
    $labels = @(& gh issue view $issueNum --json labels --jq ".labels[].name" 2>$null)
    if ($labels -notcontains "ready-for-test") { throw "Expected ready-for-test label after restart, got: $labels" }
    return "audit-record restart moved #$issueNum audit -> implementation"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

Test-Script "generate-work removed (no sub-issues or tester issue)" {
  $draft = Join-Path $env:TEMP "fredo-impl-plan.md"
  $planBody = @"
## Title
generate-work removed-path Implementation Plan

## Scope
- [ ] Sub-task 1: Implement widget A
- [ ] Sub-task 2: Wire widget B to the backend

## QA Plan
| Case | Step | Expected |
|------|------|----------|
| A | Run widget A | Renders without error |
"@
  Set-Content -Path $draft -Value $planBody -Encoding UTF8
  $planNum = $null
  try {
    $create = & rust-script $ps --agent self-improver --action create-issue --title "temp: generate-work removed-path" --body-file $draft --issue-type impl-plan 2>&1
    if ($LASTEXITCODE -ne 0) { throw "create-issue (impl-plan) failed: $create" }
    $createStr = if ($create -is [array]) { $create -join "`n" } else { "$create" }
    if ($createStr -notmatch "CREATED:") { throw "Expected CREATED:, got: $createStr" }
    $m = [regex]::Match($createStr, "issues/(\d+)")
    if (-not $m.Success) { throw "Could not parse plan issue number from: $createStr" }
    $planNum = [int]$m.Groups[1].Value

    $out = & rust-script $ps --issue $planNum --agent self-improver --action generate-work 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "GENERATE-WORK REMOVED") { throw "Expected generate-work-removed note, got: $outStr" }
    if ($outStr -match "SUB-ISSUE CREATED|TESTER ISSUE CREATED") { throw "generate-work must not create sub-issues/tester, got: $outStr" }
    # No scratch child issues may exist (sub-issues + tester issue were dropped)
    $refs = @(& gh issue list --state all --search "`"Parent: Implementation Plan #$planNum`"" --json number 2>$null | ConvertFrom-Json | Where-Object { $_.number -ne $planNum })
    if ($refs.Count -ne 0) { throw "generate-work leaked issues: $($refs.Count)" }
    return "generate-work removed: no sub-issues/tester created"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    if ($planNum) {
      $refs = @(& gh issue list --state all --search "`"Parent: Implementation Plan #$planNum`"" --json number 2>$null | ConvertFrom-Json | Where-Object { $_.number -ne $planNum })
      foreach ($r in $refs) { & gh issue close $r.number 2>$null | Out-Null; Remove-Item ".opencode/state/issues/$($r.number).jsonl" -Force -ErrorAction SilentlyContinue }
      & gh issue close $planNum 2>$null | Out-Null; Remove-Item ".opencode/state/issues/$planNum.jsonl" -Force -ErrorAction SilentlyContinue
    }
    $global:LASTEXITCODE = 0
  }
}

# --- Single-writer permissions (opencode.json) ---
Write-Host "Permissions (opencode.json):" -ForegroundColor Cyan

Test-Script "Agent files have no permission frontmatter" {
  $hits = Select-String -Path ".opencode/agents/*.md" -Pattern '^permission:' | Measure-Object
  if ($hits.Count -gt 0) { throw "Agent .md files must NOT declare permission: (opencode.json is the source); found $($hits.Count)" }
  $bashAllow = Select-String -Path ".opencode/agents/*.md" -Pattern '^  bash: allow' | Measure-Object
  if ($bashAllow.Count -gt 0) { throw "Agent .md files must NOT declare bash: allow (overrides opencode.json); found $($bashAllow.Count)" }
  return "agent frontmatter clean"
}

# Embed opencode's wildcard matcher (permission.ts + util/wildcard.ts):
# rules evaluated findLast (last matching rule wins); resource = full command string.
function Get-WildcardEscaped {
  param([string]$Pattern)
  $esc = $Pattern.Replace('\','/') -replace '([.+^${}()|\[\]\\])','\$1' -replace '\*','.*' -replace '\?','.'
  if ($esc.EndsWith(' .*')) { $esc = $esc.Substring(0, $esc.Length - 3) + '( .*)?' }
  return $esc
}
function Test-WildcardMatch {
  param([string]$Command, [string]$Pattern)
  $esc = Get-WildcardEscaped $Pattern
  return [regex]::IsMatch($Command.Replace('\','/'), '^' + $esc + '$')
}
function Get-BashEffect {
  param([string]$Agent, [string]$Command)
  $config = Get-Content "opencode.json" -Raw | ConvertFrom-Json
  $bash = $config.agent.$Agent.permission.bash
  if (-not $bash) { return "deny" }  # no rules = deny in whitelist posture
  $last = $null
  foreach ($p in $bash.PSObject.Properties.Name) {
    if (Test-WildcardMatch $Command $p) { $last = $p }
  }
  if ($null -eq $last) { return "deny" }
  return $bash.$last
}

# Commands every agent must be able to run (single commands)
Test-Script "State machine + reads allowed for all agents" {
  $config = Get-Content "opencode.json" -Raw | ConvertFrom-Json
  $agents = $config.agent.PSObject.Properties.Name
  $failures = @()
  foreach ($agent in $agents) {
    foreach ($cmd in @(
      "rust-script .opencode/scripts/pipeline-state.rs --action comment --issue 5",
      "gh issue view 5"
    )) {
      if ((Get-BashEffect $agent $cmd) -ne "allow") { $failures += "${agent}: '$cmd' not allowed" }
    }
  }
  if ($failures.Count -gt 0) { throw "Access gaps: $($failures -join '; ')" }
  return "state machine + reads allowed for $($agents.Count) agents"
}

# Principle 9 hard gate: every agent must carry permission.skill with the state
# machine allowed and a wildcard deny (no skill may run without an explicit rule).
Test-Script "permission.skill hard-gate (pipeline-state allow, * deny)" {
  $config = Get-Content "opencode.json" -Raw | ConvertFrom-Json
  $agents = $config.agent.PSObject.Properties.Name
  $failures = @()
  foreach ($agent in $agents) {
    $skill = $config.agent.$agent.permission.skill
    if ($null -eq $skill) { $failures += "${agent}: permission.skill missing"; continue }
    if ($skill.'pipeline-state' -ne "allow") { $failures += "${agent}: permission.skill.pipeline-state != allow" }
    if ($skill.'*' -ne "deny") { $failures += "${agent}: permission.skill.* != deny" }
  }
  if ($failures.Count -gt 0) { throw "permission.skill gaps: $($failures -join '; ')" }
  return "permission.skill hard-gate present for $($agents.Count) agents"
}

# Direct write commands must be denied for every agent
Test-Script "Direct GitHub writes denied for all agents" {
  $config = Get-Content "opencode.json" -Raw | ConvertFrom-Json
  $agents = $config.agent.PSObject.Properties.Name
  $writeCmds = @(
    "gh issue edit 5 --add-label blocked",
    "gh issue close 5",
    "gh pr merge 5",
    "gh label create foo --description x",
    "git merge main"
  )
  $failures = @()
  foreach ($agent in $agents) {
    foreach ($cmd in $writeCmds) {
      if ((Get-BashEffect $agent $cmd) -ne "deny") { $failures += "${agent}: '$cmd' NOT denied" }
    }
  }
  if ($failures.Count -gt 0) { throw "Write-denial gaps: $($failures -join '; ')" }
  return "write commands denied for $($agents.Count) agents"
}

# Compound commands that smuggle a write must be denied (the && / | hole)
Test-Script "Compound-command smuggling denied" {
  $config = Get-Content "opencode.json" -Raw | ConvertFrom-Json
  $agents = $config.agent.PSObject.Properties.Name
  $smuggleCmds = @(
    "git status && gh pr merge 5",
    "cargo build && git push origin main",
    "gh issue view 5 | gh issue edit 5"
  )
  $failures = @()
  foreach ($agent in $agents) {
    foreach ($cmd in $smuggleCmds) {
      if ((Get-BashEffect $agent $cmd) -ne "deny") { $failures += "${agent}: '$cmd' NOT denied" }
    }
  }
  if ($failures.Count -gt 0) { throw "Compound-command gaps: $($failures -join '; ')" }
  return "compound smuggling denied for $($agents.Count) agents"
}

# Developer pushes to the spec branch via HEAD:spec/<N>; main/master denied
Test-Script "Developer push scoping (HEAD:spec allowed, main denied)" {
  $ok = (Get-BashEffect "developer" "git push origin HEAD:spec/633") -eq "allow"
  $blockedMain = (Get-BashEffect "developer" "git push origin main") -eq "deny"
  $blockedHead = (Get-BashEffect "developer" "git push origin HEAD:main") -eq "deny"
  if (-not $ok -or -not $blockedMain -or -not $blockedHead) { throw "developer push scoping broken: HEAD:spec-allow=$ok main-deny=$blockedMain HEAD:main-deny=$blockedHead" }
  return "developer push: HEAD:spec allowed, main/HEAD:main denied"
}

# create-branch is removed — worktrees sit directly on the spec branch
Test-Script "create-branch is removed (worktree on spec branch)" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action create-branch 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "unknown action") { throw "Expected 'unknown action' for removed create-branch, got: $outStr" }
  return "create-branch removed"
} -ExpectedExitCode 1

# create-spec-branch / create-pr / merge-pr are now deterministic side-effects of
# transition, so the standalone actions are gone.
Test-Script "Spec lifecycle actions are transition side-effects (removed)" {
  foreach ($action in @("create-spec-branch", "create-pr", "merge-pr")) {
    $out = & rust-script $ps --issue $TestIssue --agent self-improver --action $action --title t --body-file x --pr 1 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "unknown action") { throw "Expected 'unknown action' for $action, got: $outStr" }
  }
  return "spec lifecycle actions removed"
} -ExpectedExitCode 1

# remove-worktree is developer-only
Test-Script "remove-worktree role-gates" {
  $out = & rust-script $ps --issue $TestIssue --agent tester --action remove-worktree --worktree-path "$env:TEMP\fredo-wt-test" 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to remove-worktree") { throw "Expected role-gate block, got: $outStr" }
  return "remove-worktree role-gate verified"
}

# generate-work is removed (any actor gets the removal note; no sub-issues)
Test-Script "generate-work reports removal (no sub-issues)" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action generate-work 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "GENERATE-WORK REMOVED") { throw "Expected GENERATE-WORK REMOVED, got: $outStr" }
  if ($outStr -match "SUB-ISSUE CREATED|TESTER ISSUE CREATED") { throw "must not create sub-issues/tester, got: $outStr" }
  return "generate-work removed note verified"
}

# triage-init is self-improver-only (role gate fires before any file write)
Test-Script "triage-init is self-improver-only" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action triage-init 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to triage-init") { throw "Expected role-gate block, got: $outStr" }
  return "triage-init role-gate verified"
}

# triage-init creates the ephemeral A2A file from the triage-plan template
Test-Script "triage-init creates the A2A file" {
  $url = & gh issue create --title "temp: triage-init" --body "triage-init scratch feature" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $a2a = ".opencode/tmp/$issueNum/triage.md"
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action triage-init 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "triage-init failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "TRIAGE A2A FILE CREATED:") { throw "Expected TRIAGE A2A FILE CREATED:, got: $outStr" }
    if (-not (Test-Path $a2a)) { throw "A2A file not created: $a2a" }
    $content = [System.IO.File]::ReadAllText($a2a)
    if ($content -notmatch "## Discussion") { throw "A2A file missing ## Discussion: $content" }
    if ($content -notmatch "Implementation Plan #$issueNum") { throw "A2A file missing issue substitution: $content" }
    return "triage-init created $a2a"
  } finally {
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# tests-commit is role-gated (self-improver + tester only)
Test-Script "tests-commit is role-gated" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action tests-commit --feature mission-monitor 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to tests-commit") { throw "Expected role-gate block, got: $outStr" }
  return "tests-commit role-gate verified"
}

# tests-commit commits the per-feature suite to main (create + verify + cleanup)
Test-Script "tests-commit commits a feature suite to main" {
  $url = & gh issue create --title "temp: tests-commit" --body "tests-commit scratch feature" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $feat = "scratch-$issueNum"
  $dir = ".opencode/tests/$feat"
  $repo = & gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh repo view failed: $repo" }
  try {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    [System.IO.File]::WriteAllText("$dir/functional.md", "- [ ] F-1: scratch functional case`n", [System.Text.UTF8Encoding]::new($true))
    [System.IO.File]::WriteAllText("$dir/smoke.md", "- [ ] S-1: scratch smoke case`n", [System.Text.UTF8Encoding]::new($true))
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action tests-commit --feature $feat 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "tests-commit failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "TESTS COMMITTED:") { throw "Expected TESTS COMMITTED:, got: $outStr" }
    # Verify via the git tree on origin/main — the Contents API caches reads with a
    # multi-minute lag after a write, so a Contents GET can 404 right after commit.
    & git fetch origin main 2>$null | Out-Null
    $names = & git ls-tree -r --name-only origin/main -- ".opencode/tests/$feat" 2>&1
    $namesStr = if ($names -is [array]) { $names -join "`n" } else { "$names" }
    if ($namesStr -notmatch "functional.md" -or $namesStr -notmatch "smoke.md") { throw "main tree lacks both files: $namesStr" }
    return "tests-commit persisted $feat to main"
  } finally {
    # Resolve SHAs from the git tree (cache-free) so cleanup never misses a delete.
    & git fetch origin main 2>$null | Out-Null
    foreach ($f in @("functional.md", "smoke.md")) {
      $entry = & git ls-tree origin/main -- ".opencode/tests/$feat/$f" 2>&1
      $entryStr = if ($entry -is [array]) { $entry -join " " } else { "$entry" }
      $sha = if ($entryStr -match "blob ([0-9a-f]{40})") { $matches[1] } else { "" }
      if ($sha) {
        & gh api -X DELETE "repos/$repo/contents/.opencode/tests/$feat/$f" -f message="test cleanup" -f sha="$sha" -f branch="main" 2>$null | Out-Null
      }
    }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# update-plan is self-improver-only (role gate fires before any body read/write)
Test-Script "update-plan is self-improver-only" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action update-plan --section software-architect --body-file x 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to update-plan") { throw "Expected role-gate block, got: $outStr" }
  return "update-plan role-gate verified"
}

# update-plan on an issue that has no matching section errors (no GitHub write)
Test-Script "update-plan rejects an issue without the section" {
  $url = & gh issue create --title "temp: update-plan no section" --body "## Some Other Section`ncontent here" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $draft = Join-Path $env:TEMP "fredo-update-plan-draft.md"
  Set-Content -Path $draft -Value "## Domain Model`n(empty)" -Encoding UTF8
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action update-plan --section software-architect --body-file $draft 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -eq 0) { throw "Expected failure, got exit 0" }
    if ($outStr -notmatch "no '## ' section matching") { throw "Expected section-not-found error, got: $outStr" }
    return "update-plan section-not-found verified"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# update-plan positive path: replace the software-architect block, keep the rest
Test-Script "update-plan positive path (replace software-architect section)" {
  $url = & gh issue create --title "temp: update-plan positive" --body "## Software Architect`n### Domain Model`n(empty)`n## Summary`nold summary" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $draft = Join-Path $env:TEMP "fredo-update-plan-new.md"
  Set-Content -Path $draft -Value "- [ ] Sub-task 1: Wire widget A`n- [ ] Sub-task 2: Persist settings to FeatureStore" -Encoding UTF8
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action update-plan --section software-architect --body-file $draft 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "update-plan failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "PLAN UPDATED:") { throw "Expected PLAN UPDATED:, got: $outStr" }
    $body = & gh issue view $issueNum --json body --jq ".body" 2>$null
    $bodyStr = if ($body -is [array]) { $body -join "`n" } else { "$body" }
    if ($bodyStr -notmatch "Wire widget A") { throw "Draft content not found in body: $bodyStr" }
    if ($bodyStr -match "Domain Model") { throw "Old section content should have been replaced: $bodyStr" }
    if ($bodyStr -notmatch "## Summary") { throw "Following section should survive: $bodyStr" }
    return "update-plan replaced software-architect on #$issueNum"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# Triage exit gate: convergence marker required before the plan gate is consulted
Test-Script "Triage exit gate requires convergence marker" {
  $url = & gh issue create --title "temp: triage convergence gate" --label triage-plan --body "scratch feature for convergence gate" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $marker = Join-Path $env:TEMP "fredo-triage-marker.md"
  try {
    # No marker yet → the triage exit guard must block on convergence.
    $before = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $beforeStr = if ($before -is [array]) { $before -join "`n" } else { "$before" }
    if ($beforeStr -notmatch "not converged") { throw "Expected convergence block, got: $beforeStr" }
    # Post the Decision marker that declares triage converged. Written without a
    # UTF-8 BOM so the guard's `## Decision` prefix match sees the heading first.
    [System.IO.File]::WriteAllText($marker, "## Decision`n`nTriage converged — all planner questions resolved.", [System.Text.UTF8Encoding]::new($false))
    gh issue comment $issueNum --body-file $marker 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not post marker comment" }
    $after = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $afterStr = if ($after -is [array]) { $after -join "`n" } else { "$after" }
    if ($afterStr -match "not converged") { throw "Convergence block should clear after marker, got: $afterStr" }
    # The scratch issue was created directly in triage (never passed intake→triage),
    # so the A2A file was never auto-seeded — the transition must refuse to assemble
    # a plan without it.
    if ($afterStr -notmatch "A2A file missing") { throw "Expected A2A-file-missing block after convergence, got: $afterStr" }
    return "triage gate: convergence marker clears, then A2A-file requirement blocks"
  } finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# triage -> implementation auto-assembles the plan, generates work, persists the
# QA-seeded test suites, and creates the spec branch (the former SM's mechanical
# orchestration is now transition side-effects)
Test-Script "triage->implementation auto-assembles plan + work + tests" {
  $intakeBody = @"
## Title
Auto-assembly scratch feature

## Problem / Why now
Scratch feature for the auto-assembly e2e test.

## Intended users
Testers.

## Proposed behavior / Scope
Nothing real — harness only.

## Success metrics
The test passes.

## Acceptance criteria
- [ ] The e2e test completes.

## Out of scope
Production behavior.

## Priority
Low
"@
  $url = & gh issue create --title "temp: auto-assembly" --body $intakeBody 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $feat = "scratch-$issueNum"
  $a2a = ".opencode/tmp/$issueNum/triage.md"
  $testDir = ".opencode/tests/$feat"
  $repo = & gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh repo view failed: $repo" }
  $marker = Join-Path $env:TEMP "fredo-auto-marker.md"
  $closeList = @()
  try {
    # intake -> triage auto-seeds the A2A file; replace it with a converged draft.
    $t1 = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    if ($LASTEXITCODE -ne 0) { throw "intake->triage failed: $t1" }
    if (-not (Test-Path $a2a)) { throw "A2A file not auto-seeded: $a2a" }
    $draft = @(
      "# Implementation Plan #$issueNum - scratch",
      "",
      "## Software Architect",
      "",
      "### Domain Model (file:line)",
      "scratch",
      "",
      "### Requirements",
      "scratch",
      "",
      "### API Contracts & Data Models",
      "scratch",
      "",
      "### Sub-issue Decomposition + Effort Estimates",
      "",
      "- [ ] Sub-task 1: Auto-assembly widget",
      "",
      "## UI/UX Expert",
      "",
      "### Design Assets (or N/A)",
      "N/A",
      "",
      "## QA Expert",
      "",
      "### QA Plan",
      "",
      "| REQ | Test case | Expected | Edge cases |",
      "|-----|-----------|----------|------------|",
      "| REQ-1 | widget renders | visible | none |",
      "",
      "**Feature tests:** $feat",
      "",
      "## Summary",
      "goal + acceptance criteria",
      "",
      "## Staffing Plan",
      "1 developer",
      "",
      "## Deployment Notes",
      "none",
      "",
      "## Risks & Mitigations",
      "none",
      "",
      "## Discussion",
      ""
    ) -join "`n"
    [System.IO.File]::WriteAllText($a2a, $draft, [System.Text.UTF8Encoding]::new($false))

    # QA-seeded test suite (persisted by the transition side-effect)
    New-Item -ItemType Directory -Path $testDir -Force | Out-Null
    [System.IO.File]::WriteAllText("$testDir/functional.md", "- [ ] F-1: auto-assembly functional case`n", [System.Text.UTF8Encoding]::new($true))

    # Convergence marker (the agreement gate)
    [System.IO.File]::WriteAllText($marker, "## Decision`n`nTriage converged - all planner questions resolved.", [System.Text.UTF8Encoding]::new($false))
    & gh issue comment $issueNum --body-file $marker 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not post marker comment" }

    $trans = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $transStr = if ($trans -is [array]) { $trans -join "`n" } else { "$trans" }
    if ($LASTEXITCODE -ne 0) { throw "triage->implementation failed (exit $LASTEXITCODE): $transStr" }
    foreach ($need in @("IMPL PLAN ASSEMBLED:", "SPEC BRANCH CREATED:", "TESTS COMMITTED:")) {
      if ($transStr -notmatch [regex]::Escape($need)) { throw "missing '$need' in output: $transStr" }
    }
    if ($transStr -match "SUB-ISSUE CREATED|TESTER ISSUE CREATED") { throw "no sub-issues/tester may be created: $transStr" }
    $planM = [regex]::Match($transStr, "IMPL PLAN ASSEMBLED: #(\d+)")
    if (-not $planM.Success) { throw "no plan number: $transStr" }
    $planNum = [int]$planM.Groups[1].Value
    $closeList += $planNum
    # Tests persisted to main (verify via the cache-free git tree)
    & git fetch origin main 2>$null | Out-Null
    $treeNames = & git ls-tree -r --name-only origin/main -- ".opencode/tests/$feat" 2>&1
    $treeStr = if ($treeNames -is [array]) { $treeNames -join "`n" } else { "$treeNames" }
    if ($treeStr -notmatch "functional.md") { throw "tests not persisted to main: $treeStr" }
    return "auto-assembled plan #$planNum + tests on main + spec/$issueNum (no sub-issues)"
  } finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    # remove the persisted test folder from main
    & git fetch origin main 2>$null | Out-Null
    foreach ($f in @("functional.md")) {
      $entry = & git ls-tree origin/main -- ".opencode/tests/$feat/$f" 2>&1
      $entryStr = if ($entry -is [array]) { $entry -join " " } else { "$entry" }
      $sha = if ($entryStr -match "blob ([0-9a-f]{40})") { $matches[1] } else { "" }
      if ($sha) { & gh api -X DELETE "repos/$repo/contents/.opencode/tests/$feat/$f" -f message="test cleanup" -f sha="$sha" -f branch="main" 2>$null | Out-Null }
    }
    Remove-Item $testDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    # delete the auto-created spec branch on origin AND prune the stale local
    # remote-tracking ref so audits of `refs/remotes/origin/spec` stay clean
    & gh api -X DELETE "repos/$repo/git/refs/heads/spec/$issueNum" 2>$null | Out-Null
    & git fetch origin --prune 2>$null | Out-Null
    foreach ($n in @($closeList)) {
      if ($n) { & gh issue close $n 2>$null | Out-Null; Remove-Item ".opencode/state/issues/$n.jsonl" -Force -ErrorAction SilentlyContinue }
    }
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# transition is self-improver-only
Test-Script "transition is self-improver-only" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action transition 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to transition") { throw "Expected role-gate block, got: $outStr" }
  return "transition role-gate verified"
}

# Decision comments carry the exit-guard markers — self-improver only
Test-Script "Decision comments are self-improver-only" {
  $url = & gh issue create --title "temp: decision gate" --body "comment gate scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $body = Join-Path $env:TEMP "fredo-decision-body.md"
  try {
    [System.IO.File]::WriteAllText($body, "test", [System.Text.UTF8Encoding]::new($false))
    $out = & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Decision --body-file $body 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "not allowed to post a Decision comment") { throw "Expected Decision block, got: $outStr" }
    $ok = & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Status --body-file $body 2>&1
    $okStr = if ($ok -is [array]) { $ok -join "`n" } else { "$ok" }
    if ($LASTEXITCODE -ne 0) { throw "Status comment should pass for tester: $okStr" }
    return "Decision gated to self-improver; Status open"
  } finally {
    Remove-Item -LiteralPath $body -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# timeline comments: drafts in .opencode/tmp/<issue>/*.md are posted + consumed
Test-Script "timeline comments posted from tmp drafts (post-comments)" {
  $url = & gh issue create --title "temp: timeline comments" --body "timeline scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $dir = ".opencode/tmp/$issueNum"
  try {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    [System.IO.File]::WriteAllText("$dir/po-backlog.md", "As a tester, I can see the PO backlog comment.`n`n*Authored by Product Owner*", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText("$dir/si-summary.md", "Audit verdict: SUCCESS`n`n*Authored by Self-Improver*", [System.Text.UTF8Encoding]::new($false))
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action post-comments 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "post-comments failed: $outStr" }
    if ($outStr -notmatch "COMMENTED: PO Backlog" -or $outStr -notmatch "COMMENTED: SI Summary") { throw "expected both timeline comments, got: $outStr" }
    # drafts consumed (not re-postable)
    if (Test-Path "$dir/po-backlog.md") { throw "draft not consumed" }
    # comments actually on the issue
    $cmts = @(& gh issue view $issueNum --json comments --jq ".comments[].body" 2>$null)
    $joined = $cmts -join "`n"
    if ($joined -notmatch "## PO Backlog" -or $joined -notmatch "## SI Summary") { throw "comments not posted to issue: $joined" }
    return "timeline comments posted + consumed"
  } finally {
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# block/unblock positive + missing --reason rejected
Test-Script "block/unblock positive + missing reason" {
  $url = & gh issue create --title "temp: block unblock" --body "block scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action block --reason "test blocker" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "block failed: $outStr" }
    $labels = @(& gh issue view $issueNum --json labels --jq ".labels[].name" 2>$null)
    if ($labels -notcontains "blocked") { throw "Expected blocked label, got: $labels" }
    $out2 = & rust-script $ps --issue $issueNum --agent self-improver --action unblock 2>&1
    if ($LASTEXITCODE -ne 0) { throw "unblock failed: $out2" }
    $labels2 = @(& gh issue view $issueNum --json labels --jq ".labels[].name" 2>$null)
    if ($labels2 -contains "blocked") { throw "blocked label should be removed, got: $labels2" }
    $out3 = & rust-script $ps --issue $issueNum --agent self-improver --action block 2>&1
    if ($LASTEXITCODE -eq 0) { throw "block without --reason should fail" }
    $global:LASTEXITCODE = 0
    return "block/unblock positive + missing reason rejected"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# close-issue positive (cancel) + done-from-non-audit block
Test-Script "close-issue positive (cancel) + done gate" {
  $url = & gh issue create --title "temp: close cancel" --body "close scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action close-issue --to-phase canceled 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "close-issue failed: $outStr" }
    $state = & gh issue view $issueNum --json state --jq .state 2>$null
    if ($state -ne "CLOSED") { throw "Expected CLOSED, got: $state" }
    return "close-issue canceled positive"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# audit-record rejects a legal restart on a non-audit issue (no mutation)
Test-Script "audit-record rejects legal restart on non-audit issue" {
  $url = & gh issue create --title "temp: audit-record non-audit" --body "not in audit phase" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action audit-record --verdict restart --phase implementation --reason "test" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "requires the issue to be in the audit phase") { throw "Expected audit-phase guard, got: $outStr" }
    return "audit-record non-audit guard verified"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# verify exits 3 on a tampered record
Test-Script "verify detects a tampered record (exit 3)" {
  $url = & gh issue create --title "temp: verify tamper" --body "tamper scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $log = ".opencode/state/issues/$issueNum.jsonl"
  try {
    & rust-script $ps --issue $issueNum --agent tester 2>$null | Out-Null
    if (-not (Test-Path $log)) { throw "jsonl not created for scratch issue" }
    [System.IO.File]::AppendAllText($log, '{"ts":"2000-01-01T00:00:00Z","event_id":"tamper-1","event_name":"state_machine.call","actor":"tester","phase":"intake","outcome":"unknown"}', [System.Text.Encoding]::ASCII)
    & rust-script $ps --action verify 2>&1 | Out-String | Set-Variable verifyOut
    if ($LASTEXITCODE -ne 3) { throw "Expected exit 3 for tamper, got $LASTEXITCODE : $verifyOut" }
    $global:LASTEXITCODE = 0
    return "verify tamper detected (exit 3)"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item $log -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# implementation -> testing requires the spec branch to have commits (real gate)
Test-Script "implementation exit gate requires spec commits" {
  $intakeBody = @"
## Title
Implementation gate scratch

## Problem / Why now
Scratch feature for the implementation exit gate e2e test.

## Intended users
Testers.

## Proposed behavior / Scope
Nothing real — harness only.

## Success metrics
The test passes.

## Acceptance criteria
- [ ] The e2e test completes.

## Out of scope
Production behavior.

## Priority
Low
"@
  $url = & gh issue create --title "temp: impl gate" --body $intakeBody 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $a2a = ".opencode/tmp/$issueNum/triage.md"
  $repo = & gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1
  $marker = Join-Path $env:TEMP "fredo-impl-gate-marker.md"
  $closeList = @()
  $prNum = $null
  try {
    & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "intake->triage failed" }
    $draft = @(
      "# Implementation Plan #$issueNum - scratch",
      "", "## Software Architect", "", "### Domain Model (file:line)", "scratch",
      "", "### Requirements", "scratch",
      "", "### API Contracts & Data Models", "scratch",
      "", "### Sub-issue Decomposition + Effort Estimates", "",
      "- [ ] Sub-task 1: Gate widget",
      "", "## UI/UX Expert", "", "### Design Assets (or N/A)", "N/A",
      "", "## QA Expert", "", "### QA Plan", "",
      "| REQ | Test case | Expected | Edge cases |", "|-----|-----------|----------|------------|",
      "| REQ-1 | widget | pass | none |",
      "", "## Summary", "goal",
      "", "## Staffing Plan", "1 developer",
      "", "## Deployment Notes", "none",
      "", "## Risks & Mitigations", "none",
      "", "## Discussion", ""
    ) -join "`n"
    [System.IO.File]::WriteAllText($a2a, $draft, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($marker, "## Decision`n`nTriage converged - all planner questions resolved.", [System.Text.UTF8Encoding]::new($false))
    & gh issue comment $issueNum --body-file $marker 2>$null | Out-Null
    $t = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $tStr = if ($t -is [array]) { $t -join "`n" } else { "$t" }
    if ($LASTEXITCODE -ne 0) { throw "triage->implementation failed: $tStr" }
    $planM = [regex]::Match($tStr, "IMPL PLAN ASSEMBLED: #(\d+)")
    if (-not $planM.Success) { throw "no plan number: $tStr" }
    $planNum = [int]$planM.Groups[1].Value
    $closeList += $planNum

    # gate must block while the spec branch has NO commits (developer hasn't pushed)
    $b = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $bStr = if ($b -is [array]) { $b -join "`n" } else { "$b" }
    if ($bStr -notmatch "no commits beyond main") { throw "Expected no-commits block, got: $bStr" }

    # Push a trivial commit to the spec branch (the developer's push) -> gate clears.
    # The marker must live OUTSIDE `.opencode/tmp` (gitignored) or `git add` is a no-op.
    $specMarker = "spec-gate-marker-$issueNum.txt"
    [System.IO.File]::WriteAllText($specMarker, "gate test marker", [System.Text.UTF8Encoding]::new($false))
    & git fetch origin "spec/$issueNum" 2>$null | Out-Null
    & git checkout -b "spec/$issueNum" "origin/spec/$issueNum" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { & git checkout "spec/$issueNum" 2>&1 | Out-Null }
    & git add $specMarker 2>&1 | Out-Null
    & git commit -m "test: spec gate marker" 2>&1 | Out-Null
    & git push origin "HEAD:spec/$issueNum" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "spec branch push failed" }
    & git checkout main 2>&1 | Out-Null
    Remove-Item $specMarker -Force -ErrorAction SilentlyContinue
    $p = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $pStr = if ($p -is [array]) { $p -join "`n" } else { "$p" }
    if ($LASTEXITCODE -ne 0) { throw "implementation->testing should pass: $pStr" }
    if ($pStr -notmatch "TRANSITIONED:") { throw "Expected transition, got: $pStr" }
    # Guardrail (Spec #1499 false-PASS): a STATIC-only Evidence comment (no
    # telemetry_spans reference) must BLOCK testing -> audit for a live-policy plan.
    $evBody = Join-Path $env:TEMP "fredo-impl-gate-evidence.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: PASS (static source analysis, no live run)", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $planNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    $g = & rust-script $ps --issue $issueNum --agent self-improver --action transition --to-phase audit 2>&1
    $gStr = if ($g -is [array]) { $g -join "`n" } else { "$g" }
    if ($gStr -notmatch "static-only") { throw "Expected static-only block, got: $gStr" }
    # A FAIL verdict WITH a telemetry_spans token must STILL block (not PASS).
    $evFail = Join-Path $env:TEMP "fredo-impl-gate-evidence-fail.md"
    [System.IO.File]::WriteAllText($evFail, "Verdict: FAIL`nSELECT ... FROM telemetry_spans ... rows=0", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $planNum --agent tester --action comment --prefix Evidence --body-file $evFail 2>&1 | Out-Null
    Remove-Item $evFail -Force -ErrorAction SilentlyContinue
    $h = & rust-script $ps --issue $issueNum --agent self-improver --action transition --to-phase audit 2>&1
    $hStr = if ($h -is [array]) { $h -join "`n" } else { "$h" }
    if ($hStr -notmatch "not PASS") { throw "Expected FAIL-verdict block, got: $hStr" }
    # The exact #1499 vector: a VALID live PASS, then a newer FAIL — the newer FAIL
    # must still block (latest-comment-only). A stale valid PASS must never mask a FAIL.
    # (No intermediate successful transition: that would squash-merge the scratch PR.)
    $evPass = Join-Path $env:TEMP "fredo-impl-gate-evidence-pass.md"
    [System.IO.File]::WriteAllText($evPass, "Verdict: PASS`nSELECT span_name FROM telemetry_spans WHERE ... rows=1", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $planNum --agent tester --action comment --prefix Evidence --body-file $evPass 2>&1 | Out-Null
    Remove-Item $evPass -Force -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText($evFail, "Verdict: FAIL`nSELECT ... FROM telemetry_spans ... rows=0", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $planNum --agent tester --action comment --prefix Evidence --body-file $evFail 2>&1 | Out-Null
    Remove-Item $evFail -Force -ErrorAction SilentlyContinue
    $j = & rust-script $ps --issue $issueNum --agent self-improver --action transition --to-phase audit 2>&1
    $jStr = if ($j -is [array]) { $j -join "`n" } else { "$j" }
    if ($jStr -notmatch "not PASS") { throw "Newer FAIL must block despite earlier valid PASS, got: $jStr" }
    return "impl gate + verification guardrail: no-commits, static-only, FAIL, valid-PASS-then-FAIL"
  } finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    $openPr = & gh pr list --head "spec/$issueNum" --state open --json number 2>$null | ConvertFrom-Json
    if ($openPr) { & gh pr close $openPr[0].number --delete-branch 2>$null | Out-Null }
    & gh api -X DELETE "repos/$repo/git/refs/heads/spec/$issueNum" 2>$null | Out-Null
    & git fetch origin --prune 2>$null | Out-Null
    foreach ($n in @($closeList)) { if ($n) { & gh issue close $n 2>$null | Out-Null; Remove-Item ".opencode/state/issues/$n.jsonl" -Force -ErrorAction SilentlyContinue } }
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# intake exit gate requires the required sections (via transition)
Test-Script "intake exit gate requires the required sections" {
  $url = & gh issue create --title "temp: intake sections" --body "no sections here" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "missing required section") { throw "Expected sections block, got: $outStr" }
    return "intake gate: missing sections block"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# transition --to-phase done is refused (done only via audit-record)
Test-Script "transition --to-phase done is refused" {
  $url = & gh issue create --title "temp: transition done" --label audit --body "scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action transition --to-phase done 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -match "TRANSITIONED:") { throw "should not transition to done, got: $outStr" }
    if ($outStr -notmatch "illegal transition|transition to done is not allowed") { throw "Expected a done-block, got: $outStr" }
    return "transition to done refused"
  } finally {
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# Evidence comments carry the testing verdict — tester/self-improver only
Test-Script "Evidence comments are tester/self-improver-only" {
  $url = & gh issue create --title "temp: evidence gate" --body "comment gate scratch" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $body = Join-Path $env:TEMP "fredo-evidence-body.md"
  try {
    [System.IO.File]::WriteAllText($body, "PASS", [System.Text.UTF8Encoding]::new($false))
    $out = & rust-script $ps --issue $issueNum --agent developer --action comment --prefix Evidence --body-file $body 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "not allowed to post a Evidence comment") { throw "Expected Evidence block for developer, got: $outStr" }
    $ok = & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $body 2>&1
    if ($LASTEXITCODE -ne 0) { throw "tester should post Evidence: $ok" }
    return "Evidence gated to tester/self-improver"
  } finally {
    Remove-Item -LiteralPath $body -Force -ErrorAction SilentlyContinue
    & gh issue close $issueNum 2>$null | Out-Null
    Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
  }
}

# --- Remaining PowerShell scripts (syntax check) ---
Write-Host "Other scripts:" -ForegroundColor Cyan
$scripts = @(
  "dev-env.ps1",
  "pre-commit.ps1"
)

foreach ($script in $scripts) {
  $path = ".opencode/scripts/$script"
  Test-Script-Syntax $script $path
}

# --- Skill loader present ---
Write-Host "Skills:" -ForegroundColor Cyan

Test-Script-Syntax "pipeline-state skill" ".opencode/skills/pipeline-state/SKILL.md"

# --- Summary ---
Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
Write-Host "Total:  $tests"
Write-Host "Passed: $passed" -ForegroundColor Green
if ($failed -gt 0) { Write-Host "Failed: $failed" -ForegroundColor Red }
if ($skipped -gt 0) { Write-Host "Skipped: $skipped" -ForegroundColor DarkGray }
Write-Host ""

if ($failed -gt 0) {
  Write-Host "Failures:" -ForegroundColor Red
  foreach ($r in ($results | Where-Object { $_.Status -eq "FAIL" })) {
    Write-Host "  $($r.Name): $($r.Detail)" -ForegroundColor Red
  }
}

if ($failed -eq 0) {
  Write-Host "All pipeline scripts validated." -ForegroundColor Green
  exit 0
} else {
  exit 1
}


