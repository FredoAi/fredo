//! Doom Mode engine-spawn failure seam (Spec #3013, ST-4 / CU-1).
//!
//! **G-275 / G-300** test-only failure-induction lever. This replaces the
//! removed engine-path env seam and the dev-only anti-stub env seam (both
//! removed by #3013 ST-1) with a single deterministic lever: when
//! `FREDO_DOOM_FAIL_ENGINE_SPAWN` is set
//! to `1`, the launch path returns `DoomErrorCode::SpawnFailed` before invoking
//! the real spawn. It is **inert when unset**, so the production path is
//! unchanged. The consumer is `super::commands::launch_doom_runtime` (CU-2/ST-2).
//!
//! This module performs no I/O beyond reading the process environment.

/// The `FREDO_DOOM_FAIL_ENGINE_SPAWN` lever (G-275): when set to `1`, the launch
/// path fails before any engine process is created. Inert when unset, so the
/// production path is unchanged.
pub const DOOM_FAIL_ENGINE_SPAWN_ENV: &str = "FREDO_DOOM_FAIL_ENGINE_SPAWN";

/// The `FREDO_DOOM_FAIL_ENGINE_SPAWN` lever: `true` iff set to `"1"`.
pub fn fail_engine_spawn_requested() -> bool {
    fail_engine_spawn_from(std::env::var(DOOM_FAIL_ENGINE_SPAWN_ENV).ok().as_deref())
}

/// Pure parser for the failure lever (unit-testable without env mutation).
pub fn fail_engine_spawn_from(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fail_engine_spawn_lever_parser() {
        assert!(fail_engine_spawn_from(Some("1")));
        assert!(fail_engine_spawn_from(Some(" 1 ")));
        assert!(!fail_engine_spawn_from(Some("0")));
        assert!(!fail_engine_spawn_from(Some("01")));
        assert!(!fail_engine_spawn_from(Some("true")));
        assert!(!fail_engine_spawn_from(Some("")));
        assert!(!fail_engine_spawn_from(Some("   ")));
        assert!(!fail_engine_spawn_from(None));
    }

    #[test]
    fn binding_names_are_pinned() {
        assert_eq!(DOOM_FAIL_ENGINE_SPAWN_ENV, "FREDO_DOOM_FAIL_ENGINE_SPAWN");
    }
}
