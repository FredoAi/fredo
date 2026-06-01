<#
.SYNOPSIS
    Verifies that all "Fredo" references have been renamed to "Fredo" in the deprecated
    tools-mcp code and archived documentation.

.DESCRIPTION
    This test script checks:
    1. No remaining "Fredo"/"fredo" references in apps/tools-mcp_DEPRECATED/ (with exclusions)
    2. No remaining "Fredo"/"fredo" references in docs/archive/tools-mcp/ (with exclusions)
    3. Key Fredo replacements are present
    4. Excluded files are untouched

.EXAMPLE
    .\scripts\test-fredo-removal.ps1
#>

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$passCount = 0
$failCount = 0
$tests = @()

function Test-Check {
    param(
        [string]$Name,
        [scriptblock]$Condition
    )
    try {
        $result = & $Condition
        if ($result) {
            $script:passCount++
            $script:tests += [PSCustomObject]@{ Name = $Name; Status = 'PASS' }
            Write-Host "  PASS: $Name" -ForegroundColor Green
        } else {
            $script:failCount++
            $script:tests += [PSCustomObject]@{ Name = $Name; Status = 'FAIL' }
            Write-Host "  FAIL: $Name" -ForegroundColor Red
        }
    } catch {
        $script:failCount++
        $script:tests += [PSCustomObject]@{ Name = $Name; Status = 'FAIL'; Error = $_.Exception.Message }
        Write-Host "  FAIL: $Name - $_" -ForegroundColor Red
    }
}

function Get-RemainingFredoRefs {
    param([string]$Path)
    # Find all fredo/fredo references, excluding fredosian.net and Fredosian Document Format
    $results = @()
    # Scan ALL files, exclude only tokenizer.json and .git directory
    $files = Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'tokenizer.json' -and $_.FullName -notmatch '[\\/]node_modules[\\/]' }
    foreach ($file in $files) {
        $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $content) { continue }

        # Find lines with fredo/Fredo but exclude fredosian.net and Fredosian Document Format
        $lines = $content -split "`n"
        for ($i = 0; $i -lt $lines.Length; $i++) {
            $line = $lines[$i]
            if ($line -match '(?i)fredo' -and $line -notmatch '(?i)fredosian' -and $line -notmatch 'Fredosian Document Format') {
                $results += "$($file.FullName):$($i+1): $line".Trim()
            }
        }
    }
    return $results
}

Write-Host "`n=== Fredo → Fredo Rename Verification ===" -ForegroundColor Cyan

# --- Section 1: No remaining Fredo references in deprecated code ---
Write-Host "`n[1] Checking apps/tools-mcp_DEPRECATED/ for remaining Fredo references..." -ForegroundColor Yellow
$deprecatedPath = Join-Path $repoRoot 'apps/tools-mcp_DEPRECATED'
if (Test-Path $deprecatedPath) {
    $remaining = Get-RemainingFredoRefs -Path $deprecatedPath
    Test-Check "No remaining Fredo references in deprecated code (excluding fredosian.net)" -Condition { $remaining.Count -eq 0 }
    if ($remaining.Count -gt 0) {
        Write-Host "    Found $($remaining.Count) remaining reference(s):" -ForegroundColor Yellow
        $remaining | Select-Object -First 10 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkYellow }
        if ($remaining.Count -gt 10) { Write-Host "      ... and $($remaining.Count - 10) more" -ForegroundColor DarkYellow }
    }
} else {
    Write-Host "    SKIP: apps/tools-mcp_DEPRECATED/ does not exist" -ForegroundColor Gray
    $passCount++
    $tests += [PSCustomObject]@{ Name = "Deprecated code folder check"; Status = 'SKIP' }
}

# --- Section 2: No remaining Fredo references in archived docs ---
Write-Host "`n[2] Checking docs/archive/tools-mcp/ for remaining Fredo references..." -ForegroundColor Yellow
$archivePath = Join-Path $repoRoot 'docs/archive/tools-mcp'
if (Test-Path $archivePath) {
    $archiveRemaining = Get-RemainingFredoRefs -Path $archivePath
    Test-Check "No remaining Fredo references in archived docs (excluding fredosian.net)" -Condition { $archiveRemaining.Count -eq 0 }
    if ($archiveRemaining.Count -gt 0) {
        Write-Host "    Found $($archiveRemaining.Count) remaining reference(s):" -ForegroundColor Yellow
        $archiveRemaining | Select-Object -First 10 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkYellow }
    }
} else {
    Write-Host "    SKIP: docs/archive/tools-mcp/ does not exist" -ForegroundColor Gray
    $passCount++
    $tests += [PSCustomObject]@{ Name = "Archive docs folder check"; Status = 'SKIP' }
}

# --- Section 3: Key Fredo replacements present ---
Write-Host "`n[3] Checking key Fredo replacements in deprecated code..." -ForegroundColor Yellow

$pkgJson = Join-Path $deprecatedPath 'package.json'
Test-Check "package.json uses @fredo/tools-mcp" -Condition {
    if (Test-Path $pkgJson) { (Get-Content $pkgJson -Raw) -match '@fredo/tools-mcp' } else { $false }
}

Test-Check "package.json author is Fredo Team" -Condition {
    if (Test-Path $pkgJson) { (Get-Content $pkgJson -Raw) -match 'Fredo Team' } else { $false }
}

# Check for Fredo class names
$fredoService = Get-ChildItem -Path $deprecatedPath -Recurse -Filter '*FredoUiService*' -ErrorAction SilentlyContinue
Test-Check "FredoUiService class exists" -Condition { $fredoService.Count -gt 0 }

$fredoRoutes = Get-ChildItem -Path $deprecatedPath -Recurse -Filter '*FredoUiRoutes*' -ErrorAction SilentlyContinue
Test-Check "FredoUiRoutes class exists" -Condition { $fredoRoutes.Count -gt 0 }

$fredoAlert = Get-ChildItem -Path $deprecatedPath -Recurse -Filter '*FredoUiAlertTool*' -ErrorAction SilentlyContinue
Test-Check "FredoUiAlertTool class exists" -Condition { $fredoAlert.Count -gt 0 }

$fredoStepper = Get-ChildItem -Path $deprecatedPath -Recurse -Filter '*FredoUiStepperTool*' -ErrorAction SilentlyContinue
Test-Check "FredoUiStepperTool class exists" -Condition { $fredoStepper.Count -gt 0 }

$fredoCollect = Get-ChildItem -Path $deprecatedPath -Recurse -Filter '*FredoUiCollectResponsesTool*' -ErrorAction SilentlyContinue
Test-Check "FredoUiCollectResponsesTool class exists" -Condition { $fredoCollect.Count -gt 0 }

# Check Redis channel rename
Test-Check "Redis channel uses fredo:global:events" -Condition {
    $files = Get-ChildItem -Path $deprecatedPath -Recurse -Include *.ts -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -match 'fredo:global:events') { return $true }
    }
    return $false
}

Test-Check "Stream key uses fredo:sessions:" -Condition {
    $files = Get-ChildItem -Path $deprecatedPath -Recurse -Include *.ts -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -match 'fredo:sessions:') { return $true }
    }
    return $false
}

Test-Check "Redis key uses fredo:active-connection:" -Condition {
    $files = Get-ChildItem -Path $deprecatedPath -Recurse -Include *.ts -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -match 'fredo:active-connection:') { return $true }
    }
    return $false
}

# Check env var rename
Test-Check "Uses FREDO_EMBEDDED (not FREDO_EMBEDDED)" -Condition {
    $files = Get-ChildItem -Path $deprecatedPath -Recurse -Include *.ts -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -match 'FREDO_EMBEDDED') { return $true }
    }
    return $false
}

# Check socket path rename
Test-Check "Socket path uses /var/run/fredo/" -Condition {
    $files = Get-ChildItem -Path $deprecatedPath -Recurse -Include *.ts -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -match '/var/run/fredo/') { return $true }
    }
    return $false
}

# Check directory renames
Test-Check "Directory fredo-ui/ exists (was fredo-ui/)" -Condition {
    Test-Path (Join-Path $deprecatedPath 'src/services/fredo-ui')
}

Test-Check "Directory fredo_ui_stepper/ exists (was fredo_ui_stepper/)" -Condition {
    $dirs = Get-ChildItem -Path $deprecatedPath -Recurse -Directory -Filter 'fredo_ui_stepper' -ErrorAction SilentlyContinue
    $dirs.Count -gt 0
}

Test-Check "Directory fredo_ui_alert/ exists (was fredo_ui_alert/)" -Condition {
    $dirs = Get-ChildItem -Path $deprecatedPath -Recurse -Directory -Filter 'fredo_ui_alert' -ErrorAction SilentlyContinue
    $dirs.Count -gt 0
}

Test-Check "Directory fredo_ui_collect_responses/ exists (was fredo_ui_collect_responses/)" -Condition {
    $dirs = Get-ChildItem -Path $deprecatedPath -Recurse -Directory -Filter 'fredo_ui_collect_responses' -ErrorAction SilentlyContinue
    $dirs.Count -gt 0
}

# --- Section 4: Exclusions ---
Write-Host "`n[4] Checking exclusions are preserved..." -ForegroundColor Yellow

Test-Check "tokenizer.json still exists (ML artifact)" -Condition {
    Test-Path (Join-Path $repoRoot 'apps/tauri/src-tauri/models/gemma-e2b-it/tokenizer.json')
}

Test-Check "CHANGELOG.md still contains Fredo cleanup history" -Condition {
    $changelog = Join-Path $repoRoot 'CHANGELOG.md'
    if (Test-Path $changelog) {
        (Get-Content $changelog -Raw) -match '(?i)fredo'
    } else { $false }
}

Test-Check "SETUP.md still contains fredosian.net URL" -Condition {
    $setup = Join-Path $repoRoot 'docs/tauri/SETUP.md'
    if (Test-Path $setup) {
        (Get-Content $setup -Raw) -match 'fredosian\.net'
    } else { $false }
}

Test-Check "FAQ.md still contains fredosian.net URL" -Condition {
    $faq = Join-Path $repoRoot 'docs/FAQ.md'
    if (Test-Path $faq) {
        (Get-Content $faq -Raw) -match 'fredosian\.net'
    } else { $false }
}

# --- Summary ---
Write-Host "`n=== Test Summary ===" -ForegroundColor Cyan
Write-Host "  Passed: $passCount" -ForegroundColor Green
Write-Host "  Failed: $failCount" -ForegroundColor $(if ($failCount -gt 0) { 'Red' } else { 'Green' })
Write-Host ""

if ($failCount -gt 0) {
    Write-Host "FAILED: $failCount test(s) did not pass." -ForegroundColor Red
    exit 1
} else {
    Write-Host "ALL TESTS PASSED" -ForegroundColor Green
    exit 0
}
