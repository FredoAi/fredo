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
  $output = & rust-script $ps --action prune 2>&1
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
  if ($outStr -notmatch "cannot resolve parent spec") { throw "Expected parent-resolution failure, got: $outStr" }
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
    $create = & rust-script $ps --agent scrum-master --action create-issue --title "temp: transition positive-path" --body-file $draft --issue-type backlog 2>&1
    if ($LASTEXITCODE -ne 0) { throw "create-issue failed: $create" }
    $createStr = if ($create -is [array]) { $create -join "`n" } else { "$create" }
    if ($createStr -notmatch "CREATED:") { throw "Expected CREATED:, got: $createStr" }
    $m = [regex]::Match($createStr, "issues/(\d+)")
    if (-not $m.Success) { throw "Could not parse issue number from: $createStr" }
    $issueNum = [int]$m.Groups[1].Value

    $trans = & rust-script $ps --issue $issueNum --agent scrum-master --action transition 2>&1
    $transStr = if ($trans -is [array]) { $trans -join "`n" } else { "$trans" }
    if ($LASTEXITCODE -ne 0) { throw "transition failed (exit $LASTEXITCODE): $transStr" }
    if ($transStr -notmatch "TRANSITIONED:") { throw "Expected TRANSITIONED:, got: $transStr" }
    $labels = @(& gh issue view $issueNum --json labels --jq ".labels[].name" 2>$null)
    if ($labels -notcontains "triage-plan") { throw "Expected triage-plan label after transition, got: $labels" }
    return "transitioned #$issueNum intake -> triage (triage-plan)"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    if ($issueNum) { & gh issue close $issueNum 2>$null | Out-Null; Remove-Item ".opencode/state/issues/$issueNum.jsonl" -Force -ErrorAction SilentlyContinue }
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

Test-Script "generate-work positive path (plan -> sub-issues + tester)" {
  $draft = Join-Path $env:TEMP "fredo-impl-plan.md"
  $planBody = @"
## Title
generate-work positive-path Implementation Plan

## Scope
- [ ] Sub-task 1: Implement widget A
- [ ] Sub-task 2: Wire widget B to the backend
- [ ] Sub-task 3: Persist settings to FeatureStore

## QA Plan
| Case | Step | Expected |
|------|------|----------|
| A | Run widget A | Renders without error |
| B | Toggle widget B | State persists |
"@
  Set-Content -Path $draft -Value $planBody -Encoding UTF8
  $planNum = $null
  $children = @()
  try {
    $create = & rust-script $ps --agent scrum-master --action create-issue --title "temp: generate-work positive-path" --body-file $draft --issue-type impl-plan 2>&1
    if ($LASTEXITCODE -ne 0) { throw "create-issue (impl-plan) failed: $create" }
    $createStr = if ($create -is [array]) { $create -join "`n" } else { "$create" }
    if ($createStr -notmatch "CREATED:") { throw "Expected CREATED:, got: $createStr" }
    $m = [regex]::Match($createStr, "issues/(\d+)")
    if (-not $m.Success) { throw "Could not parse plan issue number from: $createStr" }
    $planNum = [int]$m.Groups[1].Value

    $out = & rust-script $ps --issue $planNum --agent scrum-master --action generate-work 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "generate-work failed (exit $LASTEXITCODE): $outStr" }
    $subCount = ([regex]::Matches($outStr, "SUB-ISSUE CREATED:")).Count
    $testerCount = ([regex]::Matches($outStr, "TESTER ISSUE CREATED:")).Count
    if ($subCount -lt 2) { throw "Expected >=2 SUB-ISSUE CREATED:, got ${subCount}: $outStr" }
    if ($testerCount -ne 1) { throw "Expected exactly 1 TESTER ISSUE CREATED:, got ${testerCount}: $outStr" }
    foreach ($line in ($outStr -split "`n")) {
      if ($line -match "SUB-ISSUE CREATED:.*issues/(\d+)") { $children += [int]$Matches[1] }
      if ($line -match "TESTER ISSUE CREATED:.*issues/(\d+)") { $children += [int]$Matches[1] }
    }
    return "generate-work created $subCount sub-issue(s) + tester for plan #$planNum"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    foreach ($c in $children) { & gh issue close $c 2>$null | Out-Null; Remove-Item ".opencode/state/issues/$c.jsonl" -Force -ErrorAction SilentlyContinue }
    # Robust cleanup: also close any open issue referencing this plan (covers
    # output-parse misses) so generate-work tests can never leak scratch issues.
    if ($planNum) {
      $refs = @(& gh issue list --state open --search "Parent: Implementation Plan #$planNum" --json number 2>$null | ConvertFrom-Json)
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
    $out = & rust-script $ps --issue $TestIssue --agent scrum-master --action $action --title t --body-file x --pr 1 2>&1
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

# generate-work is scrum-master-only
Test-Script "generate-work is scrum-master-only" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action generate-work 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to generate-work") { throw "Expected role-gate block, got: $outStr" }
  return "generate-work role-gate verified"
}

# generate-work requires a plan with checkbox sub-tasks (issue 633 has none)
Test-Script "generate-work rejects a plan with no sub-tasks" {
  $out = & rust-script $ps --issue $TestIssue --agent scrum-master --action generate-work 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($LASTEXITCODE -eq 0) { throw "Expected failure, got exit 0" }
  if ($outStr -notmatch "no sub-tasks found") { throw "Expected 'no sub-tasks found', got: $outStr" }
  return "generate-work validation verified"
} -ExpectedExitCode 1

# triage-init is scrum-master-only (role gate fires before any file write)
Test-Script "triage-init is scrum-master-only" {
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
    $out = & rust-script $ps --issue $issueNum --agent scrum-master --action triage-init 2>&1
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

# tests-commit is role-gated (scrum-master + tester only)
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
    $out = & rust-script $ps --issue $issueNum --agent scrum-master --action tests-commit --feature $feat 2>&1
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

# update-plan is scrum-master-only (role gate fires before any body read/write)
Test-Script "update-plan is scrum-master-only" {
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
    $out = & rust-script $ps --issue $issueNum --agent scrum-master --action update-plan --section software-architect --body-file $draft 2>&1
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
    $out = & rust-script $ps --issue $issueNum --agent scrum-master --action update-plan --section software-architect --body-file $draft 2>&1
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
    $before = & rust-script $ps --issue $issueNum --agent scrum-master --action transition 2>&1
    $beforeStr = if ($before -is [array]) { $before -join "`n" } else { "$before" }
    if ($beforeStr -notmatch "not converged") { throw "Expected convergence block, got: $beforeStr" }
    # Post the Decision marker that declares triage converged. Written without a
    # UTF-8 BOM so the guard's `## Decision` prefix match sees the heading first.
    [System.IO.File]::WriteAllText($marker, "## Decision`n`nTriage converged — all planner questions resolved.", [System.Text.UTF8Encoding]::new($false))
    gh issue comment $issueNum --body-file $marker 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not post marker comment" }
    $after = & rust-script $ps --issue $issueNum --agent scrum-master --action transition 2>&1
    $afterStr = if ($after -is [array]) { $after -join "`n" } else { "$after" }
    if ($afterStr -match "not converged") { throw "Convergence block should clear after marker, got: $afterStr" }
    if ($afterStr -notmatch "no Implementation Plan") { throw "Expected plan-missing block after convergence, got: $afterStr" }
    return "triage gate: convergence marker then plan gate"
  } finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
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


