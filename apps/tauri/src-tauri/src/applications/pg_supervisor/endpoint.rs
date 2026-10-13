//! `EmbeddedPgEndpointProvider` adapter over the live [`PgSupervisorState`]
//! (Spec #3029, ST-3).
//!
//! The embedded cluster binds an OS-assigned **ephemeral** loopback port that is
//! published in-memory by [`PgSupervisorState::set_ready`] /
//! [`PgSupervisorState::set_attached`] — it is never written to disk. The
//! db-client must learn it at **connect time**, but `ENGINEERING_RULES` forbids a
//! cross-application import, so this adapter implements the neutral
//! [`EmbeddedPgEndpointProvider`] seam and the composition root (`lib.rs`) wires
//! it onto the managed `DbClientState`.
//!
//! # Secrecy invariant
//!
//! [`endpoint`](EmbeddedPgEndpointProvider::endpoint) carries no secret. The
//! password is resolved from the OS keychain only through
//! [`loopback_password`](EmbeddedPgEndpointProvider::loopback_password) — the
//! same keychain entry (`fredo.postgres` / `loopback:password`) the running
//! server was given — and is never persisted, logged, or sent to the frontend.
//!
//! # Non-goals (ST-3)
//!
//! No supervisor lifecycle / port-policy / config change; no new Tauri command.

use std::sync::Arc;

use crate::infrastructure::storage::embedded_pg::{
    EmbeddedPgEndpoint, EmbeddedPgEndpointProvider,
};

use super::credentials::PgCredential;
use super::state::{PgState, PgSupervisorState};
use super::{DEFAULT_PG_HOST, PG_DATABASE, PG_SUPERUSER};

/// Adapter exposing the live embedded-PostgreSQL endpoint + loopback credential
/// to the db-client through the neutral infrastructure seam.
pub struct PgSupervisorEndpointProvider {
    supervisor: Arc<PgSupervisorState>,
    credential: PgCredential,
}

impl PgSupervisorEndpointProvider {
    /// Build the production adapter over the live supervisor state.
    pub fn new(supervisor: Arc<PgSupervisorState>) -> Self {
        Self {
            supervisor,
            credential: PgCredential::keyring(),
        }
    }

    /// Build an adapter over an explicit credential (test-only) so a unit test
    /// never touches the real `fredo.postgres` keychain entry.
    #[cfg(test)]
    fn with_credential(supervisor: Arc<PgSupervisorState>, credential: PgCredential) -> Self {
        Self {
            supervisor,
            credential,
        }
    }
}

impl EmbeddedPgEndpointProvider for PgSupervisorEndpointProvider {
    fn endpoint(&self) -> Option<EmbeddedPgEndpoint> {
        // The status view IS the live in-memory snapshot `pg_supervisor_status`
        // returns. The bound port is only meaningful while the cluster is
        // serving: `Ready` (this GUI owns the postmaster) or `Attached` (a
        // headless daemon owns it). Any other state (`Starting`/`Failed`/
        // `Disabled`) ⇒ `None`, so a connect fails before the credential path.
        let view = self.supervisor.status.borrow().clone();
        match view.state {
            PgState::Ready | PgState::Attached => view.port.map(|port| EmbeddedPgEndpoint {
                host: DEFAULT_PG_HOST.to_string(),
                port,
                user: PG_SUPERUSER.to_string(),
                database: PG_DATABASE.to_string(),
            }),
            _ => None,
        }
    }

    fn loopback_password(&self) -> Result<Option<String>, String> {
        // Keychain-only (mirrors the supervisor's own `ensure_password`).
        // `resolve()` never fails: on an unavailable keychain it falls back to
        // the documented loopback-only password, warned WITHOUT its value. The
        // password is never persisted or logged here.
        Ok(Some(self.credential.resolve()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::pg_supervisor::credentials::MemoryPgCredential;

    fn supervisor_state() -> Arc<PgSupervisorState> {
        Arc::new(PgSupervisorState::new(
            None,
            None,
            String::from("C:/tmp/fredo-3029-endpoint-test"),
        ))
    }

    fn provider_with_password(
        supervisor: Arc<PgSupervisorState>,
        password: &str,
    ) -> PgSupervisorEndpointProvider {
        PgSupervisorEndpointProvider::with_credential(
            supervisor,
            PgCredential::with_store(Arc::new(MemoryPgCredential::with_password(password))),
        )
    }

    #[test]
    fn endpoint_is_none_while_starting_and_then_reports_the_live_port() {
        let supervisor = supervisor_state();
        let provider = PgSupervisorEndpointProvider::new(supervisor.clone());

        assert_eq!(
            provider.endpoint(),
            None,
            "Starting (no bound port) => None"
        );

        supervisor.set_ready(41234, 4242);
        assert_eq!(
            provider.endpoint(),
            Some(EmbeddedPgEndpoint {
                host: "127.0.0.1".into(),
                port: 41234,
                user: "postgres".into(),
                database: "fredo".into(),
            })
        );
    }

    #[test]
    fn endpoint_re_resolves_a_new_port_across_a_restart() {
        // EARS-6: a restart that binds a NEW port is observed on the next read
        // (no cached/stale port).
        let supervisor = supervisor_state();
        let provider = PgSupervisorEndpointProvider::new(supervisor.clone());

        supervisor.set_ready(40001, 1111);
        let first = provider.endpoint().expect("ready");
        supervisor.set_ready(59999, 2222);
        let second = provider.endpoint().expect("ready");

        assert_eq!(first.port, 40001);
        assert_eq!(second.port, 59999);
        assert_ne!(first.port, second.port);
    }

    #[test]
    fn attached_state_also_publishes_its_live_port() {
        let supervisor = supervisor_state();
        let provider = PgSupervisorEndpointProvider::new(supervisor.clone());

        supervisor.set_attached(60001, 777);
        assert_eq!(provider.endpoint().expect("attached").port, 60001);
    }

    #[test]
    fn failed_state_reports_no_endpoint() {
        let supervisor = supervisor_state();
        let provider = PgSupervisorEndpointProvider::new(supervisor.clone());

        supervisor.fail("start", &anyhow::anyhow!("boom"));
        assert_eq!(
            provider.endpoint(),
            None,
            "Failed (no bound port) => None so the builtin connect fails unreachable"
        );
    }

    #[test]
    fn loopback_password_resolves_from_the_keychain_only() {
        let supervisor = supervisor_state();
        let provider = provider_with_password(supervisor, "stored-loopback-secret");
        assert_eq!(
            provider.loopback_password(),
            Ok(Some("stored-loopback-secret".into()))
        );
    }

    #[test]
    fn loopback_password_never_appears_in_the_endpoint() {
        let supervisor = supervisor_state();
        let provider = provider_with_password(supervisor.clone(), "stored-loopback-secret");
        supervisor.set_ready(41234, 4242);
        // The endpoint type structurally cannot carry the secret.
        let endpoint = provider.endpoint().expect("ready");
        assert_eq!(endpoint.host, "127.0.0.1");
        assert_ne!(endpoint.host, "stored-loopback-secret");
        assert_ne!(endpoint.database, "stored-loopback-secret");
    }
}
