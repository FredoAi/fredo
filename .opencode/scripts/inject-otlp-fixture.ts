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
 * Delegation-tree mode (--parent, #2768 round 2): spans shaped EXACTLY like the
 * real F5/F4B rows (attribute keys copied verbatim from telemetry_spans). For
 * each child i it exports, in order:
 *   1. a PARENT-side `fredo.tool.task` span — session.id = parent,
 *      gen_ai.operation.name = execute_tool, gen_ai.tool.name = task,
 *      tool_name = task, agent.type = primary, child_session_id = <child>,
 *      child_agent = general, tool.success = true, tool_call_id /
 *      gen_ai.tool.call.id = call_fixture_<i> — the SubagentNode mint key the
 *      frontend joins on (payload.childSessionId comes from child_session_id);
 *   2. the child `fredo.session` span — is_subagent = true, agent.type =
 *      subagent, gen_ai.operation.name = run_agent, and the SELF-CARRIED
 *      routing property session.parent_id = parent (ST-2 registration fires
 *      from this property alone — no parent-side event observation needed);
 *   3. the child `fredo.tool.read` span — session.parent_id = parent.
 * Every child span carries session.parent_id so the adapter promotes the typed
 * parent_session_id and the ECE re-keys the child's deliveries under the
 * parent composite key with compositedChildSessionId injected — the exact
 * compositing shape the round-2 fix keys on.
 *
 * Phased drives (AC3 strict partial-window): `--start-index N` numbers the
 * first child, so phase 1 runs `--count 1 --start-index 1` (MM open) and
 * phase 2 runs `--count 1 --start-index 2` (MM closed) against the SAME
 * --parent id. Receipts print per span (task + child), keyed by span_id hex.
 *
 * Copilot mode (--copilot, Spec #2933 ST-5): a self-contained producer for the
 * GitHub Copilot CLI capture contract. Instead of the hand-encoded gRPC
 * protobuf, it POSTs a Copilot-shaped OTLP/JSON envelope to the REAL OTLP/HTTP
 * receiver on `127.0.0.1:4318/v1/traces` — the exact transport the Copilot CLI
 * ships — so a tester can drive receiver → classifier → canonical rows without
 * the `copilot` binary, auth, or a paid subscription. The Rust fixture (ST-4)
 * remains the no-network deterministic baseline; this is the optional live leg.
 *
 * Envelope shape (mirrors the ST-4 fixture):
 *   - Resource `service.name = "copilot-cli"` → provider token `copilot_cli`
 *     (the one shared rule, `rtdb/attrs.rs::resolve_provider_token`).
 *   - Session root span `invoke_agent copilot` with
 *     `gen_ai.operation.name = invoke_agent` (NOT the OpenCode `run_agent`) and
 *     session-cumulative `gen_ai.usage.input_tokens`/`output_tokens`.
 *   - `chat <model>` span with PER-CALL `gen_ai.usage.*` (Copilot's per-call
 *     semantics — the classifier bypasses the cumulative-delta derivation).
 *   - `execute_tool readFile` span with `gen_ai.tool.name` + span timing.
 *   - Content ON by default (`gen_ai.input.messages` / `output.messages` /
 *     `tool.call.arguments` / `tool.call.result`); `--content-off` omits those
 *     four keys (Copilot's default) so the R-3.2 degradation discriminator can
 *     be exercised live — the structural rows still appear.
 *
 * Params:
 *   --count N        number of fake child sessions to inject (default 2)
 *   --prefix ID      base id; session ids are `<prefix>-1 .. <prefix>-N`
 *                    (default ses_orphan2762; `--copilot` default ses_copilot2933)
 *   --port N         receiver port (gRPC default 4317; `--copilot` HTTP default 4318)
 *   --parent ID      delegation-tree mode: parent session id (enables the
 *                    task-span + session.parent_id shape above)
 *   --start-index N  first child index in tree mode (default 1)
 *   --copilot        Copilot OTLP/HTTP JSON mode (see above); mutually
 *                    exclusive with `--parent`
 *   --content-off    `--copilot` only: omit the content keys (Copilot default)
 *
 * Dependency-free — stdlib only. Speaks cleartext h2c via `node:http2`
 * (available in Bun) and hand-encodes the `ExportTraceServiceRequest`
 * protobuf wrapped in a gRPC length-prefixed frame; `--copilot` uses the
 * global `fetch` + `AbortController` (Bun/Node built-ins, no new dependency).
 */

import http2 from 'node:http2'
import { randomBytes } from 'node:crypto'

// ── CLI params ────────────────────────────────────────────────────────────────

let count = 2
let prefixArg: string | null = null
let portArg: number | null = null
let parent: string | null = null
let startIndex = 1
let copilot = false
let contentOff = false

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--count') count = Number(argv[++i])
  else if (argv[i] === '--prefix') prefixArg = argv[++i]
  else if (argv[i] === '--port') portArg = Number(argv[++i])
  else if (argv[i] === '--parent') parent = argv[++i]
  else if (argv[i] === '--start-index') startIndex = Number(argv[++i])
  else if (argv[i] === '--copilot') copilot = true
  else if (argv[i] === '--content-off') contentOff = true
  else {
    console.error(`Unknown argument: ${argv[i]}`)
    process.exit(1)
  }
}
const prefix = prefixArg ?? (copilot ? 'ses_copilot2933' : 'ses_orphan2762')
const port = portArg ?? (copilot ? 4318 : 4317)
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
if (parent !== null && !parent) {
  console.error('--parent must be a non-empty string')
  process.exit(1)
}
if (!Number.isInteger(startIndex) || startIndex < 1) {
  console.error('--start-index must be a positive integer')
  process.exit(1)
}
if (copilot && parent !== null) {
  console.error('--copilot and --parent are mutually exclusive modes')
  process.exit(1)
}
if (contentOff && !copilot) {
  console.error('--content-off is only valid with --copilot')
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

/** One exportable span: single-span Export per span (fix round 3 discipline). */
interface InjectedSpan {
  sessionId: string
  spanName: string
  traceId: Uint8Array
  spanId: Uint8Array
  attributes: number[]
}

function buildSpanMessage(span: InjectedSpan): number[] {
  const now = BigInt(Date.now()) * 1_000_000n // ms → ns
  const startNs = now
  const endNs = now + 1_000_000n // completed: end > start (1ms span)

  // Span {
  //   bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4 (ABSENT);
  //   string name = 5; SpanKind kind = 6; fixed64 start_time_unix_nano = 7;
  //   fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9;
  // }
  return [
    ...pbBytes(1, span.traceId),
    ...pbBytes(2, span.spanId),
    ...pbString(5, span.spanName),
    ...pbVarint(6, 1), // SPAN_KIND_INTERNAL
    ...pbFixed64(7, startNs),
    ...pbFixed64(8, endNs),
    // FIX round 7 (FIX-B): a repeated message field needs ONE tag+length per
    // element. Collapsing all KeyValues into a single length-delimited record
    // decodes as ONE KeyValue (last key wins) — silently destroying session.id,
    // is_subagent, gen_ai.* and falling session_id back to the trace hex.
    ...span.attributes.flatMap((a) => pbMessage(9, a)),
  ]
}

/** Orphan-fixture mode: one completed fredo.tool.read span per fake child. */
function buildOrphanAttributes(session: InjectedSession): number[] {
  // Span attributes — mirror REAL telemetry_spans rows (see header comment).
  return [
    ...keyValue('session.id', anyValueString(session.sessionId)),
    ...keyValue('gen_ai.operation.name', anyValueString('execute_tool')),
    ...keyValue('gen_ai.tool.name', anyValueString('read')),
    ...keyValue('is_subagent', anyValueBool(true)),
    ...keyValue('agent.type', anyValueString('subagent')),
    ...keyValue('gen_ai.conversation.id', anyValueString(session.sessionId)),
    ...keyValue('agent', anyValueString('fixture-orphan')),
    // NOTE: deliberately NO `session.parent_id` → no ECE relationship.
  ]
}

/** Delegation-tree mode (#2768 round 2): the parent-side task span for one
 * child dispatch. Attribute keys copied verbatim from real F5 rows. */
function buildTaskSpanAttributes(parentId: string, childSessionId: string, index: number): number[] {
  const callId = `call_fixture_${index}`
  return [
    ...keyValue('session.id', anyValueString(parentId)),
    ...keyValue('gen_ai.operation.name', anyValueString('execute_tool')),
    ...keyValue('gen_ai.tool.name', anyValueString('task')),
    ...keyValue('tool_name', anyValueString('task')),
    ...keyValue('agent.type', anyValueString('primary')),
    ...keyValue('child_session_id', anyValueString(childSessionId)),
    ...keyValue('child_agent', anyValueString('general')),
    ...keyValue('tool.success', anyValueBool(true)),
    ...keyValue('tool_call_id', anyValueString(callId)),
    ...keyValue('gen_ai.tool.call.id', anyValueString(callId)),
    ...keyValue('duration_ms', anyValueString('1000')),
    ...keyValue('gen_ai.conversation.id', anyValueString(parentId)),
  ]
}

/** Delegation-tree mode: the child session span — carries the SELF-CARRIED
 * routing property session.parent_id (real child-session shape). */
function buildChildSessionAttributes(parentId: string, childSessionId: string): number[] {
  return [
    ...keyValue('session.id', anyValueString(childSessionId)),
    ...keyValue('session.parent_id', anyValueString(parentId)),
    ...keyValue('is_subagent', anyValueBool(true)),
    ...keyValue('agent.type', anyValueString('subagent')),
    ...keyValue('agent', anyValueString('general')),
    ...keyValue('gen_ai.agent.name', anyValueString('general')),
    ...keyValue('gen_ai.operation.name', anyValueString('run_agent')),
    ...keyValue('gen_ai.conversation.id', anyValueString(childSessionId)),
  ]
}

/** Delegation-tree mode: the child tool span — session.parent_id stamped
 * (the round-1 fix's emission shape, 100% child-span coverage). */
function buildChildToolAttributes(parentId: string, childSessionId: string): number[] {
  return [
    ...keyValue('session.id', anyValueString(childSessionId)),
    ...keyValue('session.parent_id', anyValueString(parentId)),
    ...keyValue('agent.type', anyValueString('subagent')),
    ...keyValue('agent', anyValueString('general')),
    ...keyValue('gen_ai.operation.name', anyValueString('execute_tool')),
    ...keyValue('gen_ai.tool.name', anyValueString('read')),
    ...keyValue('tool_name', anyValueString('read')),
    ...keyValue('gen_ai.conversation.id', anyValueString(childSessionId)),
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

function buildExportRequest(span: InjectedSpan): number[] {
  // ScopeSpans { repeated Span spans = 2 }  (scope = 1 omitted — optional)
  // ONE span per export (fix round 3): a single-span ScopeSpans removes the
  // multi-span envelope/decoding variable — the receiver persists every span
  // of an Export unless the span_id PRIMARY KEY collides.
  const resource: InjectedSession = { sessionId: span.sessionId, traceId: span.traceId, spanId: span.spanId }
  const scopeSpans = pbMessage(2, buildSpanMessage(span))
  // ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2 }
  const resourceSpans = [
    ...pbMessage(1, buildResource(resource)),
    ...pbMessage(2, scopeSpans),
  ]
  // ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1 }
  return pbMessage(1, resourceSpans)
}

// ── Copilot mode envelope (OTLP/HTTP JSON, Spec #2933 ST-5) ───────────────────

/** OTLP AnyValue attribute helpers — int64 fields are decimal STRINGS per the
 * OTLP/JSON spec (the receiver's `with-serde` deserializer accepts them). */
function attrString(key: string, value: string): { key: string; value: Record<string, unknown> } {
  return { key, value: { stringValue: value } }
}

function attrInt(key: string, value: number): { key: string; value: Record<string, unknown> } {
  return { key, value: { intValue: String(value) } }
}

interface CopilotSpanReceipt {
  name: string
  traceId: string
  spanId: string
}

/** Build the Copilot-shaped OTLP/JSON envelope (mirrors the ST-4 fixture). */
function buildCopilotEnvelope(
  sessionId: string,
  omitContent: boolean,
): { body: unknown; spans: CopilotSpanReceipt[] } {
  const model = 'gpt-4o'
  const traceId = randomBytes(16).toString('hex')
  const sessionSpanId = randomBytes(8).toString('hex')
  const chatSpanId = randomBytes(8).toString('hex')
  const toolSpanId = randomBytes(8).toString('hex')
  const base = Date.now() * 1_000_000 // ms → ns
  const at = (offsetMs: number) => String(base + offsetMs * 1_000_000)

  const sessionAttrs = [
    attrString('gen_ai.operation.name', 'invoke_agent'),
    attrString('gen_ai.conversation.id', sessionId),
    attrString('gen_ai.agent.name', 'copilot'),
    attrString('gen_ai.response.model', model),
    attrInt('gen_ai.usage.input_tokens', 12480), // session-cumulative
    attrInt('gen_ai.usage.output_tokens', 731), // session-cumulative
  ]
  const chatAttrs = [
    attrString('gen_ai.operation.name', 'chat'),
    attrString('gen_ai.conversation.id', sessionId),
    attrString('gen_ai.response.model', model),
    attrInt('gen_ai.usage.input_tokens', 321), // PER-CALL (not cumulative)
    attrInt('gen_ai.usage.output_tokens', 184), // PER-CALL
    attrInt('gen_ai.usage.reasoning.output_tokens', 40),
    ...(omitContent
      ? []
      : [
          attrString(
            'gen_ai.input.messages',
            JSON.stringify([
              { role: 'user', parts: [{ type: 'text', content: 'List the files in the src directory.' }] },
            ]),
          ),
          attrString(
            'gen_ai.output.messages',
            JSON.stringify([
              { role: 'assistant', parts: [{ type: 'text', content: 'I will read src/main.rs first.' }] },
            ]),
          ),
        ]),
  ]
  const toolAttrs = [
    attrString('gen_ai.operation.name', 'execute_tool'),
    attrString('gen_ai.conversation.id', sessionId),
    attrString('gen_ai.tool.name', 'readFile'),
    ...(omitContent
      ? []
      : [
          attrString('gen_ai.tool.call.arguments', JSON.stringify({ path: 'src/main.rs' })),
          attrString('gen_ai.tool.call.result', 'fn main() {}'),
        ]),
  ]

  const spans = [
    { name: 'invoke_agent copilot', traceId, spanId: sessionSpanId, startTimeUnixNano: at(0), endTimeUnixNano: at(900), attributes: sessionAttrs },
    { name: `chat ${model}`, traceId, spanId: chatSpanId, startTimeUnixNano: at(100), endTimeUnixNano: at(400), attributes: chatAttrs },
    { name: 'execute_tool readFile', traceId, spanId: toolSpanId, startTimeUnixNano: at(410), endTimeUnixNano: at(460), attributes: toolAttrs },
  ]

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attrString('service.name', 'copilot-cli'), // → provider copilot_cli
            attrString('service.version', 'copilot-cli-fixture'),
          ],
        },
        scopeSpans: [{ spans }],
      },
    ],
  }
  return {
    body,
    spans: spans.map((s) => ({ name: s.name, traceId: s.traceId, spanId: s.spanId })),
  }
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

// ── OTLP/HTTP transport (Copilot mode) ────────────────────────────────────────

/** POST an OTLP/JSON envelope to the HTTP receiver. Resolves with an explicit
 * outcome (mirrors `exportViaGrpc`) so a silent transport failure is impossible
 * to miss. Uses the global `fetch` + `AbortController` — no new dependency. */
async function exportViaHttp(url: string, jsonBody: string): Promise<ExportResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody,
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    return { ok: true, status: String(res.status) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

// ── Copilot mode runner ───────────────────────────────────────────────────────

/** Copilot mode: POST the Copilot-shaped OTLP/JSON envelope to the REAL
 * OTLP/HTTP receiver and print a self-contained receipt (row-table CONFIRM SQL
 * + the R-3.2 content-key discriminator). */
async function runCopilotMode() {
  const envelope = buildCopilotEnvelope(prefix, contentOff)
  const url = `http://127.0.0.1:${port}/v1/traces`
  console.log(`Copilot mode: POST ${envelope.spans.length} span(s) to ${url} (service.name=copilot-cli, session=${prefix}, content=${contentOff ? 'OFF' : 'ON'})`)
  const result = await exportViaHttp(url, JSON.stringify(envelope.body))
  if (!result.ok) {
    console.error(`FAILED: OTLP/HTTP export to ${url} did not complete: ${result.error ?? 'unknown error'} — the telemetry rows CANNOT exist. Verify the OTLP/HTTP receiver is up (GET http://127.0.0.1:${port}/health should return status ok) and re-run once.`)
    process.exit(1)
  }
  console.log(`EXPORT 1/1 -> OK (http ${result.status ?? 'unknown'})`)
  for (const s of envelope.spans) {
    console.log(`Injected span: session=${prefix} name=${s.name} trace_id ${s.traceId} span_id ${s.spanId}`)
  }

  const db = '$env:APPDATA\\com.fredo.app\\fredo.db'
  console.log(`CONFIRM chat_rows: sqlite3 -readonly "${db}" "SELECT session_id, correlation_id, provider, model, user_message, agent_reply, prompt_tokens, completion_tokens, cache_read_tokens, cost_usd FROM chat_rows WHERE session_id = '${prefix}'"`)
  console.log(`CONFIRM tool_use_rows: sqlite3 -readonly "${db}" "SELECT session_id, correlation_id, provider, tool_name, tool_success, tool_error, duration_ms, tool_input_json, tool_output_json FROM tool_use_rows WHERE session_id = '${prefix}'"`)
  console.log(`CONFIRM agent_session_rows: sqlite3 -readonly "${db}" "SELECT session_id, correlation_id, provider, total_tokens, total_messages, total_cost_usd, agent_name FROM agent_session_rows WHERE session_id = '${prefix}'"`)
  console.log(`EXPECT every row provider = 'copilot_cli'; chat_rows prompt_tokens = 321 / completion_tokens = 184 (PER-CALL, never a delta); agent_session_rows total_tokens = 13211 (12480+731), total_messages / total_cost_usd NULL; tool_use_rows duration_ms = 50, tool_success = 1.`)
  console.log(`R-3.2 discriminator (${contentOff ? 'content OFF — the four content keys must be ABSENT from raw_json' : 'content ON — content must be present in raw_json'}): sqlite3 -readonly "${db}" "SELECT session_id, raw_json FROM chat_rows WHERE session_id = '${prefix}'" (check gen_ai.input.messages / gen_ai.output.messages) and tool_use_rows.raw_json (check gen_ai.tool.call.arguments / gen_ai.tool.call.result).`)
  if (contentOff) {
    console.log(`Content-off gate: chat_rows and tool_use_rows MUST still exist (structural rows), user_message / agent_reply / tool_input_json / tool_output_json MUST be NULL, and raw_json MUST NOT carry the content keys — never a silent empty result.`)
  }
  console.log(`Raw-span receipt: sqlite3 -readonly "${db}" "SELECT span_name, session_id, transport, end_time_ns FROM telemetry_spans WHERE attributes_json LIKE '%${prefix}%' ORDER BY start_time_ns"`)
  console.log(`Done — Copilot OTLP/HTTP leg exported to ${url}.`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (copilot) {
    // Copilot mode (Spec #2933 ST-5) is a standalone OTLP/HTTP JSON leg — it
    // shares no state with the gRPC orphan/delegation modes.
    await runCopilotMode()
    return
  }

  // Every exported span: single-span Export, own random trace/span ids.
  const spans: InjectedSpan[] = []
  const sessions: InjectedSession[] = []

  const mk = (sessionId: string, spanName: string, attributes: number[]): InjectedSpan => ({
    sessionId,
    spanName,
    traceId: randomBytes(16),
    spanId: randomBytes(8),
    attributes,
  })

  if (parent !== null) {
    // Delegation-tree mode (#2768 round 2): per child — child session span,
    // child tool span (both stamped session.parent_id), then the parent-side
    // task span (child_session_id = the SubagentNode mint key).
    for (let i = 0; i < count; i++) {
      const idx = startIndex + i
      const childId = `${prefix}-${idx}`
      const child: InjectedSession = { sessionId: childId, traceId: randomBytes(16), spanId: randomBytes(8) }
      sessions.push(child)
      spans.push(mk(childId, 'fredo.session', buildChildSessionAttributes(parent, childId)))
      spans.push(mk(childId, 'fredo.tool.read', buildChildToolAttributes(parent, childId)))
      spans.push(mk(parent, 'fredo.tool.task', buildTaskSpanAttributes(parent, childId, idx)))
    }
  } else {
    // Orphan-fixture mode (unchanged): one completed fredo.tool.read span per
    // fake child, deliberately NO session.parent_id.
    for (let i = 1; i <= count; i++) {
      const child: InjectedSession = { sessionId: `${prefix}-${i}`, traceId: randomBytes(16), spanId: randomBytes(8) }
      sessions.push(child)
      spans.push(mk(child.sessionId, 'fredo.tool.read', buildOrphanAttributes(child)))
    }
  }

  // ONE sequential gRPC export PER SPAN (fix round 3): each span travels in
  // its own single-span ExportTraceServiceRequest, so a missing row can only
  // be a span_id PRIMARY-KEY collision — never multi-span envelope decoding.
  // Fix round 5: print the per-export gRPC outcome (session id + trace/span
  // hexes + OK/FAILED) — a silent transport failure is impossible to miss.
  let exportFailures = 0
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    const traceHex = Buffer.from(s.traceId).toString('hex')
    const spanHex = Buffer.from(s.spanId).toString('hex')
    const result = await exportViaGrpc(port, buildExportRequest(s))
    if (result.ok) {
      // FIX round 7 (FIX-C): print the OBSERVED wire status — never a
      // hardcoded grpc-status 0. An 'unknown' status means neither the
      // response headers nor trailers carried one (investigate before
      // trusting the receipt).
      console.log(`EXPORT ${i + 1}/${spans.length} session=${s.sessionId} span=${s.spanName} trace=${traceHex} span_id=${spanHex} -> OK (grpc-status ${result.status ?? 'unknown'})`)
    } else {
      exportFailures++
      console.log(`EXPORT ${i + 1}/${spans.length} session=${s.sessionId} span=${s.spanName} trace=${traceHex} span_id=${spanHex} -> FAILED: ${result.error ?? 'unknown error'}`)
    }
  }

  for (const s of spans) {
    const traceHex = Buffer.from(s.traceId).toString('hex')
    const spanHex = Buffer.from(s.spanId).toString('hex')
    console.log(`Injected span: session=${s.sessionId} name=${s.spanName} trace_id ${traceHex} span_id ${spanHex}`)
  }
  console.log(`Done — ${spans.length} span(s) exported to 127.0.0.1:${port} (one gRPC Export per span${parent !== null ? `, delegation tree under parent ${parent}` : ''})`)
  console.log(`Gate note: status_code 'UNSET' in telemetry_spans is EXPECTED (no Status set; raw.rs maps absent status → UNSET) — gate on end_time_ns IS NOT NULL, not on status.`)

  // Receipt self-containment (fix round 4): print the exact CONFIRM SQL per
  // span with BOTH hex ids embedded, plus the receiver-log capture
  // instruction — the tester can cross-check rows by PRIMARY KEY without
  // reconstructing the query (and a trace/span label conflation becomes
  // mechanically visible).
  for (const s of spans) {
    const traceHex = Buffer.from(s.traceId).toString('hex')
    const spanHex = Buffer.from(s.spanId).toString('hex')
    console.log(`CONFIRM session=${s.sessionId} span=${s.spanName}: sqlite3 -readonly "$env:APPDATA\\com.fredo.app\\fredo.db" "SELECT session_id, span_name, trace_id, span_id, status_code, end_time_ns FROM telemetry_spans WHERE trace_id = '${traceHex}' AND span_id = '${spanHex}'"`)
  }

  // Identity probe (fix round 5, plan R1): the session filter alone is NOT
  // authoritative — the receiver DERIVES session_id (session.id attr →
  // gen_ai.conversation.id → trace hex → "unknown", raw.rs:90-115). This
  // probe bypasses the derived column entirely and decides under ANY
  // session_id derivation (or attrs-only persistence).
  const spanList = spans.map((s) => `'${Buffer.from(s.spanId).toString('hex')}'`).join(', ')
  const traceList = spans.map((s) => `'${Buffer.from(s.traceId).toString('hex')}'`).join(', ')
  console.log(`IDENTITY PROBE (decides under ANY derived session_id — copy-paste): sqlite3 -readonly "$env:APPDATA\\com.fredo.app\\fredo.db" "SELECT span_id, trace_id, session_id, span_name, transport, end_time_ns, ingested_at FROM telemetry_spans WHERE span_id IN (${spanList}) OR trace_id IN (${traceList}) OR attributes_json LIKE '%${prefix}%'"`)
  console.log(`Gate: each CONFIRM query must return exactly 1 row whose trace_id = the 32-hex trace hex AND span_id = the 16-hex span hex printed above (end_time_ns IS NOT NULL; status_code 'UNSET' expected). If a persisted row's span_id equals a printed TRACE hex instead, the receipt query is conflating trace_id under a span-id label — re-check the receipt query, do NOT re-export.`)
  console.log(`Receiver-log receipt — capture IMMEDIATELY (before any DB clean/wipe): sqlite3 -readonly "$env:APPDATA\\com.fredo.app\\fredo.db" "SELECT timestamp, message, attributes_json FROM telemetry_logs WHERE message IN ('gRPC export received','raw OTLP spans persisted') ORDER BY timestamp DESC LIMIT 12;" — expect ONE 'gRPC export received'/'raw OTLP spans persisted' pair (span_count:1 / inserted:1) per injected span.`)

  // Final verdict (fix round 5): a failed export is a hard, loud exit — the
  // telemetry rows CANNOT exist, so the CONFIRM gates must not be run.
  if (exportFailures > 0) {
    console.error(`FAILED: ${exportFailures} of ${spans.length} gRPC export(s) did not complete (see EXPORT lines above) — the telemetry rows CANNOT exist. Do NOT run the CONFIRM gates; verify the OTLP gRPC receiver on 127.0.0.1:${port} is up and re-run once.`)
    process.exit(1)
  }
  console.log(`All ${spans.length} export(s) completed with grpc-status 0.`)
}

main().catch((err) => {
  console.error(`inject-otlp-fixture: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
