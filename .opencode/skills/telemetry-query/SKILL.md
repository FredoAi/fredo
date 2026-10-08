---
name: telemetry-query
description: Query Fredo's telemetry store (the embedded PostgreSQL cluster) to inspect spans, diagnose errors, monitor performance, and check retention. Load when an agent needs to query telemetry data, export span data, or debug the tracing subsystem.
---

# Telemetry Query — Read-Only Interface to the PostgreSQL Store

## Related Skills

- **dev-environment**: Dev instance lifecycle (start/stop/status/restart) and process logs. Use when you need to check if the app is running, resolve the ephemeral PostgreSQL port, or debug startup issues.

## How It Works

`telemetry-query.ps1` → managed `psql` (database `postgres`) at the env's ephemeral PostgreSQL port → formatted output (JSON / markdown / table).

PostgreSQL is the **only** persistence system (Spec #3005). The telemetry subsystem stores OpenTelemetry-compatible spans in a `telemetry_spans` table inside the embedded PostgreSQL cluster — the same store used by the settings KV, the canonical RTDB `*_rows` tables, and `telemetry_metrics` / `telemetry_logs`. This skill provides a read-only query interface — no mutations, no DDL, no DML.

Span lifecycle:
- **Init** → span created with `start_time_ns`, `status_code='UNSET'`
- **Update** → span enriched with attributes (latest only — streaming deltas coalesced)
- **Response** → span closed with `status_code='OK'`, `end_time_ns` set
- **Error** → span closed with `status_code='ERROR'`, `status_message` recorded

## Connecting to the Store

The store is the managed embedded PostgreSQL cluster. It has **no fixed file path** — connect through the managed `psql` at the running cluster's loopback port:

1. **Port:** read it from the app's `pg_supervisor_status` (the `port` field). For an isolated dev env, the manifest records it as `ports.pg` (`-Manifest`).
2. **Database / user:** database `postgres`, user `postgres`, host `127.0.0.1`.
3. **Password:** the generated loopback password lives in the **OS keychain** (service `fredo.postgres`, account `loopback:password`). Supply it with `-PgPassword` (or `$env:PGPASSWORD`); the wrapper also reads `$env:FREDO_PG_PASSWORD_FILE` (first non-blank line), then the documented loopback-only fallback. The password is never printed or logged.

> **G-307:** the ephemeral port can read `0` on a stale manifest/status. When it does, a re-resolve is required — re-run `dev-env.ps1 -Action Up` (or `-Action Status`) and pass the fresh `-PgPort`. Never guess a port.

The wrapper locates the managed `psql` automatically (under the shared PostgreSQL install dir, or on `PATH`) and bounds the connect with `PGCONNECT_TIMEOUT=10`.

## Isolated Environments (Spec #2944)

An isolated dev environment runs its own PostgreSQL cluster on its own ephemeral port, recorded as `ports.pg` in that environment's process manifest `<env-root>/manifest.json`. Pass `-Manifest` to resolve `ports.pg`; never read a sibling environment's cluster.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT session_id, span_name FROM telemetry_spans" `
  -Manifest ".opencode/tmp/envs/spec3005/manifest.json"

# Equivalent with an explicit port (from pg_supervisor_status or the manifest):
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT count(*) FROM telemetry_spans" `
  -PgPort 64217
```

Always state which store (and port) produced the evidence. If `ports.pg` reads `0` (G-307), re-resolve and disclose it. If the app pool holds all server connections and `psql` is refused (`too many clients`), use the named app-pool fallback (`telemetry_get_stats` / `feature_data_read`) and disclose the substitution.

## CLI Reference

```
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "<SQL SELECT statement>" `
  [-Format json|md|table] `
  [-Limit 1000] `
  [-Manifest <env-root>/manifest.json] `
  [-PgPort <env pg port>] [-PgHost 127.0.0.1] [-PgUser postgres] [-PgDatabase postgres] [-PgPassword <pw>]
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `-Query`  | Yes      | —       | SQL SELECT query (without trailing LIMIT — appended automatically). Must be read-only. |
| `-Format` | No       | `table` | Output format: `json` (JSON array), `md` (markdown table), `table` (psql aligned table) |
| `-Limit`  | No       | `1000`  | Maximum rows returned. Appended as `LIMIT N` unless query already contains `LIMIT`. |
| `-Manifest` | No     | (empty) | Env process-manifest path (`<env-root>/manifest.json`). Resolves `ports.pg`. Explicit `-PgPort` wins. |
| `-PgPort` | No       | `0`     | PostgreSQL loopback port (G-284/G-307). `>0` selects the managed-`psql` engine. `0` ⇒ the `-Manifest` `ports.pg` when present; else a usage error (re-resolve). |
| `-PgHost` / `-PgUser` / `-PgDatabase` / `-PgPassword` | No | `127.0.0.1` / `postgres` / `postgres` / `$env:PGPASSWORD` | PostgreSQL connection fields. Password resolution: param → `$env:PGPASSWORD` → `FREDO_PG_PASSWORD_FILE` → loopback fallback. |

### Guardrails (enforced by the wrapper)

- ❌ **DDL/DML rejected**: `CREATE`, `ALTER`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY`, `VACUUM`, `REINDEX`, `CLUSTER`, `REFRESH` — the script scans the query and refuses to execute if any of these keywords appear (case-insensitive, whole-word).
- ✅ **Allowed**: queries must start with `SELECT` or `WITH` (CTE).
- ✅ **Default LIMIT**: If the query has no `LIMIT` clause, `LIMIT 1000` is appended automatically. Override with `-Limit N`.
- ✅ **Read-only mode**: the connection sets `default_transaction_read_only=on` (via `PGOPTIONS`) and `ON_ERROR_STOP=1`, so the `telemetry_spans` READ-ONLY invariant holds even if DML somehow passed the keyword check.
- ✅ **No prompt**: `psql` runs `-w` (never prompts for a password) and `PGCONNECT_TIMEOUT=10`.

---

## Query Recipes

All recipes use PostgreSQL syntax. `ingested_at` / `timestamp` are stored as RFC3339 `TEXT`; cast with `::timestamptz` for date arithmetic. `labels_json` / `attributes_json` are `TEXT`; cast with `::jsonb` for key access.

### Recipe 1: Recent Error Spans

Find all spans that ended with an error in the last hour.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT span_id, span_name, status_message, to_timestamp(start_time_ns / 1000000000.0) AS started_at, provider, transport FROM telemetry_spans WHERE status_code = 'ERROR' AND start_time_ns > (EXTRACT(EPOCH FROM now()) - 3600) * 1000000000 ORDER BY start_time_ns DESC" `
  -Format table
```

→ Use this to diagnose recent agent errors. `status_message` contains the error text from the FredoEvent.

### Recipe 2: Latency Percentiles

Compute average/min/max latency in milliseconds for completed spans.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT span_name, COUNT(*) AS count, ROUND(AVG((end_time_ns - start_time_ns) / 1000000.0)::numeric, 1) AS avg_ms, ROUND(MIN((end_time_ns - start_time_ns) / 1000000.0)::numeric, 1) AS min_ms, ROUND(MAX((end_time_ns - start_time_ns) / 1000000.0)::numeric, 1) AS max_ms FROM telemetry_spans WHERE end_time_ns IS NOT NULL GROUP BY span_name ORDER BY avg_ms DESC" `
  -Format json
```

→ JSON output for programmatic consumption. Latency metrics help identify slow agent operations.

### Recipe 3: Session Trace

Get the full trace of spans for a specific session — follow parent-child relationships.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT span_id, parent_span_id, span_name, span_kind, status_code, to_timestamp(start_time_ns / 1000000000.0) AS started_at, CASE WHEN end_time_ns IS NOT NULL THEN to_char((end_time_ns - start_time_ns) / 1000000.0, 'FM999990.0') || 'ms' ELSE 'open' END AS duration FROM telemetry_spans WHERE session_id = '<session-id>' ORDER BY start_time_ns ASC" `
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

Check how much space the telemetry tables consume, and row counts by status.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT status_code, COUNT(*) AS count, to_char(COUNT(*) * 0.001, 'FM999999.00') || ' MB (rough)' AS est_size FROM telemetry_spans GROUP BY status_code ORDER BY count DESC" `
  -Format table
```

```powershell
# Accurate on-disk size of a table (indexes included):
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT pg_total_relation_size('telemetry_spans') AS bytes, pg_size_pretty(pg_total_relation_size('telemetry_spans')) AS pretty" `
  -Format json
```

→ `pg_total_relation_size` returns the exact bytes for the table plus its indexes/toast. The `est_size` column in the first query is a rough row-count-based approximation.

### Recipe 6: Retention Status

See how old your oldest and newest spans are.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT MIN(ingested_at) AS oldest_span, MAX(ingested_at) AS newest_span, COUNT(*) AS total_spans, ROUND((EXTRACT(EPOCH FROM (now() - MIN(ingested_at)::timestamptz)) / 86400.0)::numeric, 1) AS age_days FROM telemetry_spans" `
  -Format md
```

→ Retention is configured via `tracing.retention_days` (settings KV, default 7). Spans older than this threshold are deleted on Fredo startup. If spans are unexpectedly missing, check the retention setting.

### Recipe 7: Table Schema Inspection

View the full schema and indexes of the `telemetry_spans` table.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT ordinal_position, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'telemetry_spans' ORDER BY ordinal_position" `
  -Format table
```

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'telemetry_spans'" `
  -Format table
```

→ Use `information_schema.columns` to check column names, types, and nullability. Use `pg_indexes` to verify which indexes exist.

---

## Metric Query Recipes

The `telemetry_metrics` table stores pre-aggregated metric data derived from the FredoEvent stream by the `MetricCollector` background task:

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Identity primary key |
| `metric_name` | TEXT | Metric identifier: `span_count`, `events_received`, `orphan_spans`, `active_sessions`, `span_duration_ms` |
| `metric_type` | TEXT | One of `counter` (monotonically increasing), `gauge` (snapshot value), or `histogram` (bucket count) |
| `labels_json` | TEXT | JSON dimension labels: `{"span_name":"...","status":"ok"}` for counters, `{"span_name":"...","bucket_le":"50"}` for histogram buckets |
| `value` | DOUBLE PRECISION | The aggregated metric value: counter total, gauge reading, or histogram bucket count |
| `timestamp` | TEXT | RFC3339 timestamp of the aggregation window end |
| `aggregation_window_s` | BIGINT | Aggregation interval in seconds (configurable 10–300) |

Metric data is written in batch every N seconds (default 60). All metric queries are read-only — the `telemetry-query.ps1` wrapper handles connection and guardrails automatically.

### Recipe 8: Latency Percentiles from Histogram Buckets

Compute p50, p90, and p99 latency boundaries for each span name using accumulated histogram bucket counts. Each row stores the count of spans whose duration fell within that bucket's upper-bound range.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "WITH bucket_bounds(bucket_le, sort_order) AS (VALUES (1,1),(5,2),(10,3),(25,4),(50,5),(100,6),(250,7),(500,8),(1000,9),(2500,10),(5000,11),(10000,12)), hist_counts AS (SELECT (labels_json::jsonb ->> 'span_name') AS span_name, ((labels_json::jsonb ->> 'bucket_le'))::int AS bucket_le, SUM(value) AS cnt FROM telemetry_metrics WHERE metric_name = 'span_duration_ms' AND metric_type = 'histogram' GROUP BY span_name, ((labels_json::jsonb ->> 'bucket_le'))::int), span_total AS (SELECT span_name, SUM(cnt) AS total FROM hist_counts GROUP BY span_name), cumulative AS (SELECT h.span_name, h.bucket_le AS le, h.cnt, SUM(h.cnt) OVER (PARTITION BY h.span_name ORDER BY h.bucket_le) AS cum, t.total FROM hist_counts h JOIN span_total t ON h.span_name = t.span_name) SELECT span_name, MIN(CASE WHEN cum * 100.0 / total >= 50 THEN le END) AS p50_ms, MIN(CASE WHEN cum * 100.0 / total >= 90 THEN le END) AS p90_ms, MIN(CASE WHEN cum * 100.0 / total >= 99 THEN le END) AS p99_ms, MAX(total) AS span_count FROM cumulative GROUP BY span_name ORDER BY span_name" `
  -Format json
```

→ JSON output for programmatic consumption. Latency percentiles reveal the distribution tail — if p99 is much higher than p50, there are sporadic slow operations worth investigating alongside the span traces.

### Recipe 9: Throughput Over Time

Aggregate `span_count` counter values by hourly windows to visualize throughput trends for each span name.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT to_char(date_trunc('hour', timestamp::timestamptz), 'YYYY-MM-DD\"T\"HH24:00:00\"Z\"') AS hour_bucket, (labels_json::jsonb ->> 'span_name') AS span_name, SUM(value) AS span_count FROM telemetry_metrics WHERE metric_name = 'span_count' AND metric_type = 'counter' GROUP BY hour_bucket, span_name ORDER BY hour_bucket DESC, span_count DESC" `
  -Format md
```

→ Use this to correlate throughput spikes with agent activity. A sudden drop in `span_count` may indicate a pipeline blockage; a sustained high count may indicate a runaway loop generating excessive tool calls.

### Recipe 10: Error Rates

Compute error rate by span name by comparing `span_count{status="error"}` to `span_count{status="ok"}` counter values.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "WITH ok_counts AS (SELECT (labels_json::jsonb ->> 'span_name') AS span_name, SUM(value) AS ok_total FROM telemetry_metrics WHERE metric_name = 'span_count' AND metric_type = 'counter' AND (labels_json::jsonb ->> 'status') = 'ok' GROUP BY span_name), error_counts AS (SELECT (labels_json::jsonb ->> 'span_name') AS span_name, SUM(value) AS error_total FROM telemetry_metrics WHERE metric_name = 'span_count' AND metric_type = 'counter' AND (labels_json::jsonb ->> 'status') = 'error' GROUP BY span_name) SELECT COALESCE(o.span_name, e.span_name) AS span_name, COALESCE(o.ok_total, 0) AS ok_count, COALESCE(e.error_total, 0) AS error_count, COALESCE(o.ok_total, 0) + COALESCE(e.error_total, 0) AS total, ROUND((100.0 * COALESCE(e.error_total, 0) / NULLIF(COALESCE(o.ok_total, 0) + COALESCE(e.error_total, 0), 0))::numeric, 1) AS error_pct FROM ok_counts o FULL OUTER JOIN error_counts e ON o.span_name = e.span_name ORDER BY error_pct DESC" `
  -Format md
```

→ Markdown table sorted by error percentage descending. High error rates on specific span names point to adapter or tool issues — investigate further by querying the `status_message` in `telemetry_spans` for those span names.

### Recipe 11: Top-N Slowest Spans by Histogram Aggregation

Estimate total accumulated duration per span name by weighting histogram bucket counts by their midpoint value, then rank by total duration.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "WITH bucket_midpoints(bucket_le, midpoint, sort_order) AS (VALUES (1,0.5,1),(5,3,2),(10,7.5,3),(25,17.5,4),(50,37.5,5),(100,75,6),(250,175,7),(500,375,8),(1000,750,9),(2500,1750,10),(5000,3750,11),(10000,7500,12)), hist_counts AS (SELECT (labels_json::jsonb ->> 'span_name') AS span_name, ((labels_json::jsonb ->> 'bucket_le'))::int AS bucket_le, SUM(value) AS cnt FROM telemetry_metrics WHERE metric_name = 'span_duration_ms' AND metric_type = 'histogram' GROUP BY span_name, ((labels_json::jsonb ->> 'bucket_le'))::int) SELECT h.span_name, SUM(h.cnt * b.midpoint) AS est_total_duration_ms, SUM(h.cnt) AS span_count, ROUND((SUM(h.cnt * b.midpoint) / SUM(h.cnt))::numeric, 1) AS avg_ms FROM hist_counts h JOIN bucket_midpoints b ON h.bucket_le = b.bucket_le GROUP BY h.span_name ORDER BY est_total_duration_ms DESC LIMIT 10" `
  -Format json
```

→ JSON output listing the top 10 span names by estimated total duration. Use this to identify which operations consume the most aggregate time, even if individual spans are fast — a high-count medium-latency span may dominate total runtime.

---

## Log Query Recipes

The `telemetry_logs` table stores structured log records captured from the Rust `tracing` subscriber via the LogBridgeLayer:

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Identity primary key |
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
  -Query "SELECT timestamp, level, target, message, attributes_json FROM telemetry_logs WHERE level = 'ERROR' AND timestamp::timestamptz > now() - interval '1 hour' ORDER BY timestamp DESC" `
  -Format md
```

→ Markdown table of recent errors. Use `attributes_json` to inspect structured context (e.g., error details, event IDs). Filter by `target` to narrow to a specific module (e.g., `WHERE target = 'fredo::infrastructure::otlp'`).

### Recipe 13: Log Count by Level

Aggregate log entry counts grouped by level over the last 24 hours.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT level, COUNT(*) AS count, ROUND((100.0 * COUNT(*) / (SELECT COUNT(*) FROM telemetry_logs WHERE timestamp::timestamptz > now() - interval '24 hours'))::numeric, 1) AS pct FROM telemetry_logs WHERE timestamp::timestamptz > now() - interval '24 hours' GROUP BY level ORDER BY CASE level WHEN 'ERROR' THEN 1 WHEN 'WARN' THEN 2 WHEN 'INFO' THEN 3 WHEN 'DEBUG' THEN 4 WHEN 'TRACE' THEN 5 END" `
  -Format md
```

→ Markdown table showing log volume distribution by severity. High ERROR or WARN counts indicate issues worth investigating. Zero DEBUG/TRACE counts when level is set to INFO is expected.

### Recipe 14: Trace-Correlated Logs

Find all log entries associated with a specific trace_id, ordered by timestamp. Use this to correlate operational logs with telemetry spans.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT timestamp, level, target, message, span_id FROM telemetry_logs WHERE trace_id = '<trace-id>' ORDER BY timestamp ASC" `
  -Format md
```

→ Replace `<trace-id>` with the actual trace ID (usually a session UUID). This provides a complete operational timeline for a specific trace — errors, warnings, and info messages that occurred during that trace's lifecycle. Join with `telemetry_spans` on `trace_id` for full correlation: `SELECT s.span_name, l.level, l.message FROM telemetry_spans s JOIN telemetry_logs l ON s.trace_id = l.trace_id WHERE s.trace_id = '<trace-id>' ORDER BY l.timestamp ASC`.

### Recipe 15: Log Timeline

View the most recent log entries in chronological order with level-based severity context.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT timestamp, level, target, message, CASE WHEN trace_id IS NOT NULL THEN substr(trace_id, 1, 8) || '...' ELSE '-' END AS trace FROM telemetry_logs ORDER BY timestamp DESC LIMIT 50" `
  -Format table
```

→ Recent log entries with trace ID preview. The `trace` column shows the first 8 characters of the trace_id (or `-` if no trace context). Use `-Format md` for GitHub issue paste. To focus on a specific module, add `WHERE target LIKE '%otlp%'`.

### Recipe 16: Error Frequency Timeline

Track error occurrence frequency over time, grouped by hour and module target.

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
  -Query "SELECT to_char(date_trunc('hour', timestamp::timestamptz), 'YYYY-MM-DD\"T\"HH24:00:00\"Z\"') AS hour, target, COUNT(*) AS error_count FROM telemetry_logs WHERE level = 'ERROR' AND timestamp::timestamptz > now() - interval '7 days' GROUP BY hour, target ORDER BY hour DESC, error_count DESC" `
  -Format json
```

→ JSON output showing error frequency by hour and module. Spikes in a specific hour+target combination point to deployment issues or configuration changes. Cross-reference with `telemetry_spans` status_code='ERROR' for the same time window to correlate span failures with log errors.

---

## Output Formats

### JSON (`-Format json`)

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

A JSON array built from `psql --csv` output. Each object's keys match the column names in the SELECT statement. Useful for programmatic consumption by the agent.

### Markdown (`-Format md`)

```
| span_id | span_name | status_code | duration_ms |
|---------|-----------|-------------|-------------|
| abc-123 | tool_use.Bash | OK | 45.2 |
| def-456 | chat.assistant | OK | 120.0 |
```

The wrapper post-processes `psql --csv` output into a GitHub-flavored markdown table with aligned columns. Best for pasting into GitHub issue comments and PR reviews.

### Table (`-Format table`)

```
 span_id |   span_name    | status_code | duration
---------+----------------+-------------+----------
 abc-123 | tool_use.Bash  | OK          | 45.2ms
 def-456 | chat.assistant | OK          | 120.0ms
```

Raw `psql` aligned output (`-P pager=off`). Best for quick terminal inspection.

---

## Error Handling

The wrapper script provides clear error messages for common failure modes:

| Condition | Error Message |
|-----------|---------------|
| `psql` not found | `ERROR: psql CLI not found (managed embedded PostgreSQL or PATH).` |
| PG port unresolved (`0`) | `ERROR: PostgreSQL port unresolved (0). Re-resolve it (G-307): read pg_supervisor_status, or re-run dev-env.ps1 -Action Up / Status, then pass the fresh -PgPort ...` |
| Env manifest missing/invalid | `ERROR: env manifest not found: <path>` / `ERROR: env manifest is not valid JSON: <path>` (`-Manifest` only) |
| DDL/DML in query | `ERROR: Query rejected: contains forbidden keyword: <keyword>. Only SELECT and WITH permitted.` |
| Query execution failure | `ERROR: PostgreSQL query failed (exit code <n>).` |
| `telemetry_logs` table missing | `ERROR: relation "telemetry_logs" does not exist`. Ensure the Fredo application has been run at least once with logging enabled. |

---

## Test Isolation

When querying telemetry data during e2e tests, use a unique session ID prefix to separate test spans from real agent activity:

```powershell
$testSessionId = "e2e-" + (New-Guid).ToString().Substring(0, 8)
```

Then filter queries by `session_id LIKE '$testSessionId%'` to isolate test spans.
