//! Doom Mode runtime (Spec #2968, CU-2: ST-2 + ST-3 + ST-3b + ST-3c).
//!
//! The engine is GPL-2.0 and runs as an arm's-length separate process over a
//! loopback HTTP socket — Fredo never links it. This slice owns the runtime
//! lifecycle core only:
//!
//! * [`state`] — the shared contract (managed-child handle, Tauri state, phase /
//!   error vocabularies, launch/status wire models, bounded-timeout constants,
//!   AppStore/env keys). ST-2.
//! * [`process`] — bounded process supervision: spawn (`CREATE_NO_WINDOW`, log
//!   redirect), the bounded readiness probe, the bounded graceful stop with a
//!   hard-kill fallback, the PID marker, and the image-guarded startup sweep.
//!   ST-3/ST-3c.
//! * [`commands`] — the Tauri command surface (`launch_doom_runtime`,
//!   `stop_doom_runtime`, `get_doom_status`) plus the window-close / app-exit
//!   teardown entry points. ST-3/ST-3b.
//!
//! CU-3 adds:
//!
//! * [`resolver`] — engine/IWAD resolution (configured → PATH → staged). ST-4.
//! * [`acquisition`] — the pinned Freedoom IWAD + deferred engine archive through
//!   the shared download engine, with the minimal ZIP extractor. ST-4.
//! * [`client`] — the Rust-side HTTP control surface (`doom_read_state`/
//!   `doom_step`/`doom_frame`), including indexed8→base64-PNG frame conversion.
//!   ST-5.
//! * `src/bin/doom_stub.rs` — the build-gated stub engine. ST-8.
//!
//! Slice 2 (#2969) adds:
//!
//! * [`actions`] — the live-confirmed engine action vocabulary (`DOOM_ACTION_*`
//!   consts plus the structured list the persona and scripted lever consume).
//!   ST-1.
//! * [`autoplay`] — the autoplay contract (phase/error vocabularies, status /
//!   result wire models, bounded budget constants). ST-2.
//! * [`decision`] — the deterministic scripted decision lever plus the
//!   `FREDO_DOOM_AGENT_*` env seam. ST-2.
//! * [`agent`] — the bounded read → decide → validate → step autoplay loop, the
//!   terminal-state restart reaction, and the consecutive-failure budget (R-1,
//!   R-3, R-4, R-5). ST-3.
//!
//! NOT here (later compilable units): the `doom` window + webview + main-window
//! entry (CU-4, ST-6/ST-7).
//!
//! Slice 5 (#2972) adds:
//!
//! * [`save`] — the persisted resume contract (`DoomSave` / `DoomSaveStatus` /
//!   `DoomCampaign`, `parse`/`serialize`, the `load`/`store`/`clear` persistence
//!   surface, and the pinned campaign constants). Since #3011 the save lives in
//!   the dedicated typed PostgreSQL feature table `feature_doom_save`
//!   (`doom` / `save`, one `singleton` row), with the test-only
//!   `FREDO_DOOM_SAVE_STATE_DIR` / `FREDO_DOOM_SAVE_FORCE_FAIL` induction levers.
//!   ST-2.
//! * [`progress`] — the continuous-state owner ([`progress::DoomProgressWriter`])
//!   that persists one `DoomSave` per level transition through the shared
//!   [`crate::infrastructure::storage::application_store::ApplicationStore`]. ST-4.
//!
//! # G-263
//!
//! Every wait in this module is finite with a hard-kill fallback and teardown on
//! every exit path: readiness timeout kills the child, the stop bound hard-kills,
//! the exit hook is wall-clock capped, and the startup sweep reclaims a
//! hard-killed orphan under an image guard.

pub mod acquisition;
pub mod actions;
pub mod agent;
pub mod autoplay;
pub mod client;
pub mod commands;
pub mod decision;
pub mod mode;
pub mod process;
pub mod progress;
pub mod resolver;
pub mod save;
pub mod state;
