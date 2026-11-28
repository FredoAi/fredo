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
//! (`serde`, `serde_json`, `anyhow`, `chrono`, `async-trait`, `uuid`). There is
//! no `tauri`, no settings store, and no `path` dependency escaping `crates/`.
//! `.opencode/scripts/verify-domain-boundary.ps1` asserts it against the
//! **resolved** graph, so a transitively re-exposed platform crate is caught even
//! when the forbidden name never appears in this manifest.
//!
//! The permitted edge points the other way: platform modules may depend on this
//! crate (a platform module depending on a domain crate is the correct
//! direction). What must never exist is the reverse.

pub mod attrs;
pub mod event;

#[cfg(test)]
mod event_tests;
