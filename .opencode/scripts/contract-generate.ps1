param(
  [Parameter(Mandatory=$true)][string]$SpecFile,
  [Parameter(Mandatory=$true)][string]$OutputDir
)

if (-not (Test-Path $SpecFile)) {
  Write-Error "Spec file not found: $SpecFile"
  exit 1
}

if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$body = Get-Content $SpecFile -Raw

$reqMatches = [regex]::Matches($body, 'REQ-(\d+)(?:\.(\d+))?')
if ($reqMatches.Count -eq 0) {
  Write-Error "No EARS REQ-IDs found in spec file"
  exit 1
}

$hasRust = $body -match 'src-tauri|\.rs\b|Rust|backend|cargo|Adapter|Tauri'
$hasTs = $body -match '\.tsx?\b|TypeScript|frontend|React|pnpm|@fredo/ui|ChatNode|hook|component'

if (-not $hasRust -and -not $hasTs) {
  $hasRust = $true
  $hasTs = $true
  Write-Host "  Could not determine language — generating both contracts as fallback"
}

if ($hasRust) {
  $rustFile = Join-Path $OutputDir "contract.rs"
  $rustContent = @"
// Auto-generated spec contract — do not edit manually
// Generated from: $SpecFile
// Each method corresponds to an EARS REQ-ID. Coders MUST implement these signatures.

#![allow(dead_code)]

pub trait SpecContract {
"@

  foreach ($match in $reqMatches) {
    $reqId = $match.Value
    $methodName = $reqId -replace '-', '_' | ForEach-Object { $_.ToLower() }
    $rustContent += @"

    fn ${methodName}(&self);
"@
  }

  $rustContent += @"
}
"@

  Set-Content -Path $rustFile -Value $rustContent
  Write-Host "  Rust contract: $rustFile ($($reqMatches.Count) methods)"
}

if ($hasTs) {
  $tsFile = Join-Path $OutputDir "contract.ts"
  $tsContent = @"
// Auto-generated spec contract — do not edit manually
// Generated from: $SpecFile
// Each method corresponds to an EARS REQ-ID. Coders MUST implement these signatures.

export interface SpecContract {
"@

  foreach ($match in $reqMatches) {
    $reqId = $match.Value
    $methodName = $reqId -replace '-', '_' | ForEach-Object { $_.ToLower() }
    $tsContent += @"

  ${methodName}(): Promise<void>;
"@
  }

  $tsContent += @"
}
"@

  Set-Content -Path $tsFile -Value $tsContent
  Write-Host "  TypeScript contract: $tsFile ($($reqMatches.Count) methods)"
}

Write-Host ""
Write-Host "Contract generation complete. Include these files in every capsule's allowed_files."
