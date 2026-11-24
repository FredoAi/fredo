<#
.SYNOPSIS
  Per-user login-entry registry instrument for the background-capture suite (issue #3193).

.DESCRIPTION
  Pipeline/test tooling (NOT product code). Read/seed/clear the ONE persisted artifact of the
  start-at-login feature:

    HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest   (REG_SZ)

  It exists because NO committed helper reads this value: a sweep of `.opencode/scripts/**` finds
  only the Rust implementation (`applications/settings/autostart.rs`) and prose. The tester's
  granted route is `powershell -File .opencode/tests/*` (run through
  `.opencode/scripts/run-exitcode.ps1 -Command ...`), so the instrument lives in this suite.

  EVERY reading is printed as a `KEY=value` line so a verdict can quote it verbatim.

  WHY .NET WRITES, reg.exe READS. The product writes the value through a Rust arg-array child
  (`reg add ... /t REG_SZ /d "<data>" /f`), which transports a quote-bearing string exactly. A
  PowerShell 5.1 `& reg.exe ...` call re-quotes/escapes embedded `"` differently and would MANGLED
  the seeded data (a false instrument). So mutations use the .NET registry API, which writes the
  exact string with no argument transport in the middle, and the READ is corroborated by a real
  `reg.exe query` (the same surface the product reads through).

  AN ABSENT INPUT IS NEVER A READING (G-469: two empty readings are equal).
    * `-Exe` supplied but not on disk, or `-AppPid` not live, or `-SeedLegacy` with neither
      => exit 2 with `ERROR: ...`. The script never falls back to a guessed executable.
    * `-Restore` with no backup file => exit 2 (there is nothing to restore).
    * `reg.exe` missing / exiting other than 0 or 1, or a .NET-vs-reg.exe disagreement
      => exit 2 (the instrument is wrong; do not report a "Present/Absent" from it).
    * a post-write verification mismatch => exit 2 with BOTH readings.
  A reading that merely contradicts the caller's `-Expect` is a TEST signal, not an instrument
  failure: that exits 1.

  INPUT vs TARGET (the contract, stated so no tester has to infer it):
    * An absent INPUT fails closed (exit 2): a named executable that is not on disk, a dead PID,
      a `-SeedLegacy` with no executable, a `-Restore` with no backup file.
    * An absent TARGET is a READING, never a failure: `FredoIngest` not being present is the most
      common state this instrument must report, so `-Read` prints `ENTRY=Absent` and exits 0, and
      `-Clear` on an already-absent value is a documented NO-OP (`CLEAR_WAS_ALREADY_ABSENT=True`,
      `DELETE_VERIFIED=Absent`, exit 0) - clearing is idempotent, its postcondition is "absent".

  PS 5.1 STERNNESS (#3193 round 1 defect, fixed here). The script-wide
  `$ErrorActionPreference = "Stop"` plus a `2>&1` merge on `reg.exe query` converted the absent-value
  case into a TERMINATING `NativeCommandError`, so the instrument could not report the state it was
  written for. `reg.exe` is now called with a SCOPED `Continue` preference, its stderr is DISCARDED
  (never merged into the parsed success stream), and its exit code is the reading: 0 = Present,
  1 = Absent, anything else = `ERROR:` exit 2. Note the same PowerShell rule for PARAMETER names:
  parameters live in the script scope with case-insensitive names, so a local `$backup` IS the
  `[switch]$Backup` parameter - locals are named `$restoreRecord` and friends instead.

  SAFETY. The per-user Run key is real machine state: a developer may have a genuine
  `FredoIngest` entry. Every MUTATING mode (-SeedLegacy / -SeedForeign / -Clear) auto-creates a
  backup of the CURRENT value first (unless a backup already exists at -BackupPath, which is then
  kept as the original), and `-Restore` puts it back byte-for-byte. Always finish a round with
  `-Restore`.

  QUOTE CONTRACT (bound by the plan, `## Software Architect` API contract 4): the owned value is
  exactly one ASCII double-quote pair around the absolute current executable, exactly one ASCII
  space, then the literal `--background`; no trailing space, no extra arguments. `-Read` prints the
  raw bytes AND a per-token breakdown, so the row asserts the AC's wording rather than trusting a
  reconstructed string (the instrument is not the oracle).

.MODES (exactly one required)
  -Read          Print the resolved value path, Present|Absent, the raw data verbatim, its SHA-256,
                 the token breakdown, and (when an executable is resolvable) the expected owned
                 string with a byte-equality verdict. Both states exit 0; only a genuinely absent
                 INPUT (a named exe not on disk, a dead -AppPid) exits 2.
  -SeedLegacy    Write `"<exe>" ingest` (the pre-#3193 login command shape) and verify it.
  -SeedForeign   Write a value this product does NOT own and verify it. Default data is a
                 legacy-SHAPED command naming another executable
                 (`"C:\Program Files\Contoso\contoso.exe" ingest`), so a predicate that matches only
                 the `ingest` tail is caught. Override with -ForeignCommand.
  -Clear         Remove the value (and verify it is absent). Idempotent: when the value is already
                 absent this is a printed NO-OP (`CLEAR_WAS_ALREADY_ABSENT=True`), exit 0.
  -Backup        Write the current value (or its absence) to -BackupPath.
  -Restore       Put the backed-up value back (or remove it when the backup recorded absence) and
                 verify byte equality.

.PARAMETERS
  -Exe <path>            The executable the current value should name (normally the running app's
                         image, e.g. apps/tauri/src-tauri/target/debug/fredo.exe). Required by
                         -SeedLegacy; optional for -Read.
  -AppPid <pid>          Resolve the executable from a LIVE process instead of -Exe. Hard-fails when
                         the PID is not live (an absent input must not read as "no mismatch").
  -ForeignCommand <s>    The exact data -SeedForeign writes (default: the Contoso stand-in above).
  -BackupPath <path>     Backup file (default: <repo>/.opencode/tmp/3193/registry-backup.json).
  -Expect <Present|Absent>
                         Assert the reading; a contradiction exits 1 (test signal).

.EXAMPLE
  powershell -File .opencode/tests/background-capture/registry-entry.ps1 -Read -Exe apps/tauri/src-tauri/target/debug/fredo.exe

.EXAMPLE
  powershell -File .opencode/tests/background-capture/registry-entry.ps1 -SeedLegacy -Exe apps/tauri/src-tauri/target/debug/fredo.exe

.EXAMPLE
  powershell -File .opencode/tests/background-capture/registry-entry.ps1 -Restore

  Exit codes: 0 success; 1 reading contradicts -Expect; 2 usage / absent input / instrument or
  write-verification failure.

  PowerShell 5.1-safe. ASCII only outside comments.
#>
param(
  [switch]$Read,
  [switch]$SeedLegacy,
  [switch]$SeedForeign,
  [switch]$Clear,
  [switch]$Backup,
  [switch]$Restore,
  [string]$Exe = "",
  [int]$AppPid = 0,
  [string]$ForeignCommand = "",
  [string]$BackupPath = "",
  [ValidateSet("", "Present", "Absent")][string]$Expect = ""
)

$ErrorActionPreference = "Stop"

# ---- Constants (the product's own names; autostart.rs:22,25) -------------------
$RunKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
$RunSubKey = "Software\Microsoft\Windows\CurrentVersion\Run"
$ValueName = "FredoIngest"
$ValuePath = $RunKey + "\" + $ValueName
$DefaultForeignCommand = '"C:\Program Files\Contoso\contoso.exe" ingest'
$OwnedTail = "--background"

function Write-Fail {
  param([string]$Message)
  Write-Output ("ERROR: " + $Message)
  exit 2
}

function Get-Sha256Hex {
  param([string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $hash = $sha.ComputeHash($bytes)
    $builder = New-Object System.Text.StringBuilder
    foreach ($byte in $hash) { [void]$builder.Append($byte.ToString("x2")) }
    return $builder.ToString()
  } finally {
    $sha.Dispose()
  }
}

# ---- Mode gate -----------------------------------------------------------------
$modes = @()
if ($Read) { $modes += "-Read" }
if ($SeedLegacy) { $modes += "-SeedLegacy" }
if ($SeedForeign) { $modes += "-SeedForeign" }
if ($Clear) { $modes += "-Clear" }
if ($Backup) { $modes += "-Backup" }
if ($Restore) { $modes += "-Restore" }
if ($modes.Count -ne 1) {
  Write-Fail ("specify exactly one mode: -Read, -SeedLegacy, -SeedForeign, -Clear, -Backup or -Restore (saw " + $modes.Count + ")")
}
$mode = $modes[0].TrimStart("-")

# ---- Paths ---------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($BackupPath)) {
  $repoRoot = ""
  try { $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path } catch { $repoRoot = "" }
  if ([string]::IsNullOrWhiteSpace($repoRoot)) {
    Write-Fail "cannot resolve the repository root from the script location; pass -BackupPath"
  }
  $BackupPath = Join-Path $repoRoot ".opencode\tmp\3193\registry-backup.json"
}

# ---- Resolve the executable (never guessed) ------------------------------------
function Resolve-Executable {
  $path = ""
  $source = ""
  if (-not [string]::IsNullOrWhiteSpace($Exe)) {
    $path = $Exe
    $source = "param"
  } elseif ($AppPid -gt 0) {
    $proc = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
      Write-Fail ("-AppPid " + $AppPid + " is not a live process: cannot resolve the executable (an absent input is not a reading)")
    }
    try { $path = [string]$proc.Path } catch { $path = "" }
    if ([string]::IsNullOrWhiteSpace($path)) {
      Write-Fail ("PID " + $AppPid + " reports no executable path; run the probe as that process's owner")
    }
    $source = "apppid"
  } else {
    return $null
  }
  $resolved = Resolve-Path -LiteralPath $path -ErrorAction SilentlyContinue
  if ($null -eq $resolved) {
    Write-Fail ("executable not found: " + $path + " (an expected value must never be built from a path that does not exist)")
  }
  return [pscustomobject]@{
    Path   = [string]$resolved.Path
    Source = $source
  }
}

# ---- Registry read (primary .NET, corroborated by reg.exe) ---------------------
function Read-Entry {
  $state = [pscustomobject]@{
    KeyPresent   = $false
    Present      = $false
    Data         = ""
    Kind         = ""
    RegExeCode   = -1
    RegExePresent = $false
    RegExeOutput = ""
  }
  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunSubKey, $false)
  } catch {
    Write-Fail ("cannot open HKCU\" + $RunSubKey + ": " + $_.Exception.Message)
  }
  $readError = ""
  if ($null -ne $key) {
    $state.KeyPresent = $true
    try {
      # Presence comes from the key's OWN value-name list. The previous version asked
      # GetValueKind first and treated ANY exception as "Absent", which made a real read failure
      # indistinguishable from a missing value. A missing value is now a computed fact, and a
      # genuine read error is lifted out of the try and reported as an instrument failure.
      $found = $false
      foreach ($name in @($key.GetValueNames())) {
        if ($name -eq $ValueName) { $found = $true }
      }
      if ($found) {
        $state.Present = $true
        $kind = $key.GetValueKind($ValueName)
        $state.Kind = [string]$kind
        $raw = $key.GetValue($ValueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $raw) { $state.Data = "" } else { $state.Data = [string]$raw }
      }
    } catch {
      $readError = $_.Exception.Message
    } finally {
      try { $key.Close() } catch { }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($readError)) {
    Write-Fail ("reading HKCU\" + $RunSubKey + "\" + $ValueName + " failed: " + $readError + " (an unreadable value is NOT the reading 'Absent')")
  }

  # Independent corroboration: the same reg.exe surface the product reads through.
  # #3193 ROUND 1 DEFECT: `& reg.exe query ... 2>&1` under the script-wide
  # $ErrorActionPreference='Stop' turns reg.exe's stderr record into a TERMINATING error, so an
  # ABSENT value - the state this instrument most often reports - killed the run before it could
  # print "Absent". Fixed by scoping the preference to Continue for this call only, DISCARDING
  # stderr instead of merging it into the parsed output, and reading the exit code as the fact:
  # 0 = Present, 1 = Absent, ANY other code = hard instrument failure (never swallowed).
  $regOutput = @()
  $regCode = -1
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $regOutput = @(& reg.exe query $RunKey /v $ValueName 2>$null)
    # `[int]$null` is 0 (= "Present"), so an UNSET automatic variable must never be coerced into a
    # reading: it is mapped to a code no run can produce, which fails the 0/1 gate below.
    $regExit = $LASTEXITCODE
    if ($null -eq $regExit) { $regCode = -999 } else { $regCode = [int]$regExit }
  } catch {
    $regError = $_.Exception.Message
    $ErrorActionPreference = $previousPreference
    Write-Fail ("reg.exe query could not be run: " + $regError)
  }
  $ErrorActionPreference = $previousPreference
  if ($regCode -ne 0 -and $regCode -ne 1) {
    Write-Fail ("reg.exe query exited " + $regCode + " (only 0=Present and 1=Absent are readings; any other code is an instrument failure): " + (@($regOutput) -join " | "))
  }
  $state.RegExeCode = $regCode
  $state.RegExePresent = ($regCode -eq 0)
  $state.RegExeOutput = (@($regOutput) -join " | ")

  if ($state.RegExePresent -ne $state.Present) {
    Write-Fail ("INSTRUMENT INCONSISTENCY: the .NET read says Present=" + $state.Present + " but reg.exe says Present=" + $state.RegExePresent + " - do not report a reading from this run")
  }
  return $state
}

# A digest is only printed for a value that EXISTS: SHA-256 of the empty string looks like a real
# digest of a real value and would let an absent reading compare "equal" to another absent one.
function Get-StateDigest {
  param($State)
  if ($null -eq $State) { return "(absent)" }
  if ($State.Present) { return (Get-Sha256Hex -Text $State.Data) }
  return "(absent)"
}


# ---- Token breakdown (the AC's wording, not a reconstructed literal) -----------
function Get-TokenBreakdown {
  param([string]$Data)
  $quoteCount = 0
  foreach ($character in $Data.ToCharArray()) {
    if ($character -eq '"') { $quoteCount++ }
  }
  $open = $false
  if ($Data.Length -gt 0) { if ($Data.Substring(0, 1) -eq '"') { $open = $true } }
  $closeIndex = -1
  if ($open) { $closeIndex = $Data.IndexOf('"', 1) }
  $quotedExe = ""
  $tail = ""
  if ($open -and $closeIndex -gt 0) {
    $quotedExe = $Data.Substring(1, $closeIndex - 1)
    $tail = $Data.Substring($closeIndex + 1)
  }
  $separatorSpaces = 0
  $index = 0
  while ($index -lt $tail.Length) {
    if ($tail.Substring($index, 1) -eq ' ') { $separatorSpaces++; $index++ } else { break }
  }
  $tailTrimmed = $tail.Trim()
  $trailingWhitespace = $false
  if ($tail.Length -gt 0) {
    $last = $tail.Substring($tail.Length - 1, 1)
    if ($last -eq ' ' -or $last -eq "`t") { $trailingWhitespace = $true }
  }
  $tailIsBackground = ($tailTrimmed -ceq $OwnedTail)
  $tailIsIngest = ($tailTrimmed -ieq "ingest")
  return [pscustomobject]@{
    QuoteCount        = $quoteCount
    QuoteOpen         = $open
    QuotedExe         = $quotedExe
    Tail              = $tail
    TailTrimmed       = $tailTrimmed
    SeparatorSpaces   = $separatorSpaces
    TrailingWhitespace = $trailingWhitespace
    TailIsBackground  = $tailIsBackground
    TailIsIngest      = $tailIsIngest
  }
}

# ---- Writes / deletes (exact strings; no native argument transport) ------------
function Set-Entry {
  param([string]$Data, [string]$Why)
  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunSubKey, $true)
  } catch {
    Write-Fail ("cannot open HKCU\" + $RunSubKey + " for writing: " + $_.Exception.Message)
  }
  if ($null -eq $key) { Write-Fail ("the per-user Run key does not exist and could not be opened for writing: " + $RunKey) }
  try {
    $key.SetValue($ValueName, $Data, [Microsoft.Win32.RegistryValueKind]::String)
  } catch {
    Write-Fail ("writing " + $ValueName + " (" + $Why + ") failed: " + $_.Exception.Message)
  } finally {
    $key.Close()
  }
  $after = Read-Entry
  if (-not $after.Present) {
    Write-Fail ("wrote " + $ValueName + " (" + $Why + ") but the read-back reports Absent - the write did not land")
  }
  if ($after.Data -cne $Data) {
    Write-Fail ("wrote " + $ValueName + " (" + $Why + ") but the read-back differs. WROTE_LENGTH=" + $Data.Length + " READ_LENGTH=" + $after.Data.Length + " READ_RAW=" + $after.Data)
  }
  Write-Output ("WRITE_VERIFIED=True")
  Write-Output ("WRITE_RAW=" + $Data)
  Write-Output ("WRITE_RAW_SHA256=" + (Get-Sha256Hex -Text $Data))
}

function Remove-Entry {
  param([string]$Why)
  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunSubKey, $true)
  } catch {
    Write-Fail ("cannot open HKCU\" + $RunSubKey + " for writing: " + $_.Exception.Message)
  }
  if ($null -eq $key) {
    # No key means no value; an absent target is already the postcondition.
    Write-Output "RUN_KEY_EXISTS=False"
    Write-Output "DELETE_VERIFIED=Absent"
    return
  }
  try {
    $key.DeleteValue($ValueName, $false)
  } catch {
    Write-Fail ("deleting " + $ValueName + " (" + $Why + ") failed: " + $_.Exception.Message)
  } finally {
    $key.Close()
  }
  $after = Read-Entry
  if ($after.Present) {
    Write-Fail ("deleted " + $ValueName + " (" + $Why + ") but the read-back still reports Present: " + $after.Data)
  }
  Write-Output ("DELETE_VERIFIED=Absent")
}

# ---- Backup / restore ----------------------------------------------------------
function Read-Backup {
  $path = $BackupPath
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $parsed = $null
  try { $parsed = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) } catch { $parsed = $null }
  if ($null -eq $parsed) {
    Write-Fail ("backup file is not valid JSON: " + $path + " (delete it and re-run -Backup to re-record the host state)")
  }
  return $parsed
}

function Write-BackupFile {
  $current = Read-Entry
  $directory = Split-Path -Parent $BackupPath
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  }
  $payload = [pscustomobject]@{
    valuePath = $ValuePath
    present   = [bool]$current.Present
    data      = [string]$current.Data
    kind      = [string]$current.Kind
    userSid   = [string]([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    savedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  $json = $payload | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($BackupPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ("BACKUP_PATH=" + $BackupPath)
  Write-Output ("BACKUP_PRESENT=" + $payload.present)
  Write-Output ("BACKUP_RAW=" + $payload.data)
  Write-Output ("BACKUP_RAW_SHA256=" + (Get-StateDigest -State $current))
}

function Ensure-BackupBeforeMutation {
  $existing = Read-Backup
  if ($null -ne $existing) {
    $existingState = [pscustomobject]@{ Present = [bool]$existing.present; Data = [string]$existing.data }
    Write-Output ("BACKUP_EXISTING=True")
    Write-Output ("BACKUP_PATH=" + $BackupPath)
    Write-Output ("BACKUP_PRESENT=" + $existing.present)
    Write-Output ("BACKUP_RAW=" + [string]$existing.data)
    Write-Output ("BACKUP_RAW_SHA256=" + (Get-StateDigest -State $existingState))
    return
  }
  Write-Output "BACKUP_CREATED=auto"
  Write-BackupFile
}

# ---- Header (every run) --------------------------------------------------------
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = ""
try { $sid = [string]$identity.User.Value } catch { $sid = "(unresolved)" }
$is64 = $false
try { $is64 = [Environment]::Is64BitProcess } catch { $is64 = $false }

Write-Output "INSTRUMENT=registry-entry.ps1"
Write-Output ("MODE=" + $mode)
Write-Output ("TIMESTAMP=" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
Write-Output ("VALUE_NAME=" + $ValueName)
Write-Output ("VALUE_PATH=" + $ValuePath)
Write-Output "HIVE=HKEY_CURRENT_USER"
Write-Output ("USER_SID=" + $sid)
Write-Output ("RESOLVED_FROM=per-user HKCU of the invoking user (" + $sid + ")")
Write-Output ("PS_IS_64BIT=" + $is64)
Write-Output ("BACKUP_PATH=" + $BackupPath)
if (-not [string]::IsNullOrWhiteSpace($Expect)) { Write-Output ("EXPECTATION=" + $Expect) }

$executable = Resolve-Executable
if ($null -ne $executable) {
  Write-Output ("EXE=" + $executable.Path)
  Write-Output ("EXE_SOURCE=" + $executable.Source)
  Write-Output ("EXE_CANONICAL=" + $executable.Path)
} else {
  Write-Output "EXE=(unresolved)"
  Write-Output "EXE_SOURCE=none"
}

# ---- Modes ---------------------------------------------------------------------
if ($mode -eq "Backup") {
  $state = Read-Entry
  Write-Output ("RUN_KEY_EXISTS=" + $state.KeyPresent)
  if ($state.Present) { Write-Output "ENTRY=Present" } else { Write-Output "ENTRY=Absent" }
  Write-Output ("RAW=" + $state.Data)
  Write-Output ("RAW_SHA256=" + (Get-StateDigest -State $state))
  Write-Output ("REG_EXE_QUERY_CODE=" + $state.RegExeCode)
  Write-Output ("REG_EXE_QUERY=" + $state.RegExeOutput)
  Write-Output ("BACKUP_EXISTING=" + (Test-Path -LiteralPath $BackupPath))
  if (Test-Path -LiteralPath $BackupPath) {
    Write-Output "REFUSING_TO_OVERWRITE_EXISTING_BACKUP=True"
    Write-Output ("HINT=delete " + $BackupPath + " first if you really mean to re-record this host's value")
  } else {
    Write-BackupFile
  }
  Write-Output "RESULT=OK"
  exit 0
}

if ($mode -eq "Restore") {
  # #3193 ROUND 1 DEFECT: this local was named `$backup`. PowerShell parameter names live in the
  # script scope and are CASE-INSENSITIVE, so `$backup` IS the `[switch]$Backup` parameter and
  # assigning a parsed record to it threw "Cannot convert ... to SwitchParameter" - disabling an
  # entire evidence path. The public surface stays `-Backup`; the local is `$restoreRecord`.
  $restoreRecord = Read-Backup
  if ($null -eq $restoreRecord) {
    Write-Fail ("no backup to restore at " + $BackupPath + " - run -Backup (or a -Seed* mode, which backs up automatically) before mutating")
  }
  if ([string]$restoreRecord.valuePath -ne $ValuePath) {
    Write-Fail ("backup names a different value path (" + [string]$restoreRecord.valuePath + ") than this instrument owns (" + $ValuePath + ")")
  }
  $recordedData = [string]$restoreRecord.data
  $recordedPresent = [bool]$restoreRecord.present
  Write-Output ("RESTORE_FROM=" + $BackupPath)
  Write-Output ("RESTORE_RECORDED_PRESENT=" + $recordedPresent)
  Write-Output ("RESTORE_RECORDED_RAW=" + $recordedData)
  if ($recordedPresent) {
    Set-Entry -Data $recordedData -Why "restore"
    Write-Output "RESTORED=Present"
  } else {
    Remove-Entry -Why "restore (recorded absence)"
    Write-Output "RESTORED=Absent"
  }
  $final = Read-Entry
  $match = $true
  if ($recordedPresent -ne $final.Present) { $match = $false }
  if ($recordedPresent -and ($final.Data -cne $recordedData)) { $match = $false }
  Write-Output ("RESTORED_MATCH=" + $match)
  if (-not $match) {
    Write-Fail ("restore did not reproduce the backed-up state: RECORDED_PRESENT=" + $recordedPresent + " NOW_PRESENT=" + $final.Present + " RECORDED_RAW=" + $recordedData + " NOW_RAW=" + $final.Data)
  }
  Write-Output ("POST_RESTORE_RAW_SHA256=" + (Get-StateDigest -State $final))
  Write-Output "RESULT=OK"
  exit 0
}

if ($mode -eq "SeedLegacy") {
  if ($null -eq $executable) {
    Write-Fail "-SeedLegacy needs -Exe or -AppPid (there is no executable to quote; never seed a guessed path)"
  }
  Ensure-BackupBeforeMutation
  $legacy = '"' + $executable.Path + '" ingest'
  Write-Output ("SEED_KIND=LegacyIngest")
  Write-Output ("SEED_RAW=" + $legacy)
  Set-Entry -Data $legacy -Why "seed legacy ingest login command"
  Write-Output "RESULT=OK"
  exit 0
}

if ($mode -eq "SeedForeign") {
  Ensure-BackupBeforeMutation
  $data = $ForeignCommand
  if ([string]::IsNullOrWhiteSpace($data)) { $data = $DefaultForeignCommand }
  Write-Output "SEED_KIND=Foreign"
  Write-Output ("SEED_RAW=" + $data)
  Write-Output "SEED_FOREIGN_PURPOSE=a command this product does not own; it must stay byte-identical at startup and on either toggle"
  Set-Entry -Data $data -Why "seed foreign login command"
  Write-Output "RESULT=OK"
  exit 0
}

if ($mode -eq "Clear") {
  Ensure-BackupBeforeMutation
  $clearState = Read-Entry
  if (-not $clearState.Present) {
    # DOCUMENTED -Clear CONTRACT (so the tester needs no inference): clearing an ALREADY-ABSENT
    # value is a NO-OP that says so and exits 0. `-Clear`'s postcondition is "absent", not
    # "absent because this run removed it", so an already-clear key is SUCCESS - it is an absent
    # TARGET (a reading), not an absent INPUT (which would be exit 2). The backup taken just above
    # still proves the invocation ran against a real hive, and nothing was written or deleted.
    Write-Output "CLEAR_WAS_ALREADY_ABSENT=True"
    Write-Output "DELETE_VERIFIED=Absent"
    Write-Output "RESULT=OK"
    exit 0
  }
  Write-Output "CLEAR_WAS_ALREADY_ABSENT=False"
  Write-Output ("CLEAR_REMOVED_RAW=" + $clearState.Data)
  Remove-Entry -Why "clear"
  Write-Output "RESULT=OK"
  exit 0
}

# ---- -Read ---------------------------------------------------------------------
$state = Read-Entry
Write-Output ("RUN_KEY_EXISTS=" + $state.KeyPresent)
if ($state.Present) { Write-Output "ENTRY=Present" } else { Write-Output "ENTRY=Absent" }
Write-Output ("RAW=" + $state.Data)
Write-Output ("RAW_LENGTH=" + $state.Data.Length)
Write-Output ("RAW_SHA256=" + (Get-StateDigest -State $state))
if ($state.Present) { Write-Output ("VALUE_KIND=" + $state.Kind) } else { Write-Output "VALUE_KIND=(none: the value does not exist)" }
Write-Output ("REG_EXE_QUERY_CODE=" + $state.RegExeCode)
Write-Output ("REG_EXE_QUERY=" + $state.RegExeOutput)

if ($state.Present) {
  $tokens = Get-TokenBreakdown -Data $state.Data
  Write-Output ("QUOTE_COUNT=" + $tokens.QuoteCount)
  Write-Output ("QUOTE_OPEN=" + $tokens.QuoteOpen)
  Write-Output ("QUOTED_EXE=" + $tokens.QuotedExe)
  Write-Output ("TAIL_RAW=" + $tokens.Tail)
  Write-Output ("TAIL_TRIMMED=" + $tokens.TailTrimmed)
  Write-Output ("SEPARATOR_SPACES=" + $tokens.SeparatorSpaces)
  Write-Output ("TRAILING_WHITESPACE=" + $tokens.TrailingWhitespace)
  Write-Output ("TAIL_IS_BACKGROUND=" + $tokens.TailIsBackground)
  Write-Output ("TAIL_IS_INGEST=" + $tokens.TailIsIngest)

  if ($null -ne $executable) {
    $quotedCanonical = ""
    $quotedResolved = $null
    if (-not [string]::IsNullOrWhiteSpace($tokens.QuotedExe)) {
      $quotedResolved = Resolve-Path -LiteralPath $tokens.QuotedExe -ErrorAction SilentlyContinue
      if ($null -ne $quotedResolved) { $quotedCanonical = [string]$quotedResolved.Path }
    }
    Write-Output ("QUOTED_EXE_CANONICAL=" + $quotedCanonical)
    $match = $false
    $rule = "none"
    if (-not [string]::IsNullOrWhiteSpace($quotedCanonical)) {
      if ($quotedCanonical.ToLowerInvariant() -eq $executable.Path.ToLowerInvariant()) { $match = $true; $rule = "canonical" }
    } else {
      if (-not [string]::IsNullOrWhiteSpace($tokens.QuotedExe)) {
        if ($tokens.QuotedExe.ToLowerInvariant() -eq $executable.Path.ToLowerInvariant()) { $match = $true; $rule = "string-fallback" }
      }
    }
    Write-Output ("EXE_MATCH_CURRENT=" + $match)
    Write-Output ("EXE_MATCH_RULE=" + $rule)

    $expected = '"' + $executable.Path + '" ' + $OwnedTail
    Write-Output ("EXPECTED_OWNED_RAW=" + $expected)
    Write-Output ("EXPECTED_OWNED_LENGTH=" + $expected.Length)
    Write-Output ("RAW_EQUALS_EXPECTED=" + ($state.Data -ceq $expected))
  } else {
    # The value exists but no executable was resolvable, so no owned-string comparison exists.
    # Printed explicitly (never omitted) so a row grepping EXE_MATCH_CURRENT sees the reason.
    Write-Output "EXE_MATCH_CURRENT=(unresolved; pass -Exe or -AppPid)"
    Write-Output "RAW_EQUALS_EXPECTED=(unresolved; pass -Exe or -AppPid)"
  }
} else {
  Write-Output "QUOTE_COUNT=0"
  Write-Output "EXE_MATCH_CURRENT=False"
  Write-Output "RAW_EQUALS_EXPECTED=False"
}

if (-not [string]::IsNullOrWhiteSpace($Expect)) {
  $actual = "Absent"
  if ($state.Present) { $actual = "Present" }
  $met = ($actual -eq $Expect)
  Write-Output ("EXPECTATION_MET=" + $met)
  Write-Output ("EXPECTED_ENTRY=" + $Expect)
  Write-Output ("ACTUAL_ENTRY=" + $actual)
  if (-not $met) {
    Write-Output ("ERROR: expectation not met - expected " + $Expect + " but the value is " + $actual + " (raw=" + $state.Data + ")")
    exit 1
  }
}

Write-Output "RESULT=OK"
exit 0
