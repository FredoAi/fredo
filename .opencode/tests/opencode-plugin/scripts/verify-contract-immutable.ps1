<#
  verify-contract-immutable.ps1 — AC3 byte-identity gate for spec #3197.

  The AC states that the ingest classifier is consumed UNCHANGED: `rtdb/attrs.rs` and
  `rtdb/ingest.rs` must be byte-identical to `main`. The tester's sandbox allowlist has no bare
  `git diff`, so this wrapper runs it (a script's child process is the sanctioned form, exactly
  like `.opencode/scripts/run-exitcode.ps1`).

  Usage (from the repo root). The tester copies this file into `.opencode/tmp/3197/` first:

    Copy-Item .opencode/tests/opencode-plugin/scripts/verify-contract-immutable.ps1 .opencode/tmp/3197/
    powershell -File .opencode/tmp/3197/verify-contract-immutable.ps1

  Printed lines to paste into the posted `## Tests Runs`:
    BASE=<resolved base ref>
    PLUGIN_BRANCH=<current branch / HEAD>
    PATH=attrs.rs  STATUS=IDENTICAL|DIFF
    PATH=ingest.rs STATUS=IDENTICAL|DIFF
    CONTRACT-DIFF-EMPTY: true|false
    EXITCODE=<n>

  Exit codes: 0 = both identical (CONTRACT-DIFF-EMPTY: true); 1 = at least one differs;
              3 = could not resolve a base ref / not a git repo (report as tooling).
#>
[CmdletBinding()]
param(
  [string[]]$Paths = @(
    "apps/tauri/src-tauri/src/infrastructure/rtdb/attrs.rs",
    "apps/tauri/src-tauri/src/infrastructure/rtdb/ingest.rs"
  ),
  # "" = auto-resolve: prefer origin/main, fall back to main.
  [string]$BaseRef = ""
)

$ErrorActionPreference = 'Stop'

function Invoke-Git {
  param([string[]]$GitArgs)
  $out = & git @GitArgs 2>&1
  return @{ Output = $out; Code = $LASTEXITCODE }
}

$rootRes = Invoke-Git -GitArgs @('rev-parse', '--show-toplevel')
if ($rootRes.Code -ne 0) {
  Write-Output "BLOCKED: not a git repository ($($rootRes.Output -join ' '))"
  Write-Output "EXITCODE=3"
  exit 3
}
$root = ($rootRes.Output | Select-Object -First 1)
Set-Location -LiteralPath $root

$base = $BaseRef
if ($base -eq "") {
  $candidate = Invoke-Git rev-parse --verify --quiet origin/main
  if ($candidate.Code -eq 0 -and $candidate.Output) {
    $base = "origin/main"
  } else {
    $candidate = Invoke-Git rev-parse --verify --quiet main
    if ($candidate.Code -eq 0 -and $candidate.Output) {
      $base = "main"
    } else {
      Write-Output "BLOCKED: could not resolve origin/main or main"
      Write-Output "EXITCODE=3"
      exit 3
    }
  }
}

$branchRes = Invoke-Git rev-parse --abbrev-ref HEAD
Write-Output "BASE=$base"
Write-Output "PLUGIN_BRANCH=$(($branchRes.Output | Select-Object -First 1))"

$anyDiff = $false
foreach ($p in $Paths) {
  $leaf = Split-Path -Leaf $p
  $d = Invoke-Git diff --quiet $base -- $p
  if ($d.Code -eq 0) {
    Write-Output "PATH=$leaf  STATUS=IDENTICAL  ($p)"
  } else {
    Write-Output "PATH=$leaf  STATUS=DIFF       ($p)"
    # capture the diff so the verdict can quote it
    $full = Invoke-Git diff $base -- $p
    Write-Output "--- DIFF $p ---"
    $full.Output | ForEach-Object { Write-Output $_ }
    Write-Output "--- END DIFF $p ---"
    $anyDiff = $true
  }
}

if ($anyDiff) {
  Write-Output "CONTRACT-DIFF-EMPTY: false"
  Write-Output "EXITCODE=1"
  exit 1
}

Write-Output "CONTRACT-DIFF-EMPTY: true"
Write-Output "EXITCODE=0"
exit 0
