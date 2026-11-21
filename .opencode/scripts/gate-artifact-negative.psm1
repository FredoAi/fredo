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
  Csp         The 0.2.3 condition is induced in the LIVE document: a
              nonce-bearing `style-src` policy is installed with
              Page.addScriptToEvaluateOnNewDocument and the page reloaded. A
              nonce in style-src voids 'unsafe-inline', so Chakra/emotion's
              runtime <style> elements are refused and a normal injected <style>
              yields 0 rules. The inner gate must report BOTH
              `CSP_VIOLATION:<detail>` AND `UNSTYLED:<detail>`; UNSTYLED alone
              means the detector did not reproduce the 0.2.3 mechanism.
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
    NEGATIVE_EXPECTED=<id[,id]>
    NEGATIVE_OBSERVED=<id[,id]>            (<none> when nothing fired)
    GATE_EXIT=<n>
    NEGATIVE_CONTROL=REPRODUCED|NOT_REPRODUCED|WRONG_ERROR leg=<leg>
    NEGATIVE_NOT_REPRODUCED | NEGATIVE_WRONG_ERROR   (on failure)

Exit contract (mirrors the harness, plan section C)
    0  reproduced - the inner gate exited non-zero AND emitted every expected id
    1  NOT reproduced (the inner gate passed, or refused with exit 2/3) or the
       wrong id fired (`NEGATIVE_WRONG_ERROR`)

Driver dispatch contract (gate-release-artifact.ps1 -Mode negative)
  This module owns the LEG MECHANICS only; the driver keeps every process
  orchestration (extraction, launch, receipt). One leg is two calls:

      Import-Module (Join-Path $PSScriptRoot 'gate-artifact-negative.psm1') -Force

      $control = New-NegativeControl -Leg $Negative `
                    -LegDir (Join-Path $OutDir ('negative-' + (Get-NegativeSlug $Negative))) `
                    -ExtractedRoot $extractedPayloadRoot `
                    -CdpPort $CdpPort `
                    -DataDir $negativeDataDir `
                    -WindowHookPath (Join-Path $PSScriptRoot 'gate-artifact-window.ps1')

      # Apply $control.Env to the child environment when it is non-empty, e.g.
      #   foreach ($name in @($control.Env.Keys)) { Set-Item -Path "Env:$name" -Value ([string]$control.Env[$name]) }
      # Then run the NORMAL gate with the control's overrides:
      #   - $control.LaunchExe  -> launch THIS exe instead of the extracted one
      #                            (MissingDll)
      #   - $control.CdpProbe   -> pass as the probe's -CdpProbe hook (Csp)
      #   - $control.Assertions -> pass as the probe's -Assertions value (Csp: styled)
      #   - $control.DataDir    -> pass as the probe's -DataDir (Database)
      # Capture the inner gate's stdout lines and exit code.
      exit (Complete-NegativeControl -Control $control -GateExit $code -GateLines $lines)

  New-NegativeControl NEVER mutates the tree it is handed: MissingDll copies
  first, and every leg writes only under -LegDir.

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
                Assertions = 'styled'
                Notes = @('induce a nonce-bearing style-src policy on new documents; both ids MUST fire (UNSTYLED alone is NEGATIVE_WRONG_ERROR)')
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

function Test-NegativeOutcome {
    param(
        [string]$Leg,
        [int]$GateExit,
        [string[]]$Lines,
        [string]$PrepareError = ''
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

function Get-NegativeCspPolicyScript {
    # The induced 0.2.3 condition. A nonce in style-src voids 'unsafe-inline',
    # so emotion's runtime <style> elements (and a normally injected <style>)
    # are refused. Only style-src is constrained: the rest of the document keeps
    # its shipped policy, so the leg demonstrates the styling mechanism alone.
    return @'
(function () {
  try {
    if (window.__fredoGateCspInduced) { return true; }
    window.__fredoGateCspInduced = true;
    var policy = "style-src 'nonce-fredo-gate-3181'";
    function install() {
      try {
        var root = document.head || document.documentElement;
        if (!root) { return false; }
        if (document.querySelector('meta[data-fredo-gate-csp="1"]')) { return true; }
        var meta = document.createElement('meta');
        meta.setAttribute('http-equiv', 'Content-Security-Policy');
        meta.setAttribute('data-fredo-gate-csp', '1');
        meta.setAttribute('content', policy);
        root.appendChild(meta);
        return true;
      } catch (error) { return false; }
    }
    if (install()) { return true; }
    try {
      document.write('<meta http-equiv="Content-Security-Policy" data-fredo-gate-csp="1" content="style-src \'nonce-fredo-gate-3181\'">');
      return true;
    } catch (error) { }
    return false;
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

    $hookPath = (Resolve-Path -LiteralPath $WindowHookPath).Path
    $modulePath = (Resolve-Path -LiteralPath $CdpModulePath).Path
    New-NegativeDirectory -Path $LegDir

    $policy = Get-NegativeCspPolicyScript
    $quote = [char]39
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('# csp-wrapper-hook.ps1 - GENERATED by gate-artifact-negative.psm1 (Spec #3181 ST-4).')
    [void]$lines.Add('# The Csp negative leg. It installs a nonce-bearing style-src policy on every')
    [void]$lines.Add('# new document, keeps this DevTools session open, and only then runs the real')
    [void]$lines.Add('# in-window hook, so the hook measures a document the 0.2.3 condition governs.')
    [void]$lines.Add('# Do not edit: regenerate with New-NegativeCspHook.')
    [void]$lines.Add('$ErrorActionPreference = ' + $quote + 'Continue' + $quote)
    [void]$lines.Add('$cdpModule = ' + $quote + $modulePath + $quote)
    [void]$lines.Add('$windowHook = ' + $quote + $hookPath + $quote)
    [void]$lines.Add('Import-Module -Name $cdpModule -Force')
    [void]$lines.Add('')
    [void]$lines.Add('$port = 0')
    [void]$lines.Add('$portText = [string]$env:GATE_CDP_PORT')
    [void]$lines.Add('if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {')
    [void]$lines.Add('    Write-Output ' + $quote + 'CSP_POLICY=failed' + $quote)
    [void]$lines.Add('    Write-Output ' + $quote + 'ERROR=GATE_CDP_PORT missing or invalid' + $quote)
    [void]$lines.Add('    exit 1')
    [void]$lines.Add('}')
    [void]$lines.Add('')
    [void]$lines.Add('$session = $null')
    [void]$lines.Add('try {')
    [void]$lines.Add('    $session = Connect-FredoCdp -Port $port -TimeoutSecs 15')
    [void]$lines.Add('} catch {')
    [void]$lines.Add('    Write-Output ' + $quote + 'CSP_POLICY=failed' + $quote)
    [void]$lines.Add('    Write-Output (' + $quote + 'CDP_UNAVAILABLE:' + $quote + ' + $_.Exception.Message)')
    [void]$lines.Add('    exit 1')
    [void]$lines.Add('}')
    [void]$lines.Add('')
    [void]$lines.Add('# The Page/Runtime/Log domains MUST be enabled before a new-document script')
    [void]$lines.Add('# is registered: without them the script is accepted but never replayed into')
    [void]$lines.Add('# the reloaded document (measured: induced=False after Page.reload). The')
    [void]$lines.Add('# window hook enables them for itself; this wrapper registers first, so it')
    [void]$lines.Add('# owes the same enable.')
    [void]$lines.Add('$null = Enable-CdpDomain -Session $session -Domain ' + $quote + 'Page' + $quote)
    [void]$lines.Add('$null = Enable-CdpDomain -Session $session -Domain ' + $quote + 'Runtime' + $quote)
    [void]$lines.Add('$null = Enable-CdpDomain -Session $session -Domain ' + $quote + 'Log' + $quote)
    [void]$lines.Add('Write-Output (' + $quote + 'CSP_TARGET=' + $quote + ' + [string]$session.Target.url)')
    [void]$lines.Add('Write-Output (' + $quote + 'CSP_TARGETS=' + $quote + ' + [string]$session.Targets)')
    [void]$lines.Add('')
    [void]$lines.Add('$policyScript = @' + $quote)
    foreach ($policyLine in ($policy -split "`r?`n")) {
        [void]$lines.Add($policyLine)
    }
    [void]$lines.Add($quote + '@')
    [void]$lines.Add('')
    [void]$lines.Add('$identifier = Add-CdpNewDocumentScript -Session $session -Script $policyScript')
    [void]$lines.Add('if ([string]::IsNullOrWhiteSpace([string]$identifier)) {')
    [void]$lines.Add('    Write-Output ' + $quote + 'CSP_POLICY=failed' + $quote)
    [void]$lines.Add('    Write-Output ' + $quote + 'ERROR=Page.addScriptToEvaluateOnNewDocument refused' + $quote)
    [void]$lines.Add('    Close-FredoCdp -Session $session')
    [void]$lines.Add('    exit 1')
    [void]$lines.Add('}')
    [void]$lines.Add('Write-Output (' + $quote + 'CSP_POLICY_ID=' + $quote + ' + [string]$identifier)')
    [void]$lines.Add('')
    [void]$lines.Add('$applyScript = @' + $quote)
    [void]$lines.Add('(function () {')
    [void]$lines.Add('  return {')
    [void]$lines.Add('    token: (typeof window.__fredoGateDocToken === ''undefined'') ? '''' : String(window.__fredoGateDocToken),')
    [void]$lines.Add('    meta: document.querySelector(''meta[data-fredo-gate-csp]'') ? true : false')
    [void]$lines.Add('  };')
    [void]$lines.Add('})()')
    [void]$lines.Add($quote + '@')
    [void]$lines.Add('')
    [void]$lines.Add('# Deterministic reload: Invoke-CdpReload can return as soon as the OLD document')
    [void]$lines.Add('# still looks ready, so a document TOKEN is the proof a new document exists. The')
    [void]$lines.Add('# induced policy is then confirmed to be live in THAT document, which is the')
    [void]$lines.Add('# document the hook measures.')
    [void]$lines.Add('$token = ' + $quote + 'gate-' + $quote + ' + [Guid]::NewGuid().ToString(' + $quote + 'N' + $quote + ')')
    [void]$lines.Add('$null = Invoke-CdpEvaluate -Session $session -Expression ("window.__fredoGateDocToken = ' + $quote + '" + $token + "' + $quote + '; true") -TimeoutMs 5000')
    [void]$lines.Add('$null = Send-CdpCommand -Session $session -Method ' + $quote + 'Page.reload' + $quote + ' -Params @{ ignoreCache = $false } -TimeoutMs 10000')
    [void]$lines.Add('')
    [void]$lines.Add('$applied = $false')
    [void]$lines.Add('$lastState = ' + $quote + '<none>' + $quote)
    [void]$lines.Add('$watch = [System.Diagnostics.Stopwatch]::StartNew()')
    [void]$lines.Add('while ($watch.ElapsedMilliseconds -lt 20000) {')
    [void]$lines.Add('    $state = Invoke-CdpEvaluate -Session $session -Expression $applyScript -TimeoutMs 5000')
    [void]$lines.Add('    if ($state.Ok -and $null -ne $state.Value) {')
    [void]$lines.Add('        $lastState = ' + $quote + 'token=[' + $quote + ' + [string]$state.Value.token + ' + $quote + '] meta=' + $quote + ' + [string]$state.Value.meta')
    [void]$lines.Add('        if ([string]::IsNullOrEmpty([string]$state.Value.token) -and $state.Value.meta -eq $true) {')
    [void]$lines.Add('            $applied = $true')
    [void]$lines.Add('            break')
    [void]$lines.Add('        }')
    [void]$lines.Add('    } else {')
    [void]$lines.Add('        $lastState = ' + $quote + 'evalError=' + $quote + ' + [string]$state.Exception')
    [void]$lines.Add('    }')
    [void]$lines.Add('    Start-Sleep -Milliseconds 200')
    [void]$lines.Add('}')
    [void]$lines.Add('Write-Output (' + $quote + 'CSP_POLICY_APPLIED=' + $quote + ' + $applied + ' + $quote + ' waitedMs=' + $quote + ' + $watch.ElapsedMilliseconds + ' + $quote + ' last=' + $quote + ' + $lastState)')
    [void]$lines.Add('if (-not $applied) {')
    [void]$lines.Add('    Write-Output ' + $quote + 'CSP_POLICY=not-applied' + $quote)
    [void]$lines.Add('    Write-Output ' + $quote + 'ERROR=the induced style-src policy did not reach the reloaded document' + $quote)
    [void]$lines.Add('    Close-FredoCdp -Session $session')
    [void]$lines.Add('    exit 1')
    [void]$lines.Add('}')
    [void]$lines.Add('Write-Output ' + $quote + 'CSP_POLICY=nonce-style-src' + $quote)
    [void]$lines.Add('')
    [void]$lines.Add('# This session STAYS OPEN while the hook runs, so the registered policy also')
    [void]$lines.Add('# replays into every new document the hook creates.')
    [void]$lines.Add('& powershell -NoProfile -File $windowHook')
    [void]$lines.Add('$code = $LASTEXITCODE')
    [void]$lines.Add('Close-FredoCdp -Session $session')
    [void]$lines.Add('Write-Output (' + $quote + 'CSP_POLICY_HOOK_EXIT=' + $quote + ' + $code)')
    [void]$lines.Add('exit $code')

    $text = ($lines -join "`r`n") + "`r`n"
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
        Write-Host 'NEGATIVE_NOT_REPRODUCED'
        Write-Host 'NEGATIVE_CONTROL=NOT_REPRODUCED leg=<none>'
        return 1
    }

    $outcome = Test-NegativeOutcome -Leg $Control.Leg -GateExit $GateExit -Lines $GateLines -PrepareError $Control.PrepareError

    Write-Host ('NEGATIVE_LEG=' + $Control.Leg)
    if ([string]::IsNullOrWhiteSpace($Control.PrepareError)) {
        Write-Host 'NEGATIVE_PREPARE=ok'
    } else {
        Write-Host ('NEGATIVE_PREPARE=failed:' + $Control.PrepareError)
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
    Write-Host ('NEGATIVE_CONTROL=' + $verdict + ' leg=' + $Control.Leg)
    return 1
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
            ($hookText.Contains("style-src 'nonce-fredo-gate-3181'")) -and
            ($hookText.Contains('Add-CdpNewDocumentScript')) -and
            ($hookText.Contains('gate-artifact-window.ps1')) -and
            # Measured facts: without the Page domain enabled the script is
            # accepted but never replayed; a document token is the only reliable
            # proof a reload produced a NEW document.
            ($hookText.Contains('Enable-CdpDomain -Session $session -Domain ''Page''')) -and
            ($hookText.Contains("typeof window.__fredoGateDocToken === 'undefined'")) -and
            ($hookText.Contains('CSP_POLICY_APPLIED=')) -and
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
    'Get-NegativeSlug',
    'Get-NegativeExpectation',
    'Get-NegativeObservedErrorIds',
    'Test-NegativeOutcome',
    'New-NegativeMissingDllTree',
    'Get-NegativeCspPolicyScript',
    'New-NegativeCspHook',
    'New-NegativeDatabaseResidue',
    'New-NegativeControl',
    'Complete-NegativeControl',
    'Invoke-NegativeControlSelfTest'
)
