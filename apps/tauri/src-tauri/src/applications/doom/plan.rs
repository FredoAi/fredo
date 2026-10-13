//! Deterministic plan executor + re-plan + first-class doors (Spec #3039, ST-4).
//!
//! This module is the **live-latency and adaptivity fix** for the Doom Companion
//! (AC2/AC3/AC4): a pure, deterministic executor that runs an adopted
//! [`DoomPlan`] **one step per engine tick** — without waiting for the next
//! decision — presses `use` at a door and **does not advance until the door
//! reports `state == "waiting"`** (bounded), and requests a **re-plan** on
//! divergence.
//!
//! It is integrated by [`super::agent::run_continuous_loop`], which owns the
//! tick loop and composes this executor with the retained `safety_reflex` and
//! the Spec #3031 unstick/escape + local-locomotion policy (the **fallback**,
//! never replaced).
//!
//! # Plan execution, one engine tick per loop tick
//!
//! * `Move { bearing, distance }` → face `bearing`, hold bounded `forward` until
//!   the observed position has consumed `distance` map units.
//! * `OpenDoor { bearing }` → face `bearing`, press `use`, and **wait** until the
//!   target door reports `state == "waiting"`; re-press on the
//!   [`DOOM_DOOR_USE_REPRESS_TICKS`] cadence; exceed
//!   [`DOOM_DOOR_WAIT_MAX_TICKS`] ⇒ abandon the step and re-plan.
//! * `Shoot { tics }` / `Wait { tics }` → issue for the given hold.
//! * `Hold { tics, actions }` → the **retained legacy/local hold**: its actions
//!   are routed through the retained [`super::agent::effective_intent`] pipeline
//!   (reflex + escape + local-locomotion + door explore) for one tick, exactly as
//!   the pre-ST-4 continuous loop re-issued the model intent.
//!
//! # Re-plan triggers (AC3 / R-3)
//!
//! Five triggers, evaluated by the pure [`replan_reason`] with a fixed precedence
//! (`blocked` → `noProgress` → `frontEnemy` → `doorClosed` → `exhausted`): blocked
//! `forward` ≥ [`DOOM_REPLAN_BLOCKED_TICKS`], no-progress (no move) ≥
//! [`DOOM_REPLAN_NO_PROGRESS_TICKS`], a **new** `front` enemy the plan was not
//! adopted with, the active `open-door` step's door regressing to `closing` (or
//! the bounded wait elapsing), or the plan's steps being exhausted. Every re-plan
//! is observable (the `replans` status counter + one
//! [`build_replan_audit_record`] JSONL record).
//!
//! # Purity / determinism (NFR-DET)
//!
//! Every function here is a pure function of the observation + counters: no RNG,
//! no wall clock, no I/O. The one read of process env is the test-only
//! [`DOOM_DOOR_WAIT_MAX_TICKS_ENV`] override, read once at construction
//! (G-275/G-300) and inert when unset.
//!
//! # Test-only induction seam (G-275/G-300)
//!
//! `FREDO_DOOM_DOOR_WAIT_MAX_TICKS` overrides the bounded door wait with a tiny
//! bound, so the tester can drive the abort+re-plan path; the shipped
//! `FREDO_DOOM_INJECT_OBSERVATION` (Spec #3039 ST-2, [`super::engine`]) merges a
//! synthetic `enemies[]` / `doors[]` into the observation so the `frontEnemy` /
//! `doorClosed` triggers are drivable against the real engine. Both are inert
//! when unset; production is byte-identical.

use serde_json::{json, Value};

use crate::infrastructure::companion::doom_decision::{DoomPlan, DoomPlanStep};

use super::actions::{
    DOOM_ACTION_FORWARD, DOOM_ACTION_RUN, DOOM_ACTION_SHOOT, DOOM_ACTION_TURN_TO, DOOM_ACTION_USE,
};

// ── Pinned re-plan thresholds (Architect-owned, G-255) ───────────────────────

/// Consecutive blocked-`forward` ticks at or above which the executor re-plans
/// (mirrors [`super::agent::DOOM_REFLEX_BLOCKED_TICKS`]).
pub const DOOM_REPLAN_BLOCKED_TICKS: u32 = 4;

/// Consecutive no-progress (no-move) ticks at or above which the executor
/// re-plans (mirrors [`super::agent::DOOM_ESCAPE_STUCK_TICKS`]).
pub const DOOM_REPLAN_NO_PROGRESS_TICKS: u32 = 12;

/// Bounded door-open wait, in engine tics. ST-1 measured a door opening in ~7
/// tics; 210 (≈6 s at 35 tics/s) leaves generous margin for the `VDOORWAIT` hold.
pub const DOOM_DOOR_WAIT_MAX_TICKS: u32 = 210;

/// Re-press `use` cadence while waiting at a door, in engine tics (mirrors
/// [`super::agent::DOOM_LOCAL_DOOR_USE_TICKS`]).
pub const DOOM_DOOR_USE_REPRESS_TICKS: u32 = 30;

/// Per-tick bounded `forward` hold issued by a `Move` step, in tics.
pub const DOOM_PLAN_FORWARD_AMOUNT: i64 = 1;

/// Per-tick bounded `shoot` hold issued by a `Shoot` step, in tics.
pub const DOOM_PLAN_SHOOT_AMOUNT: i64 = 1;

/// The half-angle (degrees) of the door-match FOV cone (Spec #3039 ST-3): the
/// door an `OpenDoor` step / the local follower is waiting on must lie within
/// this many degrees of the faced bearing — the executor issues `turn-to
/// bearing`, so the target door sits at relative ≈ 0. Of the doors inside the
/// cone the NEAREST (smallest distance) is the target.
pub const DOOM_DOOR_FACING_TOLERANCE_DEGREES: i64 = 12;

/// The `FREDO_DOOR_WAIT_MAX_TICKS` test-only override of
/// [`DOOM_DOOR_WAIT_MAX_TICKS`] (G-275/G-300). Inert when unset, blank, or
/// invalid — production keeps the pinned bound.
pub const DOOM_DOOR_WAIT_MAX_TICKS_ENV: &str = "FREDO_DOOM_DOOR_WAIT_MAX_TICKS";

/// The `event` value of the per-re-plan action-audit JSONL record (AC3).
pub const DOOM_ACTION_AUDIT_REPLAN_EVENT: &str = "replan";

// ── Re-plan vocabulary (AC3) ──────────────────────────────────────────────────

/// Why the executor requested a new plan (R-3). Serialized to the action-audit
/// JSONL under [`ReplanReason::wire`] — the five documented reasons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplanReason {
    /// Blocked `forward` ≥ [`DOOM_REPLAN_BLOCKED_TICKS`].
    Blocked,
    /// No-progress (no move) ≥ [`DOOM_REPLAN_NO_PROGRESS_TICKS`].
    NoProgress,
    /// A NEW `front` enemy appeared that the plan was not adopted with.
    FrontEnemy,
    /// The active `open-door` step's door regressed to `closing`, or the bounded
    /// wait elapsed without `state == "waiting"`.
    DoorClosed,
    /// The plan's steps were exhausted.
    Exhausted,
}

impl ReplanReason {
    /// The wire reason string (the `reason` field of the audit record).
    pub fn wire(self) -> &'static str {
        match self {
            ReplanReason::Blocked => "blocked",
            ReplanReason::NoProgress => "noProgress",
            ReplanReason::FrontEnemy => "frontEnemy",
            ReplanReason::DoorClosed => "doorClosed",
            ReplanReason::Exhausted => "exhausted",
        }
    }
}

/// The per-tick counters the executor's divergence detector consumes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReplanCounters {
    /// Consecutive ticks a `forward` was commanded without the player moving.
    pub blocked_forward_ticks: u32,
    /// The current consecutive no-move tick streak.
    pub no_move_ticks: u32,
}

/// The pure divergence predicate (AC3 / R-3): the first re-plan trigger that
/// fires, or `None` when the world still matches the plan.
///
/// Fixed precedence (deterministic when two triggers fire at once): `blocked`,
/// `noProgress`, `frontEnemy`, `doorClosed`, `exhausted`. Pure — no I/O, no RNG,
/// no clock.
pub fn replan_reason(
    counters: &ReplanCounters,
    new_front_enemy: bool,
    door_not_waiting: bool,
    exhausted: bool,
) -> Option<ReplanReason> {
    if counters.blocked_forward_ticks >= DOOM_REPLAN_BLOCKED_TICKS {
        return Some(ReplanReason::Blocked);
    }
    if counters.no_move_ticks >= DOOM_REPLAN_NO_PROGRESS_TICKS {
        return Some(ReplanReason::NoProgress);
    }
    if new_front_enemy {
        return Some(ReplanReason::FrontEnemy);
    }
    if door_not_waiting {
        return Some(ReplanReason::DoorClosed);
    }
    if exhausted {
        return Some(ReplanReason::Exhausted);
    }
    None
}

/// The per-re-plan action-audit record (AC3): exactly
/// `{"event":"replan","reason":"..."}`.
pub fn build_replan_audit_record(reason: ReplanReason) -> Value {
    json!({
        "event": DOOM_ACTION_AUDIT_REPLAN_EVENT,
        "reason": reason.wire(),
    })
}

// ── Bounded door wait: the test-only override ────────────────────────────────

/// The bounded door wait from [`DOOM_DOOR_WAIT_MAX_TICKS_ENV`], or `None` when
/// unset/blank/invalid (inert). Reuses the slice's pinned `u32` parser.
pub fn door_wait_max_ticks_from_env() -> Option<u32> {
    super::decision::parse_u32(std::env::var(DOOM_DOOR_WAIT_MAX_TICKS_ENV).ok().as_deref())
}

/// The effective bounded door wait: the env override when set, else the pinned
/// [`DOOM_DOOR_WAIT_MAX_TICKS`].
pub fn door_wait_max_ticks() -> u32 {
    door_wait_max_ticks_from_env().unwrap_or(DOOM_DOOR_WAIT_MAX_TICKS)
}

// ── Observation helpers (pure) ───────────────────────────────────────────────

/// The player's integer map-unit `(x, y)`, or `None` when either is absent.
pub fn observation_position(observation: &Value) -> Option<(i64, i64)> {
    let x = observation.pointer("/player/x").and_then(Value::as_i64)?;
    let y = observation.pointer("/player/y").and_then(Value::as_i64)?;
    Some((x, y))
}

/// Whether the observation's `enemies` list reports at least one `front` target.
/// The single definition shared with [`super::agent::safety_reflex`].
pub fn observation_has_front_enemy(observation: &Value) -> bool {
    observation
        .get("enemies")
        .and_then(Value::as_array)
        .map(|enemies| {
            enemies
                .iter()
                .any(|enemy| enemy.get("direction").and_then(Value::as_str) == Some("front"))
        })
        .unwrap_or(false)
}

/// Normalize `degrees` to `-180..=180`.
fn normalize_relative(degrees: i64) -> i64 {
    let normalized = degrees.rem_euclid(360);
    if normalized > 180 {
        normalized - 360
    } else {
        normalized
    }
}

/// The angular distance between two bearings, in `0..=180` degrees.
fn angular_distance(a: i64, b: i64) -> i64 {
    let delta = (a - b).rem_euclid(360);
    if delta > 180 {
        360 - delta
    } else {
        delta
    }
}

/// The state of the door an `OpenDoor` step is waiting on, from an observation.
///
/// Prefers the additive `forward.doorBearings` entry inside the FOV cone
/// ([`DOOM_DOOR_FACING_TOLERANCE_DEGREES`]) whose relative bearing is closest to
/// the faced `bearing` — and, among those in the cone, the NEAREST by `distance`
/// (Spec #3039 ST-3: the executor issues `turn-to bearing`, so the target door
/// sits at relative ≈ 0). Falling back to the `doors[]` `front` entry. `None`
/// when no door is visible. Pure.
pub fn target_door_state(observation: &Value, bearing: i64) -> Option<String> {
    let angle = observation
        .pointer("/player/angle")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let expected = normalize_relative(bearing - angle);

    if let Some(doors) = observation
        .pointer("/forward/doorBearings")
        .and_then(Value::as_array)
    {
        // In-cone doors, matched by the NEAREST distance (tie-broken by the
        // smallest angular delta) — the door the player is actually walking into.
        let mut best: Option<(i64, i64, String)> = None;
        for door in doors {
            let Some(state) = door.get("state").and_then(Value::as_str) else {
                continue;
            };
            let door_bearing = door.get("bearing").and_then(Value::as_i64).unwrap_or(0);
            let delta = angular_distance(door_bearing, expected);
            if delta > DOOM_DOOR_FACING_TOLERANCE_DEGREES {
                continue;
            }
            let distance = door
                .get("distance")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX);
            if best
                .as_ref()
                .is_none_or(|(best_distance, best_delta, _)| {
                    (distance, delta) < (*best_distance, *best_delta)
                })
            {
                best = Some((distance, delta, state.to_string()));
            }
        }
        if let Some((_, _, state)) = best {
            return Some(state);
        }
    }

    // Fallback: the observation's `doors[]` front entry.
    observation
        .get("doors")
        .and_then(Value::as_array)
        .and_then(|doors| {
            doors
                .iter()
                .find(|door| door.get("direction").and_then(Value::as_str) == Some("front"))
                .and_then(|door| door.get("state").and_then(Value::as_str))
        })
        .map(str::to_string)
}

/// The integer map-unit Manhattan distance between two points (deterministic;
/// the observation exposes integer positions).
fn manhattan(from: (i64, i64), to: (i64, i64)) -> i64 {
    (to.0 - from.0).unsigned_abs() as i64 + (to.1 - from.1).unsigned_abs() as i64
}

/// One action issuing `forward` for the bounded per-tick hold.
fn forward_action() -> Value {
    json!({ "type": DOOM_ACTION_FORWARD, "amount": DOOM_PLAN_FORWARD_AMOUNT })
}

/// One action facing an absolute bearing.
fn turn_to_action(bearing: i64) -> Value {
    json!({ "type": DOOM_ACTION_TURN_TO, "angle": bearing })
}

/// One immediate `use` press.
fn use_action() -> Value {
    json!({ "type": DOOM_ACTION_USE })
}

/// One bounded `run` modifier hold. The route follower travels at a RUN: the run
/// modifier doubles the player's speed, so it crosses open ground quickly and
/// spends less time exposed to enemy fire (a route-follower that WALKED slowly
/// through E1M1's courtyard died before the exit).
fn run_action() -> Value {
    json!({ "type": DOOM_ACTION_RUN, "amount": DOOM_PLAN_FORWARD_AMOUNT })
}

// ── Executor ─────────────────────────────────────────────────────────────────

/// The actions a plan step produces for one engine tick.
#[derive(Clone, Debug, PartialEq)]
pub enum PlanAction {
    /// Native plan actions (`Move`/`OpenDoor`/`Shoot`/`Wait`) — issued directly,
    /// guarded by [`super::agent::safety_reflex`].
    Native(Vec<Value>),
    /// The retained legacy/local hold (`Hold`) — routed through the retained
    /// [`super::agent::effective_intent`] pipeline.
    Legacy(Vec<Value>),
    /// No plan step is active: the retained fallback drives this tick.
    None,
}

/// The outcome of one executor tick.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanTick {
    /// The action-set to issue this tick.
    pub action: PlanAction,
    /// A re-plan request raised this tick (AC3), if any.
    pub replan: Option<ReplanReason>,
    /// The active plan-step index (observability `planIndex`).
    pub index: u32,
}

/// The internal state of the currently executing plan step.
#[derive(Clone, Debug)]
enum ActiveStep {
    /// Face `bearing`; hold bounded `forward` until `remaining` map units are
    /// consumed by the observed position delta.
    Move {
        index: usize,
        bearing: i64,
        remaining: i64,
        last_position: Option<(i64, i64)>,
    },
    /// Face `bearing`, press `use`, wait for `state == "waiting"`.
    OpenDoor {
        index: usize,
        bearing: i64,
        ticks: u32,
    },
    /// A timed hold: `remaining` more ticks issuing `actions` each tick. `legacy`
    /// marks the retained [`DoomPlanStep::Hold`].
    Timed {
        index: usize,
        remaining: i64,
        actions: Vec<Value>,
        legacy: bool,
    },
}

/// The result of advancing one active step by one tick.
enum StepOutcome {
    /// Issue the action-set and stay on this step.
    Continue(PlanAction),
    /// The step is complete AND produces its final action this tick (the legacy
    /// [`DoomPlanStep::Hold`], consumed in one tick).
    CompleteWith(PlanAction),
    /// The step is complete — no action belongs to it this tick; the executor
    /// advances to the next step (in the SAME tick).
    Complete,
}

impl ActiveStep {
    /// Start a step from its plan entry at `index`.
    fn start(step: &DoomPlanStep, index: usize, observation: &Value) -> Self {
        match step {
            DoomPlanStep::Move { bearing, distance } => ActiveStep::Move {
                index,
                bearing: *bearing,
                remaining: *distance,
                last_position: observation_position(observation),
            },
            DoomPlanStep::OpenDoor { bearing } => ActiveStep::OpenDoor {
                index,
                bearing: *bearing,
                ticks: 0,
            },
            DoomPlanStep::Shoot { tics } => ActiveStep::Timed {
                index,
                remaining: *tics,
                actions: vec![json!({ "type": DOOM_ACTION_SHOOT, "amount": DOOM_PLAN_SHOOT_AMOUNT })],
                legacy: false,
            },
            DoomPlanStep::Wait { tics } => ActiveStep::Timed {
                index,
                remaining: *tics,
                actions: Vec::new(),
                legacy: false,
            },
            DoomPlanStep::Hold { actions, .. } => ActiveStep::Timed {
                index,
                // The legacy/local hold is consumed in ONE tick by the continuous
                // loop's one-tick cadence — its actions become the retained intent
                // (exactly the pre-ST-4 behaviour).
                remaining: 1,
                actions: actions.clone(),
                legacy: true,
            },
        }
    }

    /// The plan-step index this step occupies.
    fn index(&self) -> usize {
        match self {
            ActiveStep::Move { index, .. }
            | ActiveStep::OpenDoor { index, .. }
            | ActiveStep::Timed { index, .. } => *index,
        }
    }

    /// Whether the active `OpenDoor` step has diverged on its door (AC4): the
    /// target reports `closing`, or the bounded wait has elapsed without
    /// `state == "waiting"`. Non-`OpenDoor` steps never diverge here.
    fn door_diverged(&self, observation: &Value, door_wait_max: u32) -> bool {
        match self {
            ActiveStep::OpenDoor { bearing, ticks, .. } => {
                if *ticks == 0 {
                    // The first tick only faces the bearing; the door cannot be
                    // judged before the player is looking at it.
                    return false;
                }
                let closing = target_door_state(observation, *bearing).as_deref() == Some("closing");
                closing || *ticks >= door_wait_max
            }
            _ => false,
        }
    }

    /// Advance the step by one engine tick against `observation`.
    fn advance(&mut self, observation: &Value) -> StepOutcome {
        match self {
            ActiveStep::Move {
                bearing,
                remaining,
                last_position,
                ..
            } => {
                let current = observation_position(observation);
                if let (Some(previous), Some(current)) = (*last_position, current) {
                    *remaining = (*remaining - manhattan(previous, current)).max(0);
                }
                if *remaining <= 0 {
                    return StepOutcome::Complete;
                }
                *last_position = current;
                StepOutcome::Continue(PlanAction::Native(vec![
                    turn_to_action(*bearing),
                    forward_action(),
                    run_action(),
                ]))
            }
            ActiveStep::OpenDoor { bearing, ticks, .. } => {
                if *ticks >= 1
                    && target_door_state(observation, *bearing).as_deref() == Some("waiting")
                {
                    return StepOutcome::Complete;
                }
                *ticks = ticks.saturating_add(1);
                let mut actions = vec![turn_to_action(*bearing)];
                if (*ticks - 1).is_multiple_of(DOOM_DOOR_USE_REPRESS_TICKS) {
                    actions.push(use_action());
                }
                StepOutcome::Continue(PlanAction::Native(actions))
            }
            ActiveStep::Timed {
                remaining,
                actions,
                legacy,
                ..
            } => {
                if *legacy {
                    // The retained legacy/local hold: issue its actions AND
                    // complete in one tick, exactly as the pre-ST-4 continuous
                    // loop re-issued (and immediately superseded) the model intent.
                    return StepOutcome::CompleteWith(PlanAction::Legacy(actions.clone()));
                }
                if *remaining <= 0 {
                    return StepOutcome::Complete;
                }
                *remaining -= 1;
                StepOutcome::Continue(PlanAction::Native(actions.clone()))
            }
        }
    }
}

/// The pure deterministic plan executor (AC2/AC3/AC4).
///
/// Owns the adopted plan, its step cursor, the active step's progress, and the
/// run-total `plans` / `replans` counters. Consumed one engine tick at a time by
/// [`super::agent::run_continuous_loop`]; owns no I/O, no RNG, no clock.
#[derive(Debug)]
pub struct PlanExecutor {
    plan: Vec<DoomPlanStep>,
    cursor: usize,
    active: Option<ActiveStep>,
    /// Whether a `front` enemy was already visible when the current plan was
    /// adopted (the `frontEnemy` trigger only fires on a NEW one).
    adopted_front_enemy: bool,
    door_wait_max: u32,
    plans: u32,
    replans: u32,
}

impl Default for PlanExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl PlanExecutor {
    /// Build an executor with the effective bounded door wait ([`door_wait_max_ticks`]).
    pub fn new() -> Self {
        Self::with_door_wait_max(door_wait_max_ticks())
    }

    /// Build an executor with an explicit bounded door wait (unit-testable
    /// without mutating process-global env, G-222).
    pub fn with_door_wait_max(door_wait_max: u32) -> Self {
        Self {
            plan: Vec::new(),
            cursor: 0,
            active: None,
            adopted_front_enemy: false,
            door_wait_max,
            plans: 0,
            replans: 0,
        }
    }

    /// Adopt a validated plan (AC2): reset the cursor, start at the first step,
    /// stamp the adoption's front-enemy state, and count the plan.
    pub fn adopt(&mut self, plan: DoomPlan, observation: &Value) {
        self.plan = plan.steps;
        self.cursor = 0;
        self.active = None;
        self.adopted_front_enemy = observation_has_front_enemy(observation);
        self.plans = self.plans.saturating_add(1);
    }

    /// Clear the adopted plan and cursor on a divergence/re-plan — the executor
    /// is idle until the next plan is adopted. The run-total counters persist.
    pub fn invalidate(&mut self) {
        self.plan.clear();
        self.cursor = 0;
        self.active = None;
    }

    /// Clear only the per-level plan state on a level transition (death restart /
    /// advance): the plan and cursor reset, the run-total counters persist.
    pub fn reset_positioning(&mut self) {
        self.invalidate();
    }

    /// Whether the executor has no plan to run: a fresh/reset executor, or one
    /// whose plan was invalidated. A mid-plan executor is NOT idle.
    pub fn is_idle(&self) -> bool {
        self.active.is_none() && self.cursor >= self.plan.len()
    }

    /// The plans adopted this run (byte-stable status counter).
    pub fn plans(&self) -> u32 {
        self.plans
    }

    /// The re-plans requested this run (byte-stable status counter).
    pub fn replans(&self) -> u32 {
        self.replans
    }

    /// The current plan-step index (observability `planIndex`).
    pub fn index(&self) -> u32 {
        self.active
            .as_ref()
            .map_or(self.cursor as u32, |active| active.index() as u32)
    }

    /// One executor tick: evaluate divergence, then execute the active step
    /// (starting the next step in the same tick when one completes). Pure — a
    /// function of `observation` + `counters` + the persisted state.
    pub fn tick(&mut self, observation: &Value, counters: &ReplanCounters) -> PlanTick {
        // A plan has at most DOOM_PLAN_MAX_STEPS steps; the completion loop can
        // therefore advance at most that many steps in one tick. The bound is
        // defensive (a completing step never starts another that completes in the
        // same tick, so this is unreachable).
        let mut guard = 0usize;
        loop {
            guard += 1;
            if guard > DOOM_PLAN_MAX_STEPS_GUARD {
                self.replans = self.replans.saturating_add(1);
                self.invalidate();
                return PlanTick {
                    action: PlanAction::None,
                    replan: Some(ReplanReason::Exhausted),
                    index: 0,
                };
            }

            if self.active.is_none() {
                if self.cursor >= self.plan.len() {
                    if self.plan.is_empty() {
                        // No plan at all: the retained fallback drives.
                        return PlanTick {
                            action: PlanAction::None,
                            replan: None,
                            index: self.cursor as u32,
                        };
                    }
                    // The plan's steps are exhausted (AC3).
                    let new_front_enemy = observation_has_front_enemy(observation)
                        && !self.adopted_front_enemy;
                    let reason = replan_reason(counters, new_front_enemy, false, true)
                        .unwrap_or(ReplanReason::Exhausted);
                    self.replans = self.replans.saturating_add(1);
                    self.invalidate();
                    return PlanTick {
                        action: PlanAction::None,
                        replan: Some(reason),
                        index: 0,
                    };
                }
                let index = self.cursor;
                self.active = Some(ActiveStep::start(
                    &self.plan[index],
                    index,
                    observation,
                ));
            }

            // Divergence (AC3) is evaluated BEFORE the step issues anything, so a
            // diverged plan stops driving the world and the retained fallback
            // takes over until a new plan arrives.
            let new_front_enemy =
                observation_has_front_enemy(observation) && !self.adopted_front_enemy;
            let door_not_waiting = self
                .active
                .as_ref()
                .is_some_and(|active| active.door_diverged(observation, self.door_wait_max));
            if let Some(reason) = replan_reason(counters, new_front_enemy, door_not_waiting, false) {
                self.replans = self.replans.saturating_add(1);
                self.invalidate();
                return PlanTick {
                    action: PlanAction::None,
                    replan: Some(reason),
                    index: 0,
                };
            }

            let Some(mut active) = self.active.take() else {
                // Unreachable: `active` was just ensured above.
                return PlanTick {
                    action: PlanAction::None,
                    replan: None,
                    index: self.cursor as u32,
                };
            };
            let index = active.index();
            match active.advance(observation) {
                StepOutcome::Continue(action) => {
                    self.active = Some(active);
                    return PlanTick {
                        action,
                        replan: None,
                        index: index as u32,
                    };
                }
                StepOutcome::CompleteWith(action) => {
                    self.cursor = index + 1;
                    self.active = None;
                    let exhausted = self.cursor >= self.plan.len();
                    if exhausted {
                        self.replans = self.replans.saturating_add(1);
                        self.invalidate();
                    }
                    return PlanTick {
                        action,
                        replan: exhausted.then_some(ReplanReason::Exhausted),
                        index: index as u32,
                    };
                }
                StepOutcome::Complete => {
                    self.cursor = index + 1;
                    self.active = None;
                    // Start the next step in the SAME tick (a completing step
                    // consumed no action); `exhausted` is caught at the loop top.
                    continue;
                }
            }
        }
    }
}

/// The defensive per-tick step-advance bound (mirrors the plan's step maximum).
const DOOM_PLAN_MAX_STEPS_GUARD: usize =
    crate::infrastructure::companion::doom_decision::DOOM_PLAN_MAX_STEPS + 1;

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    use crate::applications::doom::clock::{FixedTickClock, DOOM_CONTINUOUS_TICK_PERIOD_MS};
    use crate::applications::doom::decision::ScriptedDecisionSource;
    use crate::applications::doom::engine::{run_bounded_driver, DoomDriverConfig, DoomDriverReport};

    // ── Pure re-plan predicate (the FIVE triggers) ───────────────────────────

    #[test]
    fn the_replan_thresholds_are_pinned() {
        assert_eq!(DOOM_REPLAN_BLOCKED_TICKS, 4);
        assert_eq!(DOOM_REPLAN_NO_PROGRESS_TICKS, 12);
        assert_eq!(DOOM_DOOR_WAIT_MAX_TICKS, 210);
        assert_eq!(DOOM_DOOR_USE_REPRESS_TICKS, 30);
        assert_eq!(DOOM_DOOR_WAIT_MAX_TICKS_ENV, "FREDO_DOOM_DOOR_WAIT_MAX_TICKS");
        assert_eq!(DOOM_PLAN_FORWARD_AMOUNT, 1);
        assert_eq!(DOOM_PLAN_SHOOT_AMOUNT, 1);
    }

    #[test]
    fn the_five_replan_reasons_serialize_to_the_wire_vocabulary() {
        let cases = [
            (ReplanReason::Blocked, "blocked"),
            (ReplanReason::NoProgress, "noProgress"),
            (ReplanReason::FrontEnemy, "frontEnemy"),
            (ReplanReason::DoorClosed, "doorClosed"),
            (ReplanReason::Exhausted, "exhausted"),
        ];
        for (reason, wire) in cases {
            assert_eq!(reason.wire(), wire);
        }
    }

    #[test]
    fn replan_reason_fires_each_trigger_in_isolation() {
        let clear = ReplanCounters::default();
        // 1. blocked >= 4
        assert_eq!(
            replan_reason(
                &ReplanCounters {
                    blocked_forward_ticks: DOOM_REPLAN_BLOCKED_TICKS,
                    ..clear
                },
                false,
                false,
                false
            ),
            Some(ReplanReason::Blocked)
        );
        // 2. no-progress >= 12
        assert_eq!(
            replan_reason(
                &ReplanCounters {
                    no_move_ticks: DOOM_REPLAN_NO_PROGRESS_TICKS,
                    ..clear
                },
                false,
                false,
                false
            ),
            Some(ReplanReason::NoProgress)
        );
        // 3. new front enemy
        assert_eq!(
            replan_reason(&clear, true, false, false),
            Some(ReplanReason::FrontEnemy)
        );
        // 4. door-closed
        assert_eq!(
            replan_reason(&clear, false, true, false),
            Some(ReplanReason::DoorClosed)
        );
        // 5. plan exhausted
        assert_eq!(
            replan_reason(&clear, false, false, true),
            Some(ReplanReason::Exhausted)
        );
        // Below every threshold, in agreement → no re-plan.
        assert_eq!(replan_reason(&clear, false, false, false), None);
        assert_eq!(
            replan_reason(
                &ReplanCounters {
                    blocked_forward_ticks: DOOM_REPLAN_BLOCKED_TICKS - 1,
                    no_move_ticks: DOOM_REPLAN_NO_PROGRESS_TICKS - 1,
                },
                false,
                false,
                false
            ),
            None
        );
    }

    #[test]
    fn replan_reason_has_a_deterministic_precedence_when_all_triggers_fire() {
        let all = ReplanCounters {
            blocked_forward_ticks: DOOM_REPLAN_BLOCKED_TICKS,
            no_move_ticks: DOOM_REPLAN_NO_PROGRESS_TICKS,
        };
        assert_eq!(
            replan_reason(&all, true, true, true),
            Some(ReplanReason::Blocked)
        );
        assert_eq!(
            replan_reason(
                &ReplanCounters {
                    blocked_forward_ticks: DOOM_REPLAN_BLOCKED_TICKS - 1,
                    no_move_ticks: DOOM_REPLAN_NO_PROGRESS_TICKS,
                },
                true,
                true,
                true
            ),
            Some(ReplanReason::NoProgress)
        );
        assert_eq!(
            replan_reason(
                &ReplanCounters {
                    blocked_forward_ticks: DOOM_REPLAN_BLOCKED_TICKS - 1,
                    no_move_ticks: DOOM_REPLAN_NO_PROGRESS_TICKS - 1,
                },
                true,
                true,
                true
            ),
            Some(ReplanReason::FrontEnemy)
        );
        assert_eq!(
            replan_reason(
                &ReplanCounters {
                    blocked_forward_ticks: DOOM_REPLAN_BLOCKED_TICKS - 1,
                    no_move_ticks: DOOM_REPLAN_NO_PROGRESS_TICKS - 1,
                },
                false,
                true,
                true
            ),
            Some(ReplanReason::DoorClosed)
        );
    }

    #[test]
    fn the_replan_audit_record_is_the_documented_shape() {
        let record = build_replan_audit_record(ReplanReason::DoorClosed);
        assert_eq!(record["event"], "replan");
        assert_eq!(record["reason"], "doorClosed");
        assert_eq!(record.as_object().expect("object").len(), 2);
    }

    #[test]
    fn the_door_wait_env_override_is_inert_when_unset() {
        // The pure parser path (no env mutation, G-222).
        assert_eq!(super::super::decision::parse_u32(None), None);
        assert_eq!(super::super::decision::parse_u32(Some("nope")), None);
        assert_eq!(super::super::decision::parse_u32(Some(" 3 ")), Some(3));
    }

    #[test]
    fn the_explicit_door_wait_constructor_uses_its_bound() {
        let executor = PlanExecutor::with_door_wait_max(3);
        assert!(executor.is_idle());
        assert_eq!(executor.plans(), 0);
        assert_eq!(executor.replans(), 0);
    }

    // ── The executed plan steps ──────────────────────────────────────────────

    fn move_observation(x: i64, y: i64) -> Value {
        json!({ "player": { "x": x, "y": y, "angle": 0 }, "enemies": [], "doors": [] })
    }

    #[test]
    fn a_move_step_faces_and_walks_until_the_distance_is_consumed() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Move {
                    bearing: 90,
                    distance: 20,
                }],
            },
            &move_observation(0, 0),
        );
        assert_eq!(executor.plans(), 1);

        // Tick 1: faces the bearing and holds a bounded forward.
        let counters = ReplanCounters::default();
        let tick = executor.tick(&move_observation(0, 0), &counters);
        match &tick.action {
            PlanAction::Native(actions) => {
                assert_eq!(actions[0], json!({ "type": "turn-to", "angle": 90 }));
                assert_eq!(actions[1]["type"], "forward");
                assert_eq!(actions[1]["amount"], DOOM_PLAN_FORWARD_AMOUNT);
            }
            other => panic!("expected a native move action, got {other:?}"),
        }
        assert_eq!(tick.replan, None);
        assert_eq!(executor.index(), 0);

        // Tick 2: the observed position moved 20 units → the step completes and
        // the plan is exhausted → a re-plan is requested.
        let tick = executor.tick(&move_observation(20, 0), &counters);
        assert_eq!(tick.action, PlanAction::None);
        assert_eq!(tick.replan, Some(ReplanReason::Exhausted));
        assert_eq!(executor.replans(), 1);
        assert!(executor.is_idle());
    }

    #[test]
    fn a_partially_consumed_move_keeps_walking() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Move {
                    bearing: 0,
                    distance: 100,
                }],
            },
            &move_observation(0, 0),
        );
        let counters = ReplanCounters::default();
        let first = executor.tick(&move_observation(0, 0), &counters);
        assert!(matches!(first.action, PlanAction::Native(_)));
        // Move 30 of 100: still active.
        let second = executor.tick(&move_observation(0, 30), &counters);
        assert!(matches!(second.action, PlanAction::Native(_)));
        assert_eq!(second.replan, None);
        assert_eq!(executor.index(), 0);
    }

    #[test]
    fn a_shoot_step_holds_for_its_tics_then_exhausts() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Shoot { tics: 3 }],
            },
            &move_observation(0, 0),
        );
        let counters = ReplanCounters::default();
        for expected_remaining in (0..3).rev() {
            let tick = executor.tick(&move_observation(0, 0), &counters);
            match &tick.action {
                PlanAction::Native(actions) => assert_eq!(actions[0]["type"], "shoot"),
                other => panic!("expected a shoot, got {other:?}"),
            }
            assert_eq!(tick.replan, None, "remaining {expected_remaining}");
        }
        // The 4th tick sees the hold complete → exhausted.
        let tick = executor.tick(&move_observation(0, 0), &counters);
        assert_eq!(tick.action, PlanAction::None);
        assert_eq!(tick.replan, Some(ReplanReason::Exhausted));
    }

    #[test]
    fn a_wait_step_issues_no_action() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Wait { tics: 1 }],
            },
            &move_observation(0, 0),
        );
        let counters = ReplanCounters::default();
        let tick = executor.tick(&move_observation(0, 0), &counters);
        assert_eq!(tick.action, PlanAction::Native(Vec::new()));
        assert_eq!(tick.replan, None);
    }

    #[test]
    fn a_hold_step_is_the_legacy_path_and_is_consumed_in_one_tick() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Hold {
                    tics: 40,
                    actions: vec![json!({ "type": "shoot" })],
                }],
            },
            &move_observation(0, 0),
        );
        let counters = ReplanCounters::default();
        // The hold issues its actions AND completes (exhausting the one-step plan)
        // in a single tick — the pre-ST-4 legacy behaviour.
        let tick = executor.tick(&move_observation(0, 0), &counters);
        assert_eq!(
            tick.action,
            PlanAction::Legacy(vec![json!({ "type": "shoot" })])
        );
        assert_eq!(tick.replan, Some(ReplanReason::Exhausted));
        assert!(executor.is_idle(), "the hold leaves the executor idle");
        // The next tick is the retained fallback with no plan.
        let next = executor.tick(&move_observation(0, 0), &counters);
        assert_eq!(next.action, PlanAction::None);
        assert_eq!(next.replan, None);
    }

    #[test]
    fn a_multi_step_plan_advances_one_step_per_tick() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![
                    DoomPlanStep::Shoot { tics: 1 },
                    DoomPlanStep::Wait { tics: 1 },
                ],
            },
            &move_observation(0, 0),
        );
        let counters = ReplanCounters::default();
        // Tick 1 → step 0 (shoot).
        let first = executor.tick(&move_observation(0, 0), &counters);
        assert!(matches!(&first.action, PlanAction::Native(a) if a[0]["type"] == "shoot"));
        assert_eq!(first.index, 0);
        // Tick 2 → step 1 (wait, no action).
        let second = executor.tick(&move_observation(0, 0), &counters);
        assert_eq!(second.action, PlanAction::Native(Vec::new()));
        assert_eq!(second.index, 1);
        // Tick 3 → exhausted.
        let third = executor.tick(&move_observation(0, 0), &counters);
        assert_eq!(third.replan, Some(ReplanReason::Exhausted));
    }

    // ── Doors first-class (AC4) ──────────────────────────────────────────────

    fn door_observation(state: &str, bearing: i64) -> Value {
        json!({
            "player": { "x": 0, "y": 0, "angle": 90 },
            "enemies": [],
            "doors": [{ "kind": "door", "state": state, "direction": "front", "distance": 40 }],
            "forward": { "doorBearings": [{ "bearing": bearing, "distance": 40, "state": state }] },
        })
    }

    #[test]
    fn an_open_door_step_presses_use_then_waits_for_waiting() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::OpenDoor { bearing: 90 }],
            },
            &door_observation("opening", 0),
        );
        let counters = ReplanCounters::default();

        // Tick 1: faces the bearing and presses `use` (the first repress slot).
        let first = executor.tick(&door_observation("opening", 0), &counters);
        match &first.action {
            PlanAction::Native(actions) => {
                assert_eq!(actions[0], json!({ "type": "turn-to", "angle": 90 }));
                assert!(actions.iter().any(|a| a["type"] == "use"), "{actions:?}");
            }
            other => panic!("expected the open-door actions, got {other:?}"),
        }
        assert_eq!(first.replan, None, "must not proceed before waiting");

        // Tick 2: still opening → keeps waiting (does NOT advance the step).
        let second = executor.tick(&door_observation("opening", 0), &counters);
        assert!(matches!(second.action, PlanAction::Native(_)));
        assert_eq!(second.replan, None);
        assert_eq!(executor.index(), 0);

        // Tick 3: the door reports `waiting` → proceed; the one-step plan is
        // exhausted.
        let third = executor.tick(&door_observation("waiting", 0), &counters);
        assert_eq!(third.action, PlanAction::None);
        assert_eq!(third.replan, Some(ReplanReason::Exhausted));
        assert!(executor.is_idle());
    }

    #[test]
    fn an_open_door_step_re_presses_use_on_the_cadence() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::OpenDoor { bearing: 90 }],
            },
            &door_observation("opening", 0),
        );
        let counters = ReplanCounters::default();
        // Tick 1 presses `use`; ticks 2..N must NOT; the `N+1`th (the cadence)
        // does.
        let mut use_ticks: Vec<u32> = Vec::new();
        for tick_index in 1..=DOOM_DOOR_USE_REPRESS_TICKS + 1 {
            let tick = executor.tick(&door_observation("opening", 0), &counters);
            if let PlanAction::Native(actions) = &tick.action {
                if actions.iter().any(|a| a["type"] == "use") {
                    use_ticks.push(tick_index);
                }
            }
        }
        assert_eq!(
            use_ticks,
            vec![1, DOOM_DOOR_USE_REPRESS_TICKS + 1],
            "the first press and the cadence"
        );
    }

    #[test]
    fn an_open_door_step_times_out_and_replans_when_never_waiting() {
        let mut executor = PlanExecutor::with_door_wait_max(3);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::OpenDoor { bearing: 90 }],
            },
            &door_observation("opening", 0),
        );
        let counters = ReplanCounters::default();
        // Ticks 1..3 keep waiting; tick 4 exceeds the tiny bound → re-plan.
        for _ in 0..3 {
            let tick = executor.tick(&door_observation("opening", 0), &counters);
            assert_eq!(tick.replan, None);
        }
        let tick = executor.tick(&door_observation("opening", 0), &counters);
        assert_eq!(tick.action, PlanAction::None);
        assert_eq!(tick.replan, Some(ReplanReason::DoorClosed));
        assert!(executor.is_idle());
        assert_eq!(executor.replans(), 1);
    }

    #[test]
    fn an_open_door_step_replans_when_the_door_regresses_to_closing() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::OpenDoor { bearing: 90 }],
            },
            &door_observation("opening", 0),
        );
        let counters = ReplanCounters::default();
        let first = executor.tick(&door_observation("opening", 0), &counters);
        assert_eq!(first.replan, None);
        let second = executor.tick(&door_observation("closing", 0), &counters);
        assert_eq!(second.replan, Some(ReplanReason::DoorClosed));
        assert!(executor.is_idle());
    }

    // ── Divergence triggers driven through the executor ──────────────────────

    #[test]
    fn a_new_front_enemy_triggers_a_replan() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        // Adopt with NO front enemy.
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Move {
                    bearing: 0,
                    distance: 500,
                }],
            },
            &move_observation(0, 0),
        );
        let counters = ReplanCounters::default();
        // A front enemy appears mid-plan → re-plan (a NEW one).
        let observation = json!({
            "player": { "x": 0, "y": 0, "angle": 0 },
            "enemies": [{ "direction": "front", "distance": 120 }],
            "doors": [],
        });
        let tick = executor.tick(&observation, &counters);
        assert_eq!(tick.action, PlanAction::None);
        assert_eq!(tick.replan, Some(ReplanReason::FrontEnemy));
        assert!(executor.is_idle());
    }

    #[test]
    fn a_front_enemy_present_at_adoption_does_not_immediately_replan() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        let observation = json!({
            "player": { "x": 0, "y": 0, "angle": 0 },
            "enemies": [{ "direction": "front", "distance": 120 }],
            "doors": [],
        });
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Move {
                    bearing: 0,
                    distance: 500,
                }],
            },
            &observation,
        );
        let tick = executor.tick(&observation, &ReplanCounters::default());
        assert_eq!(tick.replan, None, "the plan was adopted accounting for it");
    }

    #[test]
    fn blocked_and_no_progress_counters_trigger_theirs_replans() {
        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Move {
                    bearing: 0,
                    distance: 500,
                }],
            },
            &move_observation(0, 0),
        );
        let blocked = executor.tick(
            &move_observation(0, 0),
            &ReplanCounters {
                blocked_forward_ticks: DOOM_REPLAN_BLOCKED_TICKS,
                no_move_ticks: 0,
            },
        );
        assert_eq!(blocked.replan, Some(ReplanReason::Blocked));

        let mut executor = PlanExecutor::with_door_wait_max(DOOM_DOOR_WAIT_MAX_TICKS);
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Move {
                    bearing: 0,
                    distance: 500,
                }],
            },
            &move_observation(0, 0),
        );
        let stalled = executor.tick(
            &move_observation(0, 0),
            &ReplanCounters {
                blocked_forward_ticks: 0,
                no_move_ticks: DOOM_REPLAN_NO_PROGRESS_TICKS,
            },
        );
        assert_eq!(stalled.replan, Some(ReplanReason::NoProgress));
    }

    // ── Observation helpers ──────────────────────────────────────────────────

    #[test]
    fn observation_helpers_are_tolerant_and_typed() {
        assert_eq!(observation_position(&move_observation(3, 4)), Some((3, 4)));
        assert_eq!(observation_position(&json!({})), None);

        assert!(observation_has_front_enemy(&json!({
            "enemies": [{ "direction": "front" }]
        })));
        assert!(!observation_has_front_enemy(&json!({
            "enemies": [{ "direction": "back" }]
        })));
        assert!(!observation_has_front_enemy(&json!({})));

        // `target_door_state` prefers the closest door bearing.
        let obs = json!({
            "player": { "angle": 0 },
            "forward": { "doorBearings": [
                { "bearing": -60, "distance": 40, "state": "opening" },
                { "bearing": 0, "distance": 30, "state": "waiting" },
            ] },
        });
        assert_eq!(target_door_state(&obs, 0).as_deref(), Some("waiting"));
        // Fallback to `doors[]` when there is no `forward` sensor.
        let fallback = json!({ "doors": [{ "direction": "front", "state": "closing" }] });
        assert_eq!(target_door_state(&fallback, 0).as_deref(), Some("closing"));
        assert_eq!(target_door_state(&json!({}), 0), None);
    }

    #[test]
    fn target_door_state_matches_by_fov_cone_and_nearest_distance() {
        assert_eq!(DOOM_DOOR_FACING_TOLERANCE_DEGREES, 12);
        // Two doors inside the cone: the NEAREST distance wins (regardless of
        // iteration order).
        let inside = json!({
            "player": { "angle": 0 },
            "forward": { "doorBearings": [
                { "bearing": 8, "distance": 80, "state": "closing" },
                { "bearing": -5, "distance": 30, "state": "waiting" },
            ] },
        });
        assert_eq!(target_door_state(&inside, 0).as_deref(), Some("waiting"));
        // A door OUTSIDE the FOV cone is ignored even when much nearer.
        let outside = json!({
            "player": { "angle": 0 },
            "forward": { "doorBearings": [
                { "bearing": 40, "distance": 10, "state": "closing" },
                { "bearing": 3, "distance": 90, "state": "opening" },
            ] },
        });
        assert_eq!(target_door_state(&outside, 0).as_deref(), Some("opening"));
        // No door inside the cone → no target door.
        let none = json!({
            "player": { "angle": 0 },
            "forward": { "doorBearings": [ { "bearing": 90, "distance": 5, "state": "waiting" } ] },
        });
        assert_eq!(target_door_state(&none, 0), None);
    }

    // ── Determinism (NFR-DET): two identical driven runs ─────────────────────

    /// **ST-4 (NFR-DET).** A run driven by `run_bounded_driver` + `FixedTickClock`
    /// with a NATIVE plan script reproduces the report field-for-field — the plan
    /// executor is step-driven, with no wall clock (G-316).
    #[tokio::test]
    async fn the_native_plan_driver_is_field_for_field_deterministic() {
        async fn run() -> DoomDriverReport {
            let state = crate::applications::doom::engine::DoomEngineState::default();
            let source = ScriptedDecisionSource::from_script_json(
                &json!({
                    "decisions": [
                        { "steps": [
                            { "op": "shoot", "tics": 4 },
                            { "op": "wait", "tics": 4 },
                            { "op": "move", "bearing": 90, "distance": 64 }
                        ] }
                    ],
                    "repeat": true
                })
                .to_string(),
            )
            .expect("script");
            let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
            run_bounded_driver(
                &state,
                &source,
                DoomDriverConfig {
                    map: 1,
                    skill: 3,
                    max_steps: 64,
                    max_failures: 3,
                    stop_at_first_exit: false,
                },
                &clock,
            )
            .await
            .expect("driven run")
        }

        let first = run().await;
        let second = run().await;
        assert_eq!(first, second, "identical native plan ⇒ identical report");
        assert!(first.ticks > 0);
    }

    /// **ST-4 (AC2).** A native plan executes tick-by-tick: one plan covers many
    /// engine ticks, so the run's `steps` exceed its `decisions` (`steps ≫
    /// decisions`) — the decision latency is amortized across the plan.
    #[tokio::test]
    async fn a_native_plan_amortizes_the_decision_across_many_ticks() {
        let state = crate::applications::doom::engine::DoomEngineState::default();
        let source = ScriptedDecisionSource::from_script_json(
            &json!({
                "decisions": [
                    { "steps": [
                        { "op": "shoot", "tics": 8 },
                        { "op": "wait", "tics": 8 },
                        { "op": "move", "bearing": 90, "distance": 32 }
                    ] }
                ],
                "repeat": true
            })
            .to_string(),
        )
        .expect("script");
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let report = run_bounded_driver(
            &state,
            &source,
            DoomDriverConfig {
                map: 1,
                skill: 3,
                max_steps: 64,
                max_failures: 3,
                stop_at_first_exit: false,
            },
            &clock,
        )
        .await
        .expect("driven run");

        assert!(report.steps > 0);
        assert!(
            report.steps > report.decisions,
            "a plan must amortize: steps {} vs decisions {}",
            report.steps,
            report.decisions
        );
    }
}
