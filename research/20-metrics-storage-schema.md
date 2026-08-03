# Research Report: Metrics Storage & Event Schema

**Agent:** Research Analyst (storage/schema)
**Date:** 2026-08-02

---

## Executive Summary (Top 8 Findings)

1. **JSONL is the canonical format for append-only event/telemetry logs.** JSON Lines: UTF-8, one valid JSON object per line, `\n` terminator. "A great format for log files" that "may be processed one record at a time" and works with shell pipelines and stream compression.
2. **Newline-delimited JSON beats a single JSON array.** A single array requires rewriting/truncating to append, can't be tailed, and one malformed byte invalidates the whole file. Newline-delimited is purely additive.
3. **The standard observability event shape separates named top-level fields from a flexible attribute map.** OTel log model: `Timestamp`, `EventName`, `Severity`, `Body`, `Attributes`. ECS adds query-critical fields: `@timestamp`, `event.id`, `event.action`, `event.outcome`, `event.duration`, `event.sequence`, `event.created`/`ingested`.
4. **Store raw events and derive metrics — this is exactly the event-sourcing model.** The log enables *complete rebuild*, *temporal query*, and *event replay*. Aggregates/read models are "purely derivable from the event log" and are caches, not the system of record.
5. **DORA-style delivery metrics are derived from timestamps, not stored as aggregates.** Cycle time for an issue = terminal-event ts − first-event ts.
6. **For this scale (dozens of issues, local, low writer concurrency), SQLite's own guidance is "otherwise → choose SQLite," but it competes with `fopen()`, not with JSONL.** JSONL is a *log format*; SQLite is a *query store*. JSONL is enough at your scale; SQLite is the fallback if scans get slow.
7. **Pre-aggregating metrics keyed by high-cardinality dimensions is a known lossy trap.** OTel SDKs enforce a cardinality limit and fold overflow into `otel.metric.overflow`, silently dropping the attributes any query would filter on. Store raw events; aggregate at query time.
8. **Timestamps must carry a UTC offset; naive local times are an anti-pattern.** RFC 3339 requires an offset; unqualified local time "will fail in approximately 23/24 of the globe."

---

## JSONL vs Single JSON Array vs SQLite

| Dimension | JSONL (per issue) | Single JSON array | SQLite |
|---|---|---|---|
| Append cost | O(1) | O(n) rewrite | O(1) row insert |
| Streaming/tailing | Yes | No | No native tail |
| Corruption isolation | One bad line skippable | One bad byte kills file | Atomic |
| Schema evolution | Additive, no migration | painful | migrations |
| Querying | grep/jq one pass | full parse | SQL GROUP BY |
| Concurrency | Safe if one writer per file | unsafe | single writer, fine |
| Rotation | trivial per issue | awkward | DELETE by predicate |
| Scale fit | fine to millions of lines | poor | up to 281 TB |
| Re-derivability | excellent | same, fragile | good |
| Human readability | excellent | poor for append logs | needs client |

**Verdict:** JSONL wins for the write side (append log); SQLite wins for the read side (ad-hoc grouping). Recommended: JSONL as append log + on-demand derivation, SQLite as a drop-in derived query layer if scans ever get slow.

---

## Recommended Event Schema

| Field | Type | Required | Description |
|---|---|---|---|
| `ts` | string RFC 3339 UTC | yes | time the event occurred |
| `recordedAt` | string | no | time observed/written (lag detection) |
| `eventId` | string UUID | yes | unique id |
| `eventName` | string enum | yes | `state_machine.call`, `phase.started`, `phase.completed`, `step.failed`, `issue.completed` |
| `kind` | string enum | yes | `event` / `metric` / `state` |
| `actor` | string | yes | agent name |
| `entity` | object | yes | `{ issueId, repo?, project? }` |
| `phase` | string | yes | pipeline phase |
| `outcome` | string enum | yes | `success` / `failure` / `unknown` |
| `attempt` | integer ≥1 | yes | retry ordinal |
| `durationMs` | integer | on terminal | end − start; also store `startTs`/`endTs` |
| `correlationId` | string | yes | trace id linking all events of one work item |
| `parentEventId` | string | no | parent span/attempt id |
| `sequence` | integer | on ties | monotonic per-file counter |
| `attributes` | object | no | typed key-values: `tokensUsed`, `exitCode`, `errorType`, `model` |
| `message` | string | no | human-readable summary |

**Example line:**
```json
{"ts":"2026-08-02T12:34:56.789Z","recordedAt":"2026-08-02T12:34:56.790Z","eventId":"f3b2…","eventName":"phase.completed","kind":"event","actor":"opencode","entity":{"issueId":"ISS-42","repo":"fredo"},"phase":"architect","outcome":"success","attempt":1,"durationMs":84312,"correlationId":"tr_9f1c…","parentEventId":null,"sequence":17,"attributes":{"tokensUsed":12400,"model":"deepseek-v4-flash"},"message":"Architect phase completed in 84.3s"}
```

**Naming rules:** identical field names across every emitter (state machine owns the schema); units in names (`durationMs`, `tokensUsed`); typed values.

---

## Raw-Events + Derive vs Maintained Aggregate

**Store raw events as the system of record; derive all metrics from the log. Optionally cache a per-issue snapshot.**

- Fowler: aggregates "purely derivable from the event log"; the log gives complete rebuild, temporal query, event replay.
- OTel cardinality: pre-aggregated metrics lose breakdown by high-cardinality dimensions.
- DORA metrics are by definition computed from timestamps on events.

**Recommended hybrid:** raw JSONL events (truth) + one maintained per-issue snapshot JSON (the event-sourcing "application state" cache) updated transactionally *after* appending the event. The snapshot gives instant last-known state; it is validated/rebuilt from the log on demand. Never authoritative over the log.

---

## Per-Issue File vs Global Log

**One JSONL file per issue** (`metrics/<issueId>.jsonl`), written by the state machine.
- **Concurrency safety:** Lumberjack "assumes that only one process is writing to the output files." A global file shared by N concurrent agents needs locking; a per-issue file is single-writer by construction.
- **Retention:** close an issue → gzip/archive/delete its file independently.
- **Cross-issue queries:** scanning many small files is trivially fast at dozens of issues.
- **Global log's advantage** (single chronological stream) is preserved for debugging by a small indexing step, and isn't worth write-contention risk.

---

## On-Demand vs Incremental Aggregation

**On-demand aggregation, with an optional per-issue incremental snapshot as a cache.**
- For dozens of issues, a full scan at report time is microseconds-to-milliseconds. Simplest and most robust: no drift, nothing to reconcile.
- Incremental aggregates only add value when the read path is hot or the corpus is large — and if added, keep as *derived* caches rebuilt from the log.
- Pre-aggregating is where the OTel cardinality trap lives: don't bake `actor × issue × phase` totals at write time.

---

## Anti-Patterns Checklist

1. Timestamps without timezone — always RFC 3339 UTC
2. Single JSON array as append log
3. Unbounded growth / no rotation (size + age + count + gzip, or delete per-issue on close)
4. Lossy pre-aggregation (no raw events → can't re-slice)
5. Events that can't be re-derived / replayable (record delta-form data)
6. Schema drift (one schema owned by state machine; add additively)
7. Bloated events (identifiers + small typed attributes; units in field names)
8. Missing correlation (every event carries `entity.issueId` + `correlationId`)
9. Ambiguous ordering (sequence counter on ties)
10. Rewriting/mutating history (append-only)
11. Multiple writers to one file (one writer per file)

---

## Concrete Recommendation (numbered)

1. **Format:** JSONL (UTF-8, one JSON object per line, `\n`).
2. **Partitioning:** one file per issue — `metrics/<issueId>.jsonl` — appended by the state machine (single writer per file, append-only). Never a global file written by N agents; never a single JSON array.
3. **Event schema:** `ts` (RFC 3339 UTC), `eventId` (UUID), `eventName`, `kind`, `actor`, `entity.issueId`, `phase`, `outcome`, `attempt`, `durationMs` + `startTs`/`endTs` on terminal events, `correlationId`, `parentEventId`, `sequence`, `attributes`, `message`.
4. **Every state-machine call appends one event.** Additionally emit explicit `phase.started` and `phase.completed` events so phase durations come from paired timestamps, not inferred call gaps.
5. **Derive, don't store, the metrics** by scanning per-issue files on demand.
6. **Snapshot cache (optional):** per-issue state document updated atomically after each append, as an event-sourcing cache; never the source of truth.
7. **Aggregation timing:** on-demand for cross-issue reports; incremental only as a derived cache.
8. **Rotation/retention:** rotate by size/age, gzip completed, delete on close.
9. **SQLite as the escape hatch, not the starting point:** import into SQLite if query complexity/frequency grows; JSONL stays the system of record.
10. **Governance:** the state machine owns and versioned-schema-emits every event; add fields additively; never mutate or rewrite history.

---

## Source List

- JSON Lines — https://jsonlines.org/
- NDJSON spec — https://github.com/ndjson/ndjson-spec
- Martin Fowler, Event Sourcing — https://martinfowler.com/eaaDev/EventSourcing.html
- OTel Logs Data Model — https://opentelemetry.io/docs/specs/otel/logs/data-model/
- OTel Metrics (cardinality) — https://opentelemetry.io/docs/concepts/signals/metrics/
- ECS Event fields — https://www.elastic.co/docs/reference/ecs/ecs-event
- SQLite appropriate uses — https://www.sqlite.org/whentouse.html
- Twelve-Factor Logs — https://12factor.net/logs
- DORA metrics — https://dora.dev/guides/dora-metrics-four-keys/
- Lumberjack (rotation, single-writer) — https://github.com/natefinch/lumberjack
- Better Stack JSON logging — https://betterstack.com/community/guides/logging/json-logging/
- RFC 3339 — https://www.rfc-editor.org/rfc/rfc3339
