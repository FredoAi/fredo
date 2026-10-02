//! The migration gate — the ONE exclusive barrier held across
//! snapshot → copy → parity → install (R-3.5, G-123).
//!
//! Writers (`writer_enter`) take a SHARED read lock; the migration leg
//! (`migration_enter`) takes the EXCLUSIVE write lock. A writer's acquire is
//! bounded by [`GATE_WAIT_BOUND`] so a writer can never block forever behind a
//! migration; on timeout it returns `Err` and the caller sheds that storage
//! write (the documented bounded-write contract). The exclusive acquire is
//! bounded by the same constant.
//!
//! `is_migrating` is an `AtomicBool` fast path so a writer can cheaply observe
//! that a migration is in flight before paying for the lock.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::GATE_WAIT_BOUND;

/// The exclusive migration barrier. `Arc`-shared between the writer call-sites
/// and the migration leg.
pub struct MigrationGate {
    migrating: AtomicBool,
    lock: RwLock<()>,
    bound: Duration,
}

impl MigrationGate {
    /// A gate bounded by [`GATE_WAIT_BOUND`].
    pub fn new() -> Arc<Self> {
        Self::with_bound(GATE_WAIT_BOUND)
    }

    /// A gate with an explicit acquire bound (deterministic tests).
    pub fn with_bound(bound: Duration) -> Arc<Self> {
        Arc::new(MigrationGate {
            migrating: AtomicBool::new(false),
            lock: RwLock::new(()),
            bound,
        })
    }

    /// Enter as a writer: take the shared read lock, bounded by the gate's
    /// acquire bound. `Err` means the migration held the barrier past the bound
    /// and the caller must shed the write rather than block (G-263).
    pub async fn writer_enter(&self) -> Result<MigrationWriterGuard<'_>> {
        match tokio::time::timeout(self.bound, self.lock.read()).await {
            Ok(guard) => Ok(MigrationWriterGuard { _guard: guard }),
            Err(_) => Err(anyhow!(
                "[migration-gate] writer acquire exceeded its {:?} bound",
                self.bound
            )),
        }
    }

    /// Enter as a writer from a SYNCHRONOUS write entry point (the terminal
    /// record writes), which cannot `.await`. Drives [`Self::writer_enter`] on
    /// the ambient runtime (or a throwaway one), so the acquire is still bounded
    /// by the gate's bound. `Err` means the migration held the barrier past the
    /// bound and the caller must shed the write (G-263).
    pub fn writer_enter_blocking(&self) -> Result<MigrationWriterGuard<'_>> {
        block_on_gate(self.writer_enter())
    }

    /// Enter as the migration leg: take the EXCLUSIVE write lock, bounded by the
    /// gate's acquire bound. While held, every writer waits (up to its own
    /// bound) — the barrier is held across copy → parity → install.
    pub async fn migration_enter(&self) -> Result<MigrationGuard<'_>> {
        self.migrating.store(true, Ordering::SeqCst);
        match tokio::time::timeout(self.bound, self.lock.write()).await {
            Ok(guard) => Ok(MigrationGuard {
                _guard: guard,
                gate: self,
            }),
            Err(_) => {
                self.migrating.store(false, Ordering::SeqCst);
                Err(anyhow!(
                    "[migration-gate] migration acquire exceeded its {:?} bound",
                    self.bound
                ))
            }
        }
    }

    /// Cheap fast-path probe: is the exclusive migration leg in flight?
    pub fn is_migrating(&self) -> bool {
        self.migrating.load(Ordering::SeqCst)
    }
}

/// Drive an async acquire from a synchronous caller (mirrors the store's
/// `block_on_pg` bridge). Inside a multi-threaded runtime this parks the worker
/// via `block_in_place`; outside any runtime it builds a bounded throwaway one.
fn block_on_gate<F: std::future::Future>(future: F) -> F::Output {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(future)),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build a runtime for a synchronous migration-gate acquire")
            .block_on(future),
    }
}

/// A held writer slot; dropping it releases the shared barrier.
pub struct MigrationWriterGuard<'a> {
    _guard: RwLockReadGuard<'a, ()>,
}

/// The held exclusive migration slot; dropping it releases the barrier and
/// clears the `is_migrating` fast path.
pub struct MigrationGuard<'a> {
    _guard: RwLockWriteGuard<'a, ()>,
    gate: &'a MigrationGate,
}

impl Drop for MigrationGuard<'_> {
    fn drop(&mut self) {
        self.gate.migrating.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn writers_and_migration_are_mutually_exclusive() {
        let gate = MigrationGate::new();
        assert!(!gate.is_migrating());

        let migration = gate.migration_enter().await.unwrap();
        assert!(gate.is_migrating());

        // A writer cannot enter while the migration holds the barrier.
        let blocked = tokio::time::timeout(Duration::from_millis(50), gate.writer_enter()).await;
        assert!(
            blocked.is_err(),
            "a writer must not enter while the migration holds the barrier"
        );

        drop(migration);
        assert!(!gate.is_migrating());

        // Once released, a writer enters immediately.
        let writer = gate.writer_enter().await.unwrap();
        drop(writer);
    }

    #[tokio::test]
    async fn migration_waits_for_an_in_flight_writer() {
        let gate = MigrationGate::new();
        let writer = gate.writer_enter().await.unwrap();

        let blocked =
            tokio::time::timeout(Duration::from_millis(50), gate.migration_enter()).await;
        assert!(blocked.is_err(), "the migration waits for writers to drain");

        drop(writer);
        let migration = gate.migration_enter().await.unwrap();
        assert!(gate.is_migrating());
        drop(migration);
    }

    #[tokio::test]
    async fn bounded_acquire_fails_closed_instead_of_blocking() {
        let gate = MigrationGate::with_bound(Duration::from_millis(30));
        let migration = gate.migration_enter().await.unwrap();

        let error = gate
            .writer_enter()
            .await
            .err()
            .expect("the writer acquire must fail closed at its bound");
        assert!(error.to_string().contains("[migration-gate]"), "{error}");

        drop(migration);
    }

    #[tokio::test]
    async fn a_failed_exclusive_acquire_clears_the_fast_path() {
        let gate = MigrationGate::with_bound(Duration::from_millis(30));
        // Hold the shared lock so the exclusive acquire times out.
        let writer = gate.writer_enter().await.unwrap();

        let error = gate
            .migration_enter()
            .await
            .err()
            .expect("the exclusive acquire must time out");
        assert!(error.to_string().contains("[migration-gate]"), "{error}");
        assert!(
            !gate.is_migrating(),
            "a failed acquire must not leave the fast path latched"
        );

        drop(writer);
    }

    /// **R-3.5 hold-scope pin (G-123).** The supervisor acquires the exclusive
    /// barrier BEFORE `run_pre_install` and holds it ACROSS `install_postgres`
    /// (the state.rs call site). Model that exact sequence here: a writer must be
    /// blocked for the WHOLE window — copy/parity AND the engine install — and
    /// unblocked only once the barrier is released after the install.
    #[tokio::test]
    async fn writer_is_blocked_across_the_copy_parity_and_install_window() {
        let gate = MigrationGate::new();

        // Acquire before the leg (state.rs).
        let guard = gate.migration_enter().await.unwrap();

        // ... copy + parity ...
        let blocked_during_leg =
            tokio::time::timeout(Duration::from_millis(40), gate.writer_enter()).await;
        assert!(
            blocked_during_leg.is_err(),
            "a writer must be blocked while the barrier spans copy + parity"
        );

        // ... engine install, STILL under the same exclusive barrier ...
        assert!(
            gate.is_migrating(),
            "the barrier must remain held across the engine install"
        );
        let blocked_during_install =
            tokio::time::timeout(Duration::from_millis(40), gate.writer_enter()).await;
        assert!(
            blocked_during_install.is_err(),
            "a writer must be blocked across the engine install (R-3.5)"
        );

        // Release only AFTER the install; a writer then enters.
        drop(guard);
        assert!(!gate.is_migrating());
        let writer = gate.writer_enter().await.unwrap();
        drop(writer);
    }
}
