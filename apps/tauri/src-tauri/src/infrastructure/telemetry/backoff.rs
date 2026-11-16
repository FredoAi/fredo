//! Bounded exponential back-off for repeated identical error logs (Spec #3067 R-5).
//!
//! While the storage engine is not ready (fail-closed, R-3.2) the flush paths
//! retry on every tick and each failure would otherwise emit an identical
//! `ERROR` line — an unbounded log flood. [`ErrorBackoff`] gates those emissions
//! per site: the first failure emits immediately, then identical failures are
//! suppressed until a doubling window elapses (capped at
//! [`STORAGE_UNAVAILABLE_BACKOFF_MAX_MS`]). A successful write calls
//! [`ErrorBackoff::reset`], so normal operation is unaffected.
//!
//! The primitive is time-source agnostic: [`ErrorBackoff::due`] takes the
//! current [`Instant`] as an argument so callers (and unit tests) can inject a
//! deterministic clock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

/// First repeat window (ms) after an initial emission.
pub const STORAGE_UNAVAILABLE_BACKOFF_BASE_MS: u64 = 1_000;
/// Interval cap (ms) — the window never grows beyond this.
pub const STORAGE_UNAVAILABLE_BACKOFF_MAX_MS: u64 = 60_000;
/// Doubling factor applied to the window after each granted emission.
pub const STORAGE_UNAVAILABLE_BACKOFF_FACTOR: u32 = 2;

/// Per-site bounded exponential back-off for repeated identical error logs.
///
/// Each instance owns its own monotonic base (pinned by the first [`due`] call),
/// so a site's schedule is independent of every other site — distinct error
/// sources are never coalesced.
///
/// [`due`]: ErrorBackoff::due
pub struct ErrorBackoff {
    /// Per-instance monotonic base; the first `due` call pins it.
    base: OnceLock<Instant>,
    /// Absolute deadline (ms since `base`) at which the next emission is due.
    /// `0` means "due now" (fresh, or just reset).
    next_due_ms: AtomicU64,
    /// Window (ms) applied when the next emission is granted. `0` means the
    /// first window (uses [`STORAGE_UNAVAILABLE_BACKOFF_BASE_MS`]).
    interval_ms: AtomicU64,
    /// Emissions suppressed since the last granted emission.
    suppressed: AtomicU64,
}

impl ErrorBackoff {
    /// Create a fresh back-off (no schedule armed; the first `due` emits).
    pub const fn new() -> Self {
        ErrorBackoff {
            base: OnceLock::new(),
            next_due_ms: AtomicU64::new(0),
            interval_ms: AtomicU64::new(0),
            suppressed: AtomicU64::new(0),
        }
    }

    /// `Some(suppressed_since_last)` when an emission is due at `now`
    /// (advances the schedule by the current interval); `None` while gated.
    ///
    /// The first call always emits. Each granted emission advances the deadline
    /// by the current window and doubles the window (capped at
    /// [`STORAGE_UNAVAILABLE_BACKOFF_MAX_MS`]) for the following window.
    pub fn due(&self, now: Instant) -> Option<u64> {
        let base = *self.base.get_or_init(|| now);
        let now_ms = now.saturating_duration_since(base).as_millis() as u64;

        if now_ms < self.next_due_ms.load(Ordering::SeqCst) {
            self.suppressed.fetch_add(1, Ordering::SeqCst);
            return None;
        }

        // Emission granted: report and clear the suppressed count.
        let suppressed = self.suppressed.swap(0, Ordering::SeqCst);

        // Window used for the interval that starts now: the first window is the
        // base window, thereafter the doubling interval.
        let current = self.interval_ms.load(Ordering::SeqCst);
        let window = if current == 0 {
            STORAGE_UNAVAILABLE_BACKOFF_BASE_MS
        } else {
            current
        };

        self.next_due_ms
            .store(now_ms.saturating_add(window), Ordering::SeqCst);

        // Double the window for the next interval, capped at the maximum.
        let next = window
            .saturating_mul(STORAGE_UNAVAILABLE_BACKOFF_FACTOR as u64)
            .min(STORAGE_UNAVAILABLE_BACKOFF_MAX_MS);
        self.interval_ms.store(next, Ordering::SeqCst);

        Some(suppressed)
    }

    /// Clear the schedule and the suppressed counter — the next `due` emits
    /// immediately. Called after a successful write so normal operation is
    /// never suppressed.
    pub fn reset(&self) {
        self.next_due_ms.store(0, Ordering::SeqCst);
        self.interval_ms.store(0, Ordering::SeqCst);
        self.suppressed.store(0, Ordering::SeqCst);
    }
}

impl Default for ErrorBackoff {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn first_call_is_due_then_gated_until_interval() {
        let backoff = ErrorBackoff::new();
        let t0 = Instant::now();

        // First call emits immediately with nothing suppressed.
        assert_eq!(backoff.due(t0), Some(0));

        // Inside the first window (BASE ms) emissions are gated and counted.
        assert_eq!(backoff.due(t0 + Duration::from_millis(1)), None);
        assert_eq!(backoff.due(t0 + Duration::from_millis(999)), None);

        // At the window boundary the emission is due and reports the two
        // suppressed attempts (owned counter — never global state, G-222).
        assert_eq!(backoff.due(t0 + Duration::from_millis(1000)), Some(2));
    }

    #[test]
    fn interval_doubles_to_cap() {
        let backoff = ErrorBackoff::new();
        let t0 = Instant::now();

        // Gaps between consecutive granted emissions: BASE, then doubling, then
        // pinned at MAX.
        let gaps = [1000u64, 2000, 4000, 8000, 16000, 32000, 60000, 60000];

        assert_eq!(backoff.due(t0), Some(0), "first emission is immediate");

        let mut offset = 0u64;
        for (i, gap) in gaps.iter().enumerate() {
            offset += gap;
            assert_eq!(
                backoff.due(t0 + Duration::from_millis(offset - 1)),
                None,
                "gated just before window {i} closes"
            );
            assert_eq!(
                backoff.due(t0 + Duration::from_millis(offset)),
                Some(1),
                "emitted when window {i} closes"
            );
        }
    }

    #[test]
    fn reset_clears_the_gate_and_counter() {
        let backoff = ErrorBackoff::new();
        let t0 = Instant::now();

        assert_eq!(backoff.due(t0), Some(0));
        assert_eq!(backoff.due(t0 + Duration::from_millis(10)), None);
        assert_eq!(backoff.due(t0 + Duration::from_millis(20)), None);

        backoff.reset();

        // After reset the very next call emits immediately and the suppressed
        // counter is cleared.
        assert_eq!(backoff.due(t0 + Duration::from_millis(30)), Some(0));
    }

    #[test]
    fn distinct_instances_are_independent() {
        let a = ErrorBackoff::new();
        let b = ErrorBackoff::new();
        let t0 = Instant::now();

        // Gating `a` must not gate `b` (per-site keys, no coalescing).
        assert_eq!(a.due(t0), Some(0));
        assert_eq!(a.due(t0 + Duration::from_millis(5)), None);
        assert_eq!(b.due(t0 + Duration::from_millis(5)), Some(0));
    }
}
