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

Test-Script "create-spec-branch is scrum-master-only" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action create-spec-branch 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to create-spec-branch") { throw "Expected role-gate block, got: $outStr" }
  return "create-spec-branch role-gate verified"
}

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
  # developer must NOT be able to merge-pr / close-issue / audit-record
  $devMerge = & rust-script $ps --issue $TestIssue --agent developer --action merge-pr --pr 1 2>&1
  $devClose  = & rust-script $ps --issue $TestIssue --agent developer --action close-issue --to-phase done 2>&1
  $testerAudit = & rust-script $ps --issue $TestIssue --agent tester --action audit-record --verdict success 2>&1
  foreach ($out in @($devMerge, $devClose, $testerAudit)) {
    $s = if ($out -is [array]) { $out -join "`n" } else { "$out" }
    if ($s -notmatch "not allowed to") { throw "Expected role-gate block, got: $s" }
  }
  # product-owner may create-issue (intake-role); validate it gets PAST the role gate to intake validation
  $poCreate = & rust-script $ps --agent product-owner --action create-issue --title "x" --body-file $badDraft --issue-type backlog 2>&1
  $poStr = if ($poCreate -is [array]) { $poCreate -join "`n" } else { "$poCreate" }
  if ($poStr -notmatch "INTAKE INVALID" -or $poStr -match "not allowed to") { throw "PO should pass role gate to intake validation, got: $poStr" }
  return "role gating verified"
} -ExpectedExitCode 1

Remove-Item -LiteralPath $badDraft -Force -ErrorAction SilentlyContinue

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

# Developer push-to-spec-branch must stay allowed while push-to-main is denied
Test-Script "Developer push scoping (spec allowed, main denied)" {
  $ok = (Get-BashEffect "developer" "git push origin spec/633") -eq "allow"
  $blocked = (Get-BashEffect "developer" "git push origin main") -eq "deny"
  if (-not $ok -or -not $blocked) { throw "developer push scoping broken: spec-allow=$ok main-deny=$blocked" }
  return "developer push: spec allowed, main denied"
}

# create-branch is removed — worktrees sit directly on the spec branch
Test-Script "create-branch is removed (worktree on spec branch)" {
  $out = & rust-script $ps --issue $TestIssue --agent developer --action create-branch 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "unknown action") { throw "Expected 'unknown action' for removed create-branch, got: $outStr" }
  return "create-branch removed"
} -ExpectedExitCode 1

# remove-worktree is developer-only
Test-Script "remove-worktree role-gates" {
  $out = & rust-script $ps --issue $TestIssue --agent tester --action remove-worktree --worktree-path "$env:TEMP\fredo-wt-test" 2>&1
  $outStr = if ($out -is [array]) { $out -join "`n" } else { "$out" }
  if ($outStr -notmatch "not allowed to remove-worktree") { throw "Expected role-gate block, got: $outStr" }
  return "remove-worktree role-gate verified"
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


