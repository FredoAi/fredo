/// infrastructure/otlp — embedded OTLP receiver.
///
/// Starts two servers when the Tauri app launches:
///   • gRPC on 127.0.0.1:4317  — for OpenCode (OTLP/gRPC)
///   • HTTP on 127.0.0.1:4318  — for OpenCode (OTLP/HTTP, otlp-http exporter type)
///
/// Both servers receive OTLP signals (traces, metrics, logs), persist them raw
/// on receipt, and feed the RTDB ingest classifier (row pipeline).
///
/// The receivers resolve their dependencies from [`ReceiverContext`], never from
/// a `tauri::AppHandle`. The desktop process is the ONLY process that binds the
/// OTLP ports (Spec #3194): [`start_with_ports`] is the single receiver entry
/// point and fails with a typed [`IngestStartError`] naming the receiver, port,
/// failure class, and raw text.
pub mod grpc;
pub mod http;
pub mod raw;

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::infrastructure::rtdb::ingest::IngestClassifier;
use crate::infrastructure::storage::span_store::SpanStore;

/// AppHandle-free dependency bundle for the OTLP receivers.
///
/// Everything the gRPC and HTTP handlers need to persist raw spans and classify
/// rows, with no reference to `tauri::AppHandle` — the seam that lets the
/// receivers run in a process that is not the desktop GUI.
pub struct ReceiverContext {
    /// The RTDB write-path classifier (canonical `*_rows`).
    pub classifier: Arc<IngestClassifier>,
    /// The raw telemetry store (`telemetry_spans` / `telemetry_metrics` /
    /// `telemetry_logs`).
    pub span_store: Arc<SpanStore>,
}

/// Which receiver failed to become ready (wire `"grpc"` / `"http"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OtlpReceiverKind {
    /// The OTLP/gRPC receiver (`127.0.0.1:<grpcPort>`).
    Grpc,
    /// The OTLP/HTTP receiver (`127.0.0.1:<httpPort>`).
    Http,
}

impl OtlpReceiverKind {
    /// The wire token (`"grpc"` / `"http"`).
    pub fn as_str(self) -> &'static str {
        match self {
            OtlpReceiverKind::Grpc => "grpc",
            OtlpReceiverKind::Http => "http",
        }
    }
}

/// Why a receiver failed to start (wire `"addrInUse"` / `"bindFailed"`).
/// `AddrInUse` is the port-conflict class AC3 names; `BindFailed` is the residual.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IngestStartFailureCode {
    /// `std::io::ErrorKind::AddrInUse` was found in the error chain.
    AddrInUse,
    /// Any other start failure.
    BindFailed,
}

impl IngestStartFailureCode {
    /// The wire token (`"addrInUse"` / `"bindFailed"`).
    pub fn as_str(self) -> &'static str {
        match self {
            IngestStartFailureCode::AddrInUse => "addrInUse",
            IngestStartFailureCode::BindFailed => "bindFailed",
        }
    }
}

/// The typed OTLP ingest start failure — one value names the receiver, the
/// port, the failure class, and the raw error text (Spec #3194, AC3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestStartError {
    /// The receiver that failed to start.
    pub receiver: OtlpReceiverKind,
    /// The port the failing receiver tried to bind.
    pub port: u16,
    /// The classified failure cause.
    pub code: IngestStartFailureCode,
    /// The raw error text (the full `anyhow` chain, `{e:#}`).
    pub message: String,
}

impl std::fmt::Display for IngestStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "OTLP {} receiver failed to start on 127.0.0.1:{} ({}): {}",
            self.receiver.as_str(),
            self.port,
            self.code.as_str(),
            self.message
        )
    }
}

impl std::error::Error for IngestStartError {}

/// Classify a start failure: walk the error chain for a [`std::io::Error`] with
/// [`std::io::ErrorKind::AddrInUse`] → [`IngestStartFailureCode::AddrInUse`],
/// else [`IngestStartFailureCode::BindFailed`]. Decode-independent (reads the
/// `ErrorKind`, never the message text).
pub fn classify_bind(error: &anyhow::Error) -> IngestStartFailureCode {
    for cause in error.chain() {
        if let Some(io_error) = cause.downcast_ref::<std::io::Error>() {
            if io_error.kind() == std::io::ErrorKind::AddrInUse {
                return IngestStartFailureCode::AddrInUse;
            }
        }
    }
    IngestStartFailureCode::BindFailed
}

/// Serve both OTLP receivers on the EXPLICIT loopback ports `grpc_port` /
/// `http_port` until one errors or the future is dropped — the SINGLE receiver
/// entry point for the desktop process (Spec #3194).
///
/// `tokio::try_join!` fails fast on a start error (e.g. a port already in use)
/// and CANCELS the sibling, so a failed bind never leaves a half-started
/// receiver (R-3c). Fail-fast is preserved; only the error type is typed, with
/// per-receiver attribution (`map_err`) naming which receiver and port failed.
pub async fn start_with_ports(
    ctx: Arc<ReceiverContext>,
    grpc_port: u16,
    http_port: u16,
) -> Result<(), IngestStartError> {
    let grpc_ctx = Arc::clone(&ctx);
    let http_ctx = Arc::clone(&ctx);
    tokio::try_join!(
        async move {
            grpc::start_with_on_port(grpc_ctx, grpc_port)
                .await
                .map_err(|error| IngestStartError {
                    receiver: OtlpReceiverKind::Grpc,
                    port: grpc_port,
                    code: classify_bind(&error),
                    message: format!("{error:#}"),
                })
        },
        async move {
            http::start_with_on_port(http_ctx, http_port)
                .await
                .map_err(|error| IngestStartError {
                    receiver: OtlpReceiverKind::Http,
                    port: http_port,
                    code: classify_bind(&error),
                    message: format!("{error:#}"),
                })
        },
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Shared test fixtures for the OTLP receiver tests. Builds a
    //! [`ReceiverContext`] from a pending (uninstalled) engine — proving the
    //! context needs no `AppHandle` and no live database to construct.

    use std::sync::Arc;

    use crate::infrastructure::otlp::ReceiverContext;
    use crate::infrastructure::rtdb::cache::RtdbCache;
    use crate::infrastructure::rtdb::commands::Rtdb;
    use crate::infrastructure::rtdb::flush::{FlushLoop, RowEmitter};
    use crate::infrastructure::rtdb::ingest::IngestClassifier;
    use crate::infrastructure::rtdb::store::RtdbStore;
    use crate::infrastructure::rtdb::subscriptions::SubscriptionRegistry;
    use crate::infrastructure::storage::engine::EngineHandle;
    use crate::infrastructure::storage::span_store::SpanStore;

    /// Build an AppHandle-free context over a pending engine. Data-plane calls
    /// fail closed (engine not installed); the handlers log-and-continue.
    pub(crate) fn receiver_context() -> Arc<ReceiverContext> {
        let engine = EngineHandle::new_pending();
        let span_store = Arc::new(SpanStore::open(engine.clone()).expect("SpanStore::open"));
        let store = Arc::new(RtdbStore::open(engine).expect("RtdbStore::open"));
        let (cache, _rx) = RtdbCache::new(store);
        let emitter: RowEmitter = Arc::new(|_deliveries, _marker| {});
        let rtdb = Arc::new(Rtdb::new(
            cache,
            Arc::new(SubscriptionRegistry::new()),
            Arc::new(FlushLoop::new(emitter)),
        ));
        Arc::new(ReceiverContext {
            classifier: Arc::new(IngestClassifier::new(rtdb)),
            span_store,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// ST-3 (R-1): the receiver context is constructible with no
    /// `tauri::AppHandle` and no live engine — the AppHandle-free seam.
    #[test]
    fn receiver_context_constructs_without_apphandle() {
        let ctx = test_support::receiver_context();
        // Fields are the two owned `Arc`s named in the API contract.
        assert_eq!(Arc::strong_count(&ctx.classifier), 1);
        assert_eq!(Arc::strong_count(&ctx.span_store), 1);
    }

    /// ST-2 (#3194): the SINGLE receiver entry point is AppHandle-free — it takes
    /// only the context and the two ports, and returns the typed
    /// `IngestStartError`. This is a type-level pin: if `start_with_ports` regains
    /// an `AppHandle` parameter, or loses its typed error, this stops compiling.
    #[test]
    fn start_with_ports_signature_is_apphandle_free_and_typed() {
        fn assert_entry<F, Fut>(_: F)
        where
            F: FnOnce(Arc<ReceiverContext>, u16, u16) -> Fut,
            Fut: std::future::Future<Output = Result<(), IngestStartError>>,
        {
        }
        assert_entry(start_with_ports);
    }

    /// G-468 (Spec #3194): `lib.rs` has EXACTLY ONE `start_with_ports(` call site —
    /// refuse zero AND two-or-more — and never calls the retired `otlp::start(`.
    /// The "only binders" property as a compiled assertion, not a prose claim. The
    /// guard anchors on the CALL and asserts the cardinality property directly.
    #[test]
    fn lib_rs_has_exactly_one_start_with_ports_call_site() {
        let lib = include_str!("../../lib.rs");
        let occurrences = lib.matches("start_with_ports(").count();
        assert_eq!(
            occurrences, 1,
            "lib.rs must contain EXACTLY ONE `start_with_ports(` call site (found {occurrences}); \
             the receiver has exactly one entry point — zero is a dropped pipeline and >=2 is a \
             second binder"
        );
        assert!(
            !lib.contains("otlp::start("),
            "the retired `otlp::start(` wrapper must be absent from lib.rs"
        );
    }

    /// `classify_bind` walks the error chain to the `io::Error` and classifies
    /// `AddrInUse`; any other chain is `BindFailed` (the pure rule).
    #[test]
    fn classify_bind_walks_the_chain_for_addr_in_use() {
        let in_use = anyhow::Error::from(std::io::Error::from(
            std::io::ErrorKind::AddrInUse,
        ))
        .context("bind failed");
        assert_eq!(
            classify_bind(&in_use),
            IngestStartFailureCode::AddrInUse,
            "an io::ErrorKind::AddrInUse in the chain is the port-conflict class"
        );

        let other_io = anyhow::Error::from(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        ));
        assert_eq!(
            classify_bind(&other_io),
            IngestStartFailureCode::BindFailed,
            "a non-AddrInUse io::Error is the residual class"
        );

        let not_io = anyhow::anyhow!("the listener stopped");
        assert_eq!(
            classify_bind(&not_io),
            IngestStartFailureCode::BindFailed,
            "a non-io error is the residual class"
        );
    }

    /// The typed enums serialize to the frozen wire tokens, and the error's
    /// `Display` names the receiver, port, and class.
    #[test]
    fn typed_error_serializes_the_wire_shape_and_displays_its_parts() {
        let error = IngestStartError {
            receiver: OtlpReceiverKind::Http,
            port: 4318,
            code: IngestStartFailureCode::AddrInUse,
            message: "address already in use".to_string(),
        };
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(json["receiver"], "http");
        assert_eq!(json["port"], 4318);
        assert_eq!(json["code"], "addrInUse");
        assert_eq!(json["message"], "address already in use");

        assert_eq!(
            serde_json::to_value(OtlpReceiverKind::Grpc).expect("serialize"),
            "grpc"
        );
        assert_eq!(
            serde_json::to_value(IngestStartFailureCode::BindFailed).expect("serialize"),
            "bindFailed"
        );

        let display = error.to_string();
        assert!(display.contains("http"), "{display}");
        assert!(display.contains("4318"), "{display}");
        assert!(display.contains("addrInUse"), "{display}");
        assert!(display.contains("address already in use"), "{display}");
    }

    /// End-to-end: a real EXCLUSIVE holder on the gRPC port makes the gRPC
    /// receiver fail with `code: addrInUse`, naming the gRPC receiver and port
    /// (the live classification the tonic error chain actually yields).
    #[tokio::test]
    async fn a_held_grpc_port_is_classified_as_addr_in_use() {
        let ctx = test_support::receiver_context();
        // Hold the gRPC port EXCLUSIVELY; the HTTP sibling uses an ephemeral port
        // and is cancelled by `try_join!` the moment gRPC fails (no half-pipeline).
        let holder =
            std::net::TcpListener::bind("127.0.0.1:0").expect("bind an exclusive holder");
        let port = holder.local_addr().expect("holder addr").port();

        let error = tokio::time::timeout(
            Duration::from_secs(10),
            start_with_ports(ctx, port, 0),
        )
        .await
        .expect("the start must fail fast, not hang")
        .expect_err("a held port must fail");

        assert_eq!(error.receiver, OtlpReceiverKind::Grpc);
        assert_eq!(error.port, port);
        assert_eq!(
            error.code,
            IngestStartFailureCode::AddrInUse,
            "the tonic grpc bind error chain must classify as addrInUse: {error}"
        );
        drop(holder);
    }
}
