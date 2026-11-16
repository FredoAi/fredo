//! Embedded-PostgreSQL endpoint + loopback-credential seam (Spec #3029, ST-1).
//!
//! This module is the **neutral infrastructure channel** through which the
//! db-client application learns the live embedded cluster's endpoint and its
//! loopback password. It exists because `ENGINEERING_RULES` forbids a
//! cross-application import (`applications::db_client` must NOT `use`
//! `applications::pg_supervisor`), and because the endpoint is only known at
//! **connect time**: the port is OS-assigned ephemeral and published in-memory by
//! the supervisor (`set_ready`/`set_attached`) — never written to disk.
//!
//! The trait is *implemented* by `applications::pg_supervisor::endpoint` over its
//! live state and *consumed* by `applications::db_client::connect`; the
//! composition root (`lib.rs`) wires the two, so state stays in the application
//! module (AGENTS) and the secret stays in `pg_supervisor`.
//!
//! # Secrecy invariant
//!
//! [`EmbeddedPgEndpoint`] carries **no secret**. The password crosses this seam
//! only through [`EmbeddedPgEndpointProvider::loopback_password`], which resolves
//! it from the OS keychain at connect time; it is never persisted, logged, or
//! returned to the frontend.
//!
//! # Non-goals (ST-1)
//!
//! No behavior change: nothing consumes the trait yet, no managed state is read
//! here, and `PgCredential` stays in `pg_supervisor`. No new Tauri command.

use std::sync::Arc;

/// The live loopback endpoint of the embedded PostgreSQL cluster.
///
/// `host` is always the loopback address (never `0.0.0.0`); `port` is the port
/// the cluster is CURRENTLY bound to (ephemeral, hence resolved per connect).
/// This type deliberately has **no password field**.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddedPgEndpoint {
    /// The loopback bind host (e.g. `127.0.0.1`).
    pub host: String,
    /// The currently bound ephemeral port.
    pub port: u16,
    /// The database role to connect as.
    pub user: String,
    /// The application database to connect to.
    pub database: String,
}

/// The neutral seam by which the db-client learns the embedded endpoint +
/// loopback credential.
///
/// Implemented by the pg_supervisor over its live state; consumed by the
/// db-client at connect time. `Send + Sync` so it can be installed on the
/// Tauri-managed db-client state.
pub trait EmbeddedPgEndpointProvider: Send + Sync {
    /// The live endpoint while the cluster is `Ready`/`Attached`; `None`
    /// otherwise (boot in progress, failed, or no managed supervisor).
    fn endpoint(&self) -> Option<EmbeddedPgEndpoint>;

    /// The loopback password from the OS keychain (mirrors the supervisor's own
    /// resolution). `Ok(None)` when no secret is stored; `Err` when the store is
    /// unavailable. The value is NEVER persisted or logged by this seam.
    fn loopback_password(&self) -> Result<Option<String>, String>;
}

/// Tauri-managed handle wrapping the provider (Spec #3029).
///
/// The composition root may `app.manage` this alongside (or instead of) wiring
/// the provider onto the db-client state; it exists so the seam has a single
/// managed-state home if a future consumer needs to resolve the endpoint
/// without the db-client state.
pub struct EmbeddedPgEndpointState(pub Arc<dyn EmbeddedPgEndpointProvider>);

impl EmbeddedPgEndpointState {
    /// The wrapped provider.
    pub fn provider(&self) -> Arc<dyn EmbeddedPgEndpointProvider> {
        self.0.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic in-memory provider: a fixed endpoint (or `None`) and a
    /// fixed password (`Ok(Some(_))`, `Ok(None)`, or `Err`).
    struct FakeProvider {
        endpoint: Option<EmbeddedPgEndpoint>,
        password: Result<Option<String>, String>,
    }

    impl EmbeddedPgEndpointProvider for FakeProvider {
        fn endpoint(&self) -> Option<EmbeddedPgEndpoint> {
            self.endpoint.clone()
        }

        fn loopback_password(&self) -> Result<Option<String>, String> {
            self.password.clone()
        }
    }

    fn sample_endpoint() -> EmbeddedPgEndpoint {
        EmbeddedPgEndpoint {
            host: "127.0.0.1".into(),
            port: 41234,
            user: "postgres".into(),
            database: "fredo".into(),
        }
    }

    #[test]
    fn endpoint_carries_no_secret_and_is_copyable_by_value() {
        let endpoint = sample_endpoint();
        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.port, 41234);
        // The struct is `PartialEq`/`Eq`/`Clone` so a live snapshot can be
        // compared and re-read without mutation.
        assert_eq!(endpoint.clone(), endpoint);
    }

    #[test]
    fn provider_seam_round_trips_the_endpoint_and_password() {
        let provider = FakeProvider {
            endpoint: Some(sample_endpoint()),
            password: Ok(Some("loopback-secret".into())),
        };
        assert_eq!(provider.endpoint(), Some(sample_endpoint()));
        assert_eq!(
            provider.loopback_password(),
            Ok(Some("loopback-secret".into()))
        );
    }

    #[test]
    fn a_not_ready_provider_reports_no_endpoint() {
        let provider = FakeProvider {
            endpoint: None,
            password: Ok(None),
        };
        assert_eq!(provider.endpoint(), None);
        assert_eq!(provider.loopback_password(), Ok(None));
    }

    #[test]
    fn the_state_handle_returns_the_wrapped_provider() {
        let state = EmbeddedPgEndpointState(Arc::new(FakeProvider {
            endpoint: Some(sample_endpoint()),
            password: Ok(Some("pw".into())),
        }));
        let provider = state.provider();
        assert_eq!(provider.endpoint(), Some(sample_endpoint()));
        assert_eq!(provider.loopback_password(), Ok(Some("pw".into())));
    }
}
