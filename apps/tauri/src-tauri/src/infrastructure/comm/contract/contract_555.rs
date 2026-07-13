//! Spec #555 ECE contract stub — streaming cadence + BufferedContract migration.
//!
//! This file defines the type-level contract for Phase 2 ECE delivery changes.
//! Developers implement against this contract; only the Architect may modify it.
//!
//! # Capsule A (ECE Streaming Fix) implements:
//!   - Replace `update_sent: bool` with `last_update_emitted_at: Option<DateTime<Utc>>`
//!   - Implement `should_emit_update()` cadence check
//!   - Preserve backward-compatible init/update/end lifecycle semantics

use chrono::{DateTime, Utc};

/// Streaming update cadence in milliseconds.
/// Updates are emitted at most once per this interval per buffer.
pub const STREAM_UPDATE_CADENCE_MS: i64 = 500;

/// Trait for the cadenced update logic.
/// Implemented on `BufferedContract` in `types.rs` and consumed by
/// `process_for_contract()` in `engine.rs`.
pub trait CadencedUpdate {
    /// Returns true if an update delivery should be emitted now.
    ///
    /// Rules:
    /// - Always returns true for the first update (last_update_emitted_at is None)
    /// - Returns true if at least STREAM_UPDATE_CADENCE_MS have passed since last emission
    /// - Returns false otherwise (content accumulates silently until next cadence window)
    fn should_emit_update(&mut self, now: DateTime<Utc>) -> bool;

    /// Record that an update was emitted at the given time.
    fn record_update_emitted(&mut self, now: DateTime<Utc>);
}

/// Contract: the `BufferedContract` struct in `types.rs` must:
/// 1. Replace field `update_sent: bool` with `last_update_emitted_at: Option<DateTime<Utc>>`
/// 2. Initialize `last_update_emitted_at: None` in `BufferedContract::new()`
/// 3. Implement `CadencedUpdate` trait
///
/// The `process_for_contract()` function in `engine.rs` must:
/// 1. Replace the `if !is_new && buffered.update_sent { return Vec::new(); }` block
///    with a cadence check using `buffered.should_emit_update(Utc::now())`
/// 2. After emitting an update, call `buffered.record_update_emitted(Utc::now())`
/// 3. Add a guard: skip cadence delivery if `buffered.completed` is true
/// 4. Preserve the `queue overflow protection` (REQ-12) block unchanged
