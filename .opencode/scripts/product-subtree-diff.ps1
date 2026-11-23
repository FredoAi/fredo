<#
.SYNOPSIS
  Product-subtree diff (audit C1 / P6).

  Compares the PRODUCT subtree between two commits. A docs/pipeline-only commit
  after a live capture does not invalidate product evidence; a product change
  does (re-serve before re-testing).

.PARAMETER Served
  The commit the environment/evidence was taken at.

.PARAMETER Intended
  The commit that must be tested (the merged spec tip).

.PARAMETER Paths
  The product-subtree paths (defaults: apps, package.json, pnpm-lock.yaml,
  apps/tauri/src-tauri/Cargo.toml, Cargo.lock).

.PARAMETER SelfTest
  Run the built-in controls and exit 0 when they pass.

.EXITCODES
  0 = UNCHANGED, 2 = CHANGED, 1 = error.
#>
[CmdletBinding()]
param(
  [string]$Served = "",
  [string]$Intended = "",
  [string[]]$Paths = @("apps", "package.json", "pnpm-lock.yaml", "apps/tauri/src-tauri/Cargo.toml", "Cargo.lock"),
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

function Get-DiffResult {
  param([string]$Served, [string]$Intended, [string[]]$Paths)
  if (-not $Served -or -not $Intended) { throw "pass -Served <sha> and -Intended <sha>" }
  $gitArgs = @("diff", "--quiet", $Served, $Intended, "--") + $Paths
  & git @gitArgs 2>$null | Out-Null
  switch ($LASTEXITCODE) {
    0 { return "UNCHANGED" }
    1 { return "CHANGED" }
    default { throw "git diff failed (exit $LASTEXITCODE)" }
  }
}

if ($SelfTest) {
  $fail = 0
  try { $r1 = Get-DiffResult -Served "HEAD" -Intended "HEAD" -Paths $Paths } catch { $r1 = "ERROR: $_" }
  if ($r1 -eq "UNCHANGED") { Write-Output "CONTROL 1 (same commit) PASS" } else { Write-Output "CONTROL 1 (same commit) FAIL: $r1"; $fail++ }
  $r2 = "NO-ERROR"
  try { Get-DiffResult -Served "not-a-real-ref-xyz" -Intended "HEAD" -Paths $Paths | Out-Null } catch { $r2 = "ERROR" }
  if ($r2 -eq "ERROR") { Write-Output "CONTROL 2 (bad ref) PASS" } else { Write-Output "CONTROL 2 (bad ref) FAIL: expected an error"; $fail++ }
  if ($fail -gt 0) { exit 1 }
  Write-Output "RESULT: CLEAN (2 controls)"
  exit 0
}

$r = Get-DiffResult -Served $Served -Intended $Intended -Paths $Paths
Write-Output "PRODUCT_SUBTREE: $r"
if ($r -eq "UNCHANGED") { exit 0 } else { exit 2 }
