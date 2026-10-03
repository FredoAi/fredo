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
/// a `tauri::AppHandle`, so the same code serves the Tauri GUI *and* the
/// headless `fredo ingest` daemon. `start(app)` is the GUI wrapper that builds
/// the context from managed app state; a headless caller builds it directly and
/// calls [`start_with`].
pub mod grpc;
pub mod http;
pub mod raw;

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::infrastructure::rtdb::ingest::{IngestClassifier, IngestClassifierState};
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

/// Serve both OTLP receivers (gRPC `127.0.0.1:4317` + HTTP `127.0.0.1:4318`)
/// until one errors or the future is dropped. AppHandle-free: the caller owns
/// the runtime and the shutdown.
///
/// `tokio::try_join!` fails fast on a bind error (e.g. a port already in use)
/// and cancels the sibling, so a start failure is surfaced clearly rather than
/// leaving a half-started receiver.
pub async fn start_with(ctx: Arc<ReceiverContext>) -> anyhow::Result<()> {
    let grpc_ctx = Arc::clone(&ctx);
    let http_ctx = Arc::clone(&ctx);
    tokio::try_join!(grpc::start_with(grpc_ctx), http::start_with(http_ctx))?;
    Ok(())
}

/// Spawn both OTLP receiver servers as background tasks.
/// Called once from `lib.rs` during app setup, alongside `ipc::start_ipc_server`.
///
/// Thin wrapper: builds a [`ReceiverContext`] from the managed app state and
/// delegates to [`start_with`].
pub fn start(app: AppHandle) {
    let ctx = Arc::new(ReceiverContext {
        classifier: app.state::<IngestClassifierState>().inner().clone(),
        span_store: app.state::<Arc<SpanStore>>().inner().clone(),
    });
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start_with(ctx).await {
            tracing::error!(target: "fredo::otlp", error = %e, "OTLP receiver error");
        }
    });
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

    /// ST-3 (R-1): the AppHandle-free entry point takes ONLY the context. This
    /// is a type-level pin — if `start_with` regains an `AppHandle` parameter
    /// this stops compiling.
    #[test]
    fn start_with_signature_is_apphandle_free() {
        fn assert_entry<F, Fut>(_: F)
        where
            F: FnOnce(Arc<ReceiverContext>) -> Fut,
        {
        }
        assert_entry(start_with);
    }
}
