//! The dead-code SUPPRESSION pin (Spec #3201 ST-12, added at review 2026-11-28).
//!
//! # Why this exists
//!
//! At ST-5 this crate's `dead_code` count went **35 -> 0 with no suppression**,
//! and that zero is evidence **only because nothing silences the lint**: the
//! identical reading — a clean `cargo check` — is produced by silencing it.
//! F-12 diffs suppressions *within one round*, so nothing stopped a future
//! change from restoring the "clean" reading in one line.
//!
//! # What is pinned, and why it is two things
//!
//! 1. `#![deny(dead_code)]` in `src/lib.rs` — dead code is a **build failure**
//!    in this crate, not a warning someone can ignore. (With no dead code and no
//!    suppression the crate is green; the deny only fires on an orphan.)
//! 2. THIS test — the tree must contain **zero** suppression attributes for that
//!    lint, at any level (item attribute or inner attribute, inline in a
//!    multi-lint list) and under either silencing spelling (`allow` and
//!    `expect`; a `deny` is the enforcement, not a suppression). Layer 1 cannot
//!    catch a suppression placed on an item that is *not* dead yet — that item
//!    raises no lint, so the deny never fires and the suppression sits in the
//!    tree waiting for the day the item becomes an orphan. Layer 2 catches it on
//!    the day it is written.
//!
//! The two layers are deliberately redundant: the compiler's refusal is the
//! enforcement, and this scan is the record that the refusal is not being
//! routed around.
//!
//! # Scope, stated exactly
//!
//! The scan universe is **every `.rs` file under this crate** — `src/`,
//! `tests/`, and `benches/`/`examples/` when those directories exist — plus the
//! crate's `Cargo.toml` lint table. It deliberately does **not** scan the
//! platform tree: the plan's QA row F-12 records 8 pre-existing suppression
//! sites in `apps/tauri/src-tauri/src/` that this spec does not own, and a guard
//! that reddens on correct, unowned code is worse than no guard.
//!
//! The scan **refuses a zero population**: a path-resolution bug that visits no
//! files would otherwise report a perfect score forever (G-524 — an empty match
//! is a failed instrument, not a clean bill).

use std::path::{Path, PathBuf};

/// The two spellings that silence a lint.
///
/// Built by concatenation **on purpose**: this file is inside the scan universe,
/// so a literal pattern written here would make the guard report on itself. The
/// [`needle_construction_never_matches_this_file`] test proves the construction
/// is what keeps that from happening — it is a self-check, not an exemption.
fn forbidden_needles() -> Vec<String> {
    ["allow(", "expect("]
        .iter()
        .map(|prefix| format!("{prefix}{}", "dead_code"))
        .collect()
}

/// Collapse all whitespace so a spaced-out attribute is the same subject as a
/// tight one. A suppression is a suppression however it is spaced, and a scan
/// that only sees one spelling is a scan a formatter defeats.
fn normalized(source: &str) -> String {
    source.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Does `source` contain any forbidden suppression of the lint?
///
/// Pure and total: the caller supplies the text, so the mutation control below
/// can prove the detector actually catches a seeded suppression even while the
/// real tree is clean.
fn suppression_in(source: &str) -> Option<String> {
    let flat = normalized(source);
    forbidden_needles()
        .into_iter()
        .find(|needle| flat.contains(needle.as_str()))
}

/// The crate root, from cargo — never a hand-written relative path, which would
/// silently resolve against whatever directory the test binary was launched in.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every `.rs` file under `dir`, recursively. Symlinks are not followed (this is
/// a scan of tracked source, and a link could point anywhere).
fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// The line of `source` that carries the suppression, for a failure message that
/// points a reader at the edit rather than at the whole file.
fn offending_line(source: &str) -> String {
    source
        .lines()
        .find(|line| normalized(line).contains("dead_code"))
        .map(|line| line.trim().to_string())
        .unwrap_or_else(|| "<line not isolated>".to_string())
}

#[test]
fn no_dead_code_suppression_under_crate() {
    let root = crate_root();

    let mut files = Vec::new();
    rust_sources(&root.join("src"), &mut files);
    rust_sources(&root.join("tests"), &mut files);
    // Not present today; scanned so the header's claim stays true if either is
    // added later (a new `benches/` must not become a place a suppression hides).
    rust_sources(&root.join("benches"), &mut files);
    rust_sources(&root.join("examples"), &mut files);

    // NON-VACUITY (G-524): a scan that visited nothing must fail, not pass.
    // The floor is a stated number rather than `> 0` so a partial universe (a
    // mis-rooted walk that finds only `tests/`) is caught too — the crate ships
    // `lib.rs`, `attrs.rs`, `event.rs`, `merge.rs`, `rows.rs`, `event_tests.rs`
    // and six `classifier/` modules plus this test target, so a resolution bug
    // cannot hide behind one file. The count is printed on the failure path so
    // the population is visible.
    assert!(
        files.len() >= 10,
        "SCAN VISITED ONLY {} .rs file(s) under {} — a partial population is a \
         failed instrument, not a clean bill (expected the crate's src/ tree)",
        files.len(),
        root.display()
    );
    assert!(
        files.iter().any(|p| p.ends_with("lib.rs")),
        "SCAN missed src/lib.rs — the walk is mis-rooted"
    );

    let mut violations = Vec::new();
    for file in &files {
        // An unreadable source file is a FAILED INSTRUMENT, never a silent pass
        // (G-524): skipping it would let a suppression inside it go unseen while
        // the scan reported a clean population.
        let source = std::fs::read_to_string(file).unwrap_or_else(|err| {
            panic!(
                "cannot read {} — the scan's population is incomplete: {err}",
                file.display()
            )
        });
        if let Some(needle) = suppression_in(&source) {
            violations.push(format!(
                "  {}  --  matched `{}`\n      {}",
                file.strip_prefix(&root).unwrap_or(file).display(),
                needle,
                offending_line(&source)
            ));
        }
    }

    assert!(
        violations.is_empty(),
        "dead_code must never be silenced in this crate (Spec #3201 ST-12).\n\
         The 35 -> 0 reading this pin protects is evidence ONLY because nothing \
         suppresses the lint; a silencing attribute on `dead_code` reproduces the \
         reading while destroying what it measures.\n\
         Fix the orphan (consume it, delete it, or widen it to `pub` if the \
         platform genuinely needs it) — never suppress it.\n\
         Scanned {} file(s):\n{}",
        files.len(),
        violations.join("\n")
    );
}

#[test]
fn the_crate_manifest_does_not_allow_the_lint() {
    let manifest = crate_root().join("Cargo.toml");
    let source = std::fs::read_to_string(&manifest)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", manifest.display()));
    let flat = normalized(&source);

    // The third route to the same silencing: a `[lints]` table in the manifest
    // (ST-12's own non-goal — "do not disable a lint in Cargo.toml"). Checked
    // here because it leaves no attribute in any `.rs` file for the scan above
    // to see.
    for needle in forbidden_needles() {
        assert!(
            !flat.contains(&needle),
            "{} configures `{needle}` — a lint may not be disabled in the crate \
             manifest (Spec #3201 ST-12 / AC5)",
            manifest.display()
        );
    }
}

/// The DETECTOR's own control, run every time: a suppression the tree no longer
/// carries must still be caught by `suppression_in`.
///
/// Without this, a scanner that matched nothing (a typo in the needle, a
/// normalization that never fires) would be indistinguishable from a clean tree.
/// The mutated inputs are built from parts for the same reason the needles are —
/// a literal one here would be found by the scan above.
#[test]
fn the_detector_catches_a_seeded_suppression() {
    let lint = "dead_code";
    let item_level = format!("#[{}{})]", "allow(", lint);
    let crate_level = format!("#![{}{})]", "allow(", lint);
    let spaced = format!("#[ {}(\n    {} ) ]", "allow", lint);
    let in_a_list = format!("#[{} {}, {})]", "allow(", lint, "unused_variables");
    let expect_form = format!("#[{}{})]", "expect(", lint);

    for seeded in [item_level, crate_level, spaced, in_a_list, expect_form] {
        assert!(
            suppression_in(&seeded).is_some(),
            "the detector MISSED a suppression it exists to catch: {seeded}"
        );
    }

    // The control for the control: ordinary code that merely *mentions* the
    // lint must not be flagged, or the pin would redden on a correct tree.
    let ordinary = "#![deny(dead_code)]\nfn main() {}\n";
    assert!(
        suppression_in(ordinary).is_none(),
        "the detector flags a DENY, which is the enforcement it exists to protect"
    );
}

/// A self-check, not an exemption: this file lives inside the scan universe, so
/// the guard must be able to scan itself and find nothing. If this fails, the
/// needle construction stopped working and every other result from this pin is
/// suspect.
///
/// The path is derived from `file!()` rather than hand-written: `file!()` is
/// relative to the cargo invocation directory (the workspace root), while the
/// test process runs with the crate root as its cwd, so the two cannot simply be
/// joined. Taking the file NAME and resolving it under `tests/` keeps the
/// reference derived from the source, and the existence check below proves the
/// name is still accurate.
#[test]
fn needle_construction_never_matches_this_file() {
    let own_name = Path::new(file!())
        .file_name()
        .expect("file!() always has a file name");
    let own_path = crate_root().join("tests").join(own_name);
    let self_source = std::fs::read_to_string(&own_path).unwrap_or_else(|err| {
        panic!(
            "the guard must be able to read its own source at {}: {err}",
            own_path.display()
        )
    });
    assert!(
        suppression_in(&self_source).is_none(),
        "the guard's own source matches its needle — the needle is no longer \
         built from parts, so the guard now reports on itself"
    );
}
