//! Feature-owned data layer (Spec #2896) — declared, backend-owned, persistent
//! per-feature tables with table/record/field-granular reads and watches.
//!
//! The FULL submodule tree is declared here up front so later sub-tasks only
//! create files and never re-touch this module. A sub-task that does not own a
//! module's implementation ships that file with a module doc comment only.
//!
//! - [`declaration`]    — declaration model + hard-named validation (ST-2, R-4)
//! - [`registry`]       — declaration persistence + idempotent materialization (ST-2, R-4.1/R-4.3/R-4.4)
//! - [`store`]          — shared metadata DDL + reserved-column guard (ST-2)
//! - [`projection`]     — canonical upsert → declared-row projection engine (ST-3)
//! - [`session_rollup`] — the closed `sessionRollup` projection kind (ST-3)
//! - [`commands`]       — read/watch/unwatch/write/delete IPC (ST-4)
//! - [`watch`]          — the global per-watch registry (ST-4)
//! - [`envelope`]       — the `featureBatch` notification envelope (ST-4)
//! - [`backfill`]       — one-time declared-table projection backfill (ST-4)
//! - [`lifecycle`]      — declared-table retention + tombstones (ST-7)

pub mod backfill;
pub mod commands;
pub mod declaration;
pub mod envelope;
pub mod lifecycle;
pub mod projection;
pub mod registry;
pub mod session_rollup;
pub mod store;
pub mod watch;
