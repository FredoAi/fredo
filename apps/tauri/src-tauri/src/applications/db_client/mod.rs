//! Built-in PostgreSQL client (Spec #2950).
//!
//! # ST-1 — Foundation (producer, frozen contract)
//!
//! This module is created by **ST-1** and is the shared producer every later
//! sub-task builds against (G-255/G-023). It lands:
//!
//! * the full wire contract ([`types`]) — every `Db*` struct/enum, the
//!   `db_*` command argument shapes, and the persistence/credential key
//!   constants (`Fredo_dbclient_*`, keyring service `fredo.dbclient`);
//! * the managed [`DbClientState`](state::DbClientState);
//! * the G-275 induction seams ([`seam`]): `FREDO_DBCLIENT_FORCE_FAIL`
//!   (`connect|auth|timeout|query`, inert when unset) and
//!   `FREDO_DBCLIENT_STATE_DIR` (default `.opencode/tmp/2950/dbclient/`);
//! * all nine `#[tauri::command]` wrappers ([`commands`]), registered exactly
//!   once in `lib.rs` — additive to the existing `generate_handler!` list.
//!
//! # ST-1 non-goals / invariants
//!
//! * No `sqlx` pool is opened, no `pg_catalog` SQL is issued, and no credential
//!   is read or written here — [`connect`], [`schema`] and [`query`] fill their
//!   own module bodies in ST-2/ST-3/ST-4.
//! * `AppStore`/`EngineHandle` and the embedded-PostgreSQL supervisor are
//!   untouched.
//! * The wiring files (`mod.rs`, `commands.rs`, `state.rs`, `types.rs`,
//!   `seam.rs`, `applications/mod.rs`, `lib.rs`) are owned by ST-1 only; later
//!   sub-tasks never re-open them. Transient per-connection registries live in
//!   their own module (e.g. ST-2's pools on [`state::DbClientState`]).
//!
//! EARS: none (contract) — enables R-1..R-5.

pub mod commands;
pub mod connect;
pub mod query;
pub mod schema;
pub mod seam;
pub mod state;
pub mod types;

#[cfg(test)]
mod tests_foundation;
