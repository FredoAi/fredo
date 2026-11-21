//! Cluster-directory isolation, residue quarantine, and log-directory resolution
//! (Spec #3180 ST-1).
//!
//! # The defect this module closes
//!
//! `initdb` targets one directory. Before this slice that target was
//! `<app_data_dir>/postgres` — the same directory Fredo writes
//! `log/postgres.log` into and the crate writes `start.log` into. Those files are
//! created only AFTER a successful `setup()`+`start()`, so a clean profile works
//! while a REINSTALL (cluster deleted, residue left behind) leaves a non-empty
//! directory that `initdb` refuses forever — the reported "directory exists but is
//! not empty" class.
//!
//! The structural fix is to give the cluster its own dedicated directory
//! (`<app_data_dir>/postgres/cluster`) and move the postmaster log to a SIBLING
//! (`<app_data_dir>/postgres/log`). Nothing else is ever written into the cluster
//! path, so the class cannot recur from Fredo's own writes.
//!
//! Two recovery paths keep that true for an existing profile:
//!
//! * a LEGACY cluster at `<app_data_dir>/postgres` (recognised by
//!   [`PG_CLUSTER_MARKER`] — `postgresql.conf`, the crate's own
//!   `is_initialized()` predicate) is used as-is and never re-initialised;
//! * RESIDUE at the dedicated path (exists, non-empty, no cluster marker) is
//!   quarantined by RENAME to a timestamped sibling — never deleted.
//!
//! `FREDO_PG_DATA_DIR` keeps its exact semantics: when set (non-blank) it wins
//! verbatim, so every isolated-env and QA seam keeps meaning.
//!
//! # Crate-predicate parity
//!
//! `postgresql_embedded`'s `PostgreSQL::is_initialized()` is literally
//! `data_dir/postgresql.conf exists`. Our [`inspect_cluster_dir`] MUST use the
//! same predicate (not `PG_VERSION`), or our carve-out and the crate's `initdb`
//! decision could disagree — we would skip quarantine for a directory the crate
//! would then refuse. [`cluster_state_uses_the_crate_marker_not_pg_version`]
//! pins that parity.

use std::path::{Path, PathBuf};

use super::{PG_DATA_SUBDIR, PG_LOG_SUBDIR};

/// Dedicated cluster subdirectory under the supervisor home
/// (`<app_data_dir>/postgres/cluster`). `initdb` targets exactly this directory.
pub const PG_CLUSTER_SUBDIR: &str = "cluster";

/// Quarantine prefix for a residue directory that could not be initialised
/// (`<cluster>` -> `<cluster>.rejected-<unix_ts>`). The quarantine is a RENAME,
/// never a delete.
pub const PG_REJECT_PREFIX: &str = "cluster.rejected-";

/// **G-275** injectable fault seam (Spec #3180 ST-1): when set to a non-blank
/// value other than `0`/`false`, [`ensure_initialisable`] REFUSES to quarantine a
/// residue directory and surfaces the typed [`ClusterDirError`] instead, so the
/// fail-closed `DataDirNotEmpty` leg is drivable in-repo (the AC-5 Postgres
/// receipt). Inert when unset — the default recovery path is byte-identical.
pub const PG_CLUSTER_QUARANTINE_FAIL_ENV: &str = "FREDO_PG_CLUSTER_QUARANTINE_FAIL";

/// The crate's own initialised-cluster predicate: `postgresql.conf` at the
/// cluster root. MUST equal `postgresql_embedded`'s `is_initialized()` — see the
/// module docs. `PG_VERSION` alone is NOT a cluster (it is written by `initdb`
/// but the crate does not use it as the initialised test).
const PG_CLUSTER_MARKER: &str = "postgresql.conf";

/// The three-way (four-state) classification of a resolved cluster directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClusterDirState {
    /// The directory does not exist — `initdb` will create it.
    Absent,
    /// The directory exists and is empty — `initdb` may initialise it.
    Empty,
    /// The directory is an initialised cluster ([`PG_CLUSTER_MARKER`] present).
    Cluster,
    /// The directory exists, is non-empty, and is NOT an initialised cluster —
    /// residue that must be quarantined before `initdb` can run.
    Residue,
}

/// A cluster directory that cannot be initialised and could not be quarantined.
///
/// Carried as a concrete error type so [`super::state::classify_failure`] can
/// downcast it from the error chain and publish the typed
/// `PgFailureKind::DataDirNotEmpty` (rather than the non-actionable `Unknown`).
#[derive(Debug)]
pub struct ClusterDirError {
    /// The cluster directory that blocked initialisation.
    pub path: PathBuf,
    /// The state observed at that path.
    pub state: ClusterDirState,
}

impl std::fmt::Display for ClusterDirError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "the PostgreSQL cluster directory {} is not empty and could not be quarantined (state: {:?}); \
             move or rename it, then restart Fredo",
            self.path.display(),
            self.state
        )
    }
}

impl std::error::Error for ClusterDirError {}

/// Resolve the directory `initdb` targets (see [`resolve_cluster_dir_from`]).
///
/// Precedence:
/// 1. a non-blank `FREDO_PG_DATA_DIR` (verbatim — the FS-1 override);
/// 2. the LEGACY `<app_data_dir>/postgres` when it already holds a cluster
///    ([`PG_CLUSTER_MARKER`] present);
/// 3. the dedicated `<app_data_dir>/postgres/cluster`.
pub fn resolve_cluster_dir(app_data_dir: &Path) -> PathBuf {
    resolve_cluster_dir_from(
        std::env::var(super::PG_DATA_DIR_ENV).ok().as_deref(),
        app_data_dir,
    )
}

/// The pure cluster-dir rule (split out so the precedence contract is
/// unit-testable without mutating process-global environment state, G-222).
fn resolve_cluster_dir_from(override_value: Option<&str>, app_data_dir: &Path) -> PathBuf {
    if let Some(value) = override_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let supervisor_home = app_data_dir.join(PG_DATA_SUBDIR);
    if supervisor_home.join(PG_CLUSTER_MARKER).is_file() {
        return supervisor_home;
    }
    supervisor_home.join(PG_CLUSTER_SUBDIR)
}

/// Resolve the postmaster LOG directory.
///
/// `<override>/log` when the FS-1 `FREDO_PG_DATA_DIR` override is set (so the log
/// stays a sibling of an override cluster exactly as before), else the dedicated
/// `<app_data_dir>/postgres/log` — a SIBLING of the cluster dir, never inside it.
pub fn resolve_log_dir(app_data_dir: &Path) -> PathBuf {
    resolve_log_dir_from(
        std::env::var(super::PG_DATA_DIR_ENV).ok().as_deref(),
        app_data_dir,
    )
}

/// The pure log-dir rule (G-222 — no process-global env mutation in tests).
fn resolve_log_dir_from(override_value: Option<&str>, app_data_dir: &Path) -> PathBuf {
    match override_value {
        Some(value) if !value.trim().is_empty() => {
            PathBuf::from(value.trim()).join(PG_LOG_SUBDIR)
        }
        _ => app_data_dir.join(PG_DATA_SUBDIR).join(PG_LOG_SUBDIR),
    }
}

/// Classify `dir` WITHOUT mutating it (pure read). See [`ClusterDirState`].
pub fn inspect_cluster_dir(dir: &Path) -> ClusterDirState {
    if !dir.exists() {
        return ClusterDirState::Absent;
    }
    if dir.join(PG_CLUSTER_MARKER).is_file() {
        return ClusterDirState::Cluster;
    }
    match std::fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_none() {
                ClusterDirState::Empty
            } else {
                ClusterDirState::Residue
            }
        }
        // An unreadable non-directory (or an unreadable directory) is not
        // initialisable: treat it as residue so the quarantine path (rename, no
        // delete) handles it — never a silent `initdb` refusal.
        Err(_) => ClusterDirState::Residue,
    }
}

/// Make `dir` safe for `initdb` without ever deleting user files.
///
/// * `Absent` / `Empty` / `Cluster` -> `Ok(())`, nothing touched.
/// * `Residue` -> quarantine by RENAME (see [`quarantine_cluster_dir`]), `Ok(())`.
/// * any failure (including the [`PG_CLUSTER_QUARANTINE_FAIL_ENV`] seam) ->
///   [`ClusterDirError`].
///
/// This is the SINGLE choke point every owner path reaches through
/// [`super::runtime::PgRuntime::setup`] (GUI boot, config-apply restart, headless
/// `fredo ingest`), so the recovery is never path-specific.
pub fn ensure_initialisable(dir: &Path) -> anyhow::Result<()> {
    ensure_initialisable_with(
        dir,
        quarantine_fail_enabled(),
        now_unix_secs(),
    )
}

/// The pure recovery rule (G-222): the seam flag and the timestamp are injected
/// so both branches are unit-testable without mutating process-global state.
fn ensure_initialisable_with(
    dir: &Path,
    refuse_quarantine: bool,
    at_unix_secs: u64,
) -> anyhow::Result<()> {
    if inspect_cluster_dir(dir) != ClusterDirState::Residue {
        return Ok(());
    }
    if refuse_quarantine {
        return Err(anyhow::Error::new(ClusterDirError {
            path: dir.to_path_buf(),
            state: ClusterDirState::Residue,
        }));
    }
    match quarantine_cluster_dir(dir, at_unix_secs) {
        Ok(_target) => Ok(()),
        Err(source) => {
            // The io detail is logged; the caller sees the typed error so the
            // failure classifies as `DataDirNotEmpty` (never a bare `Unknown`).
            tracing::warn!(
                target: "fredo::pg_supervisor",
                path = %dir.display(),
                error = %source,
                "could not quarantine the non-empty cluster directory"
            );
            Err(anyhow::Error::new(ClusterDirError {
                path: dir.to_path_buf(),
                state: ClusterDirState::Residue,
            }))
        }
    }
}

/// Quarantine `dir` by renaming it to a timestamped sibling — NEVER a delete.
///
/// `<cluster>` becomes `<cluster>.rejected-<at_unix_secs>`; any other directory
/// name keeps its name with the same `.rejected-<ts>` suffix
/// (`<override>.rejected-<ts>`). Returns the quarantine path.
pub fn quarantine_cluster_dir(dir: &Path, at_unix_secs: u64) -> anyhow::Result<PathBuf> {
    let name = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| PG_CLUSTER_SUBDIR.to_string());
    // The default cluster name uses the binding prefix; any other name keeps its
    // own name and gains the same suffix.
    let rejected = if name == PG_CLUSTER_SUBDIR {
        format!("{PG_REJECT_PREFIX}{at_unix_secs}")
    } else {
        format!("{name}.rejected-{at_unix_secs}")
    };
    let target = dir.with_file_name(rejected);
    std::fs::rename(dir, &target).map_err(|source| {
        anyhow::Error::new(source).context(format!(
            "quarantining {} -> {}",
            dir.display(),
            target.display()
        ))
    })?;
    Ok(target)
}

/// Resolve the **`FREDO_PG_CLUSTER_QUARANTINE_FAIL`** seam (mirrors the other
/// G-275 levers): `true` when the env var is set to a non-blank value other than
/// `0`/`false`, else `false`. Inert by default.
fn quarantine_fail_enabled() -> bool {
    quarantine_fail_with(std::env::var(PG_CLUSTER_QUARANTINE_FAIL_ENV).ok().as_deref())
}

/// The pure seam rule (G-222).
fn quarantine_fail_with(value: Option<&str>) -> bool {
    match value {
        Some(value) => {
            let raw = value.trim();
            !raw.is_empty() && !raw.eq_ignore_ascii_case("0") && !raw.eq_ignore_ascii_case("false")
        }
        None => false,
    }
}

/// The wall-clock timestamp used in a quarantine directory name.
fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_cluster(dir: &Path) {
        std::fs::create_dir_all(dir).expect("create cluster dir");
        std::fs::write(dir.join(PG_CLUSTER_MARKER), "# initialized\n").expect("seed marker");
    }

    fn seed_residue(dir: &Path) {
        std::fs::create_dir_all(dir.join("log")).expect("create residue log dir");
        std::fs::write(dir.join("start.log"), b"crate start log").expect("seed start.log");
        std::fs::write(dir.join("log").join("postgres.log"), b"fredo postmaster log")
            .expect("seed postmaster log");
    }

    /// The three layouts the resolver must distinguish, driven through the PURE
    /// helper so a sibling test's process env can never leak in (G-222):
    /// absent/clean -> `postgres/cluster`; dirty residue at the new path -> still
    /// `postgres/cluster`; a legacy cluster at `postgres` -> `postgres` verbatim.
    #[test]
    fn resolve_cluster_dir_covers_absent_residue_and_legacy_layouts() {
        let root = tempfile::tempdir().expect("tempdir");
        let app_data_dir = root.path();

        // Absent: nothing on disk yet.
        assert_eq!(
            resolve_cluster_dir_from(None, app_data_dir),
            app_data_dir.join(PG_DATA_SUBDIR).join(PG_CLUSTER_SUBDIR),
            "an absent profile must resolve the dedicated cluster path"
        );

        // Dirty residue at the NEW path does not change the resolved path (it is
        // quarantined there by `ensure_initialisable`).
        seed_residue(&app_data_dir.join(PG_DATA_SUBDIR).join(PG_CLUSTER_SUBDIR));
        assert_eq!(
            resolve_cluster_dir_from(None, app_data_dir),
            app_data_dir.join(PG_DATA_SUBDIR).join(PG_CLUSTER_SUBDIR),
            "residue at the dedicated path resolves to the dedicated path"
        );

        // Legacy: `<app_data_dir>/postgres` holds a cluster -> used verbatim.
        let legacy_root = tempfile::tempdir().expect("tempdir");
        seed_cluster(&legacy_root.path().join(PG_DATA_SUBDIR));
        assert_eq!(
            resolve_cluster_dir_from(None, legacy_root.path()),
            legacy_root.path().join(PG_DATA_SUBDIR),
            "a legacy cluster at <app_data_dir>/postgres must be preserved verbatim"
        );

        // The override always wins, verbatim, whatever is on disk.
        assert_eq!(
            resolve_cluster_dir_from(Some("D:/custom/pgdata"), legacy_root.path()),
            PathBuf::from("D:/custom/pgdata"),
            "FREDO_PG_DATA_DIR wins verbatim"
        );
        assert_eq!(
            resolve_cluster_dir_from(Some("  D:/trimmed  "), app_data_dir),
            PathBuf::from("D:/trimmed"),
            "the override is trimmed"
        );
        assert_eq!(
            resolve_cluster_dir_from(Some(""), legacy_root.path()),
            legacy_root.path().join(PG_DATA_SUBDIR),
            "a blank override is inert (legacy carve-out still applies)"
        );
        assert_eq!(
            resolve_cluster_dir_from(Some("   "), app_data_dir),
            app_data_dir.join(PG_DATA_SUBDIR).join(PG_CLUSTER_SUBDIR),
            "a blank override is inert (default layout)"
        );
    }

    /// The log dir is the relocated SIBLING: `<app>/postgres/log` by default and
    /// `<override>/log` under the override — never inside the cluster dir.
    #[test]
    fn resolve_log_dir_is_the_sibling_log_directory() {
        let app_data_dir = Path::new("C:/app-data");
        assert_eq!(
            resolve_log_dir_from(None, app_data_dir),
            app_data_dir.join(PG_DATA_SUBDIR).join(PG_LOG_SUBDIR),
            "default: <app_data_dir>/postgres/log"
        );
        assert_eq!(
            resolve_log_dir_from(Some(""), app_data_dir),
            app_data_dir.join(PG_DATA_SUBDIR).join(PG_LOG_SUBDIR),
            "blank override is inert"
        );
        assert_eq!(
            resolve_log_dir_from(Some("D:/custom/pgdata"), app_data_dir),
            PathBuf::from("D:/custom/pgdata").join(PG_LOG_SUBDIR),
            "override: <override>/log (byte-identical FREDO_PG_DATA_DIR semantics)"
        );
        // The relocated log is NOT under the default cluster dir.
        assert_ne!(
            resolve_log_dir_from(None, app_data_dir),
            app_data_dir
                .join(PG_DATA_SUBDIR)
                .join(PG_CLUSTER_SUBDIR)
                .join(PG_LOG_SUBDIR),
            "the log must never live inside the initdb target"
        );
    }

    /// `Cluster` is the crate's `postgresql.conf` predicate — a directory holding
    /// only `PG_VERSION` is RESIDUE, exactly as the crate would refuse to treat it
    /// as initialised and run `initdb` again.
    #[test]
    fn cluster_state_uses_the_crate_marker_not_pg_version() {
        let root = tempfile::tempdir().expect("tempdir");

        let absent = root.path().join("absent");
        assert_eq!(inspect_cluster_dir(&absent), ClusterDirState::Absent);

        let empty = root.path().join("empty");
        std::fs::create_dir_all(&empty).expect("create empty");
        assert_eq!(inspect_cluster_dir(&empty), ClusterDirState::Empty);

        let version_only = root.path().join("version-only");
        std::fs::create_dir_all(&version_only).expect("create version-only");
        std::fs::write(version_only.join("PG_VERSION"), "18\n").expect("seed PG_VERSION");
        assert_eq!(
            inspect_cluster_dir(&version_only),
            ClusterDirState::Residue,
            "PG_VERSION alone is NOT the crate's initialised predicate"
        );

        let cluster = root.path().join("cluster");
        seed_cluster(&cluster);
        assert_eq!(inspect_cluster_dir(&cluster), ClusterDirState::Cluster);

        let residue = root.path().join("residue");
        seed_residue(&residue);
        assert_eq!(inspect_cluster_dir(&residue), ClusterDirState::Residue);
    }

    /// Quarantine RENAMES the directory and preserves every byte; the original
    /// path is gone and the timestamped sibling holds the untouched files.
    #[test]
    fn quarantine_renames_and_preserves_bytes_without_deleting() {
        let root = tempfile::tempdir().expect("tempdir");
        let cluster = root.path().join(PG_CLUSTER_SUBDIR);
        seed_residue(&cluster);

        let target = quarantine_cluster_dir(&cluster, 1_700_000_000).expect("quarantine");

        assert_eq!(
            target,
            root.path()
                .join(format!("{PG_REJECT_PREFIX}1700000000")),
            "the default cluster name gains the binding reject prefix"
        );
        assert!(!cluster.exists(), "the residue path must be vacated");
        assert!(target.is_dir(), "the quarantined directory must exist");
        assert_eq!(
            std::fs::read(target.join("start.log")).expect("read start.log"),
            b"crate start log",
            "the crate start.log is byte-identical after quarantine"
        );
        assert_eq!(
            std::fs::read(target.join("log").join("postgres.log")).expect("read postmaster log"),
            b"fredo postmaster log",
            "the Fredo postmaster log is byte-identical after quarantine"
        );

        // A non-default name keeps its own name and gains the same suffix.
        let override_dir = root.path().join("pgdata");
        seed_residue(&override_dir);
        let override_target = quarantine_cluster_dir(&override_dir, 42).expect("quarantine");
        assert_eq!(override_target, root.path().join("pgdata.rejected-42"));
        assert!(override_target.join("start.log").is_file());
    }

    /// `ensure_initialisable` quarantines residue and leaves the other three
    /// states completely untouched (no rename, no delete).
    #[test]
    fn ensure_initialisable_quarantines_only_residue() {
        let root = tempfile::tempdir().expect("tempdir");

        // Absent -> Ok, still absent.
        let absent = root.path().join("absent");
        ensure_initialisable_with(&absent, false, 7).expect("absent is initialisable");
        assert!(!absent.exists(), "an absent dir must not be created here");

        // Empty -> Ok, still empty.
        let empty = root.path().join("empty");
        std::fs::create_dir_all(&empty).expect("create empty");
        ensure_initialisable_with(&empty, false, 7).expect("empty is initialisable");
        assert!(empty.is_dir(), "an empty dir stays in place");

        // Cluster -> Ok, untouched.
        let cluster = root.path().join("cluster-proof");
        seed_cluster(&cluster);
        ensure_initialisable_with(&cluster, false, 7).expect("a cluster is initialisable");
        assert!(cluster.join(PG_CLUSTER_MARKER).is_file(), "the cluster stays in place");
        assert!(
            !root
                .path()
                .join(format!("{PG_REJECT_PREFIX}7"))
                .exists(),
            "a cluster must never be quarantined"
        );

        // Residue -> quarantined, initialisable afterwards.
        let residue = root.path().join(PG_CLUSTER_SUBDIR);
        seed_residue(&residue);
        ensure_initialisable_with(&residue, false, 11).expect("residue is quarantined");
        assert!(!residue.exists(), "the residue path is vacated");
        assert_eq!(
            inspect_cluster_dir(&residue),
            ClusterDirState::Absent,
            "the vacated path is ready for initdb"
        );
        assert_eq!(
            inspect_cluster_dir(&root.path().join(format!("{PG_REJECT_PREFIX}11"))),
            ClusterDirState::Residue,
            "the residue survives under the timestamped sibling"
        );
    }

    /// With the fail seam on, quarantine is REFUSED and the typed
    /// `ClusterDirError` surfaces — the directory is still untouched.
    #[test]
    fn ensure_initialisable_surfaces_the_typed_error_when_quarantine_is_refused() {
        let root = tempfile::tempdir().expect("tempdir");
        let residue = root.path().join(PG_CLUSTER_SUBDIR);
        seed_residue(&residue);

        let error = ensure_initialisable_with(&residue, true, 99)
            .expect_err("the seam must refuse to quarantine");
        let typed = error
            .downcast_ref::<ClusterDirError>()
            .expect("the error must be a typed ClusterDirError");
        assert_eq!(typed.path, residue);
        assert_eq!(typed.state, ClusterDirState::Residue);
        assert!(
            error.to_string().contains("not empty"),
            "the typed message must name the failure class: {error}"
        );

        // Nothing was renamed or deleted under the refusal.
        assert!(residue.join("start.log").is_file());
        assert!(
            !root.path().join(format!("{PG_REJECT_PREFIX}99")).exists(),
            "a refused quarantine creates no sibling"
        );
    }

    /// The seam is inert unless explicitly set, and `0`/`false` leaves it off.
    #[test]
    fn quarantine_fail_rule_is_inert_by_default_and_reads_the_lever() {
        assert_eq!(
            PG_CLUSTER_QUARANTINE_FAIL_ENV, "FREDO_PG_CLUSTER_QUARANTINE_FAIL",
            "the seam env name is the QA-facing contract"
        );
        assert_eq!(PG_CLUSTER_SUBDIR, "cluster");
        assert_eq!(PG_REJECT_PREFIX, "cluster.rejected-");
        assert!(!quarantine_fail_with(None), "unset is inert");
        assert!(!quarantine_fail_with(Some("")), "blank is inert");
        assert!(!quarantine_fail_with(Some("   ")), "blank is inert");
        assert!(!quarantine_fail_with(Some("0")), "0 is inert");
        assert!(!quarantine_fail_with(Some("false")), "false is inert");
        assert!(!quarantine_fail_with(Some("FALSE")), "false is case-insensitive");
        assert!(quarantine_fail_with(Some("1")));
        assert!(quarantine_fail_with(Some("true")));
        assert!(quarantine_fail_with(Some("yes")));
    }
}
