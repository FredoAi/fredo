//! Doom Mode runtime (Spec #2968; native engine Spec #3023).
//!
//! Since Spec #3023 the engine is a **native, in-process, pure-Rust** adapter
//! ([`engine`], over `neurodoom`) — no separate process, no loopback HTTP bridge,
//! no vendored GPL source, and no from-source provisioning. This module owns:
//!
//! * [`state`] — the shared contract (phase / error vocabularies, launch/status
//!   wire models, bounded-timeout constants, AppStore/env keys).
//! * [`engine`] — the in-process engine adapter (`DoomEngineState` / `DoomSession`)
//!   over `neurodoom::ClassicEngine`, loading the bundled `DOOM1.WAD` with the
//!   typed `wadMissing` / `wadCorrupt` / `engineStartFailed` failure surface.
//! * [`commands`] — the Tauri command surface (`launch_doom_runtime`,
//!   `doom_read_state` / `doom_step` / `doom_frame_raw`, `stop_doom_runtime`) plus the
//!   window-close / app-exit teardown entry points.
//! * [`actions`] — the engine action vocabulary (`DOOM_ACTION_*` consts plus the
//!   structured list the persona and scripted lever consume).
//! * [`autoplay`] — the autoplay contract (phase/error vocabularies, status /
//!   result wire models, bounded budget constants).
//! * [`decision`] — the deterministic scripted decision lever plus the
//!   `FREDO_DOOM_AGENT_*` env seam.
//! * [`agent`] — the bounded read → decide → validate → step autoplay loop, the
//!   terminal-state restart reaction, and the consecutive-failure budget.
//! * [`mode`] — the Doom Mode lifecycle (activation, the singleton window, the
//!   companion-suppression gate).
//! * [`perception`] — the bounded observation geometry contract (the `walls`
//!   field), the pure projection, and the semantic/depth → `PerceptionFrame`
//!   bridge (Spec #3030 S1).
//! * [`navigation`] — the deterministic level-walkability model (Spec #3039
//!   ST-1): a coarse passability/clearance graph over the loaded `MapData` (a
//!   two-sided linedef is a portal; an opened door is a passable edge) and the
//!   executed E1M1–E1M8 feasibility scan that selects AC5's completion target.
//! * [`save`] — the persisted resume contract (`DoomSave` / `DoomSaveStatus` /
//!   `DoomCampaign`) in the typed PostgreSQL feature table `feature_doom_save`,
//!   with the test-only `FREDO_DOOM_SAVE_STATE_DIR` / `FREDO_DOOM_SAVE_FORCE_FAIL`
//!   induction levers.
//! * [`progress`] — the continuous-state writer ([`progress::DoomProgressWriter`]).
//! * [`failure_seam`] — the engine-start failure induction lever (adapted for the
//!   native engine).
//!
//! # G-263
//!
//! Teardown is take-and-drop of the native in-process session on every exit path:
//! there is no child process and no engine thread, so no orphan is constructible.
//! Every autoplay budget stays finite.

pub mod actions;
pub mod agent;
pub mod autoplay;
// Injectable tick clock — the AC5 determinism boundary (Spec #3026 ST-1). The
// continuous loop's ONLY wall-clock dependency; production `TokioTickClock`,
// deterministic `FixedTickClock`.
pub mod clock;
pub mod commands;
pub mod decision;
// Native in-process engine adapter (Spec #3023, ST-1) — the single source of the
// observation/control surface.
pub mod engine;
pub mod failure_seam;
pub mod mode;
// Deterministic level-walkability model (Spec #3039 ST-1) — the AC5 feasibility
// gate: a coarse passability/clearance graph over the loaded `MapData` plus the
// executed E1M1-E1M8 scan that selects the completion target.
pub mod navigation;
pub mod perception;
pub mod progress;
pub mod save;
pub mod state;
