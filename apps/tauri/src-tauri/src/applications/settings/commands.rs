use std::path::{Component, Path};
use std::sync::Arc;

use crate::infrastructure::storage::SettingsStore;

/// The four settings keys whose values select an executable (or a directory a
/// later trusted spawn reads binaries from). A compromised webview must not be
/// able to poison one of them into pointing at an arbitrary target.
///
/// The literals are LOCAL by design: engineering rules forbid cross-application
/// imports, so this module must not import the `llm_server` / `terminal`
/// constants that declare the same keys.
pub const SENSITIVE_PATH_SETTING_KEYS: [&str; 4] = [
    "llama_server_path",
    "llama_server_companion_dir",
    "terminal_copilot_path",
    "terminal_pwsh_path",
];

/// Error-message prefix shared by every rejection:
/// ``invalid setting value for `<key>`: <rule>``.
pub const SETTING_VALUE_ERROR_PREFIX: &str = "invalid setting value for";

/// The ONE shared rule for the four sensitive path keys, used by BOTH write
/// planes (data plane and control plane — the control plane is not a bypass).
///
/// CLASSIFIES ONLY: it returns `Ok(())`/`Err(String)` and NEVER rewrites the
/// value. Every key outside [`SENSITIVE_PATH_SETTING_KEYS`] passes untouched
/// (no allowlist, no validation of any other key). For a sensitive key an empty
/// or whitespace-only value clears the setting (`Ok`). Otherwise the checks run
/// in this BINDING order and the FIRST match is returned:
///
/// 1. a control character (any char `< U+0020` or `U+007F`);
/// 2. not an absolute path;
/// 3. a `..` path component.
pub fn validate_setting_value(key: &str, value: &str) -> Result<(), String> {
    if !SENSITIVE_PATH_SETTING_KEYS.contains(&key) {
        return Ok(());
    }
    if value.trim().is_empty() {
        return Ok(());
    }
    if value.chars().any(|c| c < '\u{20}' || c == '\u{7f}') {
        return Err(format!(
            "{SETTING_VALUE_ERROR_PREFIX} `{key}`: path must not contain control characters"
        ));
    }
    if !Path::new(value).is_absolute() {
        return Err(format!(
            "{SETTING_VALUE_ERROR_PREFIX} `{key}`: path must be absolute"
        ));
    }
    if Path::new(value)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "{SETTING_VALUE_ERROR_PREFIX} `{key}`: path must not contain `..` components"
        ));
    }
    Ok(())
}

/// Data-plane write with validation. On `Ok` the accepted `value` is passed to
/// the store UNMODIFIED — no `trim()`, no separator rewrite, no normalisation:
/// trimming an accepted absolute binary path would change the executable a later
/// spawn runs.
pub async fn persist_setting(
    store: &SettingsStore,
    key: &str,
    value: &str,
) -> Result<(), String> {
    validate_setting_value(key, value)?;
    store.set(key, value).await.map_err(|e| e.to_string())
}

/// Control-plane (synchronous cache) write with the SAME shared validation. On
/// `Ok` the accepted `value` is passed to the store UNMODIFIED.
pub fn persist_control_setting(
    store: &SettingsStore,
    key: &str,
    value: &str,
) -> Result<(), String> {
    validate_setting_value(key, value)?;
    store.cached_set(key, value).map_err(|e| e.to_string())
}

/// Persist a setting through the engine-selected data plane.
#[tauri::command]
pub async fn save_setting(
    key: String,
    value: String,
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<(), String> {
    persist_setting(store.inner(), &key, &value).await
}

/// Retrieve a setting from the engine-selected data plane.
/// Returns `None` if the key has never been saved.
#[tauri::command]
pub async fn get_setting(
    key: String,
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<Option<String>, String> {
    store.get(&key).await.map_err(|e| e.to_string())
}

/// Read a setting from the synchronous settings cache (PG-hydrated).
///
/// This is the frontend seam for keys the backend reads synchronously (e.g.
/// the per-app window presentation map on the terminal per-emit hot path),
/// which must not route through the async, PostgreSQL-only data plane.
/// Returns `None` if the key has never been saved.
#[tauri::command]
pub async fn get_control_setting(
    key: String,
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<Option<String>, String> {
    store.cached_get(&key).map_err(|e| e.to_string())
}

/// Upsert a setting on the synchronous settings cache (write-through to
/// PostgreSQL).
#[tauri::command]
pub async fn save_control_setting(
    key: String,
    value: String,
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<(), String> {
    persist_control_setting(store.inner(), &key, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::storage::engine::EngineHandle;

    const RULE_CONTROL: &str = "path must not contain control characters";
    const RULE_ABSOLUTE: &str = "path must be absolute";
    const RULE_PARENT: &str = "path must not contain `..` components";

    fn open_store(dir: &std::path::Path) -> SettingsStore {
        SettingsStore::open(EngineHandle::new_pending(), dir).expect("open settings store")
    }

    fn non_absolute_value() -> String {
        "copilot.exe".to_string()
    }

    fn parent_value() -> String {
        std::env::temp_dir()
            .join("..")
            .join("evil.exe")
            .to_string_lossy()
            .into_owned()
    }

    fn control_value() -> String {
        std::env::temp_dir()
            .join("copi\u{0}ot.exe")
            .to_string_lossy()
            .into_owned()
    }

    fn expected_error(key: &str, rule: &str) -> String {
        format!("{SETTING_VALUE_ERROR_PREFIX} `{key}`: {rule}")
    }

    fn expect_reject(key: &str, value: &str, rule: &str) {
        let error = validate_setting_value(key, value)
            .expect_err(&format!("expected rejection for {key} / {rule} (value: {value:?})"));
        assert_eq!(
            error,
            expected_error(key, rule),
            "wrong message for {key} / {rule} (value: {value:?})"
        );
    }

    /// The 4 x 3 (key, rule) matrix, used by both-plane tests.
    fn matrix_cells() -> Vec<(&'static str, String, &'static str)> {
        let mut cells = Vec::new();
        for key in SENSITIVE_PATH_SETTING_KEYS {
            cells.push((key, non_absolute_value(), RULE_ABSOLUTE));
            cells.push((key, control_value(), RULE_CONTROL));
            cells.push((key, parent_value(), RULE_PARENT));
        }
        cells
    }

    // ── R-3.a: the shared rule, one test per (key, rule) cell ───────────────

    #[test]
    fn matrix_llama_server_path_non_absolute() {
        expect_reject("llama_server_path", &non_absolute_value(), RULE_ABSOLUTE);
    }

    #[test]
    fn matrix_llama_server_path_control_character() {
        expect_reject("llama_server_path", &control_value(), RULE_CONTROL);
    }

    #[test]
    fn matrix_llama_server_path_parent_dir() {
        expect_reject("llama_server_path", &parent_value(), RULE_PARENT);
    }

    #[test]
    fn matrix_llama_server_companion_dir_non_absolute() {
        expect_reject(
            "llama_server_companion_dir",
            &non_absolute_value(),
            RULE_ABSOLUTE,
        );
    }

    #[test]
    fn matrix_llama_server_companion_dir_control_character() {
        expect_reject("llama_server_companion_dir", &control_value(), RULE_CONTROL);
    }

    #[test]
    fn matrix_llama_server_companion_dir_parent_dir() {
        expect_reject("llama_server_companion_dir", &parent_value(), RULE_PARENT);
    }

    #[test]
    fn matrix_terminal_copilot_path_non_absolute() {
        expect_reject("terminal_copilot_path", &non_absolute_value(), RULE_ABSOLUTE);
    }

    #[test]
    fn matrix_terminal_copilot_path_control_character() {
        expect_reject("terminal_copilot_path", &control_value(), RULE_CONTROL);
    }

    #[test]
    fn matrix_terminal_copilot_path_parent_dir() {
        expect_reject("terminal_copilot_path", &parent_value(), RULE_PARENT);
    }

    #[test]
    fn matrix_terminal_pwsh_path_non_absolute() {
        expect_reject("terminal_pwsh_path", &non_absolute_value(), RULE_ABSOLUTE);
    }

    #[test]
    fn matrix_terminal_pwsh_path_control_character() {
        expect_reject("terminal_pwsh_path", &control_value(), RULE_CONTROL);
    }

    #[test]
    fn matrix_terminal_pwsh_path_parent_dir() {
        expect_reject("terminal_pwsh_path", &parent_value(), RULE_PARENT);
    }

    #[test]
    fn control_characters_cover_nul_and_del_for_every_key() {
        for key in SENSITIVE_PATH_SETTING_KEYS {
            let nul = std::env::temp_dir()
                .join("a\u{0}.exe")
                .to_string_lossy()
                .into_owned();
            let del = std::env::temp_dir()
                .join("a\u{7f}.exe")
                .to_string_lossy()
                .into_owned();
            expect_reject(key, &nul, RULE_CONTROL);
            expect_reject(key, &del, RULE_CONTROL);
        }
    }

    #[test]
    fn binding_check_order_is_control_then_absolute_then_parent() {
        // Control character + `..` + absolute: the CONTROL message wins.
        let control_and_parent = std::env::temp_dir()
            .join("a\u{1}")
            .join("..")
            .join("b.exe");
        expect_reject(
            "terminal_pwsh_path",
            &control_and_parent.to_string_lossy(),
            RULE_CONTROL,
        );
        // Absolute + `..` (no control): the `..` message.
        expect_reject("terminal_pwsh_path", &parent_value(), RULE_PARENT);
        // Relative + `..`: the absolute message (absolute is checked before `..`).
        let relative_parent = Path::new("..").join("evil.exe");
        expect_reject(
            "terminal_pwsh_path",
            &relative_parent.to_string_lossy(),
            RULE_ABSOLUTE,
        );
    }

    // ── R-3.a: both planes reject with the same error and write nothing ──────

    #[test]
    fn control_plane_rejects_each_matrix_cell_and_does_not_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        for (key, value, rule) in matrix_cells() {
            let error = persist_control_setting(&store, key, &value)
                .expect_err(&format!("control plane must reject {key} / {rule}"));
            assert_eq!(
                error,
                expected_error(key, rule),
                "control plane message for {key} / {rule}"
            );
        }
        for key in SENSITIVE_PATH_SETTING_KEYS {
            assert_eq!(
                store.cached_get(key).expect("cached_get"),
                None,
                "no rejected write may reach the control plane for {key}"
            );
        }
    }

    #[tokio::test]
    async fn data_plane_rejects_each_matrix_cell_with_the_same_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        for (key, value, rule) in matrix_cells() {
            let error = persist_setting(&store, key, &value)
                .await
                .expect_err(&format!("data plane must reject {key} / {rule}"));
            // The validation error, not an engine error: validation runs first.
            assert_eq!(
                error,
                expected_error(key, rule),
                "data plane message for {key} / {rule}"
            );
        }
        for key in SENSITIVE_PATH_SETTING_KEYS {
            assert_eq!(
                store.cached_get(key).expect("cached_get"),
                None,
                "no rejected write may reach the store for {key}"
            );
        }
    }

    // ── R-3.b: empty and whitespace-only clear on both planes ───────────────

    #[tokio::test]
    async fn empty_and_whitespace_clear_on_both_planes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        for key in SENSITIVE_PATH_SETTING_KEYS {
            for blank in ["", "   "] {
                assert_eq!(
                    validate_setting_value(key, blank),
                    Ok(()),
                    "a blank value clears {key}"
                );
                persist_control_setting(&store, key, blank)
                    .unwrap_or_else(|e| panic!("control plane must clear {key}: {e}"));
                let stored = store.cached_get(key).expect("cached_get");
                assert_eq!(
                    stored.as_deref().map(str::trim),
                    Some(""),
                    "the control plane clears {key} (value: {blank:?})"
                );

                // The headless store has no engine, so the data plane cannot
                // succeed here; the observable is that a blank value is never
                // classified as invalid.
                let error = persist_setting(&store, key, blank)
                    .await
                    .expect_err("the pending engine cannot complete a data-plane write");
                assert!(
                    !error.contains(SETTING_VALUE_ERROR_PREFIX),
                    "a blank value must not be a validation error for {key}: {error}"
                );
            }
        }
    }

    // ── R-3.c: a valid absolute path is accepted and stored unmodified ───────

    #[test]
    fn valid_absolute_path_is_stored_byte_identical() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let value = std::env::temp_dir()
            .join("qa-3078")
            .join("bin")
            .join("copilot.exe")
            .to_string_lossy()
            .into_owned();
        assert_eq!(validate_setting_value("terminal_copilot_path", &value), Ok(()));
        persist_control_setting(&store, "terminal_copilot_path", &value)
            .expect("a valid absolute path is accepted");
        assert_eq!(
            store.cached_get("terminal_copilot_path").expect("cached_get"),
            Some(value.clone()),
            "the accepted value must be stored byte-identical (no trim, no rewrite)"
        );
    }

    #[tokio::test]
    async fn valid_absolute_path_is_not_a_validation_error_on_the_data_plane() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let value = std::env::temp_dir()
            .join("qa-3078")
            .join("bin")
            .join("copilot.exe")
            .to_string_lossy()
            .into_owned();
        let error = persist_setting(&store, "llama_server_path", &value)
            .await
            .expect_err("the pending engine cannot complete a data-plane write");
        assert!(
            !error.contains(SETTING_VALUE_ERROR_PREFIX),
            "an accepted absolute path must reach the store, not the validator: {error}"
        );
    }

    // ── R-3.d: every other key round-trips unchanged (no allowlist) ─────────

    #[tokio::test]
    async fn non_listed_keys_round_trip_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let cases = [
            // A real non-listed path key with a `..`-bearing value.
            ("terminal_work_dir", "..\\..\\relative\\work"),
            ("app_window_presentation", "{\"doom\":\"float\"}"),
            // Arbitrary key carrying a control character AND `..`.
            ("qa_3078_probe", "a\u{7f}b..c"),
        ];
        for (key, value) in cases {
            assert_eq!(
                validate_setting_value(key, value),
                Ok(()),
                "{key} is not one of the four and must not be validated"
            );
            persist_control_setting(&store, key, value)
                .unwrap_or_else(|e| panic!("the control plane must accept {key}: {e}"));
            assert_eq!(
                store.cached_get(key).expect("cached_get"),
                Some(value.to_string()),
                "{key} must round-trip unchanged"
            );
            let error = persist_setting(&store, key, value)
                .await
                .expect_err("the pending engine cannot complete a data-plane write");
            assert!(
                !error.contains(SETTING_VALUE_ERROR_PREFIX),
                "{key} must never be validated on the data plane: {error}"
            );
        }
    }

    // ── Windows path semantics pinned by the QA plan ────────────────────────

    #[cfg(windows)]
    #[test]
    fn windows_qa_literal_is_accepted_byte_identical() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let value = "C:\\Code\\fredo\\.opencode\\tmp\\3078\\qa\\bin\\copilot.exe";
        persist_control_setting(&store, "terminal_copilot_path", value)
            .expect("the QA absolute literal is accepted");
        assert_eq!(
            store.cached_get("terminal_copilot_path").expect("cached_get"),
            Some(value.to_string())
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_prefix_only_and_leading_space_paths_are_not_absolute() {
        expect_reject("terminal_pwsh_path", "C:bin\\copilot.exe", RULE_ABSOLUTE);
        expect_reject(
            "terminal_pwsh_path",
            " C:\\bin\\copilot.exe",
            RULE_ABSOLUTE,
        );
        // `Path::is_absolute()` on Windows requires a drive/UNC prefix, so a
        // POSIX-style root-relative path is NOT absolute here.
        expect_reject("terminal_pwsh_path", "/usr/bin/x", RULE_ABSOLUTE);
    }
}
