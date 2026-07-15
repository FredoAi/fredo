---
name: fredo-cli-events
description: CLI-based mock event injection for Fredo e2e testing. Load when the QA needs to trigger specific UI states by sending FredoEvents through the IPC socket.
---

# Fredo E2E — Mock Event Injection

## How It Works

`fredo emit` → IPC socket (`\\.\pipe\fredo-ipc` on Windows) → EventBus → `fredo-stream-event` → React frontend

Same path real events take. Only works when the dev:tauri instance is running and the `fredo` binary is built.

## Finding the Binary

```powershell
$fredoBin = Get-ChildItem -Path "apps/tauri/src-tauri/target" -Recurse -Filter "fredo.exe" | Select-Object -First 1 -ExpandProperty FullName
```

If not found: `pnpm dev:tauri` must have run at least once to build the binary. Report "E2E BLOCKED: fredo binary not found" if missing.

Sanity check: `& $fredoBin --version` should print version info.

## Recommended: Use the Validated Wrapper

Prefer `e2e-inject.ps1` over raw `fredo emit` commands. It validates:
- State casing (enforces lowercase: `init`, `update`, `response`, `error`)
- Provider format (enforces hyphenated: `open-code`, `claude-code`, `internal`)
- Event type `_` → `-` conversion
- BOM stripping from payload files
- JSON payload validation

Usage: `powershell -File .opencode/scripts/e2e-inject.ps1 -EventType tool_use -State init -ToolName Bash -Provider open-code -SessionId e2e-test-1`

## CLI Reference

```
& $fredoBin emit \
  --event-type <tool_use|agent_session|chat|infrastructure|ui|custom> \
  --state <init|update|response|error> \
  --tool-name <string> \
  --session-id <string> \
  --correlation-id <string> \
  --provider <open-code|claude-code|internal> \
  --payload '<json string>'
```

Defaults: `--state init`, `--session-id tauri-local`, `--provider internal`

---

## Event Types and Their UI Effects

| Event Type | State | What it triggers in the UI |
|------------|-------|---------------------------|
| `tool_use` | `Init` | Opens a feature window for that tool if one exists |
| `tool_use` | `Response` | Updates window content / counters increment |
| `tool_use` | `Error` | Shows error state in the feature window |
| `chat` | `Init` | Adds a chat message node to Mission Monitor |
| `agent_session` | `Init` | Creates a new agent session in Mission Monitor |
| `agent_session` | `Response` | Completes a session / updates status |
| `infrastructure` | `Init` | Triggers Diagram feature updates |
| `ui` | `Init` | Triggers UI-level custom events |

---

## OpenCode Plugin Event Forwarding Matrix

**CRITICAL: Not all opencode events reach Fredo's adapter.** The plugin at `apps/opencode-plugin/src/index.ts` controls which events are forwarded. When designing bug fixes or features that depend on specific opencode events, verify the plugin actually forwards them.

### Hook Architecture

The opencode plugin uses two mechanisms to forward events to `fredo open-code-plugin`:

1. **Catch-all `event` hook** (line 41): Forwards ANY opencode event via `event.type` discriminator. This covers most session lifecycle, permission, file, and command events.
2. **Dedicated hook registrations** (lines 46-69): Specific hooks for `tool.execute.before`, `tool.execute.after`, `chat.message`, and `experimental.compaction.autocontinue`. These are needed because those hooks have different signatures (input/output args) than the catch-all `event` hook.

### Event Forwarding Table

| OpenCode Event | Hook Type | Forwarded? | Event Type in IPC | Notes |
|---------------|-----------|------------|-------------------|-------|
| `chat.message` | Dedicated (`chat.message`) | ✅ Yes | `chat.message` | Has `input.output.message.parts[0].text` for user prompt |
| `session.created` | Catch-all `event` | ✅ Yes | `session.created` | Session metadata + agent info |
| `session.updated` | Catch-all `event` | ✅ Yes | `session.updated` | Carries final response + token counts for deepseek |
| `session.deleted` | Catch-all `event` | ✅ Yes | `session.deleted` | Session cleanup |
| `session.idle` | Catch-all `event` | ✅ Yes | `session.idle` | Agent idle notification |
| **`session.status`** | Catch-all `event` | **⚠️ UNKNOWN** | `session.status` | Delta/text streaming events. **Bug #593: QA found ZERO session.status events in telemetry for deepseek agent sessions.** May not fire for all models/providers, or may not be forwarded by the catch-all hook. |
| `PreToolUse` | Dedicated (`tool.execute.before`) | ✅ Yes | `PreToolUse` | Tool metadata before execution |
| `PostToolUse` | Dedicated (`tool.execute.after`) | ✅ Yes | `PostToolUse` | Tool response after execution (includes `task` tool for @-subagent) |
| `permission.asked` | Catch-all `event` | ✅ Yes | `permission.asked` | Permission requests |
| `permission.replied` | Catch-all `event` | ✅ Yes | `permission.replied` | Permission responses |
| `file.edited` | Catch-all `event` | ✅ Yes | `file.edited` | File modification events |
| `command.executed` | Catch-all `event` | ✅ Yes | `command.executed` | Shell command execution |
| `message.part.updated` | Catch-all `event` | ⚠️ Varies | `message.part.updated` | Streaming delta events. Deepseek uses these instead of `chat.message` for streaming (Bug #586). |
| `message.updated` | Catch-all `event` | ⚠️ Varies | `message.updated` | Message updates with metadata |
| `experimental.compaction.autocontinue` | Dedicated | ✅ Yes | `experimental.compaction.autocontinue` | Session compaction events |

### Known Gaps (Bug #593)

1. **`session.status` delta events:** For deepseek agents, the QA telemetry query found **zero** `session.status` spans. This means text accumulation via delta chunk concatenation CANNOT work with the current plugin — the events never reach the adapter. Any fix that depends on `session.status` events will silently fail unless the plugin is updated to forward them (or the adapter uses `session.updated` for final response instead).

2. **Model-specific event differences:** Deepseek uses `message.part.updated` with a `delta` field for streaming text, NOT `chat.message` with `output.message.parts[0].text`. Bug #586 was triggered by this mismatch. Always verify which events your target model/provider actually emits by querying the telemetry database.

### Verification Recipe

To check which events are ACTUALLY being forwarded by the plugin for a given agent session:

```powershell
# 1. Find the session ID from Mission Monitor or query telemetry
# 2. Query telemetry for event types received for that session
sqlite3 fredo.db "SELECT DISTINCT json_extract(payload, '$.event_type') as event_type, COUNT(*) as count FROM telemetry_spans WHERE json_extract(payload, '$.sessionID') = '<session-id>' GROUP BY event_type ORDER BY count DESC"
```

**Red flag:** If an event type your fix depends on has `count = 0`, the plugin is NOT forwarding it. Do NOT design a fix around that event type — either update the plugin or use a different event source.

---

## Mock Event Recipes

### Recipe 1: Trigger a feature window to open

```
& $fredoBin emit --event-type tool_use --state init --tool-name run-cli --provider open-code --session-id e2e-test-1
```

→ Verify: `tauri_webview_dom_snapshot(type="accessibility")` contains a window with the feature name.

### Recipe 2: Send a chat message (Mission Monitor)

```
& $fredoBin emit --event-type chat --state init --tool-name assistant --provider open-code --session-id e2e-session-1 --correlation-id e2e-corr-1 --payload '{\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"e2e-test: hello from mock event\"}]}}'
```

→ Verify: `tauri_webview_find_element(strategy="text", selector="e2e-test: hello")` finds the message.

### Recipe 3: Trigger an error display

```
& $fredoBin emit --event-type tool_use --state error --tool-name terminal --provider open-code --session-id e2e-session-1 --payload "{\"error\":{\"message\":\"e2e-test: intentional error for testing\"}}"
```

→ Verify: error element visible in accessibility tree with role "alert" or text containing "error".

### Recipe 4: Increment counters (multiple events)

```
$cid = $(New-Guid)
& $fredoBin emit --event-type tool_use --state init --tool-name read_file --provider open-code --correlation-id $cid --session-id e2e-counters
& $fredoBin emit --event-type tool_use --state response --tool-name read_file --provider open-code --correlation-id $cid --session-id e2e-counters
```

→ Verify: `tauri_webview_execute_js` reads counter state and value increased by 1.

### Recipe 5: Agent session lifecycle

```
& $fredoBin emit --event-type agent_session --state init --tool-name opencode --provider open-code --session-id e2e-lifecycle-1
& $fredoBin emit --event-type agent_session --state response --tool-name opencode --provider open-code --session-id e2e-lifecycle-1
```

→ Verify: Mission Monitor shows session with correct lifecycle state.

### Recipe 6: Infrastructure stream (Diagram)

```
& $fredoBin emit --event-type infrastructure --state init --tool-name kubectl_get --provider internal --session-id e2e-diag --payload "{\"resource\":\"pods\",\"namespace\":\"default\",\"items\":[{\"name\":\"nginx-pod\",\"status\":\"Running\"}]}"
```

→ Verify: Diagram feature shows the node.

---

## Test Isolation — Unique Session IDs

**Problem:** The dev:tauri instance runs OTLP receivers, internal adapters, and any connected agents simultaneously. Real events stream into Mission Monitor alongside test events. This pollutes the DOM snapshot — you can't tell which events are yours.

**Solution:** Use a unique, random session ID for every test run, and compare baseline vs result DOM snapshots:

```powershell
$e2eSessionId = "e2e-" + (New-Guid).ToString().Substring(0, 8)
```

Every `fredo emit` call in the test run uses `--session-id $e2eSessionId`. This isolates test events from real events — Mission Monitor treats different session IDs as independent sessions.

**Baseline comparison pattern:**
1. Take baseline DOM snapshot **before** injecting any events
2. Inject events with unique `--session-id $e2eSessionId`
3. Wait 2s for React to process
4. Take result DOM snapshot
5. Search result snapshot for `$e2eSessionId` — only test events match

This way, the 6 real sessions with 7610-18082 events are just background noise. You only verify changes from your unique session ID.

---

## Test Pattern

For each AC that needs mock events:

1. Take a **baseline DOM snapshot** before emitting
2. **Emit the event** via `fredo emit`
3. **Wait 2 seconds** for React to process (events are async)
4. Take a **result DOM snapshot**
5. **Compare** — the AC describes what should have changed between baseline and result
6. If the change hasn't happened after 2s, wait 3 more seconds and retry once
7. If still unchanged → FAIL with "event emitted but no UI change detected"

**Important**: Generate a random unique `--session-id` per test run to isolate from real events (OTLP, plugins, internal adapters). Use `New-Guid` for uniqueness: `$e2eSessionId = "e2e-" + (New-Guid).ToString().Substring(0, 8)`. Use a unique `--correlation-id` for Init/Response pairs. Compare baseline vs result DOM snapshots — only changes from the unique session ID indicate success.
