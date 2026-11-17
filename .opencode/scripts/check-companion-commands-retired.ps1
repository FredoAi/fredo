<#
  check-companion-commands-retired.ps1 - committed absence guard (spec #3152, AC1)

  Proves AC1's scoped absence predicate: the Rust companion command-surface
  path, its two IPC commands and the dead application-command relay are GONE
  from product source, the shipped Rust test targets and the frontend.

  SCANNED ROOTS - exactly TWO, nothing else:

    apps/tauri/src-tauri   (shipped Rust source, integration targets,
                            permissions/, capabilities/, Cargo.toml)
    apps/ui/src            (frontend insurance)

  Skipped dir names: target, gen, node_modules, dist, .git
  Text extensions:   .rs .toml .json .ts .tsx .js .jsx .mjs .cjs .css

  TOKEN CLASSES - the TEXT MODE is binding and differs per class:

    A. MODULE / PATH (5) - COMMENT-STRIPPED RAW substring.  These tokens
       legitimately appear as STRING LITERALS (a `COMMAND_MANIFEST` entry, a
       permission id such as `"allow-app-command-surfaces"`), so the literal
       contents are NOT stripped; only comments are removed from the scan
       window.  A literal-stripping scan would silently pass a stale manifest
       entry or a stale `allow-*` grant.
         surface_registry, register_app_command_surfaces,
         app_command_surfaces, register-app-command-surfaces,
         app-command-surfaces

    B. SYMBOLS (11) - CODE-ONLY, identifier boundaries.  Comments are removed
       AND literal text is removed before the scan, so a symbol named in a doc
       comment or a quoted string is prose, not a use.  Boundaries keep the
       prefix pair independent: CompanionManifest is NOT satisfied by
       CompanionSurfaceManifest and surface_skill is NOT satisfied by a longer
       identifier.
         AppCommandSurfaceRegistry, build_companion_skill_registry,
         surface_skill, CompanionManifest, CompanionSurfaceManifest,
         CompanionCommandManifest, CompanionCommandArgManifest,
         COMPANION_LIST_ACTIONS_ID, RESERVED_SKILL_NAMES,
         APP_COMMAND_SURFACE_MAX_SURFACES, APP_COMMAND_SURFACE_MAX_COMMANDS

    C. RELAY (6) - two text modes:
       * COMMENT-STRIPPED RAW substring (they are event names, i.e. string
         literals): app_command_intent, app-command-intent
         (`app-command-intent` also covers the `-result` suffix)
       * CODE-ONLY with identifier boundaries (wire types):
         AppCommandIntentState, AppCommandIntent, AppCommandIntentResult,
         AppCommandOutcome

  EVIDENCE ALLOWLIST - exactly ONE entry, a FOLDER PREFIX resolving to
  `.opencode/tests/companion-command-removal/`.  It sits OUTSIDE both scanned
  roots (inert today) and is declared because that suite's RETIRED.md must
  spell the banned tokens.  The guard REFUSES to start (exit 2) if any
  allowlist entry resolves under a scanned root - no `apps/**` path may ever
  be allowlisted.

  Exit codes: 0 = clean | 1 = at least one non-allowlisted hit | 2 = cannot
  run (missing root, or zero files scanned).  With -SelfTest: 0 = every
  control passed, 1 = a control failed.

  SELF-TEST CONTROLS (`-SelfTest`):
    (1) POSITIVE        - one control leg per token, ITERATED FROM THE TOKEN
                          DATA ITSELF.  A token with no leg is a FAILURE, not
                          a silent gap; the loop over the token list IS the
                          leg, and the printed leg count must equal the
                          declared token count (22).
    (2) NEGATIVE        - a comment-only mention flags nothing for the
                          comment-stripped classes (A and C-raw); a
                          comment-only AND a string-literal-only mention flags
                          nothing for the code-only classes (B and C-code).
                          Class A's raw mode deliberately still reads string
                          literals, so only its comment leg is asserted.
    (3) SEEDED ROOT     - write a probe inside apps/tauri/src-tauri/src
                          carrying one banned import path + one banned symbol,
                          assert a hit at that EXACT path:line, delete it in a
                          try/finally, and assert the tree scans clean again.
    (4) OUT-OF-ROOT     - write the same probe at
                          apps/tauri/__companion_absence_probe_outside__.ts (a
                          sibling of the scanned root), assert it is NOT
                          scanned, and delete it in a try/finally.
    (5) SELF-REFERENCE  - the plain run must be CLEAN while the guard's own
                          token table spells all 22 tokens.  The script lives
                          in .opencode/scripts (outside both roots), so this
                          control is what makes AC1 non-vacuous.

  The script is ASCII-only on purpose (G-315): PowerShell 5.1 decodes a
  UTF-8-without-BOM source under the local code page, and non-ASCII
  punctuation desyncs its parser.

  Usage:
    powershell -File .opencode/scripts/check-companion-commands-retired.ps1
    powershell -File .opencode/scripts/check-companion-commands-retired.ps1 -SelfTest
    powershell -File .opencode/scripts/check-companion-commands-retired.ps1 -Root C:\Code\fredo
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
    Class  = 'A'
    Label  = 'module/path (comment-stripped raw substring)'
    Mode   = 'raw'
    Tokens = @(
        'surface_registry',
        'register_app_command_surfaces',
        'app_command_surfaces',
        'register-app-command-surfaces',
        'app-command-surfaces'
    )
}

$GroupB = @{
    Class  = 'B'
    Label  = 'symbol (code-only, identifier boundaries)'
    Mode   = 'code'
    Tokens = @(
        'AppCommandSurfaceRegistry',
        'build_companion_skill_registry',
        'surface_skill',
        'CompanionManifest',
        'CompanionSurfaceManifest',
        'CompanionCommandManifest',
        'CompanionCommandArgManifest',
        'COMPANION_LIST_ACTIONS_ID',
        'RESERVED_SKILL_NAMES',
        'APP_COMMAND_SURFACE_MAX_SURFACES',
        'APP_COMMAND_SURFACE_MAX_COMMANDS'
    )
}

$GroupCRaw = @{
    Class  = 'C'
    Label  = 'relay event names (comment-stripped raw substring)'
    Mode   = 'raw'
    Tokens = @(
        'app_command_intent',
        'app-command-intent'
    )
}

$GroupCCode = @{
    Class  = 'C'
    Label  = 'relay wire types (code-only, identifier boundaries)'
    Mode   = 'code'
    Tokens = @(
        'AppCommandIntentState',
        'AppCommandIntent',
        'AppCommandIntentResult',
        'AppCommandOutcome'
    )
}

$Groups = @($GroupA, $GroupB, $GroupCRaw, $GroupCCode)

# Exactly ONE entry, a folder prefix.  It must stay OUTSIDE both scanned roots.
$EvidenceAllowlist = @(
    '.opencode/tests/companion-command-removal/'
)

$ScanRelRoots = @('apps/tauri/src-tauri', 'apps/ui/src')
$TextExtensions = @('.rs', '.toml', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css')
$SkipDirNames = @('target', 'gen', 'node_modules', 'dist', '.git')

$ProbeRelPath = 'apps/tauri/src-tauri/src/__companion_absence_probe__.rs'
$ProbeFileName = '__companion_absence_probe__.rs'
# A synthetic hit OUTSIDE the scanned roots, used to prove root confinement.
$OutOfRootRelPath = 'apps/tauri/__companion_absence_probe_outside__.ts'

# ---------------------------------------------------------------------------
# Language + sanitizer
# ---------------------------------------------------------------------------
function Get-LanguageForPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    switch ($ext) {
        '.rs' { return 'rust' }
        '.toml' { return 'toml' }
        '.json' { return 'json' }
        '.css' { return 'css' }
        default { return 'js' }
    }
}

# Blank comment text (and, when -Mode code, literal text too), preserving every
# character offset so reported line numbers stay real.  Two different text
# modes are the whole point of this guard, so the mode is explicit.
function ConvertTo-ScannedText {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Language,
        [Parameter(Mandatory = $true)][ValidateSet('raw', 'code')][string]$Mode
    )

    $strip = ($Mode -eq 'code')
    $n = $Text.Length
    $blank = New-Object 'System.Collections.Generic.HashSet[int]'
    $hasComments = ($Language -eq 'rust' -or $Language -eq 'js' -or $Language -eq 'css' -or $Language -eq 'toml')
    $multiLineStrings = ($Language -eq 'rust')

    $i = 0
    while ($i -lt $n) {
        $c = $Text[$i]
        $nextc = [char]0
        if (($i + 1) -lt $n) { $nextc = $Text[$i + 1] }

        # ---- toml line comment (#) ----
        if (($Language -eq 'toml') -and ($c -eq '#')) {
            while (($i -lt $n) -and ($Text[$i] -ne [char]10)) {
                [void]$blank.Add($i)
                $i += 1
            }
            continue
        }

        # ---- // line comment ----
        if ($hasComments -and ($Language -ne 'toml') -and ($c -eq '/') -and ($nextc -eq '/')) {
            while (($i -lt $n) -and ($Text[$i] -ne [char]10)) {
                [void]$blank.Add($i)
                $i += 1
            }
            continue
        }

        # ---- /* */ block comment (nested in Rust) ----
        if (($Language -eq 'rust' -or $Language -eq 'js' -or $Language -eq 'css') -and ($c -eq '/') -and ($nextc -eq '*')) {
            $depth = 1
            [void]$blank.Add($i)
            [void]$blank.Add($i + 1)
            $i += 2
            while ($i -lt $n) {
                if (($Language -eq 'rust') -and ($Text[$i] -eq '/') -and (($i + 1) -lt $n) -and ($Text[$i + 1] -eq '*')) {
                    $depth += 1
                    [void]$blank.Add($i)
                    [void]$blank.Add($i + 1)
                    $i += 2
                    continue
                }
                if (($Text[$i] -eq '*') -and (($i + 1) -lt $n) -and ($Text[$i + 1] -eq '/')) {
                    $depth -= 1
                    [void]$blank.Add($i)
                    [void]$blank.Add($i + 1)
                    $i += 2
                    if ($depth -le 0) { break }
                    continue
                }
                if ($Text[$i] -ne [char]10) { [void]$blank.Add($i) }
                $i += 1
            }
            continue
        }

        # ---- Rust raw string: r"..."  r#"..."#  br#"..."# ----
        if (($Language -eq 'rust') -and (($c -eq 'r') -or ($c -eq 'b'))) {
            $j = $i
            if ($Text[$j] -eq 'b') { $j += 1 }
            if (($j -lt $n) -and ($Text[$j] -eq 'r')) {
                $h = $j + 1
                $hashes = 0
                while (($h -lt $n) -and ($Text[$h] -eq '#')) { $hashes += 1; $h += 1 }
                if (($h -lt $n) -and ($Text[$h] -eq '"')) {
                    $prevIsIdent = ($i -gt 0) -and (([char]::IsLetterOrDigit($Text[$i - 1])) -or ($Text[$i - 1] -eq '_'))
                    if (-not $prevIsIdent) {
                        $close = '"' + ('#' * $hashes)
                        $end = $Text.IndexOf($close, $h + 1, [System.StringComparison]::Ordinal)
                        $stop = $n
                        if ($end -ge 0) { $stop = $end + $close.Length }
                        if ($strip) {
                            for ($k = $i; $k -lt $stop; $k++) {
                                if ($Text[$k] -ne [char]10) { [void]$blank.Add($k) }
                            }
                        }
                        $i = $stop
                        continue
                    }
                }
            }
        }

        # ---- double-quoted string ----
        if ($c -eq '"') {
            $start = $i
            if ($strip) { [void]$blank.Add($i) }
            $i += 1
            while ($i -lt $n) {
                if ($Text[$i] -eq '\') {
                    if ($strip) {
                        [void]$blank.Add($i)
                        if ((($i + 1) -lt $n) -and ($Text[$i + 1] -ne [char]10)) { [void]$blank.Add($i + 1) }
                    }
                    $i += 2
                    continue
                }
                if ($Text[$i] -eq '"') {
                    if ($strip) { [void]$blank.Add($i) }
                    $i += 1
                    break
                }
                if ((-not $multiLineStrings) -and ($Text[$i] -eq [char]10)) { break }
                if ($strip -and ($Text[$i] -ne [char]10)) { [void]$blank.Add($i) }
                $i += 1
            }
            continue
        }

        # ---- single quote: Rust char literal / lifetime, TOML-js string ----
        if ($c -eq [char]39) {
            if ($Language -eq 'rust') {
                $len = 0
                if (($i + 1) -lt $n) {
                    if ($Text[$i + 1] -eq '\') {
                        if ((($i + 3) -lt $n) -and ($Text[$i + 2] -eq 'u') -and ($Text[$i + 3] -eq '{')) {
                            $j = $i + 4
                            while (($j -lt $n) -and ($Text[$j] -ne '}')) { $j += 1 }
                            if (((($j + 1) -lt $n)) -and ($Text[$j + 1] -eq [char]39)) { $len = ($j + 1) - $i + 1 }
                        }
                        elseif ((($i + 3) -lt $n) -and ($Text[$i + 3] -eq [char]39)) {
                            $len = 4
                        }
                    }
                    elseif ((($i + 2) -lt $n) -and ($Text[$i + 2] -eq [char]39)) {
                        $len = 3
                    }
                }
                if ($len -gt 0) {
                    if ($strip) {
                        for ($k = $i; $k -lt ($i + $len); $k++) { [void]$blank.Add($k) }
                    }
                    $i += $len
                }
                else {
                    # A lifetime such as 'a - never a literal opener.
                    $i += 1
                }
                continue
            }

            # js / toml single-quoted string.  A quote inside a word (Don't,
            # users') is JSX/prose apostrophe, not a string opener.
            $isProse = ($Language -eq 'js') -and ($i -gt 0) -and [char]::IsLetter($Text[$i - 1])
            if ($isProse) {
                $i += 1
                continue
            }
            if ($strip) { [void]$blank.Add($i) }
            $i += 1
            while ($i -lt $n) {
                if ($Text[$i] -eq '\') {
                    if ($strip) {
                        [void]$blank.Add($i)
                        if ((($i + 1) -lt $n) -and ($Text[$i + 1] -ne [char]10)) { [void]$blank.Add($i + 1) }
                    }
                    $i += 2
                    continue
                }
                if ($Text[$i] -eq [char]39) {
                    if ($strip) { [void]$blank.Add($i) }
                    $i += 1
                    break
                }
                if ($Text[$i] -eq [char]10) { break }
                if ($strip) { [void]$blank.Add($i) }
                $i += 1
            }
            continue
        }

        # ---- js template literal (body text blanked in code mode only) ----
        if (($Language -eq 'js') -and ($c -eq '`')) {
            if ($strip) { [void]$blank.Add($i) }
            $i += 1
            while ($i -lt $n) {
                if ($Text[$i] -eq '\') {
                    if ($strip) {
                        [void]$blank.Add($i)
                        if ((($i + 1) -lt $n) -and ($Text[$i + 1] -ne [char]10)) { [void]$blank.Add($i + 1) }
                    }
                    $i += 2
                    continue
                }
                if ($Text[$i] -eq '`') {
                    if ($strip) { [void]$blank.Add($i) }
                    $i += 1
                    break
                }
                if (($Text[$i] -eq '$') -and (($i + 1) -lt $n) -and ($Text[$i + 1] -eq '{')) {
                    # An interpolation expression is CODE: scan it (do not blank
                    # its contents), and blank only the delimiters (G-419).
                    if ($strip) { [void]$blank.Add($i); [void]$blank.Add($i + 1) }
                    $i += 2
                    $depth = 1
                    while (($i -lt $n) -and ($depth -gt 0)) {
                        $cc = $Text[$i]
                        if ($cc -eq '{') { $depth += 1; $i += 1; continue }
                        if ($cc -eq '}') {
                            $depth -= 1
                            if ($strip) { [void]$blank.Add($i) }
                            $i += 1
                            continue
                        }
                        $i += 1
                    }
                    continue
                }
                if ($strip -and ($Text[$i] -ne [char]10)) { [void]$blank.Add($i) }
                $i += 1
            }
            continue
        }

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
# Matcher - case-sensitive; identifier boundaries for the code-only classes
# ---------------------------------------------------------------------------
function Test-TokenMatch {
    param(
        # An empty line or an empty file is legitimate input, never a bind error.
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][ValidateSet('raw', 'code')][string]$Mode
    )
    if ($Mode -eq 'raw') {
        # Comment-stripped RAW substring: literals are read on purpose.
        return ($Text.IndexOf($Token, [System.StringComparison]::Ordinal) -ge 0)
    }
    $pattern = '(?<![A-Za-z0-9_$])' + [regex]::Escape($Token) + '(?![A-Za-z0-9_$])'
    return [regex]::IsMatch($Text, $pattern)
}

# Scan one already-sanitized text line by line for one token group.
function Get-HitsInSanitized {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Sanitized,
        [Parameter(Mandatory = $true)][hashtable]$Group,
        [string]$RelPath = '<memory>'
    )
    $hits = New-Object System.Collections.Generic.List[object]
    $mode = $Group.Mode
    $lines = $Sanitized -split "`r?`n"
    for ($ln = 0; $ln -lt $lines.Count; $ln++) {
        foreach ($tok in $Group.Tokens) {
            if (-not (Test-TokenMatch -Text $lines[$ln] -Token $tok -Mode $mode)) { continue }
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

# True when a repo-relative path falls inside the named evidence allowlist.
function Test-Allowlisted {
    param([Parameter(Mandatory = $true)][string]$RelPath)
    $norm = $RelPath.Replace('\', '/')
    foreach ($entry in $EvidenceAllowlist) {
        $prefix = ([string]$entry).Replace('\', '/').TrimStart('/')
        if ($norm.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Repo scan (both roots)
# ---------------------------------------------------------------------------
function Invoke-CompanionAbsenceScan {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $result = [pscustomobject]@{
        Ok      = $false
        Reason  = ''
        Scanned = 0
        CountA  = 0
        CountB  = 0
        CountC  = 0
        Hits    = (New-Object System.Collections.Generic.List[object])
    }

    $skipRegex = ''
    foreach ($d in $SkipDirNames) {
        if ($skipRegex -ne '') { $skipRegex += '|' }
        $skipRegex += ('[\\/]' + [regex]::Escape($d) + '[\\/]')
    }
    $skipRegex = '(?i)(' + $skipRegex + ')'

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
        foreach ($f in (Get-ChildItem -LiteralPath $scanRoot -Recurse -File -Force -ErrorAction SilentlyContinue)) {
            $full = $f.FullName
            $probe = '\' + $full.Substring($scanRoot.Length).TrimStart('\') + '\'
            if ($probe -match $skipRegex) { continue }
            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            if ($TextExtensions -notcontains $ext) { continue }
            [void]$files.Add($full)
        }
    }
    $files.Sort()

    $sanitizedCache = @{}
    foreach ($full in $files) {
        $rel = $full.Substring($repoLen).TrimStart('\', '/').Replace('\', '/')
        $text = $null
        try { $text = [System.IO.File]::ReadAllText($full) } catch { continue }
        $result.Scanned = $result.Scanned + 1

        $language = Get-LanguageForPath -Path $full

        # Cheap sound pre-filter: a token can only match if the RAW text already
        # contains it as a substring.  Only groups that survive pay for a pass.
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
            $cacheKey = ($language + '|' + $group.Mode)
            if (-not $sanitizedCache.ContainsKey($cacheKey)) {
                $sanitizedCache[$cacheKey] = ConvertTo-ScannedText -Text $text -Language $language -Mode $group.Mode
            }
            $found = @(Get-HitsInSanitized -Sanitized $sanitizedCache[$cacheKey] -Group $group -RelPath $rel)
            foreach ($h in $found) {
                [void]$result.Hits.Add($h)
                if ($h.HitClass -eq 'A') { $result.CountA = $result.CountA + 1 }
                elseif ($h.HitClass -eq 'B') { $result.CountB = $result.CountB + 1 }
                else { $result.CountC = $result.CountC + 1 }
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

$TotalTokens = 0
foreach ($group in $Groups) { $TotalTokens = $TotalTokens + $group.Tokens.Count }
$AllowlistIsFolderPrefix = $true

# ---------------------------------------------------------------------------
# Guard: no allowlist entry may resolve under a scanned root
# ---------------------------------------------------------------------------
foreach ($entry in $EvidenceAllowlist) {
    $norm = ([string]$entry).Replace('\', '/').TrimStart('/')
    $resolved = (Join-Path $Root $norm).Replace('\', '/')
    foreach ($scanRel in $ScanRelRoots) {
        $rootAbs = (Join-Path $Root $scanRel).Replace('\', '/').TrimEnd('/')
        if (($resolved -eq $rootAbs) -or $resolved.StartsWith($rootAbs + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Host ('ERROR: evidence allowlist entry resolves under a scanned root: {0} -> {1}' -f $entry, $resolved)
            exit 2
        }
    }
    # Belt and braces: also refuse the plain prefix form.
    foreach ($scanRel in $ScanRelRoots) {
        if (($norm -eq $scanRel) -or $norm.StartsWith($scanRel + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Host ('ERROR: evidence allowlist entry names scanned product source: {0}' -f $entry)
            exit 2
        }
    }
}

# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if ($SelfTest) {
    Write-Host '=== check-companion-commands-retired : SelfTest ==='
    Write-Host ('Repo root: {0}' -f $Root)
    $failures = 0

    # ---- (1) POSITIVE: one leg per token, iterated from the token data ----
    Write-Host 'CONTROL 1 - POSITIVE (one leg per token, driven by the token lists):'
    $legCount = 0
    foreach ($group in $Groups) {
        $mode = $group.Mode
        $language = 'rust'
        foreach ($tok in $group.Tokens) {
            $legCount++
            $synthetic = ''
            if ($tok -like '*-*') {
                # A hyphenated token is a permission id / event name: it appears
                # as a quoted literal in product source.
                $synthetic = ('let probe = "allow-{0}";' -f $tok)
            }
            else {
                $synthetic = ('let probe = {0};' -f $tok)
            }
            $sanitized = ConvertTo-ScannedText -Text $synthetic -Language $language -Mode $mode
            $flagged = Test-TokenMatch -Text $sanitized -Token $tok -Mode $mode
            if ($flagged) {
                Write-Host ('  [PASS] class {0}  {1}' -f $group.Class, $tok)
            }
            else {
                Write-Host ('  [FAIL] class {0}  {1}  (did not flag its own synthetic hit)' -f $group.Class, $tok)
                $failures++
            }
        }
    }
    Write-Host ('  legs executed: {0}; tokens declared: {1}' -f $legCount, $TotalTokens)
    if ($legCount -ne $TotalTokens) {
        Write-Host '  [FAIL] a declared token has no self-test leg'
        $failures++
    }

    # ---- (2) NEGATIVE: comments / string literals flag nothing where stripped ----
    Write-Host 'CONTROL 2 - NEGATIVE (comment/string-literal mention flags nothing for its class):'
    $commentText = @'
// surface_registry, register_app_command_surfaces, app_command_intent
// AppCommandSurfaceRegistry, build_companion_skill_registry, surface_skill
// CompanionManifest, CompanionSurfaceManifest, AppCommandIntent, AppCommandOutcome
'@
    $stringText = @'
const note = "AppCommandSurfaceRegistry surface_skill CompanionManifest";
const note2 = 'AppCommandIntentResult AppCommandOutcome AppCommandIntentState';
'@
    $negA = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text $commentText -Language 'rust' -Mode 'raw') -Group $GroupA)
    $negCraw = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text $commentText -Language 'rust' -Mode 'raw') -Group $GroupCRaw)
    $negBComment = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text $commentText -Language 'rust' -Mode 'code') -Group $GroupB)
    $negBString = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text ($commentText + "`r`n" + $stringText) -Language 'js' -Mode 'code') -Group $GroupB)
    $negCCodeComment = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text $commentText -Language 'rust' -Mode 'code') -Group $GroupCCode)
    $negCCodeString = @(Get-HitsInSanitized -Sanitized (ConvertTo-ScannedText -Text ($commentText + "`r`n" + $stringText) -Language 'js' -Mode 'code') -Group $GroupCCode)

    Write-Host ('  class A hits on a comment-only mention:       {0} (expect 0)' -f $negA.Count)
    Write-Host ('  class C-raw hits on a comment-only mention:   {0} (expect 0)' -f $negCraw.Count)
    Write-Host ('  class B hits on a comment-only mention:       {0} (expect 0)' -f $negBComment.Count)
    Write-Host ('  class B hits on comment+string-literal text:  {0} (expect 0)' -f $negBString.Count)
    Write-Host ('  class C-code hits on a comment-only mention:  {0} (expect 0)' -f $negCCodeComment.Count)
    Write-Host ('  class C-code hits on comment+string text:     {0} (expect 0)' -f $negCCodeString.Count)

    $negTotal = $negA.Count + $negCraw.Count + $negBComment.Count + $negBString.Count + $negCCodeComment.Count + $negCCodeString.Count
    if ($negTotal -ne 0) {
        foreach ($h in ($negA + $negCraw + $negBComment + $negBString + $negCCodeComment + $negCCodeString)) {
            Write-Host ('    unexpected hit: {0}:{1}: {2} [class {3}]' -f $h.Path, $h.Line, $h.Token, $h.HitClass)
        }
        Write-Host '  [FAIL] a comment/prose/string-literal mention was flagged'
        $failures++
    }
    else {
        Write-Host '  [PASS] no stripped class flagged a template/prose/string-literal mention'
    }

    # ---- (3) SEEDED ROOT: a real banned reference inside the root is caught ----
    Write-Host 'CONTROL 3 - SEEDED ROOT (probe written into apps/tauri/src-tauri/src, then removed):'
    $probeFull = Join-Path $Root $ProbeRelPath
    if (Test-Path -LiteralPath $probeFull) {
        Write-Host ('  [FAIL] probe path already exists before the write: {0}' -f $ProbeRelPath)
        $failures++
    }
    else {
        $seededOk = $false
        try {
            $probeBody = "use crate::infrastructure::companion::surface_registry::AppCommandSurfaceRegistry;`r`n"
            [System.IO.File]::WriteAllText($probeFull, $probeBody)
            Write-Host ('  wrote probe: {0}' -f $ProbeRelPath)

            $seeded = Invoke-CompanionAbsenceScan -RepoRoot $Root
            $probeHits = @($seeded.Hits | Where-Object { $_.Path -eq $ProbeRelPath })
            $exactA = @($probeHits | Where-Object { ($_.Line -eq 1) -and ($_.HitClass -eq 'A') })
            $exactB = @($probeHits | Where-Object { ($_.Line -eq 1) -and ($_.HitClass -eq 'B') })
            Write-Host ('  scanned with probe present: {0} file(s), {1} hit(s) total, {2} on the probe' -f $seeded.Scanned, $seeded.Hits.Count, $probeHits.Count)
            foreach ($h in $probeHits) {
                Write-Host ('    seeded hit: {0}:{1}: {2} [class {3}]' -f $h.Path, $h.Line, $h.Token, $h.HitClass)
            }
            if (($exactA.Count -ge 1) -and ($exactB.Count -ge 1)) {
                Write-Host ('  [PASS] seeded hits reported at exactly {0}:1 (class A and class B)' -f $ProbeRelPath)
                $seededOk = $true
            }
            else {
                Write-Host ('  [FAIL] expected a class-A and a class-B hit at {0}:1 (got A={1}, B={2})' -f $ProbeRelPath, $exactA.Count, $exactB.Count)
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

        $post = Invoke-CompanionAbsenceScan -RepoRoot $Root
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

    # ---- (4) OUT-OF-ROOT NON-SCAN ----
    Write-Host ('CONTROL 4 - OUT-OF-ROOT NON-SCAN (probe at {0}, outside both roots):' -f $OutOfRootRelPath)
    $outProbeFull = Join-Path $Root $OutOfRootRelPath
    if (Test-Path -LiteralPath $outProbeFull) {
        Write-Host ('  [FAIL] out-of-root probe path already exists before the write: {0}' -f $OutOfRootRelPath)
        $failures++
    }
    else {
        $outOk = $false
        try {
            [System.IO.File]::WriteAllText($outProbeFull, "import { probe } from '../surface_registry/AppCommandSurfaceRegistry';`r`n")
            Write-Host ('  wrote out-of-root probe: {0}' -f $OutOfRootRelPath)

            $outside = Invoke-CompanionAbsenceScan -RepoRoot $Root
            $outHits = @($outside.Hits | Where-Object { $_.Path -eq $OutOfRootRelPath })
            $baseline = Invoke-CompanionAbsenceScan -RepoRoot $Root
            Write-Host ('  scanned with out-of-root probe present: {0} file(s) (unchanged roots), {1} hit(s) on the probe' -f $outside.Scanned, $outHits.Count)
            if ($outHits.Count -eq 0) {
                Write-Host '  [PASS] out-of-root file NOT scanned (root confinement holds)'
                $outOk = $true
            }
            else {
                Write-Host ('  [FAIL] out-of-root file WAS scanned: {0}' -f $OutOfRootRelPath)
                foreach ($h in $outHits) { Write-Host ('    unexpected hit: {0}:{1}: {2}' -f $h.Path, $h.Line, $h.Token) }
            }
            if ($null -eq $baseline) { $outOk = $false }
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

    # ---- (5) SELF-REFERENCE: the plain run is clean while the table spells all tokens ----
    Write-Host ('CONTROL 5 - SELF-REFERENCE (plain run clean while this script spells all {0} tokens):' -f $TotalTokens)
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
                if ($scriptText.IndexOf($tok, [System.StringComparison]::Ordinal) -ge 0) { $selfTokens++ }
            }
        }
    }
    if ($scriptUnderRoot) {
        Write-Host '  [FAIL] the guard lives inside a scanned root'
        $failures++
    }
    elseif ($selfTokens -ne $TotalTokens) {
        Write-Host ('  [FAIL] the guard''s own source spells {0} of {1} tokens' -f $selfTokens, $TotalTokens)
        $failures++
    }
    else {
        $plain = Invoke-CompanionAbsenceScan -RepoRoot $Root
        $failing = @($plain.Hits | Where-Object { -not (Test-Allowlisted -RelPath $_.Path) })
        Write-Host ('  guard source spells {0}/{1} tokens and lives outside both roots' -f $selfTokens, $TotalTokens)
        Write-Host ('  plain run: {0} file(s) scanned, {1} hit(s), {2} non-allowlisted' -f $plain.Scanned, $plain.Hits.Count, $failing.Count)
        if ((-not $plain.Ok) -or ($failing.Count -ne 0)) {
            Write-Host '  [FAIL] the plain run is not clean while the token table is fully spelled'
            foreach ($h in $failing) { Write-Host ('    hit: {0}:{1}: {2}' -f $h.Path, $h.Line, $h.Token) }
            $failures++
        }
        else {
            Write-Host '  [PASS] plain run CLEAN with all tokens spelled in the guard (AC1 is non-vacuous)'
        }
    }

    if ($failures -eq 0) {
        Write-Host 'SELFTEST: PASS (all five controls passed)'
        exit 0
    }
    Write-Host ('SELFTEST: FAIL ({0} control failure(s))' -f $failures)
    exit 1
}

# ---------------------------------------------------------------------------
# Plain run
# ---------------------------------------------------------------------------
Write-Host '=== check-companion-commands-retired ==='
Write-Host ('Repo root: {0}' -f $Root)
Write-Host ('Scanned roots: {0}' -f ($ScanRelRoots -join ', '))
Write-Host ('Text extensions: {0}' -f ($TextExtensions -join ' '))
Write-Host ('Skip dirs: {0}' -f ($SkipDirNames -join ', '))
Write-Host ('Class A - module/path tokens (comment-stripped raw substring): {0}' -f $GroupA.Tokens.Count)
Write-Host ('Class B - symbols (code-only, identifier boundaries):          {0}' -f $GroupB.Tokens.Count)
Write-Host ('Class C - relay tokens ({0} comment-stripped raw + {1} code-only):  {2}' -f $GroupCRaw.Tokens.Count, $GroupCCode.Tokens.Count, ($GroupCRaw.Tokens.Count + $GroupCCode.Tokens.Count))
Write-Host ('Tokens declared: {0}' -f $TotalTokens)
Write-Host ('Evidence allowlist: {0} entries (folder prefixes): {1}' -f $EvidenceAllowlist.Count, ($EvidenceAllowlist -join ', '))

$scan = Invoke-CompanionAbsenceScan -RepoRoot $Root
if (-not $scan.Ok) {
    Write-Host ('Scanned files: {0}' -f $scan.Scanned)
    Write-Host ('Hits by class: A={0} B={1} C={2}' -f $scan.CountA, $scan.CountB, $scan.CountC)
    Write-Host ('ERROR: cannot run the absence scan: {0}' -f $scan.Reason)
    exit 2
}

Write-Host ('Scanned files: {0}' -f $scan.Scanned)
Write-Host ('Hits by class: A={0} B={1} C={2}' -f $scan.CountA, $scan.CountB, $scan.CountC)

$failing = @($scan.Hits | Where-Object { -not (Test-Allowlisted -RelPath $_.Path) })
if ($failing.Count -eq 0) {
    if ($scan.Hits.Count -eq 0) {
        Write-Host 'RESULT: CLEAN (zero companion command-surface / relay references in the scanned roots)'
    }
    else {
        Write-Host ('RESULT: CLEAN ({0} hit(s), all covered by the evidence allowlist)' -f $scan.Hits.Count)
    }
    exit 0
}

Write-Host ('HITS: {0} ({1} not covered by the evidence allowlist)' -f $scan.Hits.Count, $failing.Count)
foreach ($h in $scan.Hits) {
    $suffix = ''
    if (Test-Allowlisted -RelPath $h.Path) { $suffix = '  [allowlisted]' }
    Write-Host ('  {0}:{1}: {2}  [class {3}]{4}' -f $h.Path, $h.Line, $h.Token, $h.HitClass, $suffix)
}
Write-Host 'RESULT: FAIL (companion command-surface / relay reference(s) present)'
exit 1
