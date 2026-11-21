<#
fredo-cdp.psm1 - a minimal, bounded WebView2 DevTools (CDP) client for the
Fredo release-artifact gate (Spec #3181, ST-3 CDP half).

Why this exists
  A produced release installer ships no MCP bridge and no OTel producer, so the
  ONLY remote inspection route into the running webview is WebView2's DevTools
  endpoint, enabled by WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  (--remote-debugging-port=<n>). This module is the shared client used by the
  in-window hook (gate-artifact-window.ps1) and by any harness leg that needs its
  own DevTools session on the same target.

Contract
  * PowerShell 5.1 standard library only: Invoke-WebRequest,
    System.Net.WebSockets.ClientWebSocket, System.Diagnostics.Stopwatch.
    No module installs, no package manager, no third-party client.
  * Every wait is BOUNDED. No call can block forever.
  * Target pick: GET http://127.0.0.1:<port>/json, bounded poll, prefers a
    page/webview target whose url is the app (leaves about:blank).
  * Errors are named: an unreachable endpoint throws a message that starts with
    CDP_UNAVAILABLE so the caller can emit the stable id.

Port policy (Spec #3181 section G)
  One port per gate run (default 9333), never one of the app's own ports. The
  port must be CLOSED before launch and OPEN after: the pre-launch refusal
  (CDP_PORT_IN_USE, exit 2) belongs to the caller/probe and can be implemented
  with Test-CdpPortOpen; after launch, no target is CDP_UNAVAILABLE.

Public functions
  Test-CdpPortOpen            TCP connect probe (bounded).
  Get-CdpTargets              GET /json -> target array.
  Select-CdpTarget            choose the app page/webview target.
  Connect-FredoCdp            bounded connect; returns a session object.
  Close-FredoCdp              close the socket.
  Send-CdpCommand             send one CDP command, read its response, stash
                              unsolicited events on the session.
  Invoke-CdpEvaluate          Runtime.evaluate {returnByValue, awaitPromise}.
  Wait-CdpEvaluate            bounded evaluate poll (scriptblock predicate).
  Enable-CdpDomain            enable a CDP domain (Log/Page/Runtime).
  Add-CdpNewDocumentScript    Page.addScriptToEvaluateOnNewDocument.
  Invoke-CdpReload            Page.reload + bounded wait for a painted document.
  Get-CdpLogEntries           filtered Log.entryAdded entries.
  Save-CdpScreenshot          Page.captureScreenshot {format png, fromSurface},
                              PNG signature + IHDR verification, file write.
  Send-CdpInsertText          Input.insertText into the focused element.
  Send-CdpKeyEvent            Input.dispatchKeyEvent keyDown/keyUp pair.
  Send-CdpEnter               Enter key (keyDown + text + keyUp).
  Send-CdpMouseClick          Input.dispatchMouseEvent press + release.
  Test-PngSignature           8-byte PNG signature check.
  Get-PngDimensions           IHDR width/height (null when not a PNG).
  Get-BytesSha256             hex SHA-256 of a byte array.
  Get-FirstFontFamily         first comma-separated family, quotes stripped.
  Test-FontFamilyContains     case-insensitive contains.

Session object shape (PSCustomObject)
  Socket, NextId, Events (ArrayList of {method, params}), Endpoint,
  WebSocketDebuggerUrl, Target, Targets, Closed
#>

$script:CdpMaxEventBuffer = 20000
$script:CdpMaxMessageBytes = 67108864

# ---- internal helpers --------------------------------------------------------

function Get-CdpProp {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    return $prop.Value
}

function Receive-CdpFrame {
    param($Session, [int]$TimeoutMs = 15000)

    if ($Session.Closed) { throw 'CDP_UNAVAILABLE: the DevTools session is closed' }

    $buffer = New-Object byte[] 65536
    $stream = New-Object System.IO.MemoryStream
    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1, $TimeoutMs))
    $text = ''

    try {
        while ($true) {
            $remaining = [int][Math]::Max(1, ($deadline - (Get-Date)).TotalMilliseconds)
            $segment = [System.ArraySegment[byte]]::new($buffer)
            $cts = New-Object System.Threading.CancellationTokenSource
            $cts.CancelAfter($remaining)
            $task = $Session.Socket.ReceiveAsync($segment, $cts.Token)
            $completed = $false
            try {
                $completed = $task.Wait($remaining)
            } catch {
                $Session.Closed = $true
                try { $Session.Socket.Abort() } catch { }
                throw ("CDP_UNAVAILABLE: DevTools receive failed: " + $_.Exception.Message)
            } finally {
                $cts.Dispose()
            }
            if (-not $completed) {
                $Session.Closed = $true
                try { $Session.Socket.Abort() } catch { }
                throw 'CDP_UNAVAILABLE: timed out waiting for a DevTools frame'
            }

            $result = $task.Result
            if ($null -eq $result) { throw 'CDP_UNAVAILABLE: empty DevTools frame' }
            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                $Session.Closed = $true
                throw 'CDP_UNAVAILABLE: the DevTools websocket was closed by the peer'
            }
            if ($result.Count -gt 0) { $stream.Write($buffer, 0, $result.Count) }
            if ($stream.Length -gt $script:CdpMaxMessageBytes) {
                $Session.Closed = $true
                throw 'CDP_UNAVAILABLE: a DevTools message exceeded the size bound'
            }
            if ($result.EndOfMessage) { break }
        }
        $text = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
    } finally {
        $stream.Dispose()
    }

    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    try {
        return ($text | ConvertFrom-Json)
    } catch {
        throw ("CDP_UNAVAILABLE: unparseable DevTools frame: " + $_.Exception.Message)
    }
}

# ---- targets -----------------------------------------------------------------

function Test-CdpPortOpen {
    param([int]$Port, [int]$TimeoutMs = 400)

    if ($Port -le 0 -or $Port -gt 65535) { return $false }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

function Get-CdpTargets {
    param([int]$Port, [int]$TimeoutMs = 2000)

    if ($Port -le 0 -or $Port -gt 65535) { throw 'CDP_UNAVAILABLE: invalid port' }
    $timeoutSecs = [Math]::Max(1, [int][Math]::Ceiling($TimeoutMs / 1000.0))
    $uri = "http://127.0.0.1:$Port/json"
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec $timeoutSecs
    if ([string]::IsNullOrWhiteSpace($resp.Content)) { return @() }
    $parsed = $resp.Content | ConvertFrom-Json
    if ($null -eq $parsed) { return @() }
    return @($parsed)
}

function Select-CdpTarget {
    param($Targets, [string]$PreferUrlPattern = '')

    if ($null -eq $Targets) { return $null }
    $candidates = New-Object System.Collections.ArrayList
    foreach ($target in @($Targets)) {
        if ($null -eq $target) { continue }
        $type = ([string](Get-CdpProp -Object $target -Name 'type')).ToLowerInvariant()
        if ($type -ne 'page' -and $type -ne 'webview') { continue }
        $url = [string](Get-CdpProp -Object $target -Name 'url')
        if ([string]::IsNullOrWhiteSpace($url)) { continue }
        if ($url.StartsWith('devtools://')) { continue }
        $ws = [string](Get-CdpProp -Object $target -Name 'webSocketDebuggerUrl')
        if ([string]::IsNullOrWhiteSpace($ws)) { continue }
        [void]$candidates.Add([pscustomobject]@{
            Target = $target
            Url = $url
            Blank = ($url -eq 'about:blank')
        })
    }
    if ($candidates.Count -eq 0) { return $null }

    $pool = @($candidates | Where-Object { -not $_.Blank })
    if ($pool.Count -eq 0) { $pool = @($candidates) }

    if (-not [string]::IsNullOrWhiteSpace($PreferUrlPattern)) {
        foreach ($candidate in $pool) {
            if ($candidate.Url -match $PreferUrlPattern) { return $candidate.Target }
        }
    }
    foreach ($candidate in $pool) {
        if ($candidate.Url -match 'tauri|localhost') { return $candidate.Target }
    }
    foreach ($candidate in $pool) {
        if ($candidate.Url -match '^https?:') { return $candidate.Target }
    }
    return $pool[0].Target
}

# ---- session -----------------------------------------------------------------

function Connect-FredoCdp {
    param(
        [int]$Port,
        [int]$TimeoutSecs = 15,
        [int]$PollMs = 250,
        [string]$PreferUrlPattern = ''
    )

    $endpoint = "http://127.0.0.1:$Port"
    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSecs))
    $targets = @()
    $selected = $null
    $lastError = ''

    while ((Get-Date) -lt $deadline) {
        try {
            $targets = @(Get-CdpTargets -Port $Port -TimeoutMs 1500)
            $selected = Select-CdpTarget -Targets $targets -PreferUrlPattern $PreferUrlPattern
        } catch {
            $lastError = $_.Exception.Message
        }
        if ($null -ne $selected) { break }
        Start-Sleep -Milliseconds $PollMs
    }

    if ($null -eq $selected) {
        $detail = 'no DevTools page target with a usable url'
        if (-not [string]::IsNullOrWhiteSpace($lastError)) { $detail = "$detail; last error: $lastError" }
        throw ("CDP_UNAVAILABLE: $detail (endpoint $endpoint)")
    }

    $wsUrl = [string](Get-CdpProp -Object $selected -Name 'webSocketDebuggerUrl')
    if ([string]::IsNullOrWhiteSpace($wsUrl)) {
        throw 'CDP_UNAVAILABLE: the selected DevTools target has no webSocketDebuggerUrl'
    }

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(10)
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter([TimeSpan]::FromSeconds([Math]::Max(5, $TimeoutSecs)))
    try {
        $connectTask = $socket.ConnectAsync([Uri]$wsUrl, $cts.Token)
        if (-not $connectTask.Wait([int]([Math]::Max(5, $TimeoutSecs) * 1000))) {
            try { $socket.Abort() } catch { }
            throw 'CDP_UNAVAILABLE: the DevTools websocket connect timed out'
        }
    } catch {
        try { $socket.Dispose() } catch { }
        throw ("CDP_UNAVAILABLE: the DevTools websocket connect failed: " + $_.Exception.Message)
    } finally {
        $cts.Dispose()
    }

    return [pscustomobject]@{
        Socket = $socket
        NextId = 0
        Events = (New-Object System.Collections.ArrayList)
        Endpoint = $endpoint
        WebSocketDebuggerUrl = $wsUrl
        Target = $selected
        Targets = $targets.Count
        Closed = $false
    }
}

function Close-FredoCdp {
    param($Session)
    if ($null -eq $Session) { return }
    $Session.Closed = $true
    try {
        if ($null -ne $Session.Socket) {
            try {
                $cts = New-Object System.Threading.CancellationTokenSource
                $cts.CancelAfter(2000)
                $null = $Session.Socket.CloseAsync(
                    [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
                    'gate done',
                    $cts.Token).Wait(2000)
                $cts.Dispose()
            } catch { }
            try { $Session.Socket.Dispose() } catch { }
        }
    } catch { }
}

function Send-CdpCommand {
    param(
        $Session,
        [string]$Method,
        $Params = $null,
        [int]$TimeoutMs = 15000
    )

    if ($null -eq $Session) { return [pscustomobject]@{ Ok = $false; Result = $null; Error = 'no CDP session' } }

    $Session.NextId = [int]$Session.NextId + 1
    $id = [int]$Session.NextId
    $paramBag = $Params
    if ($null -eq $paramBag) { $paramBag = @{} }

    $payload = [ordered]@{ id = $id; method = $Method; params = $paramBag }
    $frameText = ($payload | ConvertTo-Json -Compress -Depth 20)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($frameText)

    try {
        $segment = [System.ArraySegment[byte]]::new($bytes)
        $cts = New-Object System.Threading.CancellationTokenSource
        $cts.CancelAfter([Math]::Max(1000, $TimeoutMs))
        try {
            $sendTask = $Session.Socket.SendAsync(
                $segment,
                [System.Net.WebSockets.WebSocketMessageType]::Text,
                $true,
                $cts.Token)
            if (-not $sendTask.Wait([Math]::Max(1000, $TimeoutMs))) {
                throw 'send timed out'
            }
        } finally {
            $cts.Dispose()
        }
    } catch {
        $Session.Closed = $true
        return [pscustomobject]@{ Ok = $false; Result = $null; Error = ("CDP send failed: " + $_.Exception.Message) }
    }

    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1000, $TimeoutMs))
    while ((Get-Date) -lt $deadline) {
        $remaining = [int][Math]::Max(250, ($deadline - (Get-Date)).TotalMilliseconds)
        $message = $null
        try {
            $message = Receive-CdpFrame -Session $Session -TimeoutMs $remaining
        } catch {
            $Session.Closed = $true
            return [pscustomobject]@{ Ok = $false; Result = $null; Error = $_.Exception.Message }
        }
        if ($null -eq $message) { continue }

        $messageId = Get-CdpProp -Object $message -Name 'id'
        # NOTE: the local must NOT be named $method: PowerShell variable names are
        # case-insensitive, so it would alias the [string]$Method parameter and a
        # missing property ($null) would coerce to '' and be read as an event.
        $eventMethod = Get-CdpProp -Object $message -Name 'method'
        if ($null -ne $eventMethod) {
            if ($Session.Events.Count -ge $script:CdpMaxEventBuffer) { $Session.Events.RemoveAt(0) }
            [void]$Session.Events.Add([pscustomobject]@{
                method = [string]$eventMethod
                params = (Get-CdpProp -Object $message -Name 'params')
            })
            continue
        }
        if ($null -eq $messageId) { continue }
        if ([int]$messageId -ne $id) { continue }

        # NOTE: never assign to $error here - it is the automatic error collection.
        $errorPayload = Get-CdpProp -Object $message -Name 'error'
        if ($null -ne $errorPayload) {
            $errorText = [string](Get-CdpProp -Object $errorPayload -Name 'message')
            return [pscustomobject]@{ Ok = $false; Result = $null; Error = $errorText }
        }
        return [pscustomobject]@{
            Ok = $true
            Result = (Get-CdpProp -Object $message -Name 'result')
            Error = ''
        }
    }

    return [pscustomobject]@{ Ok = $false; Result = $null; Error = 'CDP command timed out' }
}

function Invoke-CdpEvaluate {
    param(
        $Session,
        [string]$Expression,
        [switch]$AwaitPromise,
        [int]$TimeoutMs = 15000,
        [switch]$UserGesture
    )

    $params = @{
        expression = $Expression
        returnByValue = $true
        awaitPromise = [bool]$AwaitPromise
        userGesture = [bool]$UserGesture
    }
    $response = Send-CdpCommand -Session $Session -Method 'Runtime.evaluate' -Params $params -TimeoutMs $TimeoutMs
    if (-not $response.Ok) {
        return [pscustomobject]@{ Ok = $false; Value = $null; Exception = [string]$response.Error }
    }

    $result = $response.Result
    $exceptionDetails = Get-CdpProp -Object $result -Name 'exceptionDetails'
    if ($null -ne $exceptionDetails) {
        $text = [string](Get-CdpProp -Object $exceptionDetails -Name 'text')
        if ([string]::IsNullOrWhiteSpace($text)) { $text = 'runtime exception' }
        return [pscustomobject]@{ Ok = $false; Value = $null; Exception = $text }
    }

    # Runtime.evaluate wraps the remote object: { result: { type, value, ... } }.
    $remoteObject = Get-CdpProp -Object $result -Name 'result'
    $value = Get-CdpProp -Object $remoteObject -Name 'value'
    return [pscustomobject]@{ Ok = $true; Value = $value; Exception = '' }
}

function Wait-CdpEvaluate {
    param(
        $Session,
        [string]$Expression,
        [ScriptBlock]$Predicate = $null,
        [int]$TimeoutMs = 15000,
        [int]$PollMs = 250,
        [switch]$AwaitPromise
    )

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $last = $null
    while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
        $remaining = [Math]::Max(1000, $TimeoutMs - $watch.ElapsedMilliseconds)
        $last = Invoke-CdpEvaluate -Session $Session -Expression $Expression -AwaitPromise:$AwaitPromise -TimeoutMs ([int]$remaining)
        if ($null -ne $Predicate) {
            if (& $Predicate $last) {
                return [pscustomobject]@{ Ok = $true; Eval = $last; ElapsedMs = $watch.ElapsedMilliseconds }
            }
        } elseif ($last.Ok -and $last.Value) {
            return [pscustomobject]@{ Ok = $true; Eval = $last; ElapsedMs = $watch.ElapsedMilliseconds }
        }
        Start-Sleep -Milliseconds $PollMs
    }
    return [pscustomobject]@{ Ok = $false; Eval = $last; ElapsedMs = $watch.ElapsedMilliseconds }
}

function Enable-CdpDomain {
    param($Session, [string]$Domain)
    $response = Send-CdpCommand -Session $Session -Method "$Domain.enable" -Params @{}
    return [bool]$response.Ok
}

function Add-CdpNewDocumentScript {
    param($Session, [string]$Script)
    $response = Send-CdpCommand -Session $Session -Method 'Page.addScriptToEvaluateOnNewDocument' -Params @{ source = $Script }
    if (-not $response.Ok) { return '' }
    return [string](Get-CdpProp -Object $response.Result -Name 'identifier')
}

function Invoke-CdpReload {
    param($Session, [int]$TimeoutMs = 20000, [int]$PollMs = 250)

    $response = Send-CdpCommand -Session $Session -Method 'Page.reload' -Params @{ ignoreCache = $false } -TimeoutMs 10000
    if (-not $response.Ok) { return $false }

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds 150
    $readyExpression = "!!(document.readyState === 'complete' && document.body && document.body.childElementCount > 0)"
    while ($watch.ElapsedMilliseconds -lt $TimeoutMs) {
        $remaining = [Math]::Max(1000, $TimeoutMs - $watch.ElapsedMilliseconds)
        $eval = Invoke-CdpEvaluate -Session $Session -Expression $readyExpression -TimeoutMs ([int]$remaining)
        if ($eval.Ok -and $eval.Value -eq $true) { return $true }
        Start-Sleep -Milliseconds $PollMs
    }
    return $false
}

function Get-CdpLogEntries {
    param($Session, [string]$Pattern = '')

    $entries = New-Object System.Collections.ArrayList
    if ($null -eq $Session) { return @() }
    foreach ($event in @($Session.Events)) {
        if ($null -eq $event) { continue }
        if ($event.method -ne 'Log.entryAdded') { continue }
        $entry = Get-CdpProp -Object $event.params -Name 'entry'
        if ($null -eq $entry) { continue }
        $text = [string](Get-CdpProp -Object $entry -Name 'text')
        $source = [string](Get-CdpProp -Object $entry -Name 'source')
        if (-not [string]::IsNullOrWhiteSpace($Pattern) -and -not ($text -match $Pattern)) { continue }
        [void]$entries.Add([pscustomobject]@{
            source = $source
            level = [string](Get-CdpProp -Object $entry -Name 'level')
            text = $text
            url = [string](Get-CdpProp -Object $entry -Name 'url')
        })
    }
    return @($entries)
}

# ---- screenshot --------------------------------------------------------------

function Save-CdpScreenshot {
    param(
        $Session,
        [string]$Path = '',
        [int]$TimeoutMs = 30000
    )

    $result = [ordered]@{
        Ok = $false
        Bytes = 0
        Sha256 = ''
        Width = 0
        Height = 0
        SignatureOk = $false
        Path = $Path
        Error = ''
    }

    # Viewport-only capture: exactly {format, fromSurface}. No clip, no
    # captureBeyondViewport, no Emulation override (the frame-readiness contract).
    $response = Send-CdpCommand -Session $Session -Method 'Page.captureScreenshot' -Params @{
        format = 'png'
        fromSurface = $true
    } -TimeoutMs $TimeoutMs

    if (-not $response.Ok) {
        $result.Error = 'captureScreenshot failed: ' + [string]$response.Error
        return [pscustomobject]$result
    }

    $data = [string](Get-CdpProp -Object $response.Result -Name 'data')
    if ([string]::IsNullOrWhiteSpace($data)) {
        $result.Error = 'captureScreenshot returned no data'
        return [pscustomobject]$result
    }

    $bytes = $null
    try {
        $bytes = [Convert]::FromBase64String($data)
    } catch {
        $result.Error = 'captureScreenshot data is not valid base64'
        return [pscustomobject]$result
    }

    $result.Bytes = $bytes.Length
    $result.SignatureOk = (Test-PngSignature -Bytes $bytes)
    $dimensions = Get-PngDimensions -Bytes $bytes
    if ($null -ne $dimensions) {
        $result.Width = $dimensions.Width
        $result.Height = $dimensions.Height
    }
    $result.Sha256 = Get-BytesSha256 -Bytes $bytes

    if (-not $result.SignatureOk) {
        $result.Error = 'capture is not a PNG (8-byte signature mismatch)'
        return [pscustomobject]$result
    }

    if (-not [string]::IsNullOrWhiteSpace($Path)) {
        try {
            $directory = Split-Path -Parent $Path
            if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
                New-Item -ItemType Directory -Path $directory -Force | Out-Null
            }
            [System.IO.File]::WriteAllBytes($Path, $bytes)
        } catch {
            $result.Error = 'could not write the screenshot file: ' + $_.Exception.Message
            return [pscustomobject]$result
        }
    }

    $result.Ok = $true
    return [pscustomobject]$result
}

# ---- input -------------------------------------------------------------------

function Send-CdpInsertText {
    param($Session, [string]$Text)
    $response = Send-CdpCommand -Session $Session -Method 'Input.insertText' -Params @{ text = $Text }
    return [bool]$response.Ok
}

function Send-CdpKeyEvent {
    param(
        $Session,
        [string]$Key,
        [string]$Code = '',
        [int]$VirtualKeyCode = 0
    )

    if ([string]::IsNullOrWhiteSpace($Code)) { $Code = $Key }
    $down = @{
        type = 'keyDown'
        key = $Key
        code = $Code
        windowsVirtualKeyCode = $VirtualKeyCode
        nativeVirtualKeyCode = $VirtualKeyCode
    }
    $up = @{
        type = 'keyUp'
        key = $Key
        code = $Code
        windowsVirtualKeyCode = $VirtualKeyCode
        nativeVirtualKeyCode = $VirtualKeyCode
    }
    $first = Send-CdpCommand -Session $Session -Method 'Input.dispatchKeyEvent' -Params $down
    $second = Send-CdpCommand -Session $Session -Method 'Input.dispatchKeyEvent' -Params $up
    return ([bool]$first.Ok -and [bool]$second.Ok)
}

function Send-CdpEnter {
    param($Session)

    # keyDown carries text so the editing pipeline sees a real Enter (keydown +
    # char) exactly as a user keystroke would.
    $down = @{
        type = 'keyDown'
        key = 'Enter'
        code = 'Enter'
        text = "`r"
        unmodifiedText = "`r"
        windowsVirtualKeyCode = 13
        nativeVirtualKeyCode = 13
    }
    $up = @{
        type = 'keyUp'
        key = 'Enter'
        code = 'Enter'
        windowsVirtualKeyCode = 13
        nativeVirtualKeyCode = 13
    }
    $first = Send-CdpCommand -Session $Session -Method 'Input.dispatchKeyEvent' -Params $down
    $second = Send-CdpCommand -Session $Session -Method 'Input.dispatchKeyEvent' -Params $up
    return ([bool]$first.Ok -and [bool]$second.Ok)
}

function Send-CdpMouseClick {
    param($Session, [double]$X, [double]$Y)

    $press = @{
        type = 'mousePressed'
        x = $X
        y = $Y
        button = 'left'
        buttons = 1
        clickCount = 1
    }
    $release = @{
        type = 'mouseReleased'
        x = $X
        y = $Y
        button = 'left'
        buttons = 0
        clickCount = 1
    }
    $first = Send-CdpCommand -Session $Session -Method 'Input.dispatchMouseEvent' -Params $press
    $second = Send-CdpCommand -Session $Session -Method 'Input.dispatchMouseEvent' -Params $release
    return ([bool]$first.Ok -and [bool]$second.Ok)
}

# ---- pure helpers ------------------------------------------------------------

function Test-PngSignature {
    param([byte[]]$Bytes)

    if ($null -eq $Bytes -or $Bytes.Length -lt 8) { return $false }
    $signature = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    for ($index = 0; $index -lt 8; $index++) {
        if ([int]$Bytes[$index] -ne [int]$signature[$index]) { return $false }
    }
    return $true
}

function Get-PngDimensions {
    param([byte[]]$Bytes)

    if ($null -eq $Bytes -or $Bytes.Length -lt 24) { return $null }
    if (-not (Test-PngSignature -Bytes $Bytes)) { return $null }
    # PNG layout: 8-byte signature, then the IHDR chunk (4-byte length, 4-byte
    # type), so the 13-byte IHDR payload starts at offset 16: width, height.
    $width = ([int]$Bytes[16] -shl 24) -bor ([int]$Bytes[17] -shl 16) -bor ([int]$Bytes[18] -shl 8) -bor [int]$Bytes[19]
    $height = ([int]$Bytes[20] -shl 24) -bor ([int]$Bytes[21] -shl 16) -bor ([int]$Bytes[22] -shl 8) -bor [int]$Bytes[23]
    return [pscustomobject]@{ Width = $width; Height = $height }
}

function Get-BytesSha256 {
    param([byte[]]$Bytes)

    if ($null -eq $Bytes) { return '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
    } finally {
        $sha.Dispose()
    }
    $builder = New-Object System.Text.StringBuilder
    foreach ($byte in $hash) { [void]$builder.Append($byte.ToString('x2')) }
    return $builder.ToString()
}

function Get-FirstFontFamily {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $first = ($Value -split ',')[0]
    $first = $first.Trim()
    $first = $first.Trim([char[]]@("'", '"'))
    return $first.Trim()
}

function Test-FontFamilyContains {
    param([string]$Observed, [string]$FirstFamily)

    if ([string]::IsNullOrWhiteSpace($Observed) -or [string]::IsNullOrWhiteSpace($FirstFamily)) { return $false }
    return $Observed.ToLowerInvariant().Contains($FirstFamily.ToLowerInvariant())
}

Export-ModuleMember -Function @(
    'Test-CdpPortOpen',
    'Get-CdpTargets',
    'Select-CdpTarget',
    'Connect-FredoCdp',
    'Close-FredoCdp',
    'Send-CdpCommand',
    'Invoke-CdpEvaluate',
    'Wait-CdpEvaluate',
    'Enable-CdpDomain',
    'Add-CdpNewDocumentScript',
    'Invoke-CdpReload',
    'Get-CdpLogEntries',
    'Save-CdpScreenshot',
    'Send-CdpInsertText',
    'Send-CdpKeyEvent',
    'Send-CdpEnter',
    'Send-CdpMouseClick',
    'Test-PngSignature',
    'Get-PngDimensions',
    'Get-BytesSha256',
    'Get-FirstFontFamily',
    'Test-FontFamilyContains'
)


