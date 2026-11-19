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
    4. Parses each root DLL's PE import directory, resolves every non-system
       import by bare file name against the staged set, and reports each
       unresolved edge (PAYLOAD_IMPORT_MISS / ERROR=PAYLOAD_IMPORT_UNRESOLVED).
       System imports (kernel32/advapi32/msvcp*/vcruntime*/api-ms-win-*/...)
       are allowlisted by prefix.
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
  Run the seven instrument controls (synthetic fixtures, hermetic) and exit 0
  only if all pass, else 3. Ends with a single SELFTEST: PASS|FAIL line.

.OUTPUT
  One machine-greppable line per fact:
    PAYLOAD_SOURCE=<dir>
    PAYLOAD_VULKAN_CANDIDATE=<path> status=hit|miss|skipped
    PAYLOAD_VULKAN_LOADER=<path> status=found
    PAYLOAD_COMPONENT=<name> status=staged bytes=<n>
    PAYLOAD_COMPONENT=<name> status=MISSING
    PAYLOAD_IMPORT_PARSE_FAIL=<dll> reason=<why>
    PAYLOAD_IMPORT_MISS=<dll> imported_by=<dll>
    PAYLOAD_TOTAL_BYTES=<n>
    PAYLOAD_COUNT=<n>
    PAYLOAD_MANIFEST_JSON=<path>
    RESULT=PASS|FAIL
    ERROR=PAYLOAD_INCOMPLETE missing=<comma list>
    ERROR=VULKAN_LOADER_NOT_FOUND searched=<semicolon list>
    ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=<importer> -> <missing>
    ERROR=INVALID_PROFILE value=<v>
    ERROR=SOURCE_DIR_NOT_FOUND path=<p>
    ERROR=OUTDIR_NOT_WRITABLE path=<p> reason=<why>
    ERROR=PAYLOAD_MANIFEST_INVALID path=<p> reason=<why>
  PAYLOAD_COUNT is the number of files actually staged (core + present tool
  modules), i.e. the number of staged component lines; it is never more than
  the manifest core + tool-module total.

.EXIT CODES
  0  complete payload staged (or -AllowIncomplete probe completed)
  1  PAYLOAD_INCOMPLETE / VULKAN_LOADER_NOT_FOUND / PAYLOAD_IMPORT_UNRESOLVED
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
    [switch]$AllowIncomplete,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$script:ScriptDir = $PSScriptRoot
$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$script:ManifestPath = Join-Path $script:ScriptDir 'payload-manifest.json'
$script:Captured = $null
$script:Manifest = $null

# Non-payload parser policy: imports matching these prefixes are Windows system
# libraries (or the universal CRT API sets) and are expected to come from the
# operating system, not from the payload. Matched case-insensitively.
$script:SystemImportPrefixes = @(
    'kernel32', 'kernelbase', 'ntdll', 'advapi32', 'user32', 'gdi32', 'shell32',
    'shlwapi', 'ole32', 'oleaut32', 'comdlg32', 'comctl32', 'ws2_32', 'wsock32',
    'mswsock', 'iphlpapi', 'bcrypt', 'crypt32', 'secur32', 'sspicli', 'rpcrt4',
    'dbghelp', 'powrprof', 'psapi', 'setupapi', 'version', 'imm32', 'dwmapi',
    'uxtheme', 'winmm', 'winhttp', 'wininet', 'wintrust', 'd3d11', 'd3d12',
    'dxgi', 'd3dcompiler', 'opengl32', 'glu32', 'msvcp', 'msvcr', 'vcruntime',
    'ucrtbase', 'api-ms-win-', 'ext-ms-', 'concrt', 'vcomp', 'mscoree',
    'propsys', 'urlmon', 'shcore', 'sxs', 'cfgmgr32', 'devobj', 'wtsapi32',
    'cryptbase', 'ncrypt', 'normaliz', 'wldap32'
)

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
    $rootExact = @($parsed.importClosure.rootExact)
    $rootPrefix = [string]$parsed.importClosure.rootPrefix

    if ($core.Count -eq 0 -or $tools.Count -eq 0 -or $excluded.Count -eq 0) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=empty-list"
        return 2
    }
    if ([string]::IsNullOrWhiteSpace($loaderName) -or $rootExact.Count -eq 0 -or [string]::IsNullOrWhiteSpace($rootPrefix)) {
        Emit 'RESULT=FAIL'
        Emit "ERROR=PAYLOAD_MANIFEST_INVALID path=$($script:ManifestPath) reason=missing-closure-fields"
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
        Core         = $core
        ToolModules  = $tools
        Excluded     = $excluded
        VulkanLoader = $loaderName
        RootExact    = $rootExact
        RootPrefix   = $rootPrefix
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
# PE import-directory reader (manual BinaryReader over the DOS/PE headers)
# ---------------------------------------------------------------------------
function Get-PeImportNames {
    param([string]$Path)

    $result = [pscustomobject]@{ Ok = $false; Imports = @(); Error = '' }

    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
    } catch {
        $result.Error = 'read-failed'
        return $result
    }

    if ($bytes.Length -lt 64) { $result.Error = 'file-too-small'; return $result }
    if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { $result.Error = 'no-mz'; return $result }

    $e = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($e -lt 0 -or ($e + 24) -ge $bytes.Length) { $result.Error = 'bad-e-lfanew'; return $result }
    if ($bytes[$e] -ne 0x50 -or $bytes[$e + 1] -ne 0x45 -or $bytes[$e + 2] -ne 0 -or $bytes[$e + 3] -ne 0) {
        $result.Error = 'no-pe-signature'
        return $result
    }

    $coff = $e + 4
    $numSections = [BitConverter]::ToUInt16($bytes, $coff + 2)
    $sizeOpt = [BitConverter]::ToUInt16($bytes, $coff + 16)
    $opt = $coff + 20
    if (($opt + 2) -gt $bytes.Length) { $result.Error = 'bad-optional-header'; return $result }

    $magic = [BitConverter]::ToUInt16($bytes, $opt)
    if ($magic -eq 0x10B) {
        $numDirsOff = $opt + 92
        $dirsOff = $opt + 96
    } elseif ($magic -eq 0x20B) {
        $numDirsOff = $opt + 108
        $dirsOff = $opt + 112
    } else {
        $result.Error = 'bad-optional-magic'
        return $result
    }
    if (($dirsOff + 16) -gt $bytes.Length) { $result.Error = 'truncated-data-directories'; return $result }

    $numDirs = [BitConverter]::ToUInt32($bytes, $numDirsOff)
    if ($numDirs -lt 2) { $result.Ok = $true; return $result }

    $importRva = [BitConverter]::ToUInt32($bytes, $dirsOff + 8)
    if ($importRva -eq 0) { $result.Ok = $true; return $result }

    $sectionTable = $opt + $sizeOpt
    if (($sectionTable + ($numSections * 40)) -gt $bytes.Length) { $result.Error = 'bad-section-table'; return $result }

    $mapRva = {
        param([uint32]$rva)
        for ($i = 0; $i -lt $numSections; $i++) {
            $s = $sectionTable + ($i * 40)
            $vsize = [BitConverter]::ToUInt32($bytes, $s + 8)
            $va = [BitConverter]::ToUInt32($bytes, $s + 12)
            $rawSize = [BitConverter]::ToUInt32($bytes, $s + 16)
            $rawPtr = [BitConverter]::ToUInt32($bytes, $s + 20)
            $span = [Math]::Max([int64]$vsize, [int64]$rawSize)
            if ($rva -ge $va -and ([int64]$rva -lt ([int64]$va + $span))) {
                return [int]([int64]$rawPtr + ([int64]$rva - [int64]$va))
            }
        }
        return -1
    }

    $importOff = & $mapRva $importRva
    if ($importOff -lt 0 -or $importOff -ge $bytes.Length) { $result.Error = 'import-rva-unmapped'; return $result }

    $imports = New-Object System.Collections.ArrayList
    $index = 0
    while ($index -lt 4096) {
        $off = $importOff + ($index * 20)
        if (($off + 20) -gt $bytes.Length) { break }
        $oft = [BitConverter]::ToUInt32($bytes, $off)
        $nameRva = [BitConverter]::ToUInt32($bytes, $off + 12)
        $ft = [BitConverter]::ToUInt32($bytes, $off + 16)
        if ($nameRva -eq 0 -and $oft -eq 0 -and $ft -eq 0) { break }
        if ($nameRva -ne 0) {
            $nameOff = & $mapRva $nameRva
            if ($nameOff -ge 0 -and $nameOff -lt $bytes.Length) {
                $end = $nameOff
                $max = [Math]::Min($bytes.Length, $nameOff + 260)
                while ($end -lt $max -and $bytes[$end] -ne 0) { $end++ }
                if ($end -gt $nameOff) {
                    $name = [System.Text.Encoding]::ASCII.GetString($bytes, $nameOff, ($end - $nameOff))
                    if (-not [string]::IsNullOrWhiteSpace($name)) { [void]$imports.Add($name) }
                }
            }
        }
        $index++
    }

    $result.Imports = @($imports)
    $result.Ok = $true
    return $result
}

function Test-SystemImportName {
    param([string]$Name)
    $lower = $Name.ToLowerInvariant()
    foreach ($prefix in $script:SystemImportPrefixes) {
        if ($lower.StartsWith($prefix)) { return $true }
    }
    return $false
}

function Get-ImportClosureResult {
    param($Entries)

    $names = @{}
    foreach ($entry in $Entries) { $names[$entry.Name.ToLowerInvariant()] = $true }

    $loaderLower = $script:Manifest.VulkanLoader.ToLowerInvariant()
    $prefixLower = $script:Manifest.RootPrefix.ToLowerInvariant()
    $roots = @()
    foreach ($entry in $Entries) {
        $lower = $entry.Name.ToLowerInvariant()
        $isRoot = $false
        if ($lower -eq $loaderLower) { $isRoot = $true }
        if ($lower.StartsWith($prefixLower)) { $isRoot = $true }
        foreach ($exact in $script:Manifest.RootExact) {
            if ($lower -eq $exact.ToLowerInvariant()) { $isRoot = $true }
        }
        if ($isRoot) { $roots += $entry }
    }

    $misses = New-Object System.Collections.ArrayList
    $parseFails = New-Object System.Collections.ArrayList
    foreach ($root in $roots) {
        $info = Get-PeImportNames -Path $root.Path
        if (-not $info.Ok) {
            [void]$parseFails.Add([pscustomobject]@{ Name = $root.Name; Reason = $info.Error })
            continue
        }
        foreach ($dep in $info.Imports) {
            $dl = $dep.ToLowerInvariant()
            if ($dl -eq $root.Name.ToLowerInvariant()) { continue }
            if (Test-SystemImportName -Name $dl) { continue }
            if ($names.ContainsKey($dl)) { continue }
            [void]$misses.Add([pscustomobject]@{ Missing = $dep; By = $root.Name })
        }
    }

    return [pscustomobject]@{ Misses = @($misses); ParseFails = @($parseFails) }
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

    $closure = Get-ImportClosureResult -Entries @($entries)
    foreach ($fail in $closure.ParseFails) {
        Emit "PAYLOAD_IMPORT_PARSE_FAIL=$($fail.Name) reason=$($fail.Reason)"
    }
    foreach ($miss in $closure.Misses) {
        Emit "PAYLOAD_IMPORT_MISS=$($miss.Missing) imported_by=$($miss.By)"
    }
    $closureFailed = (($closure.Misses.Count -gt 0) -or ($closure.ParseFails.Count -gt 0))
    if ($closureFailed -and -not $AllowMissing) {
        foreach ($fail in $closure.ParseFails) {
            Emit "ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=$($fail.Name) -> <unparsable>"
        }
        foreach ($miss in $closure.Misses) {
            Emit "ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=$($miss.By) -> $($miss.Missing)"
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

function PeWriteU16 {
    param([byte[]]$Buffer, [int]$Offset, [uint32]$Value)
    $encoded = [BitConverter]::GetBytes([uint16]$Value)
    [Array]::Copy($encoded, 0, $Buffer, $Offset, 2)
}

function PeWriteU32 {
    param([byte[]]$Buffer, [int]$Offset, [uint32]$Value)
    $encoded = [BitConverter]::GetBytes([uint32]$Value)
    [Array]::Copy($encoded, 0, $Buffer, $Offset, 4)
}

function PeWriteU64 {
    param([byte[]]$Buffer, [int]$Offset, [uint64]$Value)
    $encoded = [BitConverter]::GetBytes([uint64]$Value)
    [Array]::Copy($encoded, 0, $Buffer, $Offset, 8)
}

# Write a structurally valid PE32+ DLL whose import directory names exactly the
# given modules. Only this script's reader ever consumes the file; it is a
# fixture, never loaded.
function New-SyntheticPeDll {
    param([string]$Path, [string[]]$Imports = @())

    $imports = @($Imports | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $descCount = $imports.Count + 1
    $descBytes = $descCount * 20

    $stringOffsets = @()
    $cursor = $descBytes
    foreach ($imp in $imports) {
        $stringOffsets += $cursor
        $cursor += $imp.Length + 1
    }

    $rawLen = [int]([Math]::Ceiling($cursor / 512.0) * 512)
    if ($rawLen -lt 512) { $rawLen = 512 }
    $total = 0x200 + $rawLen
    $buffer = New-Object byte[] $total

    $mz = [byte[]](0x4D, 0x5A)
    [Array]::Copy($mz, 0, $buffer, 0, 2)
    PeWriteU32 $buffer 0x3C 0x40

    $pe = [byte[]](0x50, 0x45, 0x00, 0x00)
    [Array]::Copy($pe, 0, $buffer, 0x40, 4)
    PeWriteU16 $buffer 0x44 0x8664   # Machine: AMD64
    PeWriteU16 $buffer 0x46 1        # NumberOfSections
    PeWriteU16 $buffer 0x54 240      # SizeOfOptionalHeader (PE32+)
    PeWriteU16 $buffer 0x56 0x2022   # Characteristics: DLL | EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

    PeWriteU16 $buffer 0x58 0x20B    # Optional header magic: PE32+
    PeWriteU32 $buffer 0x68 0         # AddressOfEntryPoint
    PeWriteU32 $buffer 0x6C 0x1000    # BaseOfCode
    PeWriteU64 $buffer 0x70 0         # ImageBase
    PeWriteU32 $buffer 0x78 0x1000    # SectionAlignment
    PeWriteU32 $buffer 0x7C 0x200     # FileAlignment
    PeWriteU16 $buffer 0x88 6         # MajorSubsystemVersion
    PeWriteU32 $buffer 0x90 0x2000    # SizeOfImage
    PeWriteU32 $buffer 0x94 0x200     # SizeOfHeaders
    PeWriteU16 $buffer 0x9C 3         # Subsystem: console
    PeWriteU32 $buffer 0xC4 16        # NumberOfRvaAndSizes
    PeWriteU32 $buffer 0xD0 0x1000    # DataDirectory[IMPORT].VirtualAddress
    PeWriteU32 $buffer 0xD4 ([uint32]$descBytes)

    $sectionName = [System.Text.Encoding]::ASCII.GetBytes('.rdata')
    [Array]::Copy($sectionName, 0, $buffer, 0x148, $sectionName.Length)
    PeWriteU32 $buffer 0x150 ([uint32]$rawLen)  # VirtualSize
    PeWriteU32 $buffer 0x154 0x1000              # VirtualAddress
    PeWriteU32 $buffer 0x158 ([uint32]$rawLen)  # SizeOfRawData
    PeWriteU32 $buffer 0x15C 0x200               # PointerToRawData
    PeWriteU32 $buffer 0x16C 0x40000040          # INITIALIZED_DATA | READ

    for ($i = 0; $i -lt $imports.Count; $i++) {
        $descOff = 0x200 + ($i * 20)
        PeWriteU32 $buffer ($descOff + 12) ([uint32](0x1000 + $stringOffsets[$i]))
        $nameBytes = [System.Text.Encoding]::ASCII.GetBytes($imports[$i])
        [Array]::Copy($nameBytes, 0, $buffer, (0x200 + $stringOffsets[$i]), $nameBytes.Length)
    }

    [System.IO.File]::WriteAllBytes($Path, $buffer)
}

function New-FixedSourceDir {
    param([string]$Dir, [string[]]$Omit = @(), [hashtable]$ImportOverrides = @{})

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null

    # Fixture imports are derived from the manifest's ROLES, never from a
    # second table of payload names: the loader imports only system modules,
    # every other core module imports the loader plus the first root-prefix
    # module, tool modules import the anchor root module, and excluded modules
    # import a deliberately absent module (so a leak into the staged set would
    # fail the closure proof immediately).
    $loaderName = $script:Manifest.VulkanLoader
    $prefix = $script:Manifest.RootPrefix.ToLowerInvariant()
    $core = @($script:Manifest.Core)
    $tools = @($script:Manifest.ToolModules)
    $excluded = @($script:Manifest.Excluded)

    $baseName = $null
    foreach ($name in $core) {
        $lower = $name.ToLowerInvariant()
        if ($lower -ne $loaderName.ToLowerInvariant() -and $lower.StartsWith($prefix) -and $null -eq $baseName) {
            $baseName = $name
        }
    }
    $anchorName = $null
    foreach ($exact in $script:Manifest.RootExact) {
        if ($null -eq $anchorName) { $anchorName = $exact }
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
            if ($null -ne $baseName -and $lower -ne $baseName.ToLowerInvariant()) { $imports += $baseName }
            $imports += $loaderName
        }

        if ($ImportOverrides.ContainsKey($name)) { $imports = $ImportOverrides[$name] }
        New-SyntheticPeDll -Path (Join-Path $Dir $name) -Imports $imports
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
        $anchorName = $script:Manifest.RootExact[0]
        $ghostName = 'fixture-absent-dependency.dll'

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
            $missPattern = '^PAYLOAD_IMPORT_MISS=' + [regex]::Escape($ghostName) + ' imported_by=' + [regex]::Escape($anchorName) + '$'
            $edgePattern = '^ERROR=PAYLOAD_IMPORT_UNRESOLVED edge=' + [regex]::Escape($anchorName) + ' -> ' + [regex]::Escape($ghostName) + '$'
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
