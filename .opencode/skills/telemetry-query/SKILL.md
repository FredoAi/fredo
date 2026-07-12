---
name: telemetry-query
description: Query Fredo's telemetry database (fredo.db) via sqlite3 CLI to inspect spans, diagnose errors, monitor performance, and check retention. Load when an agent needs to query telemetry data, export span data, or debug the tracing subsystem.
---

# Telemetry Query — SQLite3 Interface to fredo.db

## Related Skills

- **dev-environment**: Dev instance lifecycle (start/stop/status/restart) and process logs. Use when you need to check if the app is running or debug startup issues.

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

## Metric Query Recipes

The `telemetry_metrics` table stores pre-aggregated metric data derived from the FredoEvent stream by the `MetricCollector` background task:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `metric_name` | TEXT | Metric identifier: `span_count`, `events_received`, `orphan_spans`, `active_sessions`, `span_duration_ms` |
| `metric_type` | TEXT | One of `counter` (monotonically increasing), `gauge` (snapshot value), or `histogram` (bucket count) |
| `labels_json` | TEXT | JSON dimension labels: `{"span_name":"...","status":"ok"}` for counters, `{"span_name":"...","bucket_le":"50"}` for histogram buckets |
| `value` | REAL | The aggregated metric value: counter total, gauge reading, or histogram bucket count |
| `timestamp` | TEXT | RFC3339 timestamp of the aggregation window end |
| `aggregation_window_s` | INTEGER | Aggregation interval in seconds (configurable 10–300) |

Metric data is written in batch every N seconds (default 60). All metric queries are read-only — the `telemetry-query.ps1` wrapper handles database location and guardrails automatically.

### Recipe 8: Latency Percentiles from Histogram Buckets

Compute p50, p90, and p99 latency boundaries for each span name using accumulated histogram bucket counts. Each row stores the count of spans whose duration fell within that bucket's upper-bound range.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "WITH bucket_bounds(bucket_le, sort_order) AS (VALUES (1,1),(5,2),(10,3),(25,4),(50,5),(100,6),(250,7),(500,8),(1000,9),(2500,10),(5000,11),(10000,12)), hist_counts AS (SELECT json_extract(labels_json, '$.span_name') AS span_name, CAST(json_extract(labels_json, '$.bucket_le') AS INTEGER) AS bucket_le, SUM(value) AS cnt FROM telemetry_metrics WHERE metric_name = 'span_duration_ms' AND metric_type = 'histogram' GROUP BY span_name, CAST(json_extract(labels_json, '$.bucket_le') AS INTEGER)), span_total AS (SELECT span_name, SUM(cnt) AS total FROM hist_counts GROUP BY span_name), cumulative AS (SELECT h.span_name, CAST(h.bucket_le AS INTEGER) AS le, h.cnt, SUM(h.cnt) OVER (PARTITION BY h.span_name ORDER BY h.bucket_le) AS cum, t.total FROM hist_counts h JOIN span_total t ON h.span_name = t.span_name) SELECT span_name, MIN(CASE WHEN cum * 100.0 / total >= 50 THEN le END) AS p50_ms, MIN(CASE WHEN cum * 100.0 / total >= 90 THEN le END) AS p90_ms, MIN(CASE WHEN cum * 100.0 / total >= 99 THEN le END) AS p99_ms, MAX(total) AS span_count FROM cumulative GROUP BY span_name ORDER BY span_name" `
  -Format json
```

→ JSON output for programmatic consumption. Latency percentiles reveal the distribution tail — if p99 is much higher than p50, there are sporadic slow operations worth investigating alongside the span traces.

### Recipe 9: Throughput Over Time

Aggregate `span_count` counter values by hourly windows to visualize throughput trends for each span name.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour_bucket, json_extract(labels_json, '$.span_name') AS span_name, SUM(value) AS span_count FROM telemetry_metrics WHERE metric_name = 'span_count' AND metric_type = 'counter' GROUP BY hour_bucket, span_name ORDER BY hour_bucket DESC, span_count DESC" `
  -Format md
```

→ Use this to correlate throughput spikes with agent activity. A sudden drop in `span_count` may indicate a pipeline blockage; a sustained high count may indicate a runaway loop generating excessive tool calls.

### Recipe 10: Error Rates

Compute error rate by span name by comparing `span_count{status="error"}` to `span_count{status="ok"}` counter values.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "WITH ok_counts AS (SELECT json_extract(labels_json, '$.span_name') AS span_name, SUM(value) AS ok_total FROM telemetry_metrics WHERE metric_name = 'span_count' AND metric_type = 'counter' AND json_extract(labels_json, '$.status') = 'ok' GROUP BY span_name), error_counts AS (SELECT json_extract(labels_json, '$.span_name') AS span_name, SUM(value) AS error_total FROM telemetry_metrics WHERE metric_name = 'span_count' AND metric_type = 'counter' AND json_extract(labels_json, '$.status') = 'error' GROUP BY span_name) SELECT COALESCE(o.span_name, e.span_name) AS span_name, COALESCE(o.ok_total, 0) AS ok_count, COALESCE(e.error_total, 0) AS error_count, COALESCE(o.ok_total, 0) + COALESCE(e.error_total, 0) AS total, ROUND(100.0 * COALESCE(e.error_total, 0) / NULLIF(COALESCE(o.ok_total, 0) + COALESCE(e.error_total, 0), 0), 1) AS error_pct FROM ok_counts o FULL OUTER JOIN error_counts e ON o.span_name = e.span_name ORDER BY error_pct DESC" `
  -Format md
```

→ Markdown table sorted by error percentage descending. High error rates on specific span names point to adapter or tool issues — investigate further by querying the `status_message` in `telemetry_spans` for those span names.

### Recipe 11: Top-N Slowest Spans by Histogram Aggregation

Estimate total accumulated duration per span name by weighting histogram bucket counts by their midpoint value, then rank by total duration.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "WITH bucket_midpoints(bucket_le, midpoint, sort_order) AS (VALUES (1,0.5,1),(5,3,2),(10,7.5,3),(25,17.5,4),(50,37.5,5),(100,75,6),(250,175,7),(500,375,8),(1000,750,9),(2500,1750,10),(5000,3750,11),(10000,7500,12)), hist_counts AS (SELECT json_extract(labels_json, '$.span_name') AS span_name, CAST(json_extract(labels_json, '$.bucket_le') AS INTEGER) AS bucket_le, SUM(value) AS cnt FROM telemetry_metrics WHERE metric_name = 'span_duration_ms' AND metric_type = 'histogram' GROUP BY span_name, CAST(json_extract(labels_json, '$.bucket_le') AS INTEGER)) SELECT h.span_name, SUM(h.cnt * b.midpoint) AS est_total_duration_ms, SUM(h.cnt) AS span_count, ROUND(SUM(h.cnt * b.midpoint) / SUM(h.cnt), 1) AS avg_ms FROM hist_counts h JOIN bucket_midpoints b ON h.bucket_le = b.bucket_le GROUP BY h.span_name ORDER BY est_total_duration_ms DESC LIMIT 10" `
  -Format json
```

→ JSON output listing the top 10 span names by estimated total duration. Use this to identify which operations consume the most aggregate time, even if individual spans are fast — a high-count medium-latency span may dominate total runtime.

---

## Log Query Recipes

The `telemetry_logs` table stores structured log records captured from the Rust `tracing` subscriber via the LogBridgeLayer:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `timestamp` | TEXT | RFC3339 timestamp of the log event |
| `level` | TEXT | Log level: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `target` | TEXT | Module path (e.g., `fredo::infrastructure::otlp`) |
| `message` | TEXT | Formatted log message |
| `attributes_json` | TEXT | JSON object of structured key=value attributes |
| `trace_id` | TEXT | Parent span's trace_id (nullable, from active span context) |
| `span_id` | TEXT | Parent span's span_id (nullable, from active span context) |
| `session_id` | TEXT | Associated session identifier (nullable) |

### Recipe 12: Recent Error Logs

Find all ERROR-level log entries from the last hour, showing the module target and structured attributes.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT datetime(timestamp) AS time, level, target, message, attributes_json FROM telemetry_logs WHERE level = 'ERROR' AND timestamp > datetime('now', '-1 hour') ORDER BY timestamp DESC" `
  -Format md
```

→ Markdown table of recent errors. Use `attributes_json` to inspect structured context (e.g., error details, event IDs). Filter by `target` to narrow to a specific module (e.g., `WHERE target = 'fredo::infrastructure::otlp'`).

### Recipe 13: Log Count by Level

Aggregate log entry counts grouped by level over the last 24 hours.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT level, COUNT(*) AS count, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM telemetry_logs WHERE timestamp > datetime('now', '-24 hours')), 1) AS pct FROM telemetry_logs WHERE timestamp > datetime('now', '-24 hours') GROUP BY level ORDER BY CASE level WHEN 'ERROR' THEN 1 WHEN 'WARN' THEN 2 WHEN 'INFO' THEN 3 WHEN 'DEBUG' THEN 4 WHEN 'TRACE' THEN 5 END" `
  -Format md
```

→ Markdown table showing log volume distribution by severity. High ERROR or WARN counts indicate issues worth investigating. Zero DEBUG/TRACE counts when level is set to INFO is expected.

### Recipe 14: Trace-Correlated Logs

Find all log entries associated with a specific trace_id, ordered by timestamp. Use this to correlate operational logs with telemetry spans.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT datetime(timestamp) AS time, level, target, message, span_id FROM telemetry_logs WHERE trace_id = '<trace-id>' ORDER BY timestamp ASC" `
  -Format md
```

→ Replace `<trace-id>` with the actual trace ID (usually a session UUID). This provides a complete operational timeline for a specific trace — errors, warnings, and info messages that occurred during that trace's lifecycle. Join with `telemetry_spans` on `trace_id` for full correlation: `SELECT s.span_name, l.level, l.message FROM telemetry_spans s JOIN telemetry_logs l ON s.trace_id = l.trace_id WHERE s.trace_id = '<trace-id>' ORDER BY l.timestamp ASC`.

### Recipe 15: Log Timeline

View the most recent log entries in chronological order with level-based severity context.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT datetime(timestamp) AS time, level, target, message, CASE WHEN trace_id IS NOT NULL THEN substr(trace_id, 1, 8) || '...' ELSE '-' END AS trace FROM telemetry_logs ORDER BY timestamp DESC LIMIT 50" `
  -Format table
```

→ Recent log entries with trace ID preview. The `trace` column shows the first 8 characters of the trace_id (or `-` if no trace context). Use `-Format md` for GitHub issue paste. To focus on a specific module, add `WHERE target LIKE '%otlp%'`.

### Recipe 16: Error Frequency Timeline

Track error occurrence frequency over time, grouped by hour and module target.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour, target, COUNT(*) AS error_count FROM telemetry_logs WHERE level = 'ERROR' AND timestamp > datetime('now', '-7 days') GROUP BY hour, target ORDER BY hour DESC, error_count DESC" `
  -Format json
```

→ JSON output showing error frequency by hour and module. Spikes in a specific hour+target combination point to deployment issues or configuration changes. Cross-reference with `telemetry_spans` status_code='ERROR' for the same time window to correlate span failures with log errors.

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
| `telemetry_logs` table missing | `ERROR: no such table: telemetry_logs`. Ensure the Fredo application has been run at least once with logging enabled. |

---

## Test Isolation

When querying telemetry data during e2e tests, use a unique session ID prefix to separate test spans from real agent activity:

```powershell
$testSessionId = "e2e-" + (New-Guid).ToString().Substring(0, 8)
```

Then filter queries by `session_id LIKE '$testSessionId%'` to isolate test spans.
