//! The reusable target-capture seam (Spec #3244, ST-3).
//!
//! A screenshot is taken for a TARGET RECTANGLE in physical desktop pixels.
//! This module owns exactly two things:
//!
//! | Item | What it is |
//! |---|---|
//! | [`TargetRect`] | the ONE physical-pixel rectangle shape every caller speaks |
//! | [`capture_target_region`] | capture that rectangle FRESH, on every call |
//!
//! # The ONE capture path
//!
//! [`capture_target_region`] delegates to
//! [`super::commands::capture_screen_region`], whose signature and return are
//! UNCHANGED (the #3234 non-goal). The `xcap::Monitor` capture stays the
//! producer: no child process, no second transport and no new stream is
//! introduced. The seam exists so the companion's screen-read path has ONE
//! typed entry point for "capture this target's physical rectangle", shared by
//! an in-window target (whose rectangle the frontend derives from the DOM) and
//! a separate window (whose rectangle the host reads from its own geometry).
//!
//! # Freshness (R-3a)
//!
//! Every call re-reads the screen. There is no memo, no snapshot file and no
//! generation counter — a reused capture would make the pair reflect an earlier
//! turn, which R-3a forbids. The host reads the target's rectangle immediately
//! before it calls this, so the pixels belong to the turn in flight.
//!
//! # Known limitation (disclosed, not hidden)
//!
//! `capture_screen_region` reads MONITOR pixels, so an OCCLUDED target window
//! yields whatever is on top of it. A window-targeted rectangle (what the host's
//! window-geometry accessor produces) is preferred over a guessed region, but
//! occlusion is a real risk the R-4 measurement records — this seam cannot
//! remove it.

use serde::{Deserialize, Serialize};

use super::commands;

/// A physical-pixel rectangle on the desktop.
///
/// Coordinates are in PHYSICAL screen pixels — the units
/// [`super::commands::capture_screen_region`] consumes. A caller holding
/// CSS/logical pixels multiplies by `devicePixelRatio` first, exactly as the
/// shipped in-window recipe does; the host's window geometry is already physical.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Capture `rect` FRESH via the shipped monitor capture.
///
/// The ONE capture path for a target in this slice (R-2b / R-3a): it delegates
/// to [`super::commands::capture_screen_region`] unchanged, so the
/// `xcap::Monitor` producer and the base64-PNG return are exactly the shipped
/// ones. Nothing is memoized — every call reads the screen again.
#[tauri::command]
pub fn capture_target_region(rect: TargetRect) -> Result<String, String> {
    commands::capture_screen_region(rect.x, rect.y, rect.width, rect.height)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A physical-pixel rectangle, built without a product constructor (the
    /// frontend constructs the wire value; the seam only consumes it).
    fn rect(x: f64, y: f64, width: f64, height: f64) -> TargetRect {
        TargetRect {
            x,
            y,
            width,
            height,
        }
    }

    // ── 1. The rectangle shape ──────────────────────────────────────────────

    #[test]
    fn target_rect_carries_its_physical_components_verbatim() {
        let rect = rect(10.0, 20.0, 300.0, 200.0);
        assert_eq!(rect.x, 10.0);
        assert_eq!(rect.y, 20.0);
        assert_eq!(rect.width, 300.0);
        assert_eq!(rect.height, 200.0);
        assert_eq!(
            rect,
            TargetRect {
                x: 10.0,
                y: 20.0,
                width: 300.0,
                height: 200.0,
            }
        );
    }

    /// The wire shape the frontend sends: exactly `{x, y, width, height}` in
    /// camelCase, no optional key (G-413) and no rescale.
    #[test]
    fn the_wire_shape_is_the_camel_case_rectangle() {
        let value = serde_json::to_value(rect(1.0, 2.0, 3.0, 4.0)).expect("serialize");
        let object = value.as_object().expect("object");
        assert_eq!(object.len(), 4, "exactly {{x,y,width,height}}: {value}");
        assert_eq!(object.get("x").and_then(|v| v.as_f64()), Some(1.0));
        assert_eq!(object.get("y").and_then(|v| v.as_f64()), Some(2.0));
        assert_eq!(object.get("width").and_then(|v| v.as_f64()), Some(3.0));
        assert_eq!(object.get("height").and_then(|v| v.as_f64()), Some(4.0));

        // Round-trips from the frontend's exact shape (integers widened to f64).
        let parsed: TargetRect =
            serde_json::from_str("{\"x\":5,\"y\":6,\"width\":7,\"height\":8}").expect("parse");
        assert_eq!(parsed, rect(5.0, 6.0, 7.0, 8.0));
    }

    // ── 2. The seam delegates and keeps no state (R-3a) ─────────────────────

    /// The seam is EXACTLY one command that DELEGATES to the shipped capture —
    /// never a re-implementation, and never a memoizing producer (R-3a: a fresh
    /// capture per call).
    #[test]
    fn the_seam_delegates_to_the_shipped_capture_and_keeps_no_state() {
        let source = include_str!("target.rs");
        let product = source
            .split("#[cfg(test)]")
            .next()
            .expect("the product source precedes the test module");

        let attribute = ["#[tauri", "::command]"].concat();
        assert_eq!(
            product.matches(&attribute).count(),
            1,
            "the screenshot seam owns exactly ONE command"
        );
        assert!(product.contains("pub fn capture_target_region("));
        assert!(
            product.contains(
                "commands::capture_screen_region(rect.x, rect.y, rect.width, rect.height)"
            ),
            "the seam must delegate to the shipped capture verbatim"
        );

        // No state that could make a later call reuse an earlier capture, and no
        // process/child spawn (the #3234 non-goal).
        for banned in [
            "OnceLock",
            "Mutex<",
            "RwLock<",
            "lazy_static",
            "RefCell",
            "std::process",
        ] {
            assert!(
                !product.contains(banned),
                "the capture seam keeps no state and spawns nothing (found {banned})"
            );
        }
    }
}
