//! # telemetry-domain
//!
//! The RTDB classification rules as a crate that **cannot** reach the Tauri
//! platform (Spec #3201).
//!
//! This crate holds the agent-telemetry domain: the wire vocabulary the ingest
//! classifier branches on, the shared GenAI attribute-extraction rules (NFR-6),
//! the canonical row model with its merge rules, and the classifier itself. Its
//! value is negative and structural — it is the compiler-enforced proof that the
//! most domain-rich code in the repository carries no dependency on the platform
//! it is supposed to be independent of.
//!
//! The dependency rule is deliberately narrow: general-purpose libraries only
//! (`serde`, `serde_json`, `anyhow`, `chrono`, `async-trait`, `uuid`,
//! `tracing`). There is no `tauri`, no settings store, and no `path` dependency
//! escaping `crates/`.
//! `.opencode/scripts/verify-domain-boundary.ps1` asserts it against the
//! **resolved** graph, so a transitively re-exposed platform crate is caught even
//! when the forbidden name never appears in this manifest.
//!
//! The permitted edge points the other way: platform modules may depend on this
//! crate (a platform module depending on a domain crate is the correct
//! direction). What must never exist is the reverse.

use async_trait::async_trait;

pub mod attrs;
pub mod classifier;
pub mod event;
pub mod merge;
pub mod rows;

#[cfg(test)]
mod event_tests;

use rows::{RowKey, RowKind, RowUpsert};

/// The classifier's **real** outward surface — the ONE dependency the domain
/// rules have on the hosting platform (Spec #3201 AC6).
///
/// **This port is READ + WRITE, deliberately.** The backlog's one-method sketch
/// (`fn ingest_row_upsert(&self, upsert: RowUpsert) -> Result<()>`) cannot
/// satisfy the code that consumes it: the classifier both writes merged rows and
/// **reads** existing ones, and the spec's three invariants live in the reads.
/// A write-only port compiles only by deleting them.
///
/// Why each method exists, and which invariant it serves:
///
/// | Method | Serves |
/// |---|---|
/// | [`RowSink::ingest_row_upsert`] | **Cost never double-counts** (the merged row carries per-turn deltas, never a re-applied cumulative) · **the user's words are never overwritten** (the merge already happened in-crate, so the row handed over is the authoritative one) |
/// | [`RowSink::get_row`] | **Cost never double-counts** · **the user's words are never overwritten** — merge-then-ingest reads the current row, applies the patch through [`merge`]'s total per-field rules, and diffs; the `reattribute_provider` target-presence guard reads before it ever writes. Without the read the merge degenerates to "start from an empty row", which is exactly the double-count / overwrite defect |
/// | [`RowSink::keys_for_session`] | **A subagent's work never vanishes from its parent's timeline** — the relationship re-key enumerates the child's existing rows (cached ∪ persisted, so rows still inside the write-behind window are not missed) and copies each one under the parent key |
///
/// Object-safe by construction (`#[async_trait]`, matching the platform's own
/// `comm/adapter.rs` precedent), because it is used **only** as
/// `Arc<dyn RowSink>`.
///
/// Implemented by the platform's `Rtdb` composition root
/// (`rtdb/commands.rs::impl RowSink for Rtdb`); the crate never names `Rtdb`.
#[async_trait]
pub trait RowSink: Send + Sync {
    /// Write one merged row. `changed_fields` holds the camelCase names of the
    /// fields the caller's merge patch touched; the return value is the number
    /// of deliveries forwarded to matching subscriptions.
    async fn ingest_row_upsert(
        &self,
        upsert: RowUpsert,
        changed_fields: &[String],
    ) -> anyhow::Result<usize>;

    /// Read one row of `kind` by its composite key.
    ///
    /// Returns the crate's row union ([`RowUpsert`] — the same three variants
    /// the write path takes; a row union serves both directions) so the caller
    /// matches on the variant it just asked for.
    async fn get_row(
        &self,
        kind: RowKind,
        session_id: &str,
        correlation_id: &str,
    ) -> anyhow::Result<Option<RowUpsert>>;

    /// Every key belonging to `session_id` for `kind` — the relationship
    /// re-key's enumeration input (cached ∪ persisted).
    async fn keys_for_session(
        &self,
        kind: RowKind,
        session_id: &str,
    ) -> anyhow::Result<Vec<RowKey>>;
}
