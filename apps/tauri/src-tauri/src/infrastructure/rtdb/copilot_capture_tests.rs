//! Spec #2933 ST-4 — GitHub Copilot CLI capture: the deterministic mocked path
//! and the regression/coexistence harness (EARS R-4.1, R-4.2, R-1.1–R-1.3,
//! R-2.1–R-2.6, R-3.1, R-3.2, R-5.1, R-5.2).
//!
//! ## What this module proves (test-only — NO product code, NO `AppHandle`,
//! ## NO network, NO `copilot` binary, NO paid tier)
//!
//! 1. **The full attribute → row mapping** (the plan's §3 table): the committed
//!    `fixtures/copilot_cli/*.json` fixtures are loaded with `include_str!` and
//!    fed through the REAL [`IngestClassifier`] composed exactly like the live
//!    path (`RtdbStore` → `RtdbCache` → `SubscriptionRegistry` → `FlushLoop` →
//!    `Rtdb` → `IngestClassifier`). Every field is asserted against the fixture
//!    values: provider token exactly `copilot_cli`, `sessionId` from
//!    `gen_ai.conversation.id`, `model`, the PER-CALL absolute
//!    `promptTokens`/`completionTokens` (the cumulative-delta derivation is
//!    bypassed for `copilot_cli`), `cacheReadTokens` absent, tool
//!    name/args/result/success/error/duration, and the session `totalTokens`
//!    fallback over `gen_ai.usage.input_tokens + output_tokens`.
//! 2. **The content-off degradation discriminator** (R-3.2): with content
//!    disabled the structural rows still exist while the content keys are
//!    ABSENT from `rawJson` and the canonical content fields are null; the
//!    content-on control populates both — so the degradation is distinguishishable
//!    from a broken extractor.
//! 3. **Provider coexistence/isolation** (R-5.1/R-5.2): an OpenCode-shaped
//!    envelope AND the Copilot fixture are fed into ONE classifier — the
//!    `open_code` rows keep their exact field set/shape, the `copilot_cli` rows
//!    are disjoint in session/correlation identity, and no row's provider flips.
//! 4. **Replay idempotency** (R-4.1/R-4.2): a replayed identical export is a
//!    content no-op — no duplicate composite key, no seq inflation.
//!
//! The fixtures are ST-1's recorded (documented-shape) live capture; the suite
//! itself never depends on the real `copilot` binary (the live capture is the
//! input, not a test dependency).
//!
//! ## Limitation this harness surfaced (flagged for an architect decision)
//!
//! The across-classifier replay (the restart shape — F-11) is FULLY idempotent.
//! Within ONE classifier instance, a replayed export re-mints the ROOT session
//! span's correlation id: `resolve_span_correlation_id` special-cases
//! `OP_SESSION` to `resolve_correlation_id`, which allocates a fresh per-turn id
//! for an Init-state span whenever a turn counter exists (pre-existing ported
//! behavior, shared with OpenCode's `run_agent` root). The chat/tool spans ARE
//! span-keyed (the ST9 guard) and replay as content no-ops; only the session
//! root lands at a NEW `(sessionId, correlationId)` key. A provider-scoped
//! span-keyed session correlation (in `ingest.rs` — outside this test module)
//! would make the same-classifier root replay a no-op too. Not asserted here as
//! "expected" — reported instead of enshrined.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::rtdb::cache::RtdbCache;
use crate::infrastructure::rtdb::commands::Rtdb;
use crate::infrastructure::rtdb::flush::{FlushLoop, RowEmitter};
use crate::infrastructure::rtdb::ingest::IngestClassifier;
use crate::infrastructure::rtdb::project::RowDelivery;
use crate::infrastructure::rtdb::rows::{
    AgentSessionRow, ChatRow, ToolUseRow, AGENT_SESSION_FIELDS, CHAT_FIELDS, TOOL_USE_FIELDS,
};
use crate::infrastructure::rtdb::store::RtdbStore;
use crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry;

// ── Committed fixtures (ST-1) — the deterministic mocked-path input ──────────

const CONTENT_ON: &str = include_str!("fixtures/copilot_cli/content-on.json");
const CONTENT_OFF: &str = include_str!("fixtures/copilot_cli/content-off.json");
const TOOL_FAILURE: &str = include_str!("fixtures/copilot_cli/tool-failure.json");
const SESSION_ONLY: &str = include_str!("fixtures/copilot_cli/session-only.json");

/// Fixture session ids (from `gen_ai.conversation.id`).
const SESSION_CONTENT_ON: &str = "ses_copilot_fixture_1";
const SESSION_CONTENT_OFF: &str = "ses_copilot_fixture_2";
const SESSION_TOOL_FAILURE: &str = "ses_copilot_fixture_3";
const SESSION_SESSION_ONLY: &str = "ses_copilot_fixture_4";

// ── Harness — the SAME composition the live classifier is built with ────────

type Sink = Arc<Mutex<Vec<RowDelivery>>>;

/// Compose the REAL classifier over a throwaway store — mirrors the live
/// `RtdbStore → RtdbCache → SubscriptionRegistry → FlushLoop → Rtdb →
/// IngestClassifier` wiring (the `make_classifier()` composition used by the
/// classifier's own unit tests). Test-only: the emitter captures deliveries
/// into a `Vec` (no IPC, no `AppHandle`).
fn make_classifier() -> (tempfile::TempDir, Arc<IngestClassifier>, Arc<Rtdb>, Sink) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(RtdbStore::open(dir.path().to_path_buf()).expect("open store"));
    store.ensure_schema().expect("schema");
    let (cache, _rx) = RtdbCache::new(store);
    let registry = Arc::new(SubscriptionRegistry::new());
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&sink);
    let emitter: RowEmitter = Arc::new(move |deliveries: &[RowDelivery], _marker: Option<&str>| {
        capture
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend_from_slice(deliveries);
    });
    let flush = Arc::new(FlushLoop::new(emitter));
    let rtdb = Arc::new(Rtdb::new(cache, registry, flush));
    let classifier = Arc::new(IngestClassifier::new(Arc::clone(&rtdb)));
    (dir, classifier, rtdb, sink)
}

/// Feed one committed fixture (an OTLP/JSON envelope) through the real
/// classifier. Returns the classifier's row-mutation count.
fn ingest_fixture(classifier: &IngestClassifier, fixture: &str) -> usize {
    let raw: Value = serde_json::from_str(fixture).expect("committed fixture is valid JSON");
    classifier.ingest_otlp(Transport::OtlpHttp, &raw)
}

fn feed(classifier: &IngestClassifier, raw: &Value) -> usize {
    classifier.ingest_otlp(Transport::OtlpHttp, raw)
}

fn chat(rtdb: &Rtdb, session: &str, corr: &str) -> ChatRow {
    rtdb
        .cache()
        .get_chat(session, corr)
        .expect("read chat row")
        .expect("chat row exists")
}

fn tool(rtdb: &Rtdb, session: &str, corr: &str) -> ToolUseRow {
    rtdb
        .cache()
        .get_tool_use(session, corr)
        .expect("read tool row")
        .expect("tool row exists")
}

fn session_row(rtdb: &Rtdb, session: &str, corr: &str) -> AgentSessionRow {
    rtdb
        .cache()
        .get_agent_session(session, corr)
        .expect("read session row")
        .expect("session row exists")
}

fn chat_keys(rtdb: &Rtdb, session: &str) -> Vec<(String, String)> {
    rtdb
        .cache()
        .chat_keys_for_session(session)
        .expect("chat keys")
}

fn tool_keys(rtdb: &Rtdb, session: &str) -> Vec<(String, String)> {
    rtdb
        .cache()
        .tool_keys_for_session(session)
        .expect("tool keys")
}

fn session_keys(rtdb: &Rtdb, session: &str) -> Vec<(String, String)> {
    rtdb
        .cache()
        .agent_session_keys_for_session(session)
        .expect("session keys")
}

/// Assert a row's serialized shape is EXACTLY the canonical field set (R-5.1:
/// the OpenCode row shape is unchanged — no added/removed fields).
fn assert_field_set<T: serde::Serialize>(row: &T, expected: &[&str], label: &str) {
    let value = serde_json::to_value(row).expect("serialize row");
    let actual: BTreeSet<String> = value
        .as_object()
        .expect("row serializes to an object")
        .keys()
        .cloned()
        .collect();
    let expected: BTreeSet<String> = expected.iter().map(|f| (*f).to_string()).collect();
    assert_eq!(actual, expected, "{label} must carry exactly the canonical field set");
}

/// OTLP attribute builder (stringValue) — fixture-shaped.
fn attr(key: &str, value: &str) -> Value {
    json!({ "key": key, "value": { "stringValue": value } })
}

/// OTLP attribute builder (intValue) — fixture-shaped.
fn attr_num(key: &str, value: i64) -> Value {
    json!({ "key": key, "value": { "intValue": value } })
}

/// An OpenCode-shaped OTLP export (`service.name = "fredo-opencode-plugin"` →
/// provider token `open_code`) under a DISTINCT session id — the R-5 isolation
/// control. Mirrors the plugin's real attribute shapes.
fn opencode_envelope() -> Value {
    let session = "ses_opencode_baseline";
    json!({
        "resourceSpans": [{
            "resource": { "attributes": [ attr("service.name", "fredo-opencode-plugin") ] },
            "scopeSpans": [{ "spans": [
                {
                    "name": "run_agent",
                    "traceId": "aaf7651916cd43dd8448eb211c803100",
                    "spanId": "aaad6b7169203001",
                    "startTimeUnixNano": "1000000000",
                    "endTimeUnixNano": "9000000000",
                    "attributes": [
                        attr("gen_ai.operation.name", "run_agent"),
                        attr("session.id", session),
                        attr("gen_ai.agent.name", "opencode"),
                        attr_num("total_tokens", 59_200),
                        attr_num("total_messages", 12),
                        json!({ "key": "total_cost_usd", "value": { "doubleValue": 0.42 } })
                    ]
                },
                {
                    "name": "llm",
                    "traceId": "aaf7651916cd43dd8448eb211c803100",
                    "spanId": "aaad6b7169203002",
                    "startTimeUnixNano": "1100000000",
                    "endTimeUnixNano": "4000000000",
                    "attributes": [
                        attr("gen_ai.operation.name", "chat"),
                        attr("session.id", session),
                        attr("gen_ai.input.messages",
                             "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"What is the weather?\"}]}]"),
                        attr("gen_ai.output.messages",
                             "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"The weather is sunny.\"}]}]"),
                        attr("gen_ai.response.model", "claude-sonnet-4"),
                        attr_num("gen_ai.usage.input_tokens", 100),
                        attr_num("gen_ai.usage.output_tokens", 50),
                        attr_num("gen_ai.usage.cache_read.input_tokens", 512_000)
                    ]
                },
                {
                    "name": "execute_tool bash",
                    "traceId": "aaf7651916cd43dd8448eb211c803100",
                    "spanId": "aaad6b7169203003",
                    "startTimeUnixNano": "4100000000",
                    "endTimeUnixNano": "4220000000",
                    "attributes": [
                        attr("gen_ai.operation.name", "execute_tool"),
                        attr("session.id", session),
                        attr("gen_ai.tool.name", "bash"),
                        attr("gen_ai.tool.call.arguments", "{\"command\":\"ls\"}"),
                        attr("gen_ai.tool.call.result", "file1 file2"),
                        json!({ "key": "tool.success", "value": { "boolValue": true } }),
                        attr_num("duration_ms", 120)
                    ]
                }
            ]}]
        }]
    })
}

// ── R-1.1–R-1.3 / R-2.1–R-2.6: the full content-on attribute → row mapping ──

#[test]
fn content_on_fixture_maps_the_full_copilot_field_set() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    let ingested = ingest_fixture(&classifier, CONTENT_ON);
    assert!(ingested >= 3, "session + chat + tool rows must classify");

    // ── session root (`invoke_agent` → AgentSessionRow, provider-scoped) ────
    let session = session_row(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_1");
    assert_eq!(session.provider.as_deref(), Some("copilot_cli"));
    assert_eq!(
        session.total_tokens,
        Some(1_700),
        "session total falls back to gen_ai.usage.input_tokens + output_tokens (1500 + 200)"
    );
    assert_eq!(session.total_messages, None, "Copilot emits no message count");
    assert_eq!(session.total_cost_usd, None, "Copilot emits no cost");
    assert_eq!(session.agent_name.as_deref(), Some("copilot"));
    assert_eq!(session.state, crate::infrastructure::rtdb::rows::RowState::Init);
    assert_eq!(session.started_at_ns, Some(1_000_000_000));
    assert_eq!(session.ended_at_ns, Some(9_000_000_000));
    assert_field_set(&session, AGENT_SESSION_FIELDS, "agent_session row");

    // ── chat turn (`chat` → ChatRow; PER-CALL absolute tokens) ──────────────
    let chat_row = chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2");
    assert_eq!(chat_row.provider.as_deref(), Some("copilot_cli"));
    assert_eq!(
        chat_row.user_message.as_deref(),
        Some("Add a doc comment to src/main.rs"),
        "userMessage from gen_ai.input.messages"
    );
    assert_eq!(
        chat_row.agent_reply.as_deref(),
        Some("I will add the doc comment."),
        "agentReply from gen_ai.output.messages"
    );
    assert_eq!(
        chat_row.prompt_tokens,
        Some(1_200),
        "Copilot chat input is the PER-CALL absolute value, never a delta"
    );
    assert_eq!(chat_row.completion_tokens, Some(150));
    assert_eq!(
        chat_row.cache_read_tokens, None,
        "the cumulative-delta path is bypassed for copilot_cli → cacheReadTokens absent"
    );
    assert_eq!(chat_row.cost_usd, None, "Copilot emits no per-turn cost");
    assert_eq!(chat_row.model.as_deref(), Some("gpt-4o"));
    assert_eq!(chat_row.state, crate::infrastructure::rtdb::rows::RowState::Response);
    assert_field_set(&chat_row, CHAT_FIELDS, "chat row");

    // content-on ⇒ the content keys are PRESENT in rawJson (the R-3.2 control).
    assert!(
        chat_row.raw_json.contains("gen_ai.input.messages"),
        "content-on chat rawJson must carry the content keys"
    );
    assert!(chat_row.raw_json.contains("gen_ai.output.messages"));

    // ── tool call (`execute_tool` → ToolUseRow) ─────────────────────────────
    let tool_row = tool(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_3");
    assert_eq!(tool_row.provider.as_deref(), Some("copilot_cli"));
    assert_eq!(tool_row.tool_name.as_deref(), Some("readFile"));
    assert_eq!(tool_row.tool_success, Some(true), "completed without error.type → success");
    assert_eq!(tool_row.tool_error, None);
    assert_eq!(tool_row.duration_ms, Some(500), "duration derived from span timing");
    assert_eq!(
        tool_row.tool_input_json.as_deref(),
        Some("{\"path\":\"src/main.rs\"}"),
        "tool arguments from gen_ai.tool.call.arguments"
    );
    assert_eq!(
        tool_row.tool_output_json.as_deref(),
        Some("\"fn main() {}\""),
        "tool result from gen_ai.tool.call.result"
    );
    assert_field_set(&tool_row, TOOL_USE_FIELDS, "tool-use row");
    assert!(tool_row.raw_json.contains("gen_ai.tool.call.arguments"));
}

// ── R-3.1 / R-3.2: content-off degradation (structural rows, no content) ─────

#[test]
fn content_off_fixture_degrades_structurally_and_leaves_content_keys_absent() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    ingest_fixture(&classifier, CONTENT_OFF);

    // Structural rows still exist in ALL three classes.
    let session = session_row(&rtdb, SESSION_CONTENT_OFF, "ses_copilot_fixture_2_1");
    assert_eq!(session.provider.as_deref(), Some("copilot_cli"));
    assert_eq!(session.total_tokens, Some(1_020), "900 + 120 session total fallback");
    assert_eq!(session.agent_name.as_deref(), Some("copilot"));

    let chat_row = chat(&rtdb, SESSION_CONTENT_OFF, "ses_copilot_fixture_2_2");
    assert_eq!(chat_row.provider.as_deref(), Some("copilot_cli"));
    assert_eq!(chat_row.prompt_tokens, Some(700));
    assert_eq!(chat_row.completion_tokens, Some(90));
    assert_eq!(chat_row.model.as_deref(), Some("gpt-4o"));
    assert_eq!(chat_row.user_message, None, "content-off → userMessage absent");
    assert_eq!(chat_row.agent_reply, None, "content-off → agentReply absent");

    let tool_row = tool(&rtdb, SESSION_CONTENT_OFF, "ses_copilot_fixture_2_3");
    assert_eq!(tool_row.provider.as_deref(), Some("copilot_cli"));
    assert_eq!(tool_row.tool_name.as_deref(), Some("readFile"));
    assert_eq!(tool_row.tool_success, Some(true), "structural outcome survives content-off");
    assert_eq!(tool_row.duration_ms, Some(500));
    assert_eq!(tool_row.tool_input_json, None, "content-off → tool arguments absent");
    assert_eq!(tool_row.tool_output_json, None, "content-off → tool result absent");

    // R-3.2 binding discriminator: the content keys are ABSENT from rawJson —
    // the documented degradation, NOT a broken extractor (which would leave the
    // keys present with a null canonical field).
    for row_raw in [&chat_row.raw_json, &tool_row.raw_json, &session.raw_json] {
        for key in [
            "gen_ai.input.messages",
            "gen_ai.output.messages",
            "gen_ai.tool.call.arguments",
            "gen_ai.tool.call.result",
        ] {
            assert!(
                !row_raw.contains(key),
                "content-off rawJson must be free of the content key `{key}`"
            );
        }
    }
}

// ── R-2.5: tool-failure outcome derived from `error.type` + span timing ──────

#[test]
fn tool_failure_fixture_maps_failure_outcome_error_and_duration() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    ingest_fixture(&classifier, TOOL_FAILURE);

    let session = session_row(&rtdb, SESSION_TOOL_FAILURE, "ses_copilot_fixture_3_1");
    assert_eq!(session.total_tokens, Some(910), "800 + 110 session total fallback");

    let chat_row = chat(&rtdb, SESSION_TOOL_FAILURE, "ses_copilot_fixture_3_2");
    assert_eq!(chat_row.prompt_tokens, Some(600));
    assert_eq!(chat_row.completion_tokens, Some(80));

    let tool_row = tool(&rtdb, SESSION_TOOL_FAILURE, "ses_copilot_fixture_3_3");
    assert_eq!(tool_row.tool_name.as_deref(), Some("applyPatch"));
    assert_eq!(
        tool_row.tool_success,
        Some(false),
        "error.type present → failure (Copilot-native outcome signal)"
    );
    assert_eq!(tool_row.tool_error.as_deref(), Some("ToolExecutionError"));
    assert_eq!(tool_row.duration_ms, Some(500), "duration from span timing");
}

// ── R-4.2 / partial exchange: chat-only never leaves an orphan or partial row ─

#[test]
fn session_only_fixture_produces_no_tool_row() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    ingest_fixture(&classifier, SESSION_ONLY);

    let session = session_row(&rtdb, SESSION_SESSION_ONLY, "ses_copilot_fixture_4_1");
    assert_eq!(session.total_tokens, Some(460), "400 + 60 session total fallback");

    let chat_row = chat(&rtdb, SESSION_SESSION_ONLY, "ses_copilot_fixture_4_2");
    assert_eq!(chat_row.user_message.as_deref(), Some("What does src/main.rs do?"));
    assert_eq!(chat_row.agent_reply.as_deref(), Some("It is the entry point."));
    assert_eq!(chat_row.prompt_tokens, Some(350));
    assert_eq!(chat_row.completion_tokens, Some(50));

    assert!(
        tool_keys(&rtdb, SESSION_SESSION_ONLY).is_empty(),
        "a chat-only exchange must not fabricate a tool row"
    );
}

/// A partial exchange delivered out of order (chat before the session root)
/// still yields a coherent row, and the later session root neither orphans nor
/// duplicates the chat row (R-4.2 "no partial row that later double-writes").
#[test]
fn out_of_order_partial_exchange_stays_coherent_without_duplicates() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    let session = "ses_copilot_partial";
    let chat_span = json!({
        "name": "chat gpt-4o",
        "traceId": "baf7651916cd43dd8448eb211c803200",
        "spanId": "bbad6b7169204001",
        "startTimeUnixNano": "1000000000",
        "endTimeUnixNano": "4000000000",
        "attributes": [
            attr("gen_ai.operation.name", "chat"),
            attr("gen_ai.conversation.id", session),
            attr("gen_ai.response.model", "gpt-4o"),
            attr_num("gen_ai.usage.input_tokens", 200),
            attr_num("gen_ai.usage.output_tokens", 30)
        ]
    });
    let session_span = json!({
        "name": "invoke_agent copilot",
        "traceId": "baf7651916cd43dd8448eb211c803200",
        "spanId": "bbad6b7169204002",
        "startTimeUnixNano": "500000000",
        "endTimeUnixNano": "9000000000",
        "attributes": [
            attr("gen_ai.operation.name", "invoke_agent"),
            attr("gen_ai.conversation.id", session),
            attr("gen_ai.agent.name", "copilot"),
            attr_num("gen_ai.usage.input_tokens", 200),
            attr_num("gen_ai.usage.output_tokens", 30)
        ]
    });

    // Response before init: the chat row lands first, alone.
    feed(&classifier, &copilot_envelope(vec![chat_span.clone()]));
    let chat_keys_before = chat_keys(&rtdb, session);
    assert_eq!(chat_keys_before.len(), 1, "one chat row, no orphan");
    let chat_before = chat(&rtdb, session, &chat_keys_before[0].1);
    assert!(session_keys(&rtdb, session).is_empty(), "no session row yet");

    // The session root arrives later — the chat row is untouched.
    feed(&classifier, &copilot_envelope(vec![session_span]));
    assert_eq!(chat_keys(&rtdb, session).len(), 1, "no duplicate chat row");
    assert_eq!(
        chat(&rtdb, session, &chat_keys_before[0].1),
        chat_before,
        "the earlier chat row is byte-identical after the late session root"
    );
    assert_eq!(session_keys(&rtdb, session).len(), 1, "exactly one session row");
}

/// Build a Copilot-resource envelope around spans (fixture resource identity).
fn copilot_envelope(spans: Vec<Value>) -> Value {
    json!({
        "resourceSpans": [{
            "resource": { "attributes": [ attr("service.name", "copilot-cli") ] },
            "scopeSpans": [{ "spans": spans }]
        }]
    })
}

// ── R-5.1 / R-5.2: OpenCode unchanged + no cross-provider contamination ──────

#[test]
fn opencode_and_copilot_rows_coexist_without_cross_contamination() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    feed(&classifier, &opencode_envelope());
    ingest_fixture(&classifier, CONTENT_ON);

    // ── OpenCode baseline: exact field shape, provider `open_code` ──────────
    let oc_session = session_row(&rtdb, "ses_opencode_baseline", "ses_opencode_baseline_1");
    assert_eq!(oc_session.provider.as_deref(), Some("open_code"));
    assert_eq!(oc_session.total_tokens, Some(59_200), "OpenCode flat total_tokens stays primary");
    assert_eq!(oc_session.total_messages, Some(12));
    assert_eq!(oc_session.total_cost_usd, Some(0.42));
    assert_field_set(&oc_session, AGENT_SESSION_FIELDS, "OpenCode agent_session row");

    let oc_chat = chat(&rtdb, "ses_opencode_baseline", "ses_opencode_baseline_2");
    assert_eq!(oc_chat.provider.as_deref(), Some("open_code"));
    assert_eq!(oc_chat.user_message.as_deref(), Some("What is the weather?"));
    assert_eq!(oc_chat.agent_reply.as_deref(), Some("The weather is sunny."));
    assert_eq!(oc_chat.prompt_tokens, Some(100), "OpenCode cumulative-delta path unchanged");
    assert_eq!(oc_chat.completion_tokens, Some(50));
    assert_eq!(oc_chat.model.as_deref(), Some("claude-sonnet-4"));
    assert_eq!(
        oc_chat.cache_read_tokens,
        Some(512_000),
        "OpenCode cache-read delta path unchanged"
    );
    assert_field_set(&oc_chat, CHAT_FIELDS, "OpenCode chat row");

    let oc_tool = tool(&rtdb, "ses_opencode_baseline", "ses_opencode_baseline_3");
    assert_eq!(oc_tool.provider.as_deref(), Some("open_code"));
    assert_eq!(oc_tool.tool_name.as_deref(), Some("bash"));
    assert_eq!(oc_tool.tool_success, Some(true));
    assert_eq!(oc_tool.duration_ms, Some(120), "OpenCode flat duration_ms stays primary");
    assert_eq!(oc_tool.tool_input_json.as_deref(), Some("{\"command\":\"ls\"}"));
    assert_eq!(oc_tool.tool_output_json.as_deref(), Some("file1 file2"));
    assert_field_set(&oc_tool, TOOL_USE_FIELDS, "OpenCode tool-use row");

    // ── Identity disjointness: no shared session/correlation keys ───────────
    let copilot_sessions: BTreeSet<String> = [
        SESSION_CONTENT_ON,
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    let opencode_sessions: BTreeSet<String> = ["ses_opencode_baseline"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    assert!(
        copilot_sessions.is_disjoint(&opencode_sessions),
        "provider session namespaces must not collide"
    );

    for (session, corr) in chat_keys(&rtdb, SESSION_CONTENT_ON) {
        assert!(session.starts_with("ses_copilot_fixture_"), "copilot chat key session");
        assert_ne!(session, "ses_opencode_baseline");
        assert_eq!(chat(&rtdb, &session, &corr).provider.as_deref(), Some("copilot_cli"));
    }
    for (session, corr) in chat_keys(&rtdb, "ses_opencode_baseline") {
        assert_eq!(chat(&rtdb, &session, &corr).provider.as_deref(), Some("open_code"));
    }

    // ── No provider flips on a replayed export ──────────────────────────────
    feed(&classifier, &opencode_envelope());
    assert_eq!(
        session_row(&rtdb, "ses_opencode_baseline", "ses_opencode_baseline_1")
            .provider
            .as_deref(),
        Some("open_code")
    );
    assert_eq!(
        chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2").provider.as_deref(),
        Some("copilot_cli"),
        "a replayed OpenCode export must never restamp Copilot rows"
    );
}

// ── R-4.1 / R-4.2: replayed identical export is idempotent ──────────────────

/// The restart shape (the canonical deterministic duplicate-export replay, and
/// exactly the F-11 "restart Fredo and re-ingest" expectation): a FRESH
/// classifier over the SAME store re-derives byte-identical keys/content, so
/// every write is a content no-op — no duplicate composite key, no seq bump.
#[test]
fn replayed_identical_copilot_export_is_idempotent_across_classifiers() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    ingest_fixture(&classifier, CONTENT_ON);

    let chat_before = chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2");
    let tool_before = tool(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_3");
    let session_before = session_row(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_1");
    let counts_before = rtdb.cache().store().row_counts().expect("counts");

    // A fresh classifier (the process-restart shape) replaying the same export.
    let restarted = Arc::new(IngestClassifier::new(Arc::clone(&rtdb)));
    ingest_fixture(&restarted, CONTENT_ON);

    assert_eq!(
        rtdb.cache().store().row_counts().expect("counts"),
        counts_before,
        "an identical replay must not add a row in any table"
    );
    assert_eq!(chat_keys(&rtdb, SESSION_CONTENT_ON).len(), 1, "one chat row per composite key");
    assert_eq!(tool_keys(&rtdb, SESSION_CONTENT_ON).len(), 1, "one tool row per composite key");
    assert_eq!(session_keys(&rtdb, SESSION_CONTENT_ON).len(), 1, "one session row");

    let chat_after = chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2");
    let tool_after = tool(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_3");
    let session_after = session_row(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_1");
    assert_eq!(chat_after, chat_before, "chat row unchanged (incl. seq)");
    assert_eq!(tool_after, tool_before, "tool row unchanged (incl. seq)");
    assert_eq!(session_after, session_before, "session row unchanged (incl. seq)");
    assert_eq!(chat_after.seq, chat_before.seq, "no seq inflation on an unchanged row");
}

/// Span-keyed idempotency within ONE classifier (the duplicate-export retry
/// case): the ST9 one-correlation-per-span guard makes the CHAT and TOOL rows
/// replay as content no-ops — same composite key, same seq.
#[test]
fn duplicate_span_keyed_rows_dedup_within_one_classifier() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    ingest_fixture(&classifier, CONTENT_ON);

    let chat_before = chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2");
    let tool_before = tool(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_3");

    // The identical export again, through the SAME classifier.
    ingest_fixture(&classifier, CONTENT_ON);

    let chat_after = chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2");
    let tool_after = tool(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_3");
    assert_eq!(chat_after.correlation_id, chat_before.correlation_id);
    assert_eq!(tool_after.correlation_id, tool_before.correlation_id);
    assert_eq!(chat_after.seq, chat_before.seq, "chat seq unchanged on replay");
    assert_eq!(tool_after.seq, tool_before.seq, "tool seq unchanged on replay");
    assert_eq!(chat_after, chat_before);
    assert_eq!(tool_after, tool_before);
    assert_eq!(chat_keys(&rtdb, SESSION_CONTENT_ON).len(), 1);
    assert_eq!(tool_keys(&rtdb, SESSION_CONTENT_ON).len(), 1);
}

// ── R-4.2: a degraded/unclassifiable export never corrupts or duplicates ─────

#[test]
fn degraded_export_writes_no_rows_and_preserves_existing_rows() {
    let (_dir, classifier, rtdb, _sink) = make_classifier();
    ingest_fixture(&classifier, CONTENT_ON);
    let counts_before = rtdb.cache().store().row_counts().expect("counts");
    let chat_before = chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2");

    // An empty envelope (a truncated/denied export) classifies to nothing.
    assert_eq!(feed(&classifier, &json!({ "resourceSpans": [] })), 0);

    // A span that resolves to no canonical op is dropped, never half-written.
    let unclassifiable = json!({
        "resourceSpans": [{
            "resource": { "attributes": [ attr("service.name", "copilot-cli") ] },
            "scopeSpans": [{ "spans": [ {
                "name": "zzz-unclassified",
                "spanId": "ccad6b7169205001",
                "attributes": [ attr("gen_ai.conversation.id", SESSION_CONTENT_ON) ]
            } ] }]
        }]
    });
    assert_eq!(feed(&classifier, &unclassifiable), 0);

    assert_eq!(
        rtdb.cache().store().row_counts().expect("counts"),
        counts_before,
        "a degraded export must not add or corrupt rows"
    );
    assert_eq!(
        chat(&rtdb, SESSION_CONTENT_ON, "ses_copilot_fixture_1_2"),
        chat_before,
        "existing rows are byte-identical after a degraded export"
    );
}
