---
name: fredo-cli-events
description: CLI-based mock event injection for Fredo e2e testing. Load when the QA needs to trigger specific UI states by sending events through the IPC socket.
---

# Fredo E2E — Mock Event Injection

## How It Works

`fredo emit` → IPC socket (`\\.\pipe\fredo-ipc` on Windows) → `CliCommand::EmitEvent` → `InternalAdapter::enrich` → **RTDB ingest classifier** (`rtdb/ingest.rs`) → canonical rows (`chat_rows` / `tool_use_rows` / `agent_session_rows`) → subscriptions → `fredo-stream-event` → React frontend (Spec #2788 — the RTDB row pipeline is the ONLY delivery path).

Same row path real OTLP spans take. Only works when the dev:tauri instance is running and the `fredo` binary is built.

**⚠️ `--file` / `--payload` carry the event BODY (payload) only.** A whole-event JSON (with `eventType`/`state`/`sessionId` keys) passed to `--file` does NOT error — it silently nests as the event's payload and classifies into an extraction-empty row under the default session (`tauri-local`). There is no whole-event injection mode. When in doubt, verify the emitted rows via the telemetry-query skill (recipe below).

**⚠️ CRITICAL — mock-vs-real payload shapes:** `fredo emit` injects the event body straight into the row classifier, bypassing the OTLP receivers entirely. Mock payloads follow the conventions below; real OTLP spans carry the plugin's `gen_ai.*` attributes and classify richer rows (model, cost, span timing). Mock tool rows carry no span timing, so the time-window tool→chat association does NOT attach them — use real drives when testing association-dependent UI.

**DO NOT use `fredo emit` for these scenarios:**
- Verifying Mission Monitor's graph derivation from real OTLP-derived rows (span timing, cost, model, per-turn token deltas)
- Testing span attribute extraction (the `rtdb/attrs.rs` extract rules against real plugin shapes)
- End-to-end OTLP transport validation (gRPC/HTTP legs, cross-transport dedupe)

**For real pipeline verification, drive a live opencode session through Fredo's Run CLI feature instead** (maomaolabs toolbar → Run CLI; see the "Feature usage: Run CLI" section of the feature's `smoke.md` for the full method — `write_pty_input` with trailing `\r`, wait through `Starting OpenCode…`, never `opencode run` from a shell). `fredo emit` is appropriate for row-classification testing, Mission Monitor row rendering from canonical mock shapes, and IPC-socket testing.

## Finding the Binary

```powershell
$fredoBin = Get-ChildItem -Path "apps/tauri/src-tauri/target" -Recurse -Filter "fredo.exe" | Select-Object -First 1 -ExpandProperty FullName
```

If not found: `pnpm dev:tauri` must have run at least once to build the binary. Report "E2E BLOCKED: fredo binary not found" if missing.

Sanity check: `& $fredoBin --version` should print version info.

## Using `fredo emit` Directly

Call `fredo emit` directly with explicit flags (see the CLI reference below). Follow these conventions:
- **State** values: snake_case (`init`, `update`, `response`, `error`) — the default is `init`, so a bare `fredo emit` WITHOUT `--state` succeeds (nit c fix)
- **Event type** values: snake_case (`tool_use`, `agent_session`, `chat`, `infrastructure`, `ui`, `custom`) — accepted as-is by `--event-type` (nit b fix)
- **Provider** values: snake_case (`open_code`, `claude_code`, `internal`)
- Payload files: strip BOM and validate JSON before passing; the file is the event BODY only (see the caveat above)

Usage: `& $fredoBin emit --event-type tool_use --state init --tool-name Bash --provider open_code --session-id e2e-test-1`

## CLI Reference

```
& $fredoBin emit \
  --event-type <tool_use|agent_session|chat|infrastructure|ui|custom> \
  --state <init|update|response|error> \
  --tool-name <string> \
  --session-id <string> \
  --correlation-id <string> \
  --provider <open_code|claude_code|internal> \
  --payload '<json string>' \
  --file <path-to-payload-json or ->
```

Defaults: `--state init`, `--session-id tauri-local`, `--provider internal`. `--file -` reads the payload from stdin.

---

## Event Types and Their UI Effects

All effects now come from classified RTDB rows (the v1 delivery streams no longer exist):

| Event Type | State | What it triggers in the UI |
|------------|-------|---------------------------|
| `chat` | `init` | Chat row upsert → Mission Monitor renders a chat node (USER section; userMessage extracted per the classifier's priority chain) |
| `chat` | `response` | Chat row patch → RESPONSE section + token figures (from `payload.info.turnInputTokens`/`turnOutputTokens` or the classifier's canonical projections) |
| `tool_use` | `init`/`update` | Tool row upsert → TOOLS sections / tool nodes in Mission Monitor |
| `tool_use` | `response` | Tool row completion (success/error outcome) |
| `tool_use` (`tool-name Fredo_ui_stepper`) | any | Stepper-probe rows: the Stepper Probe panel's row count + epoch advance; auto-navigation to the steps page fires when the panel is open (W5) |
| `agent_session` | `init` | Session row upsert → Mission Monitor session identity |
| `agent_session` | `response` | Session aggregate patch (total_tokens / total_messages / total_cost_usd) |
| `infrastructure` / `ui` / `custom` | any | Classified only through the CLI mock shapes — no dedicated UI consumer today |

→ Verify via Mission Monitor DOM captures or the row stores (`chat_rows`/`tool_use_rows`/`agent_session_rows` in fredo.db, read-only via the telemetry-query skill).

---

## OpenCode Plugin → OTLP Spans (real path)

**CRITICAL: real rows come from spans, not Hook events.** The plugin at `apps/opencode-plugin/src/index.ts` exports OTLP traces to `127.0.0.1:4317`. Every span is persisted raw to `telemetry_spans` on receipt AND classified into RTDB rows by the ingest classifier.

### Verification Recipe

To check which spans a given agent session actually produced, load the **`telemetry-query`** skill and use its sanctioned wrapper. It owns `fredo.db` path resolution, enforces read-only guardrails, and uses the `telemetry_spans.session_id` column — do NOT call `sqlite3 fredo.db` directly:

```powershell
# 1. Find the session ID from Mission Monitor or query telemetry
# 2. Query telemetry for event types received for that session
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT event_type, COUNT(*) AS count FROM telemetry_spans WHERE session_id = '<session-id>' GROUP BY event_type ORDER BY count DESC" `
  -Format md
```

**Red flag:** If a span type your fix depends on has `count = 0`, the plugin is NOT emitting it. Do NOT design a fix around that event type — either update the plugin or use a different source.

---

## Mock Event Recipes

Each recipe smoke-verified live against the RTDB row path (Spec #2788 P6.1). All payloads are event BODY only (`--file`/`--payload` never carry a whole event).

### Recipe 1: Chat turn with user message (Mission Monitor)

```
& $fredoBin emit --event-type chat --state init --provider open_code --session-id e2e-chat-1 --correlation-id e2e-chat-1_1 --payload '{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"e2e-test: hello from mock event\"}]}}'
```

→ Verify: Mission Monitor shows a chat node for session `e2e-chat-1` with the `── USER ──` section carrying the emitted text. (The classifier's mock-shape extraction reads `message.content[].text`; real spans use the `gen_ai.input.messages`/`gen_ai.output.messages` registry keys.)

### Recipe 2: Tool execution lifecycle

```
$cid = $(New-Guid)
& $fredoBin emit --event-type tool_use --state init --tool-name read_file --provider open_code --correlation-id $cid --session-id e2e-tools-1
& $fredoBin emit --event-type tool_use --state response --tool-name read_file --provider open_code --correlation-id $cid --session-id e2e-tools-1
```

→ Verify: tool row for the composite key with `tool_success`/state outcome; Mission Monitor renders it (note: mock tool rows carry no span timing, so time-window association does NOT attach them to a chat node — the mock-vs-real rule).

### Recipe 3: Agent session lifecycle

```
& $fredoBin emit --event-type agent_session --state init --tool-name opencode --provider open_code --session-id e2e-lifecycle-1
& $fredoBin emit --event-type agent_session --state response --tool-name opencode --provider open_code --session-id e2e-lifecycle-1 --payload '{\"total_tokens\":1234,\"total_messages\":3,\"total_cost_usd\":0.01}'
```

→ Verify: Mission Monitor session row with aggregate figures from the payload.

### Recipe 4: Stepper probe rows (row-subscription probe)

```
& $fredoBin emit --event-type tool_use --tool-name Fredo_ui_stepper --state init --session-id e2e-stepper-1 --payload '{\"steps\":[{\"title\":\"Step A\",\"status\":\"Waiting\"}]}'
```

→ Verify: with the Stepper Probe panel open, its Replayed-rows counter increments and the row-store epoch advances; auto-navigation to the steps page fires when the current page is neither `steps` nor `dev-mode` (W5 migration).

### Recipe 5: Snake_case CLI parsing regression

```
& $fredoBin emit --event-type tool_use --session-id e2e-parse-1
```

→ Verify: command succeeds (default `--state init` parses; nit b/c fix). Row appears in `tool_use_rows` under session `e2e-parse-1`.

---

## Test Isolation — Unique Session IDs

**Problem:** The dev:tauri instance runs OTLP receivers, the row classifier, and any connected agents simultaneously. Real spans stream into the row store alongside test events. This pollutes the DOM snapshot — you can't tell which events are yours.

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

---

## Test Pattern

For each AC that needs mock events:

1. Take a **baseline DOM snapshot** before emitting
2. **Emit the event** via `fredo emit`
3. **Wait 2 seconds** for React to process (rows are async)
4. Take a **result DOM snapshot**
5. **Compare** — the AC describes what should have changed between baseline and result
6. If the change hasn't happened after 2s, wait 3 more seconds and retry once
7. If still unchanged → FAIL with "event emitted but no UI change detected"

**Important**: Generate a random unique `--session-id` per test run to isolate from real events (OTLP, plugins). Use `New-Guid` for uniqueness: `$e2eSessionId = "e2e-" + (New-Guid).ToString().Substring(0, 8)`. Use a unique `--correlation-id` per turn key. Compare baseline vs result DOM snapshots — only changes from the unique session ID indicate success.
