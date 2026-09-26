//! Shared library for spike #2964 — SQLite → embedded-PostgreSQL migration approach.
//!
//! This crate is a **research artifact only**. It never opens Fredo's `fredo.db`,
//! never touches production persistence, and is not part of any Cargo workspace.
//!
//! # Layout contract (ST-1 pre-declares the whole crate to avoid merge conflicts)
//!
//! * `Cargo.toml` declares a `[[bin]]` for every planned artifact: `schema`,
//!   `bench` (ST-1), `write_behind` (ST-3), `parity` (ST-4), `supervisor` (ST-5).
//! * This `lib.rs` declares ONLY the ST-1 shared modules below. Later tasks
//!   **must not edit it** — they add only their own `src/<name>.rs` binary file
//!   (already declared in `Cargo.toml`) and may reuse the shared code with
//!   `use postgres_migration_spike::harness;`.
//! * No `apps/**` file is ever referenced, imported, or modified.

pub mod harness;
pub mod schema_defs;
