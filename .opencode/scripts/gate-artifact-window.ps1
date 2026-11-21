<#
.SYNOPSIS
  The in-window live assertion hook for the Fredo release-artifact gate
  (Spec #3181, ST-3 CDP half).

.DESCRIPTION
  Runs INSIDE launch-artifact-probe.ps1's bounded launch window (the probe's
  -CdpProbe hook, Spec #3181 ST-2) and asserts the running WebView2 over the
  DevTools protocol. The probe stays the ONLY GUI launch primitive; this script
  never starts a process.

  Hook environment (binding):
    GATE_EXE               the launched executable (evidence identity only).
    GATE_CDP_PORT          the WebView2 DevTools port (--remote-debugging-port).
    GATE_DATA_DIR          the run's isolated app-data dir (profile identity).
    GATE_LOG_DIR           the run's log dir; cdp.json + screenshot.png are written
                           here (run-fresh / run-dirty).
    GATE_WINDOW_SECS       the whole-hook budget in seconds. The caller MUST size
                           it to cover the boot settle, the DB-ready bound and the
                           companion-turn bound; every clause derives its bound.
    GATE_ASSERTIONS        comma list of: styled,database,companion,screenshot.
                           Only the selected clauses run. An unknown token or an
                           empty list is a refusal (exit 2), never a silent skip.
    GATE_PG_DATA_DIR       the per-run cluster dir the probe configured through
                           the product's FREDO_PG_DATA_DIR seam. It is the
                           EXPECTED identity; the DB clause proves the EFFECTIVE
                           dir from pg_supervisor_status.dataDir, never from this
                           variable (G-449).
    GATE_DB_READY_SECS     the DB-ready bound in seconds (default 180).
    GATE_BOOT_SETTLE_SECS  the document-readiness bound in seconds (default 60).

  Stdout literals (the driver tees them into gate.log and quotes them):
    CHECK <id> PASS|FAIL <detail>        one line per clause, pass or fail
    SURFACE_RECT=launcher-command-bar x=<n> y=<n> w=<n> h=<n> viewport=<WxH> source=getBoundingClientRect
    URL_AFTER_WAITPRENAV=<href or <none>> the committed document URL read BEFORE any reload
    PRE_NAV_FRAME=<readyState=... href=... bodyChildren=... internals=...>  the pre-navigation frame detail
    RELOADED=<True|False>                result of the post-wait reload (styled/screenshot only)
    BOOT_SETTLE=<ready|blank-document> seconds=<n>   seconds is the pre + post total
    DB_ISOLATION=<isolated|shared|mismatch>
    DB_EFFECTIVE_DIR=<fresh|dirty>=<absolute path>
    DB_STATE=<fresh|dirty>=<state>
    UNSTYLED:<detail> / CSP_VIOLATION:<detail> / DB_NOT_READY:<fresh|dirty>
    COMPANION_NO_REPLY / COMPANION_ENGINE:<code> / CDP_UNAVAILABLE / EVIDENCE_MISSING:screenshot

  Wait-then-reload order (styled/screenshot): the hook first WAITS for the app's
    first navigation to commit (Wait-DocumentReady; URL_AFTER_WAITPRENAV +
    PRE_NAV_FRAME), THEN reloads. A reload issued against the still-blank
    about:blank target restarts the cold-boot navigation and the per-run
    webview profile never recovers, so the wait is required. A timed-out wait is
    NOT an error -- it falls through to the reload and the readiness gate, which
    alone owns the blank-document verdict. ONE budget (GATE_BOOT_SETTLE_SECS)
    bounds the pre-navigation wait and the post-reload gate together.

  Readiness gate (before the clauses): the document must reach
    readyState=complete && href != about:blank && __TAURI_INTERNALS__ &&
    bodyChildren >= 1 within GATE_BOOT_SETTLE_SECS. A blank frame emits
    CDP_UNAVAILABLE:blank-document, records db.state=not-observed-blank-document,
    still runs styled/screenshot (so the readiness failure is visible as
    UNSTYLED:screenshot-frame) and SKIPS the DB clause. A blank frame is an
    instrument state: the styled UNSTYLED and CSP_VIOLATION ids are only ever
    attributed to a RENDERED document.

  Clauses:
    styled      (a) an injected <style> yields exactly 1 rule,
                (b) Chakra/emotion sheets (ownerNode[data-emotion]) total > 0,
                (c) document.styleSheets total rules >= the floor (1),
                (d) body fontFamily is non-empty and contains the FIRST family of
                    the authored --font-family var (quotes stripped, case
                    insensitive). The mono stack is deliberately NOT asserted:
                    the shipped base theme is "classic" ('Inter', ...).
                (e) --accent-primary is non-empty,
                (f) zero CSP violations, from window.__fredoGate.csp (installed
                    BEFORE the hook's reload) plus Log.entryAdded entries
                    matching "Refused to apply|Content Security Policy".
    screenshot  S1..S6 frame readiness (the UI/UX contract), polled <= 15 s at
                250 ms, then a viewport-only Page.captureScreenshot
                {format:"png", fromSurface:true} with NO clip, NO
                captureBeyondViewport and NO Emulation. Captured ANYWAY on
                failure; the 8-byte PNG signature and IHDR dimensions are
                verified. Failure routes to UNSTYLED:screenshot-frame.
    (SURFACE_RECT is emitted when styled or screenshot is selected, from a real
     getBoundingClientRect() reading of [data-testid="launcher-command-bar"].)
    database    page-evaluated invoke('pg_supervisor_status'). Before the ready
                bound it OBSERVES the product's effective cluster dir
                (dataDir) and proves isolation: equal to GATE_PG_DATA_DIR ->
                DB_ISOLATION=isolated; equal to the shared
                %APPDATA%\com.fredo.app\postgres\cluster ->
                GATE_REFUSED reason=db-isolation-shared; anything else ->
                GATE_REFUSED reason=db-isolation-mismatch, never DB_NOT_READY.
                Both refusals emit DB_EFFECTIVE_DIR=<profile>=<observed>. Only an
                isolated profile is then polled to state == "ready" within the
                bound (min(GATE_DB_READY_SECS, available), counted from a ready
                document); on failure DB_NOT_READY:<profile>.
    companion   writes Fredo_companion_visible THROUGH the app
                (invoke('save_setting')) then reloads and drives one turn
                through the launcher field + Enter. If no rendered reply lands,
                the DECLARED IPC fallback runs (invoke('start_companion_engine')
                then invoke('llm_chat') with an llm-done listener and
                get_llama_server_status.mtpStats) and is recorded as route "ipc".
                The fallback is never silent.

  Outputs: <GATE_LOG_DIR>/cdp.json (per-clause readings + checks + errors) and
  <GATE_LOG_DIR>/screenshot.png (screenshot clause only).

  Exit codes:
    0  every selected clause passed
    1  >= 1 clause failed (a named error was emitted)
    2  refused precondition (missing/invalid GATE_* env)

  PowerShell 5.1 standard library only. ASCII-only source (G-315).
#>

$ErrorActionPreference = 'Continue'
$script:StartedAt = Get-Date
$script:Checks = New-Object System.Collections.ArrayList
$script:Errors = New-Object System.Collections.ArrayList
$script:ExitCode = 0
$script:Refused = $false
$script:Result = $null
$script:DataDir = ''

Import-Module (Join-Path $PSScriptRoot 'fredo-cdp.psm1') -Force

# ---- output helpers ----------------------------------------------------------

function Write-GateLine {
    param([string]$Text)
    Write-Output $Text
}

function Get-GateProp {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    return $prop.Value
}

function Add-Check {
    param([string]$Id, [bool]$Ok, [string]$Detail)
    [void]$script:Checks.Add([pscustomobject]@{ id = $Id; ok = $Ok; detail = $Detail })
    $status = 'FAIL'
    if ($Ok) {
        $status = 'PASS'
    } else {
        if ($script:ExitCode -eq 0) { $script:ExitCode = 1 }
    }
    Write-GateLine ('CHECK {0} {1}   {2}' -f $Id, $status, $Detail)
}

function Add-GateError {
    param([string]$Id, [string]$Detail = '')
    [void]$script:Errors.Add([pscustomobject]@{ id = $Id; detail = $Detail })
    if ([string]::IsNullOrWhiteSpace($Detail)) {
        Write-GateLine $Id
    } else {
        Write-GateLine ('{0}:{1}' -f $Id, $Detail)
    }
    if ($script:ExitCode -eq 0) { $script:ExitCode = 1 }
}

function Write-CdpJson {
    param([string]$RunDir)
    if ([string]::IsNullOrWhiteSpace($RunDir) -or $null -eq $script:Result) { return }
    try {
        if (-not (Test-Path -LiteralPath $RunDir)) {
            New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
        }
        $script:Result.durationSeconds = [Math]::Round(((Get-Date) - $script:StartedAt).TotalSeconds, 1)
        $script:Result.checks = @($script:Checks)
        $script:Result.errors = @($script:Errors)
        $json = $script:Result | ConvertTo-Json -Depth 12
        $path = Join-Path $RunDir 'cdp.json'
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($path, $json, $encoding)
        Write-GateLine ('CDP_JSON=' + $path)
    } catch {
        Write-GateLine ('CDP_JSON_WRITE_FAILED=' + $_.Exception.Message)
    }
}

function Get-Excerpt {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    $flat = ($Text -replace '\s+', ' ').Trim()
    if ($flat.Length -le 200) { return $flat }
    return $flat.Substring(0, 200)
}

# A positive numeric hook bound from an environment variable, with a default.
# A malformed/absent value never aborts the hook: it falls back to the documented
# default (the caller sizes its launch window from the same defaults).
function Get-EnvPositiveNumber {
    param([string]$Name, [double]$Default)
    $raw = [string][Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $parsed = 0.0
    if ([double]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return $Default
}

# Normalize a filesystem path for identity comparison: absolute, no trailing
# separator, case-insensitive (Windows). Comparison is by normalized string, so a
# different case or a trailing slash can never masquerade as an isolated cluster.
function ConvertTo-NormalizedDir {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $text = $Path.Trim().Trim('"').Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return '' }
    try { $text = [System.IO.Path]::GetFullPath($text) } catch { }
    return ($text.TrimEnd('\', '/')).ToLowerInvariant()
}

# The effective-dir proof (G-449). The observed dir comes from the PRODUCT
# (pg_supervisor_status.dataDir); ExpectedDir is the run's configured
# GATE_PG_DATA_DIR and SharedDir is the OS app-data cluster. A value that cannot
# be observed is NOT treated as isolated -- it is a mismatch refusal.
function Get-DbIsolationVerdict {
    param([string]$Profile, [string]$ObservedDir, [string]$ExpectedDir, [string]$SharedDir)

    $observed = ConvertTo-NormalizedDir $ObservedDir
    $expected = ConvertTo-NormalizedDir $ExpectedDir
    $shared = ConvertTo-NormalizedDir $SharedDir
    $effective = $ObservedDir
    if ([string]::IsNullOrWhiteSpace($effective)) { $effective = '<unobserved>' }
    $expectedText = $ExpectedDir
    if ([string]::IsNullOrWhiteSpace($expectedText)) { $expectedText = '<unset>' }

    $verdict = [pscustomobject]@{
        Profile = $Profile
        Isolation = 'mismatch'
        State = 'db-isolation-mismatch'
        Refused = $true
        RefusalDetail = ('reason=db-isolation-mismatch expected=' + $expectedText + ' observed=' + $effective)
        EffectiveDir = $effective
    }

    if ([string]::IsNullOrWhiteSpace($observed)) { return $verdict }
    if ((-not [string]::IsNullOrWhiteSpace($expected)) -and $observed -eq $expected) {
        $verdict.Isolation = 'isolated'
        $verdict.State = 'observed'
        $verdict.Refused = $false
        $verdict.RefusalDetail = ''
        return $verdict
    }
    if ((-not [string]::IsNullOrWhiteSpace($shared)) -and $observed -eq $shared) {
        $verdict.Isolation = 'shared'
        $verdict.State = 'db-isolation-shared'
        $verdict.RefusalDetail = 'reason=db-isolation-shared'
        return $verdict
    }
    return $verdict
}

# ---- page-evaluated scripts --------------------------------------------------
# Single-quoted here-strings: no PowerShell interpolation. Every script is a
# self-contained function expression whose value is returned by Runtime.evaluate
# with returnByValue.

$script:CspCollectorScript = @'
(function () {
  var gate = window.__fredoGate = window.__fredoGate || {};
  if (gate.csp) { gate.cspInstalled = true; return true; }
  gate.csp = [];
  gate.cspInstalled = true;
  try {
    document.addEventListener('securitypolicyviolation', function (event) {
      try {
        gate.csp.push({
          directive: String(event.violatedDirective || ''),
          blocked: String(event.blockedURI || ''),
          sample: String(event.sample || '').slice(0, 120)
        });
      } catch (inner) { }
    }, true);
  } catch (outer) { }
  return true;
})()
'@

$script:StyledScript = @'
(function () {
  var out = {};
  var probeId = '__fredo_gate_injected_style__';
  var previous = document.getElementById(probeId);
  if (previous && previous.parentNode) { previous.parentNode.removeChild(previous); }
  var style = document.createElement('style');
  style.id = probeId;
  style.textContent = '.fredo-gate-probe{color:red}';
  (document.head || document.documentElement).appendChild(style);
  var injectedRules = 0;
  try { injectedRules = style.sheet ? style.sheet.cssRules.length : 0; } catch (error) { injectedRules = -1; }
  if (style.parentNode) { style.parentNode.removeChild(style); }

  var emotionRules = 0;
  var totalRules = 0;
  var sheets = document.styleSheets || [];
  for (var index = 0; index < sheets.length; index++) {
    var sheet = sheets[index];
    var rules = 0;
    try { rules = sheet.cssRules ? sheet.cssRules.length : 0; } catch (error) { rules = 0; }
    totalRules += rules;
    try {
      if (sheet.ownerNode && sheet.ownerNode.hasAttribute && sheet.ownerNode.hasAttribute('data-emotion')) {
        emotionRules += rules;
      }
    } catch (error) { }
  }

  var rootStyle = getComputedStyle(document.documentElement);
  var bodyStyle = document.body ? getComputedStyle(document.body) : null;
  var gate = window.__fredoGate || {};
  var violations = gate.csp || [];
  var violationDetail = '';
  for (var index2 = 0; index2 < violations.length && index2 < 5; index2++) {
    if (index2) { violationDetail += '; '; }
    violationDetail += String(violations[index2].directive || '') + ' ' + String(violations[index2].blocked || '');
  }

  out.injectedRules = injectedRules;
  out.emotionRules = emotionRules;
  out.rules = totalRules;
  out.font = bodyStyle ? String(bodyStyle.fontFamily || '') : '';
  out.authoredFont = String((rootStyle.getPropertyValue('--font-family') || '')).trim();
  out.accent = String((rootStyle.getPropertyValue('--accent-primary') || '')).trim();
  out.violations = violations.length;
  out.violationDetail = violationDetail;
  return out;
})()
'@

$script:FrameScript = @'
(function () {
  var viewportWidth = window.innerWidth;
  var viewportHeight = window.innerHeight;
  var out = {
    S1: false, S2: false, S3: false, S4: false, S5: false, S6: false,
    observed: {},
    rect: null,
    viewport: { width: viewportWidth, height: viewportHeight },
    devicePixelRatio: window.devicePixelRatio || 1,
    readyState: document.readyState,
    href: String(location.href),
    bodyChildren: document.body ? document.body.childElementCount : -1
  };

  function alphaOf(color) {
    if (!color) { return 0; }
    var match = String(color).match(/rgba?\(([^)]+)\)/);
    if (!match) { return 0; }
    var parts = match[1].split(',');
    if (parts.length < 4) { return 1; }
    var alpha = parseFloat(parts[3]);
    return isNaN(alpha) ? 0 : alpha;
  }

  try {
    out.S1 = out.readyState === 'complete' && out.href !== 'about:blank' && out.bodyChildren >= 1;
  } catch (error) { }

  try {
    var root = document.getElementById('root');
    var rootChildren = root ? root.childElementCount : 0;
    var shell = false;
    if (root && root.querySelectorAll) {
      var divs = root.querySelectorAll('div');
      for (var index = 0; index < divs.length; index++) {
        var rect = divs[index].getBoundingClientRect();
        if (rect.width >= 0.9 * viewportWidth && rect.height >= 0.9 * viewportHeight) { shell = true; break; }
      }
    }
    out.observed.rootChildren = rootChildren;
    out.observed.shell = shell;
    out.S2 = rootChildren >= 1 && shell;
  } catch (error) { out.observed.S2error = String(error); }

  try {
    var inlineBackground = document.body ? String(document.body.style.background || document.body.style.backgroundColor || '') : '';
    var computedBackground = document.body ? String(getComputedStyle(document.body).backgroundColor || '') : '';
    out.observed.inlineBackground = inlineBackground;
    out.observed.computedBackground = computedBackground;
    out.S3 = inlineBackground !== '' && alphaOf(computedBackground) > 0;
  } catch (error) { out.observed.S3error = String(error); }

  try {
    var bar = document.querySelector('[data-testid="launcher-command-bar"]');
    var input = document.querySelector('[data-testid="launcher-command-input"]');
    var barOk = false;
    if (bar) {
      var barRect = bar.getBoundingClientRect();
      out.rect = { x: barRect.left, y: barRect.top, width: barRect.width, height: barRect.height };
      barOk = barRect.width >= 100 && barRect.height >= 8 && barRect.right > 0 && barRect.bottom > 0 && barRect.left < viewportWidth && barRect.top < viewportHeight;
    }
    var inputOk = false;
    if (input) {
      var inputRect = input.getBoundingClientRect();
      inputOk = inputRect.width >= 100 && inputRect.height >= 8 && inputRect.right > 0 && inputRect.bottom > 0 && inputRect.left < viewportWidth && inputRect.top < viewportHeight;
    }
    out.observed.bar = bar ? true : false;
    out.observed.input = input ? true : false;
    out.S4 = barOk && inputOk;
  } catch (error) { out.observed.S4error = String(error); }

  try {
    var led = document.querySelector('[data-testid="desktop-status-led"]');
    var dot = led ? (led.querySelector('span') || led) : null;
    if (dot) {
      var ledRect = dot.getBoundingClientRect();
      var ledColor = String(getComputedStyle(dot).backgroundColor || '');
      out.observed.ledRect = { width: ledRect.width, height: ledRect.height };
      out.observed.ledColor = ledColor;
      out.S5 = ledRect.width > 0 && ledRect.height > 0 && alphaOf(ledColor) > 0;
    } else {
      out.observed.ledColor = '';
    }
  } catch (error) { out.observed.S5error = String(error); }

  try {
    var accent = String((getComputedStyle(document.documentElement).getPropertyValue('--accent-primary') || '')).trim();
    out.observed.accent = accent;
    out.S6 = accent !== '';
  } catch (error) { out.observed.S6error = String(error); }

  return out;
})()
'@

$script:DocumentReadyScript = @'
(function () {
  var out = {
    ready: false,
    readyState: document.readyState,
    href: String(location.href),
    bodyChildren: document.body ? document.body.childElementCount : -1,
    hasInternals: (typeof window.__TAURI_INTERNALS__ !== 'undefined' && window.__TAURI_INTERNALS__ !== null)
  };
  out.s1 = (out.readyState === 'complete' && out.href !== 'about:blank' && out.bodyChildren >= 1);
  out.ready = (out.s1 && out.hasInternals);
  return out;
})()
'@

$script:DbScript = @'
(function () {
  try {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') { return { __gateError: 'no-tauri-internals' }; }
    return internals.invoke('pg_supervisor_status');
  } catch (error) { return { __gateError: String(error) }; }
})()
'@

$script:EngineScript = @'
(function () {
  try {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') { return { __gateError: 'no-tauri-internals' }; }
    return internals.invoke('get_llama_server_status');
  } catch (error) { return { __gateError: String(error) }; }
})()
'@

$script:SaveSettingScript = @'
(function () {
  try {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') { return false; }
    return internals.invoke('save_setting', { key: 'Fredo_companion_visible', value: 'true' });
  } catch (error) { return false; }
})()
'@

$script:LauncherInputScript = @'
!!document.querySelector('[data-testid="launcher-command-input"]')
'@

$script:FocusLauncherScript = @'
(function () {
  var field = document.querySelector('[data-testid="launcher-command-input"]');
  if (!field) { return false; }
  field.focus();
  return document.activeElement === field;
})()
'@

$script:LauncherRectScript = @'
(function () {
  var field = document.querySelector('[data-testid="launcher-command-input"]');
  if (!field) { return null; }
  var rect = field.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
})()
'@

$script:ReplyScript = @'
(function () {
  var surface = document.querySelector('[data-testid="fredo-reply-surface"]');
  if (!surface) { return { present: false, text: '' }; }
  return { present: true, text: String(surface.innerText || '') };
})()
'@

$script:CompanionPrompt = 'Fredo release gate check. Reply with one short sentence.'

$script:CompanionIpcPrepScript = @'
(function () {
  var gate = window.__fredoGate = window.__fredoGate || {};
  gate.companion = { tokens: '', done: false, error: null, installedAt: Date.now() };
  var internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.transformCallback !== 'function' || typeof internals.invoke !== 'function') {
    gate.companion.error = 'no-tauri-internals';
    return false;
  }
  if (gate.companionIpcInstalled) { return true; }
  gate.companionIpcInstalled = true;
  function textOf(payload) {
    if (payload === null || payload === undefined) { return ''; }
    if (typeof payload === 'string') { return payload; }
    if (typeof payload.payload === 'string') { return payload.payload; }
    if (payload.payload && typeof payload.payload.payload === 'string') { return payload.payload.payload; }
    return '';
  }
  function listen(name, handler) {
    var id = internals.transformCallback(function (payload) { handler(payload); });
    internals.invoke('plugin:event|listen', { event: name, target: { kind: 'Any' }, handler: id });
  }
  listen('llm-token', function (payload) { gate.companion.tokens += textOf(payload); });
  listen('llm-error', function (payload) { gate.companion.error = textOf(payload) || 'llm-error'; });
  listen('llm-done', function () { gate.companion.done = true; });
  return true;
})()
'@

$script:StartEngineScript = @'
(function () {
  try {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') { return { success: false, code: 'no-tauri-internals' }; }
    return internals.invoke('start_companion_engine');
  } catch (error) { return { success: false, code: String(error) }; }
})()
'@

$script:ChatScript = @'
(function () {
  try {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') { return false; }
    return internals.invoke('llm_chat', { messages: [ { role: 'user', content: 'Fredo release gate check. Reply with one short sentence.' } ] });
  } catch (error) { return false; }
})()
'@

$script:CompanionIpcStateScript = @'
(function () {
  var gate = window.__fredoGate;
  if (!gate || !gate.companion) { return null; }
  return { tokens: String(gate.companion.tokens || ''), done: gate.companion.done === true, error: gate.companion.error };
})()
'@

# ---- readiness gate ----------------------------------------------------------

# Poll the document for the real-document predicate until the bound. A blank or
# uninitialised frame is an INSTRUMENT state: callers must not attribute style or
# CSP findings to it (the 0.2.3 CSP-revert discriminator is only meaningful on a
# rendered document).
function Wait-DocumentReady {
    param($Session, [double]$TimeoutSecs = 60.0, [datetime]$Deadline = [datetime]::MaxValue)

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $budgetSeconds = $TimeoutSecs
    if ($Deadline -ne [datetime]::MaxValue) {
        $remaining = ($Deadline - (Get-Date)).TotalSeconds
        if ($remaining -lt $budgetSeconds) { $budgetSeconds = $remaining }
    }
    $timeoutMs = [int][Math]::Max(1000, $budgetSeconds * 1000)
    $last = $null
    while ($watch.ElapsedMilliseconds -lt $timeoutMs) {
        $eval = Invoke-CdpEvaluate -Session $Session -Expression $script:DocumentReadyScript -TimeoutMs 8000
        if ($eval.Ok -and $null -ne $eval.Value) {
            $last = $eval.Value
            if ((Get-GateProp $last 'ready') -eq $true) {
                return [pscustomobject]@{ Ok = $true; Value = $last; Seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1) }
            }
        }
        Start-Sleep -Milliseconds 250
    }
    return [pscustomobject]@{ Ok = $false; Value = $last; Seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1) }
}

function Get-DocumentFrameDetail {
    param($Value)
    return ('readyState={0} href={1} bodyChildren={2} internals={3}' -f
        (Get-GateProp $Value 'readyState' ''),
        (Get-GateProp $Value 'href' ''),
        (Get-GateProp $Value 'bodyChildren' ''),
        (Get-GateProp $Value 'hasInternals' ''))
}

# ---- clause: styled ----------------------------------------------------------

function Invoke-StyledClause {
    param($Session, [int]$Floor = 1)

    # ATTRIBUTION IS EARNED (F-15b). The styled UNSTYLED and CSP_VIOLATION ids are
    # only emitted from a rendered document; a blank frame can never produce the
    # discriminator pair (a nonce-bearing style-src violation + emotionRules=0 on
    # S1=true). On a blank frame the clause records the frame state and emits no
    # styled/CSP finding -- the readiness failure is carried by the screenshot
    # clause (UNSTYLED:screenshot-frame) and by CDP_UNAVAILABLE:blank-document.
    $frame = Invoke-CdpEvaluate -Session $Session -Expression $script:DocumentReadyScript -TimeoutMs 8000
    $frameReady = ($frame.Ok -and ((Get-GateProp $frame.Value 'ready') -eq $true))
    if (-not $frameReady) {
        $frameDetail = ('frame=blank-document ' + (Get-DocumentFrameDetail $frame.Value) + ' (not attributed)')
        Add-Check 'REQ-2.3' $false $frameDetail
        $script:Result.styled = [ordered]@{
            ok = $false
            frameReady = $false
            readyState = [string](Get-GateProp $frame.Value 'readyState' '')
            href = [string](Get-GateProp $frame.Value 'href' '')
            bodyChildren = [int](Get-GateProp $frame.Value 'bodyChildren' -1)
            detail = $frameDetail
        }
        return
    }

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $timeoutMs = 15000
    $reading = $null
    $evalError = ''
    while ($watch.ElapsedMilliseconds -lt $timeoutMs) {
        $eval = Invoke-CdpEvaluate -Session $Session -Expression $script:StyledScript -TimeoutMs 8000
        if ($eval.Ok) {
            $evalError = ''
            $reading = $eval.Value
            $injected = [int](Get-GateProp $reading 'injectedRules' -1)
            $emotion = [int](Get-GateProp $reading 'emotionRules' 0)
            $rules = [int](Get-GateProp $reading 'rules' 0)
            if ($injected -eq 1 -and $emotion -gt 0 -and $rules -ge $Floor) { break }
        } else {
            $evalError = [string]$eval.Exception
        }
        Start-Sleep -Milliseconds 250
    }
    $readyMs = $watch.ElapsedMilliseconds

    $injectedRules = [int](Get-GateProp $reading 'injectedRules' -1)
    $emotionRules = [int](Get-GateProp $reading 'emotionRules' -1)
    $rules = [int](Get-GateProp $reading 'rules' -1)
    $observedFont = [string](Get-GateProp $reading 'font' '')
    $authoredRaw = [string](Get-GateProp $reading 'authoredFont' '')
    $authoredFirst = Get-FirstFontFamily -Value $authoredRaw
    $accent = [string](Get-GateProp $reading 'accent' '')
    $gateViolations = [int](Get-GateProp $reading 'violations' 0)
    $violationDetail = [string](Get-GateProp $reading 'violationDetail' '')

    $logViolations = @(Get-CdpLogEntries -Session $Session -Pattern 'Refused to apply|Content Security Policy')
    if ($logViolations.Count -eq 0) {
        # Log.entryAdded arrives asynchronously and is stashed while a command is
        # in flight; a final round-trip drains anything still queued so a fresh
        # violation cannot be missed by the read above.
        $null = Invoke-CdpEvaluate -Session $Session -Expression '1' -TimeoutMs 5000
        $logViolations = @(Get-CdpLogEntries -Session $Session -Pattern 'Refused to apply|Content Security Policy')
    }
    $violations = $gateViolations + $logViolations.Count

    $fontOk = (Test-FontFamilyContains -Observed $observedFont -FirstFamily $authoredFirst)
    $problems = New-Object System.Collections.ArrayList
    if (-not [string]::IsNullOrWhiteSpace($evalError)) { [void]$problems.Add("runtime evaluate failed: $evalError") }
    if ($injectedRules -ne 1) { [void]$problems.Add("injected style produced $injectedRules rules (expected 1)") }
    if ($emotionRules -le 0) { [void]$problems.Add("emotion sheets produced $emotionRules rules (expected > 0)") }
    if ($rules -lt $Floor) { [void]$problems.Add("stylesheet rules $rules below the floor $Floor") }
    if ([string]::IsNullOrWhiteSpace($observedFont)) {
        [void]$problems.Add('body fontFamily is empty')
    } elseif (-not $fontOk) {
        [void]$problems.Add("body fontFamily '$observedFont' does not contain the authored family '$authoredFirst'")
    }
    if ([string]::IsNullOrWhiteSpace($accent)) { [void]$problems.Add('--accent-primary is empty') }

    $styledOk = ($problems.Count -eq 0)
    $cspOk = ($violations -eq 0)
    $detail = ('rules={0} floor={1} font={2} accent={3} violations={4} injectedRules={5}' -f $rules, $Floor, $observedFont, $accent, $violations, $injectedRules)
    Add-Check 'REQ-2.3' ($styledOk -and $cspOk) $detail

    $violationTexts = @()
    if (-not [string]::IsNullOrWhiteSpace($violationDetail)) { $violationTexts += $violationDetail }
    foreach ($entry in $logViolations) {
        if (-not [string]::IsNullOrWhiteSpace($entry.text)) { $violationTexts += $entry.text }
    }

    $script:Result.styled = [ordered]@{
        ok = ($styledOk -and $cspOk)
        frameReady = $true
        s1 = ((Get-GateProp $frame.Value 's1') -eq $true)
        readyState = [string](Get-GateProp $frame.Value 'readyState' '')
        href = [string](Get-GateProp $frame.Value 'href' '')
        bodyChildren = [int](Get-GateProp $frame.Value 'bodyChildren' -1)
        rules = $rules
        floor = $Floor
        injectedRules = $injectedRules
        emotionRules = $emotionRules
        font = $observedFont
        fontAuthored = $authoredFirst
        fontAuthoredRaw = $authoredRaw
        fontOk = $fontOk
        accent = $accent
        violations = $violations
        violationDetails = @($violationTexts)
        readyMs = $readyMs
        detail = $detail
    }

    if (-not $styledOk) { Add-GateError 'UNSTYLED' ($problems -join '; ') }
    if (-not $cspOk) {
        $first = ''
        if ($violationTexts.Count -gt 0) { $first = [string]$violationTexts[0] }
        if ([string]::IsNullOrWhiteSpace($first)) { $first = 'violation recorded without a readable detail' }
        Add-GateError 'CSP_VIOLATION' ("$violations recorded: $first")
    }
}

# ---- clause: screenshot + SURFACE_RECT ---------------------------------------

function Get-FrameFailureDetail {
    param($Criteria, $Observed, $Capture)

    $parts = New-Object System.Collections.ArrayList
    if (-not $Criteria['S1']) {
        [void]$parts.Add(('S1=false readyState={0} href={1} bodyChildren={2}' -f $Criteria['readyState'], $Criteria['href'], $Criteria['bodyChildren']))
    }
    if (-not $Criteria['S2']) {
        [void]$parts.Add(('S2=false rootChildren={0} shell={1}' -f (Get-GateProp $Observed 'rootChildren' ''), (Get-GateProp $Observed 'shell' '')))
    }
    if (-not $Criteria['S3']) {
        [void]$parts.Add(('S3=false inlineBackground={0} computedBackground={1}' -f (Get-GateProp $Observed 'inlineBackground' ''), (Get-GateProp $Observed 'computedBackground' '')))
    }
    if (-not $Criteria['S4']) {
        [void]$parts.Add(('S4=false bar={0} input={1}' -f (Get-GateProp $Observed 'bar' ''), (Get-GateProp $Observed 'input' '')))
    }
    if (-not $Criteria['S5']) {
        [void]$parts.Add(('S5=false ledColor={0}' -f (Get-GateProp $Observed 'ledColor' '')))
    }
    if (-not $Criteria['S6']) { [void]$parts.Add('S6=false accent-empty') }
    if ($null -ne $Capture -and -not $Capture.Ok) { [void]$parts.Add('capture=' + $Capture.Error) }
    return ($parts -join '; ')
}

function Invoke-ScreenshotClause {
    param($Session, [string]$RunDir, [datetime]$Deadline)

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $timeoutMs = 15000
    $remainingMs = [int](($Deadline - (Get-Date)).TotalMilliseconds)
    if ($remainingMs -lt $timeoutMs) { $timeoutMs = [Math]::Max(1000, $remainingMs) }

    $reading = $null
    $frameEvalError = ''
    while ($watch.ElapsedMilliseconds -lt $timeoutMs) {
        $eval = Invoke-CdpEvaluate -Session $Session -Expression $script:FrameScript -TimeoutMs 8000
        if ($eval.Ok) {
            $frameEvalError = ''
            $reading = $eval.Value
            $allTrue = $true
            foreach ($key in @('S1', 'S2', 'S3', 'S4', 'S5', 'S6')) {
                if (-not ((Get-GateProp $reading $key) -eq $true)) { $allTrue = $false }
            }
            if ($allTrue) { break }
        } else {
            $frameEvalError = [string]$eval.Exception
        }
        Start-Sleep -Milliseconds 250
    }
    $readyMs = $watch.ElapsedMilliseconds

    $criteria = [ordered]@{
        S1 = ((Get-GateProp $reading 'S1') -eq $true)
        S2 = ((Get-GateProp $reading 'S2') -eq $true)
        S3 = ((Get-GateProp $reading 'S3') -eq $true)
        S4 = ((Get-GateProp $reading 'S4') -eq $true)
        S5 = ((Get-GateProp $reading 'S5') -eq $true)
        S6 = ((Get-GateProp $reading 'S6') -eq $true)
        readyState = [string](Get-GateProp $reading 'readyState' '')
        href = [string](Get-GateProp $reading 'href' '')
        bodyChildren = [int](Get-GateProp $reading 'bodyChildren' -1)
    }
    $observed = Get-GateProp $reading 'observed'
    $cssViewport = Get-GateProp $reading 'viewport'
    $cssWidth = 0
    $cssHeight = 0
    if ($null -ne $cssViewport) {
        $cssWidth = [int](Get-GateProp $cssViewport 'width' 0)
        $cssHeight = [int](Get-GateProp $cssViewport 'height' 0)
    }

    $pngPath = Join-Path $RunDir 'screenshot.png'
    $capture = Save-CdpScreenshot -Session $Session -Path $pngPath -TimeoutMs 30000

    $viewWidth = [int]$capture.Width
    $viewHeight = [int]$capture.Height
    $pngAvailable = ($capture.Ok -and $viewWidth -gt 0 -and $viewHeight -gt 0)
    if (-not $pngAvailable) {
        $viewWidth = $cssWidth
        $viewHeight = $cssHeight
    }

    $criteriaText = (@('S1', 'S2', 'S3', 'S4', 'S5', 'S6') | ForEach-Object { '{0}={1}' -f $_, $(if ($criteria[$_]) { 'true' } else { 'false' }) }) -join ' '
    $detail = ('{0} viewport={1}x{2} readyMs={3}' -f $criteriaText, $viewWidth, $viewHeight, $readyMs)
    $frameFailure = Get-FrameFailureDetail -Criteria $criteria -Observed $observed -Capture $capture
    if (-not [string]::IsNullOrWhiteSpace($frameEvalError)) { $frameFailure = "runtime-evaluate-failed=$frameEvalError; $frameFailure" }
    $frameOk = [string]::IsNullOrWhiteSpace($frameFailure)
    Add-Check 'REQ-2.3-screenshot' $frameOk $detail

    $script:Result.screenshot = [ordered]@{
        ok = $frameOk
        file = 'screenshot.png'
        readyMs = $readyMs
        viewport = [ordered]@{ width = $viewWidth; height = $viewHeight }
        cssViewport = [ordered]@{ width = $cssWidth; height = $cssHeight }
        devicePixelRatio = [double](Get-GateProp $reading 'devicePixelRatio' 1)
        pngAvailable = $pngAvailable
        bytes = [int]$capture.Bytes
        sha256 = [string]$capture.Sha256
        signatureOk = [bool]$capture.SignatureOk
        criteria = $criteria
        observed = $observed
        detail = $detail
    }

    if (-not $frameOk) {
        Add-GateError 'UNSTYLED' ('screenshot-frame ' + $frameFailure)
        if (-not $pngAvailable) { Add-GateError 'EVIDENCE_MISSING' 'screenshot' }
    }

    # SURFACE_RECT: a real getBoundingClientRect() reading, never a literal.
    $rect = Get-GateProp $reading 'rect'
    if ($null -ne $rect) {
        $rectX = [int][Math]::Round([double](Get-GateProp $rect 'x' 0))
        $rectY = [int][Math]::Round([double](Get-GateProp $rect 'y' 0))
        $rectW = [int][Math]::Round([double](Get-GateProp $rect 'width' 0))
        $rectH = [int][Math]::Round([double](Get-GateProp $rect 'height' 0))
        $surfaceLine = ('SURFACE_RECT=launcher-command-bar x={0} y={1} w={2} h={3} viewport={4}x{5} source=getBoundingClientRect' -f $rectX, $rectY, $rectW, $rectH, $cssWidth, $cssHeight)
        Write-GateLine $surfaceLine
        $script:Result.surfaceRect = $surfaceLine
        $rectOk = ($rectW -gt 0 -and $rectH -gt 0)
        Add-Check 'REQ-2.8' $rectOk $surfaceLine
    } else {
        Add-Check 'REQ-2.8' $false 'launcher-command-bar not measured (no getBoundingClientRect reading)'
    }
}

# ---- clause: database --------------------------------------------------------

function Invoke-DatabaseClause {
    param($Session, [string]$Profile, [datetime]$Deadline, [switch]$WantCompanion)

    $watch = [System.Diagnostics.Stopwatch]::StartNew()

    # The expected identity comes from the probe (GATE_PG_DATA_DIR), but the
    # EFFECTIVE identity is proven from the product's own report below. The OS
    # app-data cluster is the shared-profile sentinel (G-449).
    $expectedDbDir = [string]$env:GATE_PG_DATA_DIR
    $sharedDbDir = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.fredo.app\postgres\cluster'

    $last = $null
    $state = ''
    $evalError = ''
    $dbDir = ''
    $gateError = ''

    # PHASE 1 (before the ready bound): observe the product's effective dir. A
    # supervisor publishes dataDir as soon as it initialises, so a short bounded
    # window is enough; failing to observe it is NOT treated as isolated.
    $observeSeconds = 20.0
    $availableForObserve = ($Deadline - (Get-Date)).TotalSeconds
    if ($availableForObserve -lt $observeSeconds) { $observeSeconds = [Math]::Max(2.0, $availableForObserve) }
    $observeDeadline = (Get-Date).AddSeconds($observeSeconds)
    while ((Get-Date) -lt $observeDeadline) {
        $remainingMs = [int][Math]::Max(1000, ($observeDeadline - (Get-Date)).TotalMilliseconds)
        $eval = Invoke-CdpEvaluate -Session $Session -Expression $script:DbScript -AwaitPromise -TimeoutMs $remainingMs
        if ($eval.Ok) {
            $last = $eval.Value
            $gateError = [string](Get-GateProp $last '__gateError' '')
            if (-not [string]::IsNullOrWhiteSpace($gateError)) { $evalError = $gateError }
            $state = [string](Get-GateProp $last 'state' '')
            $dbDir = [string](Get-GateProp $last 'dataDir' '')
            if (-not [string]::IsNullOrWhiteSpace($dbDir)) { break }
        } else {
            $evalError = $eval.Exception
        }
        Start-Sleep -Milliseconds 500
    }

    # PHASE 2 (the isolation proof): the directive that makes the DB clause
    # meaningful. A shared or mismatched effective dir is a REFUSAL, never a
    # DB_NOT_READY (which would blame the product for the instrument's state).
    $isolation = Get-DbIsolationVerdict -Profile $Profile -ObservedDir $dbDir -ExpectedDir $expectedDbDir -SharedDir $sharedDbDir
    Write-GateLine ('DB_ISOLATION=' + $isolation.Isolation)
    Write-GateLine ('DB_EFFECTIVE_DIR=' + $Profile + '=' + $isolation.EffectiveDir)

    if ($isolation.Refused) {
        $dbInfo = [ordered]@{
            ok = $false
            state = $isolation.State
            isolation = $isolation.Isolation
            effectiveDir = $isolation.EffectiveDir
            expectedDir = $expectedDbDir
            dataDir = $dbDir
            waitedMs = $watch.ElapsedMilliseconds
        }
        if (-not [string]::IsNullOrWhiteSpace($evalError)) { $dbInfo['evalError'] = $evalError }
        $script:Result.db = $dbInfo
        Add-Check 'REQ-2.4' $false ('profile={0} state={1} dataDir={2}' -f $Profile, $isolation.State, $isolation.EffectiveDir)
        Add-GateError 'GATE_REFUSED' $isolation.RefusalDetail
        $script:Refused = $true
        return
    }

    # PHASE 3 (only an isolated profile): wait for ready. The bound is
    # GATE_DB_READY_SECS (default 180), never more than the remaining window, and
    # it starts here -- i.e. counted from a ready document.
    $boundSeconds = Get-EnvPositiveNumber -Name 'GATE_DB_READY_SECS' -Default 180.0
    $available = ($Deadline - (Get-Date)).TotalSeconds
    if ($WantCompanion) { $available = $available - 30.0 }
    if ($available -lt $boundSeconds) { $boundSeconds = [Math]::Max(5.0, $available) }
    $dbDeadline = (Get-Date).AddSeconds($boundSeconds)

    while ((Get-Date) -lt $dbDeadline) {
        $remainingMs = [int][Math]::Max(1000, ($dbDeadline - (Get-Date)).TotalMilliseconds)
        $eval = Invoke-CdpEvaluate -Session $Session -Expression $script:DbScript -AwaitPromise -TimeoutMs $remainingMs
        if ($eval.Ok) {
            $last = $eval.Value
            $gateError = [string](Get-GateProp $last '__gateError' '')
            if (-not [string]::IsNullOrWhiteSpace($gateError)) { $evalError = $gateError }
            $state = [string](Get-GateProp $last 'state' '')
            $observedNow = [string](Get-GateProp $last 'dataDir' '')
            if (-not [string]::IsNullOrWhiteSpace($observedNow)) { $dbDir = $observedNow }
            if ($state -eq 'ready') { break }
            if ($state -eq 'failed') { break }
        } else {
            $evalError = $eval.Exception
        }
        Start-Sleep -Milliseconds 500
    }

    $dbInfo = [ordered]@{
        ok = ($state -eq 'ready')
        state = $state
        isolation = $isolation.Isolation
        effectiveDir = $isolation.EffectiveDir
        expectedDir = $expectedDbDir
        dataDir = $dbDir
        waitedMs = $watch.ElapsedMilliseconds
    }
    $dbPort = Get-GateProp $last 'port' $null
    if ($null -ne $dbPort) { $dbInfo['port'] = [int]$dbPort }
    $dbProcessId = Get-GateProp $last 'pid' $null
    if ($null -ne $dbProcessId) { $dbInfo['pid'] = [int]$dbProcessId }
    $failureKind = [string](Get-GateProp $last 'failureKind' '')
    if (-not [string]::IsNullOrWhiteSpace($failureKind)) { $dbInfo['failureKind'] = $failureKind }
    $dbError = [string](Get-GateProp $last 'error' '')
    if (-not [string]::IsNullOrWhiteSpace($dbError)) { $dbInfo['error'] = $dbError }
    $logPath = [string](Get-GateProp $last 'logPath' '')
    if (-not [string]::IsNullOrWhiteSpace($logPath)) { $dbInfo['logPath'] = $logPath }
    if (-not [string]::IsNullOrWhiteSpace($evalError)) { $dbInfo['evalError'] = $evalError }
    $script:Result.db = $dbInfo

    $detail = ('profile={0} state={1}' -f $Profile, $state)
    if ($dbInfo.Contains('dataDir') -and -not [string]::IsNullOrWhiteSpace($dbInfo['dataDir'])) { $detail = $detail + ' dataDir=' + $dbInfo['dataDir'] }
    if ($dbInfo.Contains('port')) { $detail = $detail + ' port=' + $dbInfo['port'] }
    if ($dbInfo.Contains('pid')) { $detail = $detail + ' pid=' + $dbInfo['pid'] }
    if ($dbInfo.Contains('failureKind')) { $detail = $detail + ' failureKind=' + $dbInfo['failureKind'] }
    Add-Check 'REQ-2.4' ([bool]$dbInfo['ok']) $detail
    if (-not $dbInfo['ok']) {
        Add-GateError 'DB_NOT_READY' $Profile
    }
}

# ---- clause: companion -------------------------------------------------------

function Get-CompanionStatus {
    param($Session)
    $eval = Invoke-CdpEvaluate -Session $Session -Expression $script:EngineScript -AwaitPromise -TimeoutMs 15000
    if (-not $eval.Ok) { return $null }
    return $eval.Value
}

function Invoke-CompanionUiTurn {
    param($Session, [datetime]$Deadline)

    $result = [ordered]@{ ok = $false; replyChars = 0; replyText = ''; reason = 'no-launcher-input'; engineCode = '' }

    # The launcher field is either painted within a few seconds or absent; a long
    # wait here would starve the declared IPC fallback of its budget.
    $readyMs = [int][Math]::Max(1000, [Math]::Min(5000, ($Deadline - (Get-Date)).TotalMilliseconds))
    $ready = Wait-CdpEvaluate -Session $Session -Expression $script:LauncherInputScript -TimeoutMs $readyMs -PollMs 250
    if (-not $ready.Ok) {
        $result.reason = 'launcher-input-missing'
        return [pscustomobject]$result
    }

    $null = Invoke-CdpEvaluate -Session $Session -Expression $script:FocusLauncherScript -UserGesture -TimeoutMs 5000
    $rectEval = Invoke-CdpEvaluate -Session $Session -Expression $script:LauncherRectScript -TimeoutMs 5000
    if ($rectEval.Ok -and $null -ne $rectEval.Value) {
        $centerX = [double](Get-GateProp $rectEval.Value 'x' 0) + ([double](Get-GateProp $rectEval.Value 'width' 0) / 2.0)
        $centerY = [double](Get-GateProp $rectEval.Value 'y' 0) + ([double](Get-GateProp $rectEval.Value 'height' 0) / 2.0)
        $null = Send-CdpMouseClick -Session $Session -X $centerX -Y $centerY
        $null = Invoke-CdpEvaluate -Session $Session -Expression $script:FocusLauncherScript -UserGesture -TimeoutMs 5000
    }
    $null = Send-CdpInsertText -Session $Session -Text $script:CompanionPrompt
    $null = Send-CdpEnter -Session $Session

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $lastEngineCheck = 0.0
    while ((Get-Date) -lt $Deadline) {
        $reply = Invoke-CdpEvaluate -Session $Session -Expression $script:ReplyScript -TimeoutMs 8000
        if ($reply.Ok -and $null -ne $reply.Value) {
            $text = [string](Get-GateProp $reply.Value 'text' '')
            if (-not [string]::IsNullOrWhiteSpace($text.Trim())) {
                $result.ok = $true
                $result.replyText = $text.Trim()
                $result.replyChars = $result.replyText.Length
                $result.reason = ''
                return [pscustomobject]$result
            }
        }
        if (($watch.Elapsed.TotalSeconds - $lastEngineCheck) -ge 5.0) {
            $lastEngineCheck = $watch.Elapsed.TotalSeconds
            $status = Get-CompanionStatus -Session $Session
            $code = [string](Get-GateProp $status 'lastErrorCode' '')
            if (-not [string]::IsNullOrWhiteSpace($code)) {
                $result.reason = 'engine-failure'
                $result.engineCode = $code
                return [pscustomobject]$result
            }
        }
        Start-Sleep -Milliseconds 500
    }
    $result.reason = 'no-reply'
    return [pscustomobject]$result
}

function Invoke-CompanionIpcTurn {
    param($Session, [datetime]$Deadline)

    $result = [ordered]@{
        ok = $false
        replyChars = 0
        replyText = ''
        reason = ''
        engineCode = ''
        modelId = ''
        mtpStats = $false
    }

    $prep = Invoke-CdpEvaluate -Session $Session -Expression $script:CompanionIpcPrepScript -TimeoutMs 10000
    if (-not $prep.Ok -or $prep.Value -ne $true) {
        $result.reason = 'ipc-listener-unavailable'
        return [pscustomobject]$result
    }

    $remainingMs = [int][Math]::Max(2000, ($Deadline - (Get-Date)).TotalMilliseconds)
    $start = Invoke-CdpEvaluate -Session $Session -Expression $script:StartEngineScript -AwaitPromise -TimeoutMs $remainingMs
    if (-not $start.Ok) {
        $result.reason = 'engine-start-invoke-failed'
        $result.engineCode = [string]$start.Exception
        return [pscustomobject]$result
    }
    $startValue = $start.Value
    if ((Get-GateProp $startValue 'success') -eq $false) {
        $result.reason = 'engine-start-failed'
        $result.engineCode = [string](Get-GateProp $startValue 'code' 'unknown')
        return [pscustomobject]$result
    }

    $chat = Invoke-CdpEvaluate -Session $Session -Expression $script:ChatScript -AwaitPromise -TimeoutMs 15000
    # llm_chat resolves null on success (Result<(), String>) and REJECTS on error,
    # so success is $chat.Ok - a comparison against $true would fail every turn.
    if (-not $chat.Ok) {
        $result.reason = 'llm-chat-invoke-failed'
        $result['llmError'] = [string]$chat.Exception
        return [pscustomobject]$result
    }

    while ((Get-Date) -lt $Deadline) {
        $state = Invoke-CdpEvaluate -Session $Session -Expression $script:CompanionIpcStateScript -TimeoutMs 8000
        if ($state.Ok -and $null -ne $state.Value) {
            $done = ((Get-GateProp $state.Value 'done') -eq $true)
            $streamError = [string](Get-GateProp $state.Value 'error' '')
            $tokens = [string](Get-GateProp $state.Value 'tokens' '')
            if (-not [string]::IsNullOrWhiteSpace($streamError)) {
                $result.reason = 'llm-error'
                $result['llmError'] = $streamError
                return [pscustomobject]$result
            }
            if ($done) {
                $status = Get-CompanionStatus -Session $Session
                $result.modelId = [string](Get-GateProp $status 'modelId' '')
                $mtp = Get-GateProp $status 'mtpStats' $null
                $result.mtpStats = ($null -ne $mtp)
                $result.replyText = $tokens.Trim()
                $result.replyChars = $result.replyText.Length
                if ($result.mtpStats -and $result.replyChars -gt 0) {
                    $result.ok = $true
                    $result.reason = ''
                } elseif (-not $result.mtpStats) {
                    $result.reason = 'done-without-mtpStats'
                } else {
                    $result.reason = 'done-with-empty-reply'
                }
                return [pscustomobject]$result
            }
        }
        Start-Sleep -Milliseconds 500
    }
    $result.reason = 'no-reply'
    return [pscustomobject]$result
}

function Invoke-CompanionClause {
    param($Session, [string]$Profile, [datetime]$Deadline)

    $boundSeconds = [Math]::Round(($Deadline - (Get-Date)).TotalSeconds, 0)
    Write-GateLine ('COMPANION_BOUND_SECS={0}' -f $boundSeconds)

    # The visibility setting is written THROUGH THE APP (the same save_setting
    # command settingsService uses), then the page reloads so the companion
    # context reads it from the DB. Seeding localStorage alone is not sufficient.
    $save = Invoke-CdpEvaluate -Session $Session -Expression $script:SaveSettingScript -AwaitPromise -TimeoutMs 15000
    if (-not $save.Ok) { Write-GateLine ('COMPANION_SETTING_ERROR=' + $save.Exception) }
    $reloaded = Invoke-CdpReload -Session $Session -TimeoutMs ([int][Math]::Max(5000, [Math]::Min(20000, ($Deadline - (Get-Date)).TotalMilliseconds)))
    Write-GateLine ('COMPANION_RELOAD=' + $(if ($reloaded) { 'true' } else { 'false' }))

    $companion = [ordered]@{
        ok = $false
        route = 'none'
        replyChars = 0
        replyText = ''
        reason = ''
    }

    $remaining = [Math]::Max(0.0, ($Deadline - (Get-Date)).TotalSeconds)
    $uiSeconds = [Math]::Max(10.0, [Math]::Min(300.0, $remaining * 0.6))
    $uiDeadline = (Get-Date).AddSeconds([Math]::Min($uiSeconds, $remaining))
    $ui = Invoke-CompanionUiTurn -Session $Session -Deadline $uiDeadline

    if ($ui.ok) {
        $companion['ok'] = $true
        $companion['route'] = 'ui'
        $companion['replyChars'] = [int]$ui.replyChars
        $companion['replyText'] = Get-Excerpt $ui.replyText
        $companion['replyExcerpt'] = Get-Excerpt $ui.replyText
        $companion['routeNote'] = 'launcher-command-input + Enter (through the app)'
    } else {
        $companion['reason'] = 'ui: ' + [string]$ui.reason
        if (-not [string]::IsNullOrWhiteSpace([string]$ui.engineCode)) {
            $companion['engineCode'] = [string]$ui.engineCode
        }

        $remainingIpc = ($Deadline - (Get-Date)).TotalSeconds
        if ($remainingIpc -lt 5.0) {
            $companion['reason'] = $companion['reason'] + '; ipc-skipped-budget'
        } else {
            $ipc = Invoke-CompanionIpcTurn -Session $Session -Deadline $Deadline
            if ($ipc.ok) {
                $companion['ok'] = $true
                $companion['route'] = 'ipc'
                $companion['replyChars'] = [int]$ipc.replyChars
                $companion['replyText'] = Get-Excerpt $ipc.replyText
                $companion['replyExcerpt'] = Get-Excerpt $ipc.replyText
                $companion['routeNote'] = 'llm_chat via __TAURI_INTERNALS__.invoke (declared IPC fallback)'
                $companion['mtpStats'] = [bool]$ipc.mtpStats
            } else {
                $companion['reason'] = $companion['reason'] + '; ipc: ' + [string]$ipc.reason
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$ipc.engineCode)) {
                $companion['engineCode'] = [string]$ipc.engineCode
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$ipc.modelId)) {
                $companion['modelId'] = [string]$ipc.modelId
            }
        }
    }

    if ($companion['ok']) {
        $status = Get-CompanionStatus -Session $Session
        $modelId = [string](Get-GateProp $status 'modelId' '')
        if (-not [string]::IsNullOrWhiteSpace($modelId)) { $companion['modelId'] = $modelId }
    }

    $script:Result.companion = $companion
    $detail = ('route={0} replyChars={1}' -f $companion['route'], $companion['replyChars'])
    Add-Check 'REQ-2.5' ([bool]$companion['ok']) $detail

    if (-not $companion['ok']) {
        $engineCode = ''
        if ($companion.Contains('engineCode')) { $engineCode = [string]$companion['engineCode'] }
        if (-not [string]::IsNullOrWhiteSpace($engineCode)) {
            Add-GateError 'COMPANION_ENGINE' $engineCode
        } else {
            Add-GateError 'COMPANION_NO_REPLY' ''
        }
    }
}

# ---- main --------------------------------------------------------------------

$exe = [string]$env:GATE_EXE
$portText = [string]$env:GATE_CDP_PORT
$dataDir = [string]$env:GATE_DATA_DIR
$logDir = [string]$env:GATE_LOG_DIR
$windowText = [string]$env:GATE_WINDOW_SECS
$assertionsText = [string]$env:GATE_ASSERTIONS
$script:DataDir = $dataDir

$refusals = New-Object System.Collections.ArrayList
if ([string]::IsNullOrWhiteSpace($portText)) { [void]$refusals.Add('GATE_CDP_PORT is required') }
if ([string]::IsNullOrWhiteSpace($logDir)) { [void]$refusals.Add('GATE_LOG_DIR is required') }
if ([string]::IsNullOrWhiteSpace($assertionsText)) { [void]$refusals.Add('GATE_ASSERTIONS is required') }

$port = 0
$portOk = $false
if (-not [string]::IsNullOrWhiteSpace($portText)) { $portOk = [int]::TryParse($portText, [ref]$port) }
if (-not $portOk -or $port -lt 1 -or $port -gt 65535) {
    [void]$refusals.Add('GATE_CDP_PORT must be an integer in 1..65535')
}

$windowSecs = 90.0
if (-not [string]::IsNullOrWhiteSpace($windowText)) {
    $parsedWindow = 0.0
    if ([double]::TryParse($windowText, [ref]$parsedWindow)) {
        $windowSecs = [Math]::Max(5.0, [Math]::Min(3000.0, $parsedWindow))
    } else {
        [void]$refusals.Add('GATE_WINDOW_SECS must be a number of seconds')
    }
}

$selected = New-Object System.Collections.ArrayList
if (-not [string]::IsNullOrWhiteSpace($assertionsText)) {
    foreach ($token in ($assertionsText -split ',')) {
        $name = $token.Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if (@('styled', 'database', 'companion', 'screenshot') -notcontains $name) {
            [void]$refusals.Add("unknown GATE_ASSERTIONS token: $name")
        } elseif (-not $selected.Contains($name)) {
            [void]$selected.Add($name)
        }
    }
}
if ($selected.Count -eq 0) { [void]$refusals.Add('GATE_ASSERTIONS selected no clause') }

$runProfile = 'fresh'
$logLeaf = ''
if (-not [string]::IsNullOrWhiteSpace($logDir)) { $logLeaf = Split-Path -Leaf $logDir }
if ($logLeaf -match '^run-(.+)$') {
    $runProfile = $Matches[1]
} elseif (-not [string]::IsNullOrWhiteSpace($dataDir) -and $dataDir.ToLowerInvariant().Contains('dirty')) {
    $runProfile = 'dirty'
}

if ($refusals.Count -gt 0) {
    foreach ($refusal in $refusals) { Write-GateLine ('ERROR=' + $refusal) }
    Write-GateLine 'RESULT=REFUSED'
    exit 2
}

$script:Result = [ordered]@{
    schemaVersion = 1
    profile = $runProfile
    gateExe = $exe
    dataDir = $dataDir
    cdpPort = $port
    assertions = (@($selected) -join ',')
    startedUtc = $script:StartedAt.ToUniversalTime().ToString('o')
    durationSeconds = 0
    endpoint = "http://127.0.0.1:$port"
    targets = 0
    webSocketDebuggerUrl = ''
    styled = $null
    screenshot = $null
    surfaceRect = $null
    db = $null
    companion = $null
    checks = @()
    errors = @()
}

Write-GateLine ('HOOK_PROFILE=' + $runProfile)
Write-GateLine ('HOOK_ASSERTIONS=' + (@($selected) -join ','))
Write-GateLine ('HOOK_WINDOW_SECS=' + $windowSecs)

$wantStyled = $selected.Contains('styled')
$wantScreenshot = $selected.Contains('screenshot')
$wantDatabase = $selected.Contains('database')
$wantCompanion = $selected.Contains('companion')
$wantSurfaceRect = ($wantStyled -or $wantScreenshot)

$connectTimeout = [int][Math]::Min(15.0, [Math]::Max(5.0, $windowSecs))
$session = $null
try {
    $session = Connect-FredoCdp -Port $port -TimeoutSecs $connectTimeout
} catch {
    $message = $_.Exception.Message
    $detail = $message
    if ($detail.StartsWith('CDP_UNAVAILABLE:')) { $detail = $detail.Substring(16).Trim() }
    Add-GateError 'CDP_UNAVAILABLE' $detail
    Write-CdpJson -RunDir $logDir
    Write-GateLine 'HOOK_RESULT=FAIL'
    exit $script:ExitCode
}

$script:Result.targets = [int]$session.Targets
$script:Result.webSocketDebuggerUrl = [string]$session.WebSocketDebuggerUrl
Write-GateLine ('CDP_TARGETS=' + $session.Targets)
Write-GateLine ('CDP_WEBSOCKET=' + $session.WebSocketDebuggerUrl)

$deadline = $script:StartedAt.AddSeconds($windowSecs)

# ONE boot-settle budget governs both waits below: the pre-navigation document
# wait and the post-reload readiness gate. Hoisted here so a single env seam
# (GATE_BOOT_SETTLE_SECS, 60) bounds pre + post together -- the caller's 270 s
# window derivation still holds. No second seam is introduced.
$bootSettleSecs = Get-EnvPositiveNumber -Name 'GATE_BOOT_SETTLE_SECS' -Default 60.0
# Default to a zero-second sentinel: with neither styled nor screenshot selected
# no pre-navigation wait runs, so the post-reload gate keeps the full budget.
$preNav = [pscustomobject]@{ Ok = $false; Value = $null; Seconds = 0.0 }

try {
    $null = Enable-CdpDomain -Session $session -Domain 'Log'
    $null = Enable-CdpDomain -Session $session -Domain 'Page'
    $null = Enable-CdpDomain -Session $session -Domain 'Runtime'

    if ($wantStyled -or $wantScreenshot) {
        # The collector is registered for every FUTURE document and also
        # installed in the current one, then the page reloads: the styled/CSP
        # readings are therefore taken over a document whose whole life was
        # instrumented, which is the 0.2.3 discriminator's requirement.
        $identifier = Add-CdpNewDocumentScript -Session $session -Script $script:CspCollectorScript
        $null = Invoke-CdpEvaluate -Session $session -Expression $script:CspCollectorScript -TimeoutMs 5000
        # WAIT for the FIRST navigation to commit BEFORE reloading (round 5). A
        # reload issued against the still-blank about:blank target restarts the
        # in-flight cold-boot navigation; the per-run WEBVIEW2_USER_DATA_FOLDER
        # then never recovers and the readiness gate expires. A timed-out wait is
        # NOT an error: it falls through to the reload and the readiness gate,
        # which alone owns the blank-document verdict.
        $preNav = Wait-DocumentReady -Session $session -TimeoutSecs $bootSettleSecs -Deadline $deadline
        $preNavHref = [string](Get-GateProp $preNav.Value 'href' '')
        $preNavHrefText = if ([string]::IsNullOrWhiteSpace($preNavHref)) { '<none>' } else { $preNavHref }
        Write-GateLine ('URL_AFTER_WAITPRENAV=' + $preNavHrefText)
        Write-GateLine ('PRE_NAV_FRAME=' + (Get-DocumentFrameDetail $preNav.Value))
        $reloadBudget = [int][Math]::Max(5000, [Math]::Min(20000, ($deadline - (Get-Date)).TotalMilliseconds))
        $reloaded = Invoke-CdpReload -Session $session -TimeoutMs $reloadBudget
        if ($identifier) {
            Write-GateLine 'HOOK_CSP_COLLECTOR=registered'
        } else {
            Write-GateLine 'HOOK_CSP_COLLECTOR=not-registered'
        }
        Write-GateLine ('RELOADED=' + $(if ($reloaded) { 'True' } else { 'False' }))
    }

    # READINESS GATE (B3): a slow boot must not be mistaken for a DB wedge. The
    # document must be a real, initialised webview (complete + not about:blank +
    # __TAURI_INTERNALS__ + a body child) within the REMAINING part of
    # GATE_BOOT_SETTLE_SECS -- the pre-navigation wait above already spent part of
    # the budget, so pre + post stays inside one 60 s bound.
    $postNavBudget = [Math]::Max(5.0, $bootSettleSecs - $preNav.Seconds)
    $documentReady = Wait-DocumentReady -Session $session -TimeoutSecs $postNavBudget -Deadline $deadline
    $bootState = 'ready'
    if (-not $documentReady.Ok) { $bootState = 'blank-document' }
    $bootTotalSeconds = [Math]::Round($preNav.Seconds + $documentReady.Seconds, 1)
    Write-GateLine ('BOOT_SETTLE=' + $bootState + ' seconds=' + $bootTotalSeconds)
    Write-GateLine ('BOOT_FRAME=' + (Get-DocumentFrameDetail $documentReady.Value))
    if (-not $documentReady.Ok) {
        # Existing id, instrument class: the frame never initialised. This is a
        # re-drive, not a product verdict -- and never an attribution to a revert.
        Add-GateError 'CDP_UNAVAILABLE' 'blank-document'
        Write-GateLine ('DB_STATE=' + $runProfile + '=not-observed-blank-document')
    }

    if ($wantStyled) { Invoke-StyledClause -Session $session -Floor 1 }
    if ($wantScreenshot) { Invoke-ScreenshotClause -Session $session -RunDir $logDir -Deadline $deadline }
    if ($wantDatabase) {
        if ($documentReady.Ok) {
            Invoke-DatabaseClause -Session $session -Profile $runProfile -Deadline $deadline -WantCompanion:$wantCompanion
        } else {
            # SKIP the DB clause: a blank frame cannot report a product DB state.
            $script:Result.db = [ordered]@{
                ok = $false
                state = 'not-observed-blank-document'
                waitedMs = 0
            }
            Add-Check 'REQ-2.4' $false ('profile=' + $runProfile + ' state=not-observed-blank-document')
        }
    }
    if ($wantCompanion) {
        if (-not $documentReady.Ok) {
            $script:Result.companion = [ordered]@{ ok = $false; route = 'none'; replyChars = 0; reason = 'not-observed-blank-document' }
            Add-Check 'REQ-2.5' $false ('profile=' + $runProfile + ' state=not-observed-blank-document')
        } elseif ($script:Refused) {
            # A refused precondition (an effective-dir breach) owns the run; the
            # companion turn cannot add evidence and must not burn its bound.
            $script:Result.companion = [ordered]@{ ok = $false; route = 'none'; replyChars = 0; reason = 'not-observed-db-refused' }
            Add-Check 'REQ-2.5' $false ('profile=' + $runProfile + ' state=not-observed-db-refused')
        } else {
            Invoke-CompanionClause -Session $session -Profile $runProfile -Deadline $deadline
        }
    }

    if ($wantSurfaceRect -and -not $wantScreenshot) {
        # A styled-only run still owes the live-receipt anchor: measure the
        # launcher bar directly, never a literal.
        $rectEval = Invoke-CdpEvaluate -Session $session -Expression $script:FrameScript -TimeoutMs 8000
        if ($rectEval.Ok -and $null -ne (Get-GateProp $rectEval.Value 'rect')) {
            $rect = Get-GateProp $rectEval.Value 'rect'
            $cssViewport = Get-GateProp $rectEval.Value 'viewport'
            $cssWidth = [int](Get-GateProp $cssViewport 'width' 0)
            $cssHeight = [int](Get-GateProp $cssViewport 'height' 0)
            $rectX = [int][Math]::Round([double](Get-GateProp $rect 'x' 0))
            $rectY = [int][Math]::Round([double](Get-GateProp $rect 'y' 0))
            $rectW = [int][Math]::Round([double](Get-GateProp $rect 'width' 0))
            $rectH = [int][Math]::Round([double](Get-GateProp $rect 'height' 0))
            $surfaceLine = ('SURFACE_RECT=launcher-command-bar x={0} y={1} w={2} h={3} viewport={4}x{5} source=getBoundingClientRect' -f $rectX, $rectY, $rectW, $rectH, $cssWidth, $cssHeight)
            Write-GateLine $surfaceLine
            $script:Result.surfaceRect = $surfaceLine
            Add-Check 'REQ-2.8' ($rectW -gt 0 -and $rectH -gt 0) $surfaceLine
        } else {
            Add-Check 'REQ-2.8' $false 'launcher-command-bar not measured (no getBoundingClientRect reading)'
        }
    }
} catch {
    $message = $_.Exception.Message
    Write-GateLine ('ERROR=' + $message)
    if ($message -match '^CDP_UNAVAILABLE') {
        $detail = $message -replace '^CDP_UNAVAILABLE:\s*', ''
        Add-GateError 'CDP_UNAVAILABLE' $detail
    } elseif ($script:ExitCode -eq 0) {
        $script:ExitCode = 1
    }
} finally {
    try { Close-FredoCdp -Session $session } catch { }
    Write-CdpJson -RunDir $logDir
}

if ($script:Refused) {
    Write-GateLine 'HOOK_RESULT=REFUSED'
    exit 2
}
if ($script:ExitCode -eq 0) {
    Write-GateLine 'HOOK_RESULT=PASS'
} else {
    Write-GateLine 'HOOK_RESULT=FAIL'
}
exit $script:ExitCode
