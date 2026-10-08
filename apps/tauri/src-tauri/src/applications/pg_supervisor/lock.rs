//! Exclusive PostgreSQL data-dir lock (Spec #2974, ST-2).
//!
//! R-4.5: WHILE the app owns the PostgreSQL data dir, a second supervisor MUST
//! NOT sweep or start a postmaster against it. The ported orphan sweep KILLS a
//! live `postgres.exe` named by the marker, so under two concurrent Fredo
//! launches a second instance's sweep would otherwise kill the first instance's
//! running postmaster. The lock is therefore acquired BEFORE any sweep and held
//! for the app lifetime; a second instance fails to acquire it and starts
//! nothing.
//!
//! This is deliberately NOT a full "attach or refuse" single-instance guard —
//! it only makes the data dir exclusive.

use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::{resolve_lock_dir, PG_LOCK_FILENAME};

/// An exclusive lock on the PostgreSQL data dir, held for the app lifetime.
pub struct PgDataDirLock {
    /// The open handle whose share mode makes the lock exclusive. Held (never
    /// read) so the platform handle stays open for as long as the lock lives.
    _file: File,
    path: PathBuf,
}

impl PgDataDirLock {
    /// Acquire the exclusive lock at `<lock_dir>/postgres.lock`, where
    /// `lock_dir` is [`resolve_lock_dir(app_data_dir)`](super::resolve_lock_dir)
    /// — the **G-275** `FREDO_PG_LOCK_DIR` override when set, else
    /// `app_data_dir` (so the default path is byte-identical when unset).
    ///
    /// Windows opens the file with `share_mode(0)`, so ANY second opener — a
    /// second Fredo process, or a second supervisor in the same process — gets a
    /// sharing violation. The caller MUST acquire this BEFORE any sweep or
    /// postmaster start (R-4.5).
    pub fn acquire(app_data_dir: &Path) -> Result<Self> {
        Self::acquire_in(&resolve_lock_dir(app_data_dir))
    }

    /// Acquire the exclusive lock at an explicit `lock_dir` (Spec #2992 CU-1):
    /// the caller-controlled seam the headless daemon and QA induction use
    /// (G-275), so the lock is drivable under a scratch dir. The lock file is
    /// always `<lock_dir>/<PG_LOCK_FILENAME>`.
    pub fn acquire_in(lock_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(lock_dir)
            .with_context(|| format!("create lock dir {}", lock_dir.display()))?;
        let path = lock_dir.join(PG_LOCK_FILENAME);

        #[cfg(target_os = "windows")]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .share_mode(0)
                .open(&path)
                .with_context(|| format!("acquire exclusive lock {}", path.display()))?
        };
        #[cfg(not(target_os = "windows"))]
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("acquire lock {}", path.display()))?;

        Ok(Self { _file: file, path })
    }

    /// The lock-file path.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_points_at_the_lock_file_under_the_app_data_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock = PgDataDirLock::acquire(dir.path()).expect("acquire lock");

        assert_eq!(lock.path(), dir.path().join(PG_LOCK_FILENAME).as_path());
    }

    /// CU-1/ST-1 (G-275): `acquire_in` places the lock under the caller-supplied
    /// directory and creates it when absent, so QA can drive the lock under
    /// `.opencode/tmp/<N>/` without touching the OS app-data dir.
    #[test]
    fn acquire_in_places_the_lock_in_the_caller_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock_dir = dir.path().join("custom-lock");
        let lock = PgDataDirLock::acquire_in(&lock_dir).expect("acquire in a custom dir");

        assert!(lock_dir.exists(), "the lock dir is created");
        assert_eq!(lock.path(), lock_dir.join(PG_LOCK_FILENAME).as_path());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_second_acquire_in_the_same_dir_fails_while_held() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = PgDataDirLock::acquire_in(dir.path()).expect("first acquire");

        assert!(
            PgDataDirLock::acquire_in(dir.path()).is_err(),
            "a second acquire_in must fail while the lock is held"
        );

        drop(first);
        assert!(PgDataDirLock::acquire_in(dir.path()).is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_second_acquire_on_the_same_data_dir_fails_while_held() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = PgDataDirLock::acquire(dir.path()).expect("first acquire");

        assert!(
            PgDataDirLock::acquire(dir.path()).is_err(),
            "a second supervisor must fail to acquire the data-dir lock (R-4.5)"
        );

        drop(first);
        assert!(
            PgDataDirLock::acquire(dir.path()).is_ok(),
            "the lock is released when the holder is dropped"
        );
    }
}
