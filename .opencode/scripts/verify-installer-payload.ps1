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

  After that presence assertion the gate SCANS the imports of every payload DLL
  PRESENT in the extracted tree - every manifest core entry and every tool
  module entry that is present - reading the load-time AND delay-import tables
  through the shared pe-imports.psm1 reader (one implementation, shared with the
  stager). It fails closed when a present DLL carries a forbidden import
  (importClosure.forbiddenImportPrefixes), a non-system import that is not part
  of the extracted payload set, or an unparsable import table. fredo.exe and
  uninstall.exe are explicitly OUT of the scan universe: their load proof is the
  AC4 launch probe, not this gate. An absent tool module is NOT a failure - it
  is reported as PAYLOAD_ABSENT_OPTIONAL.

  WHY A GATE
    .github/workflows/release.yml runs this before any draft release is created,
    so a partial payload fails the release job closed instead of shipping. A
    build-log line, a PATH trick, and a developer run all prove nothing about the
    installer; only the artifact does.

  EXTRACTION (probed in this order, the answering route is recorded)
    0. -SevenZip override (when supplied): same 7z invocation. It is the FIRST
       route so a host whose 7z is not on PATH (the local dev box has 7z only
       outside the repo) can still extract. A supplied override that does not
       exist is a REFUSED precondition (exit 2,
       ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND), never a silent fall-back - a typo in
       the override must not turn into an "extractor missing" verdict.
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
      one: its fixtures are synthetic PE DLLs built inline by the shared
      pe-imports.psm1 (New-SyntheticPeDll) and its extractor route is either a
      real, available route or explicitly forced unavailable.

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

.PARAMETER SevenZip
  Optional path to a 7z executable used as the FIRST extraction route, so a
  produced installer can be extracted on a host whose 7z is not on PATH. A
  supplied path that does not exist is refused (exit 2,
  ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND) instead of falling through to the other
  routes. When omitted, the route order is unchanged.

.PARAMETER SelfTest
  Run the nine deterministic instrument controls (hermetic, synthetic fixtures,
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
    PAYLOAD_ABSENT_OPTIONAL=<name>
    PAYLOAD_IMPORT_SCAN=<dll> imports=<n> delay=<n>
    ARTIFACT_PAYLOAD_SCANNED=<n> of=<n>
    IMPORT_SCAN=PASS|FAIL dlls=<n>
    RESULT=PASS|FAIL
    ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT missing=<comma list>
    ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=<dll> module=<module> kind=<import|delay-import>
    ERROR=PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT edge=<dll> -> <module> kind=<import|delay-import>
    ERROR=PAYLOAD_IMPORT_PARSE_FAIL_IN_ARTIFACT dll=<dll> reason=<why>
    ERROR=EXTRACTOR_MISSING tried=<comma list>
    ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND path=<path>
    ERROR=DEBUG_ARTIFACT_REFUSED path=<path>
    ERROR=INSTALLER_NOT_FOUND path=<path>
    ERROR=PAYLOAD_MANIFEST_INVALID path=<path> reason=<why>

.EXIT CODES
  0  PASS - every required payload name is present and every present payload DLL
     passes the import scan
  1  FAIL - payload incomplete in the artifact, or a present payload DLL carries
     a forbidden / unresolved / unparsable import
  2  refused precondition (debug path, missing installer, no extractor,
     missing/invalid manifest, a supplied -SevenZip override that does not exist)
  3  -SelfTest control failed

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -SelfTest

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -Installer apps/tauri/src-tauri/target/release/bundle/nsis/Fredo_0.2.2_x64-setup.exe
#>
param(
    [string]$Installer = '',
    [string]$ExpectedPayload = '',
    [string]$WorkDir = '',
    [switch]$SelfTest,
    [switch]$ForceNoExtractor,
    [string]$SevenZip = ''
)

$ErrorActionPreference = 'Stop'

$script:ScriptDir = $PSScriptRoot
$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$script:Captured = $null
$script:RequiredNames = @()
$script:OptionalNames = @()
$script:ForbiddenPrefixes = @()

# Shared PE import/delay-import reader. The stager imports the SAME module, so
# the two gates cannot drift (Spec #3172). A .psm1 is imported, not dot-sourced:
# Windows PowerShell 5.1 does not publish a dot-sourced .psm1's functions into
# the caller's scope.
Import-Module (Join-Path $script:ScriptDir 'pe-imports.psm1') -Force

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

    # Optional tool modules: present ones are scanned, absent ones are reported.
    # Names are validated so the scan universe cannot silently narrow.
    $tools = @($parsed.toolModules)
    if ($tools.Count -eq 0) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=empty-tool-modules"
        return $null
    }
    foreach ($name in $tools) {
        if ([string]::IsNullOrWhiteSpace($name)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=blank-tool-module-name"
            return $null
        }
        $key = $name.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=duplicate-name name=$name"
            return $null
        }
        $seen[$key] = $true
    }

    # Forbidden module prefixes: the property this gate enforces (no TLS stack).
    $forbidden = @()
    foreach ($prefix in @($parsed.importClosure.forbiddenImportPrefixes)) {
        if ([string]::IsNullOrWhiteSpace($prefix)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=missing-forbidden-prefixes"
            return $null
        }
        $forbidden += [string]$prefix
    }
    if ($forbidden.Count -eq 0) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$Path reason=missing-forbidden-prefixes"
        return $null
    }

    return [pscustomobject]@{
        Path = (Resolve-Path -LiteralPath $Path).Path
        Core = $core
        ToolModules = $tools
        ForbiddenPrefixes = $forbidden
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
    param(
        [string]$Root,
        [string[]]$RequiredNames,
        [string[]]$OptionalNames = @(),
        [string[]]$ForbiddenPrefixes = @()
    )

    $missing = New-Object System.Collections.ArrayList
    $rootOk = Test-Path -LiteralPath $Root -PathType Container
    $foundByName = @{}

    foreach ($name in $RequiredNames) {
        $found = $null
        if ($rootOk) { $found = Find-PayloadFile -Root $Root -Name $name }
        if ($null -ne $found) {
            $foundByName[$name.ToLowerInvariant()] = $found
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

    # Scan universe = every manifest payload DLL PRESENT in the extracted tree:
    # the required core set plus any optional tool module that shipped. An absent
    # tool module is reported, never a failure. fredo.exe / uninstall.exe are not
    # in the manifest, so they are outside the scan universe by construction.
    $entries = New-Object System.Collections.ArrayList
    foreach ($name in $RequiredNames) {
        $found = $foundByName[$name.ToLowerInvariant()]
        if ($null -ne $found) {
            [void]$entries.Add([pscustomobject]@{ Name = $name; Path = $found.FullName })
        }
    }
    foreach ($name in $OptionalNames) {
        $found = $null
        if ($rootOk) { $found = Find-PayloadFile -Root $Root -Name $name }
        if ($null -eq $found) {
            Emit "PAYLOAD_ABSENT_OPTIONAL=$name"
        } else {
            [void]$entries.Add([pscustomobject]@{ Name = $name; Path = $found.FullName })
        }
    }

    $scan = Get-PeImportScan -Entries @($entries) -ForbiddenPrefixes @($ForbiddenPrefixes)
    foreach ($dll in $scan.PerDll) {
        Emit "PAYLOAD_IMPORT_SCAN=$($dll.Name) imports=$($dll.ImportCount) delay=$($dll.DelayCount)"
    }
    Emit "ARTIFACT_PAYLOAD_SCANNED=$($scan.Scanned) of=$($entries.Count)"

    $scanFailed = ($scan.Scanned -ne $entries.Count) -or
                  ($scan.ParseFails.Count -gt 0) -or
                  ($scan.Misses.Count -gt 0) -or
                  ($scan.Forbidden.Count -gt 0)
    if ($scanFailed) {
        foreach ($fail in $scan.ParseFails) {
            Emit "ERROR=PAYLOAD_IMPORT_PARSE_FAIL_IN_ARTIFACT dll=$($fail.Name) reason=$($fail.Reason)"
        }
        foreach ($forbidden in $scan.Forbidden) {
            Emit "ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=$($forbidden.Importer) module=$($forbidden.Module) kind=$($forbidden.Kind)"
        }
        foreach ($miss in $scan.Misses) {
            Emit "ERROR=PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT edge=$($miss.Importer) -> $($miss.Missing) kind=$($miss.Kind)"
        }
        Emit "IMPORT_SCAN=FAIL dlls=$($scan.Scanned)"
        Emit 'RESULT=FAIL'
        return 1
    }

    Emit "IMPORT_SCAN=PASS dlls=$($scan.Scanned)"
    Emit 'RESULT=PASS'
    return 0
}

# ---------------------------------------------------------------------------
# Extraction routes
# ---------------------------------------------------------------------------
function Get-ExtractionRoutes {
    param([bool]$ForceNone, [string]$SevenZipOverride = '')

    $routes = New-Object System.Collections.ArrayList
    if ($ForceNone) { return @($routes) }

    # An explicit -SevenZip override is the FIRST route: a host whose 7z is not
    # on PATH (the only local 7z lives outside the repo) can still extract, and
    # the caller's chosen extractor is preferred over a PATH binary of unknown
    # version. Its existence is validated by Invoke-Verify before this point.
    if (-not [string]::IsNullOrWhiteSpace($SevenZipOverride)) {
        [void]$routes.Add([pscustomobject]@{ Name = 'sevenzip-override'; Kind = '7z'; Exe = $SevenZipOverride })
    }

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

    # A native tool's NON-ZERO exit is an expected, handled outcome. Scope
    # 'Continue' around the call (G-315): with the script's stop-on-error
    # preference, redirected native stderr can become a terminating throw and
    # the documented no-extractor refusal (exit 2 + ERROR=EXTRACTOR_MISSING)
    # would be unreachable from the very host state it exists for.
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $SevenZip x -y ("-o" + $Dest) $InstallerPath 2>&1 | Out-Null
        $code = $LASTEXITCODE
    } catch {
        # A tool that cannot even start is an unanswered route, not an abort.
        $code = 1
    } finally {
        $ErrorActionPreference = $previous
    }
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

    # Same G-315 scoping as Invoke-7zRoute: an NSIS install that refuses (for
    # example a perMachine installer raised without elevation) must fall through
    # to the documented extractor-missing refusal, not abort the run.
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $InstallerPath /S ("/D=" + $target) 2>&1 | Out-Null
        $code = $LASTEXITCODE
    } catch {
        # A perMachine NSIS installer raised without elevation cannot start;
        # that is an unanswered route, not an abort (G-315).
        $code = 1
    } finally {
        $ErrorActionPreference = $previous
    }
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
        [string[]]$OptionalNames = @(),
        [string[]]$ForbiddenPrefixes = @(),
        [bool]$ForceNoRoute,
        [string]$SevenZipOverride = ''
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

    # A supplied -SevenZip override is a REFUSED precondition when it is absent:
    # never fall back silently, because a typo would otherwise read as
    # "no extraction route available" and mask the real cause.
    $resolvedOverride = ''
    if (-not [string]::IsNullOrWhiteSpace($SevenZipOverride)) {
        if (-not (Test-Path -LiteralPath $SevenZipOverride -PathType Leaf)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND path=$SevenZipOverride"
            return 2
        }
        $resolvedOverride = (Resolve-Path -LiteralPath $SevenZipOverride).Path
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
    $routes = @(Get-ExtractionRoutes -ForceNone $ForceNoRoute -SevenZipOverride $resolvedOverride)
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

    # 4. Assert every required name is present with bytes > 0, then import-scan
    #    every present payload DLL (core + any tool module).
    return (Test-PayloadTree -Root $root -RequiredNames $RequiredNames -OptionalNames $OptionalNames -ForbiddenPrefixes $ForbiddenPrefixes)
}

# ---------------------------------------------------------------------------
# -SelfTest: nine deterministic instrument controls (hermetic, synthetic)
# ---------------------------------------------------------------------------
function Invoke-CapturedTree {
    param([string]$Root, [string[]]$Names, [string[]]$Optional = @(), [string[]]$Forbidden = @())

    $script:Captured = New-Object System.Collections.ArrayList
    $code = 99
    try {
        $code = Test-PayloadTree -Root $Root -RequiredNames $Names -OptionalNames $Optional -ForbiddenPrefixes $Forbidden
    } catch {
        [void]$script:Captured.Add("ERROR=SELFTEST_EXCEPTION $($_.Exception.Message)")
    }
    $lines = @($script:Captured)
    $script:Captured = $null
    return [pscustomobject]@{ Code = $code; Lines = $lines }
}

function Invoke-CapturedVerify {
    param([string]$InstallerPath, [string]$WorkDirPath, [string[]]$Names, [string[]]$Optional = @(), [string[]]$Forbidden = @(), [bool]$ForceNoRoute, [string]$SevenZipOverride = '')

    $script:Captured = New-Object System.Collections.ArrayList
    $code = 99
    try {
        $code = Invoke-Verify -InstallerPath $InstallerPath -WorkDirPath $WorkDirPath -RequiredNames $Names -OptionalNames $Optional -ForbiddenPrefixes $Forbidden -ForceNoRoute $ForceNoRoute -SevenZipOverride $SevenZipOverride
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

# Fixtures are structurally valid synthetic PEs (two text stubs would now be a
# parse failure once the scan runs over them). One fixture builder for every
# control, with optional per-DLL import/delay overrides.
function New-PeFixtureTree {
    param(
        [string]$Dir,
        [string[]]$Names,
        [string[]]$Omit = @(),
        [hashtable]$ImportOverrides = @{},
        [hashtable]$DelayOverrides = @{}
    )

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    foreach ($name in $Names) {
        if ($Omit -contains $name) { continue }
        $imports = @()
        $delays = @()
        if ($ImportOverrides.ContainsKey($name)) { $imports = @($ImportOverrides[$name]) }
        if ($DelayOverrides.ContainsKey($name)) { $delays = @($DelayOverrides[$name]) }
        New-SyntheticPeDll -Path (Join-Path $Dir $name) -Imports $imports -DelayImports $delays
    }
}

function Invoke-SelfTest {
    param($Manifest)

    $required = @($Manifest.Core)
    $tools = @($Manifest.ToolModules)
    $forbidden = @($Manifest.ForbiddenPrefixes)
    $allNames = @($required + $tools)
    # A core DLL is the scan target for controls 6-8; prefer the one whose real
    # OpenSSL import motivated this spec, else fall back to the first core name.
    $scanTarget = 'llama-common.dll'
    if ($required -notcontains $scanTarget) { $scanTarget = $required[0] }
    $forbiddenSslModule = [string]$forbidden[0] + '-3-x64.dll'
    $forbiddenCryptoModule = [string]$forbidden[0] + '-3-x64.dll'
    if ($forbidden.Count -gt 1) { $forbiddenCryptoModule = [string]$forbidden[1] + '-3-x64.dll' }
    $ghostModule = 'mystery-unresolved-dependency.dll'
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
            New-PeFixtureTree -Dir $fixture1 -Names $allNames
            $run1 = Invoke-CapturedTree -Root $fixture1 -Names $required -Optional $tools -Forbidden $forbidden
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
                New-PeFixtureTree -Dir $fixture2 -Names $allNames -Omit @($llama)
                $run2 = Invoke-CapturedTree -Root $fixture2 -Names $required -Optional $tools -Forbidden $forbidden
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

        # ---- CONTROL 6 - ARTIFACT-FORBIDDEN-IMPORT ------------------------
        # A load-time forbidden import on a PRESENT payload DLL must fail the
        # artifact gate with the named in-artifact error.
        $pass6 = $false
        $detail6 = ''
        try {
            $fixture6 = Join-Path $root 'fixture-forbidden-import'
            $overrides6 = @{}
            $overrides6[$scanTarget] = @($forbiddenSslModule)
            New-PeFixtureTree -Dir $fixture6 -Names $allNames -ImportOverrides $overrides6
            $run6 = Invoke-CapturedTree -Root $fixture6 -Names $required -Optional $tools -Forbidden $forbidden
            $expected6 = "ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=$scanTarget module=$forbiddenSslModule kind=import"
            $pass6 = ($run6.Code -eq 1) -and
                     (Test-AnyLine -Lines $run6.Lines -Needle 'RESULT=FAIL') -and
                     (Test-AnyLine -Lines $run6.Lines -Needle $expected6) -and
                     (Test-AnyLine -Lines $run6.Lines -Needle 'IMPORT_SCAN=FAIL')
            if (-not $pass6) { $detail6 = "exit=$($run6.Code) lines=$($run6.Lines -join ' / ')" }
        } catch {
            $detail6 = $_.Exception.Message
        }
        Emit 'CONTROL 6 - ARTIFACT-FORBIDDEN-IMPORT'
        if ($pass6) { Emit '[PASS]' } else { Emit "[FAIL] $detail6"; $allPassed = $false }

        # ---- CONTROL 7 - ARTIFACT-DELAY-IMPORT ----------------------------
        # The delay-import directory (DataDirectory[13]) is read too: a
        # delay-loaded forbidden module must fail with kind=delay-import.
        $pass7 = $false
        $detail7 = ''
        try {
            $fixture7 = Join-Path $root 'fixture-delay-import'
            $overrides7 = @{}
            $overrides7[$scanTarget] = @($forbiddenCryptoModule)
            New-PeFixtureTree -Dir $fixture7 -Names $allNames -DelayOverrides $overrides7
            $run7 = Invoke-CapturedTree -Root $fixture7 -Names $required -Optional $tools -Forbidden $forbidden
            $expected7 = "ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=$scanTarget module=$forbiddenCryptoModule kind=delay-import"
            $pass7 = ($run7.Code -eq 1) -and
                     (Test-AnyLine -Lines $run7.Lines -Needle 'RESULT=FAIL') -and
                     (Test-AnyLine -Lines $run7.Lines -Needle $expected7) -and
                     (Test-AnyLine -Lines $run7.Lines -Needle 'IMPORT_SCAN=FAIL')
            if (-not $pass7) { $detail7 = "exit=$($run7.Code) lines=$($run7.Lines -join ' / ')" }
        } catch {
            $detail7 = $_.Exception.Message
        }
        Emit 'CONTROL 7 - ARTIFACT-DELAY-IMPORT'
        if ($pass7) { Emit '[PASS]' } else { Emit "[FAIL] $detail7"; $allPassed = $false }

        # ---- CONTROL 8 - ARTIFACT-IMPORT-GAP ------------------------------
        # A present payload DLL importing a non-system module that is not in the
        # extracted payload set must fail with the named unresolved error.
        $pass8 = $false
        $detail8 = ''
        try {
            $fixture8 = Join-Path $root 'fixture-import-gap'
            $overrides8 = @{}
            $overrides8[$scanTarget] = @($ghostModule)
            New-PeFixtureTree -Dir $fixture8 -Names $allNames -ImportOverrides $overrides8
            $run8 = Invoke-CapturedTree -Root $fixture8 -Names $required -Optional $tools -Forbidden $forbidden
            $expected8 = "ERROR=PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT edge=$scanTarget -> $ghostModule kind=import"
            $pass8 = ($run8.Code -eq 1) -and
                     (Test-AnyLine -Lines $run8.Lines -Needle 'RESULT=FAIL') -and
                     (Test-AnyLine -Lines $run8.Lines -Needle $expected8) -and
                     (Test-AnyLine -Lines $run8.Lines -Needle 'IMPORT_SCAN=FAIL')
            if (-not $pass8) { $detail8 = "exit=$($run8.Code) lines=$($run8.Lines -join ' / ')" }
        } catch {
            $detail8 = $_.Exception.Message
        }
        Emit 'CONTROL 8 - ARTIFACT-IMPORT-GAP'
        if ($pass8) { Emit '[PASS]' } else { Emit "[FAIL] $detail8"; $allPassed = $false }

        # ---- CONTROL 9 - SEVENZIP-OVERRIDE ------------------------------
        # Two hermetic assertions, no external process:
        #   (a) an existing -SevenZip override is the FIRST extraction route
        #       (and is absent when no override is supplied), so a host without
        #       7z on PATH can still extract;
        #   (b) a NON-EXISTENT override is refused BEFORE any route is attempted
        #       (exit 2, ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND), never a silent
        #       fall-through to the other routes.
        $pass9 = $false
        $detail9 = ''
        try {
            $overrideFixture = Join-Path $root 'fake-7z.exe'
            [System.IO.File]::WriteAllText($overrideFixture, 'stub', [System.Text.UTF8Encoding]::new($false))

            $routesWithOverride = @(Get-ExtractionRoutes -ForceNone $false -SevenZipOverride $overrideFixture)
            $routesWithoutOverride = @(Get-ExtractionRoutes -ForceNone $false)
            $overrideFirst = ($routesWithOverride.Count -gt 0) -and
                             ($routesWithOverride[0].Name -eq 'sevenzip-override') -and
                             ($routesWithOverride[0].Kind -eq '7z') -and
                             ($routesWithOverride[0].Exe -eq $overrideFixture)
            $overrideCount = @($routesWithOverride | Where-Object { $_.Name -eq 'sevenzip-override' }).Count
            $absentWhenUnset = -not (@($routesWithoutOverride | Where-Object { $_.Name -eq 'sevenzip-override' }).Count -gt 0)

            # (b) not-found refusal: the override is validated before routes run.
            $standIn9 = Join-Path $root 'fixture-installer-9.exe'
            [System.IO.File]::WriteAllText($standIn9, 'stub', [System.Text.UTF8Encoding]::new($false))
            $missingOverride = Join-Path $root 'does-not-exist\7z.exe'
            $run9 = Invoke-CapturedVerify -InstallerPath $standIn9 -WorkDirPath (Join-Path $root 'extract-override-missing') -Names $required -ForceNoRoute $false -SevenZipOverride $missingOverride
            $noExtraction9 = -not (Test-AnyLine -Lines $run9.Lines -Needle 'EXTRACT_ATTEMPT=')
            $notFoundRefusal = ($run9.Code -eq 2) -and
                               (Test-AnyLine -Lines $run9.Lines -Needle 'ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND') -and
                               $noExtraction9

            $pass9 = $overrideFirst -and ($overrideCount -eq 1) -and $absentWhenUnset -and $notFoundRefusal
            if (-not $pass9) {
                $detail9 = "overrideFirst=$overrideFirst overrideCount=$overrideCount absentWhenUnset=$absentWhenUnset notFoundRefusal=$notFoundRefusal exit=$($run9.Code) lines=$($run9.Lines -join ' / ')"
            }
        } catch {
            $detail9 = $_.Exception.Message
        }
        Emit 'CONTROL 9 - SEVENZIP-OVERRIDE'
        if ($pass9) { Emit '[PASS]' } else { Emit "[FAIL] $detail9"; $allPassed = $false }
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

exit (Invoke-Verify -InstallerPath $Installer -WorkDirPath $WorkDir -RequiredNames @($manifest.Core) -OptionalNames @($manifest.ToolModules) -ForbiddenPrefixes @($manifest.ForbiddenPrefixes) -ForceNoRoute ([bool]$ForceNoExtractor) -SevenZipOverride $SevenZip)
