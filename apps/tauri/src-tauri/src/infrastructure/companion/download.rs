//! Shared streamed-file acquisition façade (Spec #2978, S2).
//!
//! The ONE streaming acquisition engine — skip-if-present, HTTP `Range` resume
//! with a prefix-seeded streaming SHA-256, delete-on-mismatch, bounded retry —
//! lives in [`crate::features::setup::model_download`] (Spec #2856, ST-2).
//!
//! Cross-feature imports are forbidden (`AGENTS.md`: "features never import from
//! other features"), so this thin shared infrastructure module re-exports the
//! engine for consumers in OTHER features — today `features::pg_supervisor`,
//! which routes the PostgreSQL archive through the same engine rather than
//! forking a second download path (NFR-6). There is exactly ONE implementation:
//! the `features/setup` module remains the single owner of the wire behavior, and
//! this module adds no logic of its own.
//!
//! Precedent: `infrastructure::companion::models` is the shared home for the
//! model-file layout consumed by two features for the same reason (Spec #2857
//! ST-9). `infrastructure/cli/commands/setup.rs` already consumes
//! `features::setup::model_download` directly; this module gives the shared layer
//! a stable, documented path instead of a second ad-hoc reference.

pub use crate::features::setup::model_download::{
    download_missing_files, ByteStream, BoxFuture, Clock, DownloadProgress, HttpRange, HttpResponse,
    HttpTransport, ModelDownloadOutcome, ProgressReporter, ProgressState, ReqwestTransport,
    SystemClock, PROGRESS_MIN_INTERVAL,
};
