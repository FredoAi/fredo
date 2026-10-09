#Requires -Version 5.1
<#
.SYNOPSIS
    Record the managed MSYS2 base-archive pin for Doom provisioning (Spec #3012, ST-1).

.DESCRIPTION
    The runtime provisioning path downloads a pinned MSYS2 base `.tar.xz` into
    `<install_dir>/toolchain/msys2` and gates it on an exact byte count + SHA-256
    (the shared engine compares exact on-disk length). This script is the ENFORCING
    FETCH that produces those values: it downloads the pinned archive once and prints
    the real URL, archive filename, exact byte count and SHA-256, which fill the
    `DOOM_TOOLCHAIN_PIN` constant documented in `scripts/doom/README.md`.

    It is idempotent: an already-downloaded archive is reused unless `-Force` is
    passed. Nothing here is committed - the archive lands under `.opencode/tmp/`
    (gitignored) and is left on disk for the QA pin assertion (F-78).

.OUTPUTS
    Exactly these lines on stdout (the pin values to transcribe):
        url=<url>
        archive_filename=<name>
        bytes=<exact byte count>
        sha256=<lowercase hex>
        path=<local archive>

.EXAMPLE
    powershell -File scripts/doom/record-toolchain-pin.ps1
    powershell -File scripts/doom/record-toolchain-pin.ps1 -Force
#>
[CmdletBinding()]
param(
    # Pinned managed MSYS2 x86_64 base archive (dated = reproducible).
    [string]$Url = 'https://repo.msys2.org/distrib/x86_64/msys2-base-x86_64-20260927.tar.xz',
    # Download directory. Defaults to <repo>\.opencode\tmp\3012\toolchain-archive.
    [string]$OutDir,
    # Re-download even when the archive is already present.
    [switch]$Force,
    # Bounded download wait (G-263). Default 900 s.
    [int]$TimeoutSec = 900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $OutDir) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $OutDir = Join-Path $repoRoot '.opencode\tmp\3012\toolchain-archive'
}
$null = New-Item -ItemType Directory -Force -Path $OutDir

$fileName = [System.IO.Path]::GetFileName(([System.Uri]$Url).AbsolutePath)
if ([string]::IsNullOrWhiteSpace($fileName)) {
    throw "cannot derive an archive filename from URL '$Url'"
}
$target = Join-Path $OutDir $fileName

if ((Test-Path -LiteralPath $target) -and (-not $Force)) {
    Write-Host "Reusing existing archive at $target (pass -Force to re-download)."
}
else {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $target -TimeoutSec $TimeoutSec
}

$bytes = (Get-Item -LiteralPath $target).Length
$sha = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Output ("url=" + $Url)
Write-Output ("archive_filename=" + $fileName)
Write-Output ("bytes=" + $bytes)
Write-Output ("sha256=" + $sha)
Write-Output ("path=" + $target)
