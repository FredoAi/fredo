#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Write a minimal synthetic PE DLL that imports the named modules.

.DESCRIPTION
  Thin CLI over New-SyntheticPeDll (pe-imports.psm1) so the negative legs of
  the payload gates are reproducible without hand-authored binaries. The file
  is structurally a valid PE32+ DLL and only ever consumed by the in-repo PE
  reader; it is never loaded.

  -Imports      Comma- or space-separated module names for the LOAD-TIME
                import directory (DataDirectory[1]).
  -DelayImports Comma- or space-separated module names for the DELAY-IMPORT
                directory (DataDirectory[13]).

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/new-synthetic-pe.ps1 -Path .opencode/tmp/3172/poison.dll -Imports libssl-3-x64.dll

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/new-synthetic-pe.ps1 -Path .opencode/tmp/3172/delay.dll -DelayImports libcrypto-3-x64.dll
#>
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$Imports = @(),
    [string[]]$DelayImports = @()
)

$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'pe-imports.psm1') -Force

$resolved = [System.IO.Path]::GetFullPath($Path)
New-SyntheticPeDll -Path $resolved -Imports $Imports -DelayImports $DelayImports

$table = Get-PeImportTable -Path $resolved
Write-Output ("SYNTHETIC_PE_PATH={0}" -f $resolved)
Write-Output ("SYNTHETIC_PE_OK={0}" -f $table.Ok)
Write-Output ("SYNTHETIC_PE_IMPORTS={0}" -f (@($table.Imports) -join ','))
Write-Output ("SYNTHETIC_PE_DELAY_IMPORTS={0}" -f (@($table.DelayImports) -join ','))
if (-not $table.Ok) {
    Write-Output ("SYNTHETIC_PE_ERROR={0}" -f $table.Error)
    exit 1
}
exit 0
