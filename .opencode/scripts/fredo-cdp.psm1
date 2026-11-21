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

Response-header induction (Spec #3181 round 5)
  Fetch.enable {patterns:[{urlPattern:'*', resourceType:'Document',
  requestStage:'Response'}]} pauses every Document response. Invoke-CdpFetchServe
  reads the ORIGINAL response status/headers from the paused event, takes the
  body with Fetch.getResponseBody, and answers the pause with
  Fetch.fulfillRequest carrying one extra header. That is how a Content-Security-
  Policy is induced as a real RESPONSE header (enforced from byte 0) rather than
  as a post-hoc <meta>, which loses the ordering race with the app bundle. A body
  failure answers Fetch.failRequest and returns a typed error - it NEVER falls
  back to a silent Fetch.continueRequest, because that would hand the caller a
  policy-less document and call it an induction.

  Entity headers (content-encoding / content-length / transfer-encoding) are
  DROPPED: Fetch.getResponseBody yields DECODED bytes, so a retained
  content-encoding would make the renderer decode them twice, and content-length
  / transfer-encoding no longer describe the fulfilled body. Exactly ONE header
  of the requested name is emitted (an existing one is replaced, never doubled).

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
  Invoke-CdpFetchServe        serve Fetch.requestPaused Document responses,
                              fulfilling each with an extra response header.
  Get-CdpFetchPausedRequest   take the next Fetch.requestPaused params object
                              (buffered event first, then the socket).
  Add-CdpResponseHeader       pure: drop entity headers, replace the named one,
                              append exactly one (name, value) pair.
  Get-CdpFulfillBody          pure: the base64 body for Fetch.fulfillRequest.
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

# A bounded receive for the Fetch serve loop. Two properties make it different from
# Receive-CdpFrame:
#   * A TIMEOUT is not a session error. It returns $null and the session stays
#     usable, because silence is the normal case while no request is paused.
#   * The receive is NEVER cancelled. Cancelling a pending ClientWebSocket receive
#     transitions the socket to 'Aborted' (measured: the next receive faults with
#     "The WebSocket is in an invalid state ('Aborted')"), which would kill the
#     Fetch session on the first quiet poll. Instead a receive that has not
#     completed is KEPT on the session and resumed by the next call, so the serve
#     loop can poll for silence without ever tearing the socket down.
# Real failures (closed peer, bad frame, oversize, unparseable) still throw.
function Receive-CdpFramePending {
    param($Session, [int]$TimeoutMs = 500)

    if ($null -eq $Session) { throw 'CDP_UNAVAILABLE: no DevTools session' }
    if ($Session.Closed) { throw 'CDP_UNAVAILABLE: the DevTools session is closed' }

    if ($null -eq $Session.PendingReceiveTask) {
        if ($null -eq $Session.PendingReceiveBuffer) { $Session.PendingReceiveBuffer = New-Object byte[] 65536 }
        if ($null -eq $Session.PendingReceiveStream) { $Session.PendingReceiveStream = New-Object System.IO.MemoryStream }
        $segment = [System.ArraySegment[byte]]::new($Session.PendingReceiveBuffer)
        try {
            $Session.PendingReceiveTask = $Session.Socket.ReceiveAsync($segment, [System.Threading.CancellationToken]::None)
        } catch {
            $Session.Closed = $true
            throw ("CDP_UNAVAILABLE: DevTools receive failed: " + $_.Exception.Message)
        }
    }

    $task = $Session.PendingReceiveTask
    $completed = $false
    try {
        $completed = $task.Wait([int][Math]::Max(1, $TimeoutMs))
    } catch {
        $Session.Closed = $true
        try { $Session.Socket.Abort() } catch { }
        throw ("CDP_UNAVAILABLE: DevTools receive failed: " + $_.Exception.Message)
    }
    if (-not $completed) { return $null }   # the pending receive is resumed next call

    # The task is complete: consume it BEFORE the socket is touched again.
    $Session.PendingReceiveTask = $null
    $result = $null
    try { $result = $task.Result } catch {
        $Session.Closed = $true
        throw ("CDP_UNAVAILABLE: DevTools receive failed: " + $_.Exception.Message)
    }
    if ($null -eq $result) { throw 'CDP_UNAVAILABLE: empty DevTools frame' }
    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        $Session.Closed = $true
        throw 'CDP_UNAVAILABLE: the DevTools websocket was closed by the peer'
    }

    $stream = $Session.PendingReceiveStream
    if ($result.Count -gt 0) { $stream.Write($Session.PendingReceiveBuffer, 0, $result.Count) }
    if ($stream.Length -gt $script:CdpMaxMessageBytes) {
        $Session.Closed = $true
        throw 'CDP_UNAVAILABLE: a DevTools message exceeded the size bound'
    }
    if (-not $result.EndOfMessage) { return $null }   # partial; the next call resumes

    $text = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
    try { $stream.Dispose() } catch { }
    $Session.PendingReceiveStream = $null
    $Session.PendingReceiveBuffer = $null

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
        # The resumed pending receive used ONLY by the Fetch serve loop (see
        # Receive-CdpFramePending). Its presence means a receive is in flight and
        # a command must not start its own until it completes - which the serve
        # loop guarantees because it serves a pause BEFORE issuing a command.
        PendingReceiveTask = $null
        PendingReceiveBuffer = $null
        PendingReceiveStream = $null
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

# ---- fetch / response-header induction ---------------------------------------

# Take the next Fetch.requestPaused event's params object. Buffered events are
# drained first (Send-CdpCommand stashes unsolicited events while a command is in
# flight), then the socket is polled to the bound. Returns $null on silence; other
# unsolicited events are stashed back on the session so no event is lost.
function Get-CdpFetchPausedRequest {
    param($Session, [int]$TimeoutMs = 1000)

    if ($null -eq $Session) { return $null }

    for ($index = 0; $index -lt $Session.Events.Count; $index++) {
        $event = $Session.Events[$index]
        if ($null -eq $event) { continue }
        if ([string]$event.method -eq 'Fetch.requestPaused') {
            $Session.Events.RemoveAt($index)
            return (Get-CdpProp -Object $event -Name 'params')
        }
    }

    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1, $TimeoutMs))
    while ((Get-Date) -lt $deadline) {
        $remaining = [int][Math]::Max(1, ($deadline - (Get-Date)).TotalMilliseconds)
        $message = Receive-CdpFramePending -Session $Session -TimeoutMs $remaining
        if ($null -eq $message) { return $null }

        $eventMethod = Get-CdpProp -Object $message -Name 'method'
        if ($null -eq $eventMethod) { continue }   # a stray command response; no command is outstanding here
        if ([string]$eventMethod -eq 'Fetch.requestPaused') {
            return (Get-CdpProp -Object $message -Name 'params')
        }
        if ($Session.Events.Count -ge $script:CdpMaxEventBuffer) { $Session.Events.RemoveAt(0) }
        [void]$Session.Events.Add([pscustomobject]@{
            method = [string]$eventMethod
            params = (Get-CdpProp -Object $message -Name 'params')
        })
    }
    return $null
}

# Fulfil ONE paused Document response with an extra response header. Returns an
# object { Ok, Error, Url, Code, Headers }. On ANY body failure the paused request
# is answered with Fetch.failRequest and Ok=$false is returned - never a silent
# Fetch.continueRequest (a policy-less document is not an induction).
function Invoke-CdpFetchFulfill {
    param(
        $Session,
        $Paused,
        [string]$HeaderName,
        [string]$HeaderValue,
        [int]$TimeoutMs = 15000
    )

    $result = [pscustomobject]@{ Ok = $false; Error = ''; Url = ''; Code = 0; Headers = 0 }
    if ($null -eq $Paused) { $result.Error = 'no paused request'; return $result }

    $requestId = [string](Get-CdpProp -Object $Paused -Name 'requestId')
    if ([string]::IsNullOrWhiteSpace($requestId)) { $result.Error = 'paused request has no requestId'; return $result }
    $request = Get-CdpProp -Object $Paused -Name 'request'
    $result.Url = [string](Get-CdpProp -Object $request -Name 'url')

    $bodyResponse = Send-CdpCommand -Session $Session -Method 'Fetch.getResponseBody' -Params @{ requestId = $requestId } -TimeoutMs $TimeoutMs
    if (-not $bodyResponse.Ok) {
        $null = Send-CdpCommand -Session $Session -Method 'Fetch.failRequest' -Params @{ requestId = $requestId; errorReason = 'Failed' } -TimeoutMs 5000
        $result.Error = 'getResponseBody failed: ' + [string]$bodyResponse.Error
        return $result
    }

    $base64 = Get-CdpFulfillBody -BodyResult $bodyResponse.Result
    if ($null -eq $base64) {
        $null = Send-CdpCommand -Session $Session -Method 'Fetch.failRequest' -Params @{ requestId = $requestId; errorReason = 'Failed' } -TimeoutMs 5000
        $result.Error = 'getResponseBody returned no body'
        return $result
    }

    $originalHeaders = Get-CdpProp -Object $Paused -Name 'responseHeaders'
    $headers = @(Add-CdpResponseHeader -ResponseHeaders $originalHeaders -Name $HeaderName -Value $HeaderValue)
    $code = [int](Get-CdpProp -Object $Paused -Name 'responseStatusCode' 200)
    if ($code -le 0) { $code = 200 }

    $fulfill = Send-CdpCommand -Session $Session -Method 'Fetch.fulfillRequest' -Params @{
        requestId = $requestId
        responseCode = $code
        responseHeaders = @($headers)
        body = $base64
    } -TimeoutMs $TimeoutMs
    if (-not $fulfill.Ok) {
        $null = Send-CdpCommand -Session $Session -Method 'Fetch.failRequest' -Params @{ requestId = $requestId; errorReason = 'Failed' } -TimeoutMs 5000
        $result.Error = 'fulfillRequest failed: ' + [string]$fulfill.Error
        return $result
    }

    $result.Ok = $true
    $result.Code = $code
    $result.Headers = @($headers).Count
    return $result
}

# Serve paused Document responses for up to TimeoutMs, fulfilling each with
# HeaderName=HeaderValue. Returns { Ok, Served, Failed, LastError, Urls }.
#   -MinServed > 0 : return once that many documents have been served AND no new
#                    pause arrives within IdleMs (the one-shot "first reload"
#                    mode; a redirect chain is fully drained).
#   -MinServed = 0 : run the whole TimeoutMs (the continuous mode used while the
#                    hook child reloads the page for the styled clause).
# A body/fulfill failure marks Ok=$false with the typed LastError; the caller MUST
# treat that as an induction failure, not as a served document.
function Invoke-CdpFetchServe {
    param(
        $Session,
        [Parameter(Mandatory = $true)][string]$HeaderValue,
        [string]$HeaderName = 'Content-Security-Policy',
        [int]$TimeoutMs = 15000,
        [int]$MinServed = 1,
        [int]$IdleMs = 750,
        [switch]$DocumentOnly
    )

    $result = [pscustomobject]@{
        Ok = $true
        Served = 0
        Failed = 0
        LastError = ''
        Urls = @()
    }
    if ($null -eq $Session) { $result.Ok = $false; $result.LastError = 'no CDP session'; return $result }

    $urls = New-Object System.Collections.ArrayList
    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1, $TimeoutMs))
    $lastServed = Get-Date

    while ((Get-Date) -lt $deadline) {
        if ($MinServed -gt 0 -and $result.Served -ge $MinServed) {
            if (((Get-Date) - $lastServed).TotalMilliseconds -ge $IdleMs) { break }
        }
        $remaining = [int][Math]::Max(1, ($deadline - (Get-Date)).TotalMilliseconds)
        $wait = [int][Math]::Min(400, $remaining)
        $paused = Get-CdpFetchPausedRequest -Session $Session -TimeoutMs $wait
        if ($null -eq $paused) { continue }

        if ($DocumentOnly) {
            $resourceType = [string](Get-CdpProp -Object $paused -Name 'resourceType')
            if (-not [string]::IsNullOrWhiteSpace($resourceType) -and $resourceType -ne 'Document') {
                $skipId = [string](Get-CdpProp -Object $paused -Name 'requestId')
                if (-not [string]::IsNullOrWhiteSpace($skipId)) {
                    $null = Send-CdpCommand -Session $Session -Method 'Fetch.continueRequest' -Params @{ requestId = $skipId } -TimeoutMs 5000
                }
                continue
            }
        }

        $served = Invoke-CdpFetchFulfill -Session $Session -Paused $paused -HeaderName $HeaderName -HeaderValue $HeaderValue
        if (-not $served.Ok) {
            $result.Failed = $result.Failed + 1
            $result.Ok = $false
            $result.LastError = [string]$served.Error
            continue
        }
        $result.Served = $result.Served + 1
        if (-not [string]::IsNullOrWhiteSpace([string]$served.Url)) { [void]$urls.Add([string]$served.Url) }
        $lastServed = Get-Date
    }

    $result.Urls = @($urls)
    return $result
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

# Build the responseHeaders list for Fetch.fulfillRequest: preserve every original
# header except the entity headers (the body is DECODED, so content-encoding would
# double-decode it and content-length / transfer-encoding no longer describe it)
# and except any existing header of the requested name, then append EXACTLY ONE
# (Name, Value). Input entries are the CDP shape {name, value} (PSCustomObject
# from ConvertFrom-Json, or a dictionary). Pure: no session, no I/O.
function Add-CdpResponseHeader {
    param(
        $ResponseHeaders,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $entityHeaders = @('content-encoding', 'content-length', 'transfer-encoding')
    $targetName = $Name.Trim()
    $targetLower = $targetName.ToLowerInvariant()
    $output = New-Object System.Collections.ArrayList

    foreach ($header in @($ResponseHeaders)) {
        if ($null -eq $header) { continue }
        $headerName = ''
        $headerValue = ''
        if ($header -is [System.Collections.IDictionary]) {
            if ($header.Contains('name')) { $headerName = [string]$header['name'] }
            if ($header.Contains('value')) { $headerValue = [string]$header['value'] }
        } else {
            $headerName = [string](Get-CdpProp -Object $header -Name 'name')
            $headerValue = [string](Get-CdpProp -Object $header -Name 'value')
        }
        if ([string]::IsNullOrWhiteSpace($headerName)) { continue }
        $lower = $headerName.Trim().ToLowerInvariant()
        if ($entityHeaders -contains $lower) { continue }
        if ($lower -eq $targetLower) { continue }
        [void]$output.Add([pscustomobject]@{ name = $headerName.Trim(); value = $headerValue })
    }
    [void]$output.Add([pscustomobject]@{ name = $targetName; value = $Value })
    return @($output)
}

# The base64 body Fetch.fulfillRequest expects. getResponseBody returns
# { body, base64Encoded }: pass a base64 body through, base64 the TEXT body when
# base64Encoded is false. Returns $null when the result carries no body, so the
# caller can fail the request instead of fulfilling an empty document.
function Get-CdpFulfillBody {
    param($BodyResult)

    if ($null -eq $BodyResult) { return $null }
    $body = Get-CdpProp -Object $BodyResult -Name 'body'
    if ($null -eq $body) { return $null }
    $encoded = Get-CdpProp -Object $BodyResult -Name 'base64Encoded' $false
    if ([bool]$encoded) { return [string]$body }
    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$body))
}

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
    'Invoke-CdpFetchServe',
    'Get-CdpFetchPausedRequest',
    'Get-CdpLogEntries',
    'Save-CdpScreenshot',
    'Send-CdpInsertText',
    'Send-CdpKeyEvent',
    'Send-CdpEnter',
    'Send-CdpMouseClick',
    'Add-CdpResponseHeader',
    'Get-CdpFulfillBody',
    'Test-PngSignature',
    'Get-PngDimensions',
    'Get-BytesSha256',
    'Get-FirstFontFamily',
    'Test-FontFamilyContains'
)


