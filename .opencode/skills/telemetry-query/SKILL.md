---
name: telemetry-query
description: Query Fredo's telemetry database (fredo.db) via sqlite3 CLI to inspect spans, diagnose errors, monitor performance, and check retention. Load when an agent needs to query telemetry data, export span data, or debug the tracing subsystem.
---

# Telemetry Query — SQLite3 Interface to fredo.db

## How It Works

`telemetry-query.ps1` → `sqlite3 --readonly fredo.db` → formatted output (JSON / markdown / table)

The telemetry subsystem stores OpenTelemetry-compatible spans in a `telemetry_spans` table inside `fredo.db`. The same database used by `AppStore` (settings KV) and `FeatureStore` (feature-level data). This skill provides a read-only query interface — no mutations, no DDL, no DML.

Span lifecycle:
- **Init** → span created with `start_time_ns`, `status_code='UNSET'`
- **Update** → span enriched with attributes (latest only — streaming deltas coalesced)
- **Response** → span closed with `status_code='OK'`, `end_time_ns` set
- **Error** → span closed with `status_code='ERROR'`, `status_message` recorded

## Finding the Database

```powershell
# Tauri app data dir (Windows — most likely location)
$env:APPDATA\com.fredo.app\fredo.db

# Common fallback paths (searched in order by the wrapper script):
$HOME\.fredo\fredo.db                          # Linux / macOS / manual setup
$env:LOCALAPPDATA\com.fredo.app\fredo.db      # Windows local (non-roaming)
$env:APPDATA\fredo\fredo.db                   # Alternative Windows path
```

The wrapper script searches these paths automatically. If the database is not found, it reports an error with the paths it attempted.

## CLI Reference

```
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "<SQL SELECT statement>" `
  [-Format json|md|table] `
  [-Limit 1000]
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `-Query`  | Yes      | —       | SQL SELECT query (without trailing LIMIT — appended automatically). Must be read-only. |
| `-Format` | No       | `table` | Output format: `json` (raw JSON array), `md` (markdown table), `table` (plain sqlite3 table) |
| `-Limit`  | No       | `1000`  | Maximum rows returned. Appended as `LIMIT N` unless query already contains `LIMIT`. |

### Guardrails (enforced by the wrapper)

- ❌ **DDL/DML rejected**: `CREATE`, `ALTER`, `DROP`, `INSERT`, `UPDATE`, `DELETE` — the script scans the query and refuses to execute if any of these keywords appear (case-insensitive).
- ✅ **Allowed**: `PRAGMA table_info(table_name)` — introspection of table schema is explicitly permitted.
- ✅ **Default LIMIT**: If the query has no `LIMIT` clause, `LIMIT 1000` is appended automatically. Override with `-Limit N`.
- ✅ **Read-only mode**: `sqlite3` is invoked with `-readonly` flag, preventing accidental writes even if DML somehow passes the keyword check.

---

## Query Recipes

### Recipe 1: Recent Error Spans

Find all spans that ended with an error in the last hour.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT span_id, span_name, status_message, datetime(start_time_ns / 1000000000, 'unixepoch') AS started_at, provider, transport FROM telemetry_spans WHERE status_code = 'ERROR' AND start_time_ns > (strftime('%%s', 'now') - 3600) * 1000000000 ORDER BY start_time_ns DESC" `
  -Format table
```

→ Use this to diagnose recent agent errors. `status_message` contains the error text from the FredoEvent.

### Recipe 2: Latency Percentiles

Compute p50, p90, p99 latency in milliseconds for completed spans.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT span_name, COUNT(*) AS count, ROUND(AVG((end_time_ns - start_time_ns) / 1000000.0), 1) AS avg_ms, ROUND(MIN((end_time_ns - start_time_ns) / 1000000.0), 1) AS min_ms, ROUND(MAX((end_time_ns - start_time_ns) / 1000000.0), 1) AS max_ms FROM telemetry_spans WHERE end_time_ns IS NOT NULL GROUP BY span_name ORDER BY avg_ms DESC" `
  -Format json
```

→ JSON output for programmatic consumption. Latency metrics help identify slow agent operations.

### Recipe 3: Session Trace

Get the full trace of spans for a specific session — follow parent-child relationships.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT span_id, parent_span_id, span_name, span_kind, status_code, datetime(start_time_ns / 1000000000, 'unixepoch') AS started_at, CASE WHEN end_time_ns IS NOT NULL THEN printf('%.1fms', (end_time_ns - start_time_ns) / 1000000.0) ELSE 'open' END AS duration FROM telemetry_spans WHERE session_id = '<session-id>' ORDER BY start_time_ns ASC" `
  -Format md
```

→ Replace `<session-id>` with the actual session UUID. Markdown output renders nicely in GitHub issue comments. The `parent_span_id` column shows the span hierarchy — the first span in a session has `parent_span_id = NULL`.

### Recipe 4: Span Counts by Event Type

Aggregate span counts and error rates by event type.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT event_type, provider, transport, COUNT(*) AS total, SUM(CASE WHEN status_code = 'ERROR' THEN 1 ELSE 0 END) AS errors, ROUND(100.0 * SUM(CASE WHEN status_code = 'ERROR' THEN 1 ELSE 0 END) / COUNT(*), 1) AS error_pct FROM telemetry_spans GROUP BY event_type, provider, transport ORDER BY total DESC" `
  -Format md
```

→ Identify which event types produce the most errors. High `error_pct` on a specific `event_type` + `provider` combination suggests an adapter issue.

### Recipe 5: Storage Usage

Check how much space the telemetry table consumes and row counts by status.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT status_code, COUNT(*) AS count, printf('%.2f MB', COUNT(*) * 0.001) AS est_size FROM telemetry_spans GROUP BY status_code ORDER BY count DESC" `
  -Format table
```

```powershell
# Also check total table size via sqlite3 built-in
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "PRAGMA page_count * PRAGMA page_size AS total_bytes" `
  -Format json
```

→ Note: `PRAGMA` is allowed for `page_count`, `page_size`, and `table_info` only. The `est_size` column is a rough approximation; use `PRAGMA page_count * page_size` for accurate storage bytes.

### Recipe 6: Retention Status

See how old your oldest and newest spans are, and when the next retention cleanup will run.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT MIN(ingested_at) AS oldest_span, MAX(ingested_at) AS newest_span, COUNT(*) AS total_spans, ROUND((julianday('now') - julianday(MIN(ingested_at))) , 1) AS age_days FROM telemetry_spans" `
  -Format md
```

→ Retention is configured via `tracing.retention_days` (AppStore setting, default 7). Spans older than this threshold are deleted on Fredo startup. If spans are unexpectedly missing, check the retention setting.

### Recipe 7: Table Schema Inspection

View the full schema and indexes of the `telemetry_spans` table.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "PRAGMA table_info(telemetry_spans)" `
  -Format table
```

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT * FROM pragma_index_list('telemetry_spans')" `
  -Format table
```

→ Use `table_info` to check column names, types, and nullability. Use `index_list` to verify which indexes exist.

---

## Output Formats

### JSON (`--format json`)

```json
[
  {
    "span_id": "abc-123",
    "span_name": "tool_use.Bash",
    "status_code": "OK",
    "duration_ms": "45.2"
  }
]
```

Raw JSON array from `sqlite3 .mode json`. Each object's keys match the column names in the SELECT statement. Useful for programmatic consumption by the agent.

### Markdown (`--format md`)

```
| span_id | span_name | status_code | duration_ms |
|---------|-----------|-------------|-------------|
| abc-123 | tool_use.Bash | OK | 45.2 |
| def-456 | chat.assistant | OK | 120.0 |
```

The wrapper post-processes `sqlite3 .mode table` output into a GitHub-flavored markdown table with aligned columns. Best for pasting into GitHub issue comments and PR reviews.

### Table (`--format table`)

```
+---------+----------------+-----------+-----------+
| span_id |   span_name    | status_code | duration |
+---------+----------------+-----------+-----------+
| abc-123 | tool_use.Bash  | OK        | 45.2ms    |
| def-456 | chat.assistant | OK        | 120.0ms   |
+---------+----------------+-----------+-----------+
```

Raw `sqlite3 .mode table` output. Best for quick terminal inspection.

---

## Error Handling

The wrapper script provides clear error messages for common failure modes:

| Condition | Error Message |
|-----------|---------------|
| `sqlite3` not found | `ERROR: sqlite3 CLI not found. Install sqlite3 (choco install sqlite / scoop install sqlite / apt install sqlite3)` |
| `fredo.db` not found | `ERROR: fredo.db not found. Searched: <comma-separated list of paths>`. Run Fredo at least once to create the database. |
| DDL/DML in query | `ERROR: Query rejected — contains forbidden keyword: <keyword>. Only SELECT and PRAGMA table_info are allowed.` |
| Query execution failure | `ERROR: SQLite query failed: <sqlite3 stderr>` |

---

## Test Isolation

When querying telemetry data during e2e tests, use a unique session ID prefix to separate test spans from real agent activity:

```powershell
$testSessionId = "e2e-" + (New-Guid).ToString().Substring(0, 8)
```

Then filter queries by `session_id LIKE '$testSessionId%'` to isolate test spans.

---

*Authored by Coder*
