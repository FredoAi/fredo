---
name: opencode-cli-runner
description: Real agent/subagent execution via opencode CLI for Fredo e2e integration testing. Load when the QA needs to verify Mission Monitor nodes produced by live opencode agent runs.
---

# Opencode CLI Runner — Real Agent Integration Testing

## How It Works

`opencode run "prompt"` → OpenCode agent dispatches → Plugin hooks fire → `fredo hook` → IPC socket → `OpenCodeAdapter::transform()` → `FredoEvent` → `ContractEngine` → `EventBus` → `fredo-stream-event` → Mission Monitor renders nodes

Same pipeline real agents use. Produces agent, subagent, tool, and file nodes with edges. Only works when Fredo is running and the Fredo plugin is installed for OpenCode.

## Binary Detection

```powershell
$opencodeBin = Get-Command opencode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```

If not found: report `E2E BLOCKED: opencode binary not in PATH`. Do NOT attempt to install it.

Sanity check: `& $opencodeBin --version` should print version info.

## Prerequisites

The QA checks these in order. If any check fails, report `E2E BLOCKED` with the specific reason and return to the Engineering Lead.

| # | Check | Command | BLOCKED reason if missing |
|---|-------|---------|--------------------------|
| 1 | Fredo app running | `dev-environment` skill `Status` | `E2E BLOCKED: dev instance not running` |
| 2 | opencode binary in PATH | `Get-Command opencode` | `E2E BLOCKED: opencode binary not in PATH` |
| 3 | API credentials configured | `opencode auth list` | `E2E BLOCKED: no API credentials configured` |
| 4 | Fredo plugin installed | `Test-Path "$env:USERPROFILE\.config\opencode\plugins\fredo.js"` | `E2E BLOCKED: fredo plugin not installed for opencode` |
| 5 | `OPENCODE_ENABLE_TELEMETRY` set | `Test-Path env:OPENCODE_ENABLE_TELEMETRY` | `E2E BLOCKED: OPENCODE_ENABLE_TELEMETRY not set — OTLP telemetry disabled for opencode` |

---

## Core Test Patterns

| Pattern | Command | Expected Nodes in Mission Monitor | DOM Verification |
|---|---|---|---|
| Simple agent | `opencode run "tell me a joke"` | 1 agent node, 0+ tool nodes | `.react-flow__node-agentNode` contains text |
| Subagent dispatch | `opencode run "tell me a joke and ask a subagent to tell another one"` | agent node + subagent node + parent edge | `.react-flow__node-subagentNode` found |
| Tool usage | `opencode run "read the file AGENTS.md and tell me what it says"` | agent node + tool node(s) + file node(s) | `.react-flow__node-toolNode` found |
| Specific agent | `opencode run --agent <name> "prompt"` | agent node with agent name in title | Agent node title bar contains agent name |
| Specific model | `opencode run --model <provider/model> "prompt"` | agent node with model name in title | Agent node title bar contains model name |
| Continuation | `opencode run --continue` | new nodes appended to last session | Multiple nodes in same ReactFlow canvas |

---

## `opencode serve` + `--attach` (Fast Repeated Runs)

`opencode serve` starts a headless server that keeps MCP servers warm. Subsequent `opencode run --attach` calls skip cold-boot, making repeated runs faster.

```powershell
# Start the server in background (one-time)
$serveJob = Start-Job -ScriptBlock { opencode serve --port 4096 2>&1 }

# Wait a moment for the server to boot
Start-Sleep -Seconds 3

# Run tests against the warm server
opencode run --attach http://localhost:4096 "first prompt"
opencode run --attach http://localhost:4096 "second prompt with subagent"
opencode run --attach http://localhost:4096 "third prompt"

# Kill the server when done
Stop-Job $serveJob
Remove-Job $serveJob
```

Benefits over raw `opencode run`:
- No MCP server cold-boot on each run (saves 10-30s per run)
- Single server serves multiple test prompts
- Use when testing 3+ ACs that each need an agent run

Caveats:
- The server must be killed after testing — stale servers interfere with subsequent test runs
- Port 4096 must be available — if occupied, use `--port 4097` or similar
- If server fails to start, fall back to raw `opencode run`

---

## Recipes

### Recipe 1: Verify agent node appears for a simple prompt

```
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run "tell me a short joke" 2>&1
```

Wait 5s for pipeline flush, then:

```
tauri_webview_dom_snapshot(type="accessibility")
tauri_webview_find_element(strategy="css", selector=".react-flow__node-agentNode")
```

→ PASS: at least one agent node found in ReactFlow canvas.
→ FAIL: no agent nodes → BLOCKED if plugin isn't forwarding events.

### Recipe 2: Verify subagent node appears

```
$marker = "e2e-" + (New-Guid).ToString().Substring(0, 6)
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run "say '$marker' out loud, then ask a subagent to also say '$marker' out loud"
```

Wait for opencode to finish (usually 30-60s), then wait 5s for pipeline, then:

```
tauri_webview_dom_snapshot(type="accessibility")
tauri_webview_find_element(strategy="text", selector=$marker)
```

→ PASS: marker text found at least twice (once in agent node, once in subagent node).
→ FAIL: marker found only once → subagent didn't run or its output didn't reach Fredo.

### Recipe 3: Verify tool nodes appear for file reads

```
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run "read the file package.json and tell me what the project name is"
```

Wait for completion + 5s pipeline:

```
tauri_webview_find_element(strategy="css", selector=".react-flow__node-toolNode")
```

→ PASS: at least one tool node found. Text content includes file path or tool name.
→ FAIL: no tool nodes → tool events not reaching Fredo.

### Recipe 4: Fast multi-prompt via serve + attach

```
Start-Job -ScriptBlock { opencode serve --port 4096 2>&1 }
Start-Sleep -Seconds 3
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run --attach http://localhost:4096 "say hello world"
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run --attach http://localhost:4096 "ask a subagent to say goodbye world"
Stop-Job (Get-Job)[0]; Remove-Job (Get-Job)[0]
```

→ Verify: two agent prompts produced corresponding nodes in Mission Monitor.

### Recipe 5: Continuation (multi-turn)

```
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run "remember this: the code is ALPHA-99"
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run --continue "what was the code I asked you to remember?"
```

→ Verify: second response text contains "ALPHA-99" — proves session persistence works.

---

## Verification Patterns

| What to verify | DOM / JS approach |
|---|---|
| Agent node exists | `tauri_webview_find_element(strategy="css", selector=".react-flow__node-agentNode")` |
| Subagent node exists | `tauri_webview_find_element(strategy="css", selector=".react-flow__node-subagentNode")` |
| Tool node exists | `tauri_webview_find_element(strategy="css", selector=".react-flow__node-toolNode")` |
| File node exists | `tauri_webview_find_element(strategy="css", selector=".react-flow__node-fileNode")` |
| Node contains marker text | `tauri_webview_find_element(strategy="text", selector="<marker>")` |
| Session in sidebar | `tauri_webview_find_element(strategy="text", selector="<prompt snippet>")` in sidebar area |
| No error nodes | Snapshot has zero elements with `error` CSS class or "alert" role |
| Node structure is non-empty | Node text is not "undefined", "null", or whitespace-only |
| Subagent has parent edge | Agent and subagent nodes appear in same canvas — the edge is inferred |

---

## Wait / Retry Strategy

`opencode run` takes **30-120 seconds** depending on API latency and response length. Adjust waits accordingly:

| Step | Wait | Notes |
|---|---|---|
| After `opencode run` exits | 5s | IPC pipeline flush + React render |
| If expected node NOT found | +5s, retry once | Pipeline may be backed up with large batches |
| Still not found after retry | FAIL | "agent ran but node didn't appear in Mission Monitor" |
| `opencode serve` boot | 3s | Server needs time to bind port before `--attach` works |
| Max total wait per AC | 120s | Covers slow API + pipeline processing |

**IMPORTANT**: Wait for the `opencode run` process to EXIT before verifying DOM. The agent is still running while stdout is streaming. Check process completion before snapshots.

---

## Test Isolation

Unlike `fredo emit` which uses `--session-id`, `opencode run` generates its own session IDs. Isolation strategy:

1. **Embed a unique marker in the prompt**:
   ```
   $marker = "e2e-" + (New-Guid).ToString().Substring(0, 6)
   opencode run "say exactly this text: $marker"
   ```

2. **Take baseline DOM snapshot** before running opencode

3. **Run opencode** with the marker prompt

4. **Wait** for completion + pipeline flush

5. **Take result DOM snapshot** and search for marker text

6. **Compare** — only nodes containing the marker are test-relevant

Real sessions from OTLP receivers and other agents continue to stream into Mission Monitor as background noise. The marker text distinguishes test nodes from real nodes.

---

## ⚠️ ECE Transport Filtering Awareness

**`opencode run` produces Hook transport events by default.** The command's pipeline is: plugin hooks fire → `fredo hook` → IPC socket → `OpenCodeAdapter::transform(Hook)`.

**To enable OTLP gRPC export (required for OTLP-only ECE contracts), set `OPENCODE_ENABLE_TELEMETRY=1` before each `opencode run` command.** When this env var is set, the Fredo OpenCode plugin initializes its OTLP exporter and sends telemetry spans via gRPC to `127.0.0.1:4317` (the default OTLP receiver endpoint). This produces OTLP gRPC transport events alongside the default Hook events — matching OTLP-only contracts like Mission Monitor's `chat-node` (`transports: ['otlp_grpc']`).

The Fredo OpenCode plugin reads `OPENCODE_ENABLE_TELEMETRY` at initialization time (see `config.ts:72`). A non-empty value (e.g., `"1"`, `"true"`) enables telemetry. Without it, the plugin skips OTLP exporter initialization and only fires Hook events.

```powershell
# ✅ OTLP export enabled — both Hook AND OTLP gRPC events produced
$env:OPENCODE_ENABLE_TELEMETRY="1"; opencode run "your prompt here"
```

**The Mission Monitor's ECE contracts may filter for specific transports.** As of Spec #593/#586, the `chat-node` contract in `MissionMonitorFeature.tsx` specifies `transports: ['otlp_grpc']` — it ONLY matches events from the OTLP gRPC receiver. Hook transport events (from `opencode run` without the env var) are **silently filtered out** by the ContractEngine and never create ChatNodes.

**Before testing ChatNode/AgentNode creation with `opencode run`:**
1. Check the target feature's ECE contract declarations (e.g., `MissionMonitorFeature.tsx:27-41`) for a `transports` filter
2. If `transports` includes `otlp_grpc` but NOT `hook` → ChatNodes WILL NOT appear unless `OPENCODE_ENABLE_TELEMETRY=1` is set
3. For OTLP-only contracts: set `$env:OPENCODE_ENABLE_TELEMETRY="1"` before `opencode run` to enable OTLP gRPC export
4. Verify the env var is set: `Test-Path env:OPENCODE_ENABLE_TELEMETRY` returns `True`

**SubagentNodes may still appear even when ChatNodes don't** — this is because real background agent traffic using OTLP transport creates them independently. Do NOT interpret SubagentNode visibility as evidence that ChatNode creation works.

**Cross-reference with `fredo-cli-events` skill:** `fredo emit` events bypass OTLP adapters entirely (they go IPC → EventBus directly). The `fredo-cli-events` skill already documents this OTLP bypass. For ACs requiring OTLP-only contract verification, only `opencode run` with `OPENCODE_ENABLE_TELEMETRY=1` produces OTLP gRPC events — neither plain `opencode run` (Hook-only) nor `fredo emit` (IPC bypass) will work.

---

## Troubleshooting

Do NOT attempt to fix infrastructure issues. Report the BLOCKED reason and return to the Engineering Lead.

| Symptom | Likely Cause | Report |
|---|---|---|
| `opencode` not found | binary not installed / not in PATH | `E2E BLOCKED: opencode binary not in PATH` |
| `opencode auth list` returns empty | no API credentials configured | `E2E BLOCKED: no API credentials configured` |
| `fredo.js` plugin missing | Setup wizard not completed | `E2E BLOCKED: fredo plugin not installed for opencode` |
| Agent runs but no ChatNodes appear | ECE transport filter mismatch (Hook vs otlp_grpc) — `OPENCODE_ENABLE_TELEMETRY` not set | Check ECE contract `transports` field in feature declaration. Set `$env:OPENCODE_ENABLE_TELEMETRY="1"` before `opencode run` to enable OTLP gRPC export. |
| `opencode run` hangs or times out | API rate limit / quota exhausted | `E2E BLOCKED: opencode run timed out (>120s)` |
| `opencode serve` port conflict | Port 4096 already in use | Try `--port 4097`, or kill existing serve process |
| Nodes appear but content is empty | Adapter couldn't parse event payload | FAIL with evidence: screenshot of empty node |
