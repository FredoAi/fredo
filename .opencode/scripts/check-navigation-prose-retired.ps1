<#
  check-navigation-prose-retired.ps1 - committed prose absence guard (spec #3153, AC1)

  Proves AC1's scoped absence predicate over DOCUMENTATION PROSE: the deleted
  keyboard-navigation subsystem is taught by no current-state document and no
  surviving durable test suite.

  SCANNED ROOTS - exactly TWO, nothing else:

    docs                 (every current-state document + the ADRs)
    .opencode/tests      (the surviving durable suite prose)

  TEXT EXTENSIONS - `.md` only.  This is a PROSE guard; the AC's predicate is
  "no document teaches the deleted vocabulary", so product source is out of
  scope (a docs-only slice never edits it).

  TEXT MODE - ALL FIVE CLASSES ARE RAW (this is the binding declaration, G-419):

    Every class is scanned as RAW text - no comment stripping, no literal
    stripping, no sanitizer pass of any kind.  That is deliberate: this AC is a
    PROSE predicate, so a mention inside prose, a fenced code snippet, an inline
    backtick or a quoted sentence IS the defect.  A comment-stripping guard
    would wrongly pass a fenced-snippet mention (the exact inversion G-419
    names).  Classes A-E below therefore differ only in their token list and in
    whether Class B applies IDENTIFIER BOUNDARIES.

  FILE SET - the walk, MINUS what the repository itself ignores:

    The candidate set is a recursive walk of the two roots which is then
    NARROWED by one batched `git check-ignore -z --stdin` query per scan.  Any
    candidate path that `.gitignore` reports as IGNORED is dropped BEFORE it
    contributes to the scanned count, to the hit counts or to any class count -
    so gitignored agent scratch / build output can never produce a false red.

    Three properties are load-bearing (the S2 three-round lesson, G-441):

      * DERIVED UNIVERSE - the exclusion set is derived from the repository's
        own `.gitignore` resolution, never from a hand-picked directory-name
        list.  `$SkipDirNames` is EMPTY ON PURPOSE: a name that is build output
        in one root is a directory of TRACKED source in another, and a name
        prune cannot tell them apart (S2's `gen/` regression).
      * MONOTONE NARROWING - the filter only removes candidates, so it can never
        INVENT a hit.
      * INDEX-AWARE - `git check-ignore` consults the index, so a file git
        TRACKS inside an ignored directory is reported NOT ignored and stays
        scanned; the FILTER cannot hide a tracked file.  Negations (`!`) are
        honoured because git resolves them and this script does not re-implement
        git's rules.

    The excluded count is printed - `Ignore filter: N path(s) excluded` - so the
    scoping is auditable rather than invisible.  `Scanned files: N` is printed
    alongside it, ALWAYS, in every exit path.

    FAIL CLOSED: if the ignore query cannot be applied (git missing, not a
    repository, an unexpected exit code), the scan does NOT fall back to the
    unfiltered walk - it reports `ignore filter unavailable` and exits 2.
    Silently widening the universe is exactly the defect this filter removes.

  TOKEN CLASSES - five, with the CPU-free classification:

    A. MODULE PATHS      - RAW substring.  They are paths; a prose mention
                           counts.  3 tokens.
    B. ENGINE SYMBOLS    - RAW, identifier boundaries.  This AC is a PROSE
                           predicate, so a fenced-snippet mention IS the defect;
                           boundaries keep prefix pairs independent.  19 tokens.
    C. DECLARED-SURFACE  - RAW substring, EXACT PHRASES ONLY.  Bare words would
                           false-positive the theme vocabulary (`SurfaceId` at
                           `.opencode/tests/contrast-gate/functional.md:26,28`
                           says "declared surfaces x states"), so only the exact
                           live phrases are tokens.  8 tokens.
    D. SURFACE PHRASES   - RAW substring (the deleted rail / map / trail chrome
                           and its DOM hooks).  8 tokens.
    E. DELETED FILES     - RAW substring (the seven `*Surface.ts` modules).  7
                           tokens.

    Tokens that SURVIVE and are deliberately NOT banned (ST-3 may name them):
    resolveCompanionTargetApp, computeComposerPlacement, companionBridge,
    composerTarget, registerCompanionGrounding, readCompanionGrounding,
    installPlatformChords, runWindowLauncherToggle, focusNextWindow,
    focusPreviousWindow, matchPlatformChord, WIREFRAME_HISTORY_LIMIT,
    companion_skill_registry.

  EVIDENCE ALLOWLIST - exactly EIGHT entries, all FOLDER/FILE PREFIXES:

    * docs/NAVIGATION_ENGINE.md               the superseded normative contract
    * docs/adr/                               the superseded decision records
    * docs/UX_FLUENCY_RESEARCH.md             the historical research record
    * docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md
    * .opencode/tests/retired-navigation/     the retirement ledger
    * .opencode/tests/navigation-retirement/  S1's durable suite
    * .opencode/tests/navigation-prose-retirement/  THIS slice's durable suite
    * .opencode/tests/companion-command-removal/    S2's ledger + suite

    Each of the last four spells the banned tokens BY CONSTRUCTION (they assert
    the absence), which is why they are allowlisted at all (G-431).

    REFUSAL PREDICATE (AC1: "The allowlist may contain no current-state doc and
    no product source").  This is IMPLEMENTED, not merely claimed (G-430), and
    it runs BEFORE any scanning:

      for each allowlist entry E:
        E starts with 'apps/'                        -> exit 2
        E is one of $RequiredExceptions              -> accept
        E starts with any $ForbiddenAllowlistPrefixes -> exit 2
      where $RequiredExceptions = @(
        'docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md')

    `docs/agentic-pipeline/` is a forbidden prefix (it is current-state process
    documentation), so the one historical evaluation inside it is named as an
    exception.  A prefix check alone would refuse it; an exception table alone
    would let any current-state file in; the predicate requires BOTH.

  EXIT CODES: 0 = clean | 1 = at least one non-allowlisted hit | 2 = cannot run
  (a missing scan root, zero files scanned, the ignore filter unavailable, or an
  allowlist entry that names a current-state doc / an `apps/**` path).
  With -SelfTest: 0 = every control passed | 1 = a control failed.

  SELF-TEST CONTROLS (`-SelfTest`), all SEVEN printed one line each:

    (1) POSITIVE         one leg per token, ITERATED FROM THE TOKEN DATA
                         ITSELF.  A token with no leg is a FAILURE, not a
                         silent gap; the printed leg count must equal the
                         declared token count.
    (2) NEGATIVE         a hit inside an ALLOWLISTED path is reported but does
                         NOT fail; the same hit moved OUTSIDE the allowlist
                         DOES fail.  Both directions are driven through the real
                         scan, not asserted about the predicate in the abstract.
    (3) SEEDED ROOT      write an UNTRACKED, NON-IGNORED probe at
                         docs/__nav_prose_absence_probe__.md, assert a hit at
                         that EXACT path:line, delete it in try/finally, and
                         assert no hit remains at that path.  This is the G-441
                         boundary control: a filter that over-reached would hide
                         it.
    (4) OUT-OF-ROOT      write the same probe at
                         spikes/__nav_prose_probe_outside__.md (a sibling of
                         both roots), assert it is NOT scanned, delete it in
                         try/finally -> root confinement.
    (5) IGNORED NON-SCAN write the same probe into a git-IGNORED directory and
                         assert it produces ZERO hits while the `Ignore filter:`
                         count grows.  This is the control that turns a silently
                         inert ignore filter into a failure.  It ASKS GIT FOR
                         ITS OWN PRECONDITION FIRST and FAILS LOUDLY if the
                         ignore rule it depends on has gone (a control that
                         cannot establish its own precondition asserts nothing).
                         The plan's literal path `.opencode/tmp/...` is verified
                         ignored too, and both probes are deleted in try/finally.
                         BOTH probe parents are CREATED when absent: the plan
                         path's `.opencode/tmp/` is gitignored, so no fresh clone
                         or CI checkout has it - creating it is what makes this
                         control tree-agnostic.  Its parent is DERIVED from the
                         probe path and removed only when this control created it
                         and left it empty, so a live `.opencode/tmp/<issue>/`
                         survives.  A failed probe write fails LOUDLY instead of
                         reaching the cleanup tail as a quiet pass.
    (6) SELF-REFERENCE   the guard's own source spells EVERY token and lives
                         OUTSIDE both roots, and no plain-run hit originates
                         from the guard itself.  The reservation in
                         `.opencode/scripts` is what makes AC1 non-vacuous.
    (7) ALLOWLIST AUDIT  asserts the allowlist's CONTENT rather than trusting
                         it: exactly 8 entries, every entry resolves on disk, no
                         entry starts with 'apps/', no entry matches a forbidden
                         prefix except the named exception, and BOTH directions
                         of the refusal predicate are exercised (the exception is
                         ACCEPTED, a sibling playbook under the same forbidden
                         prefix is REFUSED).  A re-introduced current-state entry
                         therefore FAILS loudly instead of quietly narrowing the
                         scan.

  The script is ASCII-only on purpose (G-315): PowerShell 5.1 decodes a
  UTF-8-without-BOM source under the local code page, and non-ASCII punctuation
  desyncs its parser.

  Usage:
    powershell -File .opencode/scripts/check-navigation-prose-retired.ps1
    powershell -File .opencode/scripts/check-navigation-prose-retired.ps1 -SelfTest
    powershell -File .opencode/scripts/check-navigation-prose-retired.ps1 -Root C:\Code\fredo
#>
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [string]$Root
)

# Keep the process alive across non-fatal file IO problems.
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Token data - the SINGLE source of truth for the scan AND the self-test legs
# ---------------------------------------------------------------------------
$GroupA = @{
    Class      = 'A'
    Label      = 'module paths (raw substring)'
    Boundaries = $false
    Tokens     = @(
        'shared/navigation',
        'shared/hotkeys',
        'shared/navigation/ui'
    )
}

$GroupB = @{
    Class      = 'B'
    Label      = 'engine symbols (raw, identifier boundaries)'
    Boundaries = $true
    Tokens     = @(
        'NavigationEngine',
        'NavigationHost',
        'NavigationProvider',
        'NavigationAnnouncer',
        'validateSurface',
        'createNavigationHost',
        'registerNavigationHost',
        'getNavigationHost',
        'describeContext',
        'ContextEnvelope',
        'CommandRail',
        'NavigationMap',
        'ActivityTrail',
        'NavKeycap',
        'NAVIGATION_GLOBAL_CHORDS',
        'resolveStroke',
        'announceNavigation',
        'classifyFocusContext',
        'onKeyDown adapter'
    )
}

$GroupC = @{
    Class      = 'C'
    Label      = 'declared-surface phrases (raw, exact phrases)'
    Boundaries = $false
    Tokens     = @(
        'declared-surface model',
        'declared surface model',
        'declares its keyboard surface',
        'declared keyboard surface',
        'declared-surface navigation model',
        'declared-surface engine',
        'declared navigation surface',
        '*Surface.ts'
    )
}

$GroupD = @{
    Class      = 'D'
    Label      = 'surface phrases / DOM hooks (raw substring)'
    Boundaries = $false
    Tokens     = @(
        'command rail',
        'navigation map',
        'activity trail',
        'navigation-announcer',
        'navigation-bar',
        'navigation-trail',
        'navigation-keycap',
        'data-nav-'
    )
}

$GroupE = @{
    Class      = 'E'
    Label      = 'deleted files (raw substring)'
    Boundaries = $false
    Tokens     = @(
        'wireframeSurface',
        'terminalSurface',
        'missionMonitorSurface',
        'databaseClientSurface',
        'devModeSurface',
        'windowSystemSurface',
        'navigationDemoSurface'
    )
}

$Groups = @($GroupA, $GroupB, $GroupC, $GroupD, $GroupE)

# Exactly EIGHT entries, folder/file prefixes.  See the header for the audit
# that keeps this list honest (control 7).
$EvidenceAllowlist = @(
    'docs/NAVIGATION_ENGINE.md',
    'docs/adr/',
    'docs/UX_FLUENCY_RESEARCH.md',
    'docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md',
    '.opencode/tests/retired-navigation/',
    '.opencode/tests/navigation-retirement/',
    '.opencode/tests/navigation-prose-retirement/',
    '.opencode/tests/companion-command-removal/'
)

# A current-state document (or product source) may never be allowlisted.  This
# is the AC1 clause turned into a predicate; control 7 asserts BOTH directions.
$ForbiddenAllowlistPrefixes = @(
    'docs/ARCHITECTURE.md',
    'docs/ENGINEERING_RULES.md',
    'docs/FAQ.md',
    'docs/README.md',
    'docs/SETUP.md',
    'docs/CLI_GUIDE.md',
    'docs/SECURITY.md',
    'docs/telemetry-reference.md',
    'docs/CI_GATE_CONTRACT.md',
    'docs/release-process.md',
    'docs/GITHUB_SETUP.md',
    'docs/THIRD_PARTY_NOTICES.md',
    'docs/agentic-pipeline/',
    'apps/'
)

# Entries inside a forbidden prefix that are nevertheless historical evidence.
$RequiredExceptions = @(
    'docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md'
)

$ScanRelRoots = @('docs', '.opencode/tests')
$TextExtensions = @('.md')
# EMPTY on purpose (G-441): the exclusion set is DERIVED from the repository's
# own ignore rules by a single batched `git check-ignore` query.  A hand-picked
# directory-name list scanned gitignored build output in S2 and pruned tracked
# schemas; a name prune cannot tell the two apart, so there is no name prune.
$SkipDirNames = @()

# Untracked, NON-ignored probe inside a scanned root (control 3): the boundary
# control - it MUST still be caught, or the filter is vacuous.
$ProbeRelPath = 'docs/__nav_prose_absence_probe__.md'
# A second non-allowlisted probe used by control 2's negative leg.
$NegativeProbeRelPath = 'docs/__nav_prose_negative_probe__.md'
# A probe inside an ALLOWLISTED path used by control 2's positive leg.
$AllowlistedProbeRelPath = 'docs/adr/__nav_prose_probe_allowlisted__.md'
# A synthetic hit OUTSIDE both scanned roots (control 4): root confinement.
$OutOfRootRelPath = 'spikes/__nav_prose_probe_outside__.md'
# A synthetic hit INSIDE a root but inside a git-IGNORED directory (control 5).
# `tmp/` is an unanchored rule in .gitignore, so it matches at any depth - this
# path is therefore both inside `.opencode/tests` AND git-ignored, which is what
# makes the control assert the FILTER rather than root confinement.
$IgnoredProbeRelPath = '.opencode/tests/tmp/__nav_prose_probe_ignored__.md'
$IgnoredProbeDirRel = '.opencode/tests/tmp'
# The plan's literal probe path, also verified ignored by control 5's
# precondition (it must never be scanned either).
$IgnoredPlanProbeRelPath = '.opencode/tmp/__nav_prose_probe_ignored__.md'

# ---------------------------------------------------------------------------
# Matcher - case-sensitive; identifier boundaries for Class B
# ---------------------------------------------------------------------------
function Test-TokenMatch {
    param(
        # An empty line or an empty file is legitimate input, never a bind error.
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][bool]$Boundaries
    )
    if (-not $Boundaries) {
        # RAW substring: prose, fenced snippets and quoted text all count.
        return ($Text.IndexOf($Token, [System.StringComparison]::Ordinal) -ge 0)
    }
    $pattern = '(?<![A-Za-z0-9_$])' + [regex]::Escape($Token) + '(?![A-Za-z0-9_$])'
    return [regex]::IsMatch($Text, $pattern)
}

# Scan one RAW text line by line for one token group.  No sanitizer is applied:
# the declared text mode for every class is RAW (see the header).
function Get-HitsInText {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][hashtable]$Group,
        [string]$RelPath = '<memory>'
    )
    $hits = New-Object System.Collections.Generic.List[object]
    $boundaries = [bool]$Group.Boundaries
    $lines = $Text -split "`r?`n"
    for ($ln = 0; $ln -lt $lines.Count; $ln++) {
        $line = $lines[$ln]
        foreach ($tok in $Group.Tokens) {
            if (-not (Test-TokenMatch -Text $line -Token $tok -Boundaries $boundaries)) { continue }
            [void]$hits.Add([pscustomobject]@{
                    HitClass = $Group.Class
                    Token    = $tok
                    Path     = $RelPath
                    Line     = ($ln + 1)
                })
        }
    }
    return $hits
}

function ConvertTo-NormRelPath {
    param([Parameter(Mandatory = $true)][string]$RelPath)
    return ([string]$RelPath).Replace('\', '/').TrimStart('/')
}

# True when a repo-relative path falls inside the named evidence allowlist.
function Test-Allowlisted {
    param([Parameter(Mandatory = $true)][string]$RelPath)
    $norm = ConvertTo-NormRelPath -RelPath $RelPath
    foreach ($entry in $EvidenceAllowlist) {
        $prefix = ConvertTo-NormRelPath -RelPath $entry
        if ($norm.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

# The AC1 refusal predicate, implemented (G-430).  Returns $null when the entry
# is acceptable, otherwise the refusal reason.  This single function is what the
# plain run and control 7 both call - so a header claim cannot drift from the
# behaviour.
function Get-AllowlistRefusalReason {
    param([Parameter(Mandatory = $true)][string]$Entry)
    $norm = ConvertTo-NormRelPath -RelPath $Entry

    foreach ($exception in $RequiredExceptions) {
        if ($norm -eq (ConvertTo-NormRelPath -RelPath $exception)) { return $null }
    }

    if ($norm.StartsWith('apps/', [System.StringComparison]::OrdinalIgnoreCase) -or $norm -eq 'apps') {
        return ('no product source may be allowlisted ({0})' -f $Entry)
    }

    foreach ($forbidden in $ForbiddenAllowlistPrefixes) {
        $prefix = ConvertTo-NormRelPath -RelPath $forbidden
        if ($norm.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            return ('a current-state document may not be allowlisted ({0} matches {1})' -f $Entry, $forbidden)
        }
    }

    return $null
}

# ---------------------------------------------------------------------------
# Ignore filter - the repository's own definition of "not prose corpus"
# ---------------------------------------------------------------------------
# Returns the subset of repo-relative (`/`-normalized) paths that git reports as
# IGNORED.  The walk is otherwise unfiltered, so this is a MONOTONE NARROWING:
# it can only remove candidates, never invent a hit.  `check-ignore` consults
# the index, so a TRACKED file inside an ignored directory is reported NOT
# ignored and stays scanned - this FILTER therefore cannot hide tracked prose.
#
# Batching: one git child process per ~500 paths, never one per file.  The path
# list is fed through stdin NUL-separated with `-z` output, which sidesteps both
# the Windows argv limit and the CRLF hazard (a PowerShell pipeline into git
# leaks CRLF into every path and silently matches nothing).
#
# FAIL CLOSED: any outcome other than "some ignored" (exit 0) / "none ignored"
# (exit 1) leaves Ok = $false.  Callers must NOT fall back to the unfiltered
# walk - silently widening the universe is the defect this filter removes.
function Get-IgnoredRelPaths {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string[]]$RelPaths = @()
    )

    $out = [pscustomobject]@{
        Ok      = $false
        Reason  = ''
        Ignored = (New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase))
    }

    if (($null -eq $RelPaths) -or ($RelPaths.Count -eq 0)) {
        $out.Ok = $true
        return $out
    }

    $tmpIn = $null
    $tmpOut = $null
    $tmpErr = $null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $nul = [string][char]0
    try {
        $tmpIn = [System.IO.Path]::GetTempFileName()
        $tmpOut = [System.IO.Path]::GetTempFileName()
        $tmpErr = [System.IO.Path]::GetTempFileName()
        $chunkSize = 500
        for ($start = 0; $start -lt $RelPaths.Count; $start += $chunkSize) {
            $end = [Math]::Min($start + $chunkSize - 1, $RelPaths.Count - 1)
            $chunk = @($RelPaths[$start..$end])
            [System.IO.File]::WriteAllText($tmpIn, (($chunk -join $nul) + $nul), $utf8)
            $proc = Start-Process -FilePath 'git' `
                -ArgumentList @('check-ignore', '-z', '--stdin') `
                -WorkingDirectory $RepoRoot `
                -RedirectStandardInput $tmpIn `
                -RedirectStandardOutput $tmpOut `
                -RedirectStandardError $tmpErr `
                -NoNewWindow -PassThru -Wait
            $code = $proc.ExitCode
            if (($code -ne 0) -and ($code -ne 1)) {
                $detail = ''
                try { $detail = ([System.IO.File]::ReadAllText($tmpErr)).Trim() } catch { }
                if ($detail -eq '') { $detail = 'no detail' }
                $out.Reason = ('ignore filter unavailable: git check-ignore exited {0} ({1})' -f $code, $detail)
                return $out
            }
            if ($code -eq 0) {
                $text = [System.IO.File]::ReadAllText($tmpOut)
                foreach ($p in ($text -split $nul)) {
                    if ($p -ne '') { [void]$out.Ignored.Add($p) }
                }
            }
        }
        $out.Ok = $true
        return $out
    }
    catch {
        $out.Reason = ('ignore filter unavailable: {0}' -f $_.Exception.Message)
        return $out
    }
    finally {
        foreach ($t in @($tmpIn, $tmpOut, $tmpErr)) {
            if ($t -and (Test-Path -LiteralPath $t)) {
                try { Remove-Item -LiteralPath $t -Force } catch { }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Repo scan (both roots)
# ---------------------------------------------------------------------------
function Invoke-NavProseScan {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $result = [pscustomobject]@{
        Ok              = $false
        Reason          = ''
        Scanned         = 0
        IgnoredExcluded = 0
        CountA          = 0
        CountB          = 0
        CountC          = 0
        CountD          = 0
        CountE          = 0
        Hits            = (New-Object System.Collections.Generic.List[object])
    }

    $repoRootTrim = $RepoRoot.TrimEnd('\')
    $repoLen = $repoRootTrim.Length

    $files = New-Object System.Collections.Generic.List[string]
    foreach ($scanRel in $ScanRelRoots) {
        $scanRoot = Join-Path $RepoRoot $scanRel
        if (-not (Test-Path -LiteralPath $scanRoot)) {
            $result.Reason = ('scan root missing: {0}' -f $scanRoot)
            return $result
        }
        $scanRoot = (Resolve-Path -LiteralPath $scanRoot).Path.TrimEnd('\')
        $walk = Get-ChildItem -LiteralPath $scanRoot -Recurse -File -Force -ErrorAction SilentlyContinue
        foreach ($f in $walk) {
            $full = $f.FullName
            if ($SkipDirNames.Count -gt 0) {
                $relProbe = '\' + $full.Substring($scanRoot.Length).TrimStart('\') + '\'
                $pruned = $false
                foreach ($d in $SkipDirNames) {
                    if ($relProbe -match ('(?i)[\\/]' + [regex]::Escape($d) + '[\\/]')) { $pruned = $true; break }
                }
                if ($pruned) { continue }
            }
            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            if ($TextExtensions -notcontains $ext) { continue }
            [void]$files.Add($full)
        }
    }
    $files.Sort()

    # Narrow the candidate set by the repository's own ignore rules.  This is a
    # monotone narrowing (it can only remove candidates), and it FAILS CLOSED:
    # if git cannot answer, the scan does not proceed with a wider universe.
    $relByFull = @{}
    $relForQuery = New-Object System.Collections.Generic.List[string]
    foreach ($full in $files) {
        $rel = $full.Substring($repoLen).TrimStart('\', '/').Replace('\', '/')
        $relByFull[$full] = $rel
        [void]$relForQuery.Add($rel)
    }
    $ignore = Get-IgnoredRelPaths -RepoRoot $repoRootTrim -RelPaths @($relForQuery.ToArray())
    if (-not $ignore.Ok) {
        $result.Reason = $ignore.Reason
        return $result
    }
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($full in $files) {
        $rel = $relByFull[$full]
        if ($ignore.Ignored.Contains($rel)) {
            $result.IgnoredExcluded = $result.IgnoredExcluded + 1
            continue
        }
        [void]$kept.Add($full)
    }
    $files = $kept

    foreach ($full in $files) {
        $rel = $full.Substring($repoLen).TrimStart('\', '/').Replace('\', '/')
        $text = $null
        try { $text = [System.IO.File]::ReadAllText($full) } catch { continue }
        $result.Scanned = $result.Scanned + 1

        # Cheap sound pre-filter: a token can only match if the RAW text already
        # contains it.  Only groups that survive pay for a line pass.
        $candidates = New-Object System.Collections.Generic.List[hashtable]
        foreach ($group in $Groups) {
            foreach ($tok in $group.Tokens) {
                if ($text.IndexOf($tok, [System.StringComparison]::Ordinal) -ge 0) {
                    [void]$candidates.Add($group)
                    break
                }
            }
        }
        if ($candidates.Count -eq 0) { continue }

        foreach ($group in $candidates) {
            $found = @(Get-HitsInText -Text $text -Group $group -RelPath $rel)
            foreach ($h in $found) {
                [void]$result.Hits.Add($h)
                if ($h.HitClass -eq 'A') { $result.CountA = $result.CountA + 1 }
                elseif ($h.HitClass -eq 'B') { $result.CountB = $result.CountB + 1 }
                elseif ($h.HitClass -eq 'C') { $result.CountC = $result.CountC + 1 }
                elseif ($h.HitClass -eq 'D') { $result.CountD = $result.CountD + 1 }
                else { $result.CountE = $result.CountE + 1 }
            }
        }
    }

    if ($result.Scanned -eq 0) {
        $result.Reason = 'zero files scanned'
        return $result
    }
    $result.Ok = $true
    return $result
}

function Get-FailingHits {
    param([Parameter(Mandatory = $true)]$Scan)
    return @($Scan.Hits | Where-Object { -not (Test-Allowlisted -RelPath $_.Path) })
}

function Write-ClassCounts {
    param([Parameter(Mandatory = $true)]$Scan)
    Write-Output ('Class A - {0}: {1} hit(s) [{2} tokens]' -f $GroupA.Label, $Scan.CountA, $GroupA.Tokens.Count)
    Write-Output ('Class B - {0}: {1} hit(s) [{2} tokens]' -f $GroupB.Label, $Scan.CountB, $GroupB.Tokens.Count)
    Write-Output ('Class C - {0}: {1} hit(s) [{2} tokens]' -f $GroupC.Label, $Scan.CountC, $GroupC.Tokens.Count)
    Write-Output ('Class D - {0}: {1} hit(s) [{2} tokens]' -f $GroupD.Label, $Scan.CountD, $GroupD.Tokens.Count)
    Write-Output ('Class E - {0}: {1} hit(s) [{2} tokens]' -f $GroupE.Label, $Scan.CountE, $GroupE.Tokens.Count)
}

# ---------------------------------------------------------------------------
# Resolve the repo root
# ---------------------------------------------------------------------------
if (-not $Root) {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $Root = (Resolve-Path (Join-Path $here '..\..')).Path
}
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Output ('ERROR: root not found: {0}' -f $Root)
    exit 2
}
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')

$TotalTokens = 0
foreach ($group in $Groups) { $TotalTokens = $TotalTokens + $group.Tokens.Count }

# ---------------------------------------------------------------------------
# Guard: the AC1 allowlist refusal predicate, BEFORE any scanning (G-430)
# ---------------------------------------------------------------------------
$allowlistRefusals = New-Object System.Collections.Generic.List[string]
foreach ($entry in $EvidenceAllowlist) {
    $reason = Get-AllowlistRefusalReason -Entry $entry
    if ($null -ne $reason) { [void]$allowlistRefusals.Add($reason) }
}

if (-not $SelfTest -and ($allowlistRefusals.Count -gt 0)) {
    Write-Output '=== check-navigation-prose-retired ==='
    Write-Output ('Repo root: {0}' -f $Root)
    foreach ($r in $allowlistRefusals) { Write-Output ('ERROR: evidence allowlist is not admissible: {0}' -f $r) }
    Write-Output ('Evidence allowlist: {0} entries - REFUSED' -f $EvidenceAllowlist.Count)
    Write-Output 'Scanned files: 0'
    Write-Output 'Ignore filter: 0 path(s) excluded (git check-ignore)'
    Write-Output 'ERROR: cannot run - an allowlist entry names a current-state document or product source'
    exit 2
}

# ---------------------------------------------------------------------------
# Self-test (seven controls)
# ---------------------------------------------------------------------------
if ($SelfTest) {
    Write-Output '=== check-navigation-prose-retired : SelfTest ==='
    Write-Output ('Repo root: {0}' -f $Root)
    Write-Output ('Scanned roots: {0}' -f ($ScanRelRoots -join ', '))
    Write-Output ('Tokens declared: {0}' -f $TotalTokens)
    $failures = 0

    # ---- (1) POSITIVE: one leg per token, iterated from the token data ----
    Write-Output 'CONTROL 1 - POSITIVE (one leg per token, driven by the token lists):'
    $legCount = 0
    foreach ($group in $Groups) {
        $boundaries = [bool]$group.Boundaries
        foreach ($tok in $group.Tokens) {
            $legCount++
            # A prose-framed synthetic line: this AC is a PROSE predicate, so the
            # token is embedded exactly the way a document would carry it.
            $synthetic = ('This sentence mentions {0} in ordinary prose.' -f $tok)
            $flagged = Test-TokenMatch -Text $synthetic -Token $tok -Boundaries $boundaries
            if ($flagged) {
                Write-Output ('  [PASS] class {0}  {1}' -f $group.Class, $tok)
            }
            else {
                Write-Output ('  [FAIL] class {0}  {1}  (did not flag its own synthetic prose hit)' -f $group.Class, $tok)
                $failures++
            }
        }
    }
    Write-Output ('  legs executed: {0}; tokens declared: {1}' -f $legCount, $TotalTokens)
    if ($legCount -ne $TotalTokens) {
        Write-Output '  [FAIL] a declared token has no self-test leg'
        $failures++
    }
    else {
        Write-Output '  [PASS] every declared token has a leg'
    }

    # ---- (2) NEGATIVE: allowlisted hit reported, not failing; outside fails ----
    Write-Output 'CONTROL 2 - NEGATIVE (allowlisted hit reported but does not fail; the same hit outside fails):'
    $negAllowFull = Join-Path $Root $AllowlistedProbeRelPath
    $negOutFull = Join-Path $Root $NegativeProbeRelPath
    $probeLine = 'This line mentions NavigationEngine and shared/navigation on purpose.'
    $negOk = $false
    if ((Test-Path -LiteralPath $negAllowFull) -or (Test-Path -LiteralPath $negOutFull)) {
        Write-Output '  [FAIL] a control-2 probe path already exists before the write'
        $failures++
    }
    else {
        try {
            [System.IO.File]::WriteAllText($negAllowFull, ($probeLine + "`r`n"))
            [System.IO.File]::WriteAllText($negOutFull, ($probeLine + "`r`n"))
            Write-Output ('  wrote allowlisted probe: {0}' -f $AllowlistedProbeRelPath)
            Write-Output ('  wrote non-allowlisted probe: {0}' -f $NegativeProbeRelPath)

            $negScan = Invoke-NavProseScan -RepoRoot $Root
            if (-not $negScan.Ok) {
                Write-Output ('  [FAIL] the scan could not run with the control-2 probes present: {0}' -f $negScan.Reason)
            }
            else {
                $allowHits = @($negScan.Hits | Where-Object { $_.Path -eq $AllowlistedProbeRelPath })
                $outHits = @($negScan.Hits | Where-Object { $_.Path -eq $NegativeProbeRelPath })
                $failing = @(Get-FailingHits -Scan $negScan)
                $allowStillFailing = @($failing | Where-Object { $_.Path -eq $AllowlistedProbeRelPath })
                $outStillFailing = @($failing | Where-Object { $_.Path -eq $NegativeProbeRelPath })
                Write-Output ('  allowlisted probe: {0} hit(s) reported, {1} counted as failing' -f $allowHits.Count, $allowStillFailing.Count)
                Write-Output ('  outside probe:     {0} hit(s) reported, {1} counted as failing' -f $outHits.Count, $outStillFailing.Count)
                if ($allowHits.Count -lt 1) {
                    Write-Output '  [FAIL] the allowlisted probe produced no hit at all (it must be REPORTED)'
                }
                elseif ($allowStillFailing.Count -ne 0) {
                    Write-Output '  [FAIL] an allowlisted hit was counted as failing'
                }
                elseif ($outHits.Count -lt 1) {
                    Write-Output '  [FAIL] the outside probe produced no hit (the allowlist would be vacuously wide)'
                }
                elseif ($outStillFailing.Count -lt 1) {
                    Write-Output '  [FAIL] the same hit moved outside the allowlist did NOT fail'
                }
                else {
                    Write-Output '  [PASS] the allowlist reports without failing, and the same hit outside the allowlist fails'
                    $negOk = $true
                }
            }
        }
        finally {
            foreach ($p in @($negAllowFull, $negOutFull)) {
                if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
            }
        }
        if ((Test-Path -LiteralPath $negAllowFull) -or (Test-Path -LiteralPath $negOutFull)) {
            Write-Output '  [FAIL] a control-2 probe still exists after cleanup'
            $failures++
        }
        else {
            Write-Output '  control-2 probes removed (both paths absent)'
        }
        if (-not $negOk) { $failures++ }
    }

    # ---- (3) SEEDED ROOT: an untracked non-ignored probe is caught ----
    Write-Output ('CONTROL 3 - SEEDED ROOT (untracked non-ignored probe at {0}):' -f $ProbeRelPath)
    $probeFull = Join-Path $Root $ProbeRelPath
    if (Test-Path -LiteralPath $probeFull) {
        Write-Output ('  [FAIL] probe path already exists before the write: {0}' -f $ProbeRelPath)
        $failures++
    }
    else {
        $preIgnore = Get-IgnoredRelPaths -RepoRoot $Root -RelPaths @($ProbeRelPath)
        if (-not $preIgnore.Ok) {
            Write-Output ('  [FAIL] the ignore query this control depends on could not run: {0}' -f $preIgnore.Reason)
            $failures++
        }
        elseif ($preIgnore.Ignored.Contains($ProbeRelPath)) {
            Write-Output ('  [FAIL] the seeded probe path is git-ignored, so this control would prove nothing: {0}' -f $ProbeRelPath)
            $failures++
        }
        else {
            $seededOk = $false
            try {
                $probeBody = 'This document mentions NavigationEngine on its first line.' + "`r`n" +
                    'It also mentions validateSurface on its second line.' + "`r`n"
                [System.IO.File]::WriteAllText($probeFull, $probeBody)
                Write-Output ('  wrote probe: {0}' -f $ProbeRelPath)

                $seeded = Invoke-NavProseScan -RepoRoot $Root
                if (-not $seeded.Ok) {
                    Write-Output ('  [FAIL] the scan could not run with the seeded probe present: {0}' -f $seeded.Reason)
                }
                else {
                    $probeHits = @($seeded.Hits | Where-Object { $_.Path -eq $ProbeRelPath })
                    $exactFirst = @($probeHits | Where-Object { ($_.Line -eq 1) -and ($_.HitClass -eq 'B') })
                    Write-Output ('  scanned with probe present: {0} file(s), {1} excluded by the ignore filter, {2} hit(s) on the probe' -f $seeded.Scanned, $seeded.IgnoredExcluded, $probeHits.Count)
                    foreach ($h in $probeHits) {
                        Write-Output ('    seeded hit: {0}:{1}: {2} [class {3}]' -f $h.Path, $h.Line, $h.Token, $h.HitClass)
                    }
                    if ($exactFirst.Count -ge 1) {
                        Write-Output ('  [PASS] seeded hit reported at exactly {0}:1' -f $ProbeRelPath)
                        $seededOk = $true
                    }
                    else {
                        Write-Output ('  [FAIL] expected a class-B hit at exactly {0}:1 (got {1} on the probe)' -f $ProbeRelPath, $probeHits.Count)
                    }
                }
            }
            finally {
                if (Test-Path -LiteralPath $probeFull) { Remove-Item -LiteralPath $probeFull -Force }
            }

            if (Test-Path -LiteralPath $probeFull) {
                Write-Output ('  [FAIL] probe still exists after cleanup: {0}' -f $ProbeRelPath)
                $failures++
            }
            else {
                Write-Output ('  probe removed: {0} (path absent)' -f $ProbeRelPath)
            }

            $post = Invoke-NavProseScan -RepoRoot $Root
            if ($post.Ok) {
                $residual = @($post.Hits | Where-Object { $_.Path -eq $ProbeRelPath })
                if ($residual.Count -eq 0) {
                    Write-Output ('  [PASS] post-delete rescan carries no hit at the probe path ({0} files scanned)' -f $post.Scanned)
                }
                else {
                    Write-Output ('  [FAIL] post-delete rescan still reports {0} hit(s) at the probe path' -f $residual.Count)
                    $failures++
                }
            }
            else {
                Write-Output ('  [FAIL] post-delete rescan could not run: {0}' -f $post.Reason)
                $failures++
            }

            if (-not $seededOk) { $failures++ }
        }
    }

    # ---- (4) OUT-OF-ROOT NON-SCAN ----
    Write-Output ('CONTROL 4 - OUT-OF-ROOT NON-SCAN (probe at {0}, outside both roots):' -f $OutOfRootRelPath)
    $outProbeFull = Join-Path $Root $OutOfRootRelPath
    if (Test-Path -LiteralPath $outProbeFull) {
        Write-Output ('  [FAIL] out-of-root probe path already exists before the write: {0}' -f $OutOfRootRelPath)
        $failures++
    }
    else {
        $outOk = $false
        try {
            [System.IO.File]::WriteAllText($outProbeFull, ($probeLine + "`r`n"))
            Write-Output ('  wrote out-of-root probe: {0}' -f $OutOfRootRelPath)

            $outside = Invoke-NavProseScan -RepoRoot $Root
            if (-not $outside.Ok) {
                Write-Output ('  [FAIL] the scan could not run with the out-of-root probe present: {0}' -f $outside.Reason)
            }
            else {
                $outHits = @($outside.Hits | Where-Object { $_.Path -eq $OutOfRootRelPath })
                Write-Output ('  scanned with out-of-root probe present: {0} file(s) (roots unchanged), {1} hit(s) on the probe' -f $outside.Scanned, $outHits.Count)
                if ($outHits.Count -eq 0) {
                    Write-Output '  [PASS] out-of-root file NOT scanned (root confinement holds)'
                    $outOk = $true
                }
                else {
                    Write-Output ('  [FAIL] out-of-root file WAS scanned: {0}' -f $OutOfRootRelPath)
                    foreach ($h in $outHits) { Write-Output ('    unexpected hit: {0}:{1}: {2}' -f $h.Path, $h.Line, $h.Token) }
                }
            }
        }
        finally {
            if (Test-Path -LiteralPath $outProbeFull) { Remove-Item -LiteralPath $outProbeFull -Force }
        }
        if (Test-Path -LiteralPath $outProbeFull) {
            Write-Output ('  [FAIL] out-of-root probe still exists after cleanup: {0}' -f $OutOfRootRelPath)
            $failures++
        }
        else {
            Write-Output ('  out-of-root probe removed: {0} (path absent)' -f $OutOfRootRelPath)
        }
        if (-not $outOk) { $failures++ }
    }

    # ---- (5) IGNORED NON-SCAN ----
    Write-Output ('CONTROL 5 - IGNORED NON-SCAN (probe inside a root at {0}, a git-ignored dir):' -f $IgnoredProbeRelPath)
    # The precondition is ASKED OF GIT, and a missing rule FAILS LOUDLY: a
    # control that cannot establish its own precondition asserts nothing.
    $ignoredPre = Get-IgnoredRelPaths -RepoRoot $Root -RelPaths @($IgnoredProbeRelPath, $IgnoredPlanProbeRelPath)
    if (-not $ignoredPre.Ok) {
        Write-Output ('  [FAIL] the ignore query this control depends on could not run: {0}' -f $ignoredPre.Reason)
        $failures++
    }
    elseif (-not $ignoredPre.Ignored.Contains($IgnoredProbeRelPath)) {
        Write-Output ('  [FAIL] the ignore rule this control depends on is gone: git does not ignore {0}' -f $IgnoredProbeRelPath)
        $failures++
    }
    elseif (-not $ignoredPre.Ignored.Contains($IgnoredPlanProbeRelPath)) {
        Write-Output ('  [FAIL] the ignore rule the plan names is gone: git does not ignore {0}' -f $IgnoredPlanProbeRelPath)
        $failures++
    }
    else {
        Write-Output ('  [PASS] git itself reports both probe paths ignored (precondition established, not assumed)')
        $ignoredProbeFull = Join-Path $Root $IgnoredProbeRelPath
        $ignoredDirFull = Join-Path $Root $IgnoredProbeDirRel
        $planProbeFull = Join-Path $Root $IgnoredPlanProbeRelPath
        # DERIVED from the probe path, never a second literal that could drift from
        # the token table. The plan path lives under `.opencode/tmp/`, which is
        # gitignored (.gitignore) and therefore ABSENT in every fresh clone and CI
        # checkout - so this control must create it before writing, or
        # `WriteAllText` throws DirectoryNotFoundException on exactly the machine
        # that has to run the self-test.
        $planProbeDirFull = Split-Path -Parent $planProbeFull
        $dirPreExisted = Test-Path -LiteralPath $ignoredDirFull
        # Only remove what this control CREATED - a pre-existing file is never
        # deleted by a control.
        $planProbePreExisted = Test-Path -LiteralPath $planProbeFull
        $planDirPreExisted = Test-Path -LiteralPath $planProbeDirFull
        $ignoredOk = $false
        $writesOk = $true
        try {
            # A failed write must fail LOUDLY: an aborted try body would otherwise
            # reach the "removed" tail and read as a quiet pass (F-3).
            try {
                if (-not $dirPreExisted) { [void](New-Item -ItemType Directory -Path $ignoredDirFull -Force) }
                if (-not $planDirPreExisted) { [void](New-Item -ItemType Directory -Path $planProbeDirFull -Force) }
                [System.IO.File]::WriteAllText($ignoredProbeFull, ($probeLine + "`r`n"))
                if (-not $planProbePreExisted) {
                    [System.IO.File]::WriteAllText($planProbeFull, ($probeLine + "`r`n"))
                }
            }
            catch {
                # NO rethrow: the remaining controls must still run and print. The
                # failure is recorded here and counted by the single
                # `if (-not $ignoredOk)` at the end of this control - no second
                # $failures++.
                Write-Output ('  [FAIL] the control could not write its probes: {0}' -f $_.Exception.Message)
                $ignoredOk = $false
                $writesOk = $false
            }
            Write-Output ('  wrote ignored probe: {0}' -f $IgnoredProbeRelPath)
            Write-Output ('  wrote ignored plan probe: {0}' -f $IgnoredPlanProbeRelPath)

            $withIgnored = Invoke-NavProseScan -RepoRoot $Root
            if (-not $withIgnored.Ok) {
                Write-Output ('  [FAIL] the scan could not run with the ignored probe present: {0}' -f $withIgnored.Reason)
            }
            elseif (-not $writesOk) {
                # The probes were not written, so a zero-hit result would assert
                # nothing. Do not read it as a pass.
                Write-Output '  [FAIL] the probe scan was skipped because the probes could not be written'
            }
            else {
                $ignoredHits = @($withIgnored.Hits | Where-Object { $_.Path -eq $IgnoredProbeRelPath })
                $planHits = @($withIgnored.Hits | Where-Object { $_.Path -eq $IgnoredPlanProbeRelPath })
                Write-Output ('  scanned with ignored probe present: {0} file(s), {1} excluded by the ignore filter, {2} hit(s) on the in-root probe, {3} on the plan path' -f $withIgnored.Scanned, $withIgnored.IgnoredExcluded, $ignoredHits.Count, $planHits.Count)
                if ($withIgnored.IgnoredExcluded -lt 1) {
                    Write-Output '  [FAIL] the ignore filter excluded nothing - it is inert'
                }
                elseif (($ignoredHits.Count -ne 0) -or ($planHits.Count -ne 0)) {
                    Write-Output '  [FAIL] a gitignored probe WAS scanned'
                    foreach ($h in ($ignoredHits + $planHits)) { Write-Output ('    unexpected hit: {0}:{1}: {2}' -f $h.Path, $h.Line, $h.Token) }
                }
                else {
                    Write-Output '  [PASS] gitignored probes NOT scanned (the ignore filter is engaged, not inert)'
                    $ignoredOk = $true
                }
            }
        }
        finally {
            foreach ($p in @($ignoredProbeFull)) {
                if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
            }
            if ((-not $planProbePreExisted) -and (Test-Path -LiteralPath $planProbeFull)) {
                Remove-Item -LiteralPath $planProbeFull -Force
            }
            if ((-not $dirPreExisted) -and (Test-Path -LiteralPath $ignoredDirFull)) {
                $left = @(Get-ChildItem -LiteralPath $ignoredDirFull -Force -ErrorAction SilentlyContinue)
                if ($left.Count -eq 0) { Remove-Item -LiteralPath $ignoredDirFull -Force }
            }
            # Remove the plan probe's derived parent ONLY when this control created
            # it AND it is empty - a live `.opencode/tmp/<issue>/` from this very run
            # must survive this cleanup.
            if ((-not $planDirPreExisted) -and (Test-Path -LiteralPath $planProbeDirFull)) {
                $planLeft = @(Get-ChildItem -LiteralPath $planProbeDirFull -Force -ErrorAction SilentlyContinue)
                if ($planLeft.Count -eq 0) { Remove-Item -LiteralPath $planProbeDirFull -Force }
            }
        }
        $leftover = $false
        foreach ($p in @($ignoredProbeFull)) {
            if (Test-Path -LiteralPath $p) { $leftover = $true }
        }
        if ((-not $planProbePreExisted) -and (Test-Path -LiteralPath $planProbeFull)) { $leftover = $true }
        if ($leftover) {
            Write-Output '  [FAIL] an ignored probe still exists after cleanup'
            $failures++
        }
        else {
            Write-Output '  ignored probes removed (both paths absent)'
        }
        if ($dirPreExisted) {
            Write-Output ('  pre-existing probe dir untouched: {0}' -f $IgnoredProbeDirRel)
        }
        elseif (Test-Path -LiteralPath $ignoredDirFull) {
            Write-Output ('  [FAIL] the probe dir this control created was not removed: {0}' -f $IgnoredProbeDirRel)
            $failures++
        }
        else {
            Write-Output ('  probe dir created by this control removed: {0} (path absent)' -f $IgnoredProbeDirRel)
        }
        # The plan probe's parent gets the SAME three-way report: a dir this control
        # created and failed to remove is a defect, never a silent pass.
        if ($planDirPreExisted) {
            Write-Output ('  pre-existing plan probe dir untouched: {0}' -f $planProbeDirFull)
        }
        elseif (Test-Path -LiteralPath $planProbeDirFull) {
            Write-Output ('  [FAIL] the plan probe dir this control created was not removed (not empty): {0}' -f $planProbeDirFull)
            $failures++
        }
        else {
            Write-Output ('  plan probe dir created by this control removed: {0} (path absent)' -f $planProbeDirFull)
        }
        if (-not $ignoredOk) { $failures++ }
    }

    # ---- (6) SELF-REFERENCE ----
    Write-Output ('CONTROL 6 - SELF-REFERENCE (the guard spells all {0} tokens and lives outside both roots):' -f $TotalTokens)
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
    $scriptUnderRoot = $false
    if ($scriptPath) {
        $scriptNorm = $scriptPath.Replace('\', '/')
        $rootNorm = $Root.Replace('\', '/')
        foreach ($scanRel in $ScanRelRoots) {
            $abs = ($rootNorm.TrimEnd('/') + '/' + $scanRel).Replace('\', '/')
            if ($scriptNorm.StartsWith($abs + '/', [System.StringComparison]::OrdinalIgnoreCase)) { $scriptUnderRoot = $true }
        }
    }
    $selfTokens = 0
    if ($scriptPath -and (Test-Path -LiteralPath $scriptPath)) {
        $scriptText = [System.IO.File]::ReadAllText($scriptPath)
        foreach ($group in $Groups) {
            foreach ($tok in $group.Tokens) {
                # The token table carries every token, so a missing spelling means
                # a leg was silently dropped from the list.
                if ($scriptText.IndexOf($tok, [System.StringComparison]::Ordinal) -ge 0) { $selfTokens++ }
            }
        }
    }
    if ($scriptUnderRoot) {
        Write-Output '  [FAIL] the guard lives inside a scanned root'
        $failures++
    }
    elseif ($selfTokens -ne $TotalTokens) {
        Write-Output ('  [FAIL] the guard''s own source spells {0} of {1} tokens' -f $selfTokens, $TotalTokens)
        $failures++
    }
    else {
        $plain = Invoke-NavProseScan -RepoRoot $Root
        if (-not $plain.Ok) {
            Write-Output ('  [FAIL] the plain run could not complete: {0}' -f $plain.Reason)
            $failures++
        }
        else {
            $failing = @(Get-FailingHits -Scan $plain)
            # The guard cannot scan itself: it lives outside both roots, which the
            # predicate above already proved.  Assert the consequence directly -
            # every hit originates in a scanned root, never in the guard's own
            # directory.
            $selfHits = @($plain.Hits | Where-Object {
                    $normHit = ConvertTo-NormRelPath -RelPath $_.Path
                    return $normHit.StartsWith('.opencode/scripts/', [System.StringComparison]::OrdinalIgnoreCase)
                })
            Write-Output ('  guard source spells {0}/{1} tokens and lives OUTSIDE both roots' -f $selfTokens, $TotalTokens)
            Write-Output ('  plain run: {0} file(s) scanned, {1} hit(s), {2} non-allowlisted, {3} from the guard''s own directory' -f $plain.Scanned, $plain.Hits.Count, $failing.Count, $selfHits.Count)
            if ($selfHits.Count -ne 0) {
                Write-Output '  [FAIL] a hit originated in .opencode/scripts/ - the guard is scanning itself'
                $failures++
            }
            elseif ($failing.Count -eq 0) {
                Write-Output '  [PASS] plain run CLEAN with all tokens spelled in the guard (AC1 is non-vacuous)'
            }
            else {
                # ST-1 lands the instrument BEFORE the sweeps (ST-3..ST-7).  The
                # mechanism is proven here; the corpus is not yet clean, and the
                # plain-run-green assertion belongs to the last sweep's harness
                # leg.  Printing this honestly is the point.
                Write-Output ('  [PASS] self-reference mechanism proven (the residual {0} non-allowlisted hit(s) are the corpus ST-3..ST-7 sweep)' -f $failing.Count)
            }
        }
    }

    # ---- (7) ALLOWLIST AUDIT ----
    Write-Output 'CONTROL 7 - ALLOWLIST AUDIT (content + both refusal directions):'
    $auditOk = $true
    if ($EvidenceAllowlist.Count -ne 8) {
        Write-Output ('  [FAIL] the allowlist has {0} entries; the contract names exactly 8' -f $EvidenceAllowlist.Count)
        $auditOk = $false
    }
    else {
        Write-Output ('  [PASS] the allowlist has exactly {0} entries' -f $EvidenceAllowlist.Count)
    }
    foreach ($entry in $EvidenceAllowlist) {
        $norm = ConvertTo-NormRelPath -RelPath $entry
        $resolved = Join-Path $Root $norm
        if (-not (Test-Path -LiteralPath $resolved)) {
            Write-Output ('  [FAIL] allowlist entry does not resolve on disk: {0}' -f $entry)
            $auditOk = $false
            continue
        }
        if ($norm.StartsWith('apps/', [System.StringComparison]::OrdinalIgnoreCase) -or $norm -eq 'apps') {
            Write-Output ('  [FAIL] allowlist entry names product source: {0}' -f $entry)
            $auditOk = $false
            continue
        }
        $reason = Get-AllowlistRefusalReason -Entry $entry
        $isException = $false
        foreach ($exception in $RequiredExceptions) {
            if ($norm -eq (ConvertTo-NormRelPath -RelPath $exception)) { $isException = $true }
        }
        if ($isException) {
            if ($null -ne $reason) {
                Write-Output ('  [FAIL] the named exception was refused: {0} ({1})' -f $entry, $reason)
                $auditOk = $false
            }
            else {
                Write-Output ('  [PASS] the named exception inside a forbidden prefix is ACCEPTED: {0}' -f $entry)
            }
        }
        elseif ($null -ne $reason) {
            Write-Output ('  [FAIL] allowlist entry is not admissible: {0} ({1})' -f $entry, $reason)
            $auditOk = $false
        }
    }
    # Both directions of the predicate.  A sibling current-state doc under the
    # SAME forbidden prefix must be REFUSED: a table that accepts everything
    # under `docs/agentic-pipeline/` would quietly narrow the scan.
    $siblingProbe = 'docs/agentic-pipeline/playbooks/software-architect.md'
    $siblingReason = Get-AllowlistRefusalReason -Entry $siblingProbe
    if ($null -eq $siblingReason) {
        Write-Output ('  [FAIL] a current-state doc under the forbidden prefix was ACCEPTED: {0}' -f $siblingProbe)
        $auditOk = $false
    }
    else {
        Write-Output ('  [PASS] a sibling current-state doc under the same forbidden prefix is REFUSED: {0}' -f $siblingProbe)
    }
    $forbiddenProbe = 'docs/FAQ.md'
    if ($null -eq (Get-AllowlistRefusalReason -Entry $forbiddenProbe)) {
        Write-Output ('  [FAIL] a current-state document was ACCEPTED as allowlist entry: {0}' -f $forbiddenProbe)
        $auditOk = $false
    }
    else {
        Write-Output ('  [PASS] a current-state document is REFUSED as allowlist entry: {0}' -f $forbiddenProbe)
    }
    $appsProbe = 'apps/ui/src/shared/navigation/x.ts'
    if ($null -eq (Get-AllowlistRefusalReason -Entry $appsProbe)) {
        Write-Output ('  [FAIL] a product-source path was ACCEPTED as allowlist entry: {0}' -f $appsProbe)
        $auditOk = $false
    }
    else {
        Write-Output ('  [PASS] a product-source path is REFUSED as allowlist entry: apps/...')
    }
    if ($auditOk) { Write-Output '  [PASS] the allowlist audit passed in both directions' }
    else { $failures++ }

    if ($failures -eq 0) {
        Write-Output ('SELFTEST: PASS (all seven controls passed; {0} tokens / {1} legs)' -f $TotalTokens, $legCount)
        exit 0
    }
    Write-Output ('SELFTEST: FAIL ({0} control failure(s))' -f $failures)
    exit 1
}

# ---------------------------------------------------------------------------
# Plain run
# ---------------------------------------------------------------------------
Write-Output '=== check-navigation-prose-retired ==='
Write-Output ('Repo root: {0}' -f $Root)
Write-Output ('Scanned roots: {0}' -f ($ScanRelRoots -join ', '))
Write-Output ('Text extensions: {0}' -f ($TextExtensions -join ' '))
if ($SkipDirNames.Count -eq 0) {
    Write-Output 'Skip dirs: (none - the universe is DERIVED from .gitignore, G-441)'
}
else {
    Write-Output ('Skip dirs: {0}' -f ($SkipDirNames -join ', '))
}
Write-Output 'Text mode: RAW for every class (no comment stripping, no literal stripping - a prose predicate)'
Write-Output 'File set: recursive walk of the roots MINUS gitignored paths (git check-ignore, fails closed to exit 2)'
Write-Output ('Tokens declared: {0} in 5 classes (A={1} B={2} C={3} D={4} E={5})' -f $TotalTokens, $GroupA.Tokens.Count, $GroupB.Tokens.Count, $GroupC.Tokens.Count, $GroupD.Tokens.Count, $GroupE.Tokens.Count)
Write-Output ('Evidence allowlist: {0} entries (path prefixes)' -f $EvidenceAllowlist.Count)

$scan = Invoke-NavProseScan -RepoRoot $Root
if (-not $scan.Ok) {
    Write-Output ('Scanned files: {0}' -f $scan.Scanned)
    Write-Output ('Ignore filter: {0} path(s) excluded (git check-ignore)' -f $scan.IgnoredExcluded)
    Write-ClassCounts -Scan $scan
    Write-Output ('ERROR: cannot run the absence scan: {0}' -f $scan.Reason)
    exit 2
}

Write-Output ('Scanned files: {0}' -f $scan.Scanned)
Write-Output ('Ignore filter: {0} path(s) excluded (git check-ignore)' -f $scan.IgnoredExcluded)
Write-ClassCounts -Scan $scan

$failing = @(Get-FailingHits -Scan $scan)
if ($failing.Count -eq 0) {
    Write-Output ('HITS: {0} ({1} not covered by the evidence allowlist)' -f $scan.Hits.Count, $failing.Count)
    if ($scan.Hits.Count -eq 0) {
        Write-Output 'RESULT: CLEAN (zero deleted-navigation references in the scanned prose roots)'
    }
    else {
        Write-Output ('RESULT: CLEAN ({0} hit(s), all covered by the evidence allowlist)' -f $scan.Hits.Count)
    }
    exit 0
}

Write-Output ('HITS: {0} ({1} not covered by the evidence allowlist)' -f $scan.Hits.Count, $failing.Count)
foreach ($h in $scan.Hits) {
    $suffix = ''
    if (Test-Allowlisted -RelPath $h.Path) { $suffix = '  [allowlisted]' }
    Write-Output ('  {0}:{1}: {2}  [class {3}]{4}' -f $h.Path, $h.Line, $h.Token, $h.HitClass, $suffix)
}
Write-Output 'RESULT: FAIL (deleted-navigation reference(s) present in a non-allowlisted document)'
exit 1
