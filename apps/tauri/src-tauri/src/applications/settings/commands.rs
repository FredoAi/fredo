use std::path::{Component, Path};
use std::sync::Arc;

use crate::infrastructure::storage::SettingsStore;

/// The three settings keys whose values select an executable (or a directory a
/// later trusted spawn reads binaries from). A compromised webview must not be
/// able to poison one of them into pointing at an arbitrary target.
///
/// `llama_server_path` was RETIRED from this set by Spec #3141: companion
/// inference runs in-process, so the key no longer selects an executable and
/// there is nothing to poison. A stale persisted value is INERT — it is never
/// read for resolution, never validated here, and never deleted (AC-9/R-17.4).
///
/// The literals are LOCAL by design: engineering rules forbid cross-application
/// imports, so this module must not import the `llm_server` / `terminal`
/// constants that declare the same keys.
pub const SENSITIVE_PATH_SETTING_KEYS: [&str; 3] = [
    "llama_server_companion_dir",
    "terminal_copilot_path",
    "terminal_pwsh_path",
];

/// Error-message prefix shared by every rejection:
/// ``invalid setting value for `<key>`: <rule>``.
pub const SETTING_VALUE_ERROR_PREFIX: &str = "invalid setting value for";

/// The companion backend switch key. Declared LOCAL by design: engineering
/// rules forbid cross-application imports, so this module must not import the
/// `llm_server` constant that declares the same key.
pub const LLAMA_SERVER_BACKEND_KEY: &str = "llama_server_backend";

/// The CLOSED value set for [`LLAMA_SERVER_BACKEND_KEY`] (lowercase). A value
/// outside it is rejected at BOTH write planes, so a free-form value can never
/// be persisted — and therefore never reaches engine configuration
/// (Spec #3141, AC-24.1).
pub const COMPANION_BACKEND_MODES: [&str; 3] = ["auto", "gpu", "cpu"];

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
    // The backend switch is a CLOSED enum: only `auto` | `gpu` | `cpu`
    // (lowercase) are accepted. A blank value is allowed (it clears the setting,
    // and an absent value coerces to `auto` on read).
    if key == LLAMA_SERVER_BACKEND_KEY {
        if value.trim().is_empty() {
            return Ok(());
        }
        if COMPANION_BACKEND_MODES.contains(&value) {
            return Ok(());
        }
        return Err(format!(
            "{SETTING_VALUE_ERROR_PREFIX} `{key}`: must be one of {}",
            COMPANION_BACKEND_MODES.join(", ")
        ));
    }
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
///
/// ## ONE write rule: the cache is the source of truth (Spec #3141 fix F3)
///
/// This writes through [`SettingsStore::cached_set`], which updates the
/// synchronous cache AND durably upserts into PostgreSQL. It used to call
/// [`SettingsStore::set`] (PG only), which left the cache stale — and the cache
/// is what every synchronous backend reader uses (`get_control_setting`, and the
/// engine's `backend_mode`). The result was a split brain: `save_setting` wrote
/// `cpu` while the engine still read the cached `gpu`, so the AC-25 recovery
/// drill looped on `gpuUnavailable` forever.
///
/// There is deliberately ONE rule for both IPC names
/// ([`persist_setting`] / [`persist_control_setting`]): the async data plane, the
/// synchronous cache and the engine can never disagree. Both names are kept
/// because both are shipped IPC seams.
pub async fn persist_setting(
    store: &SettingsStore,
    key: &str,
    value: &str,
) -> Result<(), String> {
    validate_setting_value(key, value)?;
    store.cached_set(key, value).map_err(|e| e.to_string())
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

    /// The 3 x 3 (key, rule) matrix, used by both-plane tests.
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
    }    // ── R-3.b: empty and whitespace-only clear on both planes ───────────────

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

                // F3: BOTH planes converge on the cache write-through, so a blank
                // value clears on the data plane too (it used to reach PG only and
                // leave the cache stale).
                persist_setting(&store, key, blank)
                    .await
                    .unwrap_or_else(|e| panic!("data plane must clear {key}: {e}"));
                let stored = store.cached_get(key).expect("cached_get");
                assert_eq!(
                    stored.as_deref().map(str::trim),
                    Some(""),
                    "the data plane clears {key} (value: {blank:?})"
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
    async fn valid_absolute_path_is_stored_byte_identical_on_the_data_plane() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let value = std::env::temp_dir()
            .join("qa-3078")
            .join("bin")
            .join("copilot.exe")
            .to_string_lossy()
            .into_owned();
        // F3: the data plane is the SAME cache write-through now, so an accepted
        // value lands where the synchronous readers look.
        persist_setting(&store, "terminal_pwsh_path", &value)
            .await
            .expect("an accepted absolute path must be stored");
        assert_eq!(
            store.cached_get("terminal_pwsh_path").expect("cached_get"),
            Some(value.clone()),
            "the data plane must store the accepted value byte-identical"
        );
    }

    // ── Spec #3141 R-17.4 / AC-9: the retired llama_server_path is INERT ──────

    /// The retired key is no longer one of the sensitive path keys (4 → 3), and a
    /// stale persisted value round-trips UNCHANGED: it is never validated, never
    /// rewritten and never deleted.
    #[test]
    fn the_retired_llama_server_path_is_inert_and_never_deleted() {
        assert_eq!(
            SENSITIVE_PATH_SETTING_KEYS.len(),
            3,
            "the retired executable key must be off the list (4 → 3)"
        );
        assert!(
            !SENSITIVE_PATH_SETTING_KEYS.contains(&"llama_server_path"),
            "`llama_server_path` must not be a sensitive path key any more"
        );

        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        // A stale value that would FAIL every sensitive-path rule (relative, a
        // control character, and a `..` component) is still accepted verbatim —
        // nothing validates it any more, and nothing deletes it.
        let stale = "a\u{7f}b..relative\\llama-server.exe";
        persist_control_setting(&store, "llama_server_path", stale)
            .expect("the retired key is not validated and must be stored as given");
        assert_eq!(
            store.cached_get("llama_server_path").expect("cached_get"),
            Some(stale.to_string()),
            "a stale persisted llama_server_path must round-trip byte-identical (never deleted)"
        );
        // A second write (the engine never rewrites it) leaves the value intact.
        persist_control_setting(&store, "llama_server_path", stale)
            .expect("idempotent write");
        assert_eq!(
            store.cached_get("llama_server_path").expect("cached_get"),
            Some(stale.to_string())
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
                "{key} is not one of the three and must not be validated"
            );
            persist_control_setting(&store, key, value)
                .unwrap_or_else(|e| panic!("the control plane must accept {key}: {e}"));
            assert_eq!(
                store.cached_get(key).expect("cached_get"),
                Some(value.to_string()),
                "{key} must round-trip unchanged"
            );
            // F3: the data plane is the SAME write-through, so it round-trips too
            // (and is never validated: {key} is not one of the three).
            persist_setting(&store, key, value)
                .await
                .unwrap_or_else(|e| panic!("the data plane must accept {key}: {e}"));
            assert_eq!(
                store.cached_get(key).expect("cached_get"),
                Some(value.to_string()),
                "{key} must round-trip unchanged on the data plane too"
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

    // ── Spec #3141 ST-1: the backend switch is a CLOSED enum ────────────────

    /// Only `auto` | `gpu` | `cpu` are accepted; a free-form value is rejected on
    /// BOTH planes, so it can never be persisted and never reach the engine.
    #[test]
    fn backend_switch_accepts_only_the_three_closed_modes() {
        for value in COMPANION_BACKEND_MODES {
            assert_eq!(
                validate_setting_value(LLAMA_SERVER_BACKEND_KEY, value),
                Ok(()),
                "{value} must be accepted"
            );
        }

        // A blank value clears the setting (an absent value coerces to `auto`).
        assert_eq!(validate_setting_value(LLAMA_SERVER_BACKEND_KEY, ""), Ok(()));
        assert_eq!(validate_setting_value(LLAMA_SERVER_BACKEND_KEY, "   "), Ok(()));

        // Anything outside the set is rejected with the closed-set message.
        for value in ["tensorrt", "GPU", "auto ", "cuda", "1", "auto,gpu"] {
            let error = validate_setting_value(LLAMA_SERVER_BACKEND_KEY, value)
                .expect_err(&format!("{value:?} must be rejected"));
            assert!(
                error.contains("must be one of auto, gpu, cpu"),
                "unexpected message for {value:?}: {error}"
            );
        }
    }

    /// The closed-enum rejection holds on BOTH write planes, and nothing is
    /// written when it rejects.
    #[test]
    fn backend_switch_rejects_a_free_form_value_on_both_planes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        let error = persist_control_setting(&store, LLAMA_SERVER_BACKEND_KEY, "tensorrt")
            .expect_err("the control plane must reject a free-form backend");
        assert!(error.contains("must be one of auto, gpu, cpu"), "{error}");
        assert_eq!(
            store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
            None,
            "a rejected backend write must never reach the store"
        );

        // A closed-enum value is accepted and stored.
        persist_control_setting(&store, LLAMA_SERVER_BACKEND_KEY, "cpu")
            .expect("cpu is a valid backend");
        assert_eq!(
            store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
            Some("cpu".to_string())
        );
    }

    // ── Spec #3141 fix F3: save_setting ⇄ get_control_setting parity ────────

    /// THE parity pin for the settings split-brain: a value written through the
    /// SHIPPED control's path (`save_setting` ⇒ [`persist_setting`]) must be
    /// visible to the SHIPPED synchronous read (`get_control_setting` ⇒
    /// [`SettingsStore::cached_get`]) — and `save_control_setting` must stay just
    /// as visible.
    ///
    /// Before the fix `persist_setting` wrote PostgreSQL only, so
    /// `get_control_setting` (the engine's `backend_mode` read) kept returning the
    /// PREVIOUS value: the AC-25 recovery drill looped on `gpuUnavailable` because
    /// the engine never saw the new `cpu` selection.
    ///
    /// The headless harness has no PostgreSQL engine, so `cached_set` takes its
    /// documented pre-hydration path (cache update + buffered durable write). The
    /// CACHE is exactly the observable that was missing — it is the seam every
    /// synchronous backend reader uses — so parity is asserted there in both
    /// directions.
    #[tokio::test]
    async fn save_setting_and_get_control_setting_agree_on_the_backend_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        // Seed the stale value the split-brain left behind.
        persist_control_setting(&store, LLAMA_SERVER_BACKEND_KEY, "gpu")
            .expect("seed the cached backend");
        assert_eq!(
            store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
            Some("gpu".to_string())
        );

        // The SHIPPED control's write: `save_setting` ⇒ `persist_setting`.
        persist_setting(&store, LLAMA_SERVER_BACKEND_KEY, "cpu")
            .await
            .expect("save_setting must persist cpu");

        // PARITY: the synchronous read (the engine's `backend_mode` seam) sees it.
        assert_eq!(
            store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
            Some("cpu".to_string()),
            "`get_control_setting` must see the value `save_setting` wrote — this is the \
             split-brain the AC-25 recovery drill died on"
        );

        // The other direction: `save_control_setting` stays visible too (the two
        // IPC names converge on ONE write rule).
        persist_control_setting(&store, LLAMA_SERVER_BACKEND_KEY, "auto")
            .expect("save_control_setting must persist auto");
        assert_eq!(
            store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
            Some("auto".to_string())
        );
        persist_setting(&store, LLAMA_SERVER_BACKEND_KEY, "gpu")
            .await
            .expect("save_setting must persist gpu");
        assert_eq!(
            store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
            Some("gpu".to_string())
        );
    }

    /// Every closed-enum mode round-trips through the `save_setting` write path to
    /// the synchronous read — not just the one the drill exercises.
    #[tokio::test]
    async fn every_backend_mode_written_by_save_setting_is_cached() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        for mode in COMPANION_BACKEND_MODES {
            persist_setting(&store, LLAMA_SERVER_BACKEND_KEY, mode)
                .await
                .unwrap_or_else(|e| panic!("save_setting must persist {mode}: {e}"));
            assert_eq!(
                store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
                Some(mode.to_string()),
                "{mode} must be visible to the synchronous reader"
            );
        }
    }

    /// The closed-enum rejection holds on the `persist_setting` path too: a
    /// free-form value never reaches EITHER plane.
    #[tokio::test]
    async fn save_setting_rejects_a_free_form_backend_and_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let error = persist_setting(&store, LLAMA_SERVER_BACKEND_KEY, "tensorrt")
            .await
            .expect_err("save_setting must reject a free-form backend");
        assert!(error.contains("must be one of auto, gpu, cpu"), "{error}");
        assert_eq!(
            store.cached_get(LLAMA_SERVER_BACKEND_KEY).expect("cached_get"),
            None,
            "a rejected backend write must never reach the cache"
        );
    }
}
