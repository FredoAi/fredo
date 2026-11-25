<#
.SYNOPSIS
  Read-only static inspector for Fredo's Tauri webview security boundary:
  production CSP, withGlobalTauri, and the release capability set.

.DESCRIPTION
  Committed replacement for the recurring ad-hoc
  `.opencode/tmp/<issue>/e2e/check-csp.ps1` + `inspect-binaries.ps1` pair
  (Spec #3077). It launches NOTHING: every assertion is a read of
  `apps/tauri/src-tauri/tauri.conf.json`, the `capabilities/` directory, and
  `src/lib.rs`.

  It asserts the hardened release boundary:
    * withGlobalTauri is false (production does not expose window.__TAURI__);
    * the production CSP has no inline-script escape (no 'unsafe-inline' or
      'unsafe-eval' in script-src, no wildcard / remote script source);
    * the dev CSP differs only by the dev-only 'unsafe-inline' script allowance;
    * the capability set is exactly the expected release set (four files:
      default, mcp-bridge-dev, app-commands, installed-app-commands), with no
      shell permissions (shell:allow-spawn / shell:allow-execute /
      shell:allow-open); BOTH directions fail — an unaccounted capability file
      and a missing one (most importantly the installed tier disappearing);
    * the installed tier is EXACTLY ONE capability matching exactly the
      `installed-*` window family, granting exactly one permission
      (`allow-installed-app-invoke`, for the `installed_app_invoke` command) and
      NO `core:*` — and every OTHER capability matches no `installed-*` label.
      This is the POSITIVE form Spec #3146 shipped: it supersedes (never
      deletes) the #3147 invariant "zero capabilities reach an installed
      window"; isolation is cardinality plus exact-set;
    * the MCP bridge capability is dev-only and its plugin registration is
      `#[cfg(debug_assertions)]`-gated, so it is inert in a release build;
    * product source contains no `__TAURI__` global.

  Prints one `CHECK <name> PASS|FAIL <detail>` line per assertion and a final
  `RESULT=PASS|FAIL`. Exit 0 = all checks pass, 1 = at least one FAIL, 2 = the
  config could not be read.

  Read-only: it never writes, launches, or mutates anything. Windows/PowerShell
  5.1-safe.

.PARAMETER RepoRoot
  Repo root. Default: two directories above this script.

.PARAMETER ConfigPath
  `tauri.conf.json` path. Default: `<RepoRoot>\apps\tauri\src-tauri\tauri.conf.json`.

.PARAMETER CapabilitiesDir
  Capability directory. Default: `<RepoRoot>\apps\tauri\src-tauri\capabilities`.

.PARAMETER LibPath
  Rust entry point that registers the MCP bridge plugin. Default:
  `<RepoRoot>\apps\tauri\src-tauri\src\lib.rs`.

.PARAMETER ExpectedCapabilities
  The capability file names that make up the expected release set. Default:
  `default.json,mcp-bridge-dev.json,app-commands.json,installed-app-commands.json`.

  This is a SET-EQUALITY check on FILE NAMES, not a "contains" check, and BOTH
  directions are FAILs: a file present but not named here (an unaccounted
  capability) and a name here with no file (most importantly
  `installed-app-commands.json` — losing it silently drops the installed
  application command surface). A new capability file is therefore a
  DELIBERATE edit — add it to this list in the same change that adds the file,
  and extend the installed-tier check if the new file touches the
  `installed-*` namespace.

.EXAMPLE
  powershell -File .opencode/scripts/inspect-webview-config.ps1

.EXAMPLE
  powershell -File .opencode/scripts/inspect-webview-config.ps1 -ConfigPath .\apps\tauri\src-tauri\tauri.conf.json
#>
param(
  [string]$RepoRoot = '',
  [string]$ConfigPath = '',
  [string]$CapabilitiesDir = '',
  [string]$LibPath = '',
  [string[]]$ExpectedCapabilities = @('default.json', 'mcp-bridge-dev.json', 'app-commands.json', 'installed-app-commands.json')
)

$ErrorActionPreference = 'Stop'

function Write-Inspect {
  param([string]$Line)
  Write-Output $Line
}

function ConvertTo-DirectiveMap {
  param([string]$Policy)
  $map = @{}
  if ([string]::IsNullOrWhiteSpace($Policy)) { return $map }
  foreach ($part in $Policy.Split(';')) {
    $trimmed = $part.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
    $bits = $trimmed -split '\s+'
    $values = if ($bits.Count -gt 1) { @($bits[1..($bits.Count - 1)] | Where-Object { $_ -ne '' }) } else { @() }
    $map[$bits[0]] = @($values)
  }
  return $map
}

function Test-SetEqual {
  param([string[]]$A, [string[]]$B)
  $sa = @($A | Where-Object { $null -ne $_ } | Sort-Object)
  $sb = @($B | Where-Object { $null -ne $_ } | Sort-Object)
  if ($sa.Count -ne $sb.Count) { return $false }
  for ($i = 0; $i -lt $sa.Count; $i++) {
    if ($sa[$i] -ne $sb[$i]) { return $false }
  }
  return $true
}

$script:Checks = New-Object System.Collections.ArrayList
function Add-Check {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  [void]$script:Checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
}

# ---- Resolve paths ------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
} else {
  $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
}
$srcTauri = Join-Path $RepoRoot 'apps\tauri\src-tauri'
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $srcTauri 'tauri.conf.json' }
if ([string]::IsNullOrWhiteSpace($CapabilitiesDir)) { $CapabilitiesDir = Join-Path $srcTauri 'capabilities' }
if ([string]::IsNullOrWhiteSpace($LibPath)) { $LibPath = Join-Path $srcTauri 'src\lib.rs' }

Write-Inspect 'INSPECT=webview-config'
Write-Inspect "REPO_ROOT=$RepoRoot"
Write-Inspect "CONFIG=$ConfigPath"
Write-Inspect "CAPABILITIES_DIR=$CapabilitiesDir"
Write-Inspect "LIB=$LibPath"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Inspect "ERROR: config not found: $ConfigPath"
  Write-Inspect 'RESULT=ERROR'
  exit 2
}
try {
  $cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
} catch {
  Write-Inspect "ERROR: cannot parse ${ConfigPath}: $($_.Exception.Message)"
  Write-Inspect 'RESULT=ERROR'
  exit 2
}

$app = $cfg.app
$security = if ($null -ne $app) { $app.security } else { $null }
$csp = if ($null -ne $security) { $security.csp } else { '' }
$devCsp = if ($null -ne $security) { $security.devCsp } else { '' }
$withGlobalTauri = if ($null -ne $app) { $app.withGlobalTauri } else { $null }

$cspMap = ConvertTo-DirectiveMap $csp
$devMap = ConvertTo-DirectiveMap $devCsp

Write-Inspect "WITH_GLOBAL_TAURI=$withGlobalTauri"
Write-Inspect "CSP=$csp"
Write-Inspect "DEV_CSP=$devCsp"
Write-Inspect "CSP_SCRIPT_SRC=$(($cspMap['script-src']) -join ' ')"
Write-Inspect "DEV_CSP_SCRIPT_SRC=$(($devMap['script-src']) -join ' ')"

# ---- Production webview surface ----------------------------------------------
Add-Check 'app.withGlobalTauri=false' ($withGlobalTauri -eq $false) "actual=$withGlobalTauri"
Add-Check 'security.csp.present' (-not [string]::IsNullOrWhiteSpace($csp)) "length=$($csp.Length)"

$prodScript = @($cspMap['script-src'])
$forbiddenScriptTokens = @('*', 'http:', 'https:', 'data:', 'filesystem:', "'unsafe-hashes'")
$badScriptTokens = @($prodScript | Where-Object { $forbiddenScriptTokens -contains $_ })

Add-Check 'csp.default-src.self' (@($cspMap['default-src']) -contains "'self'") "default-src=$(($cspMap['default-src']) -join ' ')"
Add-Check 'csp.script-src.self' ($prodScript -contains "'self'") "script-src=$($prodScript -join ' ')"
Add-Check 'csp.script-src.no-unsafe-inline' (-not ($prodScript -contains "'unsafe-inline'")) "script-src=$($prodScript -join ' ')"
Add-Check 'csp.script-src.no-unsafe-eval' (-not ($prodScript -contains "'unsafe-eval'")) "script-src=$($prodScript -join ' ')"
Add-Check 'csp.script-src.no-wildcard-or-remote' ($badScriptTokens.Count -eq 0) "forbidden=[$($badScriptTokens -join ' ')]"
Add-Check 'csp.style-src.unsafe-inline' (@($cspMap['style-src']) -contains "'unsafe-inline'") 'expected for Chakra inline styles'
Add-Check 'csp.connect-src.ipc' (@($cspMap['connect-src']) -contains 'ipc:') "connect-src=$(($cspMap['connect-src']) -join ' ')"
Add-Check 'csp.worker-src.blob' (@($cspMap['worker-src']) -contains 'blob:') "worker-src=$(($cspMap['worker-src']) -join ' ')"
$imgSrc = @($cspMap['img-src'])
Add-Check 'csp.img-src.data-blob' (($imgSrc -contains 'data:') -and ($imgSrc -contains 'blob:')) "img-src=$($imgSrc -join ' ')"

# ---- Dev CSP: only the inline script allowance may differ --------------------
$devScript = @($devMap['script-src'])
$devScriptMinusInline = @($devScript | Where-Object { $_ -ne "'unsafe-inline'" })
$keyDiff = @()
foreach ($key in $cspMap.Keys) { if (-not $devMap.ContainsKey($key)) { $keyDiff += "missing:$key" } }
foreach ($key in $devMap.Keys) { if (-not $cspMap.ContainsKey($key)) { $keyDiff += "extra:$key" } }
$nonScriptDiffs = @()
foreach ($key in $cspMap.Keys) {
  if ($key -eq 'script-src') { continue }
  if ($devMap.ContainsKey($key) -and -not (Test-SetEqual $cspMap[$key] $devMap[$key])) {
    $nonScriptDiffs += $key
  }
}
$devSplitOk = ($devScript -contains "'unsafe-inline'") -and
  (Test-SetEqual $prodScript $devScriptMinusInline) -and
  ($keyDiff.Count -eq 0) -and
  ($nonScriptDiffs.Count -eq 0)
$devSplitDetail = "dev_inline=$($devScript -contains "'unsafe-inline'") keyDiff=[$($keyDiff -join ' ')] nonScriptDiffs=[$($nonScriptDiffs -join ' ')]"
Add-Check 'devCsp.differs-only-by-inline-script' $devSplitOk $devSplitDetail

# ---- Capability set -----------------------------------------------------------
$capFiles = @()
if (Test-Path -LiteralPath $CapabilitiesDir) {
  $capFiles = @(Get-ChildItem -LiteralPath $CapabilitiesDir -Filter *.json -File -ErrorAction SilentlyContinue)
}
Add-Check 'capabilities.dir.present' ($capFiles.Count -gt 0) "files=$($capFiles.Count)"

$actualNames = @($capFiles | ForEach-Object { $_.Name } | Sort-Object)
$expectedNames = @($ExpectedCapabilities | Sort-Object)
$missingNames = @($expectedNames | Where-Object { $actualNames -notcontains $_ })
$unexpectedNames = @($actualNames | Where-Object { $expectedNames -notcontains $_ })
# The installed tier is PART of the expected truth, named here so a disappearance
# reads as "the installed tier is gone" and not merely as a count mismatch.
$installedTierPresent = $actualNames -contains 'installed-app-commands.json'
$expectedFilesOk = ($missingNames.Count -eq 0) -and ($unexpectedNames.Count -eq 0) -and $installedTierPresent
Add-Check 'capabilities.expected-files' $expectedFilesOk "actual=[$($actualNames -join ',')] expected=[$($expectedNames -join ',')] installedTier=$installedTierPresent missing=[$($missingNames -join ',')] unexpected=[$($unexpectedNames -join ',')]"

$capDocs = @{}
foreach ($file in $capFiles) {
  try {
    $capDocs[$file.Name] = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
  } catch {
    $capDocs[$file.Name] = $null
  }
}

$defaultDoc = $capDocs['default.json']
$defaultPerms = @()
if ($null -ne $defaultDoc) { $defaultPerms = @($defaultDoc.permissions) }
$defaultShell = @($defaultPerms | Where-Object { $_ -match '^shell:' })
$defaultBridge = @($defaultPerms | Where-Object { $_ -match '^mcp-bridge' })
Add-Check 'capabilities.default.identifier' ($null -ne $defaultDoc -and $defaultDoc.identifier -eq 'default') "identifier=$(if ($null -ne $defaultDoc) { $defaultDoc.identifier } else { '' })"
Add-Check 'capabilities.default.no-shell' ($defaultShell.Count -eq 0) "shell=[$($defaultShell -join ',')]"
Add-Check 'capabilities.default.no-bridge' ($defaultBridge.Count -eq 0) "bridge=[$($defaultBridge -join ',')]"

$bridgeDoc = $capDocs['mcp-bridge-dev.json']
$bridgePerms = @()
if ($null -ne $bridgeDoc) { $bridgePerms = @($bridgeDoc.permissions) }
$bridgePermsOk = ($bridgePerms.Count -eq 1) -and ($bridgePerms[0] -eq 'mcp-bridge:default')
Add-Check 'capabilities.bridge.identifier' ($null -ne $bridgeDoc -and $bridgeDoc.identifier -eq 'mcp-bridge-dev') "identifier=$(if ($null -ne $bridgeDoc) { $bridgeDoc.identifier } else { '' })"
Add-Check 'capabilities.bridge.permissions' $bridgePermsOk "permissions=[$($bridgePerms -join ',')]"

$platformsOk = ($null -ne $defaultDoc) -and ($null -ne $bridgeDoc) -and
  (Test-SetEqual @($defaultDoc.platforms) @($bridgeDoc.platforms)) -and
  (Test-SetEqual @($defaultDoc.windows) @($bridgeDoc.windows))
Add-Check 'capabilities.bridge.scope-matches-default' $platformsOk 'platforms + windows must match default.json'

$shellFiles = @()
foreach ($file in $capFiles) {
  try {
    $raw = Get-Content -Raw -LiteralPath $file.FullName
    if ($raw -match 'shell:allow-(spawn|execute|open)') { $shellFiles += $file.Name }
  } catch {}
}
Add-Check 'capabilities.all.no-shell-exec' ($shellFiles.Count -eq 0) "files=[$($shellFiles -join ',')]"

$securityPropNames = if ($null -ne $security) { @($security.PSObject.Properties.Name) } else { @() }
$hasExplicitCapabilities = $securityPropNames -contains 'capabilities'
$explicitCaps = @()
if ($hasExplicitCapabilities) { $explicitCaps = @($security.capabilities) }
$releaseBridgeOk = if ($hasExplicitCapabilities) { -not ($explicitCaps -contains 'mcp-bridge-dev') } else { $true }
$releaseDetail = if ($hasExplicitCapabilities) { "explicit=[$($explicitCaps -join ',')]" } else { 'auto-includes the capabilities dir; bridge permission is inert because the plugin is cfg(debug_assertions)-gated' }
Add-Check 'capabilities.release-set.excludes-bridge' $releaseBridgeOk $releaseDetail

# ---- Installed tier: exactly ONE capability, exactly ONE command --------------
# The ACL glob-matches a capability's `windows`/`webviews` entries against the
# window label. An installed app's label always begins with `installed-`
# (INSTALLED_APP_WINDOW_LABEL_PREFIX), and the built-in family is
# `main`/`terminal`/`doom`/`app-*` — different prefixes, so no label is both.
#
# Spec #3146 SUPERSEDED the #3147 invariant "NO capability may reach an
# installed-* label" (supersedes, never deletes) with the positive property:
#   an installed window matches EXACTLY ONE capability, which grants EXACTLY ONE
#   command (`installed_app_invoke`, via `allow-installed-app-invoke`) and
#   carries NO `core:*`; every OTHER capability still matches no installed label.
# The second clause is what makes "exactly one command" true at the ACL: with
# the app manifest registered, a command reaches a window only through a
# capability whose permissions grant it, so a second matching capability (or a
# second permission in the one that matches) is a widening and this check
# reddens on it.
#
# The predicate is the PARSED matcher — never a token grep: the installed
# capability names the installed namespace BY DESIGN, so a literal `installed-`
# search now legitimately hits a correct tree (G-430). The probe label lives in
# this instrument, which is outside the scanned root, so it cannot count itself.
function Test-GlobMatch {
  param([string]$Pattern, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($Pattern)) { return $false }
  return $Label -like $Pattern   # Tauri window patterns are globs: * ? [..]
}

$installedCapabilityFile = 'installed-app-commands.json'
$installedCapabilityIdentifier = 'installed-app-commands'
$installedPermission = 'allow-installed-app-invoke'
$probeLabel = 'installed-fixture'

# NON-VACUITY CONTROL, both directions: the built-in class is reachable through
# `app-*`; an installed label is NOT; `installed-*` matches an installed label;
# and `installed-*` does NOT swallow any built-in label. A matcher that matched
# everything (or nothing) would blur the two tiers while every count below still
# read correctly.
$matchControlOk = (Test-GlobMatch -Pattern 'app-*' -Label 'app-terminal') -and
  (-not (Test-GlobMatch -Pattern 'app-*' -Label 'installed-app-terminal')) -and
  (Test-GlobMatch -Pattern 'installed-*' -Label 'installed-app-terminal') -and
  (-not (Test-GlobMatch -Pattern 'installed-*' -Label 'app-terminal')) -and
  (-not (Test-GlobMatch -Pattern 'installed-*' -Label 'main'))

$matchedFiles = @()
$otherReach = @()
$undeclaredReach = @()
$installedDoc = $null
$installedWindows = @()
$installedWebviews = @()
$installedPermissions = @()
foreach ($file in $capFiles) {
  $doc = $capDocs[$file.Name]
  if ($null -eq $doc) { $undeclaredReach += "$($file.Name):unparseable"; continue }
  $windowEntries  = @($doc.windows  | Where-Object { $null -ne $_ })
  $webviewEntries = @($doc.webviews | Where-Object { $null -ne $_ })
  $reachEntries = @($windowEntries + $webviewEntries)
  # An entry either glob-matches the probe or (a specific installed id, a
  # narrower glob) names the namespace without matching it. Both are reach.
  $hitEntries = @($reachEntries | Where-Object {
    $entryText = [string]$_
    (Test-GlobMatch -Pattern $entryText -Label $probeLabel) -or ($entryText -match '(?i)installed')
  })
  if ($hitEntries.Count -gt 0) { $matchedFiles += $file.Name }

  if ($file.Name -eq $installedCapabilityFile) {
    $installedDoc = $doc
    $installedWindows = @($windowEntries | ForEach-Object { [string]$_ })
    $installedWebviews = @($webviewEntries | ForEach-Object { [string]$_ })
    $installedPermissions = @($doc.permissions | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
    continue
  }

  # Fail CLOSED: a capability with neither list declares no reach we can prove
  # excludes installed-*. An absent/empty `windows` (and no `webviews`) FAILS
  # here rather than being skipped as "matches nothing" (Spec #3147 QA row F-2.5).
  if ($reachEntries.Count -eq 0) { $undeclaredReach += "$($file.Name):no-windows-or-webviews" }
  if ($hitEntries.Count -gt 0) {
    $otherReach += "$($file.Name):$(@($hitEntries | ForEach-Object { [string]$_ }) -join '|')"
  }
}

$installedCore = @($installedPermissions | Where-Object { $_ -match '^core:' })
$installedIdentifier = if ($null -ne $installedDoc) { [string]$installedDoc.identifier } else { '' }
$installedTierOk =
  $matchControlOk -and
  ($matchedFiles.Count -eq 1) -and
  ($matchedFiles[0] -eq $installedCapabilityFile) -and
  ($null -ne $installedDoc) -and
  ($installedIdentifier -eq $installedCapabilityIdentifier) -and
  ($installedWindows.Count -eq 1) -and
  ($installedWindows[0] -eq 'installed-*') -and
  ($installedWebviews.Count -eq 0) -and
  ($installedPermissions.Count -eq 1) -and
  ($installedPermissions[0] -eq $installedPermission) -and
  ($installedCore.Count -eq 0) -and
  ($otherReach.Count -eq 0) -and
  ($undeclaredReach.Count -eq 0)
$installedTierDetail = "matching=[$($matchedFiles -join ',')] identifier=$installedIdentifier windows=[$($installedWindows -join ',')] webviews=[$($installedWebviews -join ',')] permissions=[$($installedPermissions -join ',')] core=[$($installedCore -join ',')] expectedPermission=$installedPermission matchControl=$matchControlOk probe=$probeLabel otherReach=[$($otherReach -join ' ')] undeclared=[$($undeclaredReach -join ' ')]"
Add-Check 'capabilities.installed-tier.exact' $installedTierOk $installedTierDetail

# ---- The bridge plugin registration must be debug-only ----------------------
$libText = if (Test-Path -LiteralPath $LibPath) { Get-Content -Raw -LiteralPath $LibPath } else { '' }
$pluginOk = $false
$pluginDetail = 'registration not found'
$pluginIndex = $libText.IndexOf('tauri_plugin_mcp_bridge')
if ($pluginIndex -ge 0) {
  $windowStart = [Math]::Max(0, $pluginIndex - 600)
  $before = $libText.Substring($windowStart, $pluginIndex - $windowStart)
  $lastCfg = $before.LastIndexOf('#[cfg(')
  if ($lastCfg -ge 0) {
    $attrEnd = $before.IndexOf(']', $lastCfg)
    $attr = if ($attrEnd -ge 0) { $before.Substring($lastCfg, $attrEnd - $lastCfg + 1) } else { '' }
    $pluginOk = ($attr -eq '#[cfg(debug_assertions)]')
    $pluginDetail = "gate=$attr"
  } else {
    $pluginDetail = 'no #[cfg(...)] gate before the plugin registration'
  }
}
Add-Check 'bridge.plugin.debug-only' $pluginOk $pluginDetail

# ---- No window.__TAURI__ global in product source ---------------------------
$scanDirs = @(
  (Join-Path $RepoRoot 'apps\ui\src'),
  (Join-Path $RepoRoot 'apps\tauri\src-tauri\src')
)
$tauriGlobalHits = @()
foreach ($dir in $scanDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.ts', '.tsx', '.js', '.jsx', '.rs') })
  foreach ($file in $files) {
    try {
      $found = @(Select-String -LiteralPath $file.FullName -Pattern '\b__TAURI__\b' -ErrorAction Stop)
      if ($found.Count -gt 0) { $tauriGlobalHits += $found }
    } catch {}
  }
}
Add-Check 'product.no-__TAURI__' ($tauriGlobalHits.Count -eq 0) "hits=$($tauriGlobalHits.Count)"

# ---- Report -------------------------------------------------------------------
$releaseIds = @()
foreach ($name in $actualNames) {
  $doc = $capDocs[$name]
  if ($null -ne $doc -and -not [string]::IsNullOrWhiteSpace($doc.identifier)) { $releaseIds += $doc.identifier }
}
if ($hasExplicitCapabilities) {
  Write-Inspect "RELEASE_CAPABILITIES=$($explicitCaps -join ',')"
} else {
  Write-Inspect "RELEASE_CAPABILITIES=$($releaseIds -join ',')"
}
Write-Inspect "BRIDGE_IN_RELEASE=$(if ($pluginOk) { 'inert' } else { 'CHECK' })"

$passed = 0
$failed = 0
foreach ($check in $script:Checks) {
  if ($check.Ok) { $passed++ } else { $failed++ }
  $status = if ($check.Ok) { 'PASS' } else { 'FAIL' }
  Write-Inspect ("CHECK {0} {1} {2}" -f $check.Name, $status, $check.Detail)
}

Write-Inspect ("SUMMARY checks={0} passed={1} failed={2}" -f $script:Checks.Count, $passed, $failed)
if ($failed -eq 0) {
  Write-Inspect 'RESULT=PASS'
  exit 0
}
Write-Inspect 'RESULT=FAIL'
exit 1
