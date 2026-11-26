//! Window lifecycle for installed applications (Spec #3147, ST-4).
//!
//! # What this module owns
//!
//! Exactly four things, and nothing else:
//!
//! 1. **The document URL.** An installed application's window is built at the
//!    URL the `fredoapp` handler ([`super::scheme`]) actually serves —
//!    `<origin>/<id>/`, where the origin is Tauri's own mapping of the
//!    registered scheme (`http://fredoapp.localhost` on Windows/Android,
//!    `fredoapp://localhost` elsewhere; tauri 2.10.3 `src/webview/mod.rs:1705-1717`).
//!    It is deliberately **not** the `App` URL variant: that resolves against the
//!    HOST origin, which would put the application back inside the document the
//!    host owns and defeat AC-2's origin separation.
//! 2. **The label.** `installed-<id>` — [`INSTALLED_APP_WINDOW_LABEL_PREFIX`]
//!    plus the id, derived by the ONE function in [`super::store`]
//!    ([`store::window_label_for`]). The prefix cannot match any shipped
//!    capability's `windows` glob (`main`, `terminal`, `doom`, `app-*`), which is
//!    what makes the child's ACL refusal real.
//! 3. **The singleton.** A live `installed-<id>` window is focused and returned
//!    from, never rebuilt — so "open" twice is one window (AC-5's re-open).
//! 4. **The close path.** Closing destroys the window, which destroys the
//!    document; that *is* how an installed application stops running (there is
//!    no `unmount` in the contract). No window → `false`, not an error.
//!
//! # Nothing happens at startup (R-5.1 / R-5.5)
//!
//! No `installed-*` window exists until [`super::commands_window::installed_app_open`]
//! is called. This module is not reached from `lib.rs`'s setup closure, and no
//! const or static here reads the install root: building a window is the only
//! side effect in the file, and only a command performs it.
//!
//! # Verify before the window exists (AC-4.4)
//!
//! [`resolve_open_target`] calls [`super::scheme::verify_install`] over the whole
//! install record **before** any window is created. A tampered file therefore
//! reports `integrity_mismatch` on the launcher surface — where the user asked —
//! instead of inside a child document whose only content could be the failure,
//! and a corrupt record reports `integrity_record_corrupt` rather than being
//! mistaken for "not installed".

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::manifest;
use super::scheme;
use super::store::{self, InstalledAppRecord};
use super::{InstalledAppError, InstalledAppRefusalCode, InstalledAppResult};
use super::INSTALLED_APP_WINDOW_LABEL_PREFIX;

/// The origin Tauri serves the `fredoapp` scheme from, in the platform's own
/// spelling.
///
/// Tauri maps a registered custom scheme to `http://<scheme>.localhost` on
/// Windows/Android and `<scheme>://localhost` everywhere else
/// (`tauri-2.10.3/src/webview/mod.rs:1705-1717`). Both spellings arrive at the
/// handler with `/<id>/<relative>` in the URL **path**, so the document URL is
/// built from this ONE platform constant and the routing below it is identical.
#[cfg(any(windows, target_os = "android"))]
pub const INSTALLED_APP_ORIGIN: &str = "http://fredoapp.localhost";
/// The origin Tauri serves the `fredoapp` scheme from (see the Windows/Android
/// spelling above).
#[cfg(not(any(windows, target_os = "android")))]
pub const INSTALLED_APP_ORIGIN: &str = "fredoapp://localhost";

/// The window's opening size, matching the built-in generic app window
/// (`infrastructure/app_window.rs:183-185`) so an installed application does not
/// arrive in a differently-shaped frame than the applications it sits beside.
pub const INSTALLED_APP_WINDOW_WIDTH: f64 = 900.0;
/// See [`INSTALLED_APP_WINDOW_WIDTH`].
pub const INSTALLED_APP_WINDOW_HEIGHT: f64 = 600.0;
/// The minimum size, matching the built-in generic app window.
pub const INSTALLED_APP_WINDOW_MIN_WIDTH: f64 = 560.0;
/// See [`INSTALLED_APP_WINDOW_MIN_WIDTH`].
pub const INSTALLED_APP_WINDOW_MIN_HEIGHT: f64 = 360.0;

/// The document URL for an installed application: the entry route the scheme
/// handler serves (`/<id>/`, relative `""` ⇒ the app's `entry.document`).
///
/// The id is already constrained to `[a-z0-9-]` by [`manifest::is_valid_app_id`],
/// so it needs no percent-encoding and can never introduce a path segment.
pub fn installed_app_document_url(id: &str) -> String {
    format!("{INSTALLED_APP_ORIGIN}/{id}/")
}

/// The window label for an installed application (`installed-<id>`).
///
/// A thin, named alias of [`store::window_label_for`] so this module's callers
/// read the prefix rule from the module that owns it — the constant is defined
/// ONCE (in [`super`]) and derived ONCE (in [`store`]).
///
/// # The id charset IS the label charset
///
/// **Every id [`manifest::is_valid_app_id`] accepts yields a label Tauri
/// accepts.** The label is `installed-` + the id, and both parts are drawn from
/// the alphanumerics plus `-` — a strict subset of Tauri's own window-label
/// charset (alphanumeric, `-`, `/`, `:`, `_`; `tauri-runtime`'s
/// `window::is_label_valid` is the predicate, and `PendingWindow::new` refuses a
/// label it rejects). [`manifest::is_valid_app_id`] refuses `.` for exactly this
/// reason: the id is the application's identity (`authority.rs`'s
/// `strip_prefix(labels, "installed-")` recovers the id from the label), so a
/// dot-deleting sanitise here would be non-injective — two ids would collapse
/// onto one label, one window, one identity. Keeping the two charsets equal is
/// the invariant round 1 lacked: both halves were unit-pinned and neither ever
/// built a window, so a dotted id installed and then could never be opened.
/// See `the_label_is_the_installed_prefix_plus_the_id` and
/// `every_accepted_id_yields_a_label_tauri_accepts` in this module's tests.
pub fn installed_app_window_label(id: &str) -> String {
    store::window_label_for(id)
}

/// Everything the open path needs, resolved **before** any window is created.
///
/// Holding one means: the id is a well-formed installed-application id, it is
/// not a built-in id, it is installed, its whole record verified against the
/// bytes on disk, and the record names the same application as its directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTarget {
    pub id: String,
    /// `installed-<id>` — the window's implementation identity.
    pub label: String,
    /// `<install root>/<id>`.
    pub app_dir: PathBuf,
    /// The OS window title: the app's `displayName`, falling back to the id when
    /// the manifest omitted one. The label is what the host keys on; the title is
    /// what the user reads in the taskbar and the window switcher, so it must
    /// name the application rather than the label.
    pub title: String,
    /// The `fredoapp` document URL (see [`installed_app_document_url`]).
    pub url: String,
}

/// Normalise and validate the id a command was given.
///
/// Rejects (never panics on) a blank or malformed id with `id_invalid`, and
/// refuses a built-in application's id with `id_is_installed_app` — the second
/// check exists because "open `terminal`" must never be answered by the installed
/// application path (built-ins keep their own windows, untouched by this spec).
pub fn normalize_app_id(requested: &str) -> InstalledAppResult<String> {
    let id = requested.trim();
    if !manifest::is_valid_app_id(id) {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IdInvalid,
            format!("{requested:?} is not a valid application id"),
        ));
    }
    if manifest::is_reserved_app_id(id) {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IdIsInstalledApp,
            format!("{id} is an application Fredo ships with, not an installed application"),
        ));
    }
    Ok(id.to_string())
}

/// Resolve an installed application for opening: the refusal gate, the
/// integrity pre-flight, and the values the window is built from.
///
/// Pure apart from reading the install root, so every refusal path is unit-
/// testable without a window. `id` must already be normalised by
/// [`normalize_app_id`]; `data_dir` is the app-data dir the install root lives
/// under.
pub fn resolve_open_target(data_dir: &Path, id: &str) -> InstalledAppResult<OpenTarget> {
    let root = store::install_root(data_dir);
    let app_dir = store::app_dir(&root, id);

    if !app_dir.is_dir() {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IdNotInstalled,
            format!("no installed application with id {id}"),
        ));
    }

    // AC-4.4: the bytes are re-proven BEFORE a window exists, so the refusal is
    // reported by the surface the user clicked from.
    scheme::verify_install(&app_dir)?;

    let record = store::read_record(&app_dir)?;
    ensure_record_matches(&record, id)?;

    Ok(OpenTarget {
        id: record.id.clone(),
        label: installed_app_window_label(&record.id),
        title: record
            .display_name
            .clone()
            .unwrap_or_else(|| record.id.clone()),
        url: installed_app_document_url(&record.id),
        app_dir,
    })
}

/// A record must describe the directory it was read from.
///
/// Without this, a record swapped in from another install would title and serve
/// one application under another's id — a per-app corruption (T-4.5's
/// per-directory property) reported as the wrong application.
fn ensure_record_matches(record: &InstalledAppRecord, id: &str) -> InstalledAppResult<()> {
    if record.id == id {
        return Ok(());
    }
    Err(InstalledAppError::new(
        InstalledAppRefusalCode::IntegrityRecordCorrupt,
        format!(
            "the install record in the {id} directory names {} instead",
            record.id
        ),
    ))
}

/// The window operations the close path needs, behind a seam so the decision
/// logic is unit-testable without a Tauri runtime.
pub trait InstalledWindowHost {
    /// Is a window with this label live?
    fn window_exists(&self, label: &str) -> bool;
    /// Destroy the window with this label.
    fn close_window(&self, label: &str) -> InstalledAppResult<()>;
}

/// The real host: Tauri's own window registry.
pub struct TauriWindowHost<'a> {
    app: &'a AppHandle,
}

impl<'a> TauriWindowHost<'a> {
    /// Wrap the running app's window registry.
    pub fn new(app: &'a AppHandle) -> Self {
        Self { app }
    }
}

impl InstalledWindowHost for TauriWindowHost<'_> {
    fn window_exists(&self, label: &str) -> bool {
        self.app.get_webview_window(label).is_some()
    }

    fn close_window(&self, label: &str) -> InstalledAppResult<()> {
        match self.app.get_webview_window(label) {
            Some(window) => window.close().map_err(|error| {
                InstalledAppError::new(
                    InstalledAppRefusalCode::IoError,
                    format!("the {label} window could not be closed: {error}"),
                )
            }),
            // The window disappeared between the existence check and the close:
            // there is nothing left to stop.
            None => Ok(()),
        }
    }
}

/// Close an installed application's window: `true` iff a window was closed.
///
/// A missing window is **not** an error — the caller (the launcher) asks
/// "stop it if it is running", and "it was not running" is a successful answer.
/// Destroying the window destroys the document, which is what stops the
/// application's code.
pub fn close_installed_window(
    host: &impl InstalledWindowHost,
    requested_id: &str,
) -> InstalledAppResult<bool> {
    let id = normalize_app_id(requested_id)?;
    let label = installed_app_window_label(&id);
    if !host.window_exists(&label) {
        return Ok(false);
    }
    host.close_window(&label)?;
    Ok(true)
}

/// Every live installed-application window, sorted by label.
///
/// The cross-webview enumeration ST-5's live theme broadcast needs: only the
/// backend sees every webview, so the set of `installed-*` documents is resolved
/// here, from the label prefix, never from a frontend list. Nothing at startup
/// calls it — the set is empty until an application is opened.
pub fn installed_app_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    let mut windows: Vec<(String, WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(INSTALLED_APP_WINDOW_LABEL_PREFIX))
        .collect();
    windows.sort_by(|left, right| left.0.cmp(&right.0));
    windows.into_iter().map(|(_, window)| window).collect()
}

/// Build (or focus) the singleton window for one resolved installation.
///
/// The caller has already refused everything [`resolve_open_target`] refuses, so
/// this function only performs the host-side act: focus an existing window, or
/// build a new one at [`OpenTarget::url`] with [`OpenTarget::title`] as the OS
/// title.
pub fn open_installed_app_window(app: &AppHandle, target: &OpenTarget) -> InstalledAppResult<()> {
    if let Some(window) = app.get_webview_window(&target.label) {
        tracing::debug!(
            target: scheme::TRACE_TARGET,
            label = %target.label,
            "focusing the existing installed-app window"
        );
        window.set_focus().ok();
        return Ok(());
    }

    let url = Url::parse(&target.url).map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the document URL for {} could not be built: {error}", target.id),
        )
    })?;

    // `WebviewUrl::External` passes the URL through unchanged, which is what
    // keeps the document at the `fredoapp` origin (AC-2). The `App` URL variant
    // would resolve against the HOST origin and is deliberately not used.
    let builder = WebviewWindowBuilder::new(app, target.label.as_str(), WebviewUrl::External(url))
        .title(target.title.clone())
        .inner_size(INSTALLED_APP_WINDOW_WIDTH, INSTALLED_APP_WINDOW_HEIGHT)
        .min_inner_size(
            INSTALLED_APP_WINDOW_MIN_WIDTH,
            INSTALLED_APP_WINDOW_MIN_HEIGHT,
        )
        .resizable(true);

    builder.build().map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the window for {} could not be created: {error}", target.id),
        )
    })?;

    tracing::debug!(
        target: scheme::TRACE_TARGET,
        label = %target.label,
        url = %target.url,
        "created the installed-app window"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::installed_apps::store::InstalledFileRecord;
    use crate::applications::installed_apps::INSTALLED_RECORD_FILENAME;
    use std::cell::RefCell;

    // ── Fixtures ─────────────────────────────────────────────────────────────

    /// Write a minimal install directory: `<install root>/<id>/record.json` plus
    /// one `<install root>/<id>/files/<path>` per entry, hashed exactly as the
    /// installer would. Returns the app dir.
    fn install_fixture(
        data_dir: &Path,
        id: &str,
        files: &[(&str, &[u8])],
        display_name: Option<&str>,
    ) -> PathBuf {
        let app_dir = store::app_dir(&store::install_root(data_dir), id);
        let files_root = app_dir.join(super::super::INSTALLED_FILES_SUBDIR);
        std::fs::create_dir_all(&files_root).expect("create files dir");

        let mut records = Vec::new();
        for (path, bytes) in files {
            std::fs::write(files_root.join(path), bytes).expect("write file");
            records.push(InstalledFileRecord {
                path: (*path).to_string(),
                sha256: store::sha256_hex(bytes),
                bytes: bytes.len() as u64,
            });
        }
        records.sort_by(|left, right| left.path.cmp(&right.path));

        write_record(
            &app_dir,
            InstalledAppRecord {
                id: id.to_string(),
                version: "1.0.0".to_string(),
                manifest_version: 1,
                engines_fredo: ">=0.0.0".to_string(),
                entry_document: "index.html".to_string(),
                entry_module: "main.js".to_string(),
                installed_at: "2026-01-01T00:00:00Z".to_string(),
                aggregate_sha256: store::aggregate_digest(&records),
                files: records,
                description: None,
                display_name: display_name.map(str::to_string),
            },
        );
        app_dir
    }

    fn write_record(app_dir: &Path, record: InstalledAppRecord) {
        std::fs::write(
            app_dir.join(INSTALLED_RECORD_FILENAME),
            serde_json::to_vec(&record).expect("serialize record"),
        )
        .expect("write record");
    }

    fn standard_files() -> Vec<(&'static str, &'static [u8])> {
        vec![
            (
                "index.html",
                b"<!doctype html><html><body>app</body></html>" as &[u8],
            ),
            ("main.js", b"export function mount() {}" as &[u8]),
        ]
    }

    /// A host whose window registry is a plain list, so the close decision can
    /// be proven without a Tauri runtime.
    struct FakeHost {
        present: Vec<String>,
        closed: RefCell<Vec<String>>,
        fail_close: bool,
    }

    impl FakeHost {
        fn with(present: &[&str]) -> Self {
            Self {
                present: present.iter().map(|label| label.to_string()).collect(),
                closed: RefCell::new(Vec::new()),
                fail_close: false,
            }
        }
    }

    impl InstalledWindowHost for FakeHost {
        fn window_exists(&self, label: &str) -> bool {
            self.present.iter().any(|known| known == label)
        }

        fn close_window(&self, label: &str) -> InstalledAppResult<()> {
            if self.fail_close {
                return Err(InstalledAppError::new(
                    InstalledAppRefusalCode::IoError,
                    format!("{label} could not be closed"),
                ));
            }
            self.closed.borrow_mut().push(label.to_string());
            Ok(())
        }
    }

    // ── 1. Label derivation ─────────────────────────────────────────────────

    #[test]
    fn the_label_is_the_installed_prefix_plus_the_id() {
        assert_eq!(INSTALLED_APP_WINDOW_LABEL_PREFIX, "installed-");
        assert_eq!(installed_app_window_label("qa3147"), "installed-qa3147");
        assert_eq!(
            installed_app_window_label("dev-example-tools"),
            "installed-dev-example-tools"
        );

        // The ONE derivation (store) and this module's alias cannot drift.
        for id in ["a", "qa3147", "dev-example-tools"] {
            assert_eq!(
                installed_app_window_label(id),
                store::window_label_for(id),
                "the label must be derived by the single store helper"
            );
            let label = installed_app_window_label(id);
            assert!(label.starts_with(INSTALLED_APP_WINDOW_LABEL_PREFIX));
        }

        // The installed namespace can never be produced by the built-in rule —
        // two owners for one label namespace would make AC-2's refusal bendable.
        assert!(!installed_app_window_label("qa3147").starts_with("app-"));
        assert_eq!(
            crate::infrastructure::app_window::app_window_label("qa3147"),
            "app-qa3147",
            "built-ins keep their own label namespace, untouched by this spec"
        );
    }

    /// WHY THIS PIN AND NOT A REAL WINDOW-CREATE (ST-7).
    ///
    /// The defect class round 1 shipped was "both halves were green unit pins
    /// and neither created a real window". The strongest closure is a real
    /// create — `tauri::test::mock_app()` + `WebviewWindowBuilder::build()`,
    /// which goes `PendingWindow::new` → `is_label_valid` → and it WAS written:
    /// enabling `tauri`'s `test` feature made the lib test binary fail to LOAD
    /// in this environment (`0xc0000139` STATUS_ENTRYPOINT_NOT_FOUND,
    /// reproducible on a second run), an environment/build-property regression
    /// unrelated to the label rule, so it was not landed. What IS landed is a
    /// direct binding to the SAME predicate the create path consults
    /// (`tauri-runtime-2.10.1/src/window.rs:494-498`, called from
    /// `PendingWindow::new` at `:514-515`), so a `.` cannot re-enter the id
    /// charset without reddening this test. The create-path leg remains
    /// available to any environment where the mock runtime links; it is
    /// recorded here so the fallback is visible and this class cannot recur
    /// silently.
    #[test]
    fn every_accepted_id_yields_a_label_tauri_accepts() {
        // The ids the parser accepts. `dev-example-tools` is the dotted-free
        // successor of round 1's `dev.example.tools`.
        let accepted = [
            "a",
            "a1",
            "9lives",
            "qa3147",
            "qa3147-sample",
            "dev-example-tools",
            "com-example-myapp",
            "trailing-dash-",
        ];
        for id in accepted {
            assert!(manifest::is_valid_app_id(id), "{id} must be an accepted id");
            let label = installed_app_window_label(id);
            assert!(
                tauri_runtime::window::is_label_valid(&label),
                "Tauri refuses the label {label:?} derived from the accepted id {id:?} — \
                 the id charset and the label charset have drifted apart"
            );
        }

        // The predicate is not vacuous — and it is Tauri's rule, not a
        // restatement of it: exactly the alphanumerics plus `-`, `/`, `:` and
        // `_`. Pinning its own boundary means a future widening of the id
        // charset is caught against the real rule, and the dotted label round 1
        // produced is refused, which is exactly why the id rule had to narrow.
        for accepted in ["a", "installed-qa3147", "installed-dev-example-tools", "A1_2/3:4"] {
            assert!(
                tauri_runtime::window::is_label_valid(accepted),
                "Tauri accepts {accepted:?}"
            );
        }
        for rejected in ["installed-com.example.my-app", "installed-a.b", "dot.ted"] {
            assert!(
                !tauri_runtime::window::is_label_valid(rejected),
                "a dot must be refused by Tauri's own label rule: {rejected:?}"
            );
        }
    }

    // ── 2. The document URL ─────────────────────────────────────────────────

    #[test]
    fn the_document_url_is_the_fredoapp_origin_and_never_the_host_origin() {
        let url = installed_app_document_url("qa3147-test");
        assert_eq!(url, format!("{INSTALLED_APP_ORIGIN}/qa3147-test/"));
        assert!(url.starts_with(INSTALLED_APP_ORIGIN));
        assert!(url.ends_with("/qa3147-test/"), "the entry route, not a file: {url}");

        // It parses, and its path is exactly the route the handler expects.
        let parsed = Url::parse(&url).expect("the document URL must parse");
        assert_eq!(parsed.path(), "/qa3147-test/");

        // The host origin would defeat AC-2, so it must appear nowhere.
        assert!(!url.contains("tauri.localhost"), "the host origin is off limits: {url}");
        assert!(!url.contains("index.html"), "the entry route is the directory: {url}");
        assert_ne!(parsed.scheme(), "tauri");

        // The platform spelling mirrors Tauri's own mapping.
        #[cfg(any(windows, target_os = "android"))]
        assert_eq!(parsed.scheme(), "http");
        #[cfg(not(any(windows, target_os = "android")))]
        assert_eq!(parsed.scheme(), "fredoapp");
    }

    // ── 3. Id resolution: shape, built-ins, absence ─────────────────────────

    #[test]
    fn every_built_in_id_is_refused_as_an_installed_app() {
        for built_in in manifest::RESERVED_APP_IDS {
            let error = normalize_app_id(built_in).expect_err("a built-in id must be refused");
            assert_eq!(
                error.code,
                InstalledAppRefusalCode::IdIsInstalledApp,
                "{built_in} must be id_is_installed_app, not id_not_installed"
            );
            assert!(error.detail.contains(built_in));
        }
    }

    #[test]
    fn an_invalid_id_shape_is_refused_and_never_panics() {
        let too_long = "a".repeat(manifest::MAX_APP_ID_CHARS + 1);
        let cases = [
            "",
            "   ",
            "QA3147",
            "qa 3147",
            "qa/3147",
            "../qa3147",
            "qa3147\\x",
            "qa3147\0",
            ".qa3147",
            "qa3147.",
            "-qa3147",
            too_long.as_str(),
        ];
        for requested in cases {
            let error = normalize_app_id(requested).expect_err("must be refused");
            assert_eq!(
                error.code,
                InstalledAppRefusalCode::IdInvalid,
                "{requested:?} must be id_invalid"
            );
        }

        // A well-formed id passes through, trimmed.
        assert_eq!(normalize_app_id("  qa3147  ").expect("valid"), "qa3147");
        assert_eq!(
            normalize_app_id("dev-example-tools").expect("valid"),
            "dev-example-tools"
        );

        // A dotted id is refused here too — the same narrowed charset the
        // window label requires.
        assert_eq!(
            normalize_app_id("dev.example.tools")
                .expect_err("a dotted id must be refused")
                .code,
            InstalledAppRefusalCode::IdInvalid
        );
    }

    #[test]
    fn an_id_with_no_install_directory_is_not_installed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let error = resolve_open_target(directory.path(), "qa3147-absent")
            .expect_err("nothing installed");
        assert_eq!(error.code, InstalledAppRefusalCode::IdNotInstalled);
        assert!(error.detail.contains("qa3147-absent"));
    }

    // ── 4. Resolving a real install directory ──────────────────────────────

    #[test]
    fn the_open_target_carries_the_display_name_as_the_title() {
        let directory = tempfile::tempdir().expect("tempdir");
        let app_dir = install_fixture(
            directory.path(),
            "qa3147-test",
            &standard_files(),
            Some("QA3147 Test"),
        );

        let target = resolve_open_target(directory.path(), "qa3147-test").expect("resolvable");
        assert_eq!(target.id, "qa3147-test");
        assert_eq!(target.label, "installed-qa3147-test");
        assert_eq!(
            target.title, "QA3147 Test",
            "the OS title is the displayName, never the label"
        );
        assert_ne!(target.title, target.label);
        assert_eq!(
            target.url,
            installed_app_document_url("qa3147-test"),
            "the window is built at exactly the URL the handler serves"
        );
        assert_eq!(target.app_dir, app_dir);
    }

    #[test]
    fn a_record_without_a_display_name_titles_the_window_with_the_id() {
        let directory = tempfile::tempdir().expect("tempdir");
        install_fixture(directory.path(), "qa3147-test", &standard_files(), None);

        let target = resolve_open_target(directory.path(), "qa3147-test").expect("resolvable");
        assert_eq!(target.title, "qa3147-test");
    }

    // ── 5. Verify-before-window (AC-4.4) ───────────────────────────────────

    #[test]
    fn a_tampered_file_is_integrity_mismatch_before_any_window_is_built() {
        let directory = tempfile::tempdir().expect("tempdir");
        let app_dir = install_fixture(
            directory.path(),
            "qa3147-test",
            &standard_files(),
            Some("QA3147 Test"),
        );
        std::fs::write(
            app_dir
                .join(super::super::INSTALLED_FILES_SUBDIR)
                .join("main.js"),
            b"export function Mount() {}",
        )
        .expect("tamper");

        let error =
            resolve_open_target(directory.path(), "qa3147-test").expect_err("tampered refused");
        assert_eq!(error.code, InstalledAppRefusalCode::IntegrityMismatch);
        // The refusal happens before any `OpenTarget` exists — and a window can
        // only be built from one.
        assert!(!error.detail.is_empty(), "the refusal names the file it refused");
    }

    #[test]
    fn a_missing_or_unreadable_record_is_record_corrupt_not_not_installed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let app_dir = install_fixture(
            directory.path(),
            "qa3147-test",
            &standard_files(),
            Some("QA3147 Test"),
        );
        std::fs::write(app_dir.join(INSTALLED_RECORD_FILENAME), b"{ not a record")
            .expect("corrupt record");

        let error =
            resolve_open_target(directory.path(), "qa3147-test").expect_err("corrupt refused");
        assert_eq!(
            error.code,
            InstalledAppRefusalCode::IntegrityRecordCorrupt,
            "a damaged record is its own code, never id_not_installed"
        );
    }

    #[test]
    fn a_record_that_names_another_application_is_refused() {
        let directory = tempfile::tempdir().expect("tempdir");
        let app_dir = install_fixture(
            directory.path(),
            "qa3147-test",
            &standard_files(),
            Some("QA3147 Test"),
        );
        // Re-point the record at a different id, keeping the bytes valid.
        let mut record = store::read_record(&app_dir).expect("read record");
        record.id = "qa3147-other".to_string();
        write_record(&app_dir, record);

        let error =
            resolve_open_target(directory.path(), "qa3147-test").expect_err("mismatched refused");
        assert_eq!(error.code, InstalledAppRefusalCode::IntegrityRecordCorrupt);
        assert!(error.detail.contains("qa3147-other"));
    }

    // ── 6. Close ───────────────────────────────────────────────────────────

    #[test]
    fn closing_an_absent_window_returns_false_and_closes_nothing() {
        let host = FakeHost::with(&["installed-qa3147-other"]);
        assert_eq!(
            close_installed_window(&host, "qa3147-test").expect("not an error"),
            false,
            "no window is not a failure"
        );
        assert!(host.closed.borrow().is_empty());
    }

    #[test]
    fn closing_a_present_window_returns_true_and_closes_that_label() {
        let host = FakeHost::with(&["installed-qa3147-test", "installed-qa3147-other"]);
        assert_eq!(
            close_installed_window(&host, " qa3147-test ").expect("closed"),
            true
        );
        assert_eq!(
            host.closed.borrow().as_slice(),
            ["installed-qa3147-test"],
            "exactly the requested app's window is destroyed — the other app is untouched"
        );
    }

    #[test]
    fn closing_a_built_in_id_is_refused_and_never_touches_the_host() {
        let host = FakeHost::with(&["installed-qa3147-test"]);
        for built_in in manifest::RESERVED_APP_IDS {
            let error =
                close_installed_window(&host, built_in).expect_err("a built-in id is refused");
            assert_eq!(error.code, InstalledAppRefusalCode::IdIsInstalledApp);
        }
        assert!(
            host.closed.borrow().is_empty(),
            "a built-in id can never reach a close call"
        );
    }

    #[test]
    fn a_failed_close_surfaces_the_host_error() {
        let mut host = FakeHost::with(&["installed-qa3147-test"]);
        host.fail_close = true;
        let error = close_installed_window(&host, "qa3147-test").expect_err("close failed");
        assert_eq!(error.code, InstalledAppRefusalCode::IoError);
    }

    // ── 7. Nothing at startup ──────────────────────────────────────────────

    #[test]
    fn the_constants_are_the_plans_values() {
        assert_eq!(INSTALLED_APP_WINDOW_WIDTH, 900.0);
        assert_eq!(INSTALLED_APP_WINDOW_HEIGHT, 600.0);
        assert_eq!(INSTALLED_APP_WINDOW_MIN_WIDTH, 560.0);
        assert_eq!(INSTALLED_APP_WINDOW_MIN_HEIGHT, 360.0);

        let source = include_str!("window.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);
        // Building a window is the only side effect in this module, and only
        // `open_installed_app_window` performs it — never a startup path.
        assert_eq!(
            product.matches(".build()").count(),
            1,
            "exactly ONE window build site in the product code"
        );
        assert!(
            product.contains("WebviewUrl::External("),
            "the window is built at an external (fredoapp) URL"
        );
        // The host-origin variant and the built-in label namespace are never
        // used here: either would put the installed window back on the host.
        // The tokens are constructed rather than written out so this guard does
        // not match itself.
        let host_url_variant = ["WebviewUrl", "::", "App("].concat();
        assert!(!product.contains(&host_url_variant));
        let built_in_prefix = ["GENERIC_APP_WINDOW_LABEL", "_PREFIX"].concat();
        assert!(!product.contains(&built_in_prefix));
    }
}
