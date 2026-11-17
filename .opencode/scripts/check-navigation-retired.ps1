<#
  check-navigation-retired.ps1 - committed absence guard (spec #3151, AC1)

  Proves AC1's scoped absence predicate: "zero references outside the named
  enforcement guard and evidence allowlist".  The scanned root is exactly ONE
  directory:

    apps/ui/src

  Text extensions: .ts .tsx .js .jsx .mjs .cjs .css .json
  Skipped dirs:    node_modules, dist, .git

  TOKEN CLASSES - the TEXT MODE is binding and differs per class:

    A. MODULE_PATH_TOKENS  - COMMENT-STRIPPED RAW text.  The token legitimately
       lives inside an import specifier, so string-literal contents are NOT
       stripped; only comments are removed from the scan window.
         shared/navigation, shared/hotkeys

    B. SYMBOL_TOKENS       - CODE-ONLY.  Comments are removed AND literal text
       is removed (quoted strings, template-literal text, regex-literal bodies)
       before the scan, but a `${...}` interpolation expression inside a
       template is still scanned as CODE (G-419).  Symbol matching is on
       IDENTIFIER BOUNDARIES, so these prefix pairs stay independent:
         JournalEntry   is NOT satisfied by JournalEntryDraft
         JournalStore   is NOT satisfied by createJournalStore
       Literal data is never a reference: a symbol name printed in a comment, a
       string or a regex body is prose/fixture text, not a use of the symbol.

    C. DELETED_FILE_TOKENS - COMMENT-STRIPPED RAW text (they appear as import
       specifiers).
         wireframeSurface, terminalSurface, missionMonitorSurface,
         databaseClientSurface, devModeSurface, windowSystemSurface,
         navigationDemoSurface

  EVIDENCE_ALLOWLIST: EMPTY by construction.  A hit listed here is reported but
  does not fail the gate.  An allowlist entry may NEVER name product source
  (anything under apps/ui/src) - the guard itself lives in .opencode/scripts and
  the retire record in .opencode/tests/retired-navigation, both OUTSIDE the
  scanned root, so neither needs an entry.

  Exit codes: 0 = clean | 1 = at least one hit | 2 = cannot run (bad root, or
  zero files scanned).  With -SelfTest: 0 = every control passed, 1 = a control
  failed.

  SELF-TEST CONTROLS (`-SelfTest`):
    (1) POSITIVE       - one control leg per token, iterated from the token data
                         itself, plus an independent leg per prefix pair.  A
                         token in a class with no leg is a FAILURE, not a silent
                         gap (the loop over the token list IS the leg).
    (2) NEGATIVE       - a comment-only / prose-only / string-literal-only
                         mention flags nothing (the G-419 proof: a symbol in a
                         `// comment`, a string literal or a regex body is not a
                         hit for class B).
    (3) SEEDED ROOT    - write apps/ui/src/__nav_absence_probe__.ts containing
                         one banned import, assert a hit is reported at that
                         exact path and line, delete the probe (in a try/finally
                         so it is removed even when the assertion fails), and
                         assert the tree scans clean again.
    (4) OUT-OF-ROOT    - write the SAME banned import at
                         apps/ui/__nav_absence_probe_outside__.ts (a sibling of
                         the scanned root), assert it is NOT scanned, and delete
                         it (try/finally).  Proves the root confinement the AC
                         claims: the guard scans apps/ui/src and nothing else.

  Usage:
    powershell -File .opencode/scripts/check-navigation-retired.ps1
    powershell -File .opencode/scripts/check-navigation-retired.ps1 -SelfTest
    powershell -File .opencode/scripts/check-navigation-retired.ps1 -Root C:\Code\fredo
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
$ModulePathTokens = @(
    'shared/navigation',
    'shared/hotkeys'
)

$SymbolTokens = @(
    'NavigationEngine',
    'NavigationProvider',
    'NavigationHost',
    'ContextEnvelope',
    'CommandRail',
    'NavigationMap',
    'ActivityTrail',
    'NavKeycap',
    'NAVIGATION_GLOBAL_CHORDS',
    'useNavReducedMotion',
    'useAppCommandIntent',
    'useAppCommandSkill',
    'buildCompanionManifest',
    'installAppCommandSurfacePublisher',
    'getNavigationHost',
    'describeContext',
    'createJournalStore',
    'JournalStore',
    'JournalEntry',
    'JournalEntryDraft',
    'appendJournalEntry',
    'getNavigationJournal',
    'navigationJournal'
)

$DeletedFileTokens = @(
    'wireframeSurface',
    'terminalSurface',
    'missionMonitorSurface',
    'databaseClientSurface',
    'devModeSurface',
    'windowSystemSurface',
    'navigationDemoSurface'
)

# EMPTY by construction.  Every entry would have to live OUTSIDE apps/ui/src.
$EvidenceAllowlist = @()

$ScanRelRoot = 'apps/ui/src'
$TextExtensions = @('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json')
$SkipDirNames = @('node_modules', 'dist', '.git')

$ProbeRelPath = 'apps/ui/src/__nav_absence_probe__.ts'
$ProbeFileName = '__nav_absence_probe__.ts'
# A synthetic hit OUTSIDE the scanned root, used to prove root confinement.
$OutOfRootRelPath = 'apps/ui/__nav_absence_probe_outside__.ts'

# ---------------------------------------------------------------------------
# Literal-aware sanitizer
#
#   -Mode comments -> comment text is blanked; quoted/template/regex CONTENTS
#                     survive (class A and C tokens legitimately live inside an
#                     import string).
#   -Mode code     -> comment text AND literal text are blanked; template `${}`
#                     interpolations are re-entered as CODE (G-419).
#
# Character offsets are preserved (a blanked char becomes a space, newlines are
# kept), so reported line numbers are the real source line numbers.
# ---------------------------------------------------------------------------
$RegexKeywords = @(
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'do', 'else', 'case', 'yield', 'await', 'throw'
)

function ConvertTo-ScannedText {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][ValidateSet('comments', 'code')][string]$Mode
    )

    $stripLiterals = ($Mode -eq 'code')
    $n = $Text.Length
    $blank = New-Object 'System.Collections.Generic.HashSet[int]'

    $i = 0
    $state = 'code'
    # one brace-depth counter per open code frame (top level + each `${...}`)
    $frameDepths = New-Object 'System.Collections.Generic.List[int]'
    [void]$frameDepths.Add(0)
    # 'value' = an expression just ended, so '/' is division
    # 'other' = an operator/opener/comma, so '/' may start a regex
    $prevKind = 'other'

    while ($i -lt $n) {
        $c = $Text[$i]
        $nextc = ''
        if (($i + 1) -lt $n) { $nextc = $Text[$i + 1] }

        # ---------------- template-literal body ----------------
        if ($state -eq 'template') {
            if ($c -eq '\') {
                if ($stripLiterals) {
                    [void]$blank.Add($i)
                    if ((($i + 1) -lt $n) -and ($Text[$i + 1] -ne [char]10)) { [void]$blank.Add($i + 1) }
                }
                $i += 2
                continue
            }
            if ($c -eq '`') {
                if ($stripLiterals) { [void]$blank.Add($i) }
                $i += 1
                $state = 'code'
                $prevKind = 'value'
                continue
            }
            if (($c -eq '$') -and ($nextc -eq '{')) {
                if ($stripLiterals) { [void]$blank.Add($i); [void]$blank.Add($i + 1) }
                $i += 2
                [void]$frameDepths.Add(0)
                $state = 'code'
                $prevKind = 'other'
                continue
            }
            if (($c -ne [char]10) -and $stripLiterals) { [void]$blank.Add($i) }
            $i += 1
            continue
        }

        # ---------------- code ----------------
        if (($c -eq '/') -and ($nextc -eq '/')) {
            while (($i -lt $n) -and ($Text[$i] -ne [char]10)) {
                [void]$blank.Add($i)
                $i += 1
            }
            continue
        }
        if (($c -eq '/') -and ($nextc -eq '*')) {
            [void]$blank.Add($i)
            [void]$blank.Add($i + 1)
            $i += 2
            while ($i -lt $n) {
                if (($Text[$i] -eq '*') -and ((($i + 1) -lt $n)) -and ($Text[$i + 1] -eq '/')) {
                    [void]$blank.Add($i)
                    [void]$blank.Add($i + 1)
                    $i += 2
                    break
                }
                if ($Text[$i] -ne [char]10) { [void]$blank.Add($i) }
                $i += 1
            }
            continue
        }
        # quoted string.  A single quote that sits inside a word (Don't, users')
        # is JSX/prose apostrophe, not a string opener.
        if (($c -eq '"') -or ($c -eq "'")) {
            $isProseApostrophe = ($c -eq "'") -and ($i -gt 0) -and [char]::IsLetter($Text[$i - 1])
            if (-not $isProseApostrophe) {
                $quote = $c
                if ($stripLiterals) { [void]$blank.Add($i) }
                $i += 1
                while ($i -lt $n) {
                    if ($Text[$i] -eq '\') {
                        if ($stripLiterals) {
                            [void]$blank.Add($i)
                            if ((($i + 1) -lt $n) -and ($Text[$i + 1] -ne [char]10)) { [void]$blank.Add($i + 1) }
                        }
                        $i += 2
                        continue
                    }
                    if ($Text[$i] -eq $quote) {
                        if ($stripLiterals) { [void]$blank.Add($i) }
                        $i += 1
                        break
                    }
                    if ($Text[$i] -eq [char]10) { break }
                    if ($stripLiterals) { [void]$blank.Add($i) }
                    $i += 1
                }
                $prevKind = 'value'
                continue
            }
            $prevKind = 'value'
            $i += 1
            continue
        }
        if ($c -eq '`') {
            if ($stripLiterals) { [void]$blank.Add($i) }
            $i += 1
            $state = 'template'
            continue
        }
        # regex literal: only where a value cannot already have ended, and never
        # immediately after '<' (that is a JSX closing tag such as </div>)
        if (($c -eq '/') -and ($prevKind -ne 'value') -and (-not (($i -gt 0) -and ($Text[$i - 1] -eq '<')))) {
            $j = $i + 1
            $inClass = $false
            $closed = $false
            while ($j -lt $n) {
                $ch = $Text[$j]
                if ($ch -eq [char]10) { break }
                if ($ch -eq '\') { $j += 2; continue }
                if ($ch -eq '[') { $inClass = $true; $j += 1; continue }
                if ($ch -eq ']') { $inClass = $false; $j += 1; continue }
                if (($ch -eq '/') -and (-not $inClass)) { $closed = $true; break }
                $j += 1
            }
            if ($closed) {
                for ($k = $i; $k -le $j; $k++) { [void]$blank.Add($k) }
                $j += 1
                while (($j -lt $n) -and [char]::IsLetter($Text[$j])) {
                    [void]$blank.Add($j)
                    $j += 1
                }
                $i = $j
                $prevKind = 'value'
                continue
            }
            $prevKind = 'other'
            $i += 1
            continue
        }
        # identifier
        if ([char]::IsLetter($c) -or ($c -eq '_') -or ($c -eq '$')) {
            $start = $i
            while (($i -lt $n) -and (([char]::IsLetterOrDigit($Text[$i])) -or ($Text[$i] -eq '_') -or ($Text[$i] -eq '$'))) {
                $i += 1
            }
            $word = $Text.Substring($start, $i - $start)
            if ($RegexKeywords -contains $word) { $prevKind = 'other' } else { $prevKind = 'value' }
            continue
        }
        # number
        if ([char]::IsDigit($c)) {
            while (($i -lt $n) -and (([char]::IsLetterOrDigit($Text[$i])) -or ($Text[$i] -eq '.') -or ($Text[$i] -eq '_'))) {
                $i += 1
            }
            $prevKind = 'value'
            continue
        }
        if ($c -eq '{') {
            $top = $frameDepths.Count - 1
            $frameDepths[$top] = $frameDepths[$top] + 1
            $prevKind = 'other'
            $i += 1
            continue
        }
        if ($c -eq '}') {
            $top = $frameDepths.Count - 1
            if ($frameDepths[$top] -gt 0) {
                $frameDepths[$top] = $frameDepths[$top] - 1
                $prevKind = 'value'
            }
            elseif ($frameDepths.Count -gt 1) {
                $frameDepths.RemoveAt($top)
                $state = 'template'
                $prevKind = 'other'
            }
            else {
                $prevKind = 'value'
            }
            $i += 1
            continue
        }
        if (($c -eq ')') -or ($c -eq ']')) {
            $prevKind = 'value'
            $i += 1
            continue
        }
        $prevKind = 'other'
        $i += 1
    }

    $sb = New-Object System.Text.StringBuilder
    for ($k = 0; $k -lt $n; $k++) {
        $ch = $Text[$k]
        if (($ch -ne [char]10) -and $blank.Contains($k)) {
            [void]$sb.Append(' ')
        }
        else {
            [void]$sb.Append($ch)
        }
    }
    return $sb.ToString()
}

# ---------------------------------------------------------------------------
# Matcher - case-sensitive, identifier boundaries
# ---------------------------------------------------------------------------
function Test-TokenMatch {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Token
    )
    $pattern = '(?<![A-Za-z0-9_$])' + [regex]::Escape($Token) + '(?![A-Za-z0-9_$])'
    return [regex]::IsMatch($Text, $pattern)
}

function Get-ClassTokens {
    param([Parameter(Mandatory = $true)][string]$Class)
    switch ($Class) {
        'A' { return $ModulePathTokens }
        'B' { return $SymbolTokens }
        'C' { return $DeletedFileTokens }
        default { return @() }
    }
}

function Get-ClassMode {
    param([Parameter(Mandatory = $true)][string]$Class)
    if ($Class -eq 'B') { return 'code' }
    return 'comments'
}

# Scan one already-sanitized text (line by line) for one class.
function Get-HitsInSanitized {
    param(
        [Parameter(Mandatory = $true)][string]$Sanitized,
        [Parameter(Mandatory = $true)][string]$Class,
        [string]$RelPath = '<memory>'
    )
    $hits = New-Object System.Collections.Generic.List[object]
    $tokens = @(Get-ClassTokens -Class $Class)
    if ($tokens.Count -eq 0) { return $hits }

    $lines = $Sanitized -split "`r?`n"
    for ($ln = 0; $ln -lt $lines.Count; $ln++) {
        foreach ($tok in $tokens) {
            if ($lines[$ln].IndexOf($tok, [System.StringComparison]::Ordinal) -lt 0) { continue }
            if (Test-TokenMatch -Text $lines[$ln] -Token $tok) {
                [void]$hits.Add([pscustomobject]@{
                        HitClass = $Class
                        Path     = $RelPath
                        Line     = ($ln + 1)
                        Token    = $tok
                    })
            }
        }
    }
    return $hits
}

# ---------------------------------------------------------------------------
# Repo scan
# ---------------------------------------------------------------------------
function Invoke-NavAbsenceScan {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $result = [pscustomobject]@{
        Ok       = $false
        Reason   = ''
        Scanned  = 0
        CountA   = 0
        CountB   = 0
        CountC   = 0
        Hits     = (New-Object System.Collections.Generic.List[object])
    }

    $srcRoot = Join-Path $RepoRoot $ScanRelRoot
    if (-not (Test-Path -LiteralPath $srcRoot)) {
        $result.Reason = ('scan root missing: {0}' -f $srcRoot)
        return $result
    }
    $srcRoot = (Resolve-Path -LiteralPath $srcRoot).Path.TrimEnd('\')

    $skipRegex = ''
    foreach ($d in $SkipDirNames) {
        if ($skipRegex -ne '') { $skipRegex += '|' }
        $skipRegex += ('[\\/]' + [regex]::Escape($d) + '[\\/]')
    }
    $skipRegex = '(?i)(' + $skipRegex + ')'

    $repoRootTrim = $RepoRoot.TrimEnd('\')
    $repoLen = $repoRootTrim.Length

    $files = New-Object System.Collections.Generic.List[string]
    foreach ($f in (Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force -ErrorAction SilentlyContinue)) {
        $full = $f.FullName
        $probe = '\' + $full.Substring($srcRoot.Length).TrimStart('\') + '\'
        if ($probe -match $skipRegex) { continue }
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($TextExtensions -notcontains $ext) { continue }
        [void]$files.Add($full)
    }
    $files.Sort()

    foreach ($full in $files) {
        $rel = $full.Substring($repoLen).TrimStart('\', '/').Replace('\', '/')
        $text = $null
        try { $text = [System.IO.File]::ReadAllText($full) } catch { continue }
        $result.Scanned = $result.Scanned + 1

        # Cheap sound pre-filter: a token can only match if the RAW text already
        # contains it as a substring.  Only classes that survive pay for a
        # sanitizer pass.
        $candidate = @()
        foreach ($cls in @('A', 'B', 'C')) {
            foreach ($tok in (Get-ClassTokens -Class $cls)) {
                if ($text.IndexOf($tok, [System.StringComparison]::Ordinal) -ge 0) { $candidate += $cls; break }
            }
        }
        if ($candidate.Count -eq 0) { continue }

        $sanitizedByMode = @{}
        foreach ($cls in $candidate) {
            $mode = Get-ClassMode -Class $cls
            if (-not $sanitizedByMode.ContainsKey($mode)) {
                $sanitizedByMode[$mode] = ConvertTo-ScannedText -Text $text -Mode $mode
            }
            $found = @(Get-HitsInSanitized -Sanitized $sanitizedByMode[$mode] -Class $cls -RelPath $rel)
            foreach ($h in $found) {
                [void]$result.Hits.Add($h)
                if ($cls -eq 'A') { $result.CountA = $result.CountA + 1 }
                elseif ($cls -eq 'B') { $result.CountB = $result.CountB + 1 }
                else { $result.CountC = $result.CountC + 1 }
            }
        }
    }

    if ($result.Scanned -eq 0) {
        $result.Reason = 'zero candidate files scanned'
        return $result
    }
    $result.Ok = $true
    return $result
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
    Write-Host ('ERROR: root not found: {0}' -f $Root)
    exit 2
}
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')

# An allowlist entry may never name product source (the scanned root).
foreach ($entry in $EvidenceAllowlist) {
    $norm = ([string]$entry).Replace('\', '/').TrimStart('/')
    if ($norm.StartsWith($ScanRelRoot + '/') -or ($norm -eq $ScanRelRoot)) {
        Write-Host ('ERROR: evidence allowlist entry names product source: {0}' -f $entry)
        exit 2
    }
}

# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if ($SelfTest) {
    Write-Host '=== check-navigation-retired : SelfTest ==='
    Write-Host ('Repo root: {0}' -f $Root)
    $failures = 0

    # ---- (1) POSITIVE: one leg per token, iterated from the token data ----
    Write-Host 'CONTROL 1 - POSITIVE (one leg per token, driven by the token lists):'
    $legs = @(
        @{ Class = 'A'; Token = $null; Shape = { param($t) "import { probe } from '../$t/thing';" } },
        @{ Class = 'B'; Token = $null; Shape = { param($t) "const probe = $t;" } },
        @{ Class = 'C'; Token = $null; Shape = { param($t) "import { probe } from '../surfaces/$t';" } }
    )
    $legCount = 0
    foreach ($leg in $legs) {
        $cls = $leg.Class
        $mode = Get-ClassMode -Class $cls
        foreach ($tok in (Get-ClassTokens -Class $cls)) {
            $legCount++
            $synthetic = & $leg.Shape $tok
            $sanitized = ConvertTo-ScannedText -Text $synthetic -Mode $mode
            $flagged = Test-TokenMatch -Text $sanitized -Token $tok
            if ($flagged) {
                Write-Host ('  [PASS] class {0}  {1}' -f $cls, $tok)
            }
            else {
                Write-Host ('  [FAIL] class {0}  {1}  (did not flag its own synthetic hit)' -f $cls, $tok)
                $failures++
            }
        }
    }
    $totalTokens = $ModulePathTokens.Count + $SymbolTokens.Count + $DeletedFileTokens.Count
    Write-Host ('  legs executed: {0}; tokens declared: {1}' -f $legCount, $totalTokens)
    if ($legCount -ne $totalTokens) {
        Write-Host '  [FAIL] a declared token has no self-test leg'
        $failures++
    }

    # ---- (1b) IDENTIFIER BOUNDARIES: prefix pairs stay independent ----
    Write-Host 'CONTROL 1b - IDENTIFIER BOUNDARIES (prefix pairs stay independent):'
    $pairChecks = @(
        @{ Shorter = 'JournalEntry'; Longer = 'JournalEntryDraft'; Text = 'const probe = JournalEntryDraft;' },
        @{ Shorter = 'JournalStore'; Longer = 'createJournalStore'; Text = 'const probe = createJournalStore;' }
    )
    foreach ($pc in $pairChecks) {
        $sanitized = ConvertTo-ScannedText -Text $pc.Text -Mode 'code'
        $longerFlags = Test-TokenMatch -Text $sanitized -Token $pc.Longer
        $shorterLeaks = Test-TokenMatch -Text $sanitized -Token $pc.Shorter
        if ($longerFlags -and (-not $shorterLeaks)) {
            Write-Host ('  [PASS] {0} flagged; {1} not satisfied by {0}' -f $pc.Longer, $pc.Shorter)
        }
        else {
            Write-Host ('  [FAIL] boundary: {0} flagged={1}; {2} false-positive={3}' -f $pc.Longer, $longerFlags, $pc.Shorter, $shorterLeaks)
            $failures++
        }
    }

    # ---- (2) NEGATIVE: comments / prose / string literals flag nothing ----
    Write-Host 'CONTROL 2 - NEGATIVE (comment/prose/string-literal mention flags nothing):'
    $negComments = @"
// NavigationEngine and ContextEnvelope and JournalStore are retired prose.
/* The old shared/navigation barrel and NavigationProvider are gone.
   A prose mention of NavigationHost and wireframeSurface must not be a hit. */
"@
    $negCodeOnly = @"
const note = 'NavigationEngine NavigationHost JournalStore NavKeycap ContextEnvelope';
const note2 = "shared/hotkeys was another barrel of the retired engine";
const re = /navigationJournal|getNavigationJournal|createJournalStore/;
"@
    $negAByComments = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text $negComments -Mode 'comments') -Class 'A')
    $negCByComments = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text $negComments -Mode 'comments') -Class 'C')
    $negBByCode = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text ($negComments + "`r`n" + $negCodeOnly) -Mode 'code') -Class 'B')
    Write-Host ('  class A hits on a comment-only mention:      {0} (expect 0)' -f $negAByComments.Count)
    Write-Host ('  class C hits on a comment-only mention:      {0} (expect 0)' -f $negCByComments.Count)
    Write-Host ('  class B hits on comment/string/regex text:   {0} (expect 0)' -f $negBByCode.Count)
    if (($negAByComments.Count -ne 0) -or ($negCByComments.Count -ne 0) -or ($negBByCode.Count -ne 0)) {
        foreach ($h in ($negAByComments + $negCByComments + $negBByCode)) {
            Write-Host ('    unexpected hit: {0}:{1}: {2} [class {3}]' -f $h.Path, $h.Line, $h.Token, $h.HitClass)
        }
        Write-Host '  [FAIL] a comment/prose/string-literal mention was flagged'
        $failures++
    }
    else {
        Write-Host '  [PASS] no class flagged a prose/comment/string-literal mention'
    }

    # ---- (3) SEEDED ROOT: a real banned import inside the root is caught ----
    Write-Host 'CONTROL 3 - SEEDED ROOT (probe written into apps/ui/src, then removed):'
    $srcDir = Join-Path $Root $ScanRelRoot
    $probeFull = Join-Path $srcDir $ProbeFileName
    if (Test-Path -LiteralPath $probeFull) {
        Write-Host ('  [FAIL] probe path already exists before the write: {0}' -f $ProbeRelPath)
        $failures++
    }
    else {
        $seededOk = $false
        try {
            $probeBody = "import { NavigationHost } from '../../../shared/navigation/ui/host';`r`n"
            [System.IO.File]::WriteAllText($probeFull, $probeBody)
            Write-Host ('  wrote probe: {0}' -f $ProbeRelPath)

            $seeded = Invoke-NavAbsenceScan -RepoRoot $Root
            $probeHits = @($seeded.Hits | Where-Object { $_.Path -eq $ProbeRelPath })
            $exact = @($probeHits | Where-Object { $_.Line -eq 1 })
            Write-Host ('  scanned with probe present: {0} file(s), {1} hit(s) total, {2} on the probe' -f $seeded.Scanned, $seeded.Hits.Count, $probeHits.Count)
            foreach ($h in $probeHits) {
                Write-Host ('    seeded hit: {0}:{1}: {2} [class {3}]' -f $h.Path, $h.Line, $h.Token, $h.HitClass)
            }
            if ($exact.Count -ge 1) {
                Write-Host ('  [PASS] seeded hit reported at exactly {0}:1' -f $ProbeRelPath)
                $seededOk = $true
            }
            else {
                Write-Host ('  [FAIL] no hit reported at exactly {0}:1' -f $ProbeRelPath)
            }
        }
        finally {
            if (Test-Path -LiteralPath $probeFull) {
                Remove-Item -LiteralPath $probeFull -Force
            }
        }

        if (Test-Path -LiteralPath $probeFull) {
            Write-Host ('  [FAIL] probe still exists after cleanup: {0}' -f $ProbeRelPath)
            $failures++
        }
        else {
            Write-Host ('  probe removed: {0} (path absent)' -f $ProbeRelPath)
        }

        $post = Invoke-NavAbsenceScan -RepoRoot $Root
        if ($post.Ok -and ($post.Hits.Count -eq 0)) {
            Write-Host ('  [PASS] post-delete rescan clean ({0} files scanned, 0 hits)' -f $post.Scanned)
        }
        else {
            Write-Host ('  [FAIL] post-delete rescan not clean: ok={0}, hits={1}' -f $post.Ok, $post.Hits.Count)
            foreach ($h in $post.Hits) { Write-Host ('    residual hit: {0}:{1}: {2}' -f $h.Path, $h.Line, $h.Token) }
            $failures++
        }

        if (-not $seededOk) { $failures++ }
    }

    # ---- (4) OUT-OF-ROOT NON-SCAN: a synthetic hit OUTSIDE the root is not scanned ----
    Write-Host ('CONTROL 4 - OUT-OF-ROOT NON-SCAN (probe at {0}, outside {1}):' -f $OutOfRootRelPath, $ScanRelRoot)
    $outProbeFull = Join-Path $Root $OutOfRootRelPath
    if (Test-Path -LiteralPath $outProbeFull) {
        Write-Host ('  [FAIL] out-of-root probe path already exists before the write: {0}' -f $OutOfRootRelPath)
        $failures++
    }
    else {
        $outOk = $false
        try {
            [System.IO.File]::WriteAllText($outProbeFull, "import { NavigationHost } from '../shared/navigation/ui/host';`r`n")
            Write-Host ('  wrote out-of-root probe: {0}' -f $OutOfRootRelPath)

            $outside = Invoke-NavAbsenceScan -RepoRoot $Root
            $outHits = @($outside.Hits | Where-Object { $_.Path -eq $OutOfRootRelPath })
            Write-Host ('  scanned with out-of-root probe present: {0} file(s) (unchanged root), {1} hit(s) on the probe' -f $outside.Scanned, $outHits.Count)
            if ($outHits.Count -eq 0) {
                Write-Host ('  [PASS] out-of-root file NOT scanned (root confinement holds)')
                $outOk = $true
            }
            else {
                Write-Host ('  [FAIL] out-of-root file WAS scanned: {0}' -f $OutOfRootRelPath)
                foreach ($h in $outHits) { Write-Host ('    unexpected hit: {0}:{1}: {2}' -f $h.Path, $h.Line, $h.Token) }
            }
        }
        finally {
            if (Test-Path -LiteralPath $outProbeFull) {
                Remove-Item -LiteralPath $outProbeFull -Force
            }
        }
        if (Test-Path -LiteralPath $outProbeFull) {
            Write-Host ('  [FAIL] out-of-root probe still exists after cleanup: {0}' -f $OutOfRootRelPath)
            $failures++
        }
        else {
            Write-Host ('  out-of-root probe removed: {0} (path absent)' -f $OutOfRootRelPath)
        }
        if (-not $outOk) { $failures++ }
    }

    if ($failures -eq 0) {
        Write-Host 'SELFTEST: PASS (all four controls passed)'
        exit 0
    }
    Write-Host ('SELFTEST: FAIL ({0} control failure(s))' -f $failures)
    exit 1
}

# ---------------------------------------------------------------------------
# Plain run
# ---------------------------------------------------------------------------
Write-Host '=== check-navigation-retired ==='
Write-Host ('Repo root: {0}' -f $Root)
Write-Host ('Scan root: {0} (the ONLY scanned root)' -f $ScanRelRoot)
Write-Host ('Text extensions: {0}' -f ($TextExtensions -join ' '))
Write-Host ('Skip dirs: {0}' -f ($SkipDirNames -join ', '))
Write-Host ('Class A - module paths (comment-stripped raw): {0}' -f $ModulePathTokens.Count)
Write-Host ('Class B - symbols (code-only):               {0}' -f $SymbolTokens.Count)
Write-Host ('Class C - deleted files (comment-stripped raw): {0}' -f $DeletedFileTokens.Count)
Write-Host ('Evidence allowlist: {0} entries (EMPTY by construction)' -f $EvidenceAllowlist.Count)

$scan = Invoke-NavAbsenceScan -RepoRoot $Root
if (-not $scan.Ok) {
    Write-Host ('Scanned files: {0}' -f $scan.Scanned)
    Write-Host ('ERROR: cannot run the absence scan: {0}' -f $scan.Reason)
    exit 2
}

Write-Host ('Scanned files: {0}' -f $scan.Scanned)
Write-Host 'Hits by class:'
Write-Host ('  A (module paths):  {0}' -f $scan.CountA)
Write-Host ('  B (symbols):       {0}' -f $scan.CountB)
Write-Host ('  C (deleted files): {0}' -f $scan.CountC)

$allowlisted = 0
foreach ($h in $scan.Hits) {
    if ($EvidenceAllowlist -contains $h.Path) { $allowlisted++ }
}
$failing = $scan.Hits.Count - $allowlisted

if ($failing -eq 0) {
    if ($scan.Hits.Count -eq 0) {
        Write-Host 'RESULT: CLEAN (zero navigation-engine references in apps/ui/src)'
    }
    else {
        Write-Host ('RESULT: CLEAN ({0} hit(s), all covered by the evidence allowlist)' -f $scan.Hits.Count)
    }
    exit 0
}

Write-Host ('HITS: {0} ({1} not covered by the evidence allowlist)' -f $scan.Hits.Count, $failing)
foreach ($h in $scan.Hits) {
    $suffix = ''
    if ($EvidenceAllowlist -contains $h.Path) { $suffix = '  [allowlisted]' }
    Write-Host ('  {0}:{1}: {2}  [class {3}]{4}' -f $h.Path, $h.Line, $h.Token, $h.HitClass, $suffix)
}
Write-Host 'RESULT: FAIL (navigation-engine reference(s) present)'
exit 1
