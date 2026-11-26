//! The two window-lifecycle Tauri commands (Spec #3147, ST-4).
//!
//! Exactly two commands, and no others — an installed application's window is
//! opened on demand and closed on demand, and nothing else in this slice needs a
//! verb:
//!
//! | Command | Args (camelCase) | Success | Failure |
//! |---|---|---|---|
//! | [`installed_app_open`] | `appId: string` | `()` | [`InstalledAppError`] |
//! | [`installed_app_close`] | `appId: string` | `bool` (true iff a window was closed) | [`InstalledAppError`] |
//!
//! # Order of operations on open
//!
//! 1. The id is normalised and refused if malformed or if it names a built-in
//!    application (`id_invalid` / `id_is_installed_app`).
//! 2. [`window::resolve_open_target`] proves the whole install record against the
//!    bytes on disk (`integrity_mismatch` / `integrity_record_corrupt`) and the
//!    directory's existence (`id_not_installed`) — **before any window exists**,
//!    so the refusal is reported by the launcher the user clicked from (AC-4.4).
//! 3. The package's declared data tables (`capabilities.data.tables`) are
//!    MATERIALISED through the one declaration registry (Spec #3146 W-1), so the
//!    declared set exists before the document's first call. A package that
//!    declares no table does no database work at all here.
//! 4. Only then is the window built (or an existing one focused).
//!
//! # Nothing at startup
//!
//! Neither command is called from `lib.rs`'s setup closure; the app-data dir is
//! resolved per call, which is why startup cost does not grow with the number of
//! installed applications (R-5.5).
//!
//! # Why the filesystem work is off the IPC thread
//!
//! Verification reads and hashes every installed file, so it runs on the
//! blocking pool. The window itself is built on the async runtime's main thread
//! — a `WebviewWindowBuilder` cannot be constructed from a blocking worker.

use std::sync::Arc;

use tauri::AppHandle;

use super::store;
use super::window;
use super::{InstalledAppError, InstalledAppRefusalCode, InstalledAppResult};
use crate::infrastructure::application_data::commands::ApplicationDataState;
use crate::infrastructure::application_data::declaration::ApplicationDataDeclaration;

/// Resolve the app-data dir through the ONE shipped resolver.
///
/// `infrastructure::storage::boot_config::resolve_app_data_dir` is the single
/// `FREDO_DATA_DIR`-aware rule the whole app follows (Spec #2977 G-275), so the
/// installed-app window path reads the same install root the installer wrote to.
fn app_data_dir(app: &AppHandle) -> InstalledAppResult<std::path::PathBuf> {
    use tauri::Manager;
    let os_dir = app.path().app_data_dir().map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("this build cannot resolve its application data directory: {error}"),
        )
    })?;
    Ok(crate::infrastructure::storage::boot_config::resolve_app_data_dir(&os_dir))
}

/// Open an installed application in its own window (R-1.2's window half, R-5.4).
///
/// Creates the singleton `installed-<id>` window at the `fredoapp` document URL
/// with the application's `displayName` as the OS title; an already-open window
/// is focused and nothing is rebuilt. Every refusal is a named
/// [`InstalledAppError`], and **no window is created on a refusal**.
#[tauri::command]
pub async fn installed_app_open(app: AppHandle, app_id: String) -> InstalledAppResult<()> {
    let id = window::normalize_app_id(&app_id)?;
    let data_dir = app_data_dir(&app)?;

    // Verification + record reading is synchronous filesystem work; keep it off
    // the IPC thread.
    let target = tauri::async_runtime::spawn_blocking(move || {
        window::resolve_open_target(&data_dir, &id)
    })
    .await
    .map_err(|error| {
        InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!("the open check could not be run: {error}"),
        )
    })??;

    // Materialise the package's declared data tables BEFORE the window exists
    // (Spec #3146 W-1): an installed application's first call must already find
    // the declaration it was installed with. Reading the canonical manifest is
    // filesystem work, so it stays off the IPC thread; a package that declares
    // no table returns `None` and never reaches the store.
    let manifest_dir = target.app_dir.clone();
    let declaration = tauri::async_runtime::spawn_blocking(move || open_declaration(&manifest_dir))
        .await
        .map_err(|error| {
            InstalledAppError::new(
                InstalledAppRefusalCode::IoError,
                format!("the declaration check for {} could not be run: {error}", target.id),
            )
        })??;
    if let Some(declaration) = declaration {
        materialize_open_declaration(&app, &declaration)?;
    }

    window::open_installed_app_window(&app, &target)
}

/// Compose the declaration an installed package's own declared tables make.
///
/// `None` when the package declares no table — the zero-cost path: the caller
/// then performs no store lookup and no database work. Anything the canonical
/// manifest cannot be read or parsed as is the caller's [`InstalledAppError`]
/// (`integrity_record_corrupt`), exactly as the open check treats it.
fn open_declaration(
    app_dir: &std::path::Path,
) -> InstalledAppResult<Option<ApplicationDataDeclaration>> {
    let manifest = store::read_manifest_file(app_dir)?;
    Ok(manifest
        .capabilities
        .as_ref()
        .and_then(|capabilities| capabilities.data_declaration(&manifest.id, &manifest.version)))
}

/// Hand one package's declaration to the ONE registry, before the window exists.
///
/// Refusal: the existing `io_error` (no new code — the installer vocabulary is
/// frozen at 22), naming the application and the tables, because the alternative
/// is opening a document into a fence it cannot pass. The declaration is
/// idempotent (`EnsureOnly` for unchanged content, `CREATE TABLE IF NOT EXISTS`
/// otherwise), so a re-open and a restart leave every written row intact.
fn materialize_open_declaration(
    app: &AppHandle,
    declaration: &ApplicationDataDeclaration,
) -> InstalledAppResult<()> {
    use tauri::Manager;

    let Some(state) = app.try_state::<Arc<ApplicationDataState>>() else {
        return Err(InstalledAppError::new(
            InstalledAppRefusalCode::IoError,
            format!(
                "the declared tables of application '{}' could not be materialized: the \
                 application-data store is not running",
                declaration.feature_id
            ),
        ));
    };
    state
        .registry
        .declare(declaration)
        .map_err(|errors| {
            InstalledAppError::new(
                InstalledAppRefusalCode::IoError,
                format!(
                    "the declared tables of application '{}' could not be materialized: {}",
                    declaration.feature_id,
                    errors.join("; ")
                ),
            )
        })?;
    Ok(())
}

/// Close an installed application's window (R-5.3).
///
/// Returns `true` iff a window was actually closed; `false` when the application
/// was not open — that is a successful answer, not an error. Closing destroys
/// the window and therefore the document, which is what stops the application's
/// code (there is no `unmount` in the contract).
#[tauri::command]
pub async fn installed_app_close(app: AppHandle, app_id: String) -> InstalledAppResult<bool> {
    window::close_installed_window(&window::TauriWindowHost::new(&app), &app_id)
}

#[cfg(test)]
mod tests {
    use super::open_declaration;

    /// The command surface this module owns is exactly two functions — a guard
    /// so a later sub-task's command cannot be added here by accident (the plan
    /// assigns `install`/`list` to ST-2 and `push_theme` to ST-5).
    #[test]
    fn the_module_owns_exactly_the_two_window_commands() {
        // Scan the PRODUCT source only: the `#[cfg(test)]` module quotes the
        // attribute marker in its own assertions, and counting those would make
        // this guard count itself.
        let source = include_str!("commands_window.rs");
        let product = source
            .find("#[cfg(test)]")
            .map(|split| &source[..split])
            .unwrap_or(source);

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            2,
            "commands_window.rs must carry exactly installed_app_open + installed_app_close"
        );
        // The command's Rust parameter is `app_id`, so the serde/camelCase wire
        // key Tauri invokes with is `appId`.
        assert!(product.contains("pub async fn installed_app_open("));
        assert!(product.contains("pub async fn installed_app_close("));
        assert_eq!(
            product.matches("app_id: String").count(),
            2,
            "both commands take exactly one `appId: string` argument"
        );
        for other in [
            "installed_app_install",
            "installed_apps_list",
            "installed_apps_push_theme",
        ] {
            assert!(
                !product.contains(&format!("pub async fn {other}(")),
                "{other} belongs to another sub-task"
            );
        }

        // The return shapes are the plan's: open -> (), close -> bool.
        assert!(product.contains("InstalledAppResult<()>"));
        assert!(product.contains("InstalledAppResult<bool>"));
    }

    /// No startup hook: nothing in the product code calls either command.
    #[test]
    fn nothing_calls_the_commands_from_startup() {
        let setup_region = setup_closure_region();
        // Non-vacuity: the extractor must really have found the setup closure,
        // not an empty slice, or the absence assertions below prove nothing.
        assert!(
            setup_region.contains("EnvConfig::from_env()"),
            "the setup-closure extractor is vacuous: {} chars",
            setup_region.len()
        );
        assert!(
            setup_region.contains("get_webview_window(\"main\")"),
            "the setup closure really does touch windows, so an installed-window \
             creation here would have been visible"
        );
        // The region really ends at the setup closure: the `generate_handler!`
        // block (which DOES name both commands) is outside it.
        assert!(
            !setup_region.contains("generate_handler!"),
            "the extracted region must stop at the setup closure, not run into \
             the registration block"
        );
        for command in ["installed_app_open", "installed_app_close"] {
            assert!(
                !setup_region.contains(command),
                "{command} must never be reachable from lib.rs's setup closure (R-5.1)"
            );
        }
        for token in [
            "installed_app",
            "installed-apps",
            "installed_apps_list",
            "open_installed_app_window",
        ] {
            assert!(
                !setup_region.contains(token),
                "the setup closure performs no installed-app work (found {token})"
            );
        }
    }

    /// The app's ONE setup closure's source text, balanced by braces from the real
    /// `lib.rs` — never a hand-kept copy.
    ///
    /// Anchored on the `.setup(` CALL, never on a receiver spelling: the builder is a
    /// chain (#3192: `builder.on_menu_event(..).setup(..)`), and `builder.` is
    /// incidental formatting. `tauri::Builder::setup` is the only way an app registers
    /// a setup closure, so COUNTING it asserts the property this guard means — "the
    /// app registers exactly ONE setup closure".
    fn setup_closure_region_from(source: &str) -> Result<String, String> {
        const SETUP_CALL: &str = ".setup(";
        let occurrences = source.matches(SETUP_CALL).count();
        if occurrences != 1 {
            return Err(format!(
                "lib.rs must register exactly ONE `{SETUP_CALL}` closure, found {occurrences} \
                 (if a non-Tauri builder gained a `.setup(` call, narrow this extractor — do not \
                 delete the guard)"
            ));
        }
        let start = source.find(SETUP_CALL).expect("counted exactly one occurrence");
        let mut depth: i32 = 0;
        for (index, character) in source[start..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(source[start..start + index + 1].to_string());
                    }
                }
                _ => {}
            }
        }
        Err(format!("the `{SETUP_CALL}` closure in lib.rs is not brace-balanced"))
    }

    fn setup_closure_region() -> String {
        setup_closure_region_from(include_str!("../../lib.rs"))
            .expect("lib.rs registers one brace-balanced setup closure")
    }

    /// The extractor must be indifferent to the builder's receiver spelling: a chain
    /// (`builder.on_menu_event(..).setup(..)`, #3192's ST-2 shape) and the plain form
    /// extract the same region.
    #[test]
    fn the_setup_extractor_accepts_a_chained_builder() {
        let plain = setup_closure_region_from("builder.setup(|app| { body(); });")
            .expect("the plain form registers one setup closure");
        let chained = setup_closure_region_from(
            "builder\n    .on_menu_event(handler)\n    .setup(|app| { body(); });",
        )
        .expect("a chained builder registers one setup closure");
        assert!(plain.contains("body();"), "extracted the wrong region: {plain}");
        assert!(chained.contains("body();"), "extracted the wrong region: {chained}");
        assert_eq!(
            plain, chained,
            "the receiver spelling must not change the extracted region"
        );
    }

    /// The property is "exactly ONE setup closure": a second `.setup(` is refused, not
    /// silently extracted first-match, and a source with none is refused too.
    #[test]
    fn the_setup_extractor_refuses_two_setup_closures() {
        let two = setup_closure_region_from(
            "builder.setup(|app| { first(); }).setup(|app| { second(); });",
        )
        .expect_err("two setup closures must be refused");
        assert!(
            two.contains("exactly ONE"),
            "the refusal must name the property it means: {two}"
        );
        let none = setup_closure_region_from("builder.plugin(p);")
            .expect_err("no setup closure must be refused");
        assert!(
            none.contains("exactly ONE"),
            "the refusal must name the property it means: {none}"
        );
    }

    /// An unbalanced closure is an ERROR, never the file tail: the old `end = len`
    /// fallback made a broken extraction look like a (vacuous) success.
    #[test]
    fn the_setup_extractor_refuses_an_unbalanced_closure() {
        let unbalanced = setup_closure_region_from("builder.setup(|app| { body();")
            .expect_err("an unterminated closure must be refused");
        assert!(
            unbalanced.contains("not brace-balanced"),
            "the refusal must say why: {unbalanced}"
        );
    }

    // ── W-1: the declared tables are materialised on open ───────────────────

    /// Write a canonical `<dir>/manifest.json` with the given `capabilities`
    /// fragment (or none at all).
    fn write_manifest(dir: &std::path::Path, capabilities: Option<&str>) {
        let capabilities = capabilities
            .map(|fragment| format!(",\n  \"capabilities\": {fragment}"))
            .unwrap_or_default();
        let manifest = format!(
            r#"{{
  "manifestVersion": 1,
  "id": "qa3146-app-a",
  "displayName": "QA3146 App A",
  "version": "1.0.0",
  "engines": {{ "fredo": ">=0.0.0" }},
  "entry": {{ "document": "index.html", "module": "main.js" }}{capabilities}
}}"#
        );
        std::fs::write(
            dir.join(super::super::INSTALLED_MANIFEST_FILENAME),
            manifest,
        )
        .expect("write the canonical manifest");
    }

    /// W-1 — the composer the open path hands to the registry: the package's
    /// tables verbatim and in order, at the install validator's revision, and
    /// with no `source` projection.
    #[test]
    fn the_declaration_composed_for_open_carries_the_manifests_tables() {
        let data = tempfile::tempdir().expect("tempdir");
        write_manifest(
            data.path(),
            Some(
                r#"{
    "version": 1,
    "data": { "tables": [
      {"name": "notes", "primaryKey": ["id"], "columns": [
        {"name": "id", "type": "TEXT", "nullable": false, "owner": "application"},
        {"name": "body", "type": "TEXT", "nullable": true, "owner": "application"}
      ]},
      {"name": "shared_log", "primaryKey": ["id"], "columns": [
        {"name": "id", "type": "TEXT", "nullable": false, "owner": "application"}
      ]}
    ] }
  }"#,
            ),
        );

        let declaration = open_declaration(data.path())
            .expect("a readable canonical manifest")
            .expect("a declaring package composes a declaration");
        assert_eq!(declaration.feature_id, "qa3146-app-a");
        assert_eq!(
            declaration
                .tables
                .iter()
                .map(|table| table.name.as_str())
                .collect::<Vec<_>>(),
            ["notes", "shared_log"],
            "the manifest's tables, verbatim and in order"
        );
        assert_eq!(declaration.declaration_revision, "manifest:1.0.0");
        for table in &declaration.tables {
            assert!(table.source.is_none(), "{table:?} must carry no source");
        }

        // A manifest that cannot be read is the open path's own refusal, not a
        // silent skip: an unreadable canonical manifest refuses the open.
        assert!(
            open_declaration(&data.path().join("not-installed")).is_err(),
            "a missing canonical manifest must be refused"
        );
    }

    /// W-1 — a package that declares no data table composes NOTHING, so the open
    /// path performs no store lookup and no database work for it.
    ///
    /// Non-vacuity: the SAME directory, with a declared table, does compose one
    /// (the composer is not simply always `None`).
    #[test]
    fn a_package_without_data_tables_does_no_database_work() {
        let data = tempfile::tempdir().expect("tempdir");
        write_manifest(data.path(), None);
        assert_eq!(
            open_declaration(data.path()).expect("readable manifest"),
            None,
            "no capabilities ⇒ nothing to materialise ⇒ no database work"
        );

        // Non-vacuity: the same manifest shape WITH a table does compose.
        write_manifest(
            data.path(),
            Some(
                r#"{"version": 1, "data": { "tables": [
      {"name": "notes", "primaryKey": ["id"], "columns": [
        {"name": "id", "type": "TEXT", "nullable": false, "owner": "application"}
      ]}
    ] }}"#,
            ),
        );
        assert!(
            open_declaration(data.path())
                .expect("readable manifest")
                .is_some(),
            "the same tree with a declared table must compose one"
        );

        // ... and a present-but-empty table list is the zero-cost path too.
        write_manifest(data.path(), Some(r#"{"version": 1, "data": { "tables": [] }}"#));
        assert_eq!(open_declaration(data.path()).expect("readable manifest"), None);
    }

    /// W-1 — the open command materialises BEFORE it builds (or focuses) the
    /// window, so a document never starts against an empty declaration set.
    ///
    /// Anchored on the CALLS, asserting the ORDER property (G-468): the read,
    /// the guarded materialisation, then the window.
    #[test]
    fn the_open_path_materializes_before_the_window_is_built() {
        let source = include_str!("commands_window.rs");
        let start = source
            .find("pub async fn installed_app_open(")
            .expect("the open command exists");
        let body = &source[start..];
        let body = body
            .find("pub async fn installed_app_close(")
            .map(|end| &body[..end])
            .expect("the close command follows the open command");

        let read = body
            .find("open_declaration(&manifest_dir)")
            .expect("the open command reads the package's declaration");
        let guarded = body
            .find("if let Some(declaration) = declaration {")
            .expect("the materialisation is guarded by the composed declaration");
        let materialize = body
            .find("materialize_open_declaration(&app, &declaration)")
            .expect("the open command materialises the declaration");
        let build = body
            .find("window::open_installed_app_window(&app, &target)")
            .expect("the open command builds the window");

        assert!(
            read < guarded && guarded < materialize && materialize < build,
            "order must be read (at {read}) → guard (at {guarded}) → \
             materialize (at {materialize}) → build (at {build})"
        );
    }
}
