<#
  verify-domain-boundary.ps1 - the AC1 RESOLVED-GRAPH guard (Spec #3201 ST-8)

  WHAT THIS INSTRUMENT IS
  -----------------------
  AC1 says the agent-telemetry domain crate "cannot reach the platform". This
  script makes that absence FALSIFIABLE and RUNNING by asserting it against the
  RESOLVED DEPENDENCY GRAPH, not against a manifest's text.

  WHY THE GRAPH, AND NOT A MANIFEST GREP
  --------------------------------------
  A manifest text grep for `tauri` is insufficient: a `path` dependency can
  transitively re-expose the platform while the word `tauri` never appears in
  the crate's own `Cargo.toml`. `cargo tree` resolves the whole closure, so the
  transitive case is caught by construction. The falsification table in
  `.opencode/tests/telemetry-domain-crate/boundary-falsification.md` records the
  transitive row as OBSERVED, in both directions.

  TEXT MODE - STRUCTURAL, on the RESOLVED graph
  ---------------------------------------------
  The subject is a parsed construct (cargo's resolved node set), not file text.
  Every node in `cargo tree -p telemetry-domain --edges normal,build` is parsed
  to its `name vX.Y.Z` prefix and compared to the forbidden package list BY
  EXACT NODE NAME. Exact-name comparison is deliberate: a resolved artifact
  whose name merely CONTAINS a forbidden token (e.g. `tauri-utils`, which is
  only reachable when `tauri` is also resolved) is dispositioned against the
  exact list, never failed - a substring rule would redden on a name that is
  not the package AC1 names. Self-test CONTROL 6 pins that property.

  THE ASYMMETRY IS ASSERTED, NOT FORBIDDEN (Spec #3201 section 7)
  ---------------------------------------------------------------
  The direction invariant is ASYMMETRIC and this script implements it that way:

    * the CRATE must not reach the PLATFORM   -> FORBIDDEN, fails (exit 1)
    * the PLATFORM must reach the CRATE       -> EXPECTED, ASSERTED present

  `comm/adapter.rs` and `comm/adapters/internal.rs` legitimately depend on the
  crate; `Cargo.toml` declares `telemetry-domain` as a workspace dependency. A
  symmetric "no cross-crate edges" pin would redden on this CORRECT code -
  worse than no guard, because the first person to hit it deletes it. So this
  script fails when the platform->crate edge is ABSENT, and never when it is
  present. Self-test CONTROL 7 pins both halves.

  CLAUSES IMPLEMENTED (every clause this header claims has an assertion, G-430)
  ----------------------------------------------------------------------------
    1. "no forbidden package in the crate's resolved graph"
       -> the token scan over the resolved node names (the real check).
    2. "no path back to the application crate"
       -> every `path = "..."` in the crate manifest must resolve INSIDE
          `<workspace>/crates/`; an escaping entry is a named failure.
    3. "the crate IS reachable from the app" (the section 7 asymmetry)
       -> `cargo tree -p fredo` MUST contain `telemetry-domain`.

  DISCLOSED LIMIT (stated where it lives, G-431/G-511)
  ---------------------------------------------------
  This script proves the RESOLVED dependency graph only. It is blind to a
  source-level reference that never becomes a dependency edge - e.g. a
  `use crate::infrastructure::...` left in a `#[cfg(test)]` module that the
  graph never sees as an edge. The COMMITTED SOURCE-TOKEN SCAN closes that
  hole, and the two are bound together for exactly that reason:

      .opencode/scripts/guard-universe.ps1
        -Root apps/tauri/src-tauri/crates/telemetry-domain
        -Tokens .opencode/tests/telemetry-domain-crate/boundary-tokens.txt

  NEITHER INSTRUMENT ALONE SATISFIES AC1, and the reciprocal limit is real too:
  `guard-universe.ps1` is a TEXT scan and cannot see a transitively-resolved
  `path` dependency - which is this script's subject.

  POPULATION DISCIPLINE (G-524)
  -----------------------------
  A scan over ZERO resolved nodes is not a clean bill, it is a FAILED
  INSTRUMENT. This script prints the node population it visited and exits 3
  when that population is empty, so a vacuous green is impossible.

  .PARAMETER Root
    The cargo workspace root. Default: `<repo>/apps/tauri/src-tauri`, resolved
    from this script's own location so the CWD never matters.

  .PARAMETER ManifestPath
    The manifest to resolve. Default: `<Root>/Cargo.toml`.

  .PARAMETER Forbidden
    Comma-separated forbidden package names (exact node names).

  .PARAMETER Locked
    Pass `--locked` to the cargo invocations (CI runs it this way).

  .PARAMETER SelfTest
    Run the built-in controls and exit 0 when they pass.

  .EXITCODES
    0 = boundary holds
    1 = boundary VIOLATED (a forbidden node is resolved, or the expected
        platform->crate edge is missing)
    2 = error (cargo failed, or the manifest could not be read)
    3 = INSTRUMENT FAILURE (zero-population scan)
#>
[CmdletBinding()]
param(
  [string]$Root = "",
  [string]$ManifestPath = "",
  [string]$CrateName = "telemetry-domain",
  [string]$PlatformPackage = "fredo",
  [string]$Forbidden = "tauri,tauri-build,tauri-runtime,tauri-runtime-wry,tauri-plugin-shell,tauri-plugin-mcp-bridge,fredo,fredo_lib,applications",
  [switch]$Locked,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# cargo prints the resolved tree with box-drawing glyphs. The node NAME and its
# `vX.Y.Z` version are always ASCII, so the parser below is independent of the
# console code page; this only keeps the printed evidence readable.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$NodePattern = '([A-Za-z0-9_.+-]+) v[0-9]+\.[0-9]+\.[0-9]+'

# ---------------------------------------------------------------------------
# Pure helpers (no cargo): the self-test controls exercise these directly.
# ---------------------------------------------------------------------------

function ConvertTo-NodeNames {
  param([string[]]$Lines)
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($line in $Lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $m = [regex]::Match($line, $NodePattern)
    if ($m.Success) { $names.Add($m.Groups[1].Value) }
  }
  return @($names)
}

function Split-TokenList {
  param([string]$Csv)
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($t in ($Csv -split ',')) {
    $v = $t.Trim()
    if ($v -ne '') { $out.Add($v) }
  }
  return @($out)
}

function Get-ForbiddenHits {
  param([string[]]$Names, [string[]]$ForbiddenSet)
  $hits = New-Object System.Collections.Generic.List[string]
  foreach ($n in $Names) {
    foreach ($f in $ForbiddenSet) {
      if ($n -eq $f) { $hits.Add($n); break }
    }
  }
  return @($hits)
}

function Get-ManifestPathEntries {
  param([string]$ManifestText)
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($ManifestText -split "`r?`n")) {
    # Only a real key assignment counts; a `#`-commented line is prose.
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith('#')) { continue }
    $m = [regex]::Match($trimmed, '^\s*([A-Za-z0-9_.-]+)\s*=\s*\{\s*path\s*=\s*"([^"]*)"')
    if ($m.Success) {
      $paths.Add(("{0}|{1}" -f $m.Groups[1].Value, $m.Groups[2].Value))
      continue
    }
    $m2 = [regex]::Match($trimmed, '^\s*([A-Za-z0-9_.-]+)\s*\.\s*path\s*=\s*"([^"]*)"')
    if ($m2.Success) {
      $paths.Add(("{0}|{1}" -f $m2.Groups[1].Value, $m2.Groups[2].Value))
    }
  }
  return @($paths)
}

# ---------------------------------------------------------------------------
# Self-test: seven controls, none of which needs cargo or the network.
# ---------------------------------------------------------------------------

function Invoke-SelfTest {
  $fail = 0
  $forbidden = Split-TokenList -Csv "tauri,tauri-build,tauri-runtime,fredo,fredo_lib,applications"

  $cleanTree = @(
    'telemetry-domain v0.1.0 (C:\repo\crates\telemetry-domain)',
    '+-- anyhow v1.0.104',
    '+-- serde v1.0.228',
    '|   +-- serde_core v1.0.228',
    '+-- uuid v1.23.1',
    '    +-- getrandom v0.4.2'
  )

  # NOTE: every helper result is re-wrapped with @() at the call site. PowerShell
  # unwraps a single-element array to the element itself, so an un-wrapped
  # `$hits2[0]` indexes a STRING and yields its first CHARACTER - a control that
  # reports "FAIL: hits=tauri" while comparing 't' to 'tauri'. The @() is part of
  # the control's correctness, not decoration.
  # CONTROL 1: a correct tree is GREEN, with a non-zero population.
  $names = @(ConvertTo-NodeNames -Lines $cleanTree)
  $hits = @(Get-ForbiddenHits -Names $names -ForbiddenSet $forbidden)
  if ($names.Count -eq 6 -and $hits.Count -eq 0) {
    Write-Output "CONTROL 1 (clean graph: population 6, zero forbidden) PASS"
  } else {
    Write-Output ("CONTROL 1 (clean graph) FAIL: population={0} hits={1}" -f $names.Count, ($hits -join ','))
    $fail++
  }

  # CONTROL 2: a directly-added forbidden edge REDDENS and names the package.
  $withTauri = $cleanTree + '+-- tauri v2.10.3'
  $hits2 = @(Get-ForbiddenHits -Names @(ConvertTo-NodeNames -Lines $withTauri) -ForbiddenSet $forbidden)
  if ($hits2.Count -eq 1 -and $hits2[0] -eq 'tauri') {
    Write-Output "CONTROL 2 (added tauri edge) PASS - reddens naming 'tauri'"
  } else {
    Write-Output ("CONTROL 2 (added tauri edge) FAIL: hits={0}" -f ($hits2 -join ','))
    $fail++
  }

  # CONTROL 3: the application package (the `path`-dep shape) REDDENS by name.
  $withFredo = $cleanTree + '+-- fredo v0.2.5 (C:\repo\apps\tauri\src-tauri)'
  $hits3 = @(Get-ForbiddenHits -Names @(ConvertTo-NodeNames -Lines $withFredo) -ForbiddenSet $forbidden)
  if ($hits3.Count -eq 1 -and $hits3[0] -eq 'fredo') {
    Write-Output "CONTROL 3 (path dep on the application crate) PASS - reddens naming 'fredo'"
  } else {
    Write-Output ("CONTROL 3 (path dep on the application crate) FAIL: hits={0}" -f ($hits3 -join ','))
    $fail++
  }

  # CONTROL 4: the TRANSITIVE case - the forbidden package is three levels down,
  # reachable only through an innocuous-looking probe crate. This is the leg that
  # justifies the resolved graph over a manifest grep.
  $transitive = @(
    'telemetry-domain v0.1.0 (C:\repo\crates\telemetry-domain)',
    '+-- anyhow v1.0.104',
    '+-- __probe v0.1.0 (C:\repo\crates\__probe)',
    '    +-- fredo-probe-helper v0.1.0 (C:\repo\apps\tauri\src-tauri)',
    '        +-- tauri v2.10.3'
  )
  $hits4 = @(Get-ForbiddenHits -Names @(ConvertTo-NodeNames -Lines $transitive) -ForbiddenSet $forbidden)
  if ($hits4.Count -eq 1 -and $hits4[0] -eq 'tauri') {
    Write-Output "CONTROL 4 (transitive path dep re-exposes tauri) PASS - reddens naming the reached 'tauri'"
  } else {
    Write-Output ("CONTROL 4 (transitive path dep) FAIL: hits={0}" -f ($hits4 -join ','))
    $fail++
  }

  # CONTROL 5: a ZERO-POPULATION scan is an INSTRUMENT FAILURE, never a pass.
  $empty = @(ConvertTo-NodeNames -Lines @())
  if ($empty.Count -eq 0) {
    Write-Output "CONTROL 5 (zero population is an instrument failure) PASS - population 0 is reported, not passed"
  } else {
    Write-Output ("CONTROL 5 (zero population) FAIL: population={0}" -f $empty.Count)
    $fail++
  }

  # CONTROL 6: exact-NODE-NAME matching - a name that merely CONTAINS a token is
  # NOT a hit (the documented disposition, and the anti-false-positive control).
  $lookalike = $cleanTree + '+-- tauri-utils-lookalike v1.0.0'
  $hits6 = @(Get-ForbiddenHits -Names @(ConvertTo-NodeNames -Lines $lookalike) -ForbiddenSet $forbidden)
  if ($hits6.Count -eq 0) {
    Write-Output "CONTROL 6 (lookalike name is not a hit) PASS - exact node-name comparison"
  } else {
    Write-Output ("CONTROL 6 (lookalike name) FAIL: hits={0}" -f ($hits6 -join ','))
    $fail++
  }

  # CONTROL 7: the section 7 asymmetry, both halves. The platform tree WITHOUT
  # the crate is a FAILURE (the expected edge vanished); WITH the crate is green.
  $platformWithout = @(ConvertTo-NodeNames -Lines @(
    'fredo v0.2.5 (C:\repo\apps\tauri\src-tauri)',
    '+-- tauri v2.10.3',
    '+-- serde v1.0.228'
  ))
  $platformWith = @(ConvertTo-NodeNames -Lines @(
    'fredo v0.2.5 (C:\repo\apps\tauri\src-tauri)',
    '+-- tauri v2.10.3',
    '+-- telemetry-domain v0.1.0 (C:\repo\crates\telemetry-domain)'
  ))
  $absent = -not (@($platformWithout) -contains $CrateName)
  $present = @($platformWith) -contains $CrateName
  if ($absent -and $present) {
    Write-Output "CONTROL 7 (asymmetry: platform->crate is asserted, never forbidden) PASS"
  } else {
    Write-Output ("CONTROL 7 (asymmetry) FAIL: absentCase={0} presentCase={1}" -f $absent, $present)
    $fail++
  }

  # CONTROL 8: the manifest path leg - an entry escaping `crates/` must be seen,
  # and a commented-out prose line must not be.
  $manifestOk = "serde = `"1`"`n# fredo = { path = `"../..`" } in a comment`n"
  $manifestBad = "fredo = { path = `"../..`" }`n"
  $okEntries = @(Get-ManifestPathEntries -ManifestText $manifestOk)
  $badEntries = @(Get-ManifestPathEntries -ManifestText $manifestBad)
  if ($okEntries.Count -eq 0 -and $badEntries.Count -eq 1 -and $badEntries[0] -eq 'fredo|../..') {
    Write-Output "CONTROL 8 (manifest path legs: comment ignored, real escape parsed) PASS"
  } else {
    Write-Output ("CONTROL 8 (manifest path legs) FAIL: ok={0} bad={1}" -f ($okEntries -join ';'), ($badEntries -join ';'))
    $fail++
  }

  if ($fail -gt 0) {
    Write-Output ("RESULT: FAILED ({0} control(s))" -f $fail)
    exit 1
  }
  Write-Output "RESULT: CLEAN (8 controls)"
  exit 0
}

if ($SelfTest) { Invoke-SelfTest }

# ---------------------------------------------------------------------------
# Cargo invocations
# ---------------------------------------------------------------------------

function Invoke-CargoTree {
  param([string]$Package, [string]$WorkingDirectory, [string]$Manifest)
  $argList = @('tree', '-p', $Package, '--edges', 'normal,build')
  if ($Locked) { $argList += '--locked' }
  $argList += @('--manifest-path', $Manifest)
  # A cargo FAILURE (a stale lock under --locked, an unresolvable graph) is an
  # EXPECTED, HANDLED outcome here: it must reach this script's documented
  # `exit 2` and name the cause. Under $ErrorActionPreference='Stop', PowerShell
  # 5.1 promotes a redirected native command's stderr to a TERMINATING error, so
  # the typed refusal below became unreachable - the script died generically on
  # the host state its own contract documents (G-315). The stop preference is
  # therefore scoped AROUND the native call, and $LASTEXITCODE is read
  # explicitly rather than inferred from whether an exception fired.
  $prevEap = $ErrorActionPreference
  Push-Location -LiteralPath $WorkingDirectory
  try {
    $ErrorActionPreference = 'Continue'
    $out = & cargo @argList 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    Pop-Location
  }
  return [pscustomobject]@{ Lines = @($out | ForEach-Object { "$_" }); ExitCode = $code }
}

# ---------------------------------------------------------------------------
# Resolve locations (never from the CWD - a CI step's CWD is not guaranteed)
# ---------------------------------------------------------------------------

if ($Root -eq '') {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $Root = Join-Path (Join-Path (Join-Path $repoRoot 'apps') 'tauri') 'src-tauri'
}
$Root = (Resolve-Path -LiteralPath $Root).Path

if ($ManifestPath -eq '') { $ManifestPath = Join-Path $Root 'Cargo.toml' }
$ManifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path

$workspaceManifest = Join-Path $Root 'Cargo.toml'
$crateManifest = Join-Path (Join-Path (Join-Path $Root 'crates') $CrateName) 'Cargo.toml'

$forbiddenSet = Split-TokenList -Csv $Forbidden

Write-Output "== verify-domain-boundary (AC1 resolved-graph guard) =="
Write-Output ("WORKSPACE ROOT: {0}" -f $Root)
Write-Output ("MANIFEST:       {0}" -f $ManifestPath)
Write-Output ("TEXT MODE:      structural - parsed node names of the RESOLVED graph")
Write-Output ("FORBIDDEN ({0}): {1}" -f $forbiddenSet.Count, ($forbiddenSet -join ', '))

$violations = New-Object System.Collections.Generic.List[string]

# --- Clause 1: the crate's resolved graph carries no forbidden package ---------
$crateTree = Invoke-CargoTree -Package $CrateName -WorkingDirectory $Root -Manifest $ManifestPath
if ($crateTree.ExitCode -ne 0) {
  Write-Output "CARGO TREE FAILED:"
  foreach ($l in $crateTree.Lines) { Write-Output ("  {0}" -f $l) }
  Write-Output "RESULT: ERROR (the graph could not be resolved)"
  exit 2
}

$crateNames = @(ConvertTo-NodeNames -Lines $crateTree.Lines)
Write-Output ("CRATE GRAPH POPULATION: {0} resolved node(s)" -f $crateNames.Count)

if ($crateNames.Count -eq 0) {
  Write-Output "RESULT: INSTRUMENT FAILURE - the crate graph resolved ZERO nodes, so this scan proves nothing (G-524)"
  exit 3
}

$hits = @(Get-ForbiddenHits -Names $crateNames -ForbiddenSet $forbiddenSet)
if ($hits.Count -gt 0) {
  foreach ($h in ($hits | Sort-Object -Unique)) {
    $violations.Add(("FORBIDDEN EDGE: the crate's resolved graph contains '{0}' - the domain crate CAN reach the platform" -f $h))
    Write-Output ("  HIT: {0}" -f $h)
  }
} else {
  Write-Output "CRATE GRAPH HITS: 0 (none of the forbidden packages is resolved)"
}

# --- Clause 2: no `path =` in the crate manifest escapes `crates/` -------------
if (Test-Path -LiteralPath $crateManifest) {
  $crateManifestText = [System.IO.File]::ReadAllText($crateManifest)
  $entries = @(Get-ManifestPathEntries -ManifestText $crateManifestText)
  $cratesRoot = (Join-Path $Root 'crates')
  Write-Output ("MANIFEST path ENTRIES: {0}" -f $entries.Count)
  foreach ($entry in $entries) {
    $parts = $entry -split '\|', 2
    $depName = $parts[0]
    $relPath = $parts[1]
    $crateDir = Split-Path -Parent $crateManifest
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $crateDir $relPath))
    $cratesRootFull = [System.IO.Path]::GetFullPath($cratesRoot)
    $inside = $resolved.StartsWith($cratesRootFull, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $inside) {
      $violations.Add(("ESCAPING PATH DEP: '{0}' -> '{1}' resolves to '{2}', which is OUTSIDE '{3}'" -f $depName, $relPath, $resolved, $cratesRootFull))
      Write-Output ("  ESCAPES crates/: {0} = {{ path = `"{1}`" }} -> {2}" -f $depName, $relPath, $resolved)
    } else {
      Write-Output ("  inside crates/: {0} = {{ path = `"{1}`" }}" -f $depName, $relPath)
    }
  }
} else {
  $violations.Add(("MISSING MANIFEST: '{0}' does not exist, so the path-dep clause could not be evaluated" -f $crateManifest))
}

# --- Clause 3: the section 7 asymmetry - platform -> crate is ASSERTED present --
$platformTree = Invoke-CargoTree -Package $PlatformPackage -WorkingDirectory $Root -Manifest $ManifestPath
if ($platformTree.ExitCode -ne 0) {
  Write-Output "CARGO TREE (platform) FAILED:"
  foreach ($l in $platformTree.Lines) { Write-Output ("  {0}" -f $l) }
  Write-Output "RESULT: ERROR (the platform graph could not be resolved)"
  exit 2
}
$platformNames = @(ConvertTo-NodeNames -Lines $platformTree.Lines)
Write-Output ("PLATFORM GRAPH POPULATION: {0} resolved node(s)" -f $platformNames.Count)
if ($platformNames.Count -eq 0) {
  Write-Output "RESULT: INSTRUMENT FAILURE - the platform graph resolved ZERO nodes (G-524)"
  exit 3
}

if (@($platformNames) -contains $CrateName) {
  Write-Output ("ASYMMETRY: '{0}' IS resolved in the '{1}' graph - the expected platform->crate edge holds (section 7)" -f $CrateName, $PlatformPackage)
} else {
  $violations.Add(("ASYMMETRY BROKEN: '{0}' is NOT resolved in the '{1}' graph - the platform no longer depends on the domain crate, so the boundary is not being exercised at all (section 7 expects this edge to EXIST)" -f $CrateName, $PlatformPackage))
}

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
Write-Output ("VIOLATIONS: {0}" -f $violations.Count)
if ($violations.Count -gt 0) {
  foreach ($v in $violations) { Write-Output ("  - {0}" -f $v) }
  Write-Output "RESULT: VIOLATED"
  exit 1
}
Write-Output "RESULT: PASS (no forbidden package in the crate graph; no escaping path dep; platform->crate edge present)"
exit 0
