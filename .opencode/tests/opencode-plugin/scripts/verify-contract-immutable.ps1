<#
  verify-contract-immutable.ps1 - AC3 byte-identity gate for spec #3197.

  The AC states that the ingest classifier is consumed UNCHANGED: rtdb/attrs.rs and
  rtdb/ingest.rs must be byte-identical to the base branch. The tester's sandbox allowlist has no
  bare `git diff`, so this wrapper runs it (a script's child process is the sanctioned form,
  exactly like .opencode/scripts/run-exitcode.ps1).

  Usage (from anywhere inside the repo; -Paths are REPO-ROOT-relative). The tester copies this
  file into .opencode/tmp/3197/ first:

    Copy-Item .opencode/tests/opencode-plugin/scripts/verify-contract-immutable.ps1 .opencode/tmp/3197/
    powershell -File .opencode/tmp/3197/verify-contract-immutable.ps1

  Optional: -BaseRef <ref> pins the comparison base (default: auto-resolve origin/main, else main).

  ROUND-2 REPAIR (spec #3197). The round-1 body was not PowerShell 5.1-safe; the tester proved it
  unusable. Two defects, both fixed here:
    (a) `$ErrorActionPreference='Stop'` combined with `2>&1` on a native git call turns ANY benign
        stderr write (git writes advice and progress to stderr routinely) into a terminating
        NativeCommandError, killing the script before it printed a verdict. Every git call now
        runs with 'Continue' scoped to that single call, stderr is discarded, and NOTHING is
        inferred from stderr text.
    (b) `rev-parse --verify --quiet <ref>` returned EMPTY output, so a ref that resolves fine was
        reported as BLOCKED / EXITCODE=3. The base ref is now resolved by EXIT CODE and the sha is
        read from the printed revision, with `main` as the fallback for `origin/main`.

  THE CHECK IS NOT WEAKENED. The gate is still `git diff --quiet <base-sha> -- <path>` against the
  resolved base sha (git-identical object content => exit 0). What changed is that the exit status
  is now interpreted precisely instead of "non-zero means DIFF": 0 = identical, 1 = differs,
  anything else = no verdict (tooling, exit 3). A path that is absent from BOTH the base and the
  working tree is reported as no-verdict rather than silently "identical" (git exits 0 for a
  pathspec that matches nothing, which would otherwise be a false PASS).

  Printed lines to paste into the posted `## Tests Runs`:
    REPO-ROOT=<absolute path>
    BASE=<resolved ref>@<full sha>
    HEAD=<branch|detached|UNKNOWN>@<full sha|UNKNOWN>
    PATH=attrs.rs STATUS=IDENTICAL|DIFF|DELETED|ABSENT-IN-BASE-AND-WORKTREE|GIT-ERROR  (<path>)
    SHA256 attrs.rs=<hex>            (IDENTICAL paths only - receipt corroboration, NOT a gate)
    --- DIFF <path> --- ... --- END DIFF <path> ---   (differing paths only)
    CONTRACT-DIFF-EMPTY: true|false|unknown
    EXITCODE=0|1|3

  Exit codes:
    0 = every path identical to the base   (CONTRACT-DIFF-EMPTY: true)  <- the AC3 PASS condition
    1 = at least one path differs/deleted  (CONTRACT-DIFF-EMPTY: false)
    3 = NO VERDICT (CONTRACT-DIFF-EMPTY: unknown): not a git repo, git not on PATH, no base ref
        resolvable, or a path is absent from both base and working tree. Report as tooling; never
        treat this as a PASS.

  PowerShell 5.1 constraints honoured: no `??`, no ternary, no `-ErrorAction` on external
  commands, `$LASTEXITCODE` read immediately after each native call, ASCII-only output.
#>
[CmdletBinding()]
param(
  [string[]]$Paths = @(
    "apps/tauri/src-tauri/src/infrastructure/rtdb/attrs.rs",
    "apps/tauri/src-tauri/src/infrastructure/rtdb/ingest.rs"
  ),
  # "" = auto-resolve: prefer origin/main, fall back to main. Any other ref is used as given.
  [string]$BaseRef = ""
)

$ErrorActionPreference = 'Stop'

# --- helpers -------------------------------------------------------------------------------

# Structured native git call. stderr is DISCARDED (never merged into the output stream): git
# writes routine advice/progress there, and under PowerShell 5.1 a native stderr write with
# $ErrorActionPreference='Stop' is a terminating NativeCommandError (round-1 defect (a)).
# 'Continue' is scoped to this one call; $LASTEXITCODE is read on the very next statement, before
# any other native command can overwrite it.
function Invoke-Git {
  param([string[]]$GitArgs)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @()
  $code = -1
  try {
    $out = @(& git @GitArgs 2>$null)
    $code = $LASTEXITCODE
  } catch {
    $out = @()
    $code = -1
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($null -eq $code) { $code = -1 }
  return @{ Output = $out; Code = [int]$code }
}

# First non-blank stdout line, trimmed.
function Get-FirstLine {
  param($Lines)
  foreach ($l in $Lines) {
    $s = ([string]$l).Trim()
    if ($s -ne '') { return $s }
  }
  return ''
}

# A resolved revision must look like a hex object id (7..64 chars); this is the guard that makes
# an EMPTY `rev-parse` output a failure instead of a false success (round-1 defect (b)).
function Test-Sha {
  param([string]$Text)
  if ($Text -eq '') { return $false }
  return ($Text -match '^[0-9a-fA-F]{7,64}$')
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  Write-Output "BLOCKED: git is not resolvable on PATH (report as tooling)"
  Write-Output "CONTRACT-DIFF-EMPTY: unknown"
  Write-Output "EXITCODE=3"
  exit 3
}

# --- repo root -----------------------------------------------------------------------------

$rootRes = Invoke-Git -GitArgs @('rev-parse', '--show-toplevel')
$root = Get-FirstLine $rootRes.Output
if ($rootRes.Code -ne 0 -or $root -eq '') {
  Write-Output ("BLOCKED: not a git repository (git rev-parse --show-toplevel exit " + $rootRes.Code + ")")
  Write-Output "CONTRACT-DIFF-EMPTY: unknown"
  Write-Output "EXITCODE=3"
  exit 3
}
try {
  Set-Location -LiteralPath $root -ErrorAction Stop
} catch {
  Write-Output ("BLOCKED: could not enter the repository root: " + $root)
  Write-Output "CONTRACT-DIFF-EMPTY: unknown"
  Write-Output "EXITCODE=3"
  exit 3
}

# --- resolve the base ref (exit-code driven, no --quiet, no reliance on empty/stderr) --------

$candidates = @()
if ($BaseRef -ne '') {
  $candidates = @($BaseRef)
} else {
  $candidates = @('origin/main', 'main')
}

$baseRef = ''
$baseSha = ''
foreach ($cand in $candidates) {
  $rev = $cand + '^{commit}'
  $r = Invoke-Git -GitArgs @('rev-parse', '--verify', $rev)
  if ($r.Code -eq 0) {
    $sha = Get-FirstLine $r.Output
    if (Test-Sha $sha) {
      $baseRef = $cand
      $baseSha = $sha
      break
    }
    # exit 0 but nothing usable on stdout: ask again without --verify's suppression semantics.
    $r2 = Invoke-Git -GitArgs @('rev-parse', $rev)
    $sha2 = Get-FirstLine $r2.Output
    if ($r2.Code -eq 0 -and (Test-Sha $sha2)) {
      $baseRef = $cand
      $baseSha = $sha2
      break
    }
  }
  Write-Output ("NOTE: base candidate '" + $cand + "' did not resolve (git exit " + $r.Code + ")")
}

if ($baseSha -eq '') {
  Write-Output ("BLOCKED: could not resolve a base ref (tried: " + ($candidates -join ', ') + ")")
  Write-Output "CONTRACT-DIFF-EMPTY: unknown"
  Write-Output "EXITCODE=3"
  exit 3
}

# --- report the effective inputs (the tester pastes these) ----------------------------------

Write-Output ("REPO-ROOT=" + $root)
Write-Output ("BASE=" + $baseRef + "@" + $baseSha)

$headBranchRes = Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
$headShaRes = Invoke-Git -GitArgs @('rev-parse', '--verify', 'HEAD^{commit}')
$headBranch = Get-FirstLine $headBranchRes.Output
$headSha = Get-FirstLine $headShaRes.Output
if ($headBranch -eq '') { $headBranch = 'UNKNOWN' }
# A served checkout is usually a DETACHED worktree; git reports the branch name as the literal
# "HEAD" there. Label it "detached" so the receipt reads unambiguously.
if ($headBranch -eq 'HEAD') { $headBranch = 'detached' }
if (-not (Test-Sha $headSha)) { $headSha = 'UNKNOWN' }
Write-Output ("HEAD=" + $headBranch + "@" + $headSha)

# --- per-path gate -------------------------------------------------------------------------

$anyDiff = $false
$toolingErrors = @()

foreach ($p in $Paths) {
  $leaf = Split-Path -Leaf $p

  $inBaseRes = Invoke-Git -GitArgs @('cat-file', '-e', ($baseSha + ':' + $p))
  $inBase = ($inBaseRes.Code -eq 0)
  $inWork = Test-Path -LiteralPath $p -PathType Leaf

  if (-not $inWork -and -not $inBase) {
    Write-Output ("PATH=" + $leaf + " STATUS=ABSENT-IN-BASE-AND-WORKTREE  (" + $p + ")")
    $toolingErrors += ("path exists in neither the base nor the working tree: " + $p)
    continue
  }

  if (-not $inWork) {
    Write-Output ("PATH=" + $leaf + " STATUS=DELETED  (" + $p + ")")
    $anyDiff = $true
    continue
  }

  $d = Invoke-Git -GitArgs @('diff', '--quiet', $baseSha, '--', $p)
  if ($d.Code -eq 0) {
    $hash = 'unreadable'
    try {
      $hash = (Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash
    } catch {
      $hash = 'unreadable'
    }
    Write-Output ("PATH=" + $leaf + " STATUS=IDENTICAL  (" + $p + ")")
    Write-Output ("SHA256 " + $leaf + "=" + $hash)
    continue
  }

  if ($d.Code -eq 1) {
    Write-Output ("PATH=" + $leaf + " STATUS=DIFF  (" + $p + ")")
    $full = Invoke-Git -GitArgs @('diff', '--no-color', $baseSha, '--', $p)
    Write-Output ("--- DIFF " + $p + " ---")
    foreach ($line in $full.Output) { Write-Output ([string]$line) }
    Write-Output ("--- END DIFF " + $p + " ---")
    $anyDiff = $true
    continue
  }

  Write-Output ("PATH=" + $leaf + " STATUS=GIT-ERROR  (" + $p + ")  git diff exit=" + $d.Code)
  $toolingErrors += ("git diff failed for " + $p + " (exit " + $d.Code + ")")
}

# --- verdict -------------------------------------------------------------------------------

# A tooling error means NO VERDICT (never a PASS, never a FAIL) - it wins over a diff, because the
# run itself is unreliable.
if ($toolingErrors.Count -gt 0) {
  foreach ($e in $toolingErrors) { Write-Output ("ERROR: " + $e) }
  Write-Output "CONTRACT-DIFF-EMPTY: unknown"
  Write-Output "EXITCODE=3"
  exit 3
}

if ($anyDiff) {
  Write-Output "CONTRACT-DIFF-EMPTY: false"
  Write-Output "EXITCODE=1"
  exit 1
}

Write-Output "CONTRACT-DIFF-EMPTY: true"
Write-Output "EXITCODE=0"
exit 0
