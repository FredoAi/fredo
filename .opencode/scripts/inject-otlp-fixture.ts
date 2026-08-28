/**
 * #2762 D2 — FIX-ORPHAN OTLP fixture injector (pipeline tooling, NOT product code).
 *
 * Injects COMPLETED `fredo.tool.read` tool_use spans for FAKE child sessions
 * straight into the OTLP gRPC receiver (default 127.0.0.1:4317), so Mission
 * Monitor's `⚠ N unattributed` chip can be exercised deterministically (QA-6).
 *
 * Span shape mirrors REAL `telemetry_spans` rows (AGENTS.md mock-vs-real rule)
 * plus the subagent marker:
 *   - `session.id`                = the fake child session id (adapter derives
 *                                   sessionId from `session.id` — otlp.rs:65,302)
 *   - `gen_ai.operation.name`     = "execute_tool"  → op `tool.read`, event_type
 *                                   `tool_use` (otlp.rs:825-836,108)
 *   - `gen_ai.tool.name`          = "read"
 *   - `is_subagent` = true, `agent.type` = "subagent"  → payload marker
 *                                   injected (otlp.rs:444,570-575); the R-2
 *                                   guard passes → delivered under
 *                                   `subagent-tool-activity`
 *   - `gen_ai.conversation.id`    = the same fake session id
 *   - `agent`                     = "fixture-orphan"
 *   - completed span (start + end ns) → the adapter emits Init + Response so
 *                                   `completeWhen state === 'Response'` fires
 *                                   (otlp.rs:654)
 *   - deliberately NO `session.parent_id` / span link → no ECE relationship
 *                                   registration, no re-keying; the delivery
 *                                   deterministically keys under the fake
 *                                   child session id.
 *
 * Export discipline (fix round 3 — receipt determinism): each span is exported
 * in its OWN gRPC Export call (one sequential export per session), never as a
 * multi-span `ScopeSpans`. The receiver provably persists EVERY span of an
 * Export — only a `span_id` PRIMARY-KEY collision is silently ignored — so a
 * single-span envelope removes the multi-span encoding/decoding variable
 * entirely, and the receipt prints each span's `span_id` hex next to the trace
 * hex so rows can be matched by PRIMARY KEY unambiguously.
 *
 * Tester gate note: `status_code = 'UNSET'` in telemetry_spans is EXPECTED and
 * NOT a failure — this script sets no Status and raw.rs maps absent status →
 * UNSET. The adapter derives EventState from `endTimeUnixNano` presence and
 * this script sets end > start, so Init + Response both fire. Gate on
 * `end_time_ns IS NOT NULL`, never on status.
 *
 * Receipt discipline (fix round 4 — self-contained receipts): after exporting,
 * the script prints (i) the exact CONFIRM SQL per session with the trace hex
 * (32-hex) AND span hex (16-hex) embedded, and (ii) the instruction to capture
 * the receiver-log pair (`gRPC export received` / `raw OTLP spans persisted`)
 * from `telemetry_logs` IMMEDIATELY. Prior rounds recorded the trace hex under
 * a span-id label; matching BOTH ids in one query decides that conflation
 * mechanically. No behavior change to the export path.
 *
 * Receiver-key + transport hardening (fix round 5): the round-4 QA-6 gate
 * filtered `telemetry_spans` strictly on `session_id LIKE 'ses_orphan2762%'`,
 * but the receiver DERIVES session_id — resolution order `session.id` attr →
 * `gen_ai.conversation.id` → trace hex → "unknown" (raw.rs:90-115) — from the
 * MERGED resource + span attributes. Accordingly this script now:
 *   1. carries the session id under `session.id` in BOTH the Resource
 *      attributes AND the span attributes (belt-and-suspenders; the merged
 *      lookup sees either layer, duplication is harmless);
 *   2. prints the session id embedded per span next to the trace/span hexes
 *      AND the per-export gRPC outcome (a silent transport failure is
 *      impossible to miss);
 *   3. prints the round-5 IDENTITY PROBE SQL — `span_id IN (...) OR
 *      trace_id IN (...) OR attributes_json LIKE '%<prefix>%'` — which
 *      decides under ANY derived session_id (fix plan R1), alongside the
 *      per-session CONFIRM SQL.
 * Per-span sequential exports stay unchanged (fix round 3).
 *
 * Usage (tester allowlist runs this via `bun`):
 *   bun .opencode/scripts/inject-otlp-fixture.ts --count 2 --prefix ses_orphan2762
 *
 * Params:
 *   --count N    number of fake child sessions to inject (default 2)
 *   --prefix ID  base id; session ids are `<prefix>-1 .. <prefix>-N`
 *                (default ses_orphan2762)
 *   --port N     OTLP gRPC port (default 4317)
 *
 * Dependency-free — stdlib only. Speaks cleartext h2c via `node:http2`
 * (available in Bun) and hand-encodes the `ExportTraceServiceRequest`
 * protobuf wrapped in a gRPC length-prefixed frame.
 */

import http2 from 'node:http2'
import { randomBytes } from 'node:crypto'

// ── CLI params ────────────────────────────────────────────────────────────────

let count = 2
let prefix = 'ses_orphan2762'
let port = 4317

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--count') count = Number(argv[++i])
  else if (argv[i] === '--prefix') prefix = argv[++i]
  else if (argv[i] === '--port') port = Number(argv[++i])
  else {
    console.error(`Unknown argument: ${argv[i]}`)
    process.exit(1)
  }
}
if (!Number.isInteger(count) || count < 1) {
  console.error('--count must be a positive integer')
  process.exit(1)
}
if (!prefix) {
  console.error('--prefix must be a non-empty string')
  process.exit(1)
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port must be a valid port number')
  process.exit(1)
}

// ── Hand-encoded protobuf (ExportTraceServiceRequest) ────────────────────────
// wire types: 0 = varint, 1 = 64-bit, 2 = length-delimited

function pbKey(field: number, wireType: number): number {
  return (field << 3) | wireType
}

function pbVarint(field: number, value: number): number[] {
  const out: number[] = [pbKey(field, 0)]
  let v = value
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}

function pbBool(field: number, value: boolean): number[] {
  return pbVarint(field, value ? 1 : 0)
}

function pbFixed64(field: number, value: bigint): number[] {
  const out: number[] = [pbKey(field, 1)]
  let v = value
  for (let i = 0; i < 8; i++) {
    out.push(Number(v & 0xffn))
    v >>= 8n
  }
  return out
}

function pbBytes(field: number, data: ArrayLike<number>): number[] {
  const out: number[] = [pbKey(field, 2)]
  const len = data.length
  let v = len
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  for (let i = 0; i < len; i++) out.push(data[i])
  return out
}

function pbString(field: number, value: string): number[] {
  return pbBytes(field, Buffer.from(value, 'utf8'))
}

/** Length-delimited nested message. */
function pbMessage(field: number, payload: number[]): number[] {
  return pbBytes(field, payload)
}

/** AnyValue { string_value = 1 } */
function anyValueString(value: string): number[] {
  return pbString(1, value)
}

/** AnyValue { bool_value = 2 } */
function anyValueBool(value: boolean): number[] {
  return pbBool(2, value)
}

/** KeyValue { key = 1 (string), value = 2 (AnyValue) } */
function keyValue(key: string, value: number[]): number[] {
  return [...pbString(1, key), ...pbMessage(2, value)]
}

// ── Span assembly ─────────────────────────────────────────────────────────────

interface InjectedSession {
  sessionId: string
  traceId: Uint8Array
  spanId: Uint8Array
}

function buildSpanMessage(session: InjectedSession): number[] {
  const now = BigInt(Date.now()) * 1_000_000n // ms → ns
  const startNs = now
  const endNs = now + 1_000_000n // completed: end > start (1ms span)

  // Span attributes — mirror REAL telemetry_spans rows (see header comment).
  const attributes: number[] = [
    ...keyValue('session.id', anyValueString(session.sessionId)),
    ...keyValue('gen_ai.operation.name', anyValueString('execute_tool')),
    ...keyValue('gen_ai.tool.name', anyValueString('read')),
    ...keyValue('is_subagent', anyValueBool(true)),
    ...keyValue('agent.type', anyValueString('subagent')),
    ...keyValue('gen_ai.conversation.id', anyValueString(session.sessionId)),
    ...keyValue('agent', anyValueString('fixture-orphan')),
    // NOTE: deliberately NO `session.parent_id` → no ECE relationship.
  ]

  // Span {
  //   bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4 (ABSENT);
  //   string name = 5; SpanKind kind = 6; fixed64 start_time_unix_nano = 7;
  //   fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9;
  // }
  return [
    ...pbBytes(1, session.traceId),
    ...pbBytes(2, session.spanId),
    ...pbString(5, 'fredo.tool.read'),
    ...pbVarint(6, 1), // SPAN_KIND_INTERNAL
    ...pbFixed64(7, startNs),
    ...pbFixed64(8, endNs),
    // FIX round 7 (FIX-B): a repeated message field needs ONE tag+length per
    // element. Collapsing all KeyValues into a single length-delimited record
    // decodes as ONE KeyValue (last key wins) — silently destroying session.id,
    // is_subagent, gen_ai.* and falling session_id back to the trace hex.
    ...attributes.flatMap((a) => pbMessage(9, a)),
  ]
}

function buildResourceKeyValue(session: InjectedSession): number[] {
  // ONE KeyValue (the payload of Resource.attributes — see buildResource).
  // Fix round 5: the receiver merges resource + span attributes (span wins on
  // key conflicts, raw.rs:80-84) and resolves session_id from `session.id`
  // FIRST (raw.rs:91). Carry the key in BOTH layers — belt-and-suspenders,
  // harmless duplication — so the persisted session_id can never silently
  // fall back to the trace hex because one layer was absent.
  return keyValue('session.id', anyValueString(session.sessionId))
}

function buildResource(session: InjectedSession): number[] {
  // FIX round 7 (FIX-A): ResourceSpans.resource (field 1) must hold a full
  // Resource message — Resource { repeated KeyValue attributes = 1 }. The
  // round-5 code wrote the bare KeyValue HERE (one nesting level short),
  // which tonic/prost decodes as Resource.attributes → one LEN=10 element of
  // raw ASCII "session.id" → invalid wire type → DecodeError. The request is
  // rejected BEFORE the receiver's handler runs: no log pair, no insert, and
  // (with the old hardcoded receipt) a printed "OK (grpc-status 0)".
  return pbMessage(1, buildResourceKeyValue(session))
}

function buildExportRequest(session: InjectedSession): number[] {
  // ScopeSpans { repeated Span spans = 2 }  (scope = 1 omitted — optional)
  // ONE span per export (fix round 3): a single-span ScopeSpans removes the
  // multi-span envelope/decoding variable — the receiver persists every span
  // of an Export unless the span_id PRIMARY KEY collides.
  const scopeSpans = pbMessage(2, buildSpanMessage(session))
  // ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2 }
  const resourceSpans = [
    ...pbMessage(1, buildResource(session)),
    ...pbMessage(2, scopeSpans),
  ]
  // ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1 }
  return pbMessage(1, resourceSpans)
}

// ── gRPC transport (cleartext h2c) ────────────────────────────────────────────

// Fix round 5: every export resolves with an explicit outcome instead of
// rejecting — the caller prints a status line per export, so a silent
// transport failure is impossible to miss.
interface ExportResult {
  ok: boolean
  status?: string
  error?: string
}

function exportViaGrpc(portNum: number, message: number[]): Promise<ExportResult> {
  return new Promise((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${portNum}`)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (result: ExportResult) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try {
        client.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const fail = (err: Error) => settle({ ok: false, error: err.message })

    client.on('error', (err) => {
      fail(err)
    })

    // gRPC length-prefixed frame: 1-byte compressed flag (0) + 4-byte BE length.
    const frame = Buffer.alloc(5 + message.length)
    frame[0] = 0
    frame.writeUInt32BE(message.length, 1)
    for (let i = 0; i < message.length; i++) frame[5 + i] = message[i]

    const stream = client.request({
      ':method': 'POST',
      ':path': '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
      'content-type': 'application/grpc',
      te: 'trailers',
    })
    stream.on('error', (err) => {
      fail(err)
    })

    timer = setTimeout(() => {
      try {
        stream.close()
      } catch {
        // already closed
      }
      fail(new Error(`timeout exporting to 127.0.0.1:${portNum} — is the OTLP gRPC receiver up?`))
    }, 5000)

    let observedStatus: string | undefined
    stream.on('response', (headers) => {
      if (headers[':status'] !== 200) {
        fail(new Error(`unexpected HTTP status ${headers[':status']}`))
        return
      }
      // FIX round 7 (FIX-C): trailers-only gRPC responses — EVERY server-side
      // rejection (invalid protobuf, unknown method, resource exhausted) —
      // carry grpc-status in the RESPONSE HEADERS with no DATA frame and no
      // second HEADERS frame. Node http2 fires 'trailers' only for that second
      // HEADERS frame, so rejections never reached the old check and resolved
      // as a false OK. Read the header status here.
      const headerStatus = headers['grpc-status']
      if (headerStatus !== undefined) {
        observedStatus = String(headerStatus)
        if (headerStatus !== '0') {
          fail(new Error(`grpc-status ${headerStatus}: ${String(headers['grpc-message'] ?? '')}`))
        } else {
          settle({ ok: true, status: observedStatus }) // trailers-only success
        }
      }
    })
    stream.on('trailers', (trailers) => {
      const status = trailers['grpc-status']
      if (status !== undefined) {
        observedStatus = String(status)
        if (status !== '0') {
          fail(new Error(`grpc-status ${status}: ${String(trailers['grpc-message'] ?? '')}`))
        } else {
          settle({ ok: true, status: observedStatus })
        }
      }
    })
    // Drain response body (framed empty ExportResponse), then finish.
    stream.on('data', () => {})
    stream.on('end', () => {
      settle({ ok: true, status: observedStatus ?? 'unknown' })
    })
    stream.end(frame)
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sessions: InjectedSession[] = []
  for (let i = 1; i <= count; i++) {
    sessions.push({
      sessionId: `${prefix}-${i}`,
      // Random valid ids per span: trace_id 16 bytes, span_id 8 bytes.
      traceId: randomBytes(16),
      spanId: randomBytes(8),
    })
  }

  // ONE sequential gRPC export PER SPAN (fix round 3): each span travels in
  // its own single-span ExportTraceServiceRequest, so a missing row can only
  // be a span_id PRIMARY-KEY collision — never multi-span envelope decoding.
  // Fix round 5: print the per-export gRPC outcome (session id + trace/span
  // hexes + OK/FAILED) — a silent transport failure is impossible to miss.
  let exportFailures = 0
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    const traceHex = Buffer.from(s.traceId).toString('hex')
    const spanHex = Buffer.from(s.spanId).toString('hex')
    const result = await exportViaGrpc(port, buildExportRequest(s))
    if (result.ok) {
      // FIX round 7 (FIX-C): print the OBSERVED wire status — never a
      // hardcoded grpc-status 0. An 'unknown' status means neither the
      // response headers nor trailers carried one (investigate before
      // trusting the receipt).
      console.log(`EXPORT ${i + 1}/${count} session=${s.sessionId} trace=${traceHex} span=${spanHex} -> OK (grpc-status ${result.status ?? 'unknown'})`)
    } else {
      exportFailures++
      console.log(`EXPORT ${i + 1}/${count} session=${s.sessionId} trace=${traceHex} span=${spanHex} -> FAILED: ${result.error ?? 'unknown error'}`)
    }
  }

  for (const s of sessions) {
    const traceHex = Buffer.from(s.traceId).toString('hex')
    const spanHex = Buffer.from(s.spanId).toString('hex')
    console.log(`Injected session id: ${s.sessionId} (span fredo.tool.read, trace_id ${traceHex}, span_id ${spanHex})`)
  }
  console.log(`Done — ${count} orphan-fixture span(s) exported to 127.0.0.1:${port} (one gRPC Export per span)`)
  console.log(`Gate note: status_code 'UNSET' in telemetry_spans is EXPECTED (no Status set; raw.rs maps absent status → UNSET) — gate on end_time_ns IS NOT NULL, not on status.`)

  // Receipt self-containment (fix round 4): print the exact CONFIRM SQL per
  // session with BOTH hex ids embedded, plus the receiver-log capture
  // instruction — the tester can cross-check rows by PRIMARY KEY without
  // reconstructing the query (and a trace/span label conflation becomes
  // mechanically visible).
  for (const s of sessions) {
    const traceHex = Buffer.from(s.traceId).toString('hex')
    const spanHex = Buffer.from(s.spanId).toString('hex')
    console.log(`CONFIRM ${s.sessionId}: sqlite3 -readonly "$env:APPDATA\\com.fredo.app\\fredo.db" "SELECT session_id, span_name, trace_id, span_id, status_code, end_time_ns FROM telemetry_spans WHERE session_id = '${s.sessionId}' AND trace_id = '${traceHex}' AND span_id = '${spanHex}';"`)
  }

  // Identity probe (fix round 5, plan R1): the session filter alone is NOT
  // authoritative — the receiver DERIVES session_id (session.id attr →
  // gen_ai.conversation.id → trace hex → "unknown", raw.rs:90-115). This
  // probe bypasses the derived column entirely and decides under ANY
  // session_id derivation (or attrs-only persistence).
  const spanList = sessions.map((s) => `'${Buffer.from(s.spanId).toString('hex')}'`).join(', ')
  const traceList = sessions.map((s) => `'${Buffer.from(s.traceId).toString('hex')}'`).join(', ')
  console.log(`IDENTITY PROBE (decides under ANY derived session_id — copy-paste): sqlite3 -readonly "$env:APPDATA\\com.fredo.app\\fredo.db" "SELECT span_id, trace_id, session_id, span_name, transport, end_time_ns, ingested_at FROM telemetry_spans WHERE span_id IN (${spanList}) OR trace_id IN (${traceList}) OR attributes_json LIKE '%${prefix}%';"`)
  console.log(`Gate: each CONFIRM query must return exactly 1 row whose trace_id = the 32-hex trace hex AND span_id = the 16-hex span hex printed above (end_time_ns IS NOT NULL; status_code 'UNSET' expected). If a persisted row's span_id equals a printed TRACE hex instead, the receipt query is conflating trace_id under a span-id label — re-check the receipt query, do NOT re-export.`)
  console.log(`Receiver-log receipt — capture IMMEDIATELY (before any DB clean/wipe): sqlite3 -readonly "$env:APPDATA\\com.fredo.app\\fredo.db" "SELECT timestamp, message, attributes_json FROM telemetry_logs WHERE message IN ('gRPC export received','raw OTLP spans persisted') ORDER BY timestamp DESC LIMIT 8;" — expect ONE 'gRPC export received'/'raw OTLP spans persisted' pair (span_count:1 / inserted:1) per injected session.`)

  // Final verdict (fix round 5): a failed export is a hard, loud exit — the
  // telemetry rows CANNOT exist, so the CONFIRM gates must not be run.
  if (exportFailures > 0) {
    console.error(`FAILED: ${exportFailures} of ${count} gRPC export(s) did not complete (see EXPORT lines above) — the telemetry rows CANNOT exist. Do NOT run the CONFIRM gates; verify the OTLP gRPC receiver on 127.0.0.1:${port} is up and re-run once.`)
    process.exit(1)
  }
  console.log(`All ${count} export(s) completed with grpc-status 0.`)
}

main().catch((err) => {
  console.error(`inject-otlp-fixture: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
