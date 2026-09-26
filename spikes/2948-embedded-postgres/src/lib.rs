//! Shared library for spike #2948: embedded PostgreSQL vs embedded SQLite.
//!
//! This crate is a **research artifact only**. It never opens Fredo's `fredo.db`,
//! never touches production persistence, and is not part of any Cargo workspace.

pub mod metrics;
pub mod pgbench;
pub mod sampler;
pub mod schema;
pub mod workload;

pub use metrics::RunReport;
