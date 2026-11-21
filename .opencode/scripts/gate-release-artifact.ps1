<#
.SYNOPSIS
  The release-artifact gate: turn a produced NSIS installer into a PASS/FAIL
  verdict plus an evidence bundle, before any draft release exists
  (Spec #3181, ST-3 driver half).

.DESCRIPTION
  This is the harness. It does not build, does not publish, and never launches a
  process itself: it DELEGATES to the committed instruments so there is one
  implementation of each concern.

    extraction + payload assertions -> .opencode/scripts/verify-installer-payload.ps1
                                       -Installer <setup.exe> -WorkDir <run dir> [-SevenZip <path>]
    launch + ports + teardown       -> .opencode/scripts/launch-artifact-probe.ps1
                                       -SanitizePath -Ports 9223,16932,19631 -RequireClosed
                                       -CdpPort <n> -CdpProbe <hook> -DataDir <run dir>
                                       -LogDir <run dir> -WaitSecs <window>
    the live in-window assertions   -> .opencode/scripts/gate-artifact-window.ps1 (the probe's
                                       -CdpProbe hook: styled / CSP / database / screenshot /
                                       companion, SURFACE_RECT, cdp.json)
    the fail-closed negative legs   -> .opencode/scripts/gate-artifact-negative.psm1
                                       (ST-4; the dispatch is pre-wired here)

  ONE PASS, SEVEN CLAUSES. A `-Mode gate` run executes the payload assertion
  (REQ-2.1), a fresh-profile launch (REQ-2.2/2.3/2.4/2.5/2.6/2.7) and a
  pre-dirtied-profile launch (REQ-2.4), then writes ONE receipt with ONE verdict.

  THE NAMED-ERROR FUNNEL. Every assertion failure and every refused precondition
  is funnelled through `Add-NamedError`, which emits exactly ONE greppable stdout
  line per id and records it in `receipt.errors[]`. The ids are the binding set in
  the plan's API contract (section B); this script invents no assertion id. Two
  non-assertion refusal tokens also exist and are NOT part of section B:

    GATE_REFUSED:reason=<r> detail=<d>   a precondition that is neither an
                                         assertion class nor a section-B refusal
                                         (bad args, a stale listener on a probed
                                         port, or the negative leg module absent).

  EXIT-CODE CONTRACT (mirrors the plan's section C, and the sibling instruments):
    0  PASS -- every selected clause green (gate/negative: the control reproduced)
    1  FAIL -- at least one assertion failed with a named error
    2  REFUSED -- a precondition did not hold (EXTRACT_FAILED, WEBVIEW2_MISSING,
       MODEL_SET_MISSING, CDP_PORT_IN_USE, GATE_REFUSED, bad args)
    3  teardown left orphans (the delegated probe's own exit 3)
  Precedence: 3, then 2, then 1, then 0.

  EVIDENCE (all under -OutDir; the directory is created fresh):
    gate.log                     full transcript (harness output + child transcripts)
    receipt.json                 the machine receipt (section E schema)
    installer-payload/           verify-installer-payload.ps1 -WorkDir
    run-fresh/                   probe -LogDir/-DataDir: stdout.log stderr.log
                                 launch-report.log cdp.json screenshot.png
    run-dirty/                   same set for the pre-dirtied launch
    negative-<leg>/              written by gate-artifact-negative.psm1

  WINDOW SIZING. The probe's `-WaitSecs` IS the hook's `GATE_WINDOW_SECS` budget,
  and every hook clause derives its own bound from it. So the driver sizes it:
    * the companion clause runs -> -CompanionSecs + 30, clamped 1..900 (the probe
      clamp is being raised to 1..900 for exactly this reason; do not assume 300);
    * otherwise -> max(-WaitSecs, -DbReadySecs + 30), clamped 1..300, so the DB
      clause can actually reach its own -DbReadySecs bound instead of being
      starved by the launch window.

  -SkipCompanion omits REQ-2.5 entirely (the negative legs use it): the hook then
  runs `database,screenshot` only, and no REQ-2.5 CHECK line or receipt entry is
  produced. That is a deliberate, visible reduction -- never a silent one.

  -Manual prints `MANUAL_ENTRY=true` and runs the identical assertion set and
  receipt (`receipt.manual = true`). It is the AC4 human entry point.

  -SelfTest is hermetic: no installer, no model, no GUI, no network. It carries
  one control per section-B named error id, each driving the real emission
  function used by the entry path and asserting that id plus its documented exit
  class (1 for the FAIL class, 2 for the refused class), plus non-vacuity
  controls. Ends with a single `SELFTEST: PASS|FAIL` line; exit 0 when every
  control passed, 3 otherwise.

  PowerShell 5.1 standard library only. ASCII-only source (G-315). No product code.

.PARAMETER Installer
  The produced `*-setup.exe`. Required unless -SelfTest. A path containing a
  `\debug\` segment is refused by the delegated payload verifier.

.PARAMETER Mode
  `gate` (default), `negative`, or `selftest`. `-SelfTest` is the switch spelling
  of `-Mode selftest`.

.PARAMETER Negative
  Which fail-closed leg to run under `-Mode negative`: `MissingDll`, `Csp` or
  `Database`. Required in that mode.

.PARAMETER OutDir
  Evidence root. Default: `.opencode/tmp/release-gate/<yyyyMMdd-HHmmss>`.

.PARAMETER CdpPort
  WebView2 DevTools port. Default 9333. Chosen outside the app's own ports
  (9223/16932/19631) and never passed in -Ports.

.PARAMETER WaitSecs
  Launch observation window in seconds, default 90 (1..300).

.PARAMETER DbReadySecs
  DB-ready bound per profile, default 180.

.PARAMETER CompanionSecs
  Companion-turn bound, default 600.

.PARAMETER SkipCompanion
  Omit REQ-2.5 (the negative legs use it so a model-less host still runs them).

.PARAMETER SevenZip
  Optional 7z override forwarded to the payload verifier as its first route.

.PARAMETER Manual
  Manual entry: prints MANUAL_ENTRY=true, same assertions and receipt.

.PARAMETER SelfTest
  Run the hermetic instrument controls. Needs no installer, model or GUI.

.PARAMETER ForceNoWebView2
  INTERNAL (self-test control): treat every WebView2 candidate source as absent so
  the WEBVIEW2_MISSING refusal is drivable on a host that has the runtime.

.OUTPUT
  One machine-greppable line per fact (field names are binding, plan section K):
    GATE_INSTALLER=<path>
    EXTRACT_ROUTE=<route>
    CHECK REQ-2.1 PASS   EXTRACT_ROUTE=<route> EXTRACT_ROOT=<path>
    CHECK REQ-2.2 PASS   result=PASS hasExited=False window=<n> orphans=0
    CHECK REQ-2.3 PASS   rules=<n> floor=<m> font=<v> accent=<v> violations=0 injectedRules=1
    CHECK REQ-2.3-screenshot PASS   S1=true ... viewport=<WxH> readyMs=<n>
    CHECK REQ-2.4 PASS   profile=fresh state=ready port=<n> pid=<n>; profile=dirty ...
    CHECK REQ-2.5 PASS   route=ui|ipc replyChars=<n>
    CHECK REQ-2.6 PASS   port_9223=closed port_16932=closed port_19631=closed
    CHECK REQ-2.7 PASS   screenshot=run-fresh/screenshot.png bytes=<n> sha256=<hex>
    CHECK REQ-2.8 PASS   SURFACE_RECT=launcher-command-bar x= y= w= h= viewport=<WxH> source=getBoundingClientRect
    SURFACE_RECT=launcher-command-bar ... source=getBoundingClientRect
    QUARANTINE_EVIDENCE=<absolute path>
    NEGATIVE_EXPECTED=<id>[+<id>...] NEGATIVE_OBSERVED=<ids> GATE_EXIT=<n>
    MANUAL_ENTRY=true
    VERDICT=PASS|FAIL|REFUSED
    RECEIPT=<path>
  plus the named errors (section B) as `ID` or `ID:<detail>` lines.

.EXIT CODES
  0 PASS / control reproduced / every self-test control passed
  1 assertion failed (or a negative leg did not reproduce)
  2 refused precondition
  3 teardown left orphans (or a self-test control failed)

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -SelfTest

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer apps\tauri\src-tauri\target\release\bundle\nsis\Fredo_0.2.4_x64-setup.exe -Mode gate

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer <setup.exe> -Mode gate -Manual -OutDir .opencode\tmp\release-gate\manual

.EXAMPLE
  powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer <setup.exe> -Mode negative -Negative MissingDll -SkipCompanion
#>
param(
    [string]$Installer = '',
    [string]$Mode = 'gate',
    [string]$Negative = '',
    [string]$OutDir = '',
    [int]$CdpPort = 9333,
    [int]$WaitSecs = 90,
    [int]$DbReadySecs = 180,
    [int]$CompanionSecs = 600,
    [switch]$SkipCompanion,
    [string]$SevenZip = '',
    [switch]$Manual,
    [switch]$SelfTest,
    [switch]$ForceNoWebView2
)

$ErrorActionPreference = 'Stop'

$script:ScriptDir = $PSScriptRoot
$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

$script:PayloadVerifier = Join-Path $script:ScriptDir 'verify-installer-payload.ps1'
$script:LaunchProbe = Join-Path $script:ScriptDir 'launch-artifact-probe.ps1'
$script:WindowHook = Join-Path $script:ScriptDir 'gate-artifact-window.ps1'
$script:NegativeModulePath = Join-Path $script:ScriptDir 'gate-artifact-negative.psm1'

# Model payload: the ONE product rule (infrastructure/companion/models.rs:304-335).
# The gate resolves the DEFAULT rule ({home}/fredo-models + the manifest subdir);
# the app's SettingsStore `models_dir` override lives inside the app and is not
# readable from a stdlib script, and CI provisions the default location (section L).
$script:ModelSubdir = 'gemma-4-e2b-it-qat'
$script:ModelFiles = @(
    'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf',
    'mmproj-BF16.gguf',
    'MTP\mtp-gemma-4-E2B-it-Q4_0.gguf'
)

# Ports asserted CLOSED while the release app runs (the release build ships no MCP
# bridge). Deliberately disjoint from -CdpPort.
$script:ProbePorts = @(9223, 16932, 19631)

# ---- run state ---------------------------------------------------------------

$script:Captured = $null
$script:GateLogPath = ''
$script:GateLogEncoding = New-Object System.Text.UTF8Encoding($false)
$script:StartedAt = Get-Date
$script:Checks = New-Object System.Collections.ArrayList
$script:SeenCheckIds = @{}
$script:CoarseErrors = New-Object System.Collections.ArrayList
$script:Failed = $false
$script:Refused = $false
$script:Orphans = $false
$script:DbFacts = [ordered]@{}
$script:ExtractRoute = ''
$script:ExtractRoot = ''
$script:FreshDir = ''
$script:DirtyDir = ''
$script:PayloadDir = ''
$script:QuarantinePath = ''
$script:SurfaceRect = ''
$script:CdpJsonFresh = $null
$script:NegativeObserved = @()
$script:NegativeExpected = @()
$script:NegativeGateExit = $null

function Reset-RunState {
    $script:Checks = New-Object System.Collections.ArrayList
    $script:SeenCheckIds = @{}
    $script:CoarseErrors = New-Object System.Collections.ArrayList
    $script:Failed = $false
    $script:Refused = $false
    $script:Orphans = $false
    $script:DbFacts = [ordered]@{}
    $script:ExtractRoute = ''
    $script:ExtractRoot = ''
    $script:QuarantinePath = ''
    $script:SurfaceRect = ''
    $script:CdpJsonFresh = $null
    $script:NegativeObserved = @()
    $script:NegativeExpected = @()
    $script:NegativeGateExit = $null
    $script:StartedAt = Get-Date
}

# ---- output ------------------------------------------------------------------

# Emit is the ONLY stdout writer. During a self-test control ($script:Captured is
# a list) the line is buffered instead of printed and gate.log is not touched, so
# a control can assert on the exact transcript a real run would print.
function Emit {
    param([string]$Line)
    if ($null -ne $script:Captured) {
        [void]$script:Captured.Add($Line)
        return
    }
    [Console]::Out.WriteLine($Line)
    if (-not [string]::IsNullOrWhiteSpace($script:GateLogPath)) {
        try {
            [System.IO.File]::AppendAllText($script:GateLogPath, $Line + "`r`n", $script:GateLogEncoding)
        } catch {
        }
    }
}

function Get-Stamp {
    return (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
}

function Get-TextOrEmpty {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try {
        return [System.IO.File]::ReadAllText($Path)
    } catch {
        return ''
    }
}

function Get-TextLines {
    param([string]$Path)
    $text = Get-TextOrEmpty -Path $Path
    if ([string]::IsNullOrWhiteSpace($text)) { return @() }
    return @($text -split "`r?`n")
}

# ---- JSON (deterministic, PS-5.1-safe) ---------------------------------------
# ConvertTo-Json in Windows PowerShell 5.1 collapses a single-element array to a
# scalar and reorders nothing but renames nothing either -- neither of which a
# receipt can tolerate (F-19 checks array-ness and absent optionals). This small
# serializer emits exactly what we build: ordered keys, real arrays, and ABSENT
# keys for unset optionals (never null).

function ConvertTo-JsonStringLiteral {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($code -eq 34) { [void]$sb.Append('\"') }
        elseif ($code -eq 92) { [void]$sb.Append('\\') }
        elseif ($code -eq 10) { [void]$sb.Append('\n') }
        elseif ($code -eq 13) { [void]$sb.Append('\r') }
        elseif ($code -eq 9) { [void]$sb.Append('\t') }
        elseif ($code -lt 32) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
        else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-JsonNumber {
    param($Value)
    return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0}', $Value)
}

function ConvertTo-JsonText {
    param($Value)

    if ($null -eq $Value) { return 'null' }

    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
        return (ConvertTo-JsonNumber $Value)
    }
    if ($Value -is [string]) {
        return (ConvertTo-JsonStringLiteral $Value)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = New-Object System.Collections.ArrayList
        foreach ($key in $Value.Keys) {
            $inner = ConvertTo-JsonText $Value[$key]
            [void]$parts.Add((ConvertTo-JsonStringLiteral ([string]$key)) + ':' + $inner)
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = New-Object System.Collections.ArrayList
        foreach ($item in $Value) {
            [void]$parts.Add((ConvertTo-JsonText $item))
        }
        return '[' + ($parts -join ',') + ']'
    }
    return (ConvertTo-JsonStringLiteral ([string]$Value))
}

function Write-JsonFile {
    param([string]$Path, $Value)
    $text = ConvertTo-JsonText $Value
    [System.IO.File]::WriteAllText($Path, $text, $script:GateLogEncoding)
}

# ---- named errors / checks ---------------------------------------------------

function Get-CheckName {
    param([string]$Id)
    switch ($Id) {
        'REQ-2.1' { return 'EXTRACT_PAYLOAD' }
        'REQ-2.2' { return 'LAUNCH_SURVIVES' }
        'REQ-2.3' { return 'UI_STYLED' }
        'REQ-2.3-screenshot' { return 'SCREENSHOT_FRAME' }
        'REQ-2.4' { return 'DB_READY' }
        'REQ-2.5' { return 'COMPANION_TURN' }
        'REQ-2.6' { return 'MCP_BRIDGE_CLOSED' }
        'REQ-2.7' { return 'EVIDENCE_SET' }
        'REQ-2.8' { return 'SURFACE_RECT' }
        default { return $Id }
    }
}

function Test-RefusalId {
    param([string]$Id)
    # The four section-B refused classes, plus the non-assertion refusal token.
    return ($Id -eq 'EXTRACT_FAILED' -or
            $Id -eq 'WEBVIEW2_MISSING' -or
            $Id -eq 'MODEL_SET_MISSING' -or
            $Id -eq 'CDP_PORT_IN_USE' -or
            $Id -eq 'GATE_REFUSED')
}

# The ONE funnel: one greppable stdout line per id, recorded once in the receipt,
# and the run's exit class advanced accordingly.
function Add-NamedError {
    param([string]$Id, [string]$Detail = '')

    $seen = $false
    foreach ($existing in $script:CoarseErrors) {
        if ($existing.id -eq $Id -and $existing.detail -eq $Detail) { $seen = $true }
    }
    if (-not $seen) {
        [void]$script:CoarseErrors.Add([ordered]@{ id = $Id; detail = $Detail })
    }

    if ([string]::IsNullOrWhiteSpace($Detail)) { Emit $Id }
    else { Emit ($Id + ':' + $Detail) }

    if (Test-RefusalId $Id) { $script:Refused = $true }
    elseif (-not $script:Refused) { $script:Failed = $true }
}

function Add-Check {
    param([string]$Id, [bool]$Ok, [string]$Detail = '', [string]$Name = '')

    if ($script:SeenCheckIds.ContainsKey($Id)) { return }
    $script:SeenCheckIds[$Id] = $true

    $status = 'FAIL'
    if ($Ok) { $status = 'PASS' } else { if (-not $script:Refused) { $script:Failed = $true } }

    if ([string]::IsNullOrWhiteSpace($Name)) { $Name = Get-CheckName $Id }
    Emit ('CHECK {0} {1}   {2}' -f $Id, $status, $Detail)
    [void]$script:Checks.Add([ordered]@{ id = $Id; name = $Name; ok = $Ok; detail = $Detail })
}

function Get-FinalExitCode {
    if ($script:Orphans) { return 3 }
    if ($script:Refused) { return 2 }
    if ($script:Failed) { return 1 }
    return 0
}

function Get-VerdictText {
    param([int]$Code)
    if ($Code -eq 0) { return 'PASS' }
    if ($Code -eq 2) { return 'REFUSED' }
    return 'FAIL'
}

function Test-ContainsLine {
    param($Lines, [string]$Needle)
    foreach ($line in $Lines) {
        if ($line.Contains($Needle)) { return $true }
    }
    return $false
}

function Get-LineValue {
    param($Lines, [string]$Prefix)
    foreach ($line in $Lines) {
        if ($line.StartsWith($Prefix)) { return $line.Substring($Prefix.Length).Trim() }
    }
    return ''
}

# ---- environment probes ------------------------------------------------------

function Test-TcpPortListening {
    param([int]$Port, [int]$TimeoutMs = 600)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

# WebView2 runtime presence. The candidate sources are PARAMETERS so a control can
# drive the real evaluation (entry-path function) over a synthetic empty universe.
function Get-WebView2Evidence {
    param(
        [string[]]$RegistryPaths = @(),
        [string[]]$FolderGlobs = @()
    )

    foreach ($path in $RegistryPaths) {
        try {
            $value = Get-ItemProperty -LiteralPath $path -Name 'pv' -ErrorAction SilentlyContinue
            if ($null -ne $value) {
                $pv = [string]$value.pv
                if (-not [string]::IsNullOrWhiteSpace($pv)) {
                    return [pscustomobject]@{ Ok = $true; Source = 'registry'; Detail = ($path + ' pv=' + $pv) }
                }
            }
        } catch {
        }
    }

    foreach ($glob in $FolderGlobs) {
        try {
            $hits = @(Get-ChildItem -Path $glob -ErrorAction SilentlyContinue)
            if ($hits.Count -gt 0) {
                return [pscustomobject]@{ Ok = $true; Source = 'folder'; Detail = $hits[0].FullName }
            }
        } catch {
        }
    }

    return [pscustomobject]@{ Ok = $false; Source = ''; Detail = 'no WebView2 runtime candidate found' }
}

function Get-DefaultWebView2RegistryPaths {
    $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    return @(
        ('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + $id),
        ('HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\' + $id),
        ('HKCU:\Software\Microsoft\EdgeUpdate\Clients\' + $id)
    )
}

function Get-DefaultWebView2FolderGlobs {
    $roots = @()
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) { $roots += ${env:ProgramFiles(x86)} }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) { $roots += $env:ProgramFiles }
    $globs = @()
    foreach ($root in $roots) {
        $globs += (Join-Path $root 'Microsoft\EdgeWebView\Application\*\msedgewebview2.exe')
    }
    return $globs
}

# Model-set presence. Root and file list are parameters (same reason as above);
# the real run passes the product's default rule.
function Get-ModelSetEvidence {
    param([string]$Root, [string[]]$Files)

    $base = Join-Path $Root $script:ModelSubdir
    $missing = New-Object System.Collections.ArrayList
    foreach ($file in $Files) {
        $path = Join-Path $base $file
        $ok = $false
        try {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $item = Get-Item -LiteralPath $path
                if ($item.Length -gt 0) { $ok = $true }
            }
        } catch {
            $ok = $false
        }
        if (-not $ok) { [void]$missing.Add($file) }
    }

    return [pscustomobject]@{ Ok = ($missing.Count -eq 0); Missing = @($missing); Base = $base }
}

function Get-DefaultModelsRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:FREDO_MODELS_DIR)) { return $env:FREDO_MODELS_DIR }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return (Join-Path $env:USERPROFILE 'fredo-models')
    }
    return (Join-Path $script:RepoRoot 'fredo-models')
}

# ---- child process runner ----------------------------------------------------

# Run a committed PowerShell instrument to completion, capturing its exit code
# and its stdout/stderr files. A native/child NON-ZERO exit is an EXPECTED,
# handled outcome here (G-315): the stop-on-error preference is scoped around the
# call so the documented refusals stay reachable.
function Invoke-ChildScript {
    param(
        [string]$ScriptPath,
        [string[]]$ArgumentList = @(),
        [string]$StdOutPath,
        [string]$StdErrPath
    )

    $result = [pscustomobject]@{ ExitCode = $null; StdOut = ''; StdErr = '' }
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return $result
    }

    $hostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argString = '-NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
    foreach ($argument in $ArgumentList) {
        $text = [string]$argument
        if ($text -match '\s') { $argString += ' "' + $text + '"' }
        else { $argString += ' ' + $text }
    }

    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $proc = Start-Process -FilePath $hostExe -ArgumentList $argString -PassThru -Wait -NoNewWindow -RedirectStandardOutput $StdOutPath -RedirectStandardError $StdErrPath
        $result.ExitCode = [int]$proc.ExitCode
    } catch {
        $result.ExitCode = $null
    } finally {
        $ErrorActionPreference = $previous
    }

    $result.StdOut = Get-TextOrEmpty -Path $StdOutPath
    $result.StdErr = Get-TextOrEmpty -Path $StdErrPath
    return $result
}

function Write-ChildTranscript {
    param([string]$Label, $Child)
    if ($null -eq $Child) { return }
    $codeText = 'error'
    if ($null -ne $Child.ExitCode) { $codeText = [string]$Child.ExitCode }
    Emit ('CHILD {0} EXIT={1}' -f $Label, $codeText)
    foreach ($line in @($Child.StdOut -split "`r?`n")) {
        if (-not [string]::IsNullOrWhiteSpace($line)) { Emit $line }
    }
    foreach ($line in @($Child.StdErr -split "`r?`n")) {
        if (-not [string]::IsNullOrWhiteSpace($line)) { Emit ('STDERR ' + $line) }
    }
}

# ---- verdict extraction ------------------------------------------------------
# Each classifier is a PURE function over an instrument's own transcript (or
# cdp.json). The publisher below is the ONE place a classifier's outcome becomes
# a CHECK line / named error / exit class, so a control that drives the publisher
# drives exactly the entry-path behaviour.

function Get-VerifierVerdict {
    param([int]$ExitCode, [string[]]$Lines)

    $verdict = [pscustomobject]@{
        Ok = $false
        Route = ''
        Root = ''
        Missing = @()
        Refusal = ''
        ImportScanFailed = $false
    }

    foreach ($line in $Lines) {
        if ($line -match '^EXTRACTOR=(.+?)\s+status=hit') { $verdict.Route = $Matches[1].Trim() }
        if ($line -match '^EXTRACT_ROOT=(.+)$') { $verdict.Root = $Matches[1].Trim() }
        if ($line -match '^ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT\s+missing=(.+)$') {
            $verdict.Missing = @($Matches[1].Split(',') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
        if ($line -match '^ERROR=(PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT|PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT|PAYLOAD_IMPORT_PARSE_FAIL_IN_ARTIFACT)') {
            $verdict.ImportScanFailed = $true
        }
        if ([string]::IsNullOrWhiteSpace($verdict.Refusal)) {
            if ($line -match '^ERROR=(EXTRACTOR_MISSING|EXTRACTOR_OVERRIDE_NOT_FOUND|DEBUG_ARTIFACT_REFUSED|INSTALLER_NOT_FOUND|PAYLOAD_MANIFEST_INVALID)(.*)$') {
                $verdict.Refusal = ($Matches[1] + $Matches[2]).Trim()
            }
        }
    }

    $verdict.Ok = ($ExitCode -eq 0)
    return $verdict
}

function Publish-VerifierVerdict {
    param($Verdict)

    if (-not [string]::IsNullOrWhiteSpace($Verdict.Route)) {
        $script:ExtractRoute = $Verdict.Route
        Emit ('EXTRACT_ROUTE=' + $Verdict.Route)
    }
    if (-not [string]::IsNullOrWhiteSpace($Verdict.Root)) { $script:ExtractRoot = $Verdict.Root }

    if ([string]::IsNullOrWhiteSpace($Verdict.Refusal) -and $Verdict.Missing.Count -eq 0 -and -not $Verdict.ImportScanFailed -and -not $Verdict.Ok) {
        Add-NamedError 'EXTRACT_FAILED' 'payload-verifier-failed'
    }

    if (-not [string]::IsNullOrWhiteSpace($Verdict.Refusal)) {
        # An unusable installer / no answering route: refused, never a FAIL and
        # never a PASS (plan section C, EXTRACT_FAILED).
        Add-NamedError 'EXTRACT_FAILED' $Verdict.Refusal
    }

    foreach ($name in $Verdict.Missing) {
        Add-NamedError 'PAYLOAD_MISSING' $name
    }

    if ($Verdict.ImportScanFailed) {
        Add-NamedError 'EXTRACT_FAILED' 'payload-import-scan'
    }

    # F-6: the extraction route must not be an elevation-only NSIS install. The
    # delegated verifier names the exact import/route facts verbatim in gate.log.
    $routeOk = $true
    if (-not [string]::IsNullOrWhiteSpace($Verdict.Route)) {
        if ($Verdict.Route -match 'nsis|elevat') { $routeOk = $false }
    }
    if ([string]::IsNullOrWhiteSpace($Verdict.Route)) { $routeOk = $false }
    if (-not $routeOk -and [string]::IsNullOrWhiteSpace($Verdict.Refusal)) {
        Add-NamedError 'EXTRACT_FAILED' ('elevation-only-route route=' + $Verdict.Route)
    }

    $ok = ($Verdict.Ok -and $routeOk -and $Verdict.Missing.Count -eq 0 -and [string]::IsNullOrWhiteSpace($Verdict.Refusal))
    $detail = ('EXTRACT_ROUTE={0} EXTRACT_ROOT={1}' -f $script:ExtractRoute, $script:ExtractRoot)
    Add-Check 'REQ-2.1' $ok $detail
    return $ok
}

function Get-ProbeVerdict {
    param([int]$ExitCode, [string[]]$Lines, [int[]]$Ports)

    $verdict = [pscustomobject]@{
        ExitCode = $ExitCode
        Result = (Get-LineValue $Lines 'RESULT=')
        HasExited = ((Get-LineValue $Lines 'HAS_EXITED=') -eq 'True')
        AppExitCode = (Get-LineValue $Lines 'EXIT_CODE=')
        PortsOpen = @()
        BridgeHits = 0
        Orphans = 0
        Pid = (Get-LineValue $Lines 'PID=')
        LaunchError = ''
        CdpPortInUse = $false
        StaleListenerPort = ''
        HookFailure = ''
        RefusedOther = ''
    }

    foreach ($line in $Lines) {
        if ($line -match '^PORT_(\d+)=open') { $verdict.PortsOpen += [int]$Matches[1] }
        if ($line -match '^BRIDGE_LOG_HITS=(\d+)') { $verdict.BridgeHits = [int]$Matches[1] }
        if ($line -match '^ORPHANS_LEFT=(\d+)') { $verdict.Orphans = [int]$Matches[1] }
        if ($line -match '^ERROR=CDP_PORT_IN_USE') { $verdict.CdpPortInUse = $true }
        if ($line -match '^ERROR: port (\d+) is already open') { $verdict.StaleListenerPort = $Matches[1] }
        if ($line -match '^ERROR: (launch failed.*)$') { $verdict.LaunchError = $Matches[1] }
        if ($line -match '^FAILURE=(window-hook.*)$') { $verdict.HookFailure = $Matches[1] }
    }

    if ([string]::IsNullOrWhiteSpace($verdict.Pid) -and [string]::IsNullOrWhiteSpace($verdict.LaunchError) -and $verdict.Result -eq 'REFUSED') {
        $verdict.RefusedOther = 'probe-refused'
    }

    return $verdict
}

function Publish-ProbeVerdict {
    param($Verdict, [string]$Profile, [int]$WindowSecs)

    if ($Verdict.Orphans -gt 0) { $script:Orphans = $true }
    if ($Verdict.BridgeHits -gt 0) { Add-NamedError 'MCP_BRIDGE_LOG_LINE' '' }
    foreach ($port in $Verdict.PortsOpen) { Add-NamedError 'MCP_PORT_OPEN' ([string]$port) }

    if ($Verdict.CdpPortInUse) {
        Add-NamedError 'CDP_PORT_IN_USE' ''
    } elseif (-not [string]::IsNullOrWhiteSpace($Verdict.StaleListenerPort)) {
        Add-NamedError 'GATE_REFUSED' ('reason=stale-listener port=' + $Verdict.StaleListenerPort)
    } elseif (-not [string]::IsNullOrWhiteSpace($Verdict.LaunchError)) {
        Add-NamedError 'LAUNCH_NOT_RUNNING' $Verdict.LaunchError
    } elseif ([string]::IsNullOrWhiteSpace($Verdict.Pid) -and $Verdict.Result -eq 'REFUSED') {
        Add-NamedError 'GATE_REFUSED' 'reason=probe-refused profile='
    }

    if ($Verdict.HasExited) {
        $code = $Verdict.AppExitCode
        if ([string]::IsNullOrWhiteSpace($code)) { $code = 'unknown' }
        Add-NamedError 'LAUNCH_EXIT' $code
    }

    $survived = ((-not $Verdict.HasExited) -and ($Verdict.Result -eq 'PASS'))
    $detail = ('result={0} hasExited={1} window={2} orphans={3}' -f $Verdict.Result, $Verdict.HasExited, $WindowSecs, $Verdict.Orphans)
    Add-Check 'REQ-2.2' $survived $detail
    return $survived
}

function Get-HookVerdict {
    param([string]$CdpJsonPath)

    $verdict = [pscustomobject]@{
        Available = $false
        Errors = @()
        Checks = @()
        Db = $null
        Companion = $null
        Screenshot = $null
        SurfaceRect = ''
        Targets = 0
        WebSocketDebuggerUrl = ''
        Endpoint = ''
    }

    if ([string]::IsNullOrWhiteSpace($CdpJsonPath) -or -not (Test-Path -LiteralPath $CdpJsonPath -PathType Leaf)) {
        return $verdict
    }

    $raw = ''
    try { $raw = [System.IO.File]::ReadAllText($CdpJsonPath) } catch { return $verdict }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $verdict }

    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json } catch { return $verdict }
    if ($null -eq $parsed) { return $verdict }

    $verdict.Available = $true

    if ($null -ne $parsed.PSObject.Properties['errors']) {
        foreach ($entry in @($parsed.errors)) {
            if ($null -eq $entry) { continue }
            $id = [string]$entry.id
            $detail = ''
            if ($null -ne $entry.PSObject.Properties['detail']) { $detail = [string]$entry.detail }
            $verdict.Errors += [pscustomobject]@{ id = $id; detail = $detail }
        }
    }
    if ($null -ne $parsed.PSObject.Properties['checks']) {
        foreach ($entry in @($parsed.checks)) {
            if ($null -eq $entry) { continue }
            $id = [string]$entry.id
            $ok = $false
            if ($null -ne $entry.PSObject.Properties['ok']) { $ok = [bool]$entry.ok }
            $detail = ''
            if ($null -ne $entry.PSObject.Properties['detail']) { $detail = [string]$entry.detail }
            $verdict.Checks += [pscustomobject]@{ id = $id; ok = $ok; detail = $detail }
        }
    }
    if ($null -ne $parsed.PSObject.Properties['db']) { $verdict.Db = $parsed.db }
    if ($null -ne $parsed.PSObject.Properties['companion']) { $verdict.Companion = $parsed.companion }
    if ($null -ne $parsed.PSObject.Properties['screenshot']) { $verdict.Screenshot = $parsed.screenshot }
    if ($null -ne $parsed.PSObject.Properties['surfaceRect']) { $verdict.SurfaceRect = [string]$parsed.surfaceRect }
    if ($null -ne $parsed.PSObject.Properties['targets']) { $verdict.Targets = [int]$parsed.targets }
    if ($null -ne $parsed.PSObject.Properties['webSocketDebuggerUrl']) { $verdict.WebSocketDebuggerUrl = [string]$parsed.webSocketDebuggerUrl }
    if ($null -ne $parsed.PSObject.Properties['endpoint']) { $verdict.Endpoint = [string]$parsed.endpoint }

    return $verdict
}

function Publish-HookVerdict {
    param($Verdict, [string]$Profile)

    if (-not $Verdict.Available) {
        Add-NamedError 'CDP_UNAVAILABLE' ('no cdp.json for profile=' + $Profile)
    }

    foreach ($errorEntry in $Verdict.Errors) {
        switch ($errorEntry.id) {
            'UNSTYLED' { Add-NamedError 'UNSTYLED' $errorEntry.detail }
            'CSP_VIOLATION' { Add-NamedError 'CSP_VIOLATION' $errorEntry.detail }
            'DB_NOT_READY' {
                $dbProfile = $errorEntry.detail
                if ([string]::IsNullOrWhiteSpace($dbProfile)) { $dbProfile = $Profile }
                Add-NamedError 'DB_NOT_READY' $dbProfile
            }
            'COMPANION_NO_REPLY' { Add-NamedError 'COMPANION_NO_REPLY' '' }
            'COMPANION_ENGINE' { Add-NamedError 'COMPANION_ENGINE' $errorEntry.detail }
            'EVIDENCE_MISSING' { Add-NamedError 'EVIDENCE_MISSING' $errorEntry.detail }
            'CDP_UNAVAILABLE' { Add-NamedError 'CDP_UNAVAILABLE' $errorEntry.detail }
            default {
                if (-not [string]::IsNullOrWhiteSpace($errorEntry.id)) {
                    Add-NamedError $errorEntry.id $errorEntry.detail
                }
            }
        }
    }

    foreach ($check in $Verdict.Checks) {
        if ($check.id -eq 'REQ-2.4') {
            $script:DbFacts[$Profile] = [pscustomobject]@{ Ok = $check.ok; Detail = $check.detail }
            continue
        }
        Add-Check $check.id $check.ok $check.detail
    }

    if (-not [string]::IsNullOrWhiteSpace($Verdict.SurfaceRect)) {
        $script:SurfaceRect = $Verdict.SurfaceRect
        Emit ('SURFACE_RECT=' + $Verdict.SurfaceRect)
    }

    return $Verdict
}

# REQ-2.4 is emitted ONCE (F-5 counts each REQ-2.x exactly once) with BOTH profile
# facts in its detail; the hook emits one line per profile because each profile is
# its own run.
function Publish-DbCheck {
    param([string]$FreshProfile = 'fresh', [string]$DirtyProfile = 'dirty')

    $fresh = $null
    $dirty = $null
    if ($script:DbFacts.Contains($FreshProfile)) { $fresh = $script:DbFacts[$FreshProfile] }
    if ($script:DbFacts.Contains($DirtyProfile)) { $dirty = $script:DbFacts[$DirtyProfile] }

    $parts = New-Object System.Collections.ArrayList
    $ok = $true
    foreach ($pair in @(@{ Name = $FreshProfile; Fact = $fresh }, @{ Name = $DirtyProfile; Fact = $dirty })) {
        if ($null -eq $pair.Fact) {
            $ok = $false
            [void]$parts.Add(('profile={0} state=missing' -f $pair.Name))
            continue
        }
        if (-not $pair.Fact.Ok) { $ok = $false }
        [void]$parts.Add(($pair.Fact.Detail))
    }

    Add-Check 'REQ-2.4' $ok ($parts -join '; ')
    return $ok
}

# The dirty profile's residue MUST be quarantined by RENAME, never deleted
# (cluster_dir.rs:48-53, :236-250). Called only when the dirty DB clause is green.
function Test-QuarantineEvidence {
    param([string]$DataDir)

    $postgresDir = Join-Path $DataDir 'postgres'
    $result = [pscustomobject]@{ Ok = $false; Path = ''; Reason = '' }

    if (-not (Test-Path -LiteralPath $postgresDir -PathType Container)) {
        $result.Reason = 'postgres dir absent: ' + $postgresDir
        return $result
    }

    $rejected = @(Get-ChildItem -LiteralPath $postgresDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'cluster.rejected-*' })

    if ($rejected.Count -eq 0) {
        $result.Reason = 'no cluster.rejected-* sibling under ' + $postgresDir
        return $result
    }

    $best = $rejected[0]
    foreach ($candidate in $rejected) {
        if ($candidate.LastWriteTimeUtc -gt $best.LastWriteTimeUtc) { $best = $candidate }
    }

    $startLog = Join-Path $best.FullName 'start.log'
    if (-not (Test-Path -LiteralPath $startLog -PathType Leaf)) {
        $result.Reason = 'quarantined dir carries no start.log: ' + $best.FullName
        return $result
    }

    $result.Ok = $true
    $result.Path = $best.FullName
    return $result
}

function Publish-Quarantine {
    param($Quarantine)

    if ($Quarantine.Ok) {
        $script:QuarantinePath = $Quarantine.Path
        Emit ('QUARANTINE_EVIDENCE=' + $Quarantine.Path)
        return $true
    }

    Add-NamedError 'DB_QUARANTINE_MISSING' $Quarantine.Reason
    return $false
}

# REQ-2.7: the evidence set that must exist on PASS and on FAIL alike.
function Test-EvidenceSet {
    param([string]$OutDir)

    $required = @(
        @{ Rel = 'gate.log'; Name = 'gate.log' },
        @{ Rel = 'run-fresh\stdout.log'; Name = 'stdout' },
        @{ Rel = 'run-fresh\stderr.log'; Name = 'stderr' },
        @{ Rel = 'run-fresh\launch-report.log'; Name = 'launch-report' },
        @{ Rel = 'run-fresh\cdp.json'; Name = 'cdp' },
        @{ Rel = 'run-fresh\screenshot.png'; Name = 'screenshot' },
        @{ Rel = 'run-dirty\stdout.log'; Name = 'stdout' },
        @{ Rel = 'run-dirty\stderr.log'; Name = 'stderr' },
        @{ Rel = 'run-dirty\launch-report.log'; Name = 'launch-report' },
        @{ Rel = 'run-dirty\cdp.json'; Name = 'cdp' },
        @{ Rel = 'run-dirty\screenshot.png'; Name = 'screenshot' }
    )

    $missing = New-Object System.Collections.ArrayList
    foreach ($entry in $required) {
        $path = Join-Path $OutDir $entry.Rel
        $ok = $false
        try {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                if ((Get-Item -LiteralPath $path).Length -gt 0) { $ok = $true }
            }
        } catch {
            $ok = $false
        }
        if (-not $ok) {
            # de-duplicate by evidence NAME (one EVIDENCE_MISSING per artifact)
            if ($missing -notcontains $entry.Name) { [void]$missing.Add($entry.Name) }
        }
    }

    $pngPath = Join-Path $OutDir 'run-fresh\screenshot.png'
    $pngBytes = 0
    $pngSha = ''
    $pngSignature = $false
    try {
        if (Test-Path -LiteralPath $pngPath -PathType Leaf) {
            $pngBytes = (Get-Item -LiteralPath $pngPath).Length
            $pngSha = (Get-FileHash -LiteralPath $pngPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $head = [System.IO.File]::ReadAllBytes($pngPath)
            if ($head.Length -ge 8) {
                $sig = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
                $pngSignature = $true
                for ($i = 0; $i -lt 8; $i++) {
                    if ([int]$head[$i] -ne $sig[$i]) { $pngSignature = $false }
                }
            }
        }
    } catch {
    }

    return [pscustomobject]@{
        Ok = ($missing.Count -eq 0)
        Missing = @($missing)
        PngBytes = $pngBytes
        PngSha256 = $pngSha
        PngSignature = $pngSignature
        PngRel = 'run-fresh/screenshot.png'
    }
}

function Publish-EvidenceSet {
    param($Evidence)

    foreach ($name in $Evidence.Missing) {
        Add-NamedError 'EVIDENCE_MISSING' $name
    }

    $ok = ($Evidence.Ok -and $Evidence.PngSignature)
    if ($Evidence.Ok -and -not $Evidence.PngSignature) {
        Add-NamedError 'EVIDENCE_MISSING' 'screenshot-not-png'
    }

    $detail = ('screenshot={0} bytes={1} sha256={2}' -f $Evidence.PngRel, $Evidence.PngBytes, $Evidence.PngSha256)
    Add-Check 'REQ-2.7' $ok $detail
    return $ok
}

# ---- negative leg verdict ----------------------------------------------------
# The EXPECTATION is a SET of ids, because one leg can owe more than one.
#   MissingDll -> LAUNCH_EXIT:-1073741515                (one id)
#   Csp        -> CSP_VIOLATION AND UNSTYLED             (REQ-3.2a / QA F-15: the
#                 0.2.3 mechanism is a nonce-bearing style-src, which BOTH refuses
#                 the runtime style tags AND leaves the UI unstyled. UNSTYLED
#                 alone, or CSP_VIOLATION alone, is NEGATIVE_WRONG_ERROR.)
#   Database   -> DB_NOT_READY:dirty                     (one id)
# EVERY expected id must be observed for the leg to count as reproduced.

function Get-ExpectedNegativeId {
    param([string]$Name)
    # Callers ALWAYS wrap this with @(...): a one-element set unrolls to a scalar
    # on return, so `.Count` is only reliable through the wrapper.
    switch ($Name) {
        'MissingDll' { return @('LAUNCH_EXIT:-1073741515') }
        'Csp' { return @('CSP_VIOLATION', 'UNSTYLED') }
        'Database' { return @('DB_NOT_READY:dirty') }
        default { return @() }
    }
}

# Single-id matcher: does ONE observation satisfy ONE expectation? Kept as the
# sole comparison primitive so the signed/unsigned LAUNCH_EXIT equivalence lives
# in exactly one place; Get-MissingExpectedIds below applies it per expected id.
function Test-ObservedId {
    param([string[]]$Observed, [string]$Expected)

    $expectedId = $Expected
    $expectedDetail = ''
    $index = $Expected.IndexOf(':')
    if ($index -gt 0) {
        $expectedId = $Expected.Substring(0, $index)
        $expectedDetail = $Expected.Substring($index + 1)
    }

    foreach ($entry in $Observed) {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        $entryId = $entry
        $entryDetail = ''
        $entryIndex = $entry.IndexOf(':')
        if ($entryIndex -gt 0) {
            $entryId = $entry.Substring(0, $entryIndex)
            $entryDetail = $entry.Substring($entryIndex + 1)
        }

        if ($entryId -ne $expectedId) { continue }

        if ($expectedId -eq 'LAUNCH_EXIT') {
            # -1073741515 (signed) and 3221225781 (unsigned) are the same value.
            $want = 0
            $got = 0
            if (-not [int64]::TryParse($expectedDetail, [ref]$want)) { continue }
            if (-not [int64]::TryParse($entryDetail, [ref]$got)) { continue }
            if ($want -lt 0) { $want += 4294967296 }
            if ($got -lt 0) { $got += 4294967296 }
            if ($want -eq $got) { return $true }
            continue
        }

        if ([string]::IsNullOrWhiteSpace($expectedDetail)) { return $true }
        if ($entryDetail -eq $expectedDetail) { return $true }
    }

    return $false
}

# The ids in the expected SET that the observation set does NOT satisfy.
function Get-MissingExpectedIds {
    param([string[]]$Expected, [string[]]$Observed)

    $missing = New-Object System.Collections.ArrayList
    foreach ($expectedId in $Expected) {
        if ([string]::IsNullOrWhiteSpace($expectedId)) { continue }
        if (-not (Test-ObservedId -Observed $Observed -Expected $expectedId)) {
            [void]$missing.Add($expectedId)
        }
    }
    return @($missing)
}

function Get-NegativeVerdict {
    param([string[]]$Expected, [string[]]$Observed, [int]$GateExit)

    $verdict = [pscustomobject]@{ Reproduced = $false; Id = ''; Detail = '' }

    if ($GateExit -eq 0) {
        $verdict.Id = 'NEGATIVE_NOT_REPRODUCED'
        $verdict.Detail = 'the gate still passed on the induced defect'
        return $verdict
    }

    $missing = @(Get-MissingExpectedIds -Expected $Expected -Observed $Observed)
    if ($missing.Count -eq 0) {
        $verdict.Reproduced = $true
        return $verdict
    }

    # The gate failed, but not with the whole expected set: a partial
    # reproduction (the Csp leg emitting only one of its two ids) is the wrong
    # error, never a pass.
    $observedText = 'none'
    if ($Observed.Count -gt 0) { $observedText = ($Observed -join ',') }
    $verdict.Id = 'NEGATIVE_WRONG_ERROR'
    $verdict.Detail = ('expected ' + (($Expected -join '+')) + ' observed ' + $observedText + ' missing=' + (($missing -join '+')))
    return $verdict
}

function Publish-NegativeVerdict {
    param($Verdict)

    $observedText = 'none'
    if ($script:NegativeObserved.Count -gt 0) { $observedText = ($script:NegativeObserved -join ',') }
    $gateExitText = 'none'
    if ($null -ne $script:NegativeGateExit) { $gateExitText = [string]$script:NegativeGateExit }

    # The expected SET in a stable, greppable form: one id is printed bare,
    # several are joined with '+'.
    $expectedText = ''
    if ($script:NegativeExpected.Count -gt 0) { $expectedText = ($script:NegativeExpected -join '+') }

    Emit ('NEGATIVE_EXPECTED=' + $expectedText)
    Emit ('NEGATIVE_OBSERVED=' + $observedText)
    Emit ('GATE_EXIT=' + $gateExitText)

    if (-not $Verdict.Reproduced) {
        Add-NamedError $Verdict.Id $Verdict.Detail
    }
    return $Verdict.Reproduced
}

# ---- gate mode ---------------------------------------------------------------

function Get-CompanionWindowSecs {
    $window = $CompanionSecs + 30
    if ($window -lt 1) { $window = 1 }
    if ($window -gt 900) { $window = 900 }
    return $window
}

function Get-PlainWindowSecs {
    $window = $WaitSecs
    $needed = $DbReadySecs + 30
    if ($needed -gt $window) { $window = $needed }
    if ($window -lt 1) { $window = 1 }
    if ($window -gt 300) { $window = 300 }
    return $window
}

function Find-ExtractedApp {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) { return '' }
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return '' }
    try {
        $hit = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter 'fredo.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $hit) { return $hit.FullName }
    } catch {
    }
    return ''
}

function New-ProbeArgumentList {
    param(
        [string]$ExePath,
        [string]$RunDir,
        [int]$WindowSecs,
        [switch]$WithHook
    )

    $arguments = New-Object System.Collections.ArrayList
    [void]$arguments.Add('-Exe')
    [void]$arguments.Add($ExePath)
    [void]$arguments.Add('-Ports')
    [void]$arguments.Add((($script:ProbePorts | ForEach-Object { [string]$_ }) -join ','))
    [void]$arguments.Add('-RequireClosed')
    [void]$arguments.Add('-SanitizePath')
    [void]$arguments.Add('-CdpPort')
    [void]$arguments.Add([string]$CdpPort)
    [void]$arguments.Add('-DataDir')
    [void]$arguments.Add($RunDir)
    [void]$arguments.Add('-LogDir')
    [void]$arguments.Add($RunDir)
    [void]$arguments.Add('-WaitSecs')
    [void]$arguments.Add([string]$WindowSecs)
    if ($WithHook) {
        [void]$arguments.Add('-CdpProbe')
        [void]$arguments.Add($script:WindowHook)
    }
    return @($arguments)
}

function Invoke-LaunchProfile {
    param(
        [string]$Profile,
        [string]$ExePath,
        [string]$RunDir,
        [int]$WindowSecs,
        [string]$Assertions,
        [switch]$WithHook
    )

    if (-not (Test-Path -LiteralPath $RunDir -PathType Container)) {
        New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
    }

    if ($Profile -eq 'dirty') {
        # Seed the residue the 0.2.4 class produced: a leftover start.log in the
        # dedicated cluster dir. It must be quarantined (renamed), not deleted.
        $clusterDir = Join-Path $RunDir 'postgres\cluster'
        New-Item -ItemType Directory -Path $clusterDir -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $clusterDir 'start.log'), "seeded by gate-release-artifact.ps1`r`n", $script:GateLogEncoding)
        Emit ('DIRTY_SEEDED=' + (Join-Path $clusterDir 'start.log'))
    }

    $env:GATE_ASSERTIONS = $Assertions

    $reportPath = Join-Path $RunDir 'launch-report.log'
    $reportErrPath = Join-Path $RunDir 'launch-report-stderr.log'
    $arguments = New-ProbeArgumentList -ExePath $ExePath -RunDir $RunDir -WindowSecs $WindowSecs -WithHook:$WithHook

    $child = Invoke-ChildScript -ScriptPath $script:LaunchProbe -ArgumentList $arguments -StdOutPath $reportPath -StdErrPath $reportErrPath
    Write-ChildTranscript ('launch-' + $Profile) $child

    $lines = @()
    if (-not [string]::IsNullOrWhiteSpace($child.StdOut)) { $lines = @($child.StdOut -split "`r?`n") }

    $probeCode = 2
    if ($null -ne $child.ExitCode) { $probeCode = [int]$child.ExitCode }
    $probeVerdict = Get-ProbeVerdict -ExitCode $probeCode -Lines $lines -Ports $script:ProbePorts
    Publish-ProbeVerdict -Verdict $probeVerdict -Profile $Profile -WindowSecs $WindowSecs | Out-Null

    $cdpPath = Join-Path $RunDir 'cdp.json'
    $hookVerdict = Get-HookVerdict -CdpJsonPath $cdpPath
    if ($WithHook) {
        Publish-HookVerdict -Verdict $hookVerdict -Profile $Profile | Out-Null
    }

    return [pscustomobject]@{
        Probe = $probeVerdict
        Hook = $hookVerdict
        Report = $reportPath
        ExitCode = $child.ExitCode
    }
}

function Invoke-GateMode {
    param([string]$OutRoot)

    Reset-RunState

    if ([string]::IsNullOrWhiteSpace($OutRoot)) {
        $OutRoot = Join-Path $script:RepoRoot (Join-Path '.opencode\tmp\release-gate' (Get-Stamp))
    }
    $OutRoot = [System.IO.Path]::GetFullPath($OutRoot)
    if (-not (Test-Path -LiteralPath $OutRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $OutRoot -Force | Out-Null
    }
    $script:GateLogPath = Join-Path $OutRoot 'gate.log'
    [System.IO.File]::WriteAllText($script:GateLogPath, '', $script:GateLogEncoding)

    # The driver OWNS these two run dirs: a leftover cluster in run-fresh would
    # make the "fresh profile" clause a lie, and a leftover quarantine would make
    # the dirty clause vacuous. They are re-created from scratch every run.
    foreach ($leaf in @('run-fresh', 'run-dirty')) {
        $stale = Join-Path $OutRoot $leaf
        if (Test-Path -LiteralPath $stale) {
            Remove-Item -LiteralPath $stale -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Emit ('MODE=gate')
    Emit ('OUTDIR=' + $OutRoot)
    if ($Manual) { Emit 'MANUAL_ENTRY=true' }

    $installerFull = ''
    if (-not [string]::IsNullOrWhiteSpace($Installer)) {
        try { $installerFull = [System.IO.Path]::GetFullPath($Installer) } catch { $installerFull = $Installer }
    }
    Emit ('GATE_INSTALLER=' + $installerFull)

    # ---- precondition funnel (cheap refusals before any minutes are spent) ----
    $preflightOk = $true

    $webview2 = $null
    if ($ForceNoWebView2) {
        $webview2 = [pscustomobject]@{ Ok = $false; Source = ''; Detail = 'forced absent (-ForceNoWebView2)' }
    } else {
        $webview2 = Get-WebView2Evidence -RegistryPaths (Get-DefaultWebView2RegistryPaths) -FolderGlobs (Get-DefaultWebView2FolderGlobs)
    }
    if (-not $webview2.Ok) {
        Add-NamedError 'WEBVIEW2_MISSING' $webview2.Detail
        $preflightOk = $false
    } else {
        Emit ('WEBVIEW2_RUNTIME=' + $webview2.Source)
    }

    if ($CdpPort -lt 1 -or $CdpPort -gt 65535) {
        Add-NamedError 'GATE_REFUSED' ('reason=bad-args detail=-CdpPort ' + $CdpPort)
        $preflightOk = $false
    } elseif (Test-TcpPortListening -Port $CdpPort) {
        Emit ('PRECHECK_CDP_PORT_' + $CdpPort + '=open')
        Add-NamedError 'CDP_PORT_IN_USE' ('port=' + $CdpPort)
        $preflightOk = $false
    } else {
        Emit ('PRECHECK_CDP_PORT_' + $CdpPort + '=closed')
    }

    if (-not $SkipCompanion) {
        $modelsRoot = Get-DefaultModelsRoot
        $models = Get-ModelSetEvidence -Root $modelsRoot -Files $script:ModelFiles
        if (-not $models.Ok) {
            Add-NamedError 'MODEL_SET_MISSING' $models.Missing[0]
            $preflightOk = $false
        } else {
            Emit ('MODEL_SET=' + $models.Base)
        }
    } else {
        Emit 'COMPANION_SKIPPED=true'
    }

    if (-not $preflightOk) {
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }

    # ---- REQ-2.1: extraction + payload, delegated --------------------------
    $script:PayloadDir = Join-Path $OutRoot 'installer-payload'
    if (-not (Test-Path -LiteralPath $script:PayloadDir -PathType Container)) {
        New-Item -ItemType Directory -Path $script:PayloadDir -Force | Out-Null
    }
    $payloadOut = Join-Path $script:PayloadDir 'verifier-stdout.log'
    $payloadErr = Join-Path $script:PayloadDir 'verifier-stderr.log'
    $payloadArgs = @('-Installer', $installerFull, '-WorkDir', $script:PayloadDir)
    if (-not [string]::IsNullOrWhiteSpace($SevenZip)) {
        $payloadArgs += @('-SevenZip', $SevenZip)
    }
    $payloadChild = Invoke-ChildScript -ScriptPath $script:PayloadVerifier -ArgumentList $payloadArgs -StdOutPath $payloadOut -StdErrPath $payloadErr
    Write-ChildTranscript 'installer-payload' $payloadChild

    $payloadLines = @()
    if (-not [string]::IsNullOrWhiteSpace($payloadChild.StdOut)) { $payloadLines = @($payloadChild.StdOut -split "`r?`n") }
    $payloadCode = 1
    if ($null -ne $payloadChild.ExitCode) { $payloadCode = [int]$payloadChild.ExitCode }
    $payloadVerdict = Get-VerifierVerdict -ExitCode $payloadCode -Lines $payloadLines
    $payloadOk = Publish-VerifierVerdict -Verdict $payloadVerdict
    if (-not $payloadOk) {
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $true)
    }

    $appExe = Find-ExtractedApp -Root $script:ExtractRoot
    if ([string]::IsNullOrWhiteSpace($appExe)) {
        Add-NamedError 'EXTRACT_FAILED' ('fredo.exe-not-in-extracted-tree root=' + $script:ExtractRoot)
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $true)
    }
    Emit ('APP_EXE=' + $appExe)

    # ---- fresh profile ------------------------------------------------------
    $script:FreshDir = Join-Path $OutRoot 'run-fresh'
    $freshAssertions = 'styled,database,screenshot'
    if (-not $SkipCompanion) { $freshAssertions = $freshAssertions + ',companion' }
    $freshWindow = $WaitSecs
    if (-not $SkipCompanion) { $freshWindow = Get-CompanionWindowSecs }
    else { $freshWindow = Get-PlainWindowSecs }

    $fresh = Invoke-LaunchProfile -Profile 'fresh' -ExePath $appExe -RunDir $script:FreshDir -WindowSecs $freshWindow -Assertions $freshAssertions -WithHook
    if ($fresh.Hook.Available) {
        $script:CdpJsonFresh = $fresh.Hook
        if (-not [string]::IsNullOrWhiteSpace($fresh.Hook.SurfaceRect)) {
            Add-Check 'REQ-2.8' $true ('SURFACE_RECT=' + $fresh.Hook.SurfaceRect)
        } else {
            Add-Check 'REQ-2.8' $false 'launcher-command-bar not measured (no getBoundingClientRect reading)'
        }
    } else {
        Add-Check 'REQ-2.3' $false 'cdp.json unavailable for profile=fresh'
        Add-Check 'REQ-2.3-screenshot' $false 'cdp.json unavailable for profile=fresh'
        Add-Check 'REQ-2.8' $false 'cdp.json unavailable for profile=fresh'
        if (-not $SkipCompanion) { Add-Check 'REQ-2.5' $false 'cdp.json unavailable for profile=fresh' }
    }

    # ---- REQ-2.6: the app ports stay closed (probe -RequireClosed) -----------
    $portParts = New-Object System.Collections.ArrayList
    $portsOk = $true
    foreach ($port in $script:ProbePorts) {
        if ($fresh.Probe.PortsOpen -contains $port) {
            $portsOk = $false
            [void]$portParts.Add(('port_{0}=open' -f $port))
        } else {
            [void]$portParts.Add(('port_{0}=closed' -f $port))
        }
    }
    Add-Check 'REQ-2.6' $portsOk ($portParts -join ' ')

    # ---- dirty profile ------------------------------------------------------
    $script:DirtyDir = Join-Path $OutRoot 'run-dirty'
    $dirtyWindow = Get-PlainWindowSecs
    $dirty = Invoke-LaunchProfile -Profile 'dirty' -ExePath $appExe -RunDir $script:DirtyDir -WindowSecs $dirtyWindow -Assertions 'database,screenshot' -WithHook

    $dbOk = Publish-DbCheck

    if ($dbOk -and $null -ne $script:DbFacts['dirty'] -and $script:DbFacts['dirty'].Ok) {
        $quarantine = Test-QuarantineEvidence -DataDir $script:DirtyDir
        Publish-Quarantine -Quarantine $quarantine | Out-Null
    }

    # ---- REQ-2.7: the evidence set ------------------------------------------
    $evidence = Test-EvidenceSet -OutDir $OutRoot
    Publish-EvidenceSet -Evidence $evidence | Out-Null

    return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $true)
}

# ---- negative mode -----------------------------------------------------------
# PRE-WIRED DISPATCH (ST-4 owns the module). The contract this driver expects:
#
#   Export a function `Invoke-NegativeLeg` with parameters
#     -Name        'MissingDll' | 'Csp' | 'Database'   (validated by the driver)
#     -Installer   absolute path to the produced installer
#     -OutDir      absolute evidence root to write `negative-<leg>/` under
#     -CdpPort     the DevTools port to use
#     -WaitSecs    the launch window the driver would use
#     -DbReadySecs the DB-ready bound
#     -SkipCompanion  switch (forwarded verbatim)
#     -SevenZip    optional 7z override (forwarded verbatim)
#     -DriverPath  absolute path to THIS script (so the leg can re-enter it)
#   Returning an object with
#     Observed (string[] of `ID` or `ID:<detail>` emitted by the inner gate)
#     GateExit (int, the inner gate's own exit code)
#   Anything else (a missing export, a throw) is reported as GATE_REFUSED.
#
#   The DRIVER owns the verdict, and its expectation is a SET: the Csp leg must
#   reproduce BOTH `CSP_VIOLATION` AND `UNSTYLED` (REQ-3.2a / QA F-15) - a leg
#   that induced only one of them is the wrong error, not a pass. A module that
#   also returns an `Expected` array is NOT consulted: the driver's table is the
#   single source of the contract.

function Invoke-NegativeMode {
    param([string]$OutRoot)

    Reset-RunState

    if ([string]::IsNullOrWhiteSpace($OutRoot)) {
        $OutRoot = Join-Path $script:RepoRoot (Join-Path '.opencode\tmp\release-gate' (Get-Stamp))
    }
    $OutRoot = [System.IO.Path]::GetFullPath($OutRoot)
    if (-not (Test-Path -LiteralPath $OutRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $OutRoot -Force | Out-Null
    }
    $script:GateLogPath = Join-Path $OutRoot 'gate.log'
    [System.IO.File]::WriteAllText($script:GateLogPath, '', $script:GateLogEncoding)

    Emit 'MODE=negative'
    Emit ('OUTDIR=' + $OutRoot)
    Emit ('NEGATIVE_LEG=' + $Negative)
    if ($Manual) { Emit 'MANUAL_ENTRY=true' }

    $installerFull = ''
    if (-not [string]::IsNullOrWhiteSpace($Installer)) {
        try { $installerFull = [System.IO.Path]::GetFullPath($Installer) } catch { $installerFull = $Installer }
    }
    Emit ('GATE_INSTALLER=' + $installerFull)

    $allowed = @('MissingDll', 'Csp', 'Database')
    if ($allowed -notcontains $Negative) {
        Add-NamedError 'GATE_REFUSED' ('reason=bad-args detail=-Negative must be one of ' + ($allowed -join '|'))
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }
    if ([string]::IsNullOrWhiteSpace($installerFull)) {
        Add-NamedError 'GATE_REFUSED' 'reason=bad-args detail=-Installer is required'
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }

    if (-not (Test-Path -LiteralPath $script:NegativeModulePath -PathType Leaf)) {
        Add-NamedError 'GATE_REFUSED' ('reason=NEGATIVE_MODULE_MISSING path=' + $script:NegativeModulePath)
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }

    $imported = $false
    try {
        Import-Module $script:NegativeModulePath -Force -ErrorAction Stop
        $imported = $true
    } catch {
        Add-NamedError 'GATE_REFUSED' ('reason=NEGATIVE_MODULE_MISSING detail=' + $_.Exception.Message)
    }
    if (-not $imported) {
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }

    $command = Get-Command -Name 'Invoke-NegativeLeg' -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Add-NamedError 'GATE_REFUSED' 'reason=NEGATIVE_MODULE_MISSING function=Invoke-NegativeLeg'
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }

    $script:NegativeExpected = @(Get-ExpectedNegativeId -Name $Negative)

    $legResult = $null
    try {
        $legResult = Invoke-NegativeLeg -Name $Negative -Installer $installerFull -OutDir $OutRoot -CdpPort $CdpPort -WaitSecs (Get-PlainWindowSecs) -DbReadySecs $DbReadySecs -SkipCompanion:$SkipCompanion -SevenZip $SevenZip -DriverPath $PSCommandPath
    } catch {
        Add-NamedError 'GATE_REFUSED' ('reason=NEGATIVE_LEG_ERROR detail=' + $_.Exception.Message)
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }

    if ($null -eq $legResult) {
        Add-NamedError 'GATE_REFUSED' 'reason=NEGATIVE_LEG_ERROR detail=Invoke-NegativeLeg returned nothing'
        return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
    }

    $observed = @()
    if ($null -ne $legResult.PSObject.Properties['Observed']) {
        foreach ($entry in @($legResult.Observed)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$entry)) { $observed += [string]$entry }
        }
    }
    $script:NegativeObserved = $observed
    $script:NegativeGateExit = 0
    if ($null -ne $legResult.PSObject.Properties['GateExit']) { $script:NegativeGateExit = [int]$legResult.GateExit }

    $negativeVerdict = Get-NegativeVerdict -Expected $script:NegativeExpected -Observed $observed -GateExit $script:NegativeGateExit
    Publish-NegativeVerdict -Verdict $negativeVerdict | Out-Null

    return (Complete-Run -OutRoot $OutRoot -Installers $installerFull -ChecksExpected $false)
}

# ---- receipt -----------------------------------------------------------------

function Get-InstallerVersion {
    param([string]$FileName)
    if ($FileName -match '_(\d+\.\d+\.\d+)_') { return $Matches[1] }
    return ''
}

function New-InstallerBlock {
    param([string]$Path)
    $block = [ordered]@{}
    if ([string]::IsNullOrWhiteSpace($Path)) { return $block }
    $block['path'] = $Path
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $item = Get-Item -LiteralPath $Path
        $block['fileName'] = $item.Name
        $block['sha256'] = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        $block['bytes'] = [int64]$item.Length
        $version = Get-InstallerVersion -FileName $item.Name
        if (-not [string]::IsNullOrWhiteSpace($version)) { $block['version'] = $version }
    }
    return $block
}

function New-EvidenceBlock {
    param([string]$OutRoot)

    $evidence = [ordered]@{}
    $evidence['gateLog'] = 'gate.log'
    if (-not [string]::IsNullOrWhiteSpace($script:PayloadDir)) { $evidence['payloadWorkDir'] = 'installer-payload' }

    if (-not [string]::IsNullOrWhiteSpace($script:FreshDir)) {
        $evidence['fresh'] = [ordered]@{
            logDir = 'run-fresh'
            screenshot = 'run-fresh/screenshot.png'
            cdp = 'run-fresh/cdp.json'
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($script:DirtyDir)) {
        $evidence['dirty'] = [ordered]@{
            logDir = 'run-dirty'
            screenshot = 'run-dirty/screenshot.png'
            cdp = 'run-dirty/cdp.json'
        }
    }
    if ($Mode -eq 'negative' -and -not [string]::IsNullOrWhiteSpace($Negative)) {
        $leaf = 'negative-' + (($Negative -replace '([a-z])([A-Z])', '$1-$2').ToLowerInvariant())
        $evidence['negative'] = $leaf
    }
    return $evidence
}

function New-CdpBlock {
    $cdp = [ordered]@{
        port = $CdpPort
        endpoint = ('http://127.0.0.1:' + $CdpPort)
        targets = 0
    }
    if ($null -ne $script:CdpJsonFresh) {
        $cdp['targets'] = [int]$script:CdpJsonFresh.Targets
        if (-not [string]::IsNullOrWhiteSpace($script:CdpJsonFresh.WebSocketDebuggerUrl)) {
            $cdp['webSocketDebuggerUrl'] = $script:CdpJsonFresh.WebSocketDebuggerUrl
        }
        if (-not [string]::IsNullOrWhiteSpace($script:SurfaceRect)) {
            $cdp['surfaceRect'] = $script:SurfaceRect
        }
    }
    return $cdp
}

function Complete-Run {
    param([string]$OutRoot, [string]$Installers, [bool]$ChecksExpected)

    $code = Get-FinalExitCode
    $verdict = Get-VerdictText -Code $code

    Emit ('VERDICT=' + $verdict)

    $errors = New-Object System.Collections.ArrayList
    foreach ($entry in $script:CoarseErrors) {
        [void]$errors.Add([ordered]@{ id = $entry.id; detail = $entry.detail })
    }

    $checks = New-Object System.Collections.ArrayList
    foreach ($entry in $script:Checks) {
        [void]$checks.Add([ordered]@{ id = $entry.id; name = $entry.name; ok = $entry.ok; detail = $entry.detail })
    }

    $receipt = [ordered]@{}
    $receipt['schemaVersion'] = 1
    $receipt['mode'] = $Mode
    if (-not [string]::IsNullOrWhiteSpace($Negative)) { $receipt['negative'] = $Negative }
    $receipt['manual'] = [bool]$Manual
    $receipt['startedUtc'] = $script:StartedAt.ToUniversalTime().ToString('o')
    $receipt['durationSeconds'] = [Math]::Round(((Get-Date) - $script:StartedAt).TotalSeconds, 1)
    $receipt['installer'] = (New-InstallerBlock -Path $Installers)
    $receipt['verdict'] = $verdict
    $receipt['exitCode'] = $code
    $receipt['checks'] = $checks
    if ($errors.Count -gt 0) { $receipt['errors'] = $errors }
    $receipt['cdp'] = (New-CdpBlock)
    $receipt['evidence'] = (New-EvidenceBlock -OutRoot $OutRoot)

    $receiptPath = Join-Path $OutRoot 'receipt.json'
    try {
        Write-JsonFile -Path $receiptPath -Value $receipt
        Emit ('RECEIPT=' + $receiptPath)
    } catch {
        Emit ('RECEIPT_WRITE_FAILED=' + $_.Exception.Message)
    }

    return $code
}

# ---- self-test ---------------------------------------------------------------

# A captured run: Emit is buffered, run state is reset, and the body's return value
# is the exit code. Every control drives the SAME publish functions the entry path
# uses, so a control cannot pass against a mechanism the real run does not use.
function Invoke-Captured {
    param([scriptblock]$Body)

    $script:Captured = New-Object System.Collections.ArrayList
    $savedGateLogPath = $script:GateLogPath
    Reset-RunState
    $code = 99
    try {
        $code = & $Body
        if ($null -eq $code) { $code = Get-FinalExitCode }
    } catch {
        [void]$script:Captured.Add('SELFTEST_EXCEPTION ' + $_.Exception.Message)
    }
    $lines = @($script:Captured)
    $ids = @()
    foreach ($entry in $script:CoarseErrors) { $ids += [string]$entry.id }
    $script:Captured = $null
    $script:GateLogPath = $savedGateLogPath
    return [pscustomobject]@{ Code = $code; Lines = $lines; Ids = $ids }
}

function New-CdpFixture {
    param(
        [string]$Dir,
        [object[]]$Errors = @(),
        [object[]]$Checks = @(),
        $Db = $null,
        $Companion = $null,
        $Screenshot = $null,
        [string]$SurfaceRect = '',
        [string]$Profile = 'fresh'
    )

    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    }

    $fixture = [ordered]@{
        schemaVersion = 1
        profile = $Profile
        gateExe = 'fixture'
        dataDir = $Dir
        cdpPort = 9333
        assertions = 'styled,database,screenshot,companion'
        startedUtc = (Get-Date).ToUniversalTime().ToString('o')
        durationSeconds = 1
        endpoint = 'http://127.0.0.1:9333'
        targets = 1
        webSocketDebuggerUrl = 'ws://127.0.0.1:9333/devtools/page/FIXTURE'
        checks = @($Checks)
        errors = @($Errors)
    }
    if ($null -ne $Db) { $fixture['db'] = $Db }
    if ($null -ne $Companion) { $fixture['companion'] = $Companion }
    if ($null -ne $Screenshot) { $fixture['screenshot'] = $Screenshot }
    if (-not [string]::IsNullOrWhiteSpace($SurfaceRect)) { $fixture['surfaceRect'] = $SurfaceRect }

    $path = Join-Path $Dir 'cdp.json'
    Write-JsonFile -Path $path -Value $fixture
    return $path
}

function New-ControlLine {
    param([string]$Id, [string]$Label, [bool]$Passed, [string]$Detail = '')
    Emit ('CONTROL ' + $Id + ' - ' + $Label)
    if ($Passed) {
        if ([string]::IsNullOrWhiteSpace($Detail)) { Emit '[PASS]' }
        else { Emit ('[PASS] ' + $Detail) }
    } else {
        if ([string]::IsNullOrWhiteSpace($Detail)) { Emit '[FAIL] (no detail)' }
        else { Emit ('[FAIL] ' + $Detail) }
    }
}

function Invoke-SelfTest {
    $rootTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('fredo-release-gate-selftest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $rootTemp -Force | Out-Null

    $script:GateLogPath = ''
    $failures = 0

    Emit '=== gate-release-artifact : SelfTest ==='
    Emit 'SELFTEST=hermetic (no installer, no model, no GUI, no network)'

    try {
        # ---------- 1. EXTRACT_FAILED (refused class) ----------------------
        $run = Invoke-Captured {
            $v = Get-VerifierVerdict -ExitCode 2 -Lines @('EXTRACT_ROUTES=none', 'RESULT=FAIL', 'ERROR=EXTRACTOR_MISSING tried=none')
            Publish-VerifierVerdict -Verdict $v | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 2) -and ($run.Ids -contains 'EXTRACT_FAILED') -and (Test-ContainsLine $run.Lines 'EXTRACT_FAILED:EXTRACTOR_MISSING')
        New-ControlLine 'EXTRACT_FAILED' 'no extraction route refuses (exit 2)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 2. PAYLOAD_MISSING (fail class) ------------------------
        $run = Invoke-Captured {
            $v = Get-VerifierVerdict -ExitCode 1 -Lines @('EXTRACTOR=7z-on-path status=hit', 'EXTRACT_ROOT=C:\fixture\extracted', 'PAYLOAD_PRESENT=llama.dll', 'PAYLOAD_MISSING=llama-common.dll', 'RESULT=FAIL', 'ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT missing=llama-common.dll')
            Publish-VerifierVerdict -Verdict $v | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'PAYLOAD_MISSING') -and (Test-ContainsLine $run.Lines 'PAYLOAD_MISSING:llama-common.dll')
        New-ControlLine 'PAYLOAD_MISSING' 'a manifest core DLL absent from the artifact fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 3. LAUNCH_EXIT (fail class) ----------------------------
        $run = Invoke-Captured {
            $v = Get-ProbeVerdict -ExitCode 1 -Lines @('PID=4242', 'HAS_EXITED=True', 'EXIT_CODE=-1073741515', 'PORT_9223=closed', 'BRIDGE_LOG_HITS=0', 'ORPHANS_LEFT=0', 'RESULT=FAIL') -Ports @(9223, 16932, 19631)
            Publish-ProbeVerdict -Verdict $v -Profile 'fresh' -WindowSecs 90 | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'LAUNCH_EXIT') -and (Test-ContainsLine $run.Lines 'LAUNCH_EXIT:-1073741515')
        New-ControlLine 'LAUNCH_EXIT' 'an app that exits 0xC0000135 inside the window fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 4. LAUNCH_NOT_RUNNING (fail class) ---------------------
        $run = Invoke-Captured {
            $v = Get-ProbeVerdict -ExitCode 2 -Lines @('ERROR: launch failed: CreateProcessW error=5', 'RESULT=REFUSED') -Ports @(9223, 16932, 19631)
            Publish-ProbeVerdict -Verdict $v -Profile 'fresh' -WindowSecs 90 | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'LAUNCH_NOT_RUNNING')
        New-ControlLine 'LAUNCH_NOT_RUNNING' 'no process could be launched fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 5. UNSTYLED (fail class) -------------------------------
        $styDir = Join-Path $rootTemp 'cdp-unstyled'
        $null = New-CdpFixture -Dir $styDir -Profile 'fresh' `
            -Errors @(@{ id = 'UNSTYLED'; detail = 'injected style produced 0 rules' }) `
            -Checks @(@{ id = 'REQ-2.3'; ok = $false; detail = 'injectedRules=0' }) `
            -Screenshot @{ criteria = @{ S1 = $true; S2 = $true; S3 = $true; S4 = $true; S5 = $true; S6 = $true } }
        $run = Invoke-Captured {
            $v = Get-HookVerdict -CdpJsonPath (Join-Path $styDir 'cdp.json')
            Publish-HookVerdict -Verdict $v -Profile 'fresh' | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'UNSTYLED') -and (Test-ContainsLine $run.Lines 'UNSTYLED:')
        New-ControlLine 'UNSTYLED' 'a failed style assertion fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 6. CSP_VIOLATION (fail class) --------------------------
        $cspDir = Join-Path $rootTemp 'cdp-csp'
        $null = New-CdpFixture -Dir $cspDir -Profile 'fresh' `
            -Errors @(@{ id = 'UNSTYLED'; detail = 'screenshot-frame S4=false' }, @{ id = 'CSP_VIOLATION'; detail = '122 violation(s)' }) `
            -Checks @(@{ id = 'REQ-2.3'; ok = $false; detail = 'violations=122' }, @{ id = 'REQ-2.3-screenshot'; ok = $false; detail = 'S4=false' })
        $run = Invoke-Captured {
            $v = Get-HookVerdict -CdpJsonPath (Join-Path $cspDir 'cdp.json')
            Publish-HookVerdict -Verdict $v -Profile 'fresh' | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'CSP_VIOLATION') -and (Test-ContainsLine $run.Lines 'CSP_VIOLATION:')
        New-ControlLine 'CSP_VIOLATION' 'a recorded CSP violation fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 7. DB_NOT_READY (fail class) --------------------------
        $dbDir = Join-Path $rootTemp 'cdp-db'
        $null = New-CdpFixture -Dir $dbDir -Profile 'dirty' `
            -Errors @(@{ id = 'DB_NOT_READY'; detail = 'dirty' }) `
            -Checks @(@{ id = 'REQ-2.4'; ok = $false; detail = 'profile=dirty state=failed' })
        $run = Invoke-Captured {
            $v = Get-HookVerdict -CdpJsonPath (Join-Path $dbDir 'cdp.json')
            Publish-HookVerdict -Verdict $v -Profile 'dirty' | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'DB_NOT_READY') -and (Test-ContainsLine $run.Lines 'DB_NOT_READY:dirty')
        New-ControlLine 'DB_NOT_READY' 'a profile that never reaches ready fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 8. DB_QUARANTINE_MISSING (fail class) -----------------
        $qDir = Join-Path $rootTemp 'quarantine-absent'
        New-Item -ItemType Directory -Path (Join-Path $qDir 'postgres\cluster') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $qDir 'postgres\cluster\start.log'), 'residue', $script:GateLogEncoding)
        $run = Invoke-Captured {
            $v = Test-QuarantineEvidence -DataDir $qDir
            Publish-Quarantine -Quarantine $v | Out-Null
            Get-FinalExitCode
        }
        $okAbsent = ($run.Code -eq 1) -and ($run.Ids -contains 'DB_QUARANTINE_MISSING')
        # non-vacuity: a quarantined sibling IS found and reported
        $qDir2 = Join-Path $rootTemp 'quarantine-present'
        New-Item -ItemType Directory -Path (Join-Path $qDir2 'postgres\cluster.rejected-1700000000') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $qDir2 'postgres\cluster.rejected-1700000000\start.log'), 'residue', $script:GateLogEncoding)
        $run2 = Invoke-Captured {
            $v = Test-QuarantineEvidence -DataDir $qDir2
            Publish-Quarantine -Quarantine $v | Out-Null
            Get-FinalExitCode
        }
        $okPresent = ($run2.Code -eq 0) -and (Test-ContainsLine $run2.Lines 'QUARANTINE_EVIDENCE=')
        $ok = $okAbsent -and $okPresent
        New-ControlLine 'DB_QUARANTINE_MISSING' 'ready without a rejected sibling fails; a renamed sibling passes' $ok ("absent-exit=$($run.Code) ids=$($run.Ids -join ',') present-exit=$($run2.Code)")
        if (-not $ok) { $failures++ }

        # ---------- 9. COMPANION_NO_REPLY (fail class) --------------------
        $cnrDir = Join-Path $rootTemp 'cdp-companion-noreply'
        $null = New-CdpFixture -Dir $cnrDir -Profile 'fresh' `
            -Errors @(@{ id = 'COMPANION_NO_REPLY'; detail = '' }) `
            -Checks @(@{ id = 'REQ-2.5'; ok = $false; detail = 'route=ui replyChars=0' })
        $run = Invoke-Captured {
            $v = Get-HookVerdict -CdpJsonPath (Join-Path $cnrDir 'cdp.json')
            Publish-HookVerdict -Verdict $v -Profile 'fresh' | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'COMPANION_NO_REPLY')
        New-ControlLine 'COMPANION_NO_REPLY' 'no rendered reply within the bound fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 10. COMPANION_ENGINE (fail class) ---------------------
        $cengDir = Join-Path $rootTemp 'cdp-companion-engine'
        $null = New-CdpFixture -Dir $cengDir -Profile 'fresh' `
            -Errors @(@{ id = 'COMPANION_ENGINE'; detail = 'ENGINE_OOM' }) `
            -Checks @(@{ id = 'REQ-2.5'; ok = $false; detail = 'route=ipc replyChars=0' })
        $run = Invoke-Captured {
            $v = Get-HookVerdict -CdpJsonPath (Join-Path $cengDir 'cdp.json')
            Publish-HookVerdict -Verdict $v -Profile 'fresh' | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'COMPANION_ENGINE') -and (Test-ContainsLine $run.Lines 'COMPANION_ENGINE:ENGINE_OOM')
        New-ControlLine 'COMPANION_ENGINE' 'a typed engine failure fails with its code (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 11. MCP_PORT_OPEN (fail class) ------------------------
        $run = Invoke-Captured {
            $v = Get-ProbeVerdict -ExitCode 1 -Lines @('PID=4242', 'HAS_EXITED=False', 'PORT_9223=closed', 'PORT_16932=open', 'PORT_19631=closed', 'BRIDGE_LOG_HITS=0', 'ORPHANS_LEFT=0', 'FAILURE=port-open:16932', 'RESULT=FAIL') -Ports @(9223, 16932, 19631)
            Publish-ProbeVerdict -Verdict $v -Profile 'fresh' -WindowSecs 90 | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'MCP_PORT_OPEN') -and (Test-ContainsLine $run.Lines 'MCP_PORT_OPEN:16932')
        New-ControlLine 'MCP_PORT_OPEN' 'a probed port accepting a connection fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 12. MCP_BRIDGE_LOG_LINE (fail class) ------------------
        $run = Invoke-Captured {
            $v = Get-ProbeVerdict -ExitCode 1 -Lines @('PID=4242', 'HAS_EXITED=False', 'PORT_9223=closed', 'BRIDGE_LOG_HITS=1', 'ORPHANS_LEFT=0', 'FAILURE=bridge-log-line', 'RESULT=FAIL') -Ports @(9223, 16932, 19631)
            Publish-ProbeVerdict -Verdict $v -Profile 'fresh' -WindowSecs 90 | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'MCP_BRIDGE_LOG_LINE')
        New-ControlLine 'MCP_BRIDGE_LOG_LINE' 'the MCP bridge log line fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 13. EVIDENCE_MISSING (fail class) ---------------------
        $evDir = Join-Path $rootTemp 'evidence-missing'
        New-Item -ItemType Directory -Path (Join-Path $evDir 'run-fresh') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $evDir 'run-dirty') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $evDir 'gate.log'), "log`r`n", $script:GateLogEncoding)
        foreach ($rel in @('run-fresh\stdout.log', 'run-fresh\stderr.log', 'run-fresh\launch-report.log', 'run-fresh\cdp.json', 'run-dirty\stdout.log', 'run-dirty\stderr.log', 'run-dirty\launch-report.log', 'run-dirty\cdp.json')) {
            [System.IO.File]::WriteAllText((Join-Path $evDir $rel), "x`r`n", $script:GateLogEncoding)
        }
        $run = Invoke-Captured {
            $v = Test-EvidenceSet -OutDir $evDir
            Publish-EvidenceSet -Evidence $v | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'EVIDENCE_MISSING') -and (Test-ContainsLine $run.Lines 'EVIDENCE_MISSING:screenshot')
        New-ControlLine 'EVIDENCE_MISSING' 'a missing screenshot fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 14. CDP_UNAVAILABLE (fail class) ----------------------
        $run = Invoke-Captured {
            $v = Get-HookVerdict -CdpJsonPath (Join-Path $rootTemp 'does-not-exist\cdp.json')
            Publish-HookVerdict -Verdict $v -Profile 'fresh' | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'CDP_UNAVAILABLE')
        New-ControlLine 'CDP_UNAVAILABLE' 'no DevTools reading at all fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 15. WEBVIEW2_MISSING (refused class) ------------------
        $wvAbsent = Get-WebView2Evidence -RegistryPaths @() -FolderGlobs @()
        $wvStubDir = Join-Path $rootTemp 'webview2'
        New-Item -ItemType Directory -Path $wvStubDir -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $wvStubDir 'msedgewebview2.exe'), 'stub', $script:GateLogEncoding)
        $wvPresent = Get-WebView2Evidence -RegistryPaths @() -FolderGlobs @((Join-Path $wvStubDir 'msedgewebview2.exe'))
        $run = Invoke-Captured {
            if ($wvAbsent.Ok) { Add-NamedError 'WEBVIEW2_MISSING' 'control' } else { Add-NamedError 'WEBVIEW2_MISSING' $wvAbsent.Detail }
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 2) -and ($run.Ids -contains 'WEBVIEW2_MISSING') -and (-not $wvAbsent.Ok) -and $wvPresent.Ok
        New-ControlLine 'WEBVIEW2_MISSING' 'an absent runtime refuses (exit 2); a present candidate passes' $ok ("exit=$($run.Code) absent=$($wvAbsent.Ok) present=$($wvPresent.Ok)")
        if (-not $ok) { $failures++ }

        # ---------- 16. MODEL_SET_MISSING (refused class) -----------------
        $modelEmpty = Join-Path $rootTemp 'models-empty'
        New-Item -ItemType Directory -Path $modelEmpty -Force | Out-Null
        $modelFull = Join-Path $rootTemp 'models-full'
        $modelFullSub = Join-Path $modelFull $script:ModelSubdir
        New-Item -ItemType Directory -Path (Join-Path $modelFullSub 'MTP') -Force | Out-Null
        foreach ($file in $script:ModelFiles) {
            [System.IO.File]::WriteAllText((Join-Path $modelFullSub $file), 'stub', $script:GateLogEncoding)
        }
        $modelsAbsent = Get-ModelSetEvidence -Root $modelEmpty -Files $script:ModelFiles
        $modelsPresent = Get-ModelSetEvidence -Root $modelFull -Files $script:ModelFiles
        $run = Invoke-Captured {
            Add-NamedError 'MODEL_SET_MISSING' $modelsAbsent.Missing[0]
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 2) -and ($run.Ids -contains 'MODEL_SET_MISSING') -and (-not $modelsAbsent.Ok) -and $modelsPresent.Ok -and (Test-ContainsLine $run.Lines 'MODEL_SET_MISSING:')
        New-ControlLine 'MODEL_SET_MISSING' 'an absent model trio refuses (exit 2); a complete trio passes' $ok ("exit=$($run.Code) absent=$($modelsAbsent.Ok) present=$($modelsPresent.Ok)")
        if (-not $ok) { $failures++ }

        # ---------- 17. CDP_PORT_IN_USE (refused class) -------------------
        $listener = $null
        $busyPort = 0
        try {
            $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
            $listener.Start()
            $busyPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
            $busySeen = Test-TcpPortListening -Port $busyPort
        } catch {
            $busySeen = $false
        }
        $run = Invoke-Captured {
            Add-NamedError 'CDP_PORT_IN_USE' ('port=' + $busyPort)
            Get-FinalExitCode
        }
        if ($null -ne $listener) {
            try { $listener.Stop() } catch { }
        }
        $freeSeen = Test-TcpPortListening -Port $busyPort
        $ok = ($run.Code -eq 2) -and ($run.Ids -contains 'CDP_PORT_IN_USE') -and $busySeen -and (-not $freeSeen)
        New-ControlLine 'CDP_PORT_IN_USE' 'a bound DevTools port refuses (exit 2); the check flips when released' $ok ("exit=$($run.Code) busy=$busySeen free=$freeSeen port=$busyPort")
        if (-not $ok) { $failures++ }

        # ---------- 18. NEGATIVE_NOT_REPRODUCED (fail class) --------------
        $expected = @(Get-ExpectedNegativeId -Name 'MissingDll')
        $run = Invoke-Captured {
            $script:NegativeExpected = $expected
            $script:NegativeObserved = @()
            $script:NegativeGateExit = 0
            $v = Get-NegativeVerdict -Expected $expected -Observed @() -GateExit 0
            Publish-NegativeVerdict -Verdict $v | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'NEGATIVE_NOT_REPRODUCED') -and (Test-ContainsLine $run.Lines 'NEGATIVE_EXPECTED=') -and (Test-ContainsLine $run.Lines 'GATE_EXIT=')
        New-ControlLine 'NEGATIVE_NOT_REPRODUCED' 'a leg whose induced defect still passes fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 19. NEGATIVE_WRONG_ERROR (fail class) -----------------
        $run = Invoke-Captured {
            $script:NegativeExpected = $expected
            $script:NegativeObserved = @('CSP_VIOLATION:some violation')
            $script:NegativeGateExit = 1
            $v = Get-NegativeVerdict -Expected $expected -Observed @('CSP_VIOLATION:some violation') -GateExit 1
            Publish-NegativeVerdict -Verdict $v | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 1) -and ($run.Ids -contains 'NEGATIVE_WRONG_ERROR')
        New-ControlLine 'NEGATIVE_WRONG_ERROR' 'a leg failing with another id fails (exit 1)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 19a. CSP_PAIR_PARTIAL (REQ-3.2a / QA F-15) ------------
        # The Csp leg owes BOTH ids. A partial reproduction (CSP_VIOLATION only,
        # or UNSTYLED only) must be NEGATIVE_WRONG_ERROR, never an accepted leg.
        $cspExpected = @(Get-ExpectedNegativeId -Name 'Csp')
        $cspExpectedSetOk = ($cspExpected.Count -eq 2) -and ($cspExpected -contains 'CSP_VIOLATION') -and ($cspExpected -contains 'UNSTYLED')
        $runCspOnly = Invoke-Captured {
            $script:NegativeExpected = $cspExpected
            $script:NegativeObserved = @('CSP_VIOLATION: 122 recorded')
            $script:NegativeGateExit = 1
            $v = Get-NegativeVerdict -Expected $cspExpected -Observed @('CSP_VIOLATION: 122 recorded') -GateExit 1
            Publish-NegativeVerdict -Verdict $v | Out-Null
            Get-FinalExitCode
        }
        $runStyledOnly = Invoke-Captured {
            $script:NegativeExpected = $cspExpected
            $script:NegativeObserved = @('UNSTYLED: injected style produced 0 rules')
            $script:NegativeGateExit = 1
            $v = Get-NegativeVerdict -Expected $cspExpected -Observed @('UNSTYLED: injected style produced 0 rules') -GateExit 1
            Publish-NegativeVerdict -Verdict $v | Out-Null
            Get-FinalExitCode
        }
        $ok = $cspExpectedSetOk -and
              ($runCspOnly.Code -eq 1) -and
              ($runCspOnly.Ids -contains 'NEGATIVE_WRONG_ERROR') -and
              (Test-ContainsLine $runCspOnly.Lines 'missing=UNSTYLED') -and
              (Test-ContainsLine $runCspOnly.Lines 'NEGATIVE_EXPECTED=CSP_VIOLATION+UNSTYLED') -and
              ($runStyledOnly.Code -eq 1) -and
              ($runStyledOnly.Ids -contains 'NEGATIVE_WRONG_ERROR') -and
              (Test-ContainsLine $runStyledOnly.Lines 'missing=CSP_VIOLATION')
        New-ControlLine 'CSP_PAIR_PARTIAL' 'one half of the CSP/UNSTYLED pair is the wrong error (exit 1)' $ok ("expected=$($cspExpected -join '+') csp-only-exit=$($runCspOnly.Code) styled-only-exit=$($runStyledOnly.Code)")
        if (-not $ok) { $failures++ }

        # ---------- 19b. CSP_PAIR_FULL (REQ-3.2a / QA F-15) ----------------
        # Both ids observed => the leg reproduced: exit 0, no named error, and the
        # full expected set printed in its stable greppable form.
        $runPair = Invoke-Captured {
            $script:NegativeExpected = $cspExpected
            $script:NegativeObserved = @('CSP_VIOLATION: 122 recorded', 'UNSTYLED: injected style produced 0 rules')
            $script:NegativeGateExit = 1
            $v = Get-NegativeVerdict -Expected $cspExpected -Observed @('CSP_VIOLATION: 122 recorded', 'UNSTYLED: injected style produced 0 rules') -GateExit 1
            Publish-NegativeVerdict -Verdict $v | Out-Null
            Get-FinalExitCode
        }
        $ok = ($runPair.Code -eq 0) -and
              ($runPair.Ids.Count -eq 0) -and
              (Test-ContainsLine $runPair.Lines 'NEGATIVE_EXPECTED=CSP_VIOLATION+UNSTYLED') -and
              (Test-ContainsLine $runPair.Lines 'NEGATIVE_OBSERVED=CSP_VIOLATION: 122 recorded,UNSTYLED: injected style produced 0 rules') -and
              (Test-ContainsLine $runPair.Lines 'GATE_EXIT=1')
        New-ControlLine 'CSP_PAIR_FULL' 'both halves of the CSP/UNSTYLED pair reproduce the leg (exit 0)' $ok ("exit=$($runPair.Code) ids=$($runPair.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 20. GATE_REFUSED (dispatch) ---------------------------
        # Drives the REAL dispatch with a module path that does not exist, so the
        # refusal is proven reachable from the entry path, not merely callable.
        $savedModule = $script:NegativeModulePath
        $savedNegative = $script:Negative
        $savedInstaller = $script:Installer
        $stubInstaller = Join-Path $rootTemp 'stub-setup.exe'
        [System.IO.File]::WriteAllText($stubInstaller, 'stub', $script:GateLogEncoding)
        $script:NegativeModulePath = Join-Path $rootTemp 'missing\gate-artifact-negative.psm1'
        $script:Negative = 'MissingDll'
        $script:Installer = $stubInstaller
        $run = Invoke-Captured {
            Invoke-NegativeMode -OutRoot (Join-Path $rootTemp 'negative-dispatch')
        }
        $script:NegativeModulePath = $savedModule
        $script:Negative = $savedNegative
        $script:Installer = $savedInstaller
        $ok = ($run.Code -eq 2) -and ($run.Ids -contains 'GATE_REFUSED') -and (Test-ContainsLine $run.Lines 'reason=NEGATIVE_MODULE_MISSING')
        New-ControlLine 'GATE_REFUSED' 'a missing negative-leg module is a clean refusal (exit 2)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }

        # ---------- 21. CLEAN-PASS (non-vacuity) --------------------------
        $cleanDir = Join-Path $rootTemp 'cdp-clean'
        $null = New-CdpFixture -Dir $cleanDir -Profile 'fresh' `
            -Errors @() `
            -Checks @(
                @{ id = 'REQ-2.3'; ok = $true; detail = 'rules=612 floor=1 font=Inter accent=#8b5cf6 violations=0 injectedRules=1' },
                @{ id = 'REQ-2.3-screenshot'; ok = $true; detail = 'S1=true S2=true S3=true S4=true S5=true S6=true viewport=1400x900 readyMs=1840' },
                @{ id = 'REQ-2.4'; ok = $true; detail = 'profile=fresh state=ready port=5433 pid=99' },
                @{ id = 'REQ-2.5'; ok = $true; detail = 'route=ui replyChars=60' },
                @{ id = 'REQ-2.8'; ok = $true; detail = 'SURFACE_RECT=launcher-command-bar x=140 y=780 w=640 h=56 viewport=1400x900 source=getBoundingClientRect' }
            ) `
            -SurfaceRect 'launcher-command-bar x=140 y=780 w=640 h=56 viewport=1400x900 source=getBoundingClientRect'
        $run = Invoke-Captured {
            $v = Get-HookVerdict -CdpJsonPath (Join-Path $cleanDir 'cdp.json')
            Publish-HookVerdict -Verdict $v -Profile 'fresh' | Out-Null
            Get-FinalExitCode
        }
        $ok = ($run.Code -eq 0) -and ($run.Ids.Count -eq 0) -and (Test-ContainsLine $run.Lines 'CHECK REQ-2.3 PASS') -and (Test-ContainsLine $run.Lines 'SURFACE_RECT=launcher-command-bar')
        New-ControlLine 'CLEAN-PASS' 'a clean reading produces no named error (exit 0)' $ok ("exit=$($run.Code) ids=$($run.Ids -join ',')")
        if (-not $ok) { $failures++ }
    } catch {
        Emit ('SELFTEST_EXCEPTION=' + $_.Exception.Message)
        $failures++
    } finally {
        if (Test-Path -LiteralPath $rootTemp) {
            Remove-Item -LiteralPath $rootTemp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($failures -eq 0) {
        Emit 'SELFTEST: PASS'
        return 0
    }
    Emit ('SELFTEST: FAIL (' + $failures + ' control failure(s))')
    return 3
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
$resolvedMode = $Mode
if ($SelfTest) { $resolvedMode = 'selftest' }
if ([string]::IsNullOrWhiteSpace($resolvedMode)) { $resolvedMode = 'gate' }
$resolvedMode = $resolvedMode.ToLowerInvariant()

if ($resolvedMode -eq 'selftest') {
    $Mode = 'selftest'
    exit (Invoke-SelfTest)
}

if ($resolvedMode -eq 'negative') {
    $Mode = 'negative'
    exit (Invoke-NegativeMode -OutRoot $OutDir)
}

if ($resolvedMode -ne 'gate') {
    $Mode = $resolvedMode
    $script:OutDir = $OutDir
    $path = $OutDir
    if ([string]::IsNullOrWhiteSpace($path)) {
        $path = Join-Path $script:RepoRoot (Join-Path '.opencode\tmp\release-gate' (Get-Stamp))
    }
    $path = [System.IO.Path]::GetFullPath($path)
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
    $script:GateLogPath = Join-Path $path 'gate.log'
    Reset-RunState
    Emit ('MODE=' + $resolvedMode)
    Add-NamedError 'GATE_REFUSED' ('reason=bad-args detail=-Mode must be gate, negative or selftest (got ' + $resolvedMode + ')')
    exit (Complete-Run -OutRoot $path -Installers $Installer -ChecksExpected $false)
}

$Mode = 'gate'
exit (Invoke-GateMode -OutRoot $OutDir)
