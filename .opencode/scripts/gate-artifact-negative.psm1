<#
gate-artifact-negative.psm1 - the FAIL-CLOSED negative legs for the Fredo
release-artifact gate (Spec #3181, ST-4).

Why this exists
  AC3 does not ask whether the gate's controls EXIST; it asks whether they FIRE.
  Each leg of this module induces one defect, lets the REAL gate run against it,
  and passes only when the gate exits non-zero AND names the expected id. A leg
  that cannot reproduce its defect FAILS the leg (never a skip, never a pass).

The three legs (REQ-3.1, REQ-3.2a, REQ-3.3)
  MissingDll  A COPY of the extracted payload tree loses one core DLL
              (`llama-common.dll`, the loader-dependency control the probe's
              own -RemoveDll leg uses). The load leg then exits 0xC0000135
              (LAUNCH_EXIT:-1073741515). The ORIGINAL tree is never mutated:
              its DLL digest is recorded before and after the copy and asserted
              unchanged.
  Csp         The 0.2.3 condition is induced as a real DOCUMENT RESPONSE HEADER
              through the CDP Fetch domain: every Document response is fulfilled
              with `Content-Security-Policy: style-src 'self' 'unsafe-inline'
              'nonce-fredo-gate-3181'`, so the page loads normally with the
              policy enforced from byte 0. A nonce in style-src voids
              'unsafe-inline', so Chakra/emotion's runtime <style> elements are
              refused and a normal injected <style> yields 0 rules. A no-write
              new-document seed pre-creates the hook's `__fredoGate.csp` array
              (the collector then short-circuits) and tags every style-src record
              with the induced policy, so the emitted detail names the nonce. The
              inner gate must report BOTH `CSP_VIOLATION:<detail>` AND
              `UNSTYLED:<detail>`; UNSTYLED alone means the detector did not
              reproduce the 0.2.3 mechanism.
  Database    `<DataDir>/postgres/cluster/start.log` is seeded (non-empty, no
              `postgresql.conf`, i.e. residue) and the product's own seam
              `FREDO_PG_CLUSTER_QUARANTINE_FAIL=1` is set, so the residue cannot
              be quarantined and the supervisor surfaces the typed
              DataDirNotEmpty failure. The inner gate must report
              `DB_NOT_READY:dirty`.

Stdout literals (REQ-3.4; one fact per line, mirrored into gate.log by the
driver):
    NEGATIVE_LEG=<MissingDll|Csp|Database>
    NEGATIVE_PREPARE=ok|failed:<detail>
    NEGATIVE_LEG_INSTRUMENT=ok|FAIL
    NEGATIVE_INSTRUMENT_FAILURE:<detail>          (instrument failure only)
    NEGATIVE_EXPECTED=<id[,id]>
    NEGATIVE_OBSERVED=<id[,id]>            (<none> when nothing fired)
    NEGATIVE_LEG_EFFECTIVE_DIR=<dir>       (Database leg; from the hook's DB_EFFECTIVE_DIR=)
    GATE_EXIT=<n>
    NEGATIVE_CONTROL=REPRODUCED|NOT_REPRODUCED|WRONG_ERROR|INSTRUMENT_FAILURE leg=<leg>
    NEGATIVE_NOT_REPRODUCED | NEGATIVE_WRONG_ERROR | NEGATIVE_INSTRUMENT_FAILURE
                                                            (on failure)
    CSP_POLICY_HOOK_EXIT=<n|unrunnable>    (generated Csp wrapper)
    CSP_INSTRUMENT=FAIL reason=<r>         (generated Csp wrapper: host cannot start)
    CSP_INDUCTION=response-header policy=<policy>|unsupported
                                           (generated Csp wrapper: the header
                                            mechanism, or Fetch.enable refused)
    CSP_FRAME=ready|not-ready readyState=<r> href=<h> bodyChildren=<n> internals=<b>
                                           (generated Csp wrapper: the document
                                            the policy is proven live in)

INSTRUMENT FAILURE IS ITS OWN CLASS (round-2 fix). A leg decides ONLY on what a
child actually reported. When the child died before printing a usable transcript,
left an unreadable exit code, or hit PowerShell 5.1's `-File` argument binder
(`ParameterArgumentTransformationError` / `Cannot convert value`), the leg
observed NOTHING about the device under test and reports
`NEGATIVE_LEG_INSTRUMENT=FAIL` plus the outcome id
`NEGATIVE_INSTRUMENT_FAILURE:<detail>`. That class TAKES PRECEDENCE over
`NEGATIVE_NOT_REPRODUCED` and `NEGATIVE_WRONG_ERROR` in both the leg and
`Test-NegativeOutcome`. Round 1 misread exactly this shape as "the app survived"
(GateExit 0) and as "the hook failed with the wrong id", so it is now impossible
for a dead child to be scored as an observation.

PORT CONTRACT (round-2 fix): the probe's `-Ports` parameter accepts ONE
specification - one or more decimal ports separated by `,`, `;` or whitespace. A
`[int[]]` parameter cannot be bound from a `-File` invocation with more than one
value, which is why a comma-joined token used to abort the child in its binder.
This module passes exactly `9223,16932,19631` and never any other shape.

Exit contract (mirrors the harness, plan section C)
    0  reproduced - the inner gate exited non-zero AND emitted every expected id
    1  NOT reproduced (the inner gate passed, or refused with exit 2/3), the
       wrong id fired (`NEGATIVE_WRONG_ERROR`), or the instrument could not run
       (`NEGATIVE_INSTRUMENT_FAILURE`)

Driver dispatch contract (gate-release-artifact.ps1 -Mode negative)
  The landed driver imports this module and calls ONE function:

      Invoke-NegativeLeg -Name <MissingDll|Csp|Database> `
                         -Installer <abs setup.exe> -OutDir <abs evidence root> `
                         -CdpPort <n> -WaitSecs <n> -DbReadySecs <n> `
                         -SkipCompanion:<bool> [-SevenZip <path>] [-DriverPath <abs>]

  and expects an object with `Observed` (string[] of `ID` or `ID:<detail>`) and
  `GateExit` (int). The leg also returns `InstrumentFailed` (bool) and
  `InstrumentDetail` (string). The landed driver honours BOTH signals and reports
  `NEGATIVE_INSTRUMENT_FAILURE:<detail>` with PRECEDENCE over
  NEGATIVE_NOT_REPRODUCED / NEGATIVE_WRONG_ERROR: it reads `InstrumentFailed`
  directly, and it also accepts a `NEGATIVE_INSTRUMENT_FAILURE` entry in
  `Observed`, which is why an instrument-failed leg observes exactly that id and
  nothing else.

  `-InstrumentRoot` is a SELF-TEST seam (the driver never passes it): it lets the
  hermetic controls drive this real entry route against instruments that cannot
  bind, which is the round-1 regression.

  The driver's gate path exposes no seam for a mutant exe, a wrapper probe or a
  data dir, so a leg drives the SAME instruments the gate drives:
  verify-installer-payload.ps1 (extraction), launch-artifact-probe.ps1 (the only
  GUI launch primitive) and gate-artifact-window.ps1 (the clauses), with the
  induced condition applied. Ids and exit semantics are the plan's, unchanged.

  `Complete-NegativeControl` remains the standalone receipt helper (self-test
  controls + a manual drive); it is NOT on the driver's path.

  New-NegativeControl NEVER mutates the tree it is handed: MissingDll copies
  first, and every leg writes only under -OutDir.

================================================================================
REQ-3.2b - the bundle-level CSP revert (REQUIRED, runs LAST in the round)
================================================================================
The committed overlay `.opencode/scripts/tauri.csp-revert.json` is

    { "app": { "security": { "dangerousDisableAssetCspModification": false } } }

RECORDED EQUIVALENCE: a `tauri build --config <overlay>` overlay DEEP-MERGES; it
cannot delete a key. The shipped fix is
`dangerousDisableAssetCspModification: ["style-src"]` (tauri.conf.json:29), which
means "asset-CSP modification IS disabled for style-src". Setting the key to
`false` means "asset-CSP modification is NOT disabled", i.e. Tauri re-injects the
nonce into style-src and strips 'unsafe-inline' - the exact 0.2.3 mechanism.
`false` is therefore the overlay-expressible form of "removed"; this is an
equivalence, never a literal deletion, and a receipt must say so. The overlay
changes NO other config key and `tauri.conf.json` stays unchanged.

Tester recipe (build OUTSIDE the harness - NF-2 forbids tauri/pnpm inside it;
run this LAST, after every artifact-identity row - G-446):

    1. copy the installer of record aside and record its SHA-256
       `.opencode/tmp/release-gate/installer-of-record/`
    2. `powershell -NoProfile -File .opencode/tmp/release-gate/csp-revert-build.ps1`
       with a body equivalent to:
           Set-Location 'apps\tauri'
           & '.\node_modules\.bin\tauri.cmd' build `
               --config '<absolute path>\.opencode\scripts\tauri.csp-revert.json' `
               --bundles nsis
    3. copy the newly produced *-setup.exe to
       `.opencode/tmp/release-gate/csp-revert-installer/`
    4. gate THAT installer (`-Mode gate`); expect CSP_VIOLATION: + UNSTYLED: and a
       non-zero exit
    5. re-assert the installer-of-record copy's SHA-256 (unchanged)

PowerShell 5.1 standard library only. ASCII-only source (G-315).
#>

$script:MissingDllExpected = 'LAUNCH_EXIT:-1073741515'
$script:MissingDllAlias = 3221225781   # the same code read as an unsigned dword
$script:DefaultDllName = 'llama-common.dll'
$script:OverlayRelativePath = '.opencode/scripts/tauri.csp-revert.json'

# The ONE handle-whitelist spawn (G-450). Each leg drives the SAME gate/probe
# instruments the driver uses; they are spawned through the shared helper so a
# leg child never inherits the caller's stdout/stderr pipe.
Import-Module (Join-Path $PSScriptRoot 'detach-process.psm1') -ErrorAction Stop

# The shared CDP client. The generated Csp wrapper imports it for itself; this
# module imports it too so the hermetic control can assert the response-header
# helpers (Add-CdpResponseHeader / Get-CdpFulfillBody) directly.
Import-Module (Join-Path $PSScriptRoot 'fredo-cdp.psm1') -ErrorAction Stop

# ---- small helpers -----------------------------------------------------------

function Get-NegativeSlug {
    param([string]$Leg)

    switch ([string]$Leg) {
        'MissingDll' { return 'missing-dll' }
        'Csp' { return 'csp' }
        'Database' { return 'database' }
        default { return ([string]$Leg).ToLowerInvariant() }
    }
}

function New-NegativeDirectory {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-NegativeSha256 {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ''
    }
    try {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
        return ''
    }
}

function Remove-NegativeTree {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return }
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $Path)) { return }
        Start-Sleep -Milliseconds 200
    }
}

# ---- expectations (the binding id per leg) -----------------------------------

function Get-NegativeExpectation {
    param([string]$Leg)

    switch ([string]$Leg) {
        'MissingDll' {
            return [pscustomobject]@{
                Leg = 'MissingDll'
                Slug = 'missing-dll'
                Expected = @($script:MissingDllExpected)
                RequireAll = $true
                Assertions = ''
                Notes = @('delete llama-common.dll from a COPY of the extracted tree; expect the load leg to exit 0xC0000135')
            }
        }
        'Csp' {
            return [pscustomobject]@{
                Leg = 'Csp'
                Slug = 'csp'
                Expected = @('CSP_VIOLATION', 'UNSTYLED')
                RequireAll = $true
                # The styled clause alone owns the pair, but the screenshot
                # clause is selected too so cdp.json carries screenshot.criteria.S1
                # (the rendered-frame receipt the 0.2.3 discriminator rests on).
                Assertions = 'styled,screenshot'
                Notes = @('induce a nonce-bearing style-src policy as a Document response header; both ids MUST fire (UNSTYLED alone is NEGATIVE_WRONG_ERROR)')
            }
        }
        'Database' {
            return [pscustomobject]@{
                Leg = 'Database'
                Slug = 'database'
                Expected = @('DB_NOT_READY:dirty')
                RequireAll = $true
                Assertions = ''
                Notes = @('seed <DataDir>/postgres/cluster/start.log and set FREDO_PG_CLUSTER_QUARANTINE_FAIL=1; expect DB_NOT_READY:dirty')
            }
        }
        default {
            return $null
        }
    }
}

# ---- observation + classification -------------------------------------------

function Get-NegativeObservedDetail {
    param([string[]]$Lines, [string]$Id)

    $details = New-Object System.Collections.ArrayList
    foreach ($line in @($Lines)) {
        if ($null -eq $line) { continue }
        $text = ([string]$line).Trim()
        if ($text.Length -eq 0) { continue }
        if ($text -notmatch ('(?i)' + [regex]::Escape($Id))) { continue }
        $detail = ''
        $colonIndex = $text.IndexOf(':')
        if ($colonIndex -ge 0 -and $colonIndex -lt ($text.Length - 1)) {
            $detail = $text.Substring($colonIndex + 1).Trim()
        }
        [void]$details.Add($detail)
    }
    return @($details)
}

function Get-NegativeObservedErrorIds {
    param([string[]]$Lines)

    $ids = New-Object System.Collections.ArrayList
    foreach ($line in @($Lines)) {
        if ($null -eq $line) { continue }
        $text = ([string]$line).Trim()
        if ($text.Length -eq 0) { continue }

        if ($text -match 'LAUNCH_EXIT:\s*(-?[0-9]+)') {
            $raw = [int64]$Matches[1]
            if ($raw -eq $script:MissingDllAlias) { $raw = -1073741515 }
            $value = 'LAUNCH_EXIT:' + $raw.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            if (-not $ids.Contains($value)) { [void]$ids.Add($value) }
        }
        if ($text -match '\bCSP_VIOLATION\b') {
            if (-not $ids.Contains('CSP_VIOLATION')) { [void]$ids.Add('CSP_VIOLATION') }
        }
        if ($text -match '\bUNSTYLED\b') {
            if (-not $ids.Contains('UNSTYLED')) { [void]$ids.Add('UNSTYLED') }
        }
        if ($text -match 'DB_NOT_READY:\s*([A-Za-z]+)') {
            $value = 'DB_NOT_READY:' + $Matches[1].ToLowerInvariant()
            if (-not $ids.Contains($value)) { [void]$ids.Add($value) }
        }
    }
    return @($ids)
}

# Map the probe's observed `EXIT_CODE=` to the leg's expected id form. Returns
# `LAUNCH_EXIT:<signed>` (the probe/API signed int32) or '' when the transcript
# carries no readable code. The unsigned dword alias (e.g. 3221225781 for
# 0xC0000135) is accepted and normalised to the signed value, so a probe that
# reads the code either way satisfies the MissingDll expectation (round 4, A4).
function Get-NegativeLaunchExitFromLines {
    param([string[]]$Lines)

    foreach ($line in @($Lines)) {
        $text = ([string]$line).Trim()
        if ($text -match '^EXIT_CODE=\s*(-?[0-9]+)\s*$') {
            $raw = [int64]$Matches[1]
            if ($raw -eq $script:MissingDllAlias) { $raw = -1073741515 }
            return 'LAUNCH_EXIT:' + $raw.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        }
    }
    return ''
}

# Parse the hook's effective PG data dir from its transcript. The hook emits
# `DB_EFFECTIVE_DIR=<fresh|dirty>=<absolute path>` (Stream B, round 4); a bare
# `DB_EFFECTIVE_DIR=<path>` is also accepted. Returns the path ('' when absent).
function Get-NegativeEffectiveDirFromLines {
    param([string[]]$Lines)

    foreach ($line in @($Lines)) {
        $text = ([string]$line).Trim()
        if ($text -match '^DB_EFFECTIVE_DIR=(.+?)\s*$') {
            $value = $Matches[1].Trim()
            if ($value -match '^(fresh|dirty)=(.*)$') { return $Matches[2].Trim() }
            return $value
        }
    }
    return ''
}

function Test-NegativeOutcome {
    param(
        [string]$Leg,
        [int]$GateExit,
        [string[]]$Lines,
        [string]$PrepareError = '',
        [string]$InstrumentDetail = ''
    )

    $expectation = Get-NegativeExpectation -Leg $Leg
    $observed = @(Get-NegativeObservedErrorIds -Lines $Lines)
    $observedText = '<none>'
    if ($observed.Count -gt 0) { $observedText = ($observed -join ',') }
    $expectedText = ''
    if ($null -ne $expectation) { $expectedText = ($expectation.Expected -join ',') }

    $result = [pscustomobject]@{
        Leg = $Leg
        Expected = @()
        Observed = @($observed)
        ExpectedText = $expectedText
        ObservedText = $observedText
        GateExit = $GateExit
        Ok = $false
        Code = 'NEGATIVE_NOT_REPRODUCED'
        Detail = ''
    }
    if ($null -eq $expectation) {
        $result.Code = 'NEGATIVE_WRONG_ERROR'
        $result.Detail = 'unknown negative leg'
        return $result
    }
    $result.Expected = @($expectation.Expected)

    # INSTRUMENT FAILURE IS ITS OWN CLASS, and it takes precedence over every
    # observation class. A leg whose child never produced a usable transcript (or
    # whose exit code is unreadable) observed NOTHING about the device under test,
    # so it must never be scored as NEGATIVE_NOT_REPRODUCED (silently "the gate
    # still passed") or NEGATIVE_WRONG_ERROR (a half-right observation). Round 1
    # was misread exactly that way.
    if (-not [string]::IsNullOrWhiteSpace($InstrumentDetail)) {
        $result.Code = 'NEGATIVE_INSTRUMENT_FAILURE'
        $result.Detail = $InstrumentDetail
        return $result
    }
    if (-not [string]::IsNullOrWhiteSpace($PrepareError)) {
        $result.Code = 'NEGATIVE_NOT_REPRODUCED'
        $result.Detail = 'mutant-preparation-failed: ' + $PrepareError
        return $result
    }
    if ($GateExit -eq 0) {
        $result.Code = 'NEGATIVE_NOT_REPRODUCED'
        $result.Detail = 'the inner gate PASSED against the induced defect (exit 0)'
        return $result
    }
    if ($GateExit -eq 2 -or $GateExit -eq 3) {
        $result.Code = 'NEGATIVE_NOT_REPRODUCED'
        $result.Detail = ('the inner gate REFUSED (exit {0}) - a refusal never exercises the clause' -f $GateExit)
        return $result
    }

    $missing = New-Object System.Collections.ArrayList
    foreach ($expectedId in @($expectation.Expected)) {
        if (-not $observed.Contains($expectedId)) { [void]$missing.Add($expectedId) }
    }
    # UNSTYLED is one id for two different failures. The Csp leg must prove the
    # STYLED clause failed; a screenshot-frame failure alone means the styled
    # clause passed, i.e. the 0.2.3 mechanism was not reproduced.
    if ($Leg -eq 'Csp' -and $observed.Contains('UNSTYLED')) {
        $styled = $false
        foreach ($detail in @(Get-NegativeObservedDetail -Lines $Lines -Id 'UNSTYLED')) {
            if ($detail -notmatch '^screenshot-frame') { $styled = $true }
        }
        if (-not $styled -and -not $missing.Contains('UNSTYLED')) {
            [void]$missing.Add('UNSTYLED:styled')
        }
    }

    if ($missing.Count -gt 0) {
        $result.Code = 'NEGATIVE_WRONG_ERROR'
        $result.Detail = ('expected id(s) not observed: ' + ($missing -join ',') + '; observed: ' + $observedText)
        return $result
    }

    $result.Ok = $true
    $result.Code = ''
    $result.Detail = 'reproduced: gate exit ' + $GateExit
    return $result
}

# ---- leg 1: MissingDll ------------------------------------------------------

function New-NegativeMissingDllTree {
    param(
        [string]$ExtractedRoot,
        [string]$LegDir,
        [string]$ExtractedExe = '',
        [string]$DllName = $script:DefaultDllName
    )

    $result = [pscustomobject]@{
        Ok = $false
        Error = ''
        CopyRoot = ''
        LaunchExe = ''
        SourceDll = ''
        SourceDllSha256Before = ''
        SourceDllSha256After = ''
        CopyDll = ''
        CopyDllRemoved = $false
    }

    if ([string]::IsNullOrWhiteSpace($ExtractedRoot) -or -not (Test-Path -LiteralPath $ExtractedRoot -PathType Container)) {
        $result.Error = 'the extracted payload root is missing or not a directory'
        return $result
    }
    if ([string]::IsNullOrWhiteSpace($LegDir)) {
        $result.Error = 'LegDir is required'
        return $result
    }
    $root = (Resolve-Path -LiteralPath $ExtractedRoot).Path

    $exePath = ''
    if (-not [string]::IsNullOrWhiteSpace($ExtractedExe)) {
        if (-not (Test-Path -LiteralPath $ExtractedExe -PathType Leaf)) {
            $result.Error = ('the extracted exe was not found: ' + $ExtractedExe)
            return $result
        }
        $exePath = (Resolve-Path -LiteralPath $ExtractedExe).Path
        if (-not $exePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
            $result.Error = ('the extracted exe is outside the extracted payload root: ' + $exePath)
            return $result
        }
    } else {
        $candidates = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'fredo.exe' -ErrorAction SilentlyContinue)
        if ($candidates.Count -eq 0) {
            $result.Error = ('no fredo.exe under the extracted payload root: ' + $root)
            return $result
        }
        $exePath = $candidates[0].FullName
    }

    $exeDir = Split-Path -Parent $exePath
    $sourceDll = Join-Path $exeDir $DllName
    if (-not (Test-Path -LiteralPath $sourceDll -PathType Leaf)) {
        $result.Error = ('the control DLL is not present beside the extracted exe: ' + $sourceDll)
        return $result
    }

    $copyRoot = Join-Path $LegDir 'payload-copy'
    New-NegativeDirectory -Path $LegDir
    # A stale copy from an earlier attempt would make the control ambiguous.
    Remove-NegativeTree -Path $copyRoot
    New-NegativeDirectory -Path $copyRoot

    try {
        Copy-Item -Path (Join-Path $root '*') -Destination $copyRoot -Recurse -Force -ErrorAction Stop
    } catch {
        $result.Error = ('could not copy the extracted payload tree: ' + $_.Exception.Message)
        return $result
    }

    $relative = $sourceDll.Substring($root.Length).TrimStart('\', '/')
    $copyDll = Join-Path $copyRoot $relative
    $copyExe = Join-Path $copyRoot $exePath.Substring($root.Length).TrimStart('\', '/')
    $before = Get-NegativeSha256 -Path $sourceDll

    if (-not (Test-Path -LiteralPath $copyDll -PathType Leaf)) {
        $result.Error = ('the copied tree does not carry the control DLL: ' + $copyDll)
        return $result
    }
    if (-not (Test-Path -LiteralPath $copyExe -PathType Leaf)) {
        $result.Error = ('the copied tree does not carry the exe: ' + $copyExe)
        return $result
    }

    try {
        Remove-Item -LiteralPath $copyDll -Force -ErrorAction Stop
    } catch {
        $result.Error = ('could not delete the DLL from the COPY: ' + $_.Exception.Message)
        return $result
    }

    $after = Get-NegativeSha256 -Path $sourceDll
    $copyGone = -not (Test-Path -LiteralPath $copyDll -PathType Leaf)

    $result.CopyRoot = $copyRoot
    $result.LaunchExe = $copyExe
    $result.SourceDll = $sourceDll
    $result.SourceDllSha256Before = $before
    $result.SourceDllSha256After = $after
    $result.CopyDll = $copyDll
    $result.CopyDllRemoved = $copyGone

    if ($before.Length -eq 0 -or $after.Length -eq 0 -or $before -ne $after) {
        $result.Error = 'the ORIGINAL extracted tree changed while building the mutant'
        return $result
    }
    if (-not $copyGone) {
        $result.Error = 'the DLL could not be removed from the copy'
        return $result
    }

    $result.Ok = $true
    return $result
}

# ---- leg 2: Csp -------------------------------------------------------------

function Get-NegativeCspPolicy {
    # The induced 0.2.3 condition, delivered as a DOCUMENT RESPONSE HEADER (see
    # New-NegativeCspHook). A nonce in style-src voids 'unsafe-inline' - the spec
    # says a nonce/hash source makes 'unsafe-inline' ignored - so emotion's
    # runtime <style> elements AND a normally injected <style> are refused.
    # Only style-src is constrained; 'self' keeps the app's own bundled sheets
    # loading, so the document still renders (it is UNSTYLED, not blank).
    return "style-src 'self' 'unsafe-inline' 'nonce-fredo-gate-3181'"
}

function Get-NegativeCspSeedScript {
    # The new-document seed. NO WRITE TO THE PARSER STREAM: at document-start a
    # new document has no root element (document.head and document.documentElement
    # are both null), and writing into a navigation document that is not yet
    # actively parsing is an implicit open() that replaces the parser stream and
    # strands the frame at readyState=loading. This seed touches only `window` and
    # `document`, both of which exist at document-start.
    #
    # It pre-creates __fredoGate.csp so the hook's own collector short-circuits
    # (never a second listener), and it tags every style-src record with the
    # induced policy so the emitted CSP_VIOLATION detail names the nonce.
    return @'
(function () {
  try {
    var policy = "style-src 'self' 'unsafe-inline' 'nonce-fredo-gate-3181'";
    var gate = window.__fredoGate = window.__fredoGate || {};
    if (!Array.isArray(gate.csp)) { gate.csp = []; }
    gate.cspInstalled = true;
    if (gate.__fredoPolicyTag === policy) { return true; }
    gate.__fredoPolicyTag = policy;
    document.addEventListener('securitypolicyviolation', function (event) {
      try {
        gate.csp.push({
          directive: String(event.violatedDirective || ''),
          blocked: 'policy=' + policy,
          sample: String(event.sample || '').slice(0, 120)
        });
      } catch (inner) { }
    }, true);
    return true;
  } catch (error) { return false; }
})()
'@
}

function New-NegativeCspHook {
    param(
        [string]$LegDir,
        [string]$WindowHookPath,
        [string]$CdpModulePath = ''
    )

    if ([string]::IsNullOrWhiteSpace($LegDir)) { throw 'LegDir is required' }
    if ([string]::IsNullOrWhiteSpace($WindowHookPath)) {
        $WindowHookPath = Join-Path $PSScriptRoot 'gate-artifact-window.ps1'
    }
    if (-not (Test-Path -LiteralPath $WindowHookPath -PathType Leaf)) {
        throw ('the window hook script was not found: ' + $WindowHookPath)
    }
    if ([string]::IsNullOrWhiteSpace($CdpModulePath)) {
        $CdpModulePath = Join-Path $PSScriptRoot 'fredo-cdp.psm1'
    }
    if (-not (Test-Path -LiteralPath $CdpModulePath -PathType Leaf)) {
        throw ('fredo-cdp.psm1 was not found: ' + $CdpModulePath)
    }

    # The hook is spawned with the SANITISED PATH, where a bare `powershell` does
    # not resolve. Embed the ABSOLUTE PowerShell host and assert it exists at
    # generation time (round 4, A5): a bare name was an instrument death, not a
    # CSP finding.
    $powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) {
        throw ('the Windows PowerShell host was not found: ' + $powerShellExe)
    }

    $hookPath = (Resolve-Path -LiteralPath $WindowHookPath).Path
    $modulePath = (Resolve-Path -LiteralPath $CdpModulePath).Path
    $detachPath = Join-Path $PSScriptRoot 'detach-process.psm1'
    if (-not (Test-Path -LiteralPath $detachPath -PathType Leaf)) {
        throw ('detach-process.psm1 was not found: ' + $detachPath)
    }
    $detachPath = (Resolve-Path -LiteralPath $detachPath).Path
    New-NegativeDirectory -Path $LegDir

    $policy = Get-NegativeCspPolicy
    $seed = Get-NegativeCspSeedScript

    # The generated wrapper. It is a plain script (no string-array assembly): the
    # placeholders are replaced with resolved absolute paths / the policy / the
    # seed so the emitted text is exactly what the gate runs.
    $template = @'
# csp-wrapper-hook.ps1 - GENERATED by gate-artifact-negative.psm1 (Spec #3181 ST-4).
# The Csp negative leg. It induces a nonce-bearing style-src policy as a real
# DOCUMENT RESPONSE HEADER through the CDP Fetch domain, so the page loads
# normally with the policy enforced from byte 0 - never as a post-hoc <meta> and
# never as a write into the parser stream. It keeps this DevTools session open and
# services EVERY paused Document response while the real in-window hook runs, so
# the hook's own reload carries the same header.
# Do not edit: regenerate with New-NegativeCspHook.
$ErrorActionPreference = 'Continue'

$cdpModule = @'
@@CDP_MODULE@@
@@HQ@@
$detachModule = @'
@@DETACH_MODULE@@
@@HQ@@
$windowHook = @'
@@WINDOW_HOOK@@
@@HQ@@
$powerShellExe = @'
@@HOST_EXE@@
@@HQ@@
$policy = @'
@@POLICY@@
@@HQ@@
$seedScript = @'
@@SEED@@
@@HQ@@

Import-Module -Name $cdpModule -Force
Import-Module -Name $detachModule -Force

$port = 0
$portText = [string]$env:GATE_CDP_PORT
if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    Write-Output 'CSP_POLICY=failed'
    Write-Output 'ERROR=GATE_CDP_PORT missing or invalid'
    exit 1
}

$bootSettleSecs = 60.0
$bootText = [string]$env:GATE_BOOT_SETTLE_SECS
$parsedBoot = 0.0
if ([double]::TryParse($bootText, [ref]$parsedBoot) -and $parsedBoot -ge 5.0) { $bootSettleSecs = $parsedBoot }

$session = $null
try {
    $session = Connect-FredoCdp -Port $port -TimeoutSecs 15
} catch {
    Write-Output 'CSP_POLICY=failed'
    Write-Output ('CDP_UNAVAILABLE:' + $_.Exception.Message)
    exit 1
}

$null = Enable-CdpDomain -Session $session -Domain 'Page'
$null = Enable-CdpDomain -Session $session -Domain 'Runtime'
$null = Enable-CdpDomain -Session $session -Domain 'Log'
Write-Output ('CSP_TARGET=' + [string]$session.Target.url)
Write-Output ('CSP_TARGETS=' + [string]$session.Targets)

# A SECOND session carries the Fetch interception. It is the only session whose
# socket the serve loop polls, and polling must never collide with a command's own
# receive, so the two concerns get two connections. Fetch interception is scoped
# to the enabling session, which is why the hook's own reload (a THIRD session)
# is still paused here.
$fetchSession = $null
try {
    $fetchSession = Connect-FredoCdp -Port $port -TimeoutSecs 15
} catch {
    Write-Output 'CSP_POLICY=failed'
    Write-Output ('CDP_UNAVAILABLE:' + $_.Exception.Message)
    Close-FredoCdp -Session $session
    exit 1
}
$null = Enable-CdpDomain -Session $fetchSession -Domain 'Page'

$probeScript = @'
@@READY_SCRIPT@@
@@HQ@@

function Get-CspFrameDetail {
    param($State)
    $readyState = '<none>'
    $href = '<none>'
    $bodyChildren = '<none>'
    $internals = '<none>'
    if ($null -ne $State -and $State.Ok -and $null -ne $State.Value) {
        $readyState = [string]$State.Value.readyState
        $href = [string]$State.Value.href
        $bodyChildren = [string]$State.Value.bodyChildren
        $internals = [string]$State.Value.internals
    }
    return ('readyState=' + $readyState + ' href=' + $href + ' bodyChildren=' + $bodyChildren + ' internals=' + $internals)
}

# 1. Wait for the FIRST navigation to commit BEFORE enabling Fetch. A reload
#    issued against the still-blank about:blank target restarts the in-flight
#    cold-boot navigation (round 5), so the induction must come after the app's
#    own document exists.
$preNavOk = $false
$preNavState = $null
$preWatch = [System.Diagnostics.Stopwatch]::StartNew()
while ($preWatch.ElapsedMilliseconds -lt [int]($bootSettleSecs * 1000)) {
    $preNavState = Invoke-CdpEvaluate -Session $session -Expression $probeScript -TimeoutMs 8000
    if ($preNavState.Ok -and $null -ne $preNavState.Value -and $preNavState.Value.ready -eq $true) { $preNavOk = $true; break }
    Start-Sleep -Milliseconds 250
}
if (-not $preNavOk) {
    Write-Output ('CSP_FRAME=not-ready ' + (Get-CspFrameDetail $preNavState))
    Write-Output 'CSP_POLICY=not-applied'
    Write-Output 'ERROR=the app document never reached ready before the induction'
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}

# 2. Enable Fetch at the RESPONSE stage for Document requests only (on the
#    Fetch-serving session).
$fetchEnable = Send-CdpCommand -Session $fetchSession -Method 'Fetch.enable' -Params @{
    patterns = @(@{ urlPattern = '*'; resourceType = 'Document'; requestStage = 'Response' })
}
if (-not $fetchEnable.Ok) {
    Write-Output 'CSP_INDUCTION=unsupported'
    Write-Output ('ERROR=Fetch.enable refused: ' + [string]$fetchEnable.Error)
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}
Write-Output ('CSP_INDUCTION=response-header policy=' + $policy)

# 3. Register the no-write new-document seed. It pre-creates __fredoGate.csp (the
#    hook's collector then short-circuits) and tags style-src records with the
#    induced policy so the emitted violation detail names the nonce.
$identifier = Add-CdpNewDocumentScript -Session $fetchSession -Script $seedScript
if ([string]::IsNullOrWhiteSpace([string]$identifier)) {
    Write-Output 'CSP_POLICY=failed'
    Write-Output 'ERROR=Page.addScriptToEvaluateOnNewDocument refused'
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}
Write-Output ('CSP_POLICY_ID=' + [string]$identifier)

# 4. Reload into a document instrumented from byte 0 and service the paused
#    Document response: the header is added THERE, before the parser sees a byte.
$token = 'gate-' + [Guid]::NewGuid().ToString('N')
$null = Invoke-CdpEvaluate -Session $session -Expression ("window.__fredoGateDocToken = '" + $token + "'; true") -TimeoutMs 5000
$null = Send-CdpCommand -Session $session -Method 'Page.reload' -Params @{ ignoreCache = $false } -TimeoutMs 10000
try {
    $first = Invoke-CdpFetchServe -Session $fetchSession -HeaderValue $policy -TimeoutMs 30000 -MinServed 1 -DocumentOnly
} catch {
    Write-Output ('CSP_INSTRUMENT=FAIL reason=serve ' + $_.Exception.Message)
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}
if (-not $first.Ok) {
    Write-Output 'CSP_POLICY=not-applied'
    Write-Output ('ERROR=the induced response header could not be fulfilled: ' + [string]$first.LastError)
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}
if ($first.Served -lt 1) {
    Write-Output 'CSP_POLICY=not-applied'
    Write-Output 'ERROR=no Document response was paused for the induced policy'
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}
Write-Output ('CSP_INDUCTION_SERVED=' + [string]$first.Served)

# 5. Frame proof: a NEW document (the token is gone), seeded, complete, with the
#    Tauri internals and a body child. The policy is live in exactly that document.
$applied = $false
$frameState = $null
$frameWatch = [System.Diagnostics.Stopwatch]::StartNew()
while ($frameWatch.ElapsedMilliseconds -lt 30000) {
    $frameState = Invoke-CdpEvaluate -Session $session -Expression $probeScript -TimeoutMs 8000
    if ($frameState.Ok -and $null -ne $frameState.Value) {
        if ($frameState.Value.ready -eq $true -and [string]::IsNullOrEmpty([string]$frameState.Value.token) -and $frameState.Value.seeded -eq $true) {
            $applied = $true
            break
        }
    }
    Start-Sleep -Milliseconds 250
}
if ($applied) {
    Write-Output ('CSP_FRAME=ready ' + (Get-CspFrameDetail $frameState))
} else {
    Write-Output ('CSP_FRAME=not-ready ' + (Get-CspFrameDetail $frameState))
}
if (-not $applied) {
    Write-Output 'CSP_POLICY=not-applied'
    Write-Output 'ERROR=the induced style-src policy did not reach a ready reloaded document'
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}
Write-Output 'CSP_POLICY=nonce-style-src'

# 6. Spawn the REAL in-window hook through the handle-whitelist helper (explicit
#    stdio, no inherited stdout) and service EVERY Document pause until it exits,
#    then echo its transcript. The hook reloads for the styled clause; that reload
#    must carry the same header, so the session stays open for the whole child run.
$runDir = Split-Path -Parent $PSCommandPath
$hookOut = Join-Path $runDir 'csp-hook-child.stdout.log'
$hookErr = Join-Path $runDir 'csp-hook-child.stderr.log'
$hookExit = $null
$childPid = 0
try {
    $childPid = Start-DetachedProcess -FilePath $powerShellExe -ArgumentString ('-NoProfile -File "' + $windowHook + '"') -StdOutPath $hookOut -StdErrPath $hookErr
} catch {
    Write-Output 'CSP_POLICY_HOOK_EXIT=unrunnable'
    Write-Output ('CSP_INSTRUMENT=FAIL reason=' + $_.Exception.Message)
    Close-FredoCdp -Session $fetchSession
    Close-FredoCdp -Session $session
    exit 1
}
try {
    while ($true) {
        $status = Get-DetachedChildExitCode -ProcessId $childPid
        if ($status.Status -eq 'observed') { $hookExit = [int]$status.Code; break }
        if ($status.Status -eq 'unreadable') { $hookExit = $null; break }
        $serve = Invoke-CdpFetchServe -Session $fetchSession -HeaderValue $policy -TimeoutMs 700 -MinServed 0 -DocumentOnly
        if (-not $serve.Ok) {
            Write-Output ('CSP_INSTRUMENT=FAIL reason=' + [string]$serve.LastError)
            break
        }
    }
} finally {
    Close-DetachedChild -ProcessId $childPid
}
Close-FredoCdp -Session $fetchSession
Close-FredoCdp -Session $session

if (Test-Path -LiteralPath $hookOut -PathType Leaf) {
    foreach ($line in @(Get-Content -LiteralPath $hookOut)) { Write-Output ([string]$line) }
}
if ($null -eq $hookExit) {
    Write-Output 'CSP_POLICY_HOOK_EXIT=unrunnable'
    exit 1
}
Write-Output ('CSP_POLICY_HOOK_EXIT=' + $hookExit)
exit $hookExit
'@

    # A single-quoted here-string REPLACED by value: paths never contain
    # placeholders, and the seed/policy are emitted verbatim (quotes included).
    $hostExe = $powerShellExe
    $readyScript = @'
(function () {
  var gate = window.__fredoGate || null;
  var hasInternals = (typeof window.__TAURI_INTERNALS__ !== 'undefined' && window.__TAURI_INTERNALS__ !== null);
  var bodyChildren = document.body ? document.body.childElementCount : -1;
  var href = String(location.href);
  return {
    token: (typeof window.__fredoGateDocToken === 'undefined') ? '' : String(window.__fredoGateDocToken),
    ready: (document.readyState === 'complete' && href !== 'about:blank' && bodyChildren >= 1 && hasInternals),
    readyState: String(document.readyState),
    href: href,
    bodyChildren: bodyChildren,
    internals: hasInternals,
    seeded: !!(gate && Array.isArray(gate.csp) && gate.cspInstalled === true)
  };
})()
'@

    $text = $template
    # Inner here-string terminators are carried as a sentinel so the template
    # itself can be a single-quoted here-string (a literal terminator line would
    # end it early). Restore them before the value substitutions.
    $text = $text.Replace('@@HQ@@', "'@")
    $text = $text.Replace('@@CDP_MODULE@@', $modulePath)
    $text = $text.Replace('@@DETACH_MODULE@@', $detachPath)
    $text = $text.Replace('@@WINDOW_HOOK@@', $hookPath)
    $text = $text.Replace('@@HOST_EXE@@', $hostExe)
    $text = $text.Replace('@@POLICY@@', $policy)
    $text = $text.Replace('@@SEED@@', $seed)
    $text = $text.Replace('@@READY_SCRIPT@@', $readyScript.TrimEnd("`r", "`n"))

    $encoding = New-Object System.Text.UTF8Encoding($false)
    $outPath = Join-Path $LegDir 'csp-wrapper-hook.ps1'
    [System.IO.File]::WriteAllText($outPath, $text, $encoding)
    return $outPath
}

# ---- leg 3: Database --------------------------------------------------------

function New-NegativeDatabaseResidue {
    param(
        [string]$DataDir,
        [string]$LogName = 'start.log'
    )

    $result = [pscustomobject]@{
        Ok = $false
        Error = ''
        DataDir = ''
        ResidueDir = ''
        ResidueFile = ''
        Env = @{}
    }
    if ([string]::IsNullOrWhiteSpace($DataDir)) {
        $result.Error = 'DataDir is required'
        return $result
    }

    $dataPath = $DataDir
    New-NegativeDirectory -Path $dataPath
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
        $result.Error = ('could not create the run data dir: ' + $dataPath)
        return $result
    }
    $dataPath = (Resolve-Path -LiteralPath $dataPath).Path

    # <app_data>/postgres/cluster is the dedicated cluster path; residue there is
    # "exists, non-empty, no postgresql.conf". The postmaster log lives in a
    # SIBLING (postgres/log) since Spec #3180, so nothing else is needed.
    $residueDir = Join-Path (Join-Path $dataPath 'postgres') 'cluster'
    New-NegativeDirectory -Path $residueDir
    $marker = Join-Path $residueDir 'postgresql.conf'
    if (Test-Path -LiteralPath $marker) {
        $result.Error = ('the seeded cluster dir already carries postgresql.conf (it would classify as a CLUSTER, not residue): ' + $residueDir)
        return $result
    }

    $residueFile = Join-Path $residueDir $LogName
    try {
        $stamp = (Get-Date).ToUniversalTime().ToString('o')
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($residueFile, ('fredo release-gate negative control residue ' + $stamp + "`r`n"), $encoding)
    } catch {
        $result.Error = ('could not seed the residue file: ' + $_.Exception.Message)
        return $result
    }

    if (-not (Test-Path -LiteralPath $residueFile -PathType Leaf)) {
        $result.Error = 'the residue file was not written'
        return $result
    }

    $result.Ok = $true
    $result.DataDir = $dataPath
    $result.ResidueDir = $residueDir
    $result.ResidueFile = $residueFile
    $result.Env = @{ 'FREDO_PG_CLUSTER_QUARANTINE_FAIL' = '1' }
    return $result
}

# ---- the control object -----------------------------------------------------

function New-NegativeControl {
    param(
        [ValidateSet('MissingDll', 'Csp', 'Database')]
        [string]$Leg,
        [string]$LegDir,
        [string]$ExtractedRoot = '',
        [string]$ExtractedExe = '',
        [string]$WindowHookPath = '',
        [string]$DataDir = '',
        [string]$DllName = $script:DefaultDllName
    )

    $expectation = Get-NegativeExpectation -Leg $Leg
    $control = [pscustomobject]@{
        Leg = $Leg
        Slug = $expectation.Slug
        LegDir = $LegDir
        Expected = @($expectation.Expected)
        Assertions = [string]$expectation.Assertions
        PrepareError = ''
        LaunchExe = ''
        CdpProbe = ''
        DataDir = ''
        LogDirHint = ''
        Env = @{}
        Notes = @($expectation.Notes)
        Evidence = [ordered]@{}
        Mutant = $null
    }

    if ([string]::IsNullOrWhiteSpace($LegDir)) {
        $control.PrepareError = 'LegDir is required'
        return $control
    }
    New-NegativeDirectory -Path $LegDir
    $control.LegDir = (Resolve-Path -LiteralPath $LegDir).Path

    switch ($Leg) {
        'MissingDll' {
            if ([string]::IsNullOrWhiteSpace($ExtractedRoot)) {
                $control.PrepareError = '-ExtractedRoot is required for the MissingDll leg'
                break
            }
            $mutant = New-NegativeMissingDllTree -ExtractedRoot $ExtractedRoot -LegDir $control.LegDir -ExtractedExe $ExtractedExe -DllName $DllName
            $control.Mutant = $mutant
            if (-not $mutant.Ok) {
                $control.PrepareError = $mutant.Error
                break
            }
            $control.LaunchExe = $mutant.LaunchExe
            $control.Evidence['payloadCopy'] = $mutant.CopyRoot
            $control.Evidence['deletedDll'] = $mutant.CopyDll
            $control.Evidence['sourceDll'] = $mutant.SourceDll
            $control.Evidence['sourceDllSha256'] = $mutant.SourceDllSha256After
            $control.Evidence['exe'] = $mutant.LaunchExe
        }
        'Csp' {
            try {
                $hook = New-NegativeCspHook -LegDir $control.LegDir -WindowHookPath $WindowHookPath
                $control.CdpProbe = $hook
                $control.Evidence['cspWrapperHook'] = $hook
            } catch {
                $control.PrepareError = $_.Exception.Message
            }
        }
        'Database' {
            if ([string]::IsNullOrWhiteSpace($DataDir)) {
                $control.PrepareError = '-DataDir is required for the Database leg'
                break
            }
            $residue = New-NegativeDatabaseResidue -DataDir $DataDir
            if (-not $residue.Ok) {
                $control.PrepareError = $residue.Error
                break
            }
            $control.DataDir = $residue.DataDir
            $control.LogDirHint = 'run-dirty'
            $control.Env = $residue.Env
            $control.Evidence['residueDir'] = $residue.ResidueDir
            $control.Evidence['residueFile'] = $residue.ResidueFile
            $control.Evidence['dataDir'] = $residue.DataDir
        }
    }

    return $control
}

function Complete-NegativeControl {
    param(
        $Control,
        [int]$GateExit,
        [string[]]$GateLines
    )

    if ($null -eq $Control) {
        Write-Host 'NEGATIVE_EXPECTED=<none>'
        Write-Host 'NEGATIVE_OBSERVED=<none>'
        Write-Host ('GATE_EXIT=' + $GateExit)
        Write-Host 'NEGATIVE_LEG_INSTRUMENT=<none>'
        Write-Host 'NEGATIVE_NOT_REPRODUCED'
        Write-Host 'NEGATIVE_CONTROL=NOT_REPRODUCED leg=<none>'
        return 1
    }

    $instrumentDetail = ''
    if ($null -ne $Control.PSObject.Properties['InstrumentDetail']) { $instrumentDetail = [string]$Control.InstrumentDetail }
    $outcome = Test-NegativeOutcome -Leg $Control.Leg -GateExit $GateExit -Lines $GateLines `
        -PrepareError $Control.PrepareError -InstrumentDetail $instrumentDetail

    Write-Host ('NEGATIVE_LEG=' + $Control.Leg)
    if ([string]::IsNullOrWhiteSpace($Control.PrepareError)) {
        Write-Host 'NEGATIVE_PREPARE=ok'
    } else {
        Write-Host ('NEGATIVE_PREPARE=failed:' + $Control.PrepareError)
    }
    if ([string]::IsNullOrWhiteSpace($instrumentDetail)) {
        Write-Host 'NEGATIVE_LEG_INSTRUMENT=ok'
    } else {
        Write-Host 'NEGATIVE_LEG_INSTRUMENT=FAIL'
    }
    Write-Host ('NEGATIVE_EXPECTED=' + $outcome.ExpectedText)
    Write-Host ('NEGATIVE_OBSERVED=' + $outcome.ObservedText)
    Write-Host ('GATE_EXIT=' + $GateExit)

    if ([string]::IsNullOrWhiteSpace($Control.LaunchExe)) {
        Write-Host 'NEGATIVE_LAUNCH_EXE=<none>'
    } else {
        Write-Host ('NEGATIVE_LAUNCH_EXE=' + $Control.LaunchExe)
    }
    if (-not [string]::IsNullOrWhiteSpace($Control.CdpProbe)) {
        Write-Host ('NEGATIVE_CDP_PROBE=' + $Control.CdpProbe)
    }
    if (-not [string]::IsNullOrWhiteSpace($Control.DataDir)) {
        Write-Host ('NEGATIVE_DATA_DIR=' + $Control.DataDir)
    }
    foreach ($name in @($Control.Env.Keys)) {
        Write-Host ('NEGATIVE_ENV=' + $name + '=' + [string]$Control.Env[$name])
    }

    if ($outcome.Ok) {
        Write-Host ('NEGATIVE_CONTROL=REPRODUCED leg=' + $Control.Leg)
        return 0
    }

    Write-Host ($outcome.Code + ' ' + $outcome.Detail)
    $verdict = 'NOT_REPRODUCED'
    if ($outcome.Code -eq 'NEGATIVE_WRONG_ERROR') { $verdict = 'WRONG_ERROR' }
    if ($outcome.Code -eq 'NEGATIVE_INSTRUMENT_FAILURE') { $verdict = 'INSTRUMENT_FAILURE' }
    Write-Host ('NEGATIVE_CONTROL=' + $verdict + ' leg=' + $Control.Leg)
    return 1
}

# ---- the harness entry point (the landed driver calls THIS) -----------------
# gate-release-artifact.ps1 -Mode negative imports this module and calls
#   Invoke-NegativeLeg -Name <leg> -Installer <abs> -OutDir <abs> -CdpPort <n>
#                      -WaitSecs <n> -DbReadySecs <n> -SkipCompanion:<bool>
#                      -SevenZip <path> -DriverPath <abs>
# expecting { Observed = <string[]>; GateExit = <int> }. The DRIVER owns the
# verdict (NEGATIVE_EXPECTED / NEGATIVE_OBSERVED / GATE_EXIT and the
# NEGATIVE_NOT_REPRODUCED / NEGATIVE_WRONG_ERROR classification), so this module
# only performs the leg and reports the ids the inner clauses emitted.
#
# There is no driver seam for a mutant exe, a wrapper probe or a data dir on its
# gate path, so a leg drives the SAME instruments the gate drives -
# verify-installer-payload.ps1 (extraction), launch-artifact-probe.ps1 (the only
# GUI launch primitive) and gate-artifact-window.ps1 (the clauses) - with the
# induced condition applied. The ids are the plan's section B ids, unchanged.

function Invoke-LegChild {
    param(
        [string]$InstrumentPath,
        [string[]]$Arguments,
        [string]$RunDir,
        [string]$Leaf
    )

    New-NegativeDirectory -Path $RunDir
    $outFile = Join-Path $RunDir ($Leaf + '.stdout.log')
    $errFile = Join-Path $RunDir ($Leaf + '.stderr.log')
    $quoted = New-Object System.Collections.ArrayList
    [void]$quoted.Add('-NoProfile')
    [void]$quoted.Add('-File')
    [void]$quoted.Add('"' + $InstrumentPath + '"')
    foreach ($argument in @($Arguments)) {
        $text = [string]$argument
        if ($text -match '\s') { $text = '"' + $text + '"' }
        [void]$quoted.Add($text)
    }
    Write-Host ('LEG_EXEC=' + (Split-Path -Leaf $InstrumentPath) + ' ' + (@($Arguments) -join ' '))

    # Spawn the instrument through the shared handle-whitelist helper (G-450) and
    # wait for THIS direct child only, so a grandchild cannot hold the caller's
    # pipe or keep the leg waiting. A non-zero exit is an EXPECTED, handled
    # outcome (the leg reads it), so it is captured, never thrown.
    $exit = $null
    $hostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    try {
        $childPid = Start-DetachedProcess -FilePath $hostExe -ArgumentString (@($quoted) -join ' ') -StdOutPath $outFile -StdErrPath $errFile
        $code = Wait-DetachedChild -ProcessId $childPid
        if ($null -ne $code) { $exit = [int]$code }
    } catch {
        $exit = $null
    }

    $lines = @()
    if (Test-Path -LiteralPath $outFile -PathType Leaf) {
        $lines = @(Get-Content -LiteralPath $outFile | ForEach-Object { [string]$_ })
    }
    foreach ($line in $lines) { Write-Host ('LEG| ' + $line) }
    return [pscustomobject]@{ Exit = $exit; Lines = $lines; StdOut = $outFile; StdErr = $errFile }
}

function Get-LegPayloadRoot {
    param([string[]]$Lines, [string]$Fallback)

    # A redirected PowerShell host still wraps a long stdout line at its buffer
    # width, so `EXTRACT_ROOT=<deep path>` can arrive as `EXTRACT_ROOT=` followed
    # by the rest of the path on the next line. Reassemble before trusting it,
    # and only ever return a directory that actually exists (an unusable value
    # falls through to the caller's fallback).
    $all = @()
    foreach ($line in @($Lines)) { $all += [string]$line }

    for ($index = 0; $index -lt $all.Count; $index++) {
        $text = $all[$index]
        $marker = $text.IndexOf('EXTRACT_ROOT=')
        if ($marker -lt 0) { continue }
        $value = $text.Substring($marker + 13).Trim()
        $candidates = New-Object System.Collections.ArrayList
        [void]$candidates.Add($value)
        if (($index + 1) -lt $all.Count) {
            $next = $all[$index + 1].Trim()
            if (-not [string]::IsNullOrWhiteSpace($next)) {
                [void]$candidates.Add($value + $next)
                [void]$candidates.Add($value + ' ' + $next)
            }
        }
        foreach ($candidate in $candidates) {
            $trimmed = ([string]$candidate).Trim()
            if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
            if (Test-Path -LiteralPath $trimmed -PathType Container) { return $trimmed }
        }
    }
    return $Fallback
}

function Get-LegChildTranscriptMarkers {
    # Any one of these proves the child reached its own param/body code and told
    # us something. A child that died in PowerShell's ARGUMENT BINDER prints
    # none of them: the binder fails before `param` processing completes.
    return @('RESULT', 'PID', 'HAS_EXITED', 'VERSION_', 'CONTROL_', 'EXTRACT_ROOT', 'CDP_', 'ERROR')
}

function Test-LegInstrumentFailed {
    param($Probe, [string]$Stage = 'instrument')

    $check = [pscustomobject]@{ Failed = $false; Detail = '' }

    if ($null -eq $Probe) {
        $check.Failed = $true
        $check.Detail = ($Stage + ': no child result')
        return $check
    }

    $hasTranscript = $false
    $refusedLine = ''
    foreach ($line in @($Probe.Lines)) {
        $text = ([string]$line).Trim()
        foreach ($marker in @(Get-LegChildTranscriptMarkers)) {
            if ($text.StartsWith($marker, [System.StringComparison]::Ordinal)) { $hasTranscript = $true; break }
        }
        # A probe that REFUSES its preconditions (RESULT=REFUSED) or reports
        # GATE_REFUSED never exercised the device under test, so it observed
        # nothing either -- round 4 (A5).
        if ($text -match '^RESULT=REFUSED\b') { $refusedLine = $text }
        elseif ($text -match '^GATE_REFUSED\b') { $refusedLine = $text }
    }

    $stderrText = ''
    if (-not [string]::IsNullOrWhiteSpace([string]$Probe.StdErr) -and (Test-Path -LiteralPath $Probe.StdErr -PathType Leaf)) {
        try { $stderrText = [string](Get-Content -LiteralPath $Probe.StdErr -Raw) } catch { $stderrText = '' }
    }
    $firstStderrLine = ''
    $binderStderrLine = ''
    foreach ($line in @($stderrText -split "`r?`n")) {
        $text = ([string]$line).Trim()
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        if ([string]::IsNullOrWhiteSpace($firstStderrLine)) { $firstStderrLine = $text }
        if ([string]::IsNullOrWhiteSpace($binderStderrLine) -and ($text -match 'Cannot convert value|Cannot process argument transformation|ParameterArgumentTransformationError')) {
            $binderStderrLine = $text
        }
    }
    if ($firstStderrLine.Length -gt 300) { $firstStderrLine = $firstStderrLine.Substring(0, 300) }
    if ($binderStderrLine.Length -gt 300) { $binderStderrLine = $binderStderrLine.Substring(0, 300) }

    # The 5.1 `-File` binder diagnostic. A leg that hits it observed nothing.
    $binder = (-not [string]::IsNullOrWhiteSpace($binderStderrLine)) -or ($stderrText -match 'ParameterArgumentTransformationError')

    if ($binder) {
        $detailLine = $binderStderrLine
        if ([string]::IsNullOrWhiteSpace($detailLine)) { $detailLine = $firstStderrLine }
        $check.Failed = $true
        $check.Detail = ($Stage + ': argument-binder-failure stderr=' + $detailLine)
        return $check
    }
    if (-not [string]::IsNullOrWhiteSpace($refusedLine)) {
        # A typed refusal (RESULT=REFUSED / GATE_REFUSED) is the instrument
        # declining its preconditions -- neither the device's pass nor its fail.
        $check.Failed = $true
        $check.Detail = ($Stage + ': refused ' + $refusedLine)
        return $check
    }
    if (-not $hasTranscript) {
        $childExit = 'unreadable'
        if ($null -ne $Probe.Exit) { $childExit = [string]$Probe.Exit }
        $detail = ($Stage + ': no usable transcript exit=' + $childExit)
        if (-not [string]::IsNullOrWhiteSpace($firstStderrLine)) { $detail = $detail + ' stderr=' + $firstStderrLine }
        $check.Failed = $true
        $check.Detail = $detail
        return $check
    }
    if ($null -eq $Probe.Exit) {
        # A transcript with an unreadable exit code is still not a verdict input.
        $check.Failed = $true
        $check.Detail = ($Stage + ': child exit code unreadable')
        return $check
    }
    return $check
}

function Set-LegInstrumentFailureDetail {
    param($Control, [string]$Detail)

    if ($null -eq $Control) { return $false }
    if ([string]::IsNullOrWhiteSpace($Detail)) { $Detail = 'instrument failure' }

    $Control.InstrumentFailed = $true
    $Control.InstrumentDetail = $Detail
    # A non-zero exit: the leg did NOT examine the device under test, so the
    # driver must not treat this as a passing observation either way.
    $Control.GateExit = 2
    $Control.Note = 'instrument failed: ' + $Detail
    $Control.Observed = @('NEGATIVE_INSTRUMENT_FAILURE:' + $Detail)
    Write-Host 'NEGATIVE_LEG_INSTRUMENT=FAIL'
    Write-Host ('NEGATIVE_INSTRUMENT_FAILURE:' + $Detail)
    return $true
}

function Set-LegInstrumentFailure {
    param($Control, $Probe, [string]$Stage = 'instrument')

    if ($null -eq $Control) { return $false }
    $check = Test-LegInstrumentFailed -Probe $Probe -Stage $Stage
    if (-not $check.Failed) { return $false }
    return (Set-LegInstrumentFailureDetail -Control $Control -Detail ([string]$check.Detail))
}

function Find-LegAppExe {
    param([string]$Root)

    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) { return '' }
    $hit = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter 'fredo.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $hit) { return $hit.FullName }
    return ''
}

function Invoke-NegativeLeg {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('MissingDll', 'Csp', 'Database')]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Installer,
        [Parameter(Mandatory = $true)]
        [string]$OutDir,
        [int]$CdpPort = 9333,
        [int]$WaitSecs = 90,
        [int]$DbReadySecs = 180,
        [switch]$SkipCompanion,
        [string]$SevenZip = '',
        [string]$DriverPath = '',
        [string]$InstrumentRoot = ''
    )

    $result = [pscustomobject]@{
        Leg = $Name
        Observed = @()
        GateExit = 0
        Note = ''
        LegDir = ''
        InnerExit = $null
        InstrumentFailed = $false
        InstrumentDetail = ''
    }

    $slug = Get-NegativeSlug $Name
    $outRoot = [System.IO.Path]::GetFullPath($OutDir)
    $legDir = Join-Path $outRoot ('negative-' + $slug)
    New-NegativeDirectory -Path $legDir
    $result.LegDir = $legDir
    Write-Host ('NEGATIVE_LEG=' + $Name)
    Write-Host ('NEGATIVE_LEG_DIR=' + $legDir)
    if (-not [string]::IsNullOrWhiteSpace($DriverPath)) { Write-Host ('NEGATIVE_LEG_DRIVER=' + $DriverPath) }
    if ($SkipCompanion) { Write-Host 'NEGATIVE_LEG_COMPANION=skipped' }

    # The instrument directory defaults to this module's directory. -InstrumentRoot
    # is a SELF-TEST seam only (the driver never passes it): it lets the hermetic
    # controls drive the real entry route against instruments that cannot bind,
    # which is the round-1 regression.
    $instruments = $PSScriptRoot
    if (-not [string]::IsNullOrWhiteSpace($InstrumentRoot)) {
        $instruments = (Resolve-Path -LiteralPath $InstrumentRoot).Path
    }

    # ONE form for the port list: the comma-joined specification. The probe's
    # -Ports parameter accepts one or more ports separated by , ; or whitespace
    # (a `[int[]]` parameter is unreachable from a -File invocation, which is the
    # round-1 defect); this module must never hand it any other shape.
    $portSpec = '9223,16932,19631'

    # ---- extraction (the gate's own instrument) ------------------------------
    $extractRoot = Join-Path $legDir 'installer-payload'
    $extractArgs = @('-Installer', $Installer, '-WorkDir', $extractRoot)
    if (-not [string]::IsNullOrWhiteSpace($SevenZip)) { $extractArgs += @('-SevenZip', $SevenZip) }
    $extract = Invoke-LegChild -InstrumentPath (Join-Path $instruments 'verify-installer-payload.ps1') `
        -Arguments $extractArgs -RunDir $legDir -Leaf 'extract'
    if (Set-LegInstrumentFailure -Control $result -Probe $extract -Stage 'extract') {
        $result.InnerExit = $extract.Exit
        Write-Host ('NEGATIVE_LEG_INNER_EXIT=' + $result.GateExit)
        Write-Host ('NEGATIVE_LEG_OBSERVED=' + ($result.Observed -join ','))
        return $result
    }
    $payloadRoot = Get-LegPayloadRoot -Lines $extract.Lines -Fallback $extractRoot
    $appExe = Find-LegAppExe -Root $payloadRoot
    if ($extract.Exit -ne 0 -or [string]::IsNullOrWhiteSpace($appExe)) {
        # The extraction instrument neither produced a payload nor (necessarily)
        # printed RESULT=REFUSED. It still observed nothing about the device, so
        # round 4 (A5) classifies it as an instrument failure -- never as
        # NOT_REPRODUCED (a refusal against the device) nor WRONG_ERROR.
        $extractExit = 'unreadable'
        if ($null -ne $extract.Exit) { $extractExit = [string]$extract.Exit }
        $detail = 'extract: refused exit=' + $extractExit
        if ([string]::IsNullOrWhiteSpace($appExe)) { $detail = $detail + ' (no fredo.exe)' }
        [void](Set-LegInstrumentFailureDetail -Control $result -Detail $detail)
        Write-Host ('NEGATIVE_LEG_EXTRACT=FAIL exit=' + $extractExit + ' root=' + $payloadRoot)
        Write-Host ('NEGATIVE_LEG_INNER_EXIT=' + $result.GateExit)
        Write-Host ('NEGATIVE_LEG_OBSERVED=' + ($result.Observed -join ','))
        return $result
    }
    Write-Host ('NEGATIVE_LEG_EXTRACT=ok exe=' + $appExe)

    $probePath = Join-Path $instruments 'launch-artifact-probe.ps1'
    $windowHook = Join-Path $instruments 'gate-artifact-window.ps1'

    switch ($Name) {
        'MissingDll' {
            $mutant = New-NegativeMissingDllTree -ExtractedRoot $payloadRoot -ExtractedExe $appExe -LegDir $legDir
            if (-not $mutant.Ok) {
                $result.GateExit = 1
                $result.Note = 'mutant preparation failed: ' + $mutant.Error
                Write-Host ('NEGATIVE_LEG_MUTANT=FAIL reason=' + $mutant.Error)
                break
            }
            Write-Host ('NEGATIVE_LEG_MUTANT=ok copy=' + $mutant.CopyRoot + ' deleted=' + $mutant.CopyDll + ' sourceSha=' + $mutant.SourceDllSha256After)
            Write-Host ('NEGATIVE_LEG_SOURCE_UNTOUCHED=' + ($mutant.SourceDllSha256Before -eq $mutant.SourceDllSha256After))
            $runDir = Join-Path $legDir 'run-load'
            $window = [Math]::Max(5, [Math]::Min(60, $WaitSecs))
            $probe = Invoke-LegChild -InstrumentPath $probePath -Arguments @(
                '-Exe', $mutant.LaunchExe,
                '-Ports', $portSpec,
                '-RequireClosed', '-SanitizePath',
                '-DataDir', $runDir, '-LogDir', $runDir,
                '-WaitSecs', [string]$window
            ) -RunDir $runDir -Leaf 'probe'
            $result.InnerExit = $probe.Exit
            if (Set-LegInstrumentFailure -Control $result -Probe $probe -Stage 'load') { break }
            $observed = @(Get-NegativeObservedErrorIds -Lines $probe.Lines)
            $exited = $false
            foreach ($line in @($probe.Lines)) {
                if ([string]$line -match 'HAS_EXITED=True') { $exited = $true }
            }
            # A4: the probe now reports the observed code as `EXIT_CODE=` from the
            # retained launch handle. Map it to the leg's expected id form when no
            # other id matched, so a genuine 0xC0000135 reproduces the leg.
            if ($exited -and $observed.Count -eq 0) {
                $exitId = Get-NegativeLaunchExitFromLines -Lines $probe.Lines
                if (-not [string]::IsNullOrWhiteSpace($exitId)) { $observed = @($exitId) }
            }
            if ($exited -and $observed.Count -gt 0) {
                $result.GateExit = 1
                Write-Host 'NEGATIVE_LEG_LOAD=exited'
            } elseif ($exited) {
                # The app exited inside the window but no code was readable. That
                # observed NOTHING about the load clause, so it is an INSTRUMENT
                # failure -- never `exited-without-code` folded into WRONG_ERROR.
                [void](Set-LegInstrumentFailureDetail -Control $result -Detail 'load: exit code unreadable')
                Write-Host 'NEGATIVE_LEG_LOAD=exit-code-unreadable'
                break
            } else {
                $result.GateExit = 0
                $result.Note = 'the app survived the window with the DLL removed'
                Write-Host 'NEGATIVE_LEG_LOAD=survived'
            }
            $result.Observed = @($observed)
        }
        'Csp' {
            $control = New-NegativeControl -Leg 'Csp' -LegDir $legDir -WindowHookPath $windowHook
            if (-not [string]::IsNullOrWhiteSpace($control.PrepareError)) {
                $result.GateExit = 1
                $result.Note = 'mutant preparation failed: ' + $control.PrepareError
                Write-Host ('NEGATIVE_LEG_MUTANT=FAIL reason=' + $control.PrepareError)
                break
            }
            Write-Host ('NEGATIVE_LEG_CDP_PROBE=' + $control.CdpProbe)
            $runDir = Join-Path $legDir 'run-csp'
            $window = [Math]::Max(30, [Math]::Min(300, $WaitSecs))
            $env:GATE_ASSERTIONS = [string]$control.Assertions
            $probe = Invoke-LegChild -InstrumentPath $probePath -Arguments @(
                '-Exe', $appExe,
                '-Ports', $portSpec,
                '-RequireClosed', '-SanitizePath',
                '-CdpPort', [string]$CdpPort,
                '-CdpProbe', $control.CdpProbe,
                '-DataDir', $runDir, '-LogDir', $runDir,
                '-WaitSecs', [string]$window
            ) -RunDir $runDir -Leaf 'probe'
            $result.InnerExit = $probe.Exit
            if (Set-LegInstrumentFailure -Control $result -Probe $probe -Stage 'csp') { break }
            $result.Observed = @(Get-NegativeObservedErrorIds -Lines $probe.Lines)
            $pair = 'partial'
            if (($result.Observed -contains 'CSP_VIOLATION') -and ($result.Observed -contains 'UNSTYLED')) { $pair = 'both' }
            Write-Host ('NEGATIVE_LEG_CSP_PAIR=' + $pair)
            if ($null -ne $probe.Exit -and $probe.Exit -ne 0 -and $result.Observed.Count -gt 0) {
                $result.GateExit = 1
            } elseif ($null -ne $probe.Exit -and $probe.Exit -ne 0) {
                $result.GateExit = [int]$probe.Exit
                $result.Note = 'the in-window hook failed without the expected id'
            } else {
                $result.GateExit = 0
                $result.Note = 'the in-window hook passed under the induced policy'
            }
        }
        'Database' {
            $dataDir = Join-Path $legDir 'run-dirty'
            $residue = New-NegativeDatabaseResidue -DataDir $dataDir
            if (-not $residue.Ok) {
                $result.GateExit = 1
                $result.Note = 'mutant preparation failed: ' + $residue.Error
                Write-Host ('NEGATIVE_LEG_MUTANT=FAIL reason=' + $residue.Error)
                break
            }
            Write-Host ('NEGATIVE_LEG_RESIDUE=' + $residue.ResidueFile)
            Write-Host ('NEGATIVE_LEG_SEAM=' + [string]$residue.Env['FREDO_PG_CLUSTER_QUARANTINE_FAIL'])
            $previous = [System.Environment]::GetEnvironmentVariable('FREDO_PG_CLUSTER_QUARANTINE_FAIL', 'Process')
            [System.Environment]::SetEnvironmentVariable('FREDO_PG_CLUSTER_QUARANTINE_FAIL', '1', 'Process')
            try {
                $window = [Math]::Max(60, [Math]::Min(300, $DbReadySecs + 30))
                $env:GATE_ASSERTIONS = 'database'
                $probe = Invoke-LegChild -InstrumentPath $probePath -Arguments @(
                    '-Exe', $appExe,
                    '-Ports', $portSpec,
                    '-RequireClosed', '-SanitizePath',
                    '-CdpPort', [string]$CdpPort,
                    '-CdpProbe', $windowHook,
                    '-DataDir', $residue.DataDir, '-LogDir', $residue.DataDir,
                    '-WaitSecs', [string]$window
                ) -RunDir $residue.DataDir -Leaf 'probe'
            } finally {
                [System.Environment]::SetEnvironmentVariable('FREDO_PG_CLUSTER_QUARANTINE_FAIL', $previous, 'Process')
            }
            $result.InnerExit = $probe.Exit
            # A4: the hook must name the EFFECTIVE PG data dir it observed. It
            # emits `DB_EFFECTIVE_DIR=<fresh|dirty>=<absolute path>`. Emit it for
            # evidence BEFORE the instrument classification, so even a hook that
            # refuses (GATE_REFUSED) leaves the dir it saw in the receipt.
            $effectiveDir = Get-NegativeEffectiveDirFromLines -Lines $probe.Lines
            if (-not [string]::IsNullOrWhiteSpace($effectiveDir)) {
                Write-Host ('NEGATIVE_LEG_EFFECTIVE_DIR=' + $effectiveDir)
            }
            if (Set-LegInstrumentFailure -Control $result -Probe $probe -Stage 'database') { break }
            # The probe sets FREDO_PG_DATA_DIR=<DataDir>\postgres\cluster, so a dir
            # that is absent (the clause never ran) or different (the seam did not
            # take) means the leg observed nothing about the seeded residue.
            $expectedEffective = [string]$residue.ResidueDir
            if ([string]::IsNullOrWhiteSpace($effectiveDir)) {
                [void](Set-LegInstrumentFailureDetail -Control $result -Detail ('database: DB_EFFECTIVE_DIR missing (expected ' + $expectedEffective + ')'))
                break
            }
            if (-not [string]::Equals($effectiveDir.TrimEnd('\', '/'), $expectedEffective.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
                [void](Set-LegInstrumentFailureDetail -Control $result -Detail ('database: DB_EFFECTIVE_DIR=' + $effectiveDir + ' expected=' + $expectedEffective))
                break
            }
            $result.Observed = @(Get-NegativeObservedErrorIds -Lines $probe.Lines)
            if ($null -ne $probe.Exit -and $probe.Exit -ne 0 -and $result.Observed.Count -gt 0) {
                $result.GateExit = 1
            } elseif ($null -ne $probe.Exit -and $probe.Exit -ne 0) {
                $result.GateExit = [int]$probe.Exit
                $result.Note = 'the in-window hook failed without DB_NOT_READY:dirty'
            } else {
                $result.GateExit = 0
                $result.Note = 'the profile still reached ready with the residue wedged'
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($result.Note)) { Write-Host ('NEGATIVE_LEG_NOTE=' + $result.Note) }
    Write-Host ('NEGATIVE_LEG_INNER_EXIT=' + $result.GateExit)
    $observedText = '<none>'
    if ($result.Observed.Count -gt 0) { $observedText = ($result.Observed -join ',') }
    Write-Host ('NEGATIVE_LEG_OBSERVED=' + $observedText)
    return $result
}

# ---- hermetic self-test -----------------------------------------------------

function Invoke-NegativeControlSelfTest {
    param([string]$WorkDir = '')

    $failures = New-Object System.Collections.ArrayList
    $count = 0

    function Write-NegativeControlResult {
        param([string]$Name, [bool]$Ok, [string]$Detail)
        if ($Ok) {
            Write-Host ('NEGATIVE_CONTROL ' + $Name + ' PASS   ' + $Detail)
        } else {
            Write-Host ('NEGATIVE_CONTROL ' + $Name + ' FAIL   ' + $Detail)
        }
    }

    $tempRoot = $WorkDir
    $ownedTemp = $false
    if ([string]::IsNullOrWhiteSpace($tempRoot)) {
        $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('fredo-negative-selftest-' + [Guid]::NewGuid().ToString('N'))
        $ownedTemp = $true
    }
    New-NegativeDirectory -Path $tempRoot
    $tempRoot = (Resolve-Path -LiteralPath $tempRoot).Path

    try {
        # 1-3: the binding expectation per leg.
        $count = $count + 1
        $expect = Get-NegativeExpectation -Leg 'MissingDll'
        $ok = ($expect.Expected.Count -eq 1 -and $expect.Expected[0] -eq 'LAUNCH_EXIT:-1073741515')
        Write-NegativeControlResult 'expectation-missingdll' $ok ('expected=' + ($expect.Expected -join ','))
        if (-not $ok) { [void]$failures.Add('expectation-missingdll') }

        $count = $count + 1
        $expect = Get-NegativeExpectation -Leg 'Csp'
        $ok = ($expect.Expected.Count -eq 2 -and $expect.Expected -contains 'CSP_VIOLATION' -and $expect.Expected -contains 'UNSTYLED')
        Write-NegativeControlResult 'expectation-csp' $ok ('expected=' + ($expect.Expected -join ',') + ' assertions=' + $expect.Assertions)
        if (-not $ok) { [void]$failures.Add('expectation-csp') }

        $count = $count + 1
        $expect = Get-NegativeExpectation -Leg 'Database'
        $ok = ($expect.Expected.Count -eq 1 -and $expect.Expected[0] -eq 'DB_NOT_READY:dirty')
        Write-NegativeControlResult 'expectation-database' $ok ('expected=' + ($expect.Expected -join ','))
        if (-not $ok) { [void]$failures.Add('expectation-database') }

        # 4: id extraction + the dword alias + the decoy.
        $count = $count + 1
        $sample = @(
            'VERDICT=FAIL',
            'LAUNCH_EXIT:3221225781',
            'UNSTYLED:screenshot-frame S4=false',
            'CSP_VIOLATION: 3 recorded',
            'DB_NOT_READY:dirty',
            'PAYLOAD_GATE=PASS'
        )
        $ids = @(Get-NegativeObservedErrorIds -Lines $sample)
        $ok = ($ids -contains 'LAUNCH_EXIT:-1073741515' -and $ids -contains 'CSP_VIOLATION' -and $ids -contains 'UNSTYLED' -and $ids -contains 'DB_NOT_READY:dirty' -and -not ($ids -contains 'PAYLOAD_GATE'))
        Write-NegativeControlResult 'observed-ids' $ok ('ids=' + ($ids -join ','))
        if (-not $ok) { [void]$failures.Add('observed-ids') }

        # 5: a gate that PASSED is never a reproduction.
        $count = $count + 1
        $outcome = Test-NegativeOutcome -Leg 'MissingDll' -GateExit 0 -Lines @('VERDICT=PASS')
        $ok = ((-not $outcome.Ok) -and $outcome.Code -eq 'NEGATIVE_NOT_REPRODUCED')
        Write-NegativeControlResult 'classify-not-reproduced' $ok ('code=' + $outcome.Code)
        if (-not $ok) { [void]$failures.Add('classify-not-reproduced') }

        # 6: a REFUSED inner run never counts as a reproduction.
        $count = $count + 1
        $outcome = Test-NegativeOutcome -Leg 'MissingDll' -GateExit 2 -Lines @('LAUNCH_EXIT:-1073741515')
        $ok = ((-not $outcome.Ok) -and $outcome.Code -eq 'NEGATIVE_NOT_REPRODUCED')
        Write-NegativeControlResult 'classify-refused' $ok ('exit=2 code=' + $outcome.Code)
        if (-not $ok) { [void]$failures.Add('classify-refused') }

        # 7: UNSTYLED alone (screenshot-frame) is the WRONG error for the Csp leg.
        $count = $count + 1
        $outcome = Test-NegativeOutcome -Leg 'Csp' -GateExit 1 -Lines @('CSP_VIOLATION: 2 recorded', 'UNSTYLED:screenshot-frame S4=false')
        $ok = ((-not $outcome.Ok) -and $outcome.Code -eq 'NEGATIVE_WRONG_ERROR')
        Write-NegativeControlResult 'classify-csp-screenshot-only' $ok ('code=' + $outcome.Code + ' detail=' + $outcome.Detail)
        if (-not $ok) { [void]$failures.Add('classify-csp-screenshot-only') }

        # 8: both ids fire -> reproduced.
        $count = $count + 1
        $outcome = Test-NegativeOutcome -Leg 'Csp' -GateExit 1 -Lines @('CHECK REQ-2.3 FAIL   rules=0 floor=1 injectedRules=0', 'UNSTYLED: injected style produced 0 rules', 'CSP_VIOLATION: 122 recorded: style-src')
        $ok = ($outcome.Ok -and $outcome.Code -eq '')
        Write-NegativeControlResult 'classify-csp-reproduced' $ok ('code=' + $outcome.Code + ' observed=' + $outcome.ObservedText)
        if (-not $ok) { [void]$failures.Add('classify-csp-reproduced') }

        # 9: the signed and unsigned dword both satisfy the MissingDll leg.
        $count = $count + 1
        $signedOutcome = Test-NegativeOutcome -Leg 'MissingDll' -GateExit 1 -Lines @('LAUNCH_EXIT:-1073741515')
        $aliasOutcome = Test-NegativeOutcome -Leg 'MissingDll' -GateExit 1 -Lines @('LAUNCH_EXIT:3221225781')
        $ok = ($signedOutcome.Ok -and $aliasOutcome.Ok)
        Write-NegativeControlResult 'classify-missingdll' $ok ('signed=' + $signedOutcome.Ok + ' alias=' + $aliasOutcome.Ok)
        if (-not $ok) { [void]$failures.Add('classify-missingdll') }

        # 10: Database reproduced only on DB_NOT_READY:dirty.
        $count = $count + 1
        $outcome = Test-NegativeOutcome -Leg 'Database' -GateExit 1 -Lines @('DB_NOT_READY:fresh', 'DB_NOT_READY:dirty')
        $freshOnly = Test-NegativeOutcome -Leg 'Database' -GateExit 1 -Lines @('DB_NOT_READY:fresh')
        $ok = ($outcome.Ok -and -not $freshOnly.Ok -and $freshOnly.Code -eq 'NEGATIVE_WRONG_ERROR')
        Write-NegativeControlResult 'classify-database' $ok ('dirty=' + $outcome.Ok + ' fresh-only=' + $freshOnly.Code)
        if (-not $ok) { [void]$failures.Add('classify-database') }

        # 11: the mutant copies, deletes from the COPY, leaves the source byte-identical.
        $count = $count + 1
        $fixtureRoot = Join-Path $tempRoot 'extracted'
        $fixtureSub = Join-Path $fixtureRoot 'resources'
        New-NegativeDirectory -Path $fixtureSub
        $fixtureEncoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText((Join-Path $fixtureRoot 'fredo.exe'), 'MZ gate-selftest fixture', $fixtureEncoding)
        [System.IO.File]::WriteAllText((Join-Path $fixtureRoot $script:DefaultDllName), 'PE gate-selftest payload dll', $fixtureEncoding)
        [System.IO.File]::WriteAllText((Join-Path $fixtureSub 'keep.txt'), 'sibling resource', $fixtureEncoding)
        $sourceDllHash = Get-NegativeSha256 -Path (Join-Path $fixtureRoot $script:DefaultDllName)
        $mutant = New-NegativeMissingDllTree -ExtractedRoot $fixtureRoot -LegDir (Join-Path $tempRoot 'leg-missing-dll')
        $ok = (
            $mutant.Ok -and
            (Test-Path -LiteralPath $mutant.LaunchExe -PathType Leaf) -and
            (-not (Test-Path -LiteralPath $mutant.CopyDll)) -and
            (Test-Path -LiteralPath (Join-Path $mutant.CopyRoot 'resources\keep.txt') -PathType Leaf) -and
            ((Get-NegativeSha256 -Path $mutant.SourceDll) -eq $sourceDllHash) -and
            ($mutant.SourceDllSha256Before -eq $mutant.SourceDllSha256After)
        )
        Write-NegativeControlResult 'mutant-copy' $ok ('copy=' + $mutant.CopyRoot + ' launch=' + $mutant.LaunchExe + ' sourceSha=' + $sourceDllHash)
        if (-not $ok) { [void]$failures.Add('mutant-copy') }

        # 12: a tree with no control DLL is a preparation FAILURE, never a pass.
        $count = $count + 1
        $emptyRoot = Join-Path $tempRoot 'no-dll'
        New-NegativeDirectory -Path $emptyRoot
        [System.IO.File]::WriteAllText((Join-Path $emptyRoot 'fredo.exe'), 'MZ gate-selftest fixture', $fixtureEncoding)
        $missing = New-NegativeMissingDllTree -ExtractedRoot $emptyRoot -LegDir (Join-Path $tempRoot 'leg-no-dll')
        $ok = (-not $missing.Ok -and -not [string]::IsNullOrWhiteSpace($missing.Error))
        Write-NegativeControlResult 'mutant-absent-dll' $ok ('error=' + $missing.Error)
        if (-not $ok) { [void]$failures.Add('mutant-absent-dll') }

        # 13: the DB residue is exactly <DataDir>/postgres/cluster/start.log.
        $count = $count + 1
        $dbDataDir = Join-Path $tempRoot 'db-data'
        $residue = New-NegativeDatabaseResidue -DataDir $dbDataDir
        $expectedResidue = Join-Path (Join-Path (Join-Path $dbDataDir 'postgres') 'cluster') 'start.log'
        $ok = (
            $residue.Ok -and
            (Test-Path -LiteralPath $expectedResidue -PathType Leaf) -and
            ((Get-Item -LiteralPath $expectedResidue).Length -gt 0) -and
            (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $expectedResidue) 'postgresql.conf'))) -and
            ([string]$residue.Env['FREDO_PG_CLUSTER_QUARANTINE_FAIL'] -eq '1')
        )
        Write-NegativeControlResult 'db-residue' $ok ('residue=' + $expectedResidue)
        if (-not $ok) { [void]$failures.Add('db-residue') }

        # 14: the Csp wrapper hook parses, carries the induced policy, is ASCII.
        $count = $count + 1
        $cspHook = New-NegativeCspHook -LegDir (Join-Path $tempRoot 'leg-csp')
        $hookText = ''
        $parseErrors = 99
        $nonAscii = 0
        if (Test-Path -LiteralPath $cspHook -PathType Leaf) {
            $hookText = [System.IO.File]::ReadAllText($cspHook)
            $tokens = $null
            $errors = $null
            $null = [System.Management.Automation.Language.Parser]::ParseFile($cspHook, [ref]$tokens, [ref]$errors)
            $parseErrors = @($errors).Count
            foreach ($character in $hookText.ToCharArray()) {
                if ([int]$character -gt 127) { $nonAscii = $nonAscii + 1 }
            }
        }
        $ok = (
            ($parseErrors -eq 0) -and
            ($nonAscii -eq 0) -and
            ($hookText.Contains('style-src ''self'' ''unsafe-inline'' ''nonce-fredo-gate-3181''')) -and
            ($hookText.Contains('Add-CdpNewDocumentScript')) -and
            ($hookText.Contains('gate-artifact-window.ps1')) -and
            # Measured facts: without the Page domain enabled the script is
            # accepted but never replayed; a document token is the only reliable
            # proof a reload produced a NEW document.
            ($hookText.Contains('Enable-CdpDomain -Session $session -Domain ''Page''')) -and
            ($hookText.Contains("typeof window.__fredoGateDocToken === 'undefined'")) -and
            ($hookText.Contains('CSP_INDUCTION=response-header')) -and
            ($hookText.Contains('CSP_FRAME=')) -and
            ($hookText.Contains('CSP_POLICY=not-applied'))
        )
        Write-NegativeControlResult 'csp-hook' $ok ('parseErrors=' + $parseErrors + ' nonAscii=' + $nonAscii + ' path=' + $cspHook)
        if (-not $ok) { [void]$failures.Add('csp-hook') }

        # 15: the committed revert overlay is the 'false' form and touches nothing else.
        $count = $count + 1
        $overlayPath = Join-Path $PSScriptRoot 'tauri.csp-revert.json'
        $overlayOk = $false
        $overlayDetail = 'overlay-not-found: ' + $overlayPath
        if (Test-Path -LiteralPath $overlayPath -PathType Leaf) {
            try {
                $overlay = Get-Content -LiteralPath $overlayPath -Raw | ConvertFrom-Json
                $securityKeys = @($overlay.app.security.PSObject.Properties.Name)
                $appKeys = @($overlay.app.PSObject.Properties.Name)
                $overlayOk = (
                    ($appKeys.Count -eq 1 -and $appKeys[0] -eq 'security') -and
                    ($securityKeys.Count -eq 1 -and $securityKeys[0] -eq 'dangerousDisableAssetCspModification') -and
                    ($overlay.app.security.dangerousDisableAssetCspModification -eq $false)
                )
                $overlayDetail = ('app=[' + ($appKeys -join ',') + '] security=[' + ($securityKeys -join ',') + '] value=' + $overlay.app.security.dangerousDisableAssetCspModification)
            } catch {
                $overlayDetail = 'overlay-unreadable: ' + $_.Exception.Message
            }
        }
        Write-NegativeControlResult 'overlay-equivalence' $overlayOk $overlayDetail
        if (-not $overlayOk) { [void]$failures.Add('overlay-equivalence') }

        # 16: the HARNESS entry point refuses a bad installer instead of throwing
        #     or passing. The driver calls exactly this signature, so the leg's
        #     fail-closed path is proven on the entry route (not only on helpers).
        $count = $count + 1
        $invokeOk = $false
        $invokeDetail = ''
        try {
            $missingInstaller = Join-Path $tempRoot 'no-such-installer.exe'
            $legResult = Invoke-NegativeLeg -Name 'MissingDll' -Installer $missingInstaller `
                -OutDir (Join-Path $tempRoot 'invoke-leg') -CdpPort 9449 -WaitSecs 5 -DbReadySecs 5 -SkipCompanion
            $invokeOk = (
                ($null -ne $legResult) -and
                ($null -ne $legResult.PSObject.Properties['Observed']) -and
                ($null -ne $legResult.PSObject.Properties['GateExit']) -and
                ($legResult.GateExit -ne 0) -and
                ($legResult.InstrumentFailed -eq $true) -and
                ([string]$legResult.InstrumentDetail -match '^extract: refused exit=2') -and
                (@($legResult.Observed).Count -eq 1) -and
                ([string]$legResult.Observed[0]).StartsWith('NEGATIVE_INSTRUMENT_FAILURE:') -and
                (Test-Path -LiteralPath (Join-Path $tempRoot 'invoke-leg\negative-missing-dll'))
            )
            $invokeDetail = 'exit=' + $legResult.GateExit + ' instrument=' + $legResult.InstrumentDetail + ' observed=' + (@($legResult.Observed) -join '|') + ' note=' + $legResult.Note
        } catch {
            $invokeDetail = 'threw: ' + $_.Exception.Message
        }
        Write-NegativeControlResult 'invoke-leg-refuses-bad-installer' $invokeOk $invokeDetail
        if (-not $invokeOk) { [void]$failures.Add('invoke-leg-refuses-bad-installer') }

        # 17: AN UNRUNNABLE INSTRUMENT IS ITS OWN CLASS (round-2 fix). Two
        #     discriminating shapes are driven through the REAL entry route with a
        #     stubbed instrument root, so nothing about the device under test is
        #     guessed:
        #       (a) the load child prints NOTHING and exits non-zero  -> the
        #           round-1 binder death (no usable transcript);
        #       (b) the load child prints a healthy transcript AND the binder text
        #           on stderr -> the stderr signal alone must classify it.
        #     In both, the leg must report NEGATIVE_LEG_INSTRUMENT=FAIL, return
        #     the NEGATIVE_INSTRUMENT_FAILURE outcome id, and observe NOTHING.
        $count = $count + 1
        $instrumentDetail = ''
        $instrumentOk = $true
        try {
            $fixturePayload = Join-Path $tempRoot 'inst-payload'
            New-NegativeDirectory -Path $fixturePayload
            $fixtureEncoding2 = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText((Join-Path $fixturePayload 'fredo.exe'), 'MZ gate-selftest fixture', $fixtureEncoding2)
            [System.IO.File]::WriteAllText((Join-Path $fixturePayload $script:DefaultDllName), 'PE gate-selftest payload dll', $fixtureEncoding2)

            $verifierStub = @(
                '# selftest stub: extraction succeeds on the fixture tree',
                "Write-Output ('EXTRACT_ROOT=' + '" + $fixturePayload + "')",
                "Write-Output 'RESULT=PASS'",
                'exit 0'
            ) -join "`r`n"

            $silentProbeStub = @(
                '# selftest stub: the round-1 shape - the child dies before printing',
                'exit 1'
            ) -join "`r`n"

            $binderProbeStub = @(
                '# selftest stub: a usable transcript AND the binder diagnostic',
                "Write-Output 'PID=4242'",
                "Write-Output 'RESULT=PASS'",
                "Write-Output 'HAS_EXITED=False'",
                "[Console]::Error.WriteLine('Cannot convert value ""9223,16932,19631"" to type ""System.Int32[]"".')",
                'exit 0'
            ) -join "`r`n"

            $variants = @(
                [pscustomobject]@{ Name = 'silent-exit-1'; Probe = $silentProbeStub },
                [pscustomobject]@{ Name = 'transcript-plus-binder-stderr'; Probe = $binderProbeStub }
            )

            foreach ($variant in $variants) {
                $instrumentRoot = Join-Path $tempRoot ('inst-' + $variant.Name)
                New-NegativeDirectory -Path $instrumentRoot
                [System.IO.File]::WriteAllText((Join-Path $instrumentRoot 'verify-installer-payload.ps1'), $verifierStub, $fixtureEncoding2)
                [System.IO.File]::WriteAllText((Join-Path $instrumentRoot 'launch-artifact-probe.ps1'), $variant.Probe, $fixtureEncoding2)

                $captured = @(& {
                    Invoke-NegativeLeg -Name 'MissingDll' -Installer (Join-Path $tempRoot 'stub-installer.exe') `
                        -OutDir (Join-Path $tempRoot ('inst-leg-' + $variant.Name)) `
                        -CdpPort 9449 -WaitSecs 5 -DbReadySecs 5 -SkipCompanion `
                        -InstrumentRoot $instrumentRoot
                } 6>&1)
                $legResult = $captured | Where-Object { $null -ne $_.PSObject.Properties['GateExit'] } | Select-Object -First 1
                $logText = (@($captured) | ForEach-Object { [string]$_ }) -join "`n"

                $observed = @()
                if ($null -ne $legResult) { $observed = @($legResult.Observed) }
                $observedIsInstrumentId = ($observed.Count -eq 1) -and ([string]$observed[0]).StartsWith('NEGATIVE_INSTRUMENT_FAILURE:')
                $noObservationIds = -not (
                    ($observed -contains 'LAUNCH_EXIT:-1073741515') -or
                    ($observed -contains 'CSP_VIOLATION') -or
                    ($observed -contains 'UNSTYLED') -or
                    ($observed -contains 'DB_NOT_READY:dirty')
                )
                $variantOk = (
                    ($null -ne $legResult) -and
                    ($legResult.InstrumentFailed -eq $true) -and
                    (-not [string]::IsNullOrWhiteSpace([string]$legResult.InstrumentDetail)) -and
                    ($legResult.GateExit -ne 0) -and
                    $observedIsInstrumentId -and
                    $noObservationIds -and
                    ($logText.Contains('NEGATIVE_LEG_INSTRUMENT=FAIL')) -and
                    ($logText.Contains('NEGATIVE_INSTRUMENT_FAILURE:')) -and
                    (-not $logText.Contains('NEGATIVE_LEG_LOAD='))
                )
                $instrumentDetail = $instrumentDetail + ('[' + $variant.Name + ' failed=' + $legResult.InstrumentFailed + ' exit=' + $legResult.GateExit + ' observed=' + ($observed -join '|') + ' literal=' + $logText.Contains('NEGATIVE_LEG_INSTRUMENT=FAIL') + '] ')
                if (-not $variantOk) { $instrumentOk = $false }
            }
        } catch {
            $instrumentOk = $false
            $instrumentDetail = $instrumentDetail + 'threw: ' + $_.Exception.Message
        }
        Write-NegativeControlResult 'leg-instrument-failure' $instrumentOk $instrumentDetail
        if (-not $instrumentOk) { [void]$failures.Add('leg-instrument-failure') }

        # 18: NON-VACUITY + PRECEDENCE. The same canonical observation sets that
        #     reproduce each leg (control 8/9/10) must still reproduce when no
        #     instrument detail is present, and the SAME sets must be reclassified
        #     as NEGATIVE_INSTRUMENT_FAILURE (never NOT_REPRODUCED / WRONG_ERROR)
        #     the moment an instrument detail is supplied - at GateExit 0 and 1.
        $count = $count + 1
        $precedenceOk = $true
        $precedenceDetail = ''
        $canonical = @(
            @{ Leg = 'MissingDll'; Exit = 1; Lines = @('LAUNCH_EXIT:-1073741515') },
            @{ Leg = 'Csp'; Exit = 1; Lines = @('UNSTYLED: injected style produced 0 rules', 'CSP_VIOLATION: 113 recorded') },
            @{ Leg = 'Database'; Exit = 1; Lines = @('DB_NOT_READY:dirty') }
        )
        foreach ($case in $canonical) {
            $reproduced = Test-NegativeOutcome -Leg $case.Leg -GateExit $case.Exit -Lines $case.Lines
            foreach ($exitValue in @(0, 1)) {
                $failed = Test-NegativeOutcome -Leg $case.Leg -GateExit $exitValue -Lines $case.Lines -InstrumentDetail 'load: no usable transcript exit=1'
                $ok = (
                    ($reproduced.Ok -eq $true) -and
                    ($reproduced.Code -eq '') -and
                    ($failed.Ok -eq $false) -and
                    ($failed.Code -eq 'NEGATIVE_INSTRUMENT_FAILURE') -and
                    ($failed.Code -ne 'NEGATIVE_NOT_REPRODUCED') -and
                    ($failed.Code -ne 'NEGATIVE_WRONG_ERROR')
                )
            }
            if (-not $ok) { $precedenceOk = $false }
            $precedenceDetail = $precedenceDetail + ('[' + $case.Leg + ' reproduced=' + $reproduced.Ok + ' instrument=' + $failed.Code + '] ')
        }
        Write-NegativeControlResult 'classify-instrument-precedence' $precedenceOk $precedenceDetail
        if (-not $precedenceOk) { [void]$failures.Add('classify-instrument-precedence') }

        # 19: CSP-ABS-POWERSHELL (round 4, A5). The generated wrapper must spawn
        #     the real hook through the ABSOLUTE host: under the sanitised PATH a
        #     bare `powershell` does not resolve, which used to kill the Csp leg's
        #     instrument. The absence needle is built by concatenation so this
        #     assertion's own text is not the needle it searches for.
        $count = $count + 1
        $cspAbsDetail = ''
        $cspAbsOk = $false
        try {
            $absHost = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $absHook = New-NegativeCspHook -LegDir (Join-Path $tempRoot 'leg-csp-abs')
            $absText = [System.IO.File]::ReadAllText($absHook)
            $bareHookNeedle = '& ' + 'powershell '
            $bareHookFileNeedle = '& ' + 'powershell -NoProfile -File'
            $cspAbsOk = (
                ($absText.Contains($absHost)) -and
                (-not $absText.Contains($bareHookNeedle)) -and
                (-not $absText.Contains($bareHookFileNeedle)) -and
                ($absText.Contains('CSP_POLICY_HOOK_EXIT=')) -and
                ($absText.Contains('CSP_INSTRUMENT=FAIL reason='))
            )
            $cspAbsDetail = 'absolute=' + $absText.Contains($absHost) + ' bare=' + $absText.Contains($bareHookNeedle) + ' host=' + $absHost
        } catch {
            $cspAbsDetail = 'threw: ' + $_.Exception.Message
        }
        Write-NegativeControlResult 'CSP-ABS-POWERSHELL' $cspAbsOk $cspAbsDetail
        if (-not $cspAbsOk) { [void]$failures.Add('CSP-ABS-POWERSHELL') }

        # 20: NEGATIVE-EXIT-CODE-MAP (round 4, A4). The probe's observed
        #     `EXIT_CODE=` must become the MissingDll leg's `LAUNCH_EXIT:<signed>`
        #     id, and the unsigned dword alias must normalise to the same value.
        $count = $count + 1
        $mapSigned = Get-NegativeLaunchExitFromLines -Lines @('HAS_EXITED=True', 'EXIT_CODE=-1073741515')
        $mapAlias = Get-NegativeLaunchExitFromLines -Lines @('HAS_EXITED=True', 'EXIT_CODE=3221225781')
        $mapSpaced = Get-NegativeLaunchExitFromLines -Lines @('EXIT_CODE= 42 ')
        $mapNone = Get-NegativeLaunchExitFromLines -Lines @('HAS_EXITED=False')
        $mapOutcome = Test-NegativeOutcome -Leg 'MissingDll' -GateExit 1 -Lines @($mapSigned)
        $mapOk = (
            ($mapSigned -eq 'LAUNCH_EXIT:-1073741515') -and
            ($mapAlias -eq 'LAUNCH_EXIT:-1073741515') -and
            ($mapSpaced -eq 'LAUNCH_EXIT:42') -and
            ([string]::IsNullOrEmpty($mapNone)) -and
            ($mapOutcome.Ok -eq $true)
        )
        Write-NegativeControlResult 'NEGATIVE-EXIT-CODE-MAP' $mapOk ('signed=' + $mapSigned + ' alias=' + $mapAlias + ' spaced=' + $mapSpaced + ' none=[' + $mapNone + '] reproduced=' + $mapOutcome.Ok)
        if (-not $mapOk) { [void]$failures.Add('NEGATIVE-EXIT-CODE-MAP') }

        # 21: EXTRACT-REFUSAL-INSTRUMENT (round 4, A5). A refusal in the child's
        #     transcript is an instrument failure, and the REAL entry route marks
        #     an extraction refusal as InstrumentFailed with an `extract:` detail.
        $count = $count + 1
        $extractOk = $false
        $extractDetail = ''
        try {
            $refusedProbe = [pscustomobject]@{ Exit = 2; Lines = @('ERROR: missing installer', 'RESULT=REFUSED'); StdOut = ''; StdErr = '' }
            $refusedCheck = Test-LegInstrumentFailed -Probe $refusedProbe -Stage 'extract'
            $gateRefusedProbe = [pscustomobject]@{ Exit = 2; Lines = @('GATE_REFUSED reason=bad-args'); StdOut = ''; StdErr = '' }
            $gateRefusedCheck = Test-LegInstrumentFailed -Probe $gateRefusedProbe -Stage 'extract'

            $refuseRoot = Join-Path $tempRoot 'inst-extract-refused'
            New-NegativeDirectory -Path $refuseRoot
            $refuseEncoding = New-Object System.Text.UTF8Encoding($false)
            $refuseVerifier = @(
                '# selftest stub: extraction refuses its preconditions',
                "Write-Output 'ERROR: missing installer'",
                "Write-Output 'RESULT=REFUSED'",
                'exit 2'
            ) -join "`r`n"
            $refuseProbeStub = @(
                '# selftest stub: never reached',
                'exit 1'
            ) -join "`r`n"
            [System.IO.File]::WriteAllText((Join-Path $refuseRoot 'verify-installer-payload.ps1'), $refuseVerifier, $refuseEncoding)
            [System.IO.File]::WriteAllText((Join-Path $refuseRoot 'launch-artifact-probe.ps1'), $refuseProbeStub, $refuseEncoding)

            $captured = @(& {
                Invoke-NegativeLeg -Name 'MissingDll' -Installer (Join-Path $tempRoot 'stub-installer.exe') `
                    -OutDir (Join-Path $tempRoot 'extract-refuse-leg') `
                    -CdpPort 9449 -WaitSecs 5 -DbReadySecs 5 -SkipCompanion `
                    -InstrumentRoot $refuseRoot
            } 6>&1)
            $refuseLeg = $captured | Where-Object { $null -ne $_.PSObject.Properties['GateExit'] } | Select-Object -First 1
            $extractOk = (
                ($refusedCheck.Failed -eq $true) -and
                ($refusedCheck.Detail -match 'refused') -and
                ($gateRefusedCheck.Failed -eq $true) -and
                ($gateRefusedCheck.Detail -match 'refused') -and
                ($null -ne $refuseLeg) -and
                ($refuseLeg.InstrumentFailed -eq $true) -and
                ([string]$refuseLeg.InstrumentDetail -match '^extract: refused') -and
                (@($refuseLeg.Observed).Count -eq 1) -and
                ([string]$refuseLeg.Observed[0]).StartsWith('NEGATIVE_INSTRUMENT_FAILURE:')
            )
            $extractDetail = 'direct=' + $refusedCheck.Failed + ' gate=' + $gateRefusedCheck.Failed + ' leg=' + $refuseLeg.InstrumentDetail
        } catch {
            $extractDetail = 'threw: ' + $_.Exception.Message
        }
        Write-NegativeControlResult 'EXTRACT-REFUSAL-INSTRUMENT' $extractOk $extractDetail
        if (-not $extractOk) { [void]$failures.Add('EXTRACT-REFUSAL-INSTRUMENT') }

        # 22: DB-EFFECTIVE-DIR-PARSE (round 4, A4). The hook reports the effective
        #     dir as `DB_EFFECTIVE_DIR=<fresh|dirty>=<path>`; the leg must compare
        #     the PATH, never the profiled string, or every Database leg would
        #     instrument-fail on a perfectly isolated profile.
        $count = $count + 1
        $dirtyPath = 'C:\run\postgres\cluster'
        $parsedDirty = Get-NegativeEffectiveDirFromLines -Lines @(('DB_EFFECTIVE_DIR=dirty=' + $dirtyPath), 'DB_ISOLATION=isolated')
        $parsedFresh = Get-NegativeEffectiveDirFromLines -Lines @('DB_EFFECTIVE_DIR=fresh=C:\run2\postgres\cluster')
        $parsedBare = Get-NegativeEffectiveDirFromLines -Lines @('DB_EFFECTIVE_DIR=C:\run3\postgres\cluster')
        $parsedNone = Get-NegativeEffectiveDirFromLines -Lines @('DB_ISOLATION=isolated')
        $dbParseOk = (
            ($parsedDirty -eq $dirtyPath) -and
            ($parsedFresh -eq 'C:\run2\postgres\cluster') -and
            ($parsedBare -eq 'C:\run3\postgres\cluster') -and
            ([string]::IsNullOrEmpty($parsedNone))
        )
        Write-NegativeControlResult 'DB-EFFECTIVE-DIR-PARSE' $dbParseOk ('dirty=' + $parsedDirty + ' fresh=' + $parsedFresh + ' bare=' + $parsedBare + ' none=[' + $parsedNone + ']')
        if (-not $dbParseOk) { [void]$failures.Add('DB-EFFECTIVE-DIR-PARSE') }

        # 23: CSP-INDUCTION-NOT-DOCUMENT-WRITE (round 5). The induction must be a
        #     RESPONSE HEADER through the Fetch domain, never a start-of-document
        #     write into the parser stream. The absence needle is built by
        #     concatenation so this control's own source is not the needle it
        #     searches for. The pure helpers are asserted on fixtures: entity
        #     headers dropped, the requested header replaced (never doubled),
        #     everything else preserved, and a TEXT body base64-encoded.
        $count = $count + 1
        $inductionOk = $false
        $inductionDetail = ''
        try {
            $inductionHook = New-NegativeCspHook -LegDir (Join-Path $tempRoot 'leg-csp-induction')
            $inductionText = [System.IO.File]::ReadAllText($inductionHook)
            $parserWriteNeedle = 'document' + '.write'
            $policyText = Get-NegativeCspPolicy
            $seedText = Get-NegativeCspSeedScript

            $fixtureHeaders = @(
                [pscustomobject]@{ name = 'Content-Type'; value = 'text/html; charset=utf-8' },
                [pscustomobject]@{ name = 'Content-Encoding'; value = 'gzip' },
                [pscustomobject]@{ name = 'Content-Length'; value = '1234' },
                [pscustomobject]@{ name = 'Transfer-Encoding'; value = 'chunked' },
                [pscustomobject]@{ name = 'Content-Security-Policy'; value = "style-src 'unsafe-inline'" }
            )
            $built = @(Add-CdpResponseHeader -ResponseHeaders $fixtureHeaders -Name 'Content-Security-Policy' -Value $policyText)
            $policyHeaders = @($built | Where-Object { ([string]$_.name).ToLowerInvariant() -eq 'content-security-policy' })
            $entityGone = $true
            foreach ($entry in @($built)) {
                $lower = ([string]$entry.name).ToLowerInvariant()
                if ($lower -eq 'content-encoding' -or $lower -eq 'content-length' -or $lower -eq 'transfer-encoding') { $entityGone = $false }
            }
            $typeKept = @($built | Where-Object { ([string]$_.name).ToLowerInvariant() -eq 'content-type' }).Count -eq 1
            $singlePolicy = (($policyHeaders.Count -eq 1) -and ([string]$policyHeaders[0].value -eq $policyText))

            $expectedBody = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('<html></html>'))
            $textBody = Get-CdpFulfillBody -BodyResult ([pscustomobject]@{ body = '<html></html>'; base64Encoded = $false })
            $rawBody = Get-CdpFulfillBody -BodyResult ([pscustomobject]@{ body = 'PGh0bWw+'; base64Encoded = $true })
            $noBody = Get-CdpFulfillBody -BodyResult ([pscustomobject]@{ base64Encoded = $false })

            $inductionOk = (
                (-not $inductionText.Contains($parserWriteNeedle)) -and
                (-not $seedText.Contains($parserWriteNeedle)) -and
                ($inductionText.Contains('Fetch.enable')) -and
                ($inductionText.Contains('Invoke-CdpFetchServe')) -and
                ($inductionText.Contains('CSP_INDUCTION=response-header')) -and
                ($inductionText.Contains($policyText)) -and
                ($seedText.Contains('__fredoGate')) -and
                $entityGone -and $typeKept -and $singlePolicy -and
                ($textBody -eq $expectedBody) -and
                ($rawBody -eq 'PGh0bWw+') -and
                ($null -eq $noBody)
            )
            $inductionDetail = 'parserWrite=' + $inductionText.Contains($parserWriteNeedle) + ' fetchEnable=' + $inductionText.Contains('Fetch.enable') + ' serve=' + $inductionText.Contains('Invoke-CdpFetchServe') + ' policyHeaders=' + $policyHeaders.Count + ' entityGone=' + $entityGone + ' typeKept=' + $typeKept + ' textBody=' + ($textBody -eq $expectedBody)
        } catch {
            $inductionDetail = 'threw: ' + $_.Exception.Message
        }
        Write-NegativeControlResult 'CSP-INDUCTION-NOT-DOCUMENT-WRITE' $inductionOk $inductionDetail
        if (-not $inductionOk) { [void]$failures.Add('CSP-INDUCTION-NOT-DOCUMENT-WRITE') }
    } finally {
        if ($ownedTemp) { Remove-NegativeTree -Path $tempRoot }
    }

    Write-Host ('NEGATIVE_CONTROLS=' + $count + ' FAILURES=' + $failures.Count)
    if ($failures.Count -eq 0) {
        Write-Host 'NEGATIVE_MODULE_SELFTEST: PASS'
        return 0
    }
    Write-Host 'NEGATIVE_MODULE_SELFTEST: FAIL'
    return 1
}

Export-ModuleMember -Function @(
    'Invoke-NegativeLeg',
    'Get-NegativeSlug',
    'Get-NegativeExpectation',
    'Get-NegativeObservedErrorIds',
    'Test-NegativeOutcome',
    'Test-LegInstrumentFailed',
    'New-NegativeMissingDllTree',
    'Get-NegativeCspPolicy',
    'Get-NegativeCspSeedScript',
    'New-NegativeCspHook',
    'New-NegativeDatabaseResidue',
    'New-NegativeControl',
    'Complete-NegativeControl',
    'Invoke-NegativeControlSelfTest'
)
