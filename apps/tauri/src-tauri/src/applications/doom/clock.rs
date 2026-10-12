//! Injectable tick clock — the AC5 determinism boundary (Spec #3026, ST-1).
//!
//! The continuous autoplay loop ([`super::agent::run_continuous_loop`]) advances
//! the world on a fixed cadence. To keep that loop **test-deterministic** (R-5),
//! its ONLY wall-clock dependency is this trait: the production
//! [`TokioTickClock`] sleeps its declared period, while the deterministic
//! [`FixedTickClock`] returns immediately so a driven run replays identically
//! with zero wall-clock flakiness (the #3023 ST-9 driver seam, extended by
//! ST-3).
//!
//! # No thread, no lock (G-263)
//!
//! The trait holds no lock across its `await` and spawns no thread. `tick()` is a
//! single finite wait — in production a bounded `tokio::time::sleep`, in tests an
//! immediate return. Teardown stays bounded: the loop observes its stop flag
//! within one tick period and every `tick()` completes.
//!
//! # Pacing constants
//!
//! This module owns the pinned sim/rate constants the continuous loop and the
//! deterministic driver consume (G-255 — one declaration, no duplicated
//! literals). `DOOM_CONTINUOUS_RATE_HZ` lives with the autoplay rate contracts in
//! [`super::autoplay`]; the reflex window/step-back constants live with
//! [`super::agent::safety_reflex`].

use std::time::Duration;

use async_trait::async_trait;

// ── Pinned pacing / sim constants (Architect-owned, G-255) ────────────────────

/// The nominal continuous tick period, in milliseconds (~35.7 tics/s).
pub const DOOM_CONTINUOUS_TICK_PERIOD_MS: u64 = 28;

/// Engine tics advanced per loop iteration (one tick per tick period).
pub const DOOM_CONTINUOUS_TICS_PER_TICK: i64 = 1;

/// The smooth-frame-rate floor (fps) the continuous loop targets (AC2).
pub const DOOM_MIN_SMOOTH_FPS: u32 = 30;

/// The degraded tick period, in milliseconds (~20 tics/s) — the R-4 fallback
/// cadence when the decision source is unavailable or slower than the loop.
pub const DOOM_DEGRADED_TICK_PERIOD_MS: u64 = 50;

/// Consecutive slow/unavailable decisions before the loop degrades its pacing.
pub const DOOM_DEGRADED_AFTER_FAILURES: u32 = 2;

/// The total engine-advancing tick budget of one continuous run
/// (~14 min @ 35 tics/s) — bounds every exit path (R-4/G-263).
///
/// Finalized by Spec #3031 ST-3 from ST-1's measured deterministic completion
/// estimate: comfortably above the 10,499-tick no-progress baseline the live
/// freeze exhibited, with margin for the unstick/escape re-routes.
pub const DOOM_CONTINUOUS_MAX_TICKS: u32 = 30_000;

/// Throttle window for the `doom-autoplay-changed` status emission, in
/// milliseconds (~4 Hz). The loop emits one status per `DOOM_STATUS_EMIT_MS`
/// worth of ticks — expressed as a tick count from the injected clock's declared
/// period, so the throttle never reads the wall clock (R-5).
pub const DOOM_STATUS_EMIT_MS: u64 = 250;

// ── The seam ──────────────────────────────────────────────────────────────────

/// The injectable pacing boundary of the continuous loop.
///
/// Implementors MUST NOT spawn a thread or hold a lock across [`Self::tick`].
/// `period` is the declared cadence; `tick` awaits one period (production) or
/// returns immediately (deterministic/tests).
#[async_trait]
pub trait DoomTickClock: Send + Sync {
    /// The declared tick period this clock paces.
    fn period(&self) -> Duration;
    /// Await one tick period. Must be finite and must not block a lock.
    async fn tick(&self);
}

/// The production clock: awaits `tokio::time::sleep(period)` per tick.
#[derive(Clone, Copy, Debug)]
pub struct TokioTickClock(pub Duration);

impl TokioTickClock {
    /// Build a production clock pacing `period`.
    pub fn new(period: Duration) -> Self {
        Self(period)
    }
}

#[async_trait]
impl DoomTickClock for TokioTickClock {
    fn period(&self) -> Duration {
        self.0
    }

    async fn tick(&self) {
        // A zero period is a no-op (never sleep(0) — still immediate either way).
        if !self.0.is_zero() {
            tokio::time::sleep(self.0).await;
        }
    }
}

/// The deterministic clock: declares its period but returns IMMEDIATELY from
/// [`DoomTickClock::tick`], so a driven run is a pure function of its iteration
/// count (R-5) with zero wall-clock flakiness.
#[derive(Clone, Copy, Debug)]
pub struct FixedTickClock(pub Duration);

impl FixedTickClock {
    /// Build a deterministic clock declaring `period` (never slept).
    pub fn new(period: Duration) -> Self {
        Self(period)
    }

    /// Build a deterministic clock declaring `period` from milliseconds.
    pub fn from_millis(period_ms: u64) -> Self {
        Self(Duration::from_millis(period_ms))
    }
}

#[async_trait]
impl DoomTickClock for FixedTickClock {
    fn period(&self) -> Duration {
        self.0
    }

    async fn tick(&self) {
        // Deterministic driver + tests: yields immediately, no wall clock.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pinned_pacing_constants_are_stable() {
        assert_eq!(DOOM_CONTINUOUS_TICK_PERIOD_MS, 28);
        assert_eq!(DOOM_CONTINUOUS_TICS_PER_TICK, 1);
        assert_eq!(DOOM_MIN_SMOOTH_FPS, 30);
        assert_eq!(DOOM_DEGRADED_TICK_PERIOD_MS, 50);
        assert_eq!(DOOM_DEGRADED_AFTER_FAILURES, 2);
        assert_eq!(DOOM_CONTINUOUS_MAX_TICKS, 30_000);
        assert_eq!(DOOM_STATUS_EMIT_MS, 250);
    }

    #[test]
    fn the_nominal_period_is_about_the_rated_hz() {
        // ~35.7 tics/s declared as 28 ms — within one tic of the 35 Hz rate.
        let hz = 1000.0 / DOOM_CONTINUOUS_TICK_PERIOD_MS as f64;
        assert!((hz - f64::from(super::super::autoplay::DOOM_CONTINUOUS_RATE_HZ)).abs() < 1.0);
    }

    #[tokio::test]
    async fn fixed_clock_declares_its_period_and_returns_immediately() {
        let clock = FixedTickClock::from_millis(28);
        assert_eq!(clock.period(), Duration::from_millis(28));

        // A bounded wait proves `tick()` resolves rather than hanging; the
        // immediate return is the contract.
        for _ in 0..1_000 {
            tokio::time::timeout(Duration::from_secs(1), clock.tick())
                .await
                .expect("FixedTickClock::tick returns immediately");
        }
    }

    #[test]
    fn tokio_clock_declares_its_period() {
        let clock = TokioTickClock::new(Duration::from_millis(28));
        assert_eq!(clock.period(), Duration::from_millis(28));
    }

    #[tokio::test]
    async fn both_clocks_are_usable_through_the_trait_object() {
        let fixed = FixedTickClock::new(Duration::from_millis(10));
        let tokio_clock = TokioTickClock::new(Duration::ZERO);
        let clocks: [&dyn DoomTickClock; 2] = [&fixed, &tokio_clock];
        for clock in clocks {
            // A zero-period TokioTickClock is a no-op; the fixed clock is
            // immediate — neither blocks.
            tokio::time::timeout(Duration::from_secs(1), clock.tick())
                .await
                .expect("a finite, immediate tick");
        }
    }
}
