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
    * the capability set is the expected release set, with no shell permissions
      (shell:allow-spawn / shell:allow-execute / shell:allow-open);
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
  `default.json,mcp-bridge-dev.json`. Update this list (in the same change) when
  a spec legitimately adds a capability file.

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
  [string[]]$ExpectedCapabilities = @('default.json', 'mcp-bridge-dev.json')
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
Add-Check 'capabilities.expected-files' (Test-SetEqual $actualNames $expectedNames) "actual=[$($actualNames -join ',')] expected=[$($expectedNames -join ',')]"

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
