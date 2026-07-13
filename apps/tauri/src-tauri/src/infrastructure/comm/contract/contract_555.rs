//! Spec #555 contract constant for Phase 2 ECE delivery streaming cadence.
//!
//! This file is committed to the spec branch BEFORE capsule creation.
//! Capsule A (ECE Streaming Fix) references this file read-only
//! and implements against the constant defined here.
//! Only the Architect may modify this file.

/// Streaming update cadence in milliseconds.
/// When an ECE buffer has pending accumulated content that hasn't been
/// delivered yet, update deliveries are emitted at most once per this
/// interval per buffer. The first update after init is always immediate
/// (REQ-2).
pub const STREAM_UPDATE_CADENCE_MS: i64 = 500;
