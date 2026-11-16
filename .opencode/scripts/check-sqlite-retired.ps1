<#
  check-sqlite-retired.ps1 - residual occurrence gate (spec #3005, AC5 / R-5)

  Repo-scan gate proving no shipped artifact treats SQLite as a LIVE store.

  Deny tokens (word-boundary matched where needed):
    fredo.db, control.db, rusqlite, SqliteEngine, FREDO_STORAGE_ENGINE,
    select_engine, EngineChoice.
  CRITICAL: fredo.db / control.db are matched with a word boundary ((?!\w)) so
  the legitimate OS-keychain service name fredo.dbclient is NOT flagged (G-330).

  DENY scope (a hit here FAILS the gate):
    - .opencode/skills/**
    - .opencode/scripts/**  (except this checker itself)
    - opencode.json
    - product source apps/**  (.rs / .ts / .tsx; apps/tauri/src-tauri/gen/schemas/** skipped)
    - product docs docs/*.md  (except docs/agentic-pipeline/** and docs/README.md)

  Allowlist classes (by name; hits here are reported but do NOT fail):
    - historic-narrative        : docs/agentic-pipeline/**, spikes/**, docs/README.md, git history
    - test-absence-fixtures     : .opencode/tests/**, apps/**/tests/**
    - gate-self-reference       : this checker's token table + its self-test probe
    - ephemeral-pipeline-scratch: .opencode/tmp/**, .opencode/state/**

  Exit codes: 0 = clean (no DENY-scope hit); 1 = at least one DENY-scope hit;
  2 = the gate could not run (bad root).  With -SelfTest: 0 = the matcher fired
  as required (and held the word boundary); 1 = an assertion failed.

  Usage:
    powershell -File .opencode/scripts/check-sqlite-retired.ps1
    powershell -File .opencode/scripts/check-sqlite-retired.ps1 -SelfTest
    powershell -File .opencode/scripts/check-sqlite-retired.ps1 -Root C:\Code\fredo
#>
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [string]$Root,
    [int]$SampleLimit = 50
)

# Keep the process alive across non-fatal file IO problems.
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Deny token table (class: gate-self-reference - the checker owns these names)
# ---------------------------------------------------------------------------
$DenyTokens = @(
    [pscustomobject]@{ Name = 'fredo.db';             Regex = 'fredo\.db(?!\w)' },
    [pscustomobject]@{ Name = 'control.db';           Regex = 'control\.db(?!\w)' },
    [pscustomobject]@{ Name = 'rusqlite';             Regex = '\brusqlite\b' },
    [pscustomobject]@{ Name = 'SqliteEngine';         Regex = '\bSqliteEngine\b' },
    [pscustomobject]@{ Name = 'FREDO_STORAGE_ENGINE'; Regex = '\bFREDO_STORAGE_ENGINE\b' },
    [pscustomobject]@{ Name = 'select_engine';        Regex = '\bselect_engine\b' },
    [pscustomobject]@{ Name = 'EngineChoice';         Regex = '\bEngineChoice\b' }
)

$DenyTokenNames = ($DenyTokens | ForEach-Object { $_.Name }) -join ', '
$AllowlistClasses = @('historic-narrative', 'test-absence-fixtures', 'gate-self-reference', 'ephemeral-pipeline-scratch')
$TextExtensions = @(
    '.md', '.markdown', '.txt', '.rs', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
    '.json', '.ps1', '.psm1', '.sh', '.bash', '.bat', '.cmd', '.toml', '.yml', '.yaml',
    '.html', '.css', '.sql'
)

# ---------------------------------------------------------------------------
# Matcher (case-sensitive; .NET regex)
# ---------------------------------------------------------------------------
function Get-DenyTokenHits {
    param([string]$Text)
    $found = @()
    foreach ($t in $DenyTokens) {
        if ([regex]::IsMatch($Text, $t.Regex)) { $found += $t.Name }
    }
    return $found
}

# ---------------------------------------------------------------------------
# Self-test: prove the DENY property fires and the word boundary holds
# ---------------------------------------------------------------------------
if ($SelfTest) {
    Write-Host '=== check-sqlite-retired : SelfTest ==='
    $positive = 'the legacy store was control.db plus fredo.db here'
    $negative = 'OS keychain service is fredo.dbclient'
    $pos = @(Get-DenyTokenHits -Text $positive)
    $neg = @(Get-DenyTokenHits -Text $negative)
    $firesControl = $pos -contains 'control.db'
    $firesFredo   = $pos -contains 'fredo.db'
    $boundaryHeld = -not ($neg -contains 'fredo.db')
    Write-Host ('DENY property  -> control.db flagged:           {0}' -f $firesControl)
    Write-Host ('DENY property  -> fredo.db flagged:             {0}' -f $firesFredo)
    Write-Host ('WORD-BOUNDARY  -> fredo.dbclient NOT flagged:   {0}' -f $boundaryHeld)
    if ($firesControl -and $firesFredo -and $boundaryHeld) {
        Write-Host 'SELFTEST: PASS'
        exit 0
    }
    Write-Host 'SELFTEST: FAIL - the matcher did not fire as required'
    exit 1
}

# ---------------------------------------------------------------------------
# Path classification
# ---------------------------------------------------------------------------
function Test-SkipPath {
    param([string]$Rel)
    $r = '/' + $Rel + '/'
    foreach ($seg in @('/.git/', '/node_modules/', '/target/', '/.worktrees/', '/.serve/', '/dist/', '/gen/schemas/')) {
        if ($r.IndexOf($seg, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

function Get-FileClass {
    param([string]$Rel)
    $r = $Rel.ToLowerInvariant()
    if ($r -eq '.opencode/scripts/check-sqlite-retired.ps1') { return 'gate-self-reference' }
    if ($r.StartsWith('.opencode/tmp/') -or $r.StartsWith('.opencode/state/')) { return 'ephemeral-pipeline-scratch' }
    if ($r.StartsWith('docs/agentic-pipeline/') -or $r.StartsWith('spikes/') -or $r -eq 'docs/readme.md') { return 'historic-narrative' }
    if ($r.StartsWith('.opencode/tests/')) { return 'test-absence-fixtures' }
    if ($r.StartsWith('apps/')) {
        if ($r -match '/tests/') { return 'test-absence-fixtures' }
        if ($r -match '\.(rs|ts|tsx)$') { return 'deny' }
        return 'ungated'
    }
    if ($r.StartsWith('.opencode/skills/')) { return 'deny' }
    if ($r.StartsWith('.opencode/scripts/')) { return 'deny' }
    if ($r -eq 'opencode.json') { return 'deny' }
    if ($r.StartsWith('docs/')) {
        if ($r -match '\.md$') { return 'deny' }
        return 'ungated'
    }
    return 'ungated'
}

# ---------------------------------------------------------------------------
# Resolve the repo root
# ---------------------------------------------------------------------------
if (-not $Root) {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $Root = (Resolve-Path (Join-Path $here '..\..')).Path
}
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Host ('ERROR: root not found: {0}' -f $Root)
    exit 2
}
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$rootLen = $Root.Length + 1

# ---------------------------------------------------------------------------
# Enumerate candidate files
# ---------------------------------------------------------------------------
$scanRoots = @(
    (Join-Path $Root '.opencode\skills'),
    (Join-Path $Root '.opencode\scripts'),
    (Join-Path $Root '.opencode\tests'),
    (Join-Path $Root '.opencode\tmp'),
    (Join-Path $Root '.opencode\state'),
    (Join-Path $Root 'docs'),
    (Join-Path $Root 'spikes'),
    (Join-Path $Root 'apps')
)
$files = New-Object System.Collections.Generic.List[string]
foreach ($sr in $scanRoots) {
    if (Test-Path -LiteralPath $sr) {
        Get-ChildItem -LiteralPath $sr -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { [void]$files.Add($_.FullName) }
    }
}
$opencodeJson = Join-Path $Root 'opencode.json'
if (Test-Path -LiteralPath $opencodeJson) { [void]$files.Add($opencodeJson) }

# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------
$classHits = @{}
foreach ($c in ($AllowlistClasses + 'deny')) { $classHits[$c] = 0 }
$denyLines = New-Object System.Collections.Generic.List[string]
$scanned = 0

foreach ($f in $files) {
    $rel = $f.Substring($rootLen).Replace('\', '/')
    if (Test-SkipPath -Rel $rel) { continue }
    $ext = [System.IO.Path]::GetExtension($f).ToLowerInvariant()
    if ($TextExtensions -notcontains $ext) { continue }
    $cls = Get-FileClass -Rel $rel
    if ($cls -eq 'ungated') { continue }
    $scanned++

    $content = $null
    try { $content = [System.IO.File]::ReadAllText($f) } catch { continue }
    if ([string]::IsNullOrEmpty($content)) { continue }

    $lines = $content -split "\r?\n"
    for ($i = 0; $i -lt $lines.Count; $i++) {
        foreach ($t in $DenyTokens) {
            if ([regex]::IsMatch($lines[$i], $t.Regex)) {
                $classHits[$cls] = $classHits[$cls] + 1
                if ($cls -eq 'deny') { [void]$denyLines.Add(('{0}:{1}: {2}' -f $rel, ($i + 1), $t.Name)) }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
Write-Host '=== check-sqlite-retired ==='
Write-Host ('Repo root: {0}' -f $Root)
Write-Host ('Deny tokens: {0}' -f $DenyTokenNames)
Write-Host 'DENY property: fredo.db/control.db word-boundary matched; symbol tokens case-sensitive.'
Write-Host 'DENY scope:'
Write-Host '  - .opencode/skills/**'
Write-Host '  - .opencode/scripts/**  (except this checker)'
Write-Host '  - opencode.json'
Write-Host '  - apps/**  (.rs/.ts/.tsx; apps/tauri/src-tauri/gen/schemas/** skipped)'
Write-Host '  - docs/*.md  (except docs/agentic-pipeline/**, docs/README.md)'
Write-Host 'Allowlist classes (by name):'
Write-Host '  - historic-narrative        : docs/agentic-pipeline/**, spikes/**, docs/README.md, git history'
Write-Host '  - test-absence-fixtures     : .opencode/tests/**, apps/**/tests/**'
Write-Host '  - gate-self-reference       : this checker token table + its self-test probe'
Write-Host '  - ephemeral-pipeline-scratch: .opencode/tmp/**, .opencode/state/**'
Write-Host ('Scanned files: {0}' -f $scanned)
Write-Host 'Hits by class:'
foreach ($c in $AllowlistClasses) { Write-Host ('  {0}: {1}' -f $c, $classHits[$c]) }
Write-Host ('  deny: {0}' -f $classHits['deny'])

if ($denyLines.Count -eq 0) {
    Write-Host 'RESULT: CLEAN (no DENY-scope hit)'
    exit 0
}

Write-Host ('DENY hits: {0}' -f $denyLines.Count)
$show = [Math]::Min($SampleLimit, $denyLines.Count)
for ($i = 0; $i -lt $show; $i++) { Write-Host ('  {0}' -f $denyLines[$i]) }
if ($denyLines.Count -gt $show) { Write-Host ('  ... and {0} more' -f ($denyLines.Count - $show)) }
Write-Host 'RESULT: FAIL (DENY-scope hit(s) present - SQLite treated as a live store)'
exit 1
