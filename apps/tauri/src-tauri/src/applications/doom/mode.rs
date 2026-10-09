//! Doom Mode state machine + wire contract (Spec #2970, ST-2).
//!
//! This module is the SINGLE producer of the Doom Mode contract (G-255): the
//! mode phase/origin vocabularies, the status/result wire models, the managed
//! [`DoomModeState`], the `doom-mode-changed` global broadcast name, and the
//! `FREDO_DOOM_MODE_FAIL_ENTER` failure seam. It performs **no I/O** — the
//! lifecycle orchestration (launch → window → suppression → agent, and the
//! bounded teardown) lives in [`super::commands`].
//!
//! The mode is the single source of truth for "is Doom Mode active" (G-124);
//! the frontend derives from the global [`DOOM_MODE_EVENT`] broadcast plus a
//! mount seed (`get_doom_mode_status`). The mode is **never persisted** — a
//! fresh boot is always [`DoomModePhase::Inactive`].
//!
//! The suppression gate itself is owned by
//! [`PerformanceModeState`](crate::infrastructure::companion::PerformanceModeState);
//! this module's status mirrors it, so the two never drift.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use super::provision::DoomProvisionPhase;
use super::state::DoomErrorCode;

/// The global broadcast event carrying a [`DoomModeStatus`] to every window.
pub const DOOM_MODE_EVENT: &str = "doom-mode-changed";
/// **G-275** failure seam: when set to `1`, `enter_doom_mode` fails before any
/// launch. Inert when unset, so the production path is unchanged.
pub const DOOM_MODE_FAIL_ENTER_ENV: &str = "FREDO_DOOM_MODE_FAIL_ENTER";

// ── Vocabulary (camelCase over IPC) ───────────────────────────────────────────

/// The Doom Mode lifecycle phase (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomModePhase {
    /// The mode is off.
    #[default]
    Inactive,
    /// An enter is in flight (runtime/window/agent coming up).
    Entering,
    /// The mode is active but the engine is being provisioned on first use
    /// (Spec #3012 ST-3); the launch completes once provisioning reaches `ready`.
    Provisioning,
    /// The mode is fully entered (runtime + agent up, window open).
    Active,
    /// A bounded exit is in flight.
    Exiting,
}

impl DoomModePhase {
    /// The stable wire string (matches `#[serde(rename_all = "camelCase")]`).
    pub fn as_str(self) -> &'static str {
        match self {
            DoomModePhase::Inactive => "inactive",
            DoomModePhase::Entering => "entering",
            DoomModePhase::Provisioning => "provisioning",
            DoomModePhase::Active => "active",
            DoomModePhase::Exiting => "exiting",
        }
    }
}

/// How Doom Mode was entered (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomModeOrigin {
    /// The typed `iddqd` secret code.
    Code,
    /// The companion `doom_mode` skill (voice path).
    Voice,
    /// The `doom` window (reserved).
    Window,
}

impl DoomModeOrigin {
    /// The stable wire string (matches `#[serde(rename_all = "camelCase")]`).
    pub fn as_str(self) -> &'static str {
        match self {
            DoomModeOrigin::Code => "code",
            DoomModeOrigin::Voice => "voice",
            DoomModeOrigin::Window => "window",
        }
    }

    /// Parse the wire string (`None` for unknown/blank, so an unexpected value
    /// degrades to "no origin" rather than a failure).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "code" => Some(DoomModeOrigin::Code),
            "voice" => Some(DoomModeOrigin::Voice),
            "window" => Some(DoomModeOrigin::Window),
            _ => None,
        }
    }
}

// ── Wire models ───────────────────────────────────────────────────────────────

/// Read-only Doom Mode snapshot (`get_doom_mode_status` / `doom-mode-changed`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomModeStatus {
    /// The current lifecycle phase.
    pub phase: DoomModePhase,
    /// Whether the mode is fully entered (`phase == active`).
    pub active: bool,
    /// Whether the companion voice/audio pipeline is suppressed.
    pub voice_suppressed: bool,
    /// How the mode was entered, when active.
    pub origin: Option<DoomModeOrigin>,
    /// RFC3339 timestamp of the successful enter, when active.
    pub entered_at: Option<String>,
    /// Human-readable detail of the last failed activation, if any.
    pub last_error: Option<String>,
    /// The typed failure code paired with `last_error`, if any.
    pub code: Option<DoomErrorCode>,
    /// Whether the engine is not staged and the mode needs provisioning
    /// (Spec #3012 ST-3).
    pub needs_provisioning: bool,
    /// The live provisioning phase, when the mode is provisioning.
    pub provision: Option<DoomProvisionPhase>,
}

/// Result of `enter_doom_mode` / `exit_doom_mode` — always returned, never a hang.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomModeResult {
    /// Whether the requested state was reached (a no-op enter/exit is `true`).
    pub success: bool,
    /// The phase after the attempt.
    pub phase: DoomModePhase,
    /// Whether the mode is fully entered.
    pub active: bool,
    /// Whether the companion voice/audio pipeline is suppressed.
    pub voice_suppressed: bool,
    /// The mode origin, when active.
    pub origin: Option<DoomModeOrigin>,
    /// Human-readable failure detail, when `success` is false.
    pub error: Option<String>,
    /// The typed failure code, when `success` is false.
    pub code: Option<DoomErrorCode>,
    /// Whether the owner must choose an install dir before the engine can be
    /// provisioned (Spec #3012 ST-3; code `provisionRequired`).
    pub needs_install_dir: bool,
}

// ── Managed state + pure transitions ─────────────────────────────────────────

/// Tauri-managed Doom Mode state. The mutex guards only a short synchronous
/// transition — it is never held across an `.await`.
#[derive(Default)]
pub struct DoomModeState(pub Mutex<DoomModeInner>);

/// The mode's mutable core (phase + provenance + last failure).
#[derive(Default)]
pub struct DoomModeInner {
    phase: DoomModePhase,
    origin: Option<DoomModeOrigin>,
    entered_at: Option<String>,
    last_error: Option<String>,
    code: Option<DoomErrorCode>,
    needs_provisioning: bool,
    provision: Option<DoomProvisionPhase>,
}

impl DoomModeState {
    /// A poisoned lock must never take down the app — recover the guard.
    fn lock(&self) -> MutexGuard<'_, DoomModeInner> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The current status, taking `voice_suppressed` from its owning gate.
    pub fn status(&self, voice_suppressed: bool) -> DoomModeStatus {
        let inner = self.lock();
        DoomModeStatus {
            phase: inner.phase,
            active: inner.phase == DoomModePhase::Active,
            voice_suppressed,
            origin: inner.origin,
            entered_at: inner.entered_at.clone(),
            last_error: inner.last_error.clone(),
            code: inner.code,
            needs_provisioning: inner.needs_provisioning,
            provision: inner.provision,
        }
    }

    /// Try to begin entering. `false` when already `entering`/`provisioning`/
    /// `active` — a no-op so a second trigger never spawns a second runtime/window
    /// (R-1.a).
    pub fn begin_enter(&self, origin: Option<DoomModeOrigin>) -> bool {
        let mut inner = self.lock();
        if matches!(
            inner.phase,
            DoomModePhase::Entering | DoomModePhase::Provisioning | DoomModePhase::Active
        ) {
            return false;
        }
        inner.phase = DoomModePhase::Entering;
        inner.origin = origin;
        inner.entered_at = None;
        inner.last_error = None;
        inner.code = None;
        inner.needs_provisioning = false;
        inner.provision = None;
        true
    }

    /// Enter the `provisioning` phase with the live provisioning sub-phase
    /// (Spec #3012 ST-3).
    pub fn set_provisioning(&self, phase: DoomProvisionPhase) {
        let mut inner = self.lock();
        inner.phase = DoomModePhase::Provisioning;
        inner.provision = Some(phase);
        inner.needs_provisioning = true;
    }

    /// Leave the `provisioning` phase (successful launch continues from
    /// `entering`; a failure rolls back via [`Self::mark_enter_failed`]).
    pub fn clear_provisioning(&self) {
        let mut inner = self.lock();
        inner.provision = None;
        if inner.phase == DoomModePhase::Provisioning {
            inner.phase = DoomModePhase::Entering;
        }
    }

    /// Record whether the engine is missing and must be provisioned.
    pub fn set_needs_provisioning(&self, needs: bool) {
        self.lock().needs_provisioning = needs;
    }

    /// Mark a successful enter: `active` with the current RFC3339 timestamp.
    pub fn mark_active(&self) {
        let mut inner = self.lock();
        inner.phase = DoomModePhase::Active;
        inner.entered_at = Some(chrono::Utc::now().to_rfc3339());
        inner.last_error = None;
        inner.code = None;
        inner.needs_provisioning = false;
        inner.provision = None;
    }

    /// Mark a failed enter: back to `inactive` with a typed failure, so no
    /// half-entered state survives (R-1.b / R-5).
    pub fn mark_enter_failed(&self, message: String, code: Option<DoomErrorCode>) {
        let mut inner = self.lock();
        inner.phase = DoomModePhase::Inactive;
        inner.origin = None;
        inner.entered_at = None;
        inner.last_error = Some(message);
        inner.code = code;
        inner.needs_provisioning = false;
        inner.provision = None;
    }

    /// Try to begin exiting. `false` when `inactive` (no-op, R-3.c) or already
    /// `exiting` (idempotent). A `provisioning` mode may exit (cancel the build).
    pub fn begin_exit(&self) -> bool {
        let mut inner = self.lock();
        if !matches!(
            inner.phase,
            DoomModePhase::Entering | DoomModePhase::Provisioning | DoomModePhase::Active
        ) {
            return false;
        }
        inner.phase = DoomModePhase::Exiting;
        true
    }

    /// Clear the mode to `inactive` (exit completed / teardown). Idempotent;
    /// returns whether the mode had been non-inactive.
    pub fn clear(&self) -> bool {
        let mut inner = self.lock();
        let changed = inner.phase != DoomModePhase::Inactive;
        inner.phase = DoomModePhase::Inactive;
        inner.origin = None;
        inner.entered_at = None;
        inner.last_error = None;
        inner.code = None;
        inner.needs_provisioning = false;
        inner.provision = None;
        changed
    }
}

/// The `FREDO_DOOM_MODE_FAIL_ENTER` lever (G-275): `true` iff set to `"1"`.
pub fn fail_enter_requested() -> bool {
    fail_enter_from(std::env::var(DOOM_MODE_FAIL_ENTER_ENV).ok().as_deref())
}

/// Pure parser for the failure lever (unit-testable without env mutation).
pub fn fail_enter_from(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_serialize_camel_case() {
        let cases = [
            (DoomModePhase::Inactive, "\"inactive\""),
            (DoomModePhase::Entering, "\"entering\""),
            (DoomModePhase::Provisioning, "\"provisioning\""),
            (DoomModePhase::Active, "\"active\""),
            (DoomModePhase::Exiting, "\"exiting\""),
        ];
        for (phase, expected) in cases {
            assert_eq!(serde_json::to_string(&phase).expect("serialize"), expected);
            assert_eq!(format!("\"{}\"", phase.as_str()), expected);
        }
        assert_eq!(DoomModePhase::default(), DoomModePhase::Inactive);
    }

    #[test]
    fn origins_serialize_camel_case_and_parse() {
        let cases = [
            (DoomModeOrigin::Code, "\"code\""),
            (DoomModeOrigin::Voice, "\"voice\""),
            (DoomModeOrigin::Window, "\"window\""),
        ];
        for (origin, expected) in cases {
            assert_eq!(serde_json::to_string(&origin).expect("serialize"), expected);
            assert_eq!(DoomModeOrigin::parse(origin.as_str()), Some(origin));
        }
        assert_eq!(DoomModeOrigin::parse("  code  "), Some(DoomModeOrigin::Code));
        assert_eq!(DoomModeOrigin::parse(""), None);
        assert_eq!(DoomModeOrigin::parse("nope"), None);
    }

    #[test]
    fn status_serializes_camel_case() {
        let status = DoomModeStatus {
            phase: DoomModePhase::Active,
            active: true,
            voice_suppressed: true,
            origin: Some(DoomModeOrigin::Code),
            entered_at: Some("2026-10-04T00:00:00+00:00".to_string()),
            last_error: None,
            code: None,
            needs_provisioning: false,
            provision: None,
        };
        let value = serde_json::to_value(&status).expect("serialize");
        assert_eq!(value["phase"], "active");
        assert_eq!(value["active"], true);
        assert_eq!(value["voiceSuppressed"], true);
        assert_eq!(value["origin"], "code");
        assert_eq!(value["enteredAt"], "2026-10-04T00:00:00+00:00");
        assert!(value["lastError"].is_null());
        assert!(value["code"].is_null());
        assert_eq!(value["needsProvisioning"], false);
        assert!(value["provision"].is_null());
    }

    #[test]
    fn result_serializes_camel_case() {
        let result = DoomModeResult {
            success: false,
            phase: DoomModePhase::Inactive,
            active: false,
            voice_suppressed: false,
            origin: None,
            error: Some("boom".to_string()),
            code: Some(DoomErrorCode::SpawnFailed),
            needs_install_dir: false,
        };
        let value = serde_json::to_value(&result).expect("serialize");
        assert_eq!(value["success"], false);
        assert_eq!(value["phase"], "inactive");
        assert_eq!(value["active"], false);
        assert_eq!(value["voiceSuppressed"], false);
        assert!(value["origin"].is_null());
        assert_eq!(value["error"], "boom");
        assert_eq!(value["code"], "spawnFailed");
        assert_eq!(value["needsInstallDir"], false);
    }

    #[test]
    fn default_state_is_inactive() {
        let state = DoomModeState::default();
        let status = state.status(false);
        assert_eq!(status.phase, DoomModePhase::Inactive);
        assert!(!status.active);
        assert!(status.entered_at.is_none());
        assert!(status.origin.is_none());
    }

    #[test]
    fn enter_is_idempotent_while_entering_or_active() {
        let state = DoomModeState::default();
        assert!(state.begin_enter(Some(DoomModeOrigin::Code)));
        assert_eq!(state.status(false).phase, DoomModePhase::Entering);
        // A second trigger while entering is a no-op.
        assert!(!state.begin_enter(Some(DoomModeOrigin::Voice)));
        assert_eq!(state.status(false).origin, Some(DoomModeOrigin::Code));

        state.mark_active();
        assert_eq!(state.status(false).phase, DoomModePhase::Active);
        // A re-trigger while active is a no-op and keeps the entered-at.
        let entered = state.status(true).entered_at.clone();
        assert!(!state.begin_enter(Some(DoomModeOrigin::Voice)));
        let status = state.status(true);
        assert!(status.active);
        assert_eq!(status.entered_at, entered);
        assert_eq!(status.origin, Some(DoomModeOrigin::Code));
        assert!(status.voice_suppressed);
    }

    #[test]
    fn enter_failure_returns_to_inactive_with_a_typed_error() {
        let state = DoomModeState::default();
        state.begin_enter(Some(DoomModeOrigin::Code));
        state.mark_enter_failed("no engine".to_string(), Some(DoomErrorCode::NotConfigured));
        let status = state.status(false);
        assert_eq!(status.phase, DoomModePhase::Inactive);
        assert!(!status.active);
        assert!(status.origin.is_none());
        assert!(status.entered_at.is_none());
        assert_eq!(status.last_error.as_deref(), Some("no engine"));
        assert_eq!(status.code, Some(DoomErrorCode::NotConfigured));
    }

    #[test]
    fn exit_is_idempotent_and_clears_the_mode() {
        let state = DoomModeState::default();
        // Exit while inactive is a no-op (R-3.c).
        assert!(!state.begin_exit());

        state.begin_enter(Some(DoomModeOrigin::Voice));
        state.mark_active();
        assert!(state.begin_exit());
        assert_eq!(state.status(true).phase, DoomModePhase::Exiting);
        // A second exit while exiting is a no-op.
        assert!(!state.begin_exit());

        assert!(state.clear());
        let status = state.status(false);
        assert_eq!(status.phase, DoomModePhase::Inactive);
        assert!(!status.active);
        assert!(status.origin.is_none());
        assert!(status.entered_at.is_none());
        // A second clear is a no-op.
        assert!(!state.clear());
    }

    #[test]
    fn fail_enter_lever_parser() {
        assert!(fail_enter_from(Some("1")));
        assert!(fail_enter_from(Some(" 1 ")));
        assert!(!fail_enter_from(Some("0")));
        assert!(!fail_enter_from(Some("true")));
        assert!(!fail_enter_from(None));
    }

    #[test]
    fn provisioning_phase_tracks_the_sub_phase_and_is_exit_able() {
        let state = DoomModeState::default();
        state.begin_enter(Some(DoomModeOrigin::Code));
        state.set_provisioning(DoomProvisionPhase::DownloadingToolchain);
        let status = state.status(false);
        assert_eq!(status.phase, DoomModePhase::Provisioning);
        assert!(status.needs_provisioning);
        assert_eq!(status.provision, Some(DoomProvisionPhase::DownloadingToolchain));

        // A re-trigger during provisioning is a no-op.
        assert!(!state.begin_enter(Some(DoomModeOrigin::Voice)));

        // Leaving provisioning returns to entering and the launch can complete.
        state.clear_provisioning();
        assert_eq!(state.status(false).phase, DoomModePhase::Entering);
        assert!(state.status(false).provision.is_none());
        state.mark_active();
        assert_eq!(state.status(false).phase, DoomModePhase::Active);
        assert!(!state.status(false).needs_provisioning);

        // A provisioning mode can be exited (cancel path).
        let other = DoomModeState::default();
        other.begin_enter(Some(DoomModeOrigin::Code));
        other.set_provisioning(DoomProvisionPhase::Building);
        assert!(other.begin_exit());
        assert_eq!(other.status(false).phase, DoomModePhase::Exiting);
        assert!(other.clear());
        assert_eq!(other.status(false).phase, DoomModePhase::Inactive);
        assert!(!other.status(false).needs_provisioning);
    }

    #[test]
    fn binding_names_are_pinned() {
        assert_eq!(DOOM_MODE_EVENT, "doom-mode-changed");
        assert_eq!(DOOM_MODE_FAIL_ENTER_ENV, "FREDO_DOOM_MODE_FAIL_ENTER");
    }
}
