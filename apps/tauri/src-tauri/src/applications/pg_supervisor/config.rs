//! Typed app-data config for the embedded-PostgreSQL supervisor
//! (Spec #3022, ST-1).
//!
//! The supervisor is configured from Settings with two values that MUST be
//! readable BEFORE the cluster starts: the bind `port` (ephemeral `None` or a
//! pinned one) and the log verbosity. They cannot live in the PG-backed
//! `AppStore`/`settings` KV — reading the port would require the very cluster the
//! port configures (chicken-and-egg). They therefore live in a small typed JSON
//! file, `<app_data_dir>/postgres-supervisor.json`, written atomically (temp file
//! then rename) and read synchronously on the boot path — the direct precedent of
//! [`crate::infrastructure::storage::boot_config`].
//!
//! # Secrecy (R-3.1/R-3.2)
//!
//! The loopback password is **keychain-only** and is deliberately NOT a field of
//! [`PgSupervisorConfig`] — no password can ever land in this file.
//!
//! # Absent / malformed ⇒ defaults (R-4)
//!
//! A missing, empty, or unparseable file reads as [`PgSupervisorConfig::default`]
//! (`port = None` = ephemeral, `log_verbosity = Info`). A config problem is NEVER
//! a boot failure.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The supervisor-config JSON filename under the app-data dir. Declared in the
/// module root alongside the other path constants and re-exported here so the
/// binding `config::PG_CONFIG_FILENAME` path resolves.
pub use super::PG_CONFIG_FILENAME;

/// Log verbosity for the managed PostgreSQL server. The wire/persisted value IS
/// the PostgreSQL `log_min_messages` string, so the stored config is directly the
/// server value (not a Fredo-specific label): `error` | `warning` | `info` |
/// `debug1` | `debug5`. Default [`Self::Info`] ⇒ `"info"`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum PgLogVerbosity {
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "warning")]
    Warning,
    #[default]
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "debug1")]
    Debug,
    #[serde(rename = "debug5")]
    Trace,
}

impl PgLogVerbosity {
    /// The PostgreSQL `log_min_messages` value this verbosity maps to. This is
    /// also the persisted/wire value, so the config file and the running server
    /// agree by construction.
    pub fn pg_value(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Info => "info",
            Self::Debug => "debug1",
            Self::Trace => "debug5",
        }
    }
}

/// The typed supervisor config persisted to `<app_data_dir>/postgres-supervisor.json`.
///
/// The JSON shape is `{"port": 5433, "logVerbosity": "info"}`; an absent `port`
/// (or `null`) means ephemeral (OS-assigned).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgSupervisorConfig {
    /// Pinned TCP port for the managed cluster; `None` = ephemeral (bind port 0,
    /// OS-assigned).
    #[serde(default)]
    pub port: Option<u16>,
    /// Server log verbosity (persisted as the PostgreSQL `log_min_messages` string).
    #[serde(default)]
    pub log_verbosity: PgLogVerbosity,
}

impl PgSupervisorConfig {
    /// The absolute path of the backing file under `app_data_dir`.
    pub fn path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(PG_CONFIG_FILENAME)
    }

    /// Load the config synchronously, defaulting on an absent/empty/unparseable
    /// file. This NEVER fails — a config problem must not fail the boot path.
    pub fn load(app_data_dir: &Path) -> Self {
        let path = Self::path(app_data_dir);
        let Ok(bytes) = std::fs::read(&path) else {
            // Missing (or unreadable) file ⇒ defaults, never a boot failure.
            return Self::default();
        };
        if bytes.is_empty() {
            return Self::default();
        }
        match serde_json::from_slice::<Self>(&bytes) {
            Ok(config) => config,
            Err(error) => {
                tracing::warn!(
                    target: "fredo::pg_supervisor",
                    path = %path.display(),
                    %error,
                    "postgres-supervisor config is unparseable; using defaults"
                );
                Self::default()
            }
        }
    }

    /// Persist the config with an atomic write (temp file then rename) so a
    /// concurrent reader never observes a partial file.
    pub fn save(app_data_dir: &Path, config: &Self) -> Result<()> {
        let path = Self::path(app_data_dir);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).with_context(|| {
                    format!(
                        "create the postgres-supervisor config dir {}",
                        parent.display()
                    )
                })?;
            }
        }
        let json =
            serde_json::to_vec_pretty(config).context("serialize the postgres-supervisor config")?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).with_context(|| {
            format!(
                "write the postgres-supervisor config temp file {}",
                tmp.display()
            )
        })?;
        std::fs::rename(&tmp, &path).with_context(|| {
            format!(
                "atomically rename {} -> {}",
                tmp.display(),
                path.display()
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_constants_and_defaults_match_the_contract() {
        assert_eq!(PG_CONFIG_FILENAME, "postgres-supervisor.json");
        assert_eq!(PgLogVerbosity::default(), PgLogVerbosity::Info);
        assert_eq!(
            PgSupervisorConfig::default(),
            PgSupervisorConfig {
                port: None,
                log_verbosity: PgLogVerbosity::Info,
            }
        );
    }

    #[test]
    fn pg_value_is_the_postgres_log_min_messages_string() {
        assert_eq!(PgLogVerbosity::Error.pg_value(), "error");
        assert_eq!(PgLogVerbosity::Warning.pg_value(), "warning");
        assert_eq!(PgLogVerbosity::Info.pg_value(), "info");
        assert_eq!(PgLogVerbosity::Debug.pg_value(), "debug1");
        assert_eq!(PgLogVerbosity::Trace.pg_value(), "debug5");
        // The persisted/wire value IS the PG value (QA-4 asserts the persisted unit).
        assert_eq!(
            serde_json::to_string(&PgLogVerbosity::Debug).expect("serialize"),
            "\"debug1\""
        );
    }

    #[test]
    fn load_defaults_when_the_file_is_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            PgSupervisorConfig::load(dir.path()),
            PgSupervisorConfig::default(),
            "an absent file must read as defaults"
        );
    }

    #[test]
    fn load_defaults_when_the_file_is_empty_or_malformed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = PgSupervisorConfig::path(dir.path());

        std::fs::write(&path, b"").expect("write empty");
        assert_eq!(PgSupervisorConfig::load(dir.path()), PgSupervisorConfig::default());

        std::fs::write(&path, b"not json at all").expect("write garbage");
        assert_eq!(PgSupervisorConfig::load(dir.path()), PgSupervisorConfig::default());

        std::fs::write(&path, br#"{"port": 5433, "logVerbosity": "bogus"}"#).expect("write bad enum");
        assert_eq!(
            PgSupervisorConfig::load(dir.path()),
            PgSupervisorConfig::default(),
            "an unmapped verbosity is unparseable ⇒ defaults"
        );
    }

    #[test]
    fn save_then_load_round_trips_the_camel_case_shape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = PgSupervisorConfig {
            port: Some(5433),
            log_verbosity: PgLogVerbosity::Trace,
        };
        PgSupervisorConfig::save(dir.path(), &config).expect("save");

        // The persisted JSON uses the documented camelCase keys + PG value.
        let raw = std::fs::read_to_string(PgSupervisorConfig::path(dir.path())).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(parsed.get("port").and_then(serde_json::Value::as_u64), Some(5433));
        assert_eq!(
            parsed.get("logVerbosity").and_then(serde_json::Value::as_str),
            Some("debug5")
        );

        assert_eq!(PgSupervisorConfig::load(dir.path()), config);
    }

    #[test]
    fn save_then_load_round_trips_the_ephemeral_default() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = PgSupervisorConfig::default();
        PgSupervisorConfig::save(dir.path(), &config).expect("save");
        assert_eq!(PgSupervisorConfig::load(dir.path()), config);
    }

    #[test]
    fn load_tolerates_a_missing_optional_field() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Only the port is present; the verbosity must default.
        std::fs::write(
            PgSupervisorConfig::path(dir.path()),
            br#"{"port": 6543}"#,
        )
        .expect("write partial");
        assert_eq!(
            PgSupervisorConfig::load(dir.path()),
            PgSupervisorConfig {
                port: Some(6543),
                log_verbosity: PgLogVerbosity::Info,
            }
        );
    }

    #[test]
    fn save_never_writes_the_password_and_is_atomic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = PgSupervisorConfig {
            port: Some(1234),
            log_verbosity: PgLogVerbosity::Warning,
        };
        PgSupervisorConfig::save(dir.path(), &config).expect("save");

        // The struct has no password field; the serialized bytes carry only the
        // documented keys. (Structural guard for R-3.1/AC5.)
        let raw = std::fs::read_to_string(PgSupervisorConfig::path(dir.path())).expect("read");
        assert!(raw.contains("\"port\""));
        assert!(raw.contains("\"logVerbosity\""));
        assert!(!raw.contains("password"), "the password is NEVER a field here");
        assert!(!raw.contains("secret"));

        // The atomic write leaves no temp file behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp file must remain: {leftovers:?}");
    }
}
