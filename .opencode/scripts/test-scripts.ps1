param(
  [string]$TestIssue = "633"
)

# Offline mock mode: the whole harness runs against a local mock repo
# (FREDO_MOCK_GH=1) so the ~19 scratch issues / PRs / spec-branch pushes per run
# never touch the real GitHub. All `gh`/`git` interactions go through the helpers
# below, which read/write the same JSON store the state machine uses.
$env:FREDO_MOCK_GH = "1"
$env:FREDO_MOCK_STORE = Join-Path $env:TEMP ("fredo-mock-repo-" + [Guid]::NewGuid().ToString("N"))
$env:FREDO_MOCK_REPO = "fredo/mock"
New-Item -ItemType Directory -Path $env:FREDO_MOCK_STORE -Force | Out-Null

# gh-shaped helpers that hit the mock store (never the real GitHub). The store is
# plain JSON files under $env:FREDO_MOCK_STORE, so the harness reads/writes them
# directly (no gh subprocess, no quoting issues).
function Mock-StorePath([string]$Relative) {
  return Join-Path $env:FREDO_MOCK_STORE $Relative
}
function Mock-NextIssue {
  $counters = Mock-StorePath "counters.json"
  $c = if (Test-Path $counters) { Get-Content $counters -Raw | ConvertFrom-Json } else { $null }
  $next = if ($c -and $c.issue) { [int]$c.issue + 1 } else { 1 }
  if (-not $c) { $c = @{} }
  $c | Add-Member -NotePropertyName issue -NotePropertyValue $next -Force
  [System.IO.File]::WriteAllText($counters, ($c | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
  return $next
}
function Mock-IssueCreate([string]$Title, [string]$Body, [string]$Label) {
  $n = Mock-NextIssue
  # NB: PS 5.1 ConvertTo-Json collapses a single-element array into a bare object.
  # Use the unary comma to force a real JSON array so Rust parses `labels` as a list.
  $labels = if ([string]::IsNullOrEmpty($Label)) { @() } else { ,@(@{ name = $Label }) }
  $issue = @{
    number = $n
    title = $Title
    body = $Body
    state = "OPEN"
    labels = $labels
    comments = @()
  } | ConvertTo-Json -Depth 6
  $dir = Mock-StorePath "issues"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  # BOM-free write: Rust's serde_json does not strip a UTF-8 BOM, so Set-Content
  # -Encoding UTF8 (PS5.1 writes a BOM) would make the store unparseable.
  [System.IO.File]::WriteAllText((Join-Path $dir "$n.json"), $issue, [System.Text.UTF8Encoding]::new($false))
  return "https://github.com/fredo/mock/issues/$n"
}
function Mock-IssueState([int]$IssueNum) {
  $f = Mock-StorePath "issues\$IssueNum.json"
  if (-not (Test-Path $f)) { return @{ State = "OPEN"; Labels = @() } }
  $p = Get-Content $f -Raw | ConvertFrom-Json
  return @{ State = $p.state; Labels = @($p.labels | ForEach-Object { $_.name }) }
}
function Mock-IssueComments([int]$IssueNum) {
  $f = Mock-StorePath "issues\$IssueNum.json"
  if (-not (Test-Path $f)) { return @() }
  $p = Get-Content $f -Raw | ConvertFrom-Json
  return @($p.comments | ForEach-Object { $_.body })
}
function Mock-IssueBody([int]$IssueNum) {
  $f = Mock-StorePath "issues\$IssueNum.json"
  if (-not (Test-Path $f)) { return "" }
  $p = Get-Content $f -Raw | ConvertFrom-Json
  return $p.body
}
function Mock-IssueClose([int]$IssueNum) {
  $f = Mock-StorePath "issues\$IssueNum.json"
  if (Test-Path $f) {
    $p = Get-Content $f -Raw | ConvertFrom-Json
    $p.state = "CLOSED"
    [System.IO.File]::WriteAllText($f, ($p | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
  }
}
function Mock-PrList([string]$Head, [string]$State) {
  $dir = Mock-StorePath "prs"
  $out = @()
  if (Test-Path $dir) {
    foreach ($f in Get-ChildItem $dir -Filter *.json -ErrorAction SilentlyContinue) {
      $p = Get-Content $f.FullName -Raw | ConvertFrom-Json
      $stateOk = if ($State -eq "merged") { $p.state -eq "MERGED" } else { $p.state -eq "OPEN" }
      if ($p.head -eq $Head -and $stateOk) { $out += $p.number }
    }
  }
  return $out
}
function Mock-RepoView() {
  return "fredo/mock"
}
function Mock-Cleanup([int]$IssueNum) {
  # Best-effort removal of the scratch issue's mock + state records.
  Mock-IssueClose $IssueNum 2>$null | Out-Null
  Remove-Item (Mock-StorePath "issues\$IssueNum.json") -Force -ErrorAction SilentlyContinue
  Remove-Item ".opencode/state/issues/$IssueNum.jsonl" -Force -ErrorAction SilentlyContinue
}

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

# Retry state: the context block must surface attempt/retry derived from the event
# log (failed audit verdicts) so agents know they are completing missed ACs, not
# re-doing the feature. Round 1 on first pass; round N + reason after a restart.
Test-Script "Context block surfaces retry state (round + reason)" {
  $url = Mock-IssueCreate "temp: retry state" "retry-state scratch" "audit"
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $log = ".opencode/state/issues/$issueNum.jsonl"
  try {
    # Fresh issue: first pass (round 1), no retry marker.
    $out1 = & rust-script $ps --issue $issueNum --agent tester 2>&1
    $out1Str = if ($out1 -is [array]) { $out1 -join "`n" } else { "$out1" }
    if ($out1Str -notmatch "Attempt:\s+round 1") { throw "Expected round 1 on first pass, got: $out1Str" }
    if ($out1Str -match "RETRY") { throw "Should not be a retry on first pass, got: $out1Str" }
    # Simulate a failed audit verdict (the state machine records this on a restart).
    if (-not (Test-Path $log)) { throw "jsonl not created for scratch issue" }
    $verdict = '{"ts":"2026-08-09T00:00:00Z","event_id":"v1","event_name":"audit.verdict","actor":"self-improver","entity":{"issueId":"%N%"},"phase":"audit","outcome":"failed","message":"missed AC-2 observable"}'
    [System.IO.File]::AppendAllText($log, $verdict.Replace("%N%", $issueNum) + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
    # After the failed verdict: round 2, retry marker, reason surfaced.
    $out2 = & rust-script $ps --issue $issueNum --agent tester 2>&1
    $out2Str = if ($out2 -is [array]) { $out2 -join "`n" } else { "$out2" }
    if ($out2Str -notmatch "Attempt:\s+round 2 \(RETRY") { throw "Expected round 2 RETRY marker, got: $out2Str" }
    if ($out2Str -notmatch "Retry reason:\s+missed AC-2 observable") { throw "Expected retry reason surfaced, got: $out2Str" }
    return "retry state: round 1 → round 2 + reason after failed audit verdict"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# Round-aware verification guard: a retry round is only satisfied by evidence
# carrying the CURRENT round. A stale round-1 PASS must never clear a round-2
# audit — the round is stamped on the restart Decision comment AND enforced by
# verification_status (round-1 evidence on a round-2 issue fails closed).
Test-Script "Round-aware verification: round-1 PASS cannot clear round-2 audit" {
  $url = Mock-IssueCreate "temp: round-aware verify" "round-aware scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $log = ".opencode/state/issues/$issueNum.jsonl"
  try {
    # Post round-1 PASS evidence (no round tag → round 1) before the failed verdict.
    $ev = Join-Path $env:TEMP "fredo-round-evidence.md"
    [System.IO.File]::WriteAllText($ev, "## Tests Runs (round 1)`nVerdict: PASS`nSELECT ... FROM telemetry_spans ... rows=1", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --body-file $ev 2>&1 | Out-Null
    Remove-Item $ev -Force -ErrorAction SilentlyContinue
    # Simulate a failed audit verdict → issue is now on round 2.
    $verdict = '{"ts":"2026-08-09T00:00:00Z","event_id":"v2","event_name":"audit.verdict","actor":"self-improver","entity":{"issueId":"%N%"},"phase":"audit","outcome":"failed","message":"missed AC-3"}'
    [System.IO.File]::AppendAllText($log, $verdict.Replace("%N%", $issueNum) + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
    # The round-1 PASS is the LATEST evidence but the issue is round 2 — verification
    # must fail closed (static+live PASS but wrong round).
    $audit = & rust-script $ps --action audit --issue $issueNum 2>&1
    $auditStr = if ($audit -is [array]) { $audit -join "`n" } else { "$audit" }
    if ($auditStr -notmatch "Round: 2") { throw "audit should surface round 2, got: $auditStr" }
    # audit-record --verdict success must be blocked (verification not OK).
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action audit-record --verdict success --reason "x" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "cannot record success") { throw "round-1 evidence must not clear round-2 audit, got: $outStr" }
    return "round-aware guard: round-1 PASS blocked on round-2 audit"
  } finally {
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# record-improvement: the SI records an on-the-go pipeline improvement — posts a
# ## Pipeline Improvement (round N) comment, records a pipeline.improvement event,
# and persists a guardrail to references.md. Gated to self-improver.
Test-Script "record-improvement posts comment + event + guardrail" {
  $url = Mock-IssueCreate "temp: record-improvement" "improvement scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $log = ".opencode/state/issues/$issueNum.jsonl"
  $refs = "docs/agentic-pipeline/playbooks/references.md"
  $before = (Select-String -Path $refs -Pattern '^### G-' -ErrorAction SilentlyContinue | Measure-Object).Count
  try {
    # role-gate: developer cannot record-improvement
    $dev = & rust-script $ps --issue $issueNum --agent developer --action record-improvement --reason "x" 2>&1
    $devStr = if ($dev -is [array]) { $dev -join "`n" } else { "$dev" }
    if ($devStr -notmatch "not allowed to record-improvement") { throw "Expected role-gate block, got: $devStr" }
    # missing --reason rejected
    $noReason = & rust-script $ps --issue $issueNum --agent self-improver --action record-improvement 2>&1
    if ($LASTEXITCODE -eq 0) { throw "record-improvement without --reason should fail" }
    $global:LASTEXITCODE = 0
    # positive path
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action record-improvement --reason "G-test: sandbox gap fixed" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($outStr -notmatch "IMPROVEMENT COMMENTED: round 1") { throw "Expected improvement comment, got: $outStr" }
    if ($outStr -notmatch "GUARDRAIL PERSISTED: G-") { throw "Expected guardrail persist, got: $outStr" }
    # comment landed on the issue
    $cmts = Mock-IssueComments $issueNum
    $joined = $cmts -join "`n"
    if ($joined -notmatch "## Pipeline Improvement \(round 1\)") { throw "Improvement comment not posted, got: $joined" }
    # pipeline.improvement event recorded
    $ev = Select-String -Path $log -Pattern 'pipeline.improvement' -ErrorAction SilentlyContinue | Measure-Object
    if ($ev.Count -lt 1) { throw "pipeline.improvement event not recorded in $log" }
    # guardrail appended to references.md
    $after = (Select-String -Path $refs -Pattern '^### G-' -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($after -le $before) { throw "guardrail not appended to references.md (before=$before after=$after)" }
    return "record-improvement: comment + event + guardrail verified"
  } finally {
    # remove the test guardrail appended to references.md (restore prior count)
    $refsText = Get-Content $refs -Raw
    $refsText = $refsText -replace '(?m)^### G-\d+: on_the_go_improvement\r?\n(?:- \*\*[^*]+\*\*.*\r?\n)+\r?\n?', ''
    [System.IO.File]::WriteAllText($refs, $refsText, [System.Text.UTF8Encoding]::new($false))
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
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
  foreach ($f in @("Evidence on plan", "Spec PR merged", "Verification OK")) {
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
A scratch issue is created and transitioned from backlog to planning, then closed.

## Success metrics
The scratch issue reaches the planning label.

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
    $st = Mock-IssueState $issueNum
    if ($st.Labels -notcontains "planning") { throw "Expected planning label after transition, got: $($st.Labels)" }
    # backlog -> planning auto-seeds the A2A deliberation file (was the SM's triage-init).
    $a2a = ".opencode/tmp/$issueNum/triage.md"
    if (-not (Test-Path $a2a)) { throw "A2A file not auto-seeded: $a2a" }
    $a2aContent = [System.IO.File]::ReadAllText($a2a)
    if ($a2aContent -notmatch "## Discussion") { throw "A2A file missing ## Discussion: $a2aContent" }
    return "transitioned #$issueNum backlog -> planning (planning; A2A auto-seeded)"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    if ($issueNum) { Mock-Cleanup $issueNum; Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue }
    $global:LASTEXITCODE = 0
  }
}

Test-Script "audit-record success -> cleanup, then close-issue -> done" {
  $url = Mock-IssueCreate "temp: audit-record success" "Positive-path audit scratch" "audit"
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    # The verification guardrail requires a PASS Evidence comment (with a live
    # telemetry_spans reference) before audit-record can pass a feature.
    $evBody = Join-Path $env:TEMP "fredo-ar-success-evidence.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: PASS`nSELECT ... FROM telemetry_spans ... rows=1", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action audit-record --verdict success --reason "ok" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "audit-record failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "AUDIT PASS -> CLEANUP") { throw "Expected AUDIT PASS -> CLEANUP, got: $outStr" }
    # After audit success, the issue is OPEN in the cleanup phase (teardown pending).
    $st = Mock-IssueState $issueNum
    if ($st.State -ne "OPEN") { throw "Expected OPEN in cleanup, got state $($st.State)" }
    if ($st.Labels -notcontains "cleanup") { throw "Expected cleanup label, got: $($st.Labels)" }
    # The SI runs teardown, then labels the issue done from cleanup (human closes).
    $close = & rust-script $ps --issue $issueNum --agent self-improver --action close-issue --to-phase done 2>&1
    $closeStr = if ($close -is [array]) { $close -join "`n" } else { "$close" }
    if ($closeStr -notmatch "labeled done") { throw "Expected labeled-done, got: $closeStr" }
    $st2 = Mock-IssueState $issueNum
    if ($st2.State -ne "OPEN") { throw "Expected OPEN (human closes manually), got state $($st2.State)" }
    if ($st2.Labels -notcontains "done") { throw "Expected done label, got: $($st2.Labels)" }
    return "audit-record success -> cleanup -> labeled done (open, human closes) (#$issueNum)"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# audit-record --verdict success fails CLOSED when verification is not OK
# (no valid Evidence) — the #1499 false-PASS enforcement.
Test-Script "audit-record success blocked without valid verification" {
  $url = Mock-IssueCreate "temp: audit-record fail-closed" "fail-closed scratch" "audit"
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
    $st = Mock-IssueState $issueNum
    if ($st.State -ne "OPEN") { throw "issue must stay OPEN after blocked audit-record, got $($st.State)" }
    return "audit-record fail-closed: static-only evidence blocked"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

Test-Script "audit-record restart positive path (audit -> implementation)" {
  $url = Mock-IssueCreate "temp: audit-record restart" "Positive-path audit restart scratch" "audit"
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
    $st = Mock-IssueState $issueNum
    if ($st.Labels -notcontains "ready-for-dev") { throw "Expected ready-for-dev label after restart, got: $($st.Labels)" }
    return "audit-record restart moved #$issueNum audit -> implementation"
  } finally {
    Mock-Cleanup $issueNum
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
    # No scratch child issues may exist (sub-issues + tester issue were dropped).
    # In mock mode this is a local store read — never a GitHub search.
    $refs = @()
    $issuesDir = Join-Path $env:FREDO_MOCK_STORE "issues"
    if (Test-Path $issuesDir) {
      foreach ($f in Get-ChildItem $issuesDir -Filter *.json -ErrorAction SilentlyContinue) {
        $raw = [System.IO.File]::ReadAllText($f.FullName)
        if ($raw -match "Parent: Implementation Plan #$planNum") {
          $n = [int]($f.BaseName)
          if ($n -ne $planNum) { $refs += $n }
        }
      }
    }
    if ($refs.Count -ne 0) { throw "generate-work leaked issues: $($refs.Count)" }
    return "generate-work removed: no sub-issues/tester created"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    if ($planNum) {
      Mock-Cleanup $planNum
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

# Compound commands that smuggle a write must be denied (the && / ; / | / & hole —
# spaced AND no-space forms)
Test-Script "Compound-command smuggling denied" {
  $config = Get-Content "opencode.json" -Raw | ConvertFrom-Json
  $agents = $config.agent.PSObject.Properties.Name
  $smuggleCmds = @(
    "git status && gh pr merge 5",
    "cargo build && git push origin main",
    "gh issue view 5 | gh issue edit 5",
    "git status&&gh pr merge 5",
    "git status;gh pr merge 5",
    "git log;git push origin HEAD:spec/633 main",
    "git status & gh pr merge 5",
    "cargo build & git push origin main"
  )
  $failures = @()
  foreach ($agent in $agents) {
    foreach ($cmd in $smuggleCmds) {
      if ((Get-BashEffect $agent $cmd) -ne "deny") { $failures += "${agent}: '$cmd' NOT denied" }
    }
  }
  if ($failures.Count -gt 0) { throw "Compound-command gaps: $($failures -join '; ')" }
  return "compound smuggling denied for $($agents.Count) agents (spaced + no-space + &)"
}

# Developer pushes to the spec branch via HEAD:spec/<N>; main/master denied;
# multi-refspec / flag smuggling on the spec push denied (the HEAD:spec/* allow
# must not swallow an extra `main` refspec or a force flag)
Test-Script "Developer push scoping (HEAD:spec allowed, main denied)" {
  $ok = (Get-BashEffect "developer" "git push origin HEAD:spec/633") -eq "allow"
  $blockedMain = (Get-BashEffect "developer" "git push origin main") -eq "deny"
  $blockedHead = (Get-BashEffect "developer" "git push origin HEAD:main") -eq "deny"
  $smuggle = @(
    "git push origin HEAD:spec/633 main",
    "git push origin HEAD:spec/633 master",
    "git push origin HEAD:spec/633 -f",
    "git push origin HEAD:spec/633 --force",
    "git push --force origin HEAD:spec/633"
  )
  $smuggleBlocked = $true
  foreach ($c in $smuggle) { if ((Get-BashEffect "developer" $c) -ne "deny") { $smuggleBlocked = $false } }
  if (-not $ok -or -not $blockedMain -or -not $blockedHead -or -not $smuggleBlocked) { throw "developer push scoping broken: HEAD:spec-allow=$ok main-deny=$blockedMain HEAD:main-deny=$blockedHead smuggle-blocked=$smuggleBlocked" }
  return "developer push: HEAD:spec allowed, main/HEAD:main + refspec/flag smuggle denied"
}

# Self-Improver may merge a FEATURE branch but never main/master (incl. --ff-only)
Test-Script "SI git merge: feature allowed, main/master denied" {
  $feature = (Get-BashEffect "self-improver" "git merge spec/633") -eq "allow"
  $mainDeny = (Get-BashEffect "self-improver" "git merge main") -eq "deny"
  $ffDeny = (Get-BashEffect "self-improver" "git merge --ff-only main") -eq "deny"
  $masterDeny = (Get-BashEffect "self-improver" "git merge --ff-only master") -eq "deny"
  if (-not $feature -or -not $mainDeny -or -not $ffDeny -or -not $masterDeny) { throw "SI merge scoping broken: feature=$feature main=$mainDeny ff-only=$ffDeny master=$masterDeny" }
  return "SI merge: spec/633 allowed, main/master/--ff-only denied"
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
  $url = Mock-IssueCreate "temp: triage-init" "triage-init scratch feature" ""
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
    Mock-Cleanup $issueNum
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
  $url = Mock-IssueCreate "temp: tests-commit" "tests-commit scratch feature" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $feat = "scratch-$issueNum"
  $dir = ".opencode/tests/$feat"
  $repo = "fredo/mock"
  try {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    [System.IO.File]::WriteAllText("$dir/functional.md", "- [ ] F-1: scratch functional case`n", [System.Text.UTF8Encoding]::new($true))
    [System.IO.File]::WriteAllText("$dir/smoke.md", "- [ ] S-1: scratch smoke case`n", [System.Text.UTF8Encoding]::new($true))
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action tests-commit --feature $feat 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "tests-commit failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "TESTS COMMITTED:") { throw "Expected TESTS COMMITTED:, got: $outStr" }
    # Verify via the mock store's contents tree (the Contents API wrote them to
    # `contents/main/.opencode/tests/<feat>/`), not a real git/gh read.
    $mainTree = Join-Path $env:FREDO_MOCK_STORE "contents\main\.opencode\tests\$feat"
    if (-not (Test-Path "$mainTree\functional.md")) { throw "functional.md missing from mock main tree: $mainTree" }
    if (-not (Test-Path "$mainTree\smoke.md")) { throw "smoke.md missing from mock main tree: $mainTree" }
    return "tests-commit persisted $feat to main"
  } finally {
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:FREDO_MOCK_STORE "contents\main\.opencode\tests\$feat") -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
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

# update-plan on a draft that has no matching section errors (no GitHub write)
Test-Script "update-plan rejects a draft without the section" {
  $url = Mock-IssueCreate "temp: update-plan no section" "update-plan scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $draft = Join-Path $env:TEMP "fredo-update-plan-draft.md"
  $planDraftDir = ".opencode/tmp/$issueNum"
  Set-Content -Path $draft -Value "## Domain Model`n(empty)" -Encoding UTF8
  try {
    New-Item -ItemType Directory -Path $planDraftDir -Force | Out-Null
    Set-Content -Path "$planDraftDir/triage-plan.md" -Value "## Some Other Section`ncontent here" -Encoding UTF8
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action update-plan --section software-architect --body-file $draft 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -eq 0) { throw "Expected failure, got exit 0" }
    if ($outStr -notmatch "no '## ' section matching") { throw "Expected section-not-found error, got: $outStr" }
    return "update-plan section-not-found verified"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# update-plan positive path: replace the software-architect block in the draft, keep the rest
Test-Script "update-plan positive path (replace software-architect section in draft)" {
  $url = Mock-IssueCreate "temp: update-plan positive" "update-plan scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $draft = Join-Path $env:TEMP "fredo-update-plan-new.md"
  $planDraftDir = ".opencode/tmp/$issueNum"
  Set-Content -Path $draft -Value "- [ ] Sub-task 1: Wire widget A`n- [ ] Sub-task 2: Persist settings to FeatureStore" -Encoding UTF8
  try {
    New-Item -ItemType Directory -Path $planDraftDir -Force | Out-Null
    Set-Content -Path "$planDraftDir/triage-plan.md" -Value "## Software Architect`n### Domain Model`n(empty)`n## Summary`nold summary" -Encoding UTF8
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action update-plan --section software-architect --body-file $draft 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "update-plan failed (exit $LASTEXITCODE): $outStr" }
    if ($outStr -notmatch "PLAN UPDATED:") { throw "Expected PLAN UPDATED:, got: $outStr" }
    $bodyStr = Get-Content "$planDraftDir/triage-plan.md" -Raw
    if ($bodyStr -notmatch "Wire widget A") { throw "Draft content not found in triage-plan.md: $bodyStr" }
    if ($bodyStr -match "Domain Model") { throw "Old section content should have been replaced: $bodyStr" }
    if ($bodyStr -notmatch "## Summary") { throw "Following section should survive: $bodyStr" }
    return "update-plan replaced software-architect in triage-plan.md on #$issueNum"
  } finally {
    Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# Retry-round compaction (PO feedback, #2688): a rework re-entry into implementation
# posts a compact `## Fix Plan (round N)` instead of re-posting the full plan.
Test-Script "Retry rework posts compact Fix Plan, not the full Triage Plan" {
  $url = Mock-IssueCreate "temp: fix-plan retry" "fix-plan scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $planDraftDir = ".opencode/tmp/$issueNum"
  try {
    New-Item -ItemType Directory -Path $planDraftDir -Force | Out-Null
    $fullPlan = @"
## Software Architect
### Domain Model
Full domain model body that should NOT be re-posted on retry.
### Sub-issue Decomposition
- [ ] ST1 - Restrict the chat-node contract to chat-only gRPC
- [ ] ST2 - Plugin thinking capture
## Risks & Mitigations
Subagent regression risk under chat-only contract.

*Authored by Self-Improver*
"@
    [System.IO.File]::WriteAllText((Join-Path $planDraftDir "triage-plan.md"), $fullPlan, [System.Text.UTF8Encoding]::new($false))
    # Simulate a prior entry into implementation (this is a rework re-entry).
    $ev = '{"ts":"2026-08-10T00:00:00.000000000+00:00","event_id":"fixplan-test-1","event_name":"phase.started","actor":"self-improver","entity":{"issueId":"' + $issueNum + '"},"phase":"implementation","outcome":"success","attempt":1,"correlation_id":"issue-' + $issueNum + '","attributes":{},"message":"started implementation"}'
    New-Item -ItemType Directory -Path ".opencode/state/issues" -Force | Out-Null
    [System.IO.File]::WriteAllText(".opencode/state/issues/$issueNum.jsonl", "$ev`n", [System.Text.UTF8Encoding]::new($false))

    $out = & rust-script $ps --issue $issueNum --agent self-improver --action post-comments 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "post-comments failed (exit $LASTEXITCODE): $outStr" }

    $comments = @(Mock-IssueComments $issueNum)
    $joined = $comments -join "`n"
    if ($joined -notmatch "## Fix Plan \(round 2\)") { throw "Expected '## Fix Plan (round 2)', got: $joined" }
    if ($joined -match "Full domain model") { throw "Fix Plan must not repeat the full plan body: $joined" }
    if ($joined -notmatch "- \[ \] ST1") { throw "Fix Plan should carry the sub-issue checklist: $joined" }
    if ($joined -notmatch "Subagent regression risk") { throw "Fix Plan should carry Risks & Mitigations context: $joined" }
    if (Test-Path "$planDraftDir/triage-plan.md") { throw "triage-plan.md draft should be consumed after posting" }
    return "retry rework posted compact Fix Plan (round 2) on #$issueNum"
  } finally {
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# First entry (no prior implementation) still posts the full `## Triage Plan`.
Test-Script "First entry posts the full Triage Plan (not a Fix Plan)" {
  $url = Mock-IssueCreate "temp: triage-plan first" "triage-plan scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $planDraftDir = ".opencode/tmp/$issueNum"
  try {
    New-Item -ItemType Directory -Path $planDraftDir -Force | Out-Null
    $fullPlan = @"
## Software Architect
### Sub-issue Decomposition
- [ ] ST1 - Restrict the chat-node contract
## Summary
Goal summary.

*Authored by Self-Improver*
"@
    [System.IO.File]::WriteAllText((Join-Path $planDraftDir "triage-plan.md"), $fullPlan, [System.Text.UTF8Encoding]::new($false))

    $out = & rust-script $ps --issue $issueNum --agent self-improver --action post-comments 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "post-comments failed (exit $LASTEXITCODE): $outStr" }

    $comments = @(Mock-IssueComments $issueNum)
    $joined = $comments -join "`n"
    if ($joined -notmatch "## Triage Plan") { throw "Expected '## Triage Plan', got: $joined" }
    if ($joined -match "## Fix Plan") { throw "First entry must NOT post a Fix Plan: $joined" }
    return "first entry posted the full Triage Plan on #$issueNum"
  } finally {
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# Triage exit gate: the implementation-plan deliverable (A2A file) must be converged
# — no GitHub Decision comment is involved. The plan itself is the artifact.
Test-Script "Triage exit gate requires a converged plan deliverable (A2A file)" {
  $url = Mock-IssueCreate "temp: triage convergence gate" "scratch feature for convergence gate" "planning"
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    # No A2A plan yet → the triage exit guard must block on convergence.
    $before = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $beforeStr = if ($before -is [array]) { $before -join "`n" } else { "$before" }
    if ($beforeStr -notmatch "not converged") { throw "Expected convergence block, got: $beforeStr" }
    # Seed the A2A deliverable WITHOUT the convergence marker — still blocked.
    $a2aDir = ".opencode/tmp/$issueNum"
    New-Item -ItemType Directory -Path $a2aDir -Force | Out-Null
    [System.IO.File]::WriteAllText("$a2aDir/triage.md", "# Implementation Plan #$issueNum - scratch`n`n## Summary`ngoal`n`n## Software Architect`nscratch`n`n## UI/UX Expert`nN/A`n`n## QA Expert`nscratch`n`n## Staffing Plan`n1 dev`n`n## Deployment Notes`nnone`n`n## Risks & Mitigations`nnone", [System.Text.UTF8Encoding]::new($false))
    $mid = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $midStr = if ($mid -is [array]) { $mid -join "`n" } else { "$mid" }
    if ($midStr -notmatch "not converged") { throw "Expected convergence block without '## Convergence: agreed', got: $midStr" }
    # Append the convergence marker to the A2A FILE (the plan deliverable) — gate clears.
    $a2a = Get-Content "$a2aDir/triage.md" -Raw
    [System.IO.File]::WriteAllText("$a2aDir/triage.md", $a2a.TrimEnd() + "`n`n## Convergence: agreed", [System.Text.UTF8Encoding]::new($false))
    $after = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $afterStr = if ($after -is [array]) { $after -join "`n" } else { "$after" }
    if ($afterStr -match "not converged") { throw "Convergence block should clear after '## Convergence: agreed', got: $afterStr" }
    if ($afterStr -notmatch "TRIAGE PLAN DRAFTED:|SPEC BRANCH CREATED:") { throw "Expected plan assembly side-effects, got: $afterStr" }
    return "triage gate: plan deliverable (A2A) must be converged before transition"
  } finally {
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
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
  $url = Mock-IssueCreate "temp: auto-assembly" $intakeBody ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $feat = "scratch-$issueNum"
  $a2a = ".opencode/tmp/$issueNum/triage.md"
  $testDir = ".opencode/tests/$feat"
  $repo = "fredo/mock"
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

    # Convergence (the agreement gate): the PLAN DELIVERABLE carries the marker —
    # append `## Convergence: agreed` to the A2A file. No GitHub Decision comment.
    $a2aRaw = Get-Content $a2a -Raw
    [System.IO.File]::WriteAllText($a2a, $a2aRaw.TrimEnd() + "`n`n## Convergence: agreed", [System.Text.UTF8Encoding]::new($false))

    $trans = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $transStr = if ($trans -is [array]) { $trans -join "`n" } else { "$trans" }
    if ($LASTEXITCODE -ne 0) { throw "triage->implementation failed (exit $LASTEXITCODE): $transStr" }
    foreach ($need in @("TRIAGE PLAN DRAFTED:", "SPEC BRANCH CREATED:", "TESTS COMMITTED:")) {
      if ($transStr -notmatch [regex]::Escape($need)) { throw "missing '$need' in output: $transStr" }
    }
    if ($transStr -match "SUB-ISSUE CREATED|TESTER ISSUE CREATED|IMPL PLAN ASSEMBLED: #") { throw "no plan/sub/tester issues may be created: $transStr" }
    # Single-issue model: the plan is a `## Triage Plan` comment auto-posted on the
    # feature issue — no separate plan issue exists.
    $planM = [regex]::Match($transStr, "TRIAGE PLAN DRAFTED:")
    if (-not $planM.Success) { throw "no triage-plan draft in output: $transStr" }
    # The `## Triage Plan` comment lands on the FEATURE issue.
    $cmts = Mock-IssueComments $issueNum
    $joined = $cmts -join "`n"
    if ($joined -notmatch "## Triage Plan") { throw "triage plan comment not posted on feature issue: $joined" }
    # Tests persisted to main (verify against the mock store's contents tree)
    $mainTree = Join-Path $env:FREDO_MOCK_STORE "contents\main\.opencode\tests\$feat"
    if (-not (Test-Path "$mainTree\functional.md")) { throw "tests not persisted to main: $mainTree" }
    return "auto-assembled ## Triage Plan comment + tests on main + spec/$issueNum (no sub-issues, no plan issue)"
  } finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    # remove the persisted test folder from the mock main tree
    Remove-Item (Join-Path $env:FREDO_MOCK_STORE "contents\main\.opencode\tests\$feat") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $testDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    # delete the auto-created spec branch from the mock refs
    Remove-Item (Mock-StorePath "refs\spec\$issueNum") -Force -ErrorAction SilentlyContinue
    Remove-Item (Mock-StorePath "commits\spec\$issueNum") -Force -ErrorAction SilentlyContinue
    foreach ($n in @($closeList)) {
      if ($n) { Mock-Cleanup $n }
    }
    Mock-Cleanup $issueNum
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
  $url = Mock-IssueCreate "temp: decision gate" "comment gate scratch" ""
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
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# timeline comments: drafts in .opencode/tmp/<issue>/*.md are posted + consumed
Test-Script "timeline comments posted from tmp drafts (post-comments)" {
  $url = Mock-IssueCreate "temp: timeline comments" "timeline scratch" ""
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
    # comments actually on the issue; retry-relevant timeline comments are
    # machine-stamped with the round (SI Summary (round N)), PO Backlog is not.
    $cmts = Mock-IssueComments $issueNum
    $joined = $cmts -join "`n"
    if ($joined -notmatch "## PO Backlog" -or $joined -notmatch "## SI Summary \(round 1\)") { throw "comments not posted to issue: $joined" }
    return "timeline comments posted + consumed (SI Summary round-stamped)"
  } finally {
    Remove-Item ".opencode/tmp/$issueNum" -Recurse -Force -ErrorAction SilentlyContinue
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# block/unblock positive + missing --reason rejected
Test-Script "block/unblock positive + missing reason" {
  $url = Mock-IssueCreate "temp: block unblock" "block scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action block --reason "test blocker" 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "block failed: $outStr" }
    $st = Mock-IssueState $issueNum
    if ($st.Labels -notcontains "blocked") { throw "Expected blocked label, got: $($st.Labels)" }
    $out2 = & rust-script $ps --issue $issueNum --agent self-improver --action unblock 2>&1
    if ($LASTEXITCODE -ne 0) { throw "unblock failed: $out2" }
    $st2 = Mock-IssueState $issueNum
    if ($st2.Labels -contains "blocked") { throw "blocked label should be removed, got: $($st2.Labels)" }
    $out3 = & rust-script $ps --issue $issueNum --agent self-improver --action block 2>&1
    if ($LASTEXITCODE -eq 0) { throw "block without --reason should fail" }
    $global:LASTEXITCODE = 0
    return "block/unblock positive + missing reason rejected"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# close-issue positive (cancel) + done-from-non-audit block
Test-Script "close-issue positive (cancel) + done gate" {
  $url = Mock-IssueCreate "temp: close cancel" "close scratch" ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $out = & rust-script $ps --issue $issueNum --agent self-improver --action close-issue --to-phase canceled 2>&1
    $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($LASTEXITCODE -ne 0) { throw "close-issue failed: $outStr" }
    $st = Mock-IssueState $issueNum
    if ($st.State -ne "CLOSED") { throw "Expected CLOSED, got: $($st.State)" }
    return "close-issue canceled positive"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# Cleanup phase: close-issue --to-phase done is gated to the cleanup phase only
# (the SI runs teardown there after the audit verdict), and swaps cleanup → done.
Test-Script "Cleanup phase: done-close gated to cleanup" {
  $url = Mock-IssueCreate "temp: cleanup gate" "cleanup scratch" "audit"
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    # Done-close from the audit phase is blocked (must be in cleanup).
    $blocked = & rust-script $ps --issue $issueNum --agent self-improver --action close-issue --to-phase done 2>&1
    $blockedStr = if ($blocked -is [array]) { $blocked -join "`n" } else { "$blocked" }
    if ($blockedStr -notmatch "only cleanup-phase features can close as done") { throw "Expected cleanup-only block, got: $blockedStr" }
    # Record the audit verdict (success) → audit → cleanup.
    $evBody = Join-Path $env:TEMP "fredo-cleanup-evidence.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: PASS`nSELECT ... FROM telemetry_spans ... rows=1", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    $ar = & rust-script $ps --issue $issueNum --agent self-improver --action audit-record --verdict success --reason "ok" 2>&1
    $arStr = if ($ar -is [array]) { $ar -join "`n" } else { "$ar" }
    if ($arStr -notmatch "AUDIT PASS -> CLEANUP") { throw "Expected audit→cleanup, got: $arStr" }
    $st = Mock-IssueState $issueNum
    if ($st.Labels -notcontains "cleanup") { throw "Expected cleanup label, got: $($st.Labels)" }
    # Now the done-label succeeds from cleanup.
    $close = & rust-script $ps --issue $issueNum --agent self-improver --action close-issue --to-phase done 2>&1
    $closeStr = if ($close -is [array]) { $close -join "`n" } else { "$close" }
    if ($closeStr -notmatch "labeled done") { throw "Expected labeled-done from cleanup, got: $closeStr" }
    $st2 = Mock-IssueState $issueNum
    if ($st2.State -ne "OPEN") { throw "Expected OPEN (human closes manually), got: $($st2.State)" }
    if ($st2.Labels -notcontains "done") { throw "Expected done label, got: $($st2.Labels)" }
    return "cleanup phase: done-label gated to cleanup, audit→cleanup→done (open) works"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# audit-record rejects a legal restart on a non-audit issue (no mutation)
Test-Script "audit-record rejects legal restart on non-audit issue" {
  $url = Mock-IssueCreate "temp: audit-record non-audit" "not in audit phase" ""
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
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# verify exits 3 on a tampered record
Test-Script "verify detects a tampered record (exit 3)" {
  $url = Mock-IssueCreate "temp: verify tamper" "tamper scratch" ""
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
    Mock-Cleanup $issueNum
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
  $url = Mock-IssueCreate "temp: impl gate" $intakeBody ""
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  $a2a = ".opencode/tmp/$issueNum/triage.md"
  $repo = "fredo/mock"
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
    $a2aRaw = Get-Content $a2a -Raw
    [System.IO.File]::WriteAllText($a2a, $a2aRaw.TrimEnd() + "`n`n## Convergence: agreed", [System.Text.UTF8Encoding]::new($false))
    $t = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $tStr = if ($t -is [array]) { $t -join "`n" } else { "$t" }
    if ($LASTEXITCODE -ne 0) { throw "triage->implementation failed: $tStr" }
    if ($tStr -notmatch "TRIAGE PLAN DRAFTED:") { throw "no triage-plan draft: $tStr" }
    # Single-issue model: evidence lands on the FEATURE issue (no plan issue).
    $planNum = $issueNum

    # gate must block while the spec branch has NO commits (developer hasn't pushed)
    $b = & rust-script $ps --issue $issueNum --agent self-improver --action transition 2>&1
    $bStr = if ($b -is [array]) { $b -join "`n" } else { "$b" }
    if ($bStr -notmatch "no commits beyond main") { throw "Expected no-commits block, got: $bStr" }

    # Push a trivial commit to the spec branch (the developer's push) -> gate clears.
    # In mock mode the transition already created the spec ref; simulate the push by
    # bumping the branch's ahead-count (the machine's rev-list reads it).
    $specMarker = "spec-gate-marker-$issueNum.txt"
    [System.IO.File]::WriteAllText($specMarker, "gate test marker", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --action mock-commit --branch "spec/$issueNum" --commits 1 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "mock commit failed" }
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
    # Mock cleanup: delete the spec PR + branch refs from the mock store.
    Remove-Item (Join-Path $env:FREDO_MOCK_STORE "prs") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:FREDO_MOCK_STORE "refs\spec\$issueNum") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:FREDO_MOCK_STORE "commits\spec\$issueNum") -Force -ErrorAction SilentlyContinue
    foreach ($n in @($closeList)) { if ($n) { Mock-Cleanup $n } }
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# A verdict-less `## Evidence` screenshot receipt (upload-evidence) posted after a
# PASS verdict must NOT mask it — the verification guard reads the latest comment
# that CARRIES a verdict (Spec #2680 masking vector).
Test-Script "Verdict-less Evidence receipt does not mask a prior PASS verdict" {
  $url = Mock-IssueCreate "temp: evidence-mask" "evidence-mask scratch" "audit"
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    # Post the real PASS verdict with live evidence first (like a `## Tests Runs`).
    $evBody = Join-Path $env:TEMP "fredo-ev-mask-pass.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: **PASS**`nSELECT ... FROM telemetry_spans ... rows=1", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    # Now simulate an upload-evidence screenshot receipt posted AFTER the verdict
    # (a `## Evidence` comment with NO verdict line — upload-evidence does not
    # validate a verdict). The latest comment is now verdict-less.
    $shotBody = Join-Path $env:TEMP "fredo-ev-mask-shot.md"
    [System.IO.File]::WriteAllText($shotBody, "## Evidence`n`n![smoke.jpeg](https://github.com/FredoAi/fredo/raw/spec/1/.opencode/evidence/1/smoke.jpeg)", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --action mock-gh --ghargs "issue comment $issueNum --body-file $shotBody" 2>&1 | Out-Null
    Remove-Item $shotBody -Force -ErrorAction SilentlyContinue
    # The verification guard must still read PASS (latest verdict-carrying comment).
    $audit = & rust-script $ps --action audit --issue $issueNum --json 2>&1
    $auditStr = if ($audit -is [array]) { $audit -join "`n" } else { "$audit" }
    $auditJson = $auditStr.Substring($auditStr.IndexOf("{"))
    $json = $auditJson | ConvertFrom-Json
    if (-not $json.verdict_is_pass) { throw "verdict_is_pass should be true, got: $auditStr" }
    if (-not $json.verification_ok) { throw "verification_ok should be true, got: $auditStr" }
    # And a FAIL verdict posted later STILL blocks (the #1499 semantic is preserved).
    $failBody = Join-Path $env:TEMP "fredo-ev-mask-fail.md"
    [System.IO.File]::WriteAllText($failBody, "Verdict: FAIL`nSELECT ... FROM telemetry_spans ... rows=0", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $failBody 2>&1 | Out-Null
    Remove-Item $failBody -Force -ErrorAction SilentlyContinue
    $audit2 = & rust-script $ps --action audit --issue $issueNum --json 2>&1
    $audit2Str = if ($audit2 -is [array]) { $audit2 -join "`n" } else { "$audit2" }
    $audit2Json = $audit2Str.Substring($audit2Str.IndexOf("{"))
    $json2 = $audit2Json | ConvertFrom-Json
    if ($json2.verdict_is_pass) { throw "later FAIL verdict must flip verdict_is_pass, got: $audit2Str" }
    if ($json2.verification_ok) { throw "later FAIL verdict must block verification_ok, got: $audit2Str" }
    return "evidence masking: verdict-less receipt ignored, later FAIL still blocks"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# The verification policy is the DECLARED value after "Verification policy:",
# not a whole-line "contains static" scan — the template's explanatory sentence
# ("replace `live` with `static` ONLY if every AC...") contains the word, so a
# live plan must not be misread as static (Spec #2680).
Test-Script "Live-policy plan line is not misread as static" {
  $url = Mock-IssueCreate "temp: policy-live" "policy scratch" "audit"
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    # Plan declares LIVE — with the template's own explanatory sentence that
    # contains the word "static" (must NOT flip the policy).
    $plan = Join-Path $env:TEMP "fredo-policy-live-plan.md"
    [System.IO.File]::WriteAllText($plan, "## Triage Plan`n`n> **Verification policy: live** - replace ``live`` with ``static`` ONLY if every AC in this`n> plan is genuinely verifiable without observing a running system.", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --action mock-gh --ghargs "issue comment $issueNum --body-file $plan" 2>&1 | Out-Null
    Remove-Item $plan -Force -ErrorAction SilentlyContinue
    # Static-only PASS evidence (no telemetry_spans) must FAIL on a live plan.
    $evBody = Join-Path $env:TEMP "fredo-policy-live-ev.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: PASS (static source analysis)", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    $audit = & rust-script $ps --action audit --issue $issueNum --json 2>&1
    $auditStr = if ($audit -is [array]) { $audit -join "`n" } else { "$audit" }
    $auditJson = $auditStr.Substring($auditStr.IndexOf("{"))
    $json = $auditJson | ConvertFrom-Json
    if ($json.verification_policy -ne "live") { throw "policy should be live, got: $auditStr" }
    if ($json.verification_ok) { throw "static-only PASS must not clear a live plan, got: $auditStr" }
    return "live-policy plan: declared value wins over explanatory 'static' text"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

Test-Script "Static-policy plan line is read as static" {
  $url = Mock-IssueCreate "temp: policy-static" "policy scratch" "audit"
  if ($LASTEXITCODE -ne 0) { throw "gh issue create failed: $url" }
  $urlStr = if ($url -is [array]) { $url -join "" } else { "$url" }
  $m = [regex]::Match($urlStr, "issues/(\d+)")
  if (-not $m.Success) { throw "Could not parse issue number from: $urlStr" }
  $issueNum = [int]$m.Groups[1].Value
  try {
    $plan = Join-Path $env:TEMP "fredo-policy-static-plan.md"
    [System.IO.File]::WriteAllText($plan, "## Triage Plan`n`n> **Verification policy: static**", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --action mock-gh --ghargs "issue comment $issueNum --body-file $plan" 2>&1 | Out-Null
    Remove-Item $plan -Force -ErrorAction SilentlyContinue
    $evBody = Join-Path $env:TEMP "fredo-policy-static-ev.md"
    [System.IO.File]::WriteAllText($evBody, "Verdict: PASS (static source analysis)", [System.Text.UTF8Encoding]::new($false))
    & rust-script $ps --issue $issueNum --agent tester --action comment --prefix Evidence --body-file $evBody 2>&1 | Out-Null
    Remove-Item $evBody -Force -ErrorAction SilentlyContinue
    $audit = & rust-script $ps --action audit --issue $issueNum --json 2>&1
    $auditStr = if ($audit -is [array]) { $audit -join "`n" } else { "$audit" }
    $auditJson = $auditStr.Substring($auditStr.IndexOf("{"))
    $json = $auditJson | ConvertFrom-Json
    if ($json.verification_policy -ne "static") { throw "policy should be static, got: $auditStr" }
    if (-not $json.verification_ok) { throw "static-only PASS should clear a static plan, got: $auditStr" }
    return "static-policy plan: declared value accepted"
  } finally {
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# intake exit gate requires the required sections (via transition)
Test-Script "intake exit gate requires the required sections" {
  $url = Mock-IssueCreate "temp: intake sections" "no sections here" ""
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
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# transition --to-phase done is refused (done only via audit-record)
Test-Script "transition --to-phase done is refused" {
  $url = Mock-IssueCreate "temp: transition done" "scratch" "audit"
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
    Mock-Cleanup $issueNum
    $global:LASTEXITCODE = 0
  }
}

# Evidence comments carry the testing verdict — tester/self-improver only
Test-Script "Evidence comments are tester/self-improver-only" {
  $url = Mock-IssueCreate "temp: evidence gate" "comment gate scratch" ""
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
    Mock-Cleanup $issueNum
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

# Remove the mock-repo scratch dir (it lives in %TEMP%, gitignored by default).
Remove-Item -LiteralPath $env:FREDO_MOCK_STORE -Recurse -Force -ErrorAction SilentlyContinue

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


