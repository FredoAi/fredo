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
    ...pbMessage(9, attributes),
  ]
}

function buildExportRequest(session: InjectedSession): number[] {
  // ScopeSpans { repeated Span spans = 2 }  (scope = 1 omitted — optional)
  // ONE span per export (fix round 3): a single-span ScopeSpans removes the
  // multi-span envelope/decoding variable — the receiver persists every span
  // of an Export unless the span_id PRIMARY KEY collides.
  const scopeSpans = pbMessage(2, buildSpanMessage(session))
  // ResourceSpans { repeated ScopeSpans scope_spans = 2 }  (resource = 1 omitted)
  const resourceSpans = pbMessage(2, scopeSpans)
  // ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1 }
  return pbMessage(1, resourceSpans)
}

// ── gRPC transport (cleartext h2c) ────────────────────────────────────────────

function exportViaGrpc(portNum: number, message: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://127.0.0.1:${portNum}`)
    client.on('error', (err) => {
      client.close()
      reject(err)
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
      client.close()
      reject(err)
    })

    const timeout = setTimeout(() => {
      stream.close()
      client.close()
      reject(new Error(`timeout exporting to 127.0.0.1:${portNum} — is the OTLP gRPC receiver up?`))
    }, 5000)

    const fail = (err: Error) => {
      clearTimeout(timeout)
      client.close()
      reject(err)
    }

    stream.on('response', (headers) => {
      if (headers[':status'] !== 200) {
        fail(new Error(`unexpected HTTP status ${headers[':status']}`))
      }
    })
    stream.on('trailers', (trailers) => {
      const status = trailers['grpc-status']
      if (status !== undefined && status !== '0') {
        fail(new Error(`grpc-status ${status}: ${trailers['grpc-message'] ?? ''}`))
      }
    })
    // Drain response body (framed empty ExportResponse), then finish.
    stream.on('data', () => {})
    stream.on('end', () => {
      clearTimeout(timeout)
      client.close()
      resolve()
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
  for (const s of sessions) {
    await exportViaGrpc(port, buildExportRequest(s))
  }

  for (const s of sessions) {
    const traceHex = Buffer.from(s.traceId).toString('hex')
    const spanHex = Buffer.from(s.spanId).toString('hex')
    console.log(`Injected session id: ${s.sessionId} (span fredo.tool.read, trace_id ${traceHex}, span_id ${spanHex})`)
  }
  console.log(`Done — ${count} orphan-fixture span(s) exported to 127.0.0.1:${port} (one gRPC Export per span)`)
  console.log(`Gate note: status_code 'UNSET' in telemetry_spans is EXPECTED (no Status set; raw.rs maps absent status → UNSET) — gate on end_time_ns IS NOT NULL, not on status.`)
}

main().catch((err) => {
  console.error(`inject-otlp-fixture: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
