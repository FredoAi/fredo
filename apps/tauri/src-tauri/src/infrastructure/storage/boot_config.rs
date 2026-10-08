//! The ONE synchronous boot KV (Spec #3005, ST-1).
//!
//! PostgreSQL is the ONLY database; the synchronous SQLite control plane is
//! gone. Exactly ONE key must be readable BEFORE PostgreSQL exists: the managed
//! postmaster PID marker. It lives in a small JSON file,
//! `<app_data_dir>/boot-config.json`, with a single documented key
//! [`BOOT_PID_KEY`] (`"postgres_pid"`).
//!
//! The file is read and written SYNCHRONOUSLY (no async-in-sync deadlock) and is
//! the ONLY value outside PostgreSQL: every other setting resolves from the
//! volatile, PG-hydrated in-memory settings cache (see
//! [`super::settings_cache`]).
//!
//! This module also re-homes the ONE app-data-dir resolver
//! ([`resolve_app_data_dir`] + [`DATA_DIR_ENV`]) out of the legacy
//! `storage/migration` tree. Its behavior is byte-identical to the incumbent
//! rule: a non-blank `FREDO_DATA_DIR` override wins (trimmed), else the OS
//! `app_data_dir()`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// The boot-file key holding the managed postmaster PID marker.
pub const BOOT_PID_KEY: &str = "postgres_pid";

/// **G-275** app-data-dir override: when set (non-blank) the app data root is
/// this path instead of the OS `app_data_dir()`. Inert when unset.
pub const DATA_DIR_ENV: &str = "FREDO_DATA_DIR";

/// The boot-config JSON filename under the app-data dir.
pub const BOOT_CONFIG_FILENAME: &str = "boot-config.json";

/// The ONE app-data-dir resolver (**G-275**): the non-blank [`DATA_DIR_ENV`]
/// override when set, else the OS `app_data_dir()`.
///
/// Injected at `lib.rs` in place of the hardcoded `app.path().app_data_dir()`;
/// every consumer resolves the SAME dir through this one rule.
pub fn resolve_app_data_dir(os_app_data_dir: &Path) -> PathBuf {
    match std::env::var(DATA_DIR_ENV) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => os_app_data_dir.to_path_buf(),
    }
}

/// A synchronous JSON key-value file (`<app_data_dir>/boot-config.json`).
///
/// The ONLY pre-PostgreSQL store. `get`/`set` are synchronous; `set` performs an
/// atomic write (temp file then rename). An absent, empty, or unparseable file
/// reads as empty, and an empty value clears its key ("absent/empty => cleared").
pub struct BootConfig {
    path: PathBuf,
}

impl BootConfig {
    /// Open (or target) `<app_data_dir>/boot-config.json`. The file is created
    /// lazily on the first [`Self::set`]; `open` never fails for a missing file.
    pub fn open(app_data_dir: &Path) -> Result<Self> {
        Ok(Self {
            path: app_data_dir.join(BOOT_CONFIG_FILENAME),
        })
    }

    /// The absolute path of the backing file (test/diagnostic surface).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read one boot key synchronously. An absent/empty value yields `None`
    /// (never `Some("")`).
    pub fn get(&self, key: &str) -> Option<String> {
        self.read_map().remove(key).filter(|value| !value.is_empty())
    }

    /// Upsert one boot key, or clear it when `value` is empty, with an atomic
    /// write (temp file then rename) so a concurrent reader never sees a partial
    /// file.
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let mut map = self.read_map();
        if value.is_empty() {
            map.remove(key);
        } else {
            map.insert(key.to_string(), value.to_string());
        }
        self.write_map(&map)
    }

    /// Read the backing map; a missing/empty/unparseable file is empty.
    fn read_map(&self) -> HashMap<String, String> {
        let Ok(bytes) = std::fs::read(&self.path) else {
            return HashMap::new();
        };
        if bytes.is_empty() {
            return HashMap::new();
        }
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    /// Atomically write the backing map.
    fn write_map(&self, map: &HashMap<String, String>) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("create the boot-config dir {}", parent.display()))?;
            }
        }
        let json = serde_json::to_vec(map).context("serialize the boot config")?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, &json)
            .with_context(|| format!("write the boot-config temp file {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).with_context(|| {
            format!(
                "atomically rename {} -> {}",
                tmp.display(),
                self.path.display()
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serializes the tests that mutate process-global environment variables.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard(&'static str);

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    fn set_env(key: &'static str, value: &str) -> EnvGuard {
        std::env::set_var(key, value);
        EnvGuard(key)
    }

    fn unset_env(key: &'static str) -> EnvGuard {
        std::env::remove_var(key);
        EnvGuard(key)
    }

    #[test]
    fn resolve_app_data_dir_prefers_a_non_blank_override() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let os = Path::new("C:/os/appdata");
        {
            let _g = unset_env(DATA_DIR_ENV);
            assert_eq!(resolve_app_data_dir(os), PathBuf::from(os));
        }
        {
            let _g = set_env(DATA_DIR_ENV, "  ");
            assert_eq!(
                resolve_app_data_dir(os),
                PathBuf::from(os),
                "a blank override is inert"
            );
        }
        {
            let _g = set_env(DATA_DIR_ENV, "  C:/fixture  ");
            assert_eq!(
                resolve_app_data_dir(os),
                PathBuf::from("C:/fixture"),
                "a non-blank override wins (trimmed)"
            );
        }
    }

    #[test]
    fn boot_key_is_postgres_pid() {
        assert_eq!(BOOT_PID_KEY, "postgres_pid");
        assert_eq!(BOOT_CONFIG_FILENAME, "boot-config.json");
        assert_eq!(DATA_DIR_ENV, "FREDO_DATA_DIR");
    }

    #[test]
    fn boot_config_round_trips_and_clears_a_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let boot = BootConfig::open(dir.path()).expect("open boot config");

        // Absent => None.
        assert_eq!(boot.get(BOOT_PID_KEY), None);

        boot.set(BOOT_PID_KEY, "4242").expect("set pid");
        assert_eq!(boot.get(BOOT_PID_KEY), Some("4242".to_string()));
        assert!(
            dir.path().join(BOOT_CONFIG_FILENAME).exists(),
            "the boot file is materialized on first set"
        );

        // An empty value clears the key.
        boot.set(BOOT_PID_KEY, "").expect("clear pid");
        assert_eq!(boot.get(BOOT_PID_KEY), None);
    }

    #[test]
    fn boot_config_reads_a_missing_or_empty_file_as_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let boot = BootConfig::open(dir.path()).expect("open boot config");

        // Missing file.
        assert_eq!(boot.get(BOOT_PID_KEY), None);

        // Empty file.
        std::fs::write(dir.path().join(BOOT_CONFIG_FILENAME), b"").expect("write empty");
        assert_eq!(boot.get(BOOT_PID_KEY), None);

        // Unparseable file.
        std::fs::write(dir.path().join(BOOT_CONFIG_FILENAME), b"not json").expect("write garbage");
        assert_eq!(boot.get(BOOT_PID_KEY), None);
    }

    #[test]
    fn boot_config_preserves_unknown_keys_across_a_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let boot = BootConfig::open(dir.path()).expect("open boot config");

        boot.set("other", "kept").expect("set other");
        boot.set(BOOT_PID_KEY, "777").expect("set pid");
        assert_eq!(boot.get("other"), Some("kept".to_string()));
        assert_eq!(boot.get(BOOT_PID_KEY), Some("777".to_string()));
    }

    #[test]
    fn boot_config_writes_valid_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let boot = BootConfig::open(dir.path()).expect("open boot config");
        boot.set(BOOT_PID_KEY, "1234").expect("set pid");

        let raw = std::fs::read_to_string(dir.path().join(BOOT_CONFIG_FILENAME)).expect("read");
        let parsed: HashMap<String, String> = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(parsed.get(BOOT_PID_KEY).map(String::as_str), Some("1234"));
    }
}
