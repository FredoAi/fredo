//! Spec #3146 — the committed static guards over the installed tier's authority
//! surface.
//!
//! # Why this module is `#[cfg(test)]`
//!
//! It asserts properties of COMMITTED STATIC ARTEFACTS (`capabilities/*.json`,
//! `permissions/app/default.toml`, the manifest list and the `generate_handler!`
//! registration), so it belongs in the test target: `cargo test --lib` is the gate
//! that runs it, and it must not compile a line of runtime code.
//!
//! # The property, stated once
//!
//! #3147 shipped *"an installed window matches NO capability"*. #3146 supersedes
//! that invariant — supersedes, never deletes — with a tighter one:
//!
//! > An installed window matches **exactly one** capability, which grants
//! > **exactly one** command, with **no** `core:*` permission; every other
//! > capability still matches no installed label.
//!
//! The second clause is what makes "exactly one command" true at the ACL: with
//! `build.rs` registering the app manifest, a command reaches a window only
//! through a capability that names a permission granting it, so a command absent
//! from the installed capability cannot be invoked by an installed document. A
//! second capability matching `installed-*` — or a second permission in the one
//! that does — is a widening, and these guards redden on it.
//!
//! # Instrument discipline
//!
//! The matcher PARSES the capability JSON and glob-matches the probe label against
//! each file's `windows` / `webviews` arrays. It is deliberately NOT a token grep:
//! `installed-app-commands.json` names the installed namespace by design, so a
//! literal `installed-` search now legitimately hits on a correct tree (G-430).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::command_manifest::COMMAND_MANIFEST;

/// The probe label: a valid installed window label. The instrument lives in the
/// test target, never inside the scanned root, so it cannot count its own text.
const INSTALLED_PROBE: &str = "installed-qa3146-app-a";

/// The ONE capability that may reach the installed tier.
const INSTALLED_CAPABILITY_FILE: &str = "installed-app-commands.json";
const INSTALLED_CAPABILITY_IDENTIFIER: &str = "installed-app-commands";
const INSTALLED_CAPABILITY_PERMISSION: &str = "allow-installed-app-invoke";

/// The four built-in window patterns every other capability must stay inside.
const BUILT_IN_WINDOW_PATTERNS: [&str; 4] = ["main", "terminal", "doom", "app-*"];

fn capabilities_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities")
}

/// Every capability file, parsed, sorted by file name (a directory listing — the
/// file COUNT is an observation, never the assertion).
fn capability_files() -> Vec<(String, Value)> {
    let dir = capabilities_dir();
    let entries = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("capabilities dir {} is unreadable: {error}", dir.display()));
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .expect("a utf-8 file name")
                .to_string();
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
            let parsed: Value = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("{name} is not valid JSON: {error}"));
            (name, parsed)
        })
        .collect()
}

fn window_patterns(capability: &Value) -> Vec<String> {
    let mut patterns = Vec::new();
    for key in ["windows", "webviews"] {
        if let Some(values) = capability.get(key).and_then(Value::as_array) {
            for value in values {
                if let Some(pattern) = value.as_str() {
                    patterns.push(pattern.to_string());
                }
            }
        }
    }
    patterns
}

/// Tauri's capability window matcher, minimally: `*` matches any run of
/// characters (including none), everything else is literal. Sufficient for every
/// pattern this repo ships and for the probes below; a pattern this matcher
/// cannot express would be a capability authoring change, not a silent skip.
fn pattern_matches(pattern: &str, label: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == label;
    }

    let first = parts[0];
    let Some(mut rest) = label.strip_prefix(first) else {
        return false;
    };

    let last_index = parts.len() - 1;
    for (index, part) in parts.iter().enumerate().skip(1) {
        if index == last_index {
            return rest.ends_with(part);
        }
        match rest.find(part) {
            Some(position) => rest = &rest[position + part.len()..],
            None => return false,
        }
    }
    true
}

fn matches_any(capability: &Value, label: &str) -> bool {
    window_patterns(capability).iter().any(|pattern| pattern_matches(pattern, label))
}

fn matching_files(label: &str) -> Vec<String> {
    capability_files()
        .into_iter()
        .filter(|(_, capability)| matches_any(capability, label))
        .map(|(name, _)| name)
        .collect()
}

#[test]
fn the_matcher_is_not_vacuous_in_either_direction() {
    // The built-in class is reachable through `app-*` ...
    assert!(pattern_matches("app-*", "app-terminal"));
    // ... and an installed label is NOT, and vice versa. Both directions matter:
    // a matcher that swallowed both families would blur the two tiers while every
    // count below still read correctly.
    assert!(!pattern_matches("app-*", INSTALLED_PROBE));
    assert!(pattern_matches("installed-*", INSTALLED_PROBE));
    assert!(!pattern_matches("installed-*", "app-terminal"));
    assert!(!pattern_matches("installed-*", "main"));
    assert!(pattern_matches("main", "main"));
    assert!(!pattern_matches("main", "installed-main"));
    assert!(pattern_matches("*", "anything"));
    assert!(!pattern_matches("app-*", "app"));
    assert!(pattern_matches("app-*", "app-"));
}

/// F-2.5 / F-2.6 (inverted) / F-7.4 — exactly ONE capability reaches the installed
/// tier, it grants exactly one command, and it carries no `core:*`.
#[test]
fn exactly_one_capability_reaches_the_installed_tier() {
    let matching = matching_files(INSTALLED_PROBE);
    assert_eq!(
        matching,
        vec![INSTALLED_CAPABILITY_FILE.to_string()],
        "exactly one capability file may match an installed label; matching files: {matching:?}"
    );

    let files = capability_files();
    let (_, installed) = files
        .iter()
        .find(|(name, _)| name.as_str() == INSTALLED_CAPABILITY_FILE)
        .expect("the installed-tier capability file exists");

    assert_eq!(
        installed.get("identifier").and_then(Value::as_str),
        Some(INSTALLED_CAPABILITY_IDENTIFIER)
    );
    let windows: Vec<&str> = installed
        .get("windows")
        .and_then(Value::as_array)
        .expect("the installed capability declares its `windows` reach explicitly")
        .iter()
        .map(|window| window.as_str().expect("every window entry is a string"))
        .collect();
    assert_eq!(
        windows,
        vec!["installed-*"],
        "the installed tier is the `installed-*` family, never a per-application label"
    );
    assert!(
        installed.get("webviews").is_none(),
        "the installed capability scopes by window LABEL only — a `webviews` entry would be a second reach surface"
    );

    let permissions: Vec<&str> = installed
        .get("permissions")
        .and_then(Value::as_array)
        .expect("permissions is an array")
        .iter()
        .map(|permission| {
            permission
                .as_str()
                .expect("every permission entry is a string")
        })
        .collect();
    assert_eq!(
        permissions,
        vec![INSTALLED_CAPABILITY_PERMISSION],
        "exactly one permission, exactly the dispatcher's"
    );
    assert!(
        permissions.iter().all(|permission| !permission.starts_with("core:")),
        "the installed tier carries NO core:* permission (no window creation, no event listen, no drag)"
    );

    // The one permission is the autogenerated grant for the one command, and that
    // command is registered, listed and granted.
    assert_eq!(
        INSTALLED_CAPABILITY_PERMISSION,
        "allow-installed-app-invoke",
        "the permission naming rule is `allow-<command with - for _>`"
    );
    assert!(
        COMMAND_MANIFEST.contains(&"installed_app_invoke"),
        "the dispatcher must be a COMMAND_MANIFEST entry"
    );
    let lib = include_str!("../lib.rs");
    assert!(
        lib.contains("installed_app_invoke"),
        "the dispatcher must be registered in lib.rs's generate_handler![]"
    );
    let built_in_grants = include_str!("../../permissions/app/default.toml");
    assert!(
        built_in_grants.contains("\"allow-installed-app-invoke\""),
        "the shipped guard requires every REGISTERED command to be granted in \
         permissions/app/default.toml; losing the grant denies the command everywhere"
    );

    // ... and NOTHING else. A second permission with that shape would be a second
    // command reachable from an installed window.
    let granted_commands: Vec<&str> = permissions
        .iter()
        .map(|permission| {
            permission
                .strip_prefix("allow-")
                .expect("every grant is an allow-<command>")
        })
        .collect();
    assert_eq!(
        granted_commands,
        vec!["installed-app-invoke"],
        "an installed window reaches exactly one command"
    );
}

/// F-2.5 (4)/(6) — every OTHER capability matches no installed label, and stays
/// inside the four built-in window patterns.
#[test]
fn every_other_capability_matches_no_installed_label() {
    for (name, capability) in capability_files() {
        if name == INSTALLED_CAPABILITY_FILE {
            continue;
        }
        assert!(
            !matches_any(&capability, INSTALLED_PROBE),
            "{name} matches {INSTALLED_PROBE}; only {INSTALLED_CAPABILITY_FILE} may reach the installed tier"
        );
        assert!(
            !matches_any(&capability, "installed-"),
            "{name} matches the bare installed prefix"
        );

        let patterns = window_patterns(&capability);
        assert!(
            !patterns.is_empty(),
            "{name} declares no windows and no webviews, so its reach cannot be read off its own declaration"
        );
        for pattern in &patterns {
            assert!(
                BUILT_IN_WINDOW_PATTERNS.contains(&pattern.as_str()),
                "{name} declares the window pattern {pattern:?}, which is outside the four built-in labels"
            );
        }
    }
}

/// The built-in class keeps its full surface: `app-commands.json` still targets
/// all four built-in labels and still references the app-manifest default set.
#[test]
fn the_built_in_capability_still_targets_the_whole_built_in_class() {
    let files = capability_files();
    let (_, built_in) = files
        .iter()
        .find(|(name, _)| name.as_str() == "app-commands.json")
        .expect("capabilities/app-commands.json exists");

    assert_eq!(window_patterns(built_in), BUILT_IN_WINDOW_PATTERNS.to_vec());
    let permissions: Vec<&str> = built_in
        .get("permissions")
        .and_then(Value::as_array)
        .expect("permissions is an array")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        permissions,
        vec!["default"],
        "the built-in class reaches the app-manifest default permission set"
    );
    assert!(
        !permissions.iter().any(|permission| permission.starts_with("allow-")),
        "the built-in grant stays the SET reference, not a per-command list — the set is what keeps tier 1 unreduced"
    );
}
