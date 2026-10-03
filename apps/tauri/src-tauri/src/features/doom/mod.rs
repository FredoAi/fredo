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
//! NOT here (later compilable units): acquisition + engine/IWAD resolution
//! (CU-3, ST-4), the HTTP control client `doom_read_state`/`doom_step`/
//! `doom_frame` (CU-3, ST-5), the stub engine (CU-3, ST-8), and the `doom`
//! window + webview + main-window entry (CU-4, ST-6/ST-7).
//!
//! # G-263
//!
//! Every wait in this module is finite with a hard-kill fallback and teardown on
//! every exit path: readiness timeout kills the child, the stop bound hard-kills,
//! the exit hook is wall-clock capped, and the startup sweep reclaims a
//! hard-killed orphan under an image guard.

pub mod commands;
pub mod process;
pub mod state;
