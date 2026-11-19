#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Assert the companion-engine runtime payload is present INSIDE a produced
  installer artifact (Spec #3158, AC3/AC5).

.DESCRIPTION
  The release artifact, not a build log and not the Cargo target directory, is the
  only evidence that ships. This instrument opens the produced NSIS installer,
  extracts it, and asserts that every required (core) payload DLL named by the
  single manifest (.opencode/scripts/payload-manifest.json - the SAME list the
  staging script consumes) is present in the extracted tree with bytes > 0.

  WHY A GATE
    .github/workflows/release.yml runs this before any draft release is created,
    so a partial payload fails the release job closed instead of shipping. A
    build-log line, a PATH trick, and a developer run all prove nothing about the
    installer; only the artifact does.

  EXTRACTION (probed in this order, the answering route is recorded)
    1. 7z on PATH:                 7z x -y -o<WorkDir> <Installer>
    2. %ProgramFiles%\7-Zip\7z.exe: same invocation
    3. NSIS silent install:        <Installer> /S /D=<WorkDir>
       (the primary route when no extractor is installed; produces the real
       $INSTDIR layout the user gets). NSIS forbids quotes in /D, so a WorkDir
       containing whitespace is substituted by a no-space temp directory.
    If every route fails the script exits 2 with ERROR=EXTRACTOR_MISSING. A
    build log is never substituted for an extraction.

  REFUSED PRECONDITIONS (exit 2)
    * -Installer contains \debug\ - a debug artifact is never evidence.
    * -Installer is empty or does not exist.
    * the manifest is missing/unparseable/invalid.
    * no extraction route is available.

  INVARIANTS
    * The required-name list is read from payload-manifest.json ONLY; this script
      carries no second hardcoded DLL list.
    * -SelfTest never fabricates an installer and never claims to have extracted
      one: its fixtures are synthetic stand-in files built in the control and its
      extractor route is either a real, available route or explicitly forced
      unavailable.

.PARAMETER Installer
  Path to the produced NSIS .exe. Required for a real run (not for -SelfTest).
  A path containing \debug\ is refused.

.PARAMETER ExpectedPayload
  Path to the payload manifest. Default:
  .opencode/scripts/payload-manifest.json (beside this script).

.PARAMETER WorkDir
  Extraction directory. Default:
  <repo>/.opencode/tmp/installer-payload/<stamp>. Created fresh (a previous
  directory is replaced); left in place as evidence after the run.

.PARAMETER SelfTest
  Run the five deterministic instrument controls (hermetic, synthetic fixtures,
  no real installer and no real extractor required) and exit 0 only if all pass,
  else 3. Ends with a single SELFTEST: PASS|FAIL line.

.PARAMETER ForceNoExtractor
  INTERNAL switch (self-test control 4): mark every extraction route unavailable
  so the EXTRACTOR_MISSING refusal path can be exercised without an extractor.

.OUTPUT
  One machine-greppable line per fact:
    ARTIFACT=<installer path> sha256=<hex> bytes=<n>
    ARTIFACT_FILE=<name> bytes=<n>
    WORKDIR=<path>
    PAYLOAD_MANIFEST_JSON=<path>
    EXTRACT_ROUTES=<comma list>
    EXTRACT_ATTEMPT=<route>
    EXTRACTOR=<route> status=hit
    EXTRACT_ROOT=<path>
    PAYLOAD_PRESENT=<name>
    PAYLOAD_MISSING=<name>
    RESULT=PASS|FAIL
    ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT missing=<comma list>
    ERROR=EXTRACTOR_MISSING tried=<comma list>
    ERROR=DEBUG_ARTIFACT_REFUSED path=<path>
    ERROR=INSTALLER_NOT_FOUND path=<path>
    ERROR=PAYLOAD_MANIFEST_INVALID path=<path> reason=<why>

.EXIT CODES
  0  PASS - every required payload name is present in the artifact
  1  FAIL - payload incomplete in the artifact
  2  refused precondition (debug path, missing installer, no extractor,
     missing/invalid manifest)
  3  -SelfTest control failed

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -SelfTest

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -Installer apps/tauri/src-tauri/target/release/bundle/nsis/Fredo_0.2.0_x64-setup.exe
#>
param(
    [string]$Installer = '',
    [string]$ExpectedPayload = '',
    [string]$WorkDir = '',
    [switch]$SelfTest,
    [switch]$ForceNoExtractor
)

$ErrorActionPreference = 'Stop'

$script:ScriptDir = $PSScriptRoot
$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$script:Captured = $null
$script:RequiredNames = @()

function Emit {
    param([string]$Line)
    if ($null -ne $script:Captured) {
        [void]$script:Captured.Add($Line)
    } else {
        # The comparator/extractor functions return exit codes, so report lines
        # must go straight to stdout and never enter the pipeline.
        [Console]::Out.WriteLine($Line)
    }
}

function Get-Stamp {
    return (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
}

# ---------------------------------------------------------------------------
# Manifest (single source of the required-name list)
# ---------------------------------------------------------------------------
function Import-PayloadManifest {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=missing"
        return $null
    }

    $parsed = $null
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        $parsed = $raw | ConvertFrom-Json
    } catch {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=unparsable"
        return $null
    }

    $core = @($parsed.core)
    if ($core.Count -eq 0) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=empty-core"
        return $null
    }

    $seen = @{}
    foreach ($name in $core) {
        if ([string]::IsNullOrWhiteSpace($name)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=blank-core-name"
            return $null
        }
        $key = $name.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=duplicate-core-name name=$name"
            return $null
        }
        $seen[$key] = $true
    }

    return [pscustomobject]@{
        Path = (Resolve-Path -LiteralPath $Path).Path
        Core = $core
    }
}

# ---------------------------------------------------------------------------
# Comparator (shared by the real run and controls 1/2)
# ---------------------------------------------------------------------------
function Find-PayloadFile {
    param([string]$Root, [string]$Name)

    $hits = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $Name -ErrorAction SilentlyContinue)
    $best = $null
    foreach ($hit in $hits) {
        if ($hit.Length -gt 0) {
            if ($null -eq $best -or $hit.Length -gt $best.Length) { $best = $hit }
        }
    }
    return $best
}

function Test-PayloadTree {
    param([string]$Root, [string[]]$RequiredNames)

    $missing = New-Object System.Collections.ArrayList
    $rootOk = Test-Path -LiteralPath $Root -PathType Container

    foreach ($name in $RequiredNames) {
        $found = $null
        if ($rootOk) { $found = Find-PayloadFile -Root $Root -Name $name }
        if ($null -ne $found) {
            Emit "PAYLOAD_PRESENT=$name"
        } else {
            [void]$missing.Add($name)
            Emit "PAYLOAD_MISSING=$name"
        }
    }

    if ($missing.Count -gt 0) {
        Emit 'RESULT=FAIL'
        Emit ("ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT missing=" + ($missing -join ','))
        return 1
    }

    Emit 'RESULT=PASS'
    return 0
}

# ---------------------------------------------------------------------------
# Extraction routes
# ---------------------------------------------------------------------------
function Get-ExtractionRoutes {
    param([bool]$ForceNone)

    $routes = New-Object System.Collections.ArrayList
    if ($ForceNone) { return @($routes) }

    $onPath = Get-Command 7z -ErrorAction SilentlyContinue
    if ($null -ne $onPath -and -not [string]::IsNullOrWhiteSpace($onPath.Source)) {
        [void]$routes.Add([pscustomobject]@{ Name = '7z-on-path'; Kind = '7z'; Exe = $onPath.Source })
    }

    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $installed = Join-Path (Join-Path $env:ProgramFiles '7-Zip') '7z.exe'
        if (Test-Path -LiteralPath $installed -PathType Leaf) {
            [void]$routes.Add([pscustomobject]@{ Name = '7z-programfiles'; Kind = '7z'; Exe = $installed })
        }
    }

    [void]$routes.Add([pscustomobject]@{ Name = 'nsis-silent'; Kind = 'nsis'; Exe = '' })
    return @($routes)
}

function Invoke-7zRoute {
    param([string]$SevenZip, [string]$InstallerPath, [string]$Dest)

    & $SevenZip x -y ("-o" + $Dest) $InstallerPath 2>&1 | Out-Null
    $code = $LASTEXITCODE
    return ($code -eq 0)
}

function Invoke-NsisRoute {
    param([string]$InstallerPath, [string]$Dest)

    $target = $Dest
    if ($target -match '\s') {
        # NSIS /D must not be quoted, so a path with whitespace cannot be used.
        $target = Join-Path ([System.IO.Path]::GetTempPath()) ('fredo-nsis-install-' + [guid]::NewGuid().ToString('N'))
        Emit "EXTRACT_DEST=$target reason=workdir-has-whitespace"
    }

    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
    }

    & $InstallerPath /S ("/D=" + $target) 2>&1 | Out-Null
    $code = $LASTEXITCODE
    if ($code -ne 0) { return [pscustomobject]@{ Ok = $false; Root = $target } }
    return [pscustomobject]@{ Ok = $true; Root = $target }
}

# ---------------------------------------------------------------------------
# Main verification run
# ---------------------------------------------------------------------------
function Invoke-Verify {
    param(
        [string]$InstallerPath,
        [string]$WorkDirPath,
        [string[]]$RequiredNames,
        [bool]$ForceNoRoute
    )

    # 1. Refused preconditions come before any work.
    if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
        Emit 'RESULT=FAIL'
        Emit 'ERROR=INSTALLER_NOT_FOUND path=<empty>'
        return 2
    }

    $rawNormalized = $InstallerPath.Replace('/', '\').ToLowerInvariant()
    $fullNormalized = ''
    try {
        $fullNormalized = [System.IO.Path]::GetFullPath($InstallerPath).Replace('/', '\').ToLowerInvariant()
    } catch {
        $fullNormalized = $rawNormalized
    }
    if ($rawNormalized.Contains('\debug\') -or $fullNormalized.Contains('\debug\')) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=DEBUG_ARTIFACT_REFUSED path=$InstallerPath"
        return 2
    }

    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=INSTALLER_NOT_FOUND path=$InstallerPath"
        return 2
    }

    $installerFull = (Resolve-Path -LiteralPath $InstallerPath).Path
    $installerItem = Get-Item -LiteralPath $installerFull
    $sha = (Get-FileHash -LiteralPath $installerFull -Algorithm SHA256).Hash.ToLowerInvariant()
    Emit "ARTIFACT=$installerFull sha256=$sha bytes=$($installerItem.Length)"
    Emit "ARTIFACT_FILE=$($installerItem.Name) bytes=$($installerItem.Length)"

    # 2. Extraction directory.
    $dest = $WorkDirPath
    if ([string]::IsNullOrWhiteSpace($dest)) {
        $dest = Join-Path $script:RepoRoot (Join-Path '.opencode\tmp\installer-payload' (Get-Stamp))
    }
    $dest = [System.IO.Path]::GetFullPath($dest)
    if (Test-Path -LiteralPath $dest) {
        Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Emit "WORKDIR=$dest"
    Emit "PAYLOAD_MANIFEST_JSON=$script:ManifestPath"

    # 3. Extraction: probe routes in order, record the answering route.
    $routes = @(Get-ExtractionRoutes -ForceNone $ForceNoRoute)
    if ($routes.Count -eq 0) {
        Emit 'EXTRACT_ROUTES=none'
    } else {
        Emit ("EXTRACT_ROUTES=" + (($routes | ForEach-Object { $_.Name }) -join ','))
    }

    $root = $null
    $answered = $null
    foreach ($route in $routes) {
        Emit "EXTRACT_ATTEMPT=$($route.Name)"
        $ok = $false
        $routeRoot = $dest
        if ($route.Kind -eq '7z') {
            $ok = Invoke-7zRoute -SevenZip $route.Exe -InstallerPath $installerFull -Dest $dest
        } else {
            $nsis = Invoke-NsisRoute -InstallerPath $installerFull -Dest $dest
            $ok = $nsis.Ok
            $routeRoot = $nsis.Root
        }
        if ($ok) {
            $answered = $route.Name
            $root = $routeRoot
            break
        }
    }

    if ($null -eq $root) {
        Emit 'RESULT=FAIL'
        $tried = if ($routes.Count -gt 0) { ($routes | ForEach-Object { $_.Name }) -join ',' } else { 'none' }
        Emit "ERROR=EXTRACTOR_MISSING tried=$tried"
        return 2
    }

    Emit "EXTRACTOR=$answered status=hit"
    Emit "EXTRACT_ROOT=$root"

    # 4. Assert every required name is present with bytes > 0.
    return (Test-PayloadTree -Root $root -RequiredNames $RequiredNames)
}

# ---------------------------------------------------------------------------
# -SelfTest: five deterministic instrument controls (hermetic, synthetic)
# ---------------------------------------------------------------------------
function Invoke-CapturedTree {
    param([string]$Root, [string[]]$Names)

    $script:Captured = New-Object System.Collections.ArrayList
    $code = 99
    try {
        $code = Test-PayloadTree -Root $Root -RequiredNames $Names
    } catch {
        [void]$script:Captured.Add("ERROR=SELFTEST_EXCEPTION $($_.Exception.Message)")
    }
    $lines = @($script:Captured)
    $script:Captured = $null
    return [pscustomobject]@{ Code = $code; Lines = $lines }
}

function Invoke-CapturedVerify {
    param([string]$InstallerPath, [string]$WorkDirPath, [string[]]$Names, [bool]$ForceNoRoute)

    $script:Captured = New-Object System.Collections.ArrayList
    $code = 99
    try {
        $code = Invoke-Verify -InstallerPath $InstallerPath -WorkDirPath $WorkDirPath -RequiredNames $Names -ForceNoRoute $ForceNoRoute
    } catch {
        [void]$script:Captured.Add("ERROR=SELFTEST_EXCEPTION $($_.Exception.Message)")
    }
    $lines = @($script:Captured)
    $script:Captured = $null
    return [pscustomobject]@{ Code = $code; Lines = $lines }
}

function Test-AnyLine {
    param($Lines, [string]$Needle)
    foreach ($line in $Lines) {
        if ($line.Contains($Needle)) { return $true }
    }
    return $false
}

function New-StandInFiles {
    param([string]$Dir, [string[]]$Names, [string[]]$Omit = @())

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    foreach ($name in $Names) {
        if ($Omit -contains $name) { continue }
        # A few bytes: the comparator counts bytes, not content.
        [System.IO.File]::WriteAllText((Join-Path $Dir $name), 'stub', [System.Text.UTF8Encoding]::new($false))
    }
}

function Invoke-SelfTest {
    param($Manifest)

    $required = @($Manifest.Core)
    $stamp = (Get-Stamp) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $root = Join-Path $script:RepoRoot (Join-Path '.opencode\tmp' ('selftest-' + $stamp))
    $allPassed = $true

    # Keep the manifest path used by the real run visible to the controls.
    $script:ManifestPath = $Manifest.Path

    try {
        New-Item -ItemType Directory -Path $root -Force | Out-Null

        # ---- CONTROL 1 - PASS-ON-COMPLETE --------------------------------
        $pass1 = $false
        $detail1 = ''
        try {
            $fixture1 = Join-Path $root 'fixture-complete'
            New-StandInFiles -Dir $fixture1 -Names $required
            $run1 = Invoke-CapturedTree -Root $fixture1 -Names $required
            $allPresent = $true
            foreach ($name in $required) {
                if (-not (Test-AnyLine -Lines $run1.Lines -Needle ("PAYLOAD_PRESENT=" + $name))) {
                    $allPresent = $false
                    $detail1 = "no PAYLOAD_PRESENT line for $name"
                }
            }
            $noMissing = -not (Test-AnyLine -Lines $run1.Lines -Needle 'PAYLOAD_MISSING=')
            $pass1 = ($run1.Code -eq 0) -and (Test-AnyLine -Lines $run1.Lines -Needle 'RESULT=PASS') -and $allPresent -and $noMissing
            if (-not $pass1 -and [string]::IsNullOrEmpty($detail1)) {
                $detail1 = "exit=$($run1.Code) lines=$($run1.Lines -join ' / ')"
            }
        } catch {
            $detail1 = $_.Exception.Message
        }
        Emit 'CONTROL 1 - PASS-ON-COMPLETE'
        if ($pass1) { Emit '[PASS]' } else { Emit "[FAIL] $detail1"; $allPassed = $false }

        # ---- CONTROL 2 - FAIL-ON-MISSING ---------------------------------
        $pass2 = $false
        $detail2 = ''
        try {
            $llama = 'llama.dll'
            if ($required -notcontains $llama) {
                $detail2 = "$llama is not a required (core) name in the manifest - control 2 is vacuous"
            } else {
                $fixture2 = Join-Path $root 'fixture-missing'
                New-StandInFiles -Dir $fixture2 -Names $required -Omit @($llama)
                $run2 = Invoke-CapturedTree -Root $fixture2 -Names $required
                $pass2 = ($run2.Code -eq 1) -and
                         (Test-AnyLine -Lines $run2.Lines -Needle 'RESULT=FAIL') -and
                         (Test-AnyLine -Lines $run2.Lines -Needle ("ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT missing=" + $llama)) -and
                         (Test-AnyLine -Lines $run2.Lines -Needle ("PAYLOAD_MISSING=" + $llama))
                if (-not $pass2) { $detail2 = "exit=$($run2.Code) lines=$($run2.Lines -join ' / ')" }
            }
        } catch {
            $detail2 = $_.Exception.Message
        }
        Emit 'CONTROL 2 - FAIL-ON-MISSING'
        if ($pass2) { Emit '[PASS]' } else { Emit "[FAIL] $detail2"; $allPassed = $false }

        # ---- CONTROL 3 - REFUSE-DEBUG-PATH -------------------------------
        $pass3 = $false
        $detail3 = ''
        try {
            $debugArtifact = 'apps/tauri/src-tauri/target/debug/bundle/nsis/Fredo_0.2.0_x64-setup.exe'
            $run3 = Invoke-CapturedVerify -InstallerPath $debugArtifact -WorkDirPath (Join-Path $root 'extract-debug') -Names $required -ForceNoRoute $false
            $noExtraction = -not (Test-AnyLine -Lines $run3.Lines -Needle 'EXTRACT_ATTEMPT=') -and
                            -not (Test-AnyLine -Lines $run3.Lines -Needle 'EXTRACTOR=')
            $pass3 = ($run3.Code -eq 2) -and
                     (Test-AnyLine -Lines $run3.Lines -Needle 'ERROR=DEBUG_ARTIFACT_REFUSED') -and
                     $noExtraction
            if (-not $pass3) { $detail3 = "exit=$($run3.Code) noExtraction=$noExtraction lines=$($run3.Lines -join ' / ')" }
        } catch {
            $detail3 = $_.Exception.Message
        }
        Emit 'CONTROL 3 - REFUSE-DEBUG-PATH'
        if ($pass3) { Emit '[PASS]' } else { Emit "[FAIL] $detail3"; $allPassed = $false }

        # ---- CONTROL 4 - REFUSE-NO-EXTRACTOR -----------------------------
        $pass4 = $false
        $detail4 = ''
        try {
            # A synthetic stand-in FILE (never claimed to be a real installer and
            # never handed to an extractor: the routes are forced unavailable).
            $standIn = Join-Path $root 'fixture-installer.exe'
            [System.IO.File]::WriteAllText($standIn, 'stub', [System.Text.UTF8Encoding]::new($false))
            $run4 = Invoke-CapturedVerify -InstallerPath $standIn -WorkDirPath (Join-Path $root 'extract-noroute') -Names $required -ForceNoRoute $true
            $noExtraction = -not (Test-AnyLine -Lines $run4.Lines -Needle 'EXTRACT_ATTEMPT=')
            $pass4 = ($run4.Code -eq 2) -and
                     (Test-AnyLine -Lines $run4.Lines -Needle 'ERROR=EXTRACTOR_MISSING') -and
                     $noExtraction
            if (-not $pass4) { $detail4 = "exit=$($run4.Code) noExtraction=$noExtraction lines=$($run4.Lines -join ' / ')" }
        } catch {
            $detail4 = $_.Exception.Message
        }
        Emit 'CONTROL 4 - REFUSE-NO-EXTRACTOR'
        if ($pass4) { Emit '[PASS]' } else { Emit "[FAIL] $detail4"; $allPassed = $false }

        # ---- CONTROL 5 - SELF-REFERENCE ----------------------------------
        $pass5 = $false
        $detail5 = ''
        try {
            $scriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)
            $workRoot = [System.IO.Path]::GetFullPath((Join-Path $script:RepoRoot '.opencode\tmp\installer-payload'))
            $normScript = $scriptPath.Replace('/', '\').ToLowerInvariant()
            $normWork = $workRoot.Replace('/', '\').ToLowerInvariant()
            $outsideWork = -not ($normScript.Equals($normWork) -or $normScript.StartsWith($normWork + '\'))
            $present = Test-Path -LiteralPath $scriptPath -PathType Leaf
            $pass5 = $outsideWork -and $present
            if (-not $pass5) { $detail5 = "path=$scriptPath outsideWorkDir=$outsideWork present=$present" }
        } catch {
            $detail5 = $_.Exception.Message
        }
        Emit 'CONTROL 5 - SELF-REFERENCE'
        if ($pass5) { Emit '[PASS]' } else { Emit "[FAIL] $detail5"; $allPassed = $false }
    } catch {
        Emit "SELFTEST_EXCEPTION=$($_.Exception.Message)"
        $allPassed = $false
    } finally {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($allPassed) {
        Emit 'SELFTEST: PASS'
        return 0
    }
    Emit 'SELFTEST: FAIL'
    return 3
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($ExpectedPayload)) {
    $script:ManifestPath = Join-Path $script:ScriptDir 'payload-manifest.json'
} else {
    $script:ManifestPath = $ExpectedPayload
}

$manifest = Import-PayloadManifest -Path $script:ManifestPath
if ($null -eq $manifest) { exit 2 }

if ($SelfTest) {
    exit (Invoke-SelfTest -Manifest $manifest)
}

exit (Invoke-Verify -InstallerPath $Installer -WorkDirPath $WorkDir -RequiredNames @($manifest.Core) -ForceNoRoute ([bool]$ForceNoExtractor))
