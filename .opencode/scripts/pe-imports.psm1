<#
Shared PE import-table reader for the Fredo payload gates (Spec #3172).

Imported (Import-Module) by .opencode/scripts/stage-engine-payload.ps1 and by
the installer gate so both gates share ONE implementation and cannot drift.

Functions:
  Get-PeImportTable      Parse the import directory (DataDirectory[1]) AND the
                         delay-import directory (DataDirectory[13]) of a PE
                         file. Returns Ok/Imports/DelayImports/Error.
  Test-SystemImportName  Windows system prefix allowlist (case-insensitive).
  Get-PeImportScan       Scan a set of staged DLLs and classify every import
                         as staged, system, forbidden or unresolved.
  New-SyntheticPeDll     Write a minimal, structurally valid PE that imports
                         the named modules (load-time and delay-load). Used by
                         the self-tests, so no hand-authored binary ships.

Error vocabulary (Get-PeImportTable.Error):
  read-failed, file-too-small, no-mz, bad-e-lfanew, no-pe-signature,
  bad-optional-header, bad-optional-magic, truncated-data-directories,
  bad-section-table, import-rva-unmapped, delay-import-rva-unmapped,
  delay-import-va-unsupported
#>

# Non-payload parser policy: imports matching these prefixes are Windows
# system libraries (or the universal CRT API sets) and are expected to come
# from the operating system, not from the payload. Matched case-insensitively.
$script:PeSystemImportPrefixes = @(
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

function Test-SystemImportName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    $lower = $Name.ToLowerInvariant()
    foreach ($prefix in $script:PeSystemImportPrefixes) {
        if ($lower.StartsWith($prefix)) { return $true }
    }
    return $false
}

function Get-PeImportTable {
    param([string]$Path)

    $result = [pscustomobject]@{ Ok = $false; Imports = @(); DelayImports = @(); Error = '' }

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
    $imageBase = [uint64]0
    if ($magic -eq 0x10B) {
        $numDirsOff = $opt + 92
        $dirsOff = $opt + 96
        $imageBase = [uint64][BitConverter]::ToUInt32($bytes, $opt + 28)
    } elseif ($magic -eq 0x20B) {
        $numDirsOff = $opt + 108
        $dirsOff = $opt + 112
        $imageBase = [BitConverter]::ToUInt64($bytes, $opt + 24)
    } else {
        $result.Error = 'bad-optional-magic'
        return $result
    }
    if (($dirsOff + 16) -gt $bytes.Length) { $result.Error = 'truncated-data-directories'; return $result }

    $numDirs = [BitConverter]::ToUInt32($bytes, $numDirsOff)
    $dirsEntries = [int][Math]::Min([int64]$numDirs, [int64]16)
    if (($dirsOff + ($dirsEntries * 8)) -gt $bytes.Length) { $result.Error = 'truncated-data-directories'; return $result }

    $importRva = [uint32]0
    if ($dirsEntries -ge 2) {
        $importRva = [BitConverter]::ToUInt32($bytes, $dirsOff + 8)
    }
    $delayRva = [uint32]0
    if ($dirsEntries -ge 14) {
        $delayRva = [BitConverter]::ToUInt32($bytes, $dirsOff + (13 * 8))
    }

    if ($importRva -eq 0 -and $delayRva -eq 0) {
        $result.Ok = $true
        return $result
    }

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

    $readName = {
        param([int64]$nameOff)
        if ($nameOff -lt 0 -or $nameOff -ge $bytes.Length) { return $null }
        $end = $nameOff
        $max = [Math]::Min($bytes.Length, $nameOff + 260)
        while ($end -lt $max -and $bytes[$end] -ne 0) { $end++ }
        if ($end -le $nameOff) { return $null }
        return [System.Text.Encoding]::ASCII.GetString($bytes, [int]$nameOff, [int]($end - $nameOff))
    }

    # ---- load-time imports: DataDirectory[1] ------------------------------
    $imports = New-Object System.Collections.ArrayList
    if ($importRva -ne 0) {
        $importOff = & $mapRva $importRva
        if ($importOff -lt 0 -or $importOff -ge $bytes.Length) { $result.Error = 'import-rva-unmapped'; return $result }

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
                    $name = & $readName $nameOff
                    if (-not [string]::IsNullOrWhiteSpace($name)) { [void]$imports.Add($name) }
                }
            }
            $index++
        }
    }

    # ---- delay imports: DataDirectory[13] ---------------------------------
    # IMG_DELAYLOAD_DESCRIPTOR is 32 bytes; rvaDLLName is at +4. When
    # Attributes bit 0 is clear the name field is a VA and is converted with
    # this image's ImageBase.
    $delays = New-Object System.Collections.ArrayList
    if ($delayRva -ne 0) {
        $delayOff = & $mapRva $delayRva
        if ($delayOff -lt 0 -or $delayOff -ge $bytes.Length) { $result.Error = 'delay-import-rva-unmapped'; return $result }

        $index = 0
        while ($index -lt 4096) {
            $off = $delayOff + ($index * 32)
            if (($off + 32) -gt $bytes.Length) { break }
            $attributes = [BitConverter]::ToUInt32($bytes, $off)
            $nameField = [BitConverter]::ToUInt32($bytes, $off + 4)
            if ($attributes -eq 0 -and $nameField -eq 0) { break }
            if ($nameField -ne 0) {
                $nameRva = [uint64]0
                if (($attributes -band 1) -eq 1) {
                    $nameRva = [uint64]$nameField
                } else {
                    if ([uint64]$nameField -lt [uint64]$imageBase) {
                        $result.Error = 'delay-import-va-unsupported'
                        return $result
                    }
                    $nameRva = [uint64]$nameField - [uint64]$imageBase
                }
                if ($nameRva -gt [uint64]4294967295) {
                    $result.Error = 'delay-import-va-unsupported'
                    return $result
                }
                $mapped = & $mapRva ([uint32]$nameRva)
                if ($mapped -lt 0 -or $mapped -ge $bytes.Length) {
                    $result.Error = 'delay-import-rva-unmapped'
                    return $result
                }
                $name = & $readName $mapped
                if (-not [string]::IsNullOrWhiteSpace($name)) { [void]$delays.Add($name) }
            }
            $index++
        }
    }

    $result.Imports = @($imports)
    $result.DelayImports = @($delays)
    $result.Ok = $true
    return $result
}

function Get-PeImportScan {
    param(
        [object[]]$Entries = @(),
        [string[]]$ForbiddenPrefixes = @()
    )

    $perDll = New-Object System.Collections.ArrayList
    $misses = New-Object System.Collections.ArrayList
    $forbidden = New-Object System.Collections.ArrayList
    $parseFails = New-Object System.Collections.ArrayList

    $entriesList = @($Entries)
    $names = @{}
    foreach ($entry in $entriesList) {
        $names[$entry.Name.ToLowerInvariant()] = $true
    }

    $scanned = 0
    foreach ($entry in $entriesList) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.Path)) { continue }
        $table = Get-PeImportTable -Path $entry.Path
        $scanned++

        if (-not $table.Ok) {
            [void]$perDll.Add([pscustomobject]@{ Name = $entry.Name; ImportCount = 0; DelayCount = 0 })
            [void]$parseFails.Add([pscustomobject]@{ Name = $entry.Name; Reason = $table.Error })
            continue
        }

        [void]$perDll.Add([pscustomobject]@{
            Name        = $entry.Name
            ImportCount = @($table.Imports).Count
            DelayCount  = @($table.DelayImports).Count
        })

        foreach ($kind in @('import', 'delay-import')) {
            if ($kind -eq 'import') {
                $list = @($table.Imports)
            } else {
                $list = @($table.DelayImports)
            }
            foreach ($dep in $list) {
                if ([string]::IsNullOrWhiteSpace($dep)) { continue }
                $dl = $dep.ToLowerInvariant()
                if ($dl -eq $entry.Name.ToLowerInvariant()) { continue }
                if (Test-SystemImportName -Name $dl) { continue }

                $isForbidden = $false
                foreach ($prefix in @($ForbiddenPrefixes)) {
                    if ([string]::IsNullOrWhiteSpace($prefix)) { continue }
                    if ($dl.StartsWith($prefix.ToLowerInvariant())) { $isForbidden = $true }
                }
                if ($isForbidden) {
                    [void]$forbidden.Add([pscustomobject]@{ Importer = $entry.Name; Module = $dep; Kind = $kind })
                    continue
                }
                if ($names.ContainsKey($dl)) { continue }
                [void]$misses.Add([pscustomobject]@{ Importer = $entry.Name; Missing = $dep; Kind = $kind })
            }
        }
    }

    return [pscustomobject]@{
        Scanned    = $scanned
        PerDll     = @($perDll)
        Misses     = @($misses)
        Forbidden  = @($forbidden)
        ParseFails = @($parseFails)
    }
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

# Write a structurally valid PE32+ DLL whose import table and delay-import
# table name exactly the given modules. Only the in-repo reader consumes the
# file; it is a fixture, never loaded.
function New-SyntheticPeDll {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Imports = @(),
        [string[]]$DelayImports = @()
    )

    $imports = @($Imports | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $delays = @($DelayImports | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    $impDescBytes = ($imports.Count + 1) * 20
    $importNameCursor = $impDescBytes
    $importNameOffsets = @()
    foreach ($imp in $imports) {
        $importNameOffsets += $importNameCursor
        $importNameCursor += $imp.Length + 1
    }

    $delayDescStart = $importNameCursor
    $delayDescBytes = ($delays.Count + 1) * 32
    $delayNameCursor = $delayDescStart + $delayDescBytes
    $delayNameOffsets = @()
    foreach ($delay in $delays) {
        $delayNameOffsets += $delayNameCursor
        $delayNameCursor += $delay.Length + 1
    }

    $dataLen = $delayNameCursor
    $rawLen = [int]([Math]::Ceiling($dataLen / 512.0) * 512)
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
    PeWriteU32 $buffer 0x68 0        # AddressOfEntryPoint
    PeWriteU32 $buffer 0x6C 0x1000    # BaseOfCode
    PeWriteU64 $buffer 0x70 0         # ImageBase
    PeWriteU32 $buffer 0x78 0x1000    # SectionAlignment
    PeWriteU32 $buffer 0x7C 0x200     # FileAlignment
    PeWriteU16 $buffer 0x88 6         # MajorSubsystemVersion
    PeWriteU32 $buffer 0x90 0x2000    # SizeOfImage
    PeWriteU32 $buffer 0x94 0x200     # SizeOfHeaders
    PeWriteU16 $buffer 0x9C 3         # Subsystem: console
    PeWriteU32 $buffer 0xC4 16        # NumberOfRvaAndSizes (dirsOff + 16*8 = 0x148)
    PeWriteU32 $buffer 0xD0 0x1000    # DataDirectory[IMPORT].VirtualAddress
    PeWriteU32 $buffer 0xD4 ([uint32]$impDescBytes)

    if ($delays.Count -gt 0) {
        # DataDirectory[DELAY_IMPORT] sits at dirsOff + 13*8 = 0xC8 + 104 = 0x130.
        PeWriteU32 $buffer 0x130 ([uint32](0x1000 + $delayDescStart))
        PeWriteU32 $buffer 0x134 ([uint32]$delayDescBytes)
    }

    $sectionName = [System.Text.Encoding]::ASCII.GetBytes('.rdata')
    [Array]::Copy($sectionName, 0, $buffer, 0x148, $sectionName.Length)
    PeWriteU32 $buffer 0x150 ([uint32]$rawLen)  # VirtualSize
    PeWriteU32 $buffer 0x154 0x1000              # VirtualAddress
    PeWriteU32 $buffer 0x158 ([uint32]$rawLen)  # SizeOfRawData
    PeWriteU32 $buffer 0x15C 0x200               # PointerToRawData
    PeWriteU32 $buffer 0x16C 0x40000040          # INITIALIZED_DATA | READ

    for ($i = 0; $i -lt $imports.Count; $i++) {
        $descOff = 0x200 + ($i * 20)
        PeWriteU32 $buffer ($descOff + 12) ([uint32](0x1000 + $importNameOffsets[$i]))
        $nameBytes = [System.Text.Encoding]::ASCII.GetBytes($imports[$i])
        [Array]::Copy($nameBytes, 0, $buffer, (0x200 + $importNameOffsets[$i]), $nameBytes.Length)
    }

    for ($i = 0; $i -lt $delays.Count; $i++) {
        $descOff = 0x200 + $delayDescStart + ($i * 32)
        PeWriteU32 $buffer $descOff 1                                            # Attributes: RVA-based
        PeWriteU32 $buffer ($descOff + 4) ([uint32](0x1000 + $delayNameOffsets[$i]))
        $nameBytes = [System.Text.Encoding]::ASCII.GetBytes($delays[$i])
        [Array]::Copy($nameBytes, 0, $buffer, (0x200 + $delayNameOffsets[$i]), $nameBytes.Length)
    }

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [System.IO.File]::WriteAllBytes($Path, $buffer)
}
