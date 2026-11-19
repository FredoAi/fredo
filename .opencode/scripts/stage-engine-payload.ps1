#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Stage the companion-engine runtime payload (the canonical allowlist from
  payload-manifest.json) into the bundle source directory, with a PE
  import-closure completeness proof. All-or-nothing.

.DESCRIPTION
  One deterministic producer of the payload set for the Fredo installer (Spec
  #3158). A glob over the Cargo profile dir cannot distinguish one engine
  module from another, cannot name a missing module, and would ship a mixed or
  stale set; this script stages a literal allowlist read from the single
  machine-readable manifest beside it (.opencode/scripts/payload-manifest.json)
  and proves the set is loadable before it replaces -OutDir.

  WHAT IT DOES
    1. Reads .opencode/scripts/payload-manifest.json (the ONLY list of payload
       DLL names; this script carries no second list).
    2. Resolves the Vulkan loader by DISCOVERY over a printed candidate set
       (first hit wins): $env:VULKAN_SDK\runtime\x64, \runtime\x86, other
       enumerated \runtime\<dir> (and their x64 child), \Bin, the SDK root, then
       $env:SystemRoot\System32. Every candidate is printed. An explicit
       -VulkanLoader overrides discovery and is authoritative: a non-existent
       override is VULKAN_LOADER_NOT_FOUND, never a silent fallback.
    3. Enumerates the manifest core names (required) and tool modules
       (reported, non-required) by explicit name - the source directory is
       never globbed. The manifest's explicit-exclusion list (a CUDA backend
       module the current Vulkan-only feature set does not build, and Fredo's
       own cdylib) is never staged even when present.
    4. Parses the PE import directory (DataDirectory[1]) AND the delay-import
       directory (DataDirectory[13]) of EVERY staged DLL - there is no
       hand-picked root subset: the manifest's importClosure.roots must be the
       literal "all-staged". Every non-system, non-staged import is reported
       (PAYLOAD_IMPORT_MISS / ERROR=PAYLOAD_IMPORT_UNRESOLVED); every import
       whose module name matches a manifest forbiddenImportPrefixes entry is
       reported (PAYLOAD_FORBIDDEN_IMPORT / ERROR=PAYLOAD_FORBIDDEN_IMPORT).
       An unparsable table is a parse failure (PAYLOAD_IMPORT_PARSE_FAIL plus
       ERROR=PAYLOAD_IMPORT_UNRESOLVED kind=parse). System imports
       (kernel32/advapi32/msvcp*/vcruntime*/api-ms-win-*/...) are allowlisted
       by prefix. The PE reader lives in the shared pe-imports.psm1.
    5. Stages into a sibling temp directory and only then renames it into
       -OutDir, removing the previous directory afterwards. A strict failure
       leaves -OutDir byte-for-byte unchanged. A second run replaces the whole
       directory, so stale files cannot accumulate.

  INVARIANTS
    * Never mutates target/ (read-only on the source profile directory).
    * Never writes outside -OutDir (and its sibling staging/temp directories).
    * Never globs the source directory: every component is tested by name.
    * A missing tool module is a REPORT line, never a failure and never a
      silent set change.
    * The manifest's explicit-exclusion list is never staged.
    * -SelfTest is hermetic: it builds synthetic PE fixtures in %TEMP% and
      never depends on a release build, an installer, or any real DLL.

.PARAMETER Profile
  release (default) or debug. Selects the default source directory
  <repo>/apps/tauri/src-tauri/target/<Profile>. Any other value is a refused
  precondition (exit 2).

.PARAMETER SourceDir
  Overrides the profile directory (negative-leg testing). Relative paths are
  resolved against the current working directory.

.PARAMETER VulkanLoader
  Overrides the discovered Vulkan loader (the manifest's vulkanLoader name).
  If given, only this path is considered; a missing file is
  VULKAN_LOADER_NOT_FOUND (exit 1).

.PARAMETER OutDir
  Destination directory. Default:
  <repo>/apps/tauri/src-tauri/engine-payload (derived from this script's
  location, so it is independent of the caller's working directory).

.PARAMETER AllowIncomplete
  Probe mode: stage what exists and never fail on a gap (missing core, missing
  loader, unresolved import). Import gaps are still reported. Default STRICT.

.PARAMETER SelfTest
  Run the eleven instrument controls (synthetic fixtures, hermetic) and exit 0
  only if all pass, else 3. Ends with a single SELFTEST: PASS|FAIL line.

.PARAMETER ManifestPath
  Overrides the manifest location (default: payload-manifest.json beside this
  script). Exists so a refusal (e.g. importClosure.roots not "all-staged") is
  drivable from a tmp copy during verification; a default staging run never
  reads a caller-supplied path.

.OUTPUT
  One machine-greppable line per fact:
    PAYLOAD_SOURCE=<dir>
    PAYLOAD_VULKAN_CANDIDATE=<path> status=hit|miss|skipped
    PAYLOAD_VULKAN_LOADER=<path> status=found
    PAYLOAD_COMPONENT=<name> status=staged bytes=<n>
    PAYLOAD_COMPONENT=<name> status=MISSING
    PAYLOAD_IMPORT_SCAN=<dll> imports=<n> delay=<n>
    PAYLOAD_IMPORT_PARSE_FAIL=<dll> reason=<why>
    PAYLOAD_IMPORT_MISS=<module> imported_by=<dll> kind=<import|delay-import>
    PAYLOAD_FORBIDDEN_IMPORT=<module> imported_by=<dll> kind=<import|delay-import>
    PAYLOAD_TOTAL_BYTES=<n>
    PAYLOAD_COUNT=<n>
    PAYLOAD_MANIFEST_JSON=<path>
    RESULT=PASS|FAIL
    ERROR=PAYLOAD_INCOMPLETE missing=<comma list>
    ERROR=VULKAN_LOADER_NOT_FOUND searched=<semicolon list>
    ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=<importer> -> <missing> kind=<import|delay-import|parse>
    ERROR=PAYLOAD_FORBIDDEN_IMPORT dll=<dll> module=<module> kind=<import|delay-import>
    ERROR=PAYLOAD_IMPORT_SCAN_INCOMPLETE scanned=<n> staged=<n>
    ERROR=INVALID_PROFILE value=<v>
    ERROR=SOURCE_DIR_NOT_FOUND path=<p>
    ERROR=OUTDIR_NOT_WRITABLE path=<p> reason=<why>
    ERROR=PAYLOAD_MANIFEST_INVALID path=<p> reason=<why>
  PAYLOAD_COUNT is the number of files actually staged (core + present tool
  modules), i.e. the number of staged component lines; it is never more than
  the manifest core + tool-module total.

.EXIT CODES
  0  complete payload staged (or -AllowIncomplete probe completed)
  1  PAYLOAD_INCOMPLETE / VULKAN_LOADER_NOT_FOUND / PAYLOAD_IMPORT_UNRESOLVED /
     PAYLOAD_FORBIDDEN_IMPORT / PAYLOAD_IMPORT_SCAN_INCOMPLETE
  2  refused precondition (bad -Profile, source dir absent, manifest invalid,
     no write access to -OutDir)
  3  -SelfTest control failed

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -Profile release

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -Profile release -SourceDir '.opencode\tmp\3158\partial-payload'

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -SelfTest
#>
param(
    [string]$Profile = 'release',
    [string]$SourceDir = '',
    [string]$VulkanLoader = '',
    [string]$OutDir = '',
    [string]$ManifestPath = '',
    [switch]$AllowIncomplete,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$script:ScriptDir = $PSScriptRoot
$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
# -ManifestPath is state-machine-validated as defaultable: an explicit value is
# authoritative, otherwise the manifest beside this script is used.
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $script:ManifestPath = Join-Path $script:ScriptDir 'payload-manifest.json'
} else {
    $script:ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
}
$script:Captured = $null
$script:Manifest = $null
# Test-only seam: names that the import scan deliberately skips (CONTROL 11).
# Always empty outside -SelfTest.
$script:ScanSkipNames = @()

# Shared PE import/delay-import reader. Importing the module keeps ONE
# implementation for the stager and the installer gate (no duplicated
# extraction logic). The module file is a .psm1, so it is imported rather than
# dot-sourced (Windows PowerShell 5.1 does not publish a dot-sourced .psm1's
# functions into the caller's scope).
Import-Module (Join-Path $script:ScriptDir 'pe-imports.psm1') -Force

function Emit {
    param([string]$Line)
    if ($null -ne $script:Captured) {
        [void]$script:Captured.Add($Line)
    } else {
        # Write straight to the process stdout: the staging function returns an
        # exit code, so its report lines must never enter the pipeline (a
        # captured `$code = Invoke-PayloadStage ...` would otherwise collect the
        # whole transcript).
        [Console]::Out.WriteLine($Line)
    }
}

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
function Import-PayloadManifest {
    if (-not (Test-Path -LiteralPath $script:ManifestPath -PathType Leaf)) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=missing"
        return 2
    }

    $parsed = $null
    try {
        $raw = Get-Content -LiteralPath $script:ManifestPath -Raw -Encoding UTF8
        $parsed = $raw | ConvertFrom-Json
    } catch {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=unparsable"
        return 2
    }

    $core = @($parsed.core)
    $tools = @($parsed.toolModules)
    $excluded = @($parsed.excluded)
    $loaderName = [string]$parsed.vulkanLoader
    $roots = [string]$parsed.importClosure.roots
    $forbiddenRaw = @($parsed.importClosure.forbiddenImportPrefixes)

    if ($core.Count -eq 0 -or $tools.Count -eq 0 -or $excluded.Count -eq 0) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=empty-list"
        return 2
    }
    if ([string]::IsNullOrWhiteSpace($loaderName)) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=missing-closure-fields"
        return 2
    }
    if ($roots -ne 'all-staged') {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=import-closure-not-total value=$roots"
        return 2
    }

    $forbidden = @()
    foreach ($prefix in $forbiddenRaw) {
        if ([string]::IsNullOrWhiteSpace($prefix)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=missing-forbidden-prefixes"
            return 2
        }
        $forbidden += [string]$prefix
    }
    if ($forbidden.Count -eq 0) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=missing-forbidden-prefixes"
        return 2
    }

    $seen = @{}
    foreach ($name in @($core + $tools)) {
        if ([string]::IsNullOrWhiteSpace($name)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=blank-name"
            return 2
        }
        $key = $name.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=duplicate-name name=$name"
            return 2
        }
        $seen[$key] = $true
    }

    foreach ($name in $excluded) {
        if ($seen.ContainsKey($name.ToLowerInvariant())) {
            Emit 'RESULT=FAIL'
            Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=excluded-also-required name=$name"
            return 2
        }
    }

    $loaderInCore = $false
    foreach ($name in $core) {
        if ($name -ieq $loaderName) { $loaderInCore = $true }
    }
    if (-not $loaderInCore) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=loader-not-core name=$loaderName"
        return 2
    }

    $script:Manifest = [pscustomobject]@{
        Core              = $core
        ToolModules       = $tools
        Excluded          = $excluded
        VulkanLoader      = $loaderName
        ForbiddenPrefixes = $forbidden
    }
    return 0
}

# ---------------------------------------------------------------------------
# Vulkan loader discovery
# ---------------------------------------------------------------------------
function Get-VulkanLoaderCandidates {
    $name = $script:Manifest.VulkanLoader
    $list = New-Object System.Collections.ArrayList
    $sdk = $env:VULKAN_SDK

    if (-not [string]::IsNullOrWhiteSpace($sdk)) {
        [void]$list.Add((Join-Path $sdk ('runtime\x64\' + $name)))
        [void]$list.Add((Join-Path $sdk ('runtime\x86\' + $name)))
        $runtime = Join-Path $sdk 'runtime'
        if (Test-Path -LiteralPath $runtime -PathType Container) {
            $dirs = @(Get-ChildItem -LiteralPath $runtime -Directory -ErrorAction SilentlyContinue | Sort-Object Name)
            foreach ($dir in $dirs) {
                if ($dir.Name -ieq 'x64' -or $dir.Name -ieq 'x86') { continue }
                [void]$list.Add((Join-Path $dir.FullName $name))
                $nested = Join-Path $dir.FullName 'x64'
                if (Test-Path -LiteralPath $nested -PathType Container) {
                    [void]$list.Add((Join-Path $nested $name))
                }
            }
        }
        [void]$list.Add((Join-Path $sdk ('Bin\' + $name)))
        [void]$list.Add((Join-Path $sdk $name))
    } else {
        [void]$list.Add('<VULKAN_SDK unset>\runtime\x64\' + $name)
        [void]$list.Add('<VULKAN_SDK unset>\runtime\x86\' + $name)
        [void]$list.Add('<VULKAN_SDK unset>\runtime\*\' + $name)
        [void]$list.Add('<VULKAN_SDK unset>\Bin\' + $name)
        [void]$list.Add('<VULKAN_SDK unset>\' + $name)
    }

    if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
        [void]$list.Add((Join-Path (Join-Path $env:SystemRoot 'System32') $name))
    }

    return @($list)
}

function Resolve-VulkanLoader {
    param([string]$Override)

    $searched = New-Object System.Collections.ArrayList
    $foundPath = $null

    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        $candidate = [System.IO.Path]::GetFullPath($Override)
        [void]$searched.Add($candidate)
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Emit "PAYLOAD_VULKAN_CANDIDATE=$candidate status=hit"
            $foundPath = $candidate
        } else {
            Emit "PAYLOAD_VULKAN_CANDIDATE=$candidate status=miss"
        }
    } else {
        foreach ($candidate in @(Get-VulkanLoaderCandidates)) {
            [void]$searched.Add($candidate)
            if ($candidate.StartsWith('<')) {
                Emit "PAYLOAD_VULKAN_CANDIDATE=$candidate status=miss"
                continue
            }
            if ($null -ne $foundPath) {
                Emit "PAYLOAD_VULKAN_CANDIDATE=$candidate status=skipped"
                continue
            }
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                Emit "PAYLOAD_VULKAN_CANDIDATE=$candidate status=hit"
                $foundPath = $candidate
            } else {
                Emit "PAYLOAD_VULKAN_CANDIDATE=$candidate status=miss"
            }
        }
    }

    return [pscustomobject]@{
        Path     = $foundPath
        Searched = @($searched)
        Found    = ($null -ne $foundPath)
    }
}

# ---------------------------------------------------------------------------
# Staging (all-or-nothing)
# ---------------------------------------------------------------------------
function Invoke-PayloadStage {
    param(
        [string]$ProfileName,
        [string]$SourcePath,
        [string]$LoaderOverride,
        [string]$DestPath,
        [bool]$AllowMissing
    )

    if ($ProfileName -ne 'release' -and $ProfileName -ne 'debug') {
        Emit 'RESULT=FAIL'
        Emit "ERROR=INVALID_PROFILE value=$ProfileName"
        return 2
    }

    $sourceFull = [System.IO.Path]::GetFullPath($SourcePath)
    $destFull = [System.IO.Path]::GetFullPath($DestPath)
    Emit "PAYLOAD_SOURCE=$sourceFull"

    # Loader resolution precedes the source-dir check: an explicitly supplied
    # -VulkanLoader that does not resolve is a NAMED payload failure
    # (VULKAN_LOADER_NOT_FOUND), never a refused-precondition substitute.
    $loaderInfo = Resolve-VulkanLoader -Override $LoaderOverride
    if ($loaderInfo.Found) {
        Emit "PAYLOAD_VULKAN_LOADER=$($loaderInfo.Path) status=found"
    } else {
        Emit ("ERROR=VULKAN_LOADER_NOT_FOUND searched=" + ($loaderInfo.Searched -join ';'))
        if (-not $AllowMissing) {
            Emit 'RESULT=FAIL'
            return 1
        }
    }

    if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=SOURCE_DIR_NOT_FOUND path=$sourceFull"
        return 2
    }

    $entries = New-Object System.Collections.ArrayList
    $missingCore = New-Object System.Collections.ArrayList

    foreach ($name in $script:Manifest.Core) {
        if ($name -ieq $script:Manifest.VulkanLoader) {
            if ($loaderInfo.Found) {
                $len = (Get-Item -LiteralPath $loaderInfo.Path).Length
                if ($len -gt 0) {
                    [void]$entries.Add([pscustomobject]@{ Name = $name; Path = $loaderInfo.Path; Length = [int64]$len; Core = $true })
                } else {
                    [void]$missingCore.Add($name)
                    Emit "PAYLOAD_COMPONENT=$name status=MISSING"
                }
            } else {
                Emit "PAYLOAD_COMPONENT=$name status=MISSING"
            }
            continue
        }

        $candidate = Join-Path $sourceFull $name
        $staged = $false
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $len = (Get-Item -LiteralPath $candidate).Length
            if ($len -gt 0) {
                [void]$entries.Add([pscustomobject]@{ Name = $name; Path = $candidate; Length = [int64]$len; Core = $true })
                $staged = $true
            }
        }
        if (-not $staged) {
            [void]$missingCore.Add($name)
            Emit "PAYLOAD_COMPONENT=$name status=MISSING"
        }
    }

    foreach ($name in $script:Manifest.ToolModules) {
        $candidate = Join-Path $sourceFull $name
        $staged = $false
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $len = (Get-Item -LiteralPath $candidate).Length
            if ($len -gt 0) {
                [void]$entries.Add([pscustomobject]@{ Name = $name; Path = $candidate; Length = [int64]$len; Core = $false })
                $staged = $true
            }
        }
        if (-not $staged) {
            Emit "PAYLOAD_COMPONENT=$name status=MISSING"
        }
    }

    $hardFailure = $false
    if ($missingCore.Count -gt 0) {
        Emit ("ERROR=PAYLOAD_INCOMPLETE missing=" + ($missingCore -join ','))
        $hardFailure = $true
    }
    if ($hardFailure -and -not $AllowMissing) {
        Emit 'RESULT=FAIL'
        return 1
    }

    # Totality: every staged DLL is scanned (no hand-picked root subset). The
    # analytic registry is shared with the installer gate via pe-imports.psm1.
    $scanEntries = New-Object System.Collections.ArrayList
    foreach ($entry in $entries) {
        if ($script:ScanSkipNames -contains $entry.Name) { continue }
        [void]$scanEntries.Add($entry)
    }

    $scan = Get-PeImportScan -Entries @($scanEntries) -ForbiddenPrefixes @($script:Manifest.ForbiddenPrefixes)
    foreach ($dll in $scan.PerDll) {
        Emit "PAYLOAD_IMPORT_SCAN=$($dll.Name) imports=$($dll.ImportCount) delay=$($dll.DelayCount)"
    }
    foreach ($fail in $scan.ParseFails) {
        Emit "PAYLOAD_IMPORT_PARSE_FAIL=$($fail.Name) reason=$($fail.Reason)"
    }
    foreach ($miss in $scan.Misses) {
        Emit "PAYLOAD_IMPORT_MISS=$($miss.Missing) imported_by=$($miss.Importer) kind=$($miss.Kind)"
    }
    foreach ($forbidden in $scan.Forbidden) {
        Emit "PAYLOAD_FORBIDDEN_IMPORT=$($forbidden.Module) imported_by=$($forbidden.Importer) kind=$($forbidden.Kind)"
    }

    $scanIncomplete = ($scan.Scanned -ne $entries.Count)
    $scanFailed = ($scanIncomplete -or ($scan.ParseFails.Count -gt 0) -or ($scan.Misses.Count -gt 0) -or ($scan.Forbidden.Count -gt 0))
    if ($scanFailed -and -not $AllowMissing) {
        if ($scanIncomplete) {
            Emit "ERROR=PAYLOAD_IMPORT_SCAN_INCOMPLETE scanned=$($scan.Scanned) staged=$($entries.Count)"
        }
        foreach ($fail in $scan.ParseFails) {
            Emit "ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=$($fail.Name) -> <unparsable> kind=parse"
        }
        foreach ($forbidden in $scan.Forbidden) {
            Emit "ERROR=PAYLOAD_FORBIDDEN_IMPORT dll=$($forbidden.Importer) module=$($forbidden.Module) kind=$($forbidden.Kind)"
        }
        foreach ($miss in $scan.Misses) {
            Emit "ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=$($miss.Importer) -> $($miss.Missing) kind=$($miss.Kind)"
        }
        Emit 'RESULT=FAIL'
        return 1
    }

    # All-or-nothing: build a sibling temp directory, then swap it into place.
    $parent = Split-Path -Parent $destFull
    if ([string]::IsNullOrWhiteSpace($parent)) { $parent = $script:RepoRoot }
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        try {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        } catch {
            Emit 'RESULT=FAIL'
            Emit "ERROR=OUTDIR_NOT_WRITABLE path=$destFull reason=parent-create-failed"
            return 2
        }
    }

    $token = [guid]::NewGuid().ToString('N')
    $leaf = Split-Path -Leaf $destFull
    $tempDir = Join-Path $parent ('.' + $leaf + '.staging-' + $token)
    $backupDir = Join-Path $parent ('.' + $leaf + '.old-' + $token)

    try {
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    } catch {
        Emit 'RESULT=FAIL'
        Emit "ERROR=OUTDIR_NOT_WRITABLE path=$destFull reason=staging-create-failed"
        return 2
    }

    try {
        foreach ($entry in $entries) {
            Copy-Item -LiteralPath $entry.Path -Destination (Join-Path $tempDir $entry.Name) -Force -ErrorAction Stop
        }
    } catch {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        Emit 'RESULT=FAIL'
        Emit "ERROR=OUTDIR_NOT_WRITABLE path=$destFull reason=copy-failed"
        return 2
    }

    try {
        if (Test-Path -LiteralPath $destFull) {
            Move-Item -LiteralPath $destFull -Destination $backupDir -ErrorAction Stop
        }
        Move-Item -LiteralPath $tempDir -Destination $destFull -ErrorAction Stop
    } catch {
        if (Test-Path -LiteralPath $tempDir) {
            Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $backupDir) {
            Move-Item -LiteralPath $backupDir -Destination $destFull -ErrorAction SilentlyContinue
        }
        Emit 'RESULT=FAIL'
        Emit "ERROR=OUTDIR_NOT_WRITABLE path=$destFull reason=swap-failed"
        return 2
    }
    if (Test-Path -LiteralPath $backupDir) {
        Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $total = [int64]0
    foreach ($entry in $entries) {
        Emit "PAYLOAD_COMPONENT=$($entry.Name) status=staged bytes=$($entry.Length)"
        $total += $entry.Length
    }
    Emit "PAYLOAD_TOTAL_BYTES=$total"
    Emit "PAYLOAD_COUNT=$($entries.Count)"
    Emit "PAYLOAD_MANIFEST_JSON=$($script:ManifestPath)"
    Emit 'RESULT=PASS'
    return 0
}

# ---------------------------------------------------------------------------
# -SelfTest: hermetic instrument controls
# ---------------------------------------------------------------------------
function Invoke-StageCaptured {
    param(
        [string]$ProfileName,
        [string]$SourcePath,
        [string]$LoaderOverride,
        [string]$DestPath,
        [bool]$AllowMissing
    )
    $script:Captured = New-Object System.Collections.ArrayList
    $code = 99
    try {
        $code = Invoke-PayloadStage -ProfileName $ProfileName -SourcePath $SourcePath -LoaderOverride $LoaderOverride -DestPath $DestPath -AllowMissing $AllowMissing
    } catch {
        [void]$script:Captured.Add('RESULT=FAIL')
        [void]$script:Captured.Add("ERROR=SELFTEST_EXCEPTION $($_.Exception.Message)")
    }
    $lines = @($script:Captured)
    $script:Captured = $null
    return [pscustomobject]@{ Code = $code; Lines = $lines }
}

function Test-AnyLineMatches {
    param($Lines, [string]$Pattern)
    foreach ($line in $Lines) {
        if ($line -match $Pattern) { return $true }
    }
    return $false
}

function New-FixedSourceDir {
    param(
        [string]$Dir,
        [string[]]$Omit = @(),
        [hashtable]$ImportOverrides = @{},
        [hashtable]$DelayOverrides = @{}
    )

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null

    # Fixture imports are derived from the manifest's ROLES, never from a
    # second table of payload names: the loader imports only system modules,
    # every other core module imports the loader, tool modules import the first
    # non-loader core module, and excluded modules import a deliberately absent
    # module (so a leak into the staged set would fail the scan immediately).
    $loaderName = $script:Manifest.VulkanLoader
    $core = @($script:Manifest.Core)
    $tools = @($script:Manifest.ToolModules)
    $excluded = @($script:Manifest.Excluded)

    $anchorName = $null
    foreach ($name in $core) {
        if ($name -ine $loaderName) { $anchorName = $name; break }
    }

    $all = @()
    $all += $core
    $all += $tools
    $all += $excluded

    foreach ($name in $all) {
        if ($Omit -contains $name) { continue }
        $lower = $name.ToLowerInvariant()

        if ($excluded -contains $name) {
            $imports = @('fixture-absent-dependency.dll')
        } elseif ($tools -contains $name) {
            $imports = @('KERNEL32.dll')
            if ($null -ne $anchorName) { $imports = @($anchorName, 'KERNEL32.dll') }
        } elseif ($lower -eq $loaderName.ToLowerInvariant()) {
            $imports = @('KERNEL32.dll')
        } else {
            $imports = @('KERNEL32.dll')
            $imports += $loaderName
        }

        if ($ImportOverrides.ContainsKey($name)) { $imports = $ImportOverrides[$name] }
        $delays = @()
        if ($DelayOverrides.ContainsKey($name)) { $delays = $DelayOverrides[$name] }
        New-SyntheticPeDll -Path (Join-Path $Dir $name) -Imports $imports -DelayImports $delays
    }
}

function Get-StagedFileNames {
    param([string]$Dir)
    $names = @()
    if (Test-Path -LiteralPath $Dir -PathType Container) {
        $names = @(Get-ChildItem -LiteralPath $Dir -File | ForEach-Object { $_.Name })
    }
    return $names
}

function Invoke-SelfTest {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ('fredo-stage-engine-payload-selftest-' + [guid]::NewGuid().ToString('N'))
    $allPassed = $true

    try {
        New-Item -ItemType Directory -Path $root -Force | Out-Null

        $coreNames = @($script:Manifest.Core)
        $toolNames = @($script:Manifest.ToolModules)
        $expectedNames = @($coreNames + $toolNames)
        $loaderName = $script:Manifest.VulkanLoader
        $anchorName = $null
        foreach ($name in $coreNames) {
            if ($name -ine $loaderName) { $anchorName = $name; break }
        }
        $ghostName = 'fixture-absent-dependency.dll'
        $sslPrefix = [string]$script:Manifest.ForbiddenPrefixes[0]
        $cryptoPrefix = [string]$script:Manifest.ForbiddenPrefixes[0]
        if ($script:Manifest.ForbiddenPrefixes.Count -gt 1) {
            $cryptoPrefix = [string]$script:Manifest.ForbiddenPrefixes[1]
        }
        $forbiddenSslModule = $sslPrefix + '-3-x64.dll'
        $forbiddenCryptoModule = $cryptoPrefix + '-3-x64.dll'

        # ---- CONTROL 1 - POSITIVE -----------------------------------------
        $pass1 = $false
        $detail1 = ''
        try {
            $src1 = Join-Path $root 'src-positive'
            New-FixedSourceDir -Dir $src1
            $out1 = Join-Path $root 'out-positive'
            $run1 = Invoke-StageCaptured -ProfileName release -SourcePath $src1 -LoaderOverride (Join-Path $src1 $script:Manifest.VulkanLoader) -DestPath $out1 -AllowMissing $false
            $coreStaged = $true
            foreach ($name in $coreNames) {
                $pattern = '^PAYLOAD_COMPONENT=' + [regex]::Escape($name) + ' status=staged bytes=[1-9][0-9]*$'
                if (-not (Test-AnyLineMatches -Lines $run1.Lines -Pattern $pattern)) {
                    $coreStaged = $false
                    $detail1 = "no staged line for core name $name"
                }
            }
            $outNames = @(Get-StagedFileNames -Dir $out1)
            $filesPresent = $true
            foreach ($name in $coreNames) {
                if ($outNames -notcontains $name) { $filesPresent = $false; $detail1 = "missing file in out dir: $name" }
            }
            $pass1 = ($run1.Code -eq 0) -and (Test-AnyLineMatches -Lines $run1.Lines -Pattern '^RESULT=PASS$') -and $coreStaged -and $filesPresent
            if (-not $pass1 -and [string]::IsNullOrEmpty($detail1)) { $detail1 = "exit=$($run1.Code) lines=$($run1.Lines -join ' / ')" }
        } catch {
            $detail1 = $_.Exception.Message
        }
        Emit 'CONTROL 1 - POSITIVE'
        if ($pass1) { Emit '[PASS]' } else { Emit "[FAIL] $detail1"; $allPassed = $false }

        # ---- CONTROL 2 - MISSING-CORE -------------------------------------
        $pass2 = $false
        $detail2 = ''
        try {
            $src2 = Join-Path $root 'src-missing-core'
            New-FixedSourceDir -Dir $src2 -Omit @($anchorName)
            $out2 = Join-Path $root 'out-missing-core'
            New-Item -ItemType Directory -Path $out2 -Force | Out-Null
            $sentinel2 = Join-Path $out2 'sentinel.txt'
            Set-Content -LiteralPath $sentinel2 -Value 'untouched' -Encoding ASCII
            $run2 = Invoke-StageCaptured -ProfileName release -SourcePath $src2 -LoaderOverride (Join-Path $src2 $loaderName) -DestPath $out2 -AllowMissing $false
            $missingPattern = '^ERROR=PAYLOAD_INCOMPLETE missing=' + [regex]::Escape($anchorName) + '$'
            $pass2 = ($run2.Code -eq 1) -and
                     (Test-AnyLineMatches -Lines $run2.Lines -Pattern '^RESULT=FAIL$') -and
                     (Test-AnyLineMatches -Lines $run2.Lines -Pattern $missingPattern) -and
                     (Test-Path -LiteralPath $sentinel2 -PathType Leaf)
            if (-not $pass2) { $detail2 = "exit=$($run2.Code) lines=$($run2.Lines -join ' / ')" }
        } catch {
            $detail2 = $_.Exception.Message
        }
        Emit 'CONTROL 2 - MISSING-CORE'
        if ($pass2) { Emit '[PASS]' } else { Emit "[FAIL] $detail2"; $allPassed = $false }

        # ---- CONTROL 3 - MISSING-LOADER -----------------------------------
        $pass3 = $false
        $detail3 = ''
        try {
            $src3 = Join-Path $root 'src-missing-loader'
            New-FixedSourceDir -Dir $src3
            $out3 = Join-Path $root 'out-missing-loader'
            New-Item -ItemType Directory -Path $out3 -Force | Out-Null
            $sentinel3 = Join-Path $out3 'sentinel.txt'
            Set-Content -LiteralPath $sentinel3 -Value 'untouched' -Encoding ASCII
            $bogus = Join-Path $root ('no-such\' + $loaderName)
            $run3 = Invoke-StageCaptured -ProfileName release -SourcePath $src3 -LoaderOverride $bogus -DestPath $out3 -AllowMissing $false
            $pass3 = ($run3.Code -eq 1) -and
                     (Test-AnyLineMatches -Lines $run3.Lines -Pattern '^RESULT=FAIL$') -and
                     (Test-AnyLineMatches -Lines $run3.Lines -Pattern '^ERROR=VULKAN_LOADER_NOT_FOUND searched=.+$') -and
                     (Test-Path -LiteralPath $sentinel3 -PathType Leaf)
            if (-not $pass3) { $detail3 = "exit=$($run3.Code) lines=$($run3.Lines -join ' / ')" }
        } catch {
            $detail3 = $_.Exception.Message
        }
        Emit 'CONTROL 3 - MISSING-LOADER'
        if ($pass3) { Emit '[PASS]' } else { Emit "[FAIL] $detail3"; $allPassed = $false }

        # ---- CONTROL 4 - IMPORT-GAP ---------------------------------------
        $pass4 = $false
        $detail4 = ''
        try {
            $src4 = Join-Path $root 'src-import-gap'
            $overrides = @{}
            $overrides[$anchorName] = @($ghostName, 'KERNEL32.dll')
            New-FixedSourceDir -Dir $src4 -ImportOverrides $overrides
            $out4 = Join-Path $root 'out-import-gap'
            New-Item -ItemType Directory -Path $out4 -Force | Out-Null
            $sentinel4 = Join-Path $out4 'sentinel.txt'
            Set-Content -LiteralPath $sentinel4 -Value 'untouched' -Encoding ASCII
            $run4 = Invoke-StageCaptured -ProfileName release -SourcePath $src4 -LoaderOverride (Join-Path $src4 $loaderName) -DestPath $out4 -AllowMissing $false
            $missPattern = '^PAYLOAD_IMPORT_MISS=' + [regex]::Escape($ghostName) + ' imported_by=' + [regex]::Escape($anchorName) + ' kind=import$'
            $edgePattern = '^ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=' + [regex]::Escape($anchorName) + ' -> ' + [regex]::Escape($ghostName) + ' kind=import$'
            $pass4 = ($run4.Code -eq 1) -and
                     (Test-AnyLineMatches -Lines $run4.Lines -Pattern '^RESULT=FAIL$') -and
                     (Test-AnyLineMatches -Lines $run4.Lines -Pattern $missPattern) -and
                     (Test-AnyLineMatches -Lines $run4.Lines -Pattern $edgePattern) -and
                     (Test-Path -LiteralPath $sentinel4 -PathType Leaf)
            if (-not $pass4) { $detail4 = "exit=$($run4.Code) lines=$($run4.Lines -join ' / ')" }
        } catch {
            $detail4 = $_.Exception.Message
        }
        Emit 'CONTROL 4 - IMPORT-GAP'
        if ($pass4) { Emit '[PASS]' } else { Emit "[FAIL] $detail4"; $allPassed = $false }

        # ---- CONTROL 5 - NO-CUDA ------------------------------------------
        $pass5 = $false
        $detail5 = ''
        try {
            $src5 = Join-Path $root 'src-no-cuda'
            New-FixedSourceDir -Dir $src5
            $out5 = Join-Path $root 'out-no-cuda'
            $run5 = Invoke-StageCaptured -ProfileName release -SourcePath $src5 -LoaderOverride (Join-Path $src5 $loaderName) -DestPath $out5 -AllowMissing $false
            $excludedAbsent = $true
            foreach ($excludedName in $script:Manifest.Excluded) {
                if (Test-Path -LiteralPath (Join-Path $out5 $excludedName) -PathType Leaf) { $excludedAbsent = $false }
                $linePattern = '^PAYLOAD_COMPONENT=' + [regex]::Escape($excludedName) + ' '
                if (Test-AnyLineMatches -Lines $run5.Lines -Pattern $linePattern) { $excludedAbsent = $false }
            }
            $pass5 = ($run5.Code -eq 0) -and $excludedAbsent
            if (-not $pass5) { $detail5 = "exit=$($run5.Code) excludedAbsent=$excludedAbsent" }
        } catch {
            $detail5 = $_.Exception.Message
        }
        Emit 'CONTROL 5 - NO-CUDA'
        if ($pass5) { Emit '[PASS]' } else { Emit "[FAIL] $detail5"; $allPassed = $false }

        # ---- CONTROL 6 - IDEMPOTENT ---------------------------------------
        $pass6 = $false
        $detail6 = ''
        try {
            $src6 = Join-Path $root 'src-idempotent'
            New-FixedSourceDir -Dir $src6
            $out6 = Join-Path $root 'out-idempotent'
            $first = Invoke-StageCaptured -ProfileName release -SourcePath $src6 -LoaderOverride (Join-Path $src6 $loaderName) -DestPath $out6 -AllowMissing $false
            $staleOne = Join-Path $out6 'fixture-stale-module.dll'
            Set-Content -LiteralPath $staleOne -Value 'stale' -Encoding ASCII
            $staleTwo = Join-Path $out6 $script:Manifest.Excluded[0]
            Set-Content -LiteralPath $staleTwo -Value 'stale' -Encoding ASCII
            $second = Invoke-StageCaptured -ProfileName release -SourcePath $src6 -LoaderOverride (Join-Path $src6 $loaderName) -DestPath $out6 -AllowMissing $false
            $finalNames = @(Get-StagedFileNames -Dir $out6)
            $setExact = $true
            foreach ($name in $expectedNames) {
                if ($finalNames -notcontains $name) { $setExact = $false; $detail6 = "missing allowlisted file after second run: $name" }
            }
            foreach ($name in $finalNames) {
                if ($expectedNames -notcontains $name) { $setExact = $false; $detail6 = "stale file survived: $name" }
            }
            $pass6 = ($first.Code -eq 0) -and ($second.Code -eq 0) -and $setExact -and ($finalNames.Count -eq $expectedNames.Count)
            if (-not $pass6 -and [string]::IsNullOrEmpty($detail6)) { $detail6 = "first=$($first.Code) second=$($second.Code) files=$($finalNames -join ',')" }
        } catch {
            $detail6 = $_.Exception.Message
        }
        Emit 'CONTROL 6 - IDEMPOTENT'
        if ($pass6) { Emit '[PASS]' } else { Emit "[FAIL] $detail6"; $allPassed = $false }

        # ---- CONTROL 7 - SELF-REFERENCE -----------------------------------
        $pass7 = $false
        $detail7 = ''
        try {
            $scriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)
            $normalized = $scriptPath.Replace('/', '\').ToLowerInvariant()
            $outsideTarget = -not $normalized.Contains('\target\')
            $outsidePayload = -not $normalized.Contains('\engine-payload\')
            $present = Test-Path -LiteralPath $scriptPath -PathType Leaf
            $pass7 = $outsideTarget -and $outsidePayload -and $present
            if (-not $pass7) { $detail7 = "path=$scriptPath outsideTarget=$outsideTarget outsidePayload=$outsidePayload present=$present" }
        } catch {
            $detail7 = $_.Exception.Message
        }
        Emit 'CONTROL 7 - SELF-REFERENCE'
        if ($pass7) { Emit '[PASS]' } else { Emit "[FAIL] $detail7"; $allPassed = $false }

        # ---- CONTROL 8 - FORBIDDEN-IMPORT ---------------------------------
        # A load-time import whose module matches a manifest forbidden prefix
        # must fail staging with the named error (AC1 load-time leg).
        $pass8 = $false
        $detail8 = ''
        try {
            $src8 = Join-Path $root 'src-forbidden-import'
            $overrides8 = @{}
            $overrides8[$anchorName] = @($forbiddenSslModule, 'KERNEL32.dll')
            New-FixedSourceDir -Dir $src8 -ImportOverrides $overrides8
            $out8 = Join-Path $root 'out-forbidden-import'
            New-Item -ItemType Directory -Path $out8 -Force | Out-Null
            $sentinel8 = Join-Path $out8 'sentinel.txt'
            Set-Content -LiteralPath $sentinel8 -Value 'untouched' -Encoding ASCII
            $run8 = Invoke-StageCaptured -ProfileName release -SourcePath $src8 -LoaderOverride (Join-Path $src8 $loaderName) -DestPath $out8 -AllowMissing $false
            $report8 = '^PAYLOAD_FORBIDDEN_IMPORT=' + [regex]::Escape($forbiddenSslModule) + ' imported_by=' + [regex]::Escape($anchorName) + ' kind=import$'
            $error8 = '^ERROR=PAYLOAD_FORBIDDEN_IMPORT dll=' + [regex]::Escape($anchorName) + ' module=' + [regex]::Escape($forbiddenSslModule) + ' kind=import$'
            $pass8 = ($run8.Code -eq 1) -and
                     (Test-AnyLineMatches -Lines $run8.Lines -Pattern '^RESULT=FAIL$') -and
                     (Test-AnyLineMatches -Lines $run8.Lines -Pattern $report8) -and
                     (Test-AnyLineMatches -Lines $run8.Lines -Pattern $error8) -and
                     (Test-Path -LiteralPath $sentinel8 -PathType Leaf)
            if (-not $pass8) { $detail8 = "exit=$($run8.Code) lines=$($run8.Lines -join ' / ')" }
        } catch {
            $detail8 = $_.Exception.Message
        }
        Emit 'CONTROL 8 - FORBIDDEN-IMPORT'
        if ($pass8) { Emit '[PASS]' } else { Emit "[FAIL] $detail8"; $allPassed = $false }

        # ---- CONTROL 9 - DELAY-IMPORT -------------------------------------
        # A delay-load import on a forbidden module must fail staging too; a
        # reader that only reads DataDirectory[1] cannot see it (AC1 delay leg).
        $pass9 = $false
        $detail9 = ''
        try {
            $src9 = Join-Path $root 'src-delay-import'
            $delays9 = @{}
            $delays9[$anchorName] = @($forbiddenCryptoModule)
            New-FixedSourceDir -Dir $src9 -DelayOverrides $delays9
            $out9 = Join-Path $root 'out-delay-import'
            New-Item -ItemType Directory -Path $out9 -Force | Out-Null
            $sentinel9 = Join-Path $out9 'sentinel.txt'
            Set-Content -LiteralPath $sentinel9 -Value 'untouched' -Encoding ASCII
            $run9 = Invoke-StageCaptured -ProfileName release -SourcePath $src9 -LoaderOverride (Join-Path $src9 $loaderName) -DestPath $out9 -AllowMissing $false
            $report9 = '^PAYLOAD_FORBIDDEN_IMPORT=' + [regex]::Escape($forbiddenCryptoModule) + ' imported_by=' + [regex]::Escape($anchorName) + ' kind=delay-import$'
            $error9 = '^ERROR=PAYLOAD_FORBIDDEN_IMPORT dll=' + [regex]::Escape($anchorName) + ' module=' + [regex]::Escape($forbiddenCryptoModule) + ' kind=delay-import$'
            $pass9 = ($run9.Code -eq 1) -and
                     (Test-AnyLineMatches -Lines $run9.Lines -Pattern '^RESULT=FAIL$') -and
                     (Test-AnyLineMatches -Lines $run9.Lines -Pattern $report9) -and
                     (Test-AnyLineMatches -Lines $run9.Lines -Pattern $error9) -and
                     (Test-Path -LiteralPath $sentinel9 -PathType Leaf)
            if (-not $pass9) { $detail9 = "exit=$($run9.Code) lines=$($run9.Lines -join ' / ')" }
        } catch {
            $detail9 = $_.Exception.Message
        }
        Emit 'CONTROL 9 - DELAY-IMPORT'
        if ($pass9) { Emit '[PASS]' } else { Emit "[FAIL] $detail9"; $allPassed = $false }

        # ---- CONTROL 10 - NON-ROOT-IMPORT-GAP -----------------------------
        # A TOOL MODULE with an unresolvable non-system import must fail. The
        # old roots-only gate (loader + ggml* + two exact roots) never scanned
        # a tool module, so this control is the AC2 discriminator.
        $pass10 = $false
        $detail10 = ''
        try {
            $toolModule = $toolNames[0]
            $src10 = Join-Path $root 'src-non-root-gap'
            $overrides10 = @{}
            $overrides10[$toolModule] = @($ghostName, 'KERNEL32.dll')
            New-FixedSourceDir -Dir $src10 -ImportOverrides $overrides10
            $out10 = Join-Path $root 'out-non-root-gap'
            New-Item -ItemType Directory -Path $out10 -Force | Out-Null
            $sentinel10 = Join-Path $out10 'sentinel.txt'
            Set-Content -LiteralPath $sentinel10 -Value 'untouched' -Encoding ASCII
            $run10 = Invoke-StageCaptured -ProfileName release -SourcePath $src10 -LoaderOverride (Join-Path $src10 $loaderName) -DestPath $out10 -AllowMissing $false
            $miss10 = '^PAYLOAD_IMPORT_MISS=' + [regex]::Escape($ghostName) + ' imported_by=' + [regex]::Escape($toolModule) + ' kind=import$'
            $edge10 = '^ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=' + [regex]::Escape($toolModule) + ' -> ' + [regex]::Escape($ghostName) + ' kind=import$'
            $pass10 = ($run10.Code -eq 1) -and
                      (Test-AnyLineMatches -Lines $run10.Lines -Pattern '^RESULT=FAIL$') -and
                      (Test-AnyLineMatches -Lines $run10.Lines -Pattern $miss10) -and
                      (Test-AnyLineMatches -Lines $run10.Lines -Pattern $edge10) -and
                      (Test-Path -LiteralPath $sentinel10 -PathType Leaf)
            if (-not $pass10) { $detail10 = "exit=$($run10.Code) lines=$($run10.Lines -join ' / ')" }
        } catch {
            $detail10 = $_.Exception.Message
        }
        Emit 'CONTROL 10 - NON-ROOT-IMPORT-GAP'
        if ($pass10) { Emit '[PASS]' } else { Emit "[FAIL] $detail10"; $allPassed = $false }

        # ---- CONTROL 11 - IMPORT-SCAN-COMPLETE ----------------------------
        # A deliberately skipped DLL must raise the named completeness error
        # (scanned < staged) instead of a silent partial proof.
        $pass11 = $false
        $detail11 = ''
        try {
            $src11 = Join-Path $root 'src-scan-complete'
            New-FixedSourceDir -Dir $src11
            $out11 = Join-Path $root 'out-scan-complete'
            New-Item -ItemType Directory -Path $out11 -Force | Out-Null
            $sentinel11 = Join-Path $out11 'sentinel.txt'
            Set-Content -LiteralPath $sentinel11 -Value 'untouched' -Encoding ASCII
            $skipName = $coreNames[0]
            $script:ScanSkipNames = @($skipName)
            try {
                $run11 = Invoke-StageCaptured -ProfileName release -SourcePath $src11 -LoaderOverride (Join-Path $src11 $loaderName) -DestPath $out11 -AllowMissing $false
            } finally {
                $script:ScanSkipNames = @()
            }
            $scanCount = 0
            foreach ($line in $run11.Lines) {
                if ($line -match '^PAYLOAD_IMPORT_SCAN=.+ imports=[0-9]+ delay=[0-9]+$') { $scanCount++ }
            }
            $incomplete = $false
            $scannedCount = 0
            $stagedCount = 0
            foreach ($line in $run11.Lines) {
                if ($line -match '^ERROR=PAYLOAD_IMPORT_SCAN_INCOMPLETE scanned=([0-9]+) staged=([0-9]+)$') {
                    $incomplete = $true
                    $scannedCount = [int]$Matches[1]
                    $stagedCount = [int]$Matches[2]
                }
            }
            $pass11 = ($run11.Code -eq 1) -and
                      (Test-AnyLineMatches -Lines $run11.Lines -Pattern '^RESULT=FAIL$') -and
                      $incomplete -and
                      ($scannedCount -eq ($stagedCount - 1)) -and
                      ($stagedCount -eq $expectedNames.Count) -and
                      ($scanCount -eq ($stagedCount - 1)) -and
                      (Test-Path -LiteralPath $sentinel11 -PathType Leaf)
            if (-not $pass11) { $detail11 = "exit=$($run11.Code) incomplete=$incomplete scanned=$scannedCount staged=$stagedCount scanLines=$scanCount lines=$($run11.Lines -join ' / ')" }
        } catch {
            $detail11 = $_.Exception.Message
        } finally {
            $script:ScanSkipNames = @()
        }
        Emit 'CONTROL 11 - IMPORT-SCAN-COMPLETE'
        if ($pass11) { Emit '[PASS]' } else { Emit "[FAIL] $detail11"; $allPassed = $false }
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
$manifestCode = Import-PayloadManifest
if ($manifestCode -ne 0) { exit $manifestCode }

if ($SelfTest) {
    exit (Invoke-SelfTest)
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $resolvedOutDir = Join-Path $script:RepoRoot 'apps\tauri\src-tauri\engine-payload'
} else {
    $resolvedOutDir = $OutDir
}

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $resolvedSourceDir = Join-Path $script:RepoRoot ('apps\tauri\src-tauri\target\' + $Profile)
} else {
    $resolvedSourceDir = $SourceDir
}

$stageCode = Invoke-PayloadStage -ProfileName $Profile -SourcePath $resolvedSourceDir -LoaderOverride $VulkanLoader -DestPath $resolvedOutDir -AllowMissing ([bool]$AllowIncomplete)
exit $stageCode
