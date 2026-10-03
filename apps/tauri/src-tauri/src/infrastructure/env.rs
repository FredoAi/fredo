//! infrastructure/env — the ONE authoritative resolver for this process's
//! local test-environment configuration (Spec #2944 ST-1; Names Block G-255).
//!
//! Every dimension of an isolated environment — id, roots, port block, IPC
//! pipe, WebView2 profile dir, app identity and window title — is resolved here
//! from the `FREDO_*` variables, so no consumer re-derives a dimension. When
//! **no** `FREDO_*` variable is set, every value equals the pre-#2944 literal
//! (Vite 5174 / MCP 9223 / OTLP 4317+4318 / llama 8080 /
//! `\\.\pipe\fredo-ipc` / title `Fredo`), so the legacy single-environment path
//! is byte-identical (R-1.1, R-2.2, R-4.1).
//!
//! The resolver is pure: values are read through an injected lookup
//! ([`EnvConfig::resolve_with`]) so tests are deterministic and never mutate
//! the process environment (G-222). [`EnvConfig::from_env`] is the thin
//! production wrapper over the live process environment.

use std::path::PathBuf;

// ── Environment-variable names (Names Block — BINDING) ────────────────────────

/// Environment id (propagated to the app + OpenCode sessions).
pub const ENV_ID_ENV: &str = "FREDO_ENV_ID";
/// Per-environment state root.
pub const ENV_ROOT_ENV: &str = "FREDO_ENV_ROOT";
/// App-data dir (`fredo.db`, `control.db`).
pub const DATA_DIR_ENV: &str = "FREDO_DATA_DIR";
/// Embedded-PostgreSQL data dir.
pub const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
/// Embedded-PostgreSQL lock dir (`postgres.lock`, `headless-ingest.json`).
pub const PG_LOCK_DIR_ENV: &str = "FREDO_PG_LOCK_DIR";
/// Built-in db-client state dir.
pub const DBCLIENT_STATE_DIR_ENV: &str = "FREDO_DBCLIENT_STATE_DIR";
/// Full `fredo` CLI named-pipe name.
pub const CLI_PIPE_ENV: &str = "FREDO_CLI_PIPE";
/// The environment's MCP bridge base port.
pub const MCP_BASE_PORT_ENV: &str = "FREDO_MCP_BASE_PORT";
/// The environment's Vite dev-server port.
pub const VITE_PORT_ENV: &str = "FREDO_VITE_PORT";
/// WebView2 user-data folder for the environment.
pub const WEBVIEW_PROFILE_DIR_ENV: &str = "FREDO_WEBVIEW_PROFILE_DIR";
/// The environment's companion `llama-server` port.
pub const LLAMA_SERVER_PORT_ENV: &str = "FREDO_LLAMA_SERVER_PORT";
/// The environment's companion artifact dir.
pub const LLAMA_SERVER_COMPANION_DIR_ENV: &str = "FREDO_LLAMA_SERVER_COMPANION_DIR";
/// The environment's OTLP/gRPC ingest port (GUI + headless share this name).
pub const INGEST_GRPC_PORT_ENV: &str = "FREDO_INGEST_GRPC_PORT";
/// The environment's OTLP/HTTP ingest port.
pub const INGEST_HTTP_PORT_ENV: &str = "FREDO_INGEST_HTTP_PORT";

// ── Legacy (slot-0) defaults — the pre-#2944 literals ─────────────────────────

/// Default Vite dev-server port.
pub const DEFAULT_VITE_PORT: u16 = 5174;
/// Default MCP bridge base port.
pub const DEFAULT_MCP_PORT: u16 = 9223;
/// Default OTLP/gRPC ingest port.
pub const DEFAULT_INGEST_GRPC_PORT: u16 = 4317;
/// Default OTLP/HTTP ingest port.
pub const DEFAULT_INGEST_HTTP_PORT: u16 = 4318;
/// Default companion `llama-server` port.
pub const DEFAULT_LLAMA_SERVER_PORT: u16 = 8080;

/// Default CLI pipe name (Windows named pipe).
#[cfg(windows)]
pub const DEFAULT_CLI_PIPE: &str = r"\\.\pipe\fredo-ipc";
/// Default CLI socket path (non-Windows).
#[cfg(not(windows))]
pub const DEFAULT_CLI_PIPE: &str = "/tmp/fredo-ipc.sock";

/// Compile-time bundle identifier. Unchanged by #2944: identity isolation is
/// runtime-only (`<BUNDLE_ID>#<envId>` + window title + `FREDO_ENV_ID`).
pub const BUNDLE_ID: &str = "com.fredo.app";
/// Legacy window title (no environment suffix).
pub const DEFAULT_WINDOW_TITLE: &str = "Fredo";

/// The five endpoints that make up an environment's port block.
///
/// Resolved from the `FREDO_*` variables, defaulting to the legacy slot-0
/// values when unset. The slot→block formula (`16000 + 10*(n-1)`) is the
/// dev-env allocator's contract (CU-C); the app only consumes the injected
/// ports, so no dimension is re-derived here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PortBlock {
    /// Vite dev-server port.
    pub vite: u16,
    /// MCP bridge base port.
    pub mcp: u16,
    /// OTLP/gRPC ingest port.
    pub otlp_grpc: u16,
    /// OTLP/HTTP ingest port.
    pub otlp_http: u16,
    /// Companion `llama-server` port.
    pub llama: u16,
}

impl PortBlock {
    /// The legacy slot-0 port block (the pre-#2944 literals).
    pub const LEGACY: PortBlock = PortBlock {
        vite: DEFAULT_VITE_PORT,
        mcp: DEFAULT_MCP_PORT,
        otlp_grpc: DEFAULT_INGEST_GRPC_PORT,
        otlp_http: DEFAULT_INGEST_HTTP_PORT,
        llama: DEFAULT_LLAMA_SERVER_PORT,
    };
}

/// The resolved environment configuration for this process.
///
/// A blank value is treated as unset (the same rule as the existing
/// `FREDO_DATA_DIR` resolver). An unparseable port falls back to its legacy
/// default rather than panicking; the fail-closed port *collision* gate lives
/// in the dev-env allocator (R-4.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvConfig {
    /// Environment id; `None` = the legacy single-environment path.
    pub env_id: Option<String>,
    /// Per-environment state root (`FREDO_ENV_ROOT`).
    pub env_root: Option<PathBuf>,
    /// App-data dir (`FREDO_DATA_DIR`).
    pub data_dir: Option<PathBuf>,
    /// Embedded-PostgreSQL data dir (`FREDO_PG_DATA_DIR`).
    pub pg_data_dir: Option<PathBuf>,
    /// Embedded-PostgreSQL lock dir (`FREDO_PG_LOCK_DIR`).
    pub pg_lock_dir: Option<PathBuf>,
    /// Built-in db-client state dir (`FREDO_DBCLIENT_STATE_DIR`).
    pub dbclient_state_dir: Option<PathBuf>,
    /// CLI named-pipe name — legacy default when unset.
    pub cli_pipe: String,
    /// MCP bridge base port — legacy default when unset.
    pub mcp_base_port: u16,
    /// Vite dev-server port — legacy default when unset.
    pub vite_port: u16,
    /// WebView2 user-data folder (`FREDO_WEBVIEW_PROFILE_DIR`).
    pub webview_profile_dir: Option<PathBuf>,
    /// Companion `llama-server` port — legacy default when unset.
    pub llama_server_port: u16,
    /// Companion artifact dir (`FREDO_LLAMA_SERVER_COMPANION_DIR`).
    pub llama_server_companion_dir: Option<PathBuf>,
    /// OTLP/gRPC ingest port — legacy default when unset.
    pub ingest_grpc_port: u16,
    /// OTLP/HTTP ingest port — legacy default when unset.
    pub ingest_http_port: u16,
}

impl EnvConfig {
    /// Resolve from the live process environment.
    pub fn from_env() -> Self {
        Self::resolve_with(|key| std::env::var(key).ok())
    }

    /// Resolve through an injected lookup (deterministic tests; G-222).
    ///
    /// `get` returns the raw value for a variable name, or `None` when unset.
    pub fn resolve_with(get: impl Fn(&str) -> Option<String>) -> Self {
        let non_blank = |key: &str| -> Option<String> {
            get(key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let path = |key: &str| -> Option<PathBuf> { non_blank(key).map(PathBuf::from) };
        let port = |key: &str, default: u16| -> u16 {
            non_blank(key)
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(default)
        };

        Self {
            env_id: non_blank(ENV_ID_ENV),
            env_root: path(ENV_ROOT_ENV),
            data_dir: path(DATA_DIR_ENV),
            pg_data_dir: path(PG_DATA_DIR_ENV),
            pg_lock_dir: path(PG_LOCK_DIR_ENV),
            dbclient_state_dir: path(DBCLIENT_STATE_DIR_ENV),
            cli_pipe: non_blank(CLI_PIPE_ENV).unwrap_or_else(|| DEFAULT_CLI_PIPE.to_string()),
            mcp_base_port: port(MCP_BASE_PORT_ENV, DEFAULT_MCP_PORT),
            vite_port: port(VITE_PORT_ENV, DEFAULT_VITE_PORT),
            webview_profile_dir: path(WEBVIEW_PROFILE_DIR_ENV),
            llama_server_port: port(LLAMA_SERVER_PORT_ENV, DEFAULT_LLAMA_SERVER_PORT),
            llama_server_companion_dir: path(LLAMA_SERVER_COMPANION_DIR_ENV),
            ingest_grpc_port: port(INGEST_GRPC_PORT_ENV, DEFAULT_INGEST_GRPC_PORT),
            ingest_http_port: port(INGEST_HTTP_PORT_ENV, DEFAULT_INGEST_HTTP_PORT),
        }
    }

    /// `true` when an `FREDO_ENV_ID` is present (isolated env), `false` for the
    /// legacy single-environment path.
    pub fn is_isolated(&self) -> bool {
        self.env_id.is_some()
    }

    /// The window title: `Fredo [<envId>]` for an isolated env, the legacy
    /// `Fredo` when unset (R-2.2).
    pub fn window_title(&self) -> String {
        match &self.env_id {
            Some(id) => format!("Fredo [{id}]"),
            None => DEFAULT_WINDOW_TITLE.to_string(),
        }
    }

    /// The runtime app identity: `com.fredo.app#<envId>` for an isolated env,
    /// the compile-time bundle id `com.fredo.app` when unset (R-2.2).
    pub fn app_identity(&self) -> String {
        match &self.env_id {
            Some(id) => format!("{BUNDLE_ID}#{id}"),
            None => BUNDLE_ID.to_string(),
        }
    }

    /// The environment's resolved port block (five endpoints).
    pub fn port_block(&self) -> PortBlock {
        PortBlock {
            vite: self.vite_port,
            mcp: self.mcp_base_port,
            otlp_grpc: self.ingest_grpc_port,
            otlp_http: self.ingest_http_port,
            llama: self.llama_server_port,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn resolve(pairs: &[(&str, &str)]) -> EnvConfig {
        let map: HashMap<&str, &str> = pairs.iter().copied().collect();
        EnvConfig::resolve_with(|key| map.get(key).map(|value| (*value).to_string()))
    }

    /// ST-1 regression invariant: with no `FREDO_*` set, every resolved value
    /// equals today's literal (byte-identical legacy single-env path).
    #[test]
    fn unset_env_resolves_to_legacy_literals() {
        let env = resolve(&[]);
        assert_eq!(env.env_id, None);
        assert!(!env.is_isolated());
        assert_eq!(env.cli_pipe, DEFAULT_CLI_PIPE);
        assert_eq!(env.mcp_base_port, 9223);
        assert_eq!(env.vite_port, 5174);
        assert_eq!(env.ingest_grpc_port, 4317);
        assert_eq!(env.ingest_http_port, 4318);
        assert_eq!(env.llama_server_port, 8080);
        assert_eq!(env.window_title(), "Fredo");
        assert_eq!(env.app_identity(), "com.fredo.app");
        assert_eq!(env.port_block(), PortBlock::LEGACY);
        assert_eq!(env.env_root, None);
        assert_eq!(env.data_dir, None);
        assert_eq!(env.pg_data_dir, None);
        assert_eq!(env.pg_lock_dir, None);
        assert_eq!(env.dbclient_state_dir, None);
        assert_eq!(env.webview_profile_dir, None);
        assert_eq!(env.llama_server_companion_dir, None);
    }

    /// ST-1: every `FREDO_*` dimension resolves to the injected value.
    #[test]
    fn env_vars_are_resolved() {
        let env = resolve(&[
            (ENV_ID_ENV, "spec2944"),
            (ENV_ROOT_ENV, "C:/repo/.opencode/tmp/envs/spec2944"),
            (DATA_DIR_ENV, "C:/env/data"),
            (PG_DATA_DIR_ENV, "C:/env/postgres"),
            (PG_LOCK_DIR_ENV, "C:/env/lock"),
            (DBCLIENT_STATE_DIR_ENV, "C:/env/dbclient"),
            (CLI_PIPE_ENV, r"\\.\pipe\fredo-ipc-spec2944"),
            (MCP_BASE_PORT_ENV, "16001"),
            (VITE_PORT_ENV, "16000"),
            (WEBVIEW_PROFILE_DIR_ENV, "C:/env/webview"),
            (LLAMA_SERVER_PORT_ENV, "16004"),
            (LLAMA_SERVER_COMPANION_DIR_ENV, "C:/env/companion"),
            (INGEST_GRPC_PORT_ENV, "16002"),
            (INGEST_HTTP_PORT_ENV, "16003"),
        ]);

        assert_eq!(env.env_id.as_deref(), Some("spec2944"));
        assert!(env.is_isolated());
        assert_eq!(
            env.env_root,
            Some(PathBuf::from("C:/repo/.opencode/tmp/envs/spec2944"))
        );
        assert_eq!(env.data_dir, Some(PathBuf::from("C:/env/data")));
        assert_eq!(env.pg_data_dir, Some(PathBuf::from("C:/env/postgres")));
        assert_eq!(env.pg_lock_dir, Some(PathBuf::from("C:/env/lock")));
        assert_eq!(
            env.dbclient_state_dir,
            Some(PathBuf::from("C:/env/dbclient"))
        );
        assert_eq!(env.cli_pipe, r"\\.\pipe\fredo-ipc-spec2944");
        assert_eq!(env.webview_profile_dir, Some(PathBuf::from("C:/env/webview")));
        assert_eq!(
            env.llama_server_companion_dir,
            Some(PathBuf::from("C:/env/companion"))
        );
        assert_eq!(env.window_title(), "Fredo [spec2944]");
        assert_eq!(env.app_identity(), "com.fredo.app#spec2944");
        assert_eq!(
            env.port_block(),
            PortBlock {
                vite: 16000,
                mcp: 16001,
                otlp_grpc: 16002,
                otlp_http: 16003,
                llama: 16004,
            }
        );
    }

    /// ST-1: a blank value is treated as unset (mirrors `resolve_app_data_dir`).
    #[test]
    fn blank_values_fall_back_to_defaults() {
        let env = resolve(&[
            (ENV_ID_ENV, "   "),
            (CLI_PIPE_ENV, "  "),
            (MCP_BASE_PORT_ENV, ""),
            (VITE_PORT_ENV, " "),
        ]);
        assert_eq!(env.env_id, None);
        assert_eq!(env.cli_pipe, DEFAULT_CLI_PIPE);
        assert_eq!(env.mcp_base_port, DEFAULT_MCP_PORT);
        assert_eq!(env.vite_port, DEFAULT_VITE_PORT);
        assert_eq!(env.window_title(), "Fredo");
    }

    /// ST-1: an unparseable/out-of-range port falls back to its legacy default
    /// (never panics, never `unwrap`).
    #[test]
    fn invalid_ports_fall_back_to_defaults() {
        let env = resolve(&[
            (MCP_BASE_PORT_ENV, "not-a-port"),
            (INGEST_GRPC_PORT_ENV, "70000"),
            (INGEST_HTTP_PORT_ENV, "-1"),
            (LLAMA_SERVER_PORT_ENV, "999999"),
        ]);
        assert_eq!(env.mcp_base_port, DEFAULT_MCP_PORT);
        assert_eq!(env.ingest_grpc_port, DEFAULT_INGEST_GRPC_PORT);
        assert_eq!(env.ingest_http_port, DEFAULT_INGEST_HTTP_PORT);
        assert_eq!(env.llama_server_port, DEFAULT_LLAMA_SERVER_PORT);
    }

    /// ST-1: the production entry point reads the process environment without
    /// panicking. Assert only a value that is never blank by construction, so
    /// the pin does not depend on any sibling test's process-global state
    /// (G-222).
    #[test]
    fn from_env_resolves_a_non_blank_pipe() {
        let env = EnvConfig::from_env();
        assert!(!env.cli_pipe.trim().is_empty());
    }
}
