//! Deterministic engagement policy (Spec #3053 ST-1).
//!
//! The **combat layer** gives the Doom Companion a model-independent reflex:
//! when an enemy is in its `front` arc it fires; when a target sits in a side
//! bucket within the acquire range it turns toward it (bounded, closed-loop,
//! bucket-level aim); and while its health is low it disengages with a bounded
//! `backward` retreat. It is a **pure function of the observation + the
//! persisted [`DoomCombatPolicy`]** — no RNG, no wall clock, no I/O — mirroring
//! the purity contract of [`super::plan`] (NFR-DET).
//!
//! # Vocabulary
//!
//! The observation's `enemies[]` entries are
//! `{"kind", "hp", "direction", "distance"}` where `direction` is a coarse
//! bearing bucket (`front`/`left`/`right`/`back`) produced by the engine's
//! `relative_direction` rule. `front` is the ~±45° arc; there is **no** finer
//! enemy bearing in the observation, so "aim" is a bounded turn toward the
//! side bucket until the target re-buckets as `front`, then fire (the hitscan
//! autoaim covers the residual). This layer consumes that vocabulary **as-is**
//! — it never changes the perception contract.
//!
//! # Reflex reconciliation (binding)
//!
//! The combat layer and the retained [`super::agent::safety_reflex`] share ONE
//! predicate: [`super::plan::observation_has_front_enemy`]. A `shoot` is emitted
//! **only** when that predicate is true (the selected target is `front`), so a
//! legitimately-detected front enemy is never suppressed and firing with no
//! front enemy stays suppressed. The reconciliation is structural, not a second
//! predicate.
//!
//! # Inertness (R-4 / AC4)
//!
//! [`combat_target`] / [`combat_intent`] return `None` when there is no
//! engageable target in the selection — no `front` enemy and no in-range side
//! enemy. The retained pipeline then drives the tick unchanged (byte-identical).
//!
//! # Test-only induction seam (G-275/G-300)
//!
//! `FREDO_DOOM_COMBAT_LOW_HEALTH` ([`DOOM_COMBAT_LOW_HEALTH_ENV`]) overrides the
//! low-health threshold so the tester can force the disengage path without
//! clobbering the observation's `player` object; it is read only by
//! [`combat_low_health`] and is **inert when unset, blank, or invalid**.

use serde_json::{json, Value};

use super::actions::{
    DOOM_ACTION_BACKWARD, DOOM_ACTION_SHOOT, DOOM_ACTION_TURN_LEFT, DOOM_ACTION_TURN_RIGHT,
};

// ── Pinned constants (Architect-owned, G-255) ────────────────────────────────

/// The low-health threshold: at or below it the companion disengages (AC3).
pub const DOOM_COMBAT_LOW_HEALTH: i64 = 25;

/// The side-acquisition bound, in map units: a `left`/`right` target is chased
/// (turned toward) only within this distance — never beyond.
pub const DOOM_COMBAT_ACQUIRE_RANGE: i64 = 512;

/// The per-tick bounded `shoot` hold, in tics (mirrors
/// [`super::plan::DOOM_PLAN_SHOOT_AMOUNT`]).
pub const DOOM_COMBAT_FIRE_TICS: i64 = 1;

/// The per-tick bounded `turn-left`/`turn-right` hold, in tics.
pub const DOOM_COMBAT_TURN_AMOUNT: i64 = 1;

/// The per-tick bounded `backward` retreat hold, in tics (mirrors
/// [`super::agent::DOOM_REFLEX_STEP_BACK_TICKS`]).
pub const DOOM_COMBAT_RETREAT_TICS: i64 = 2;

/// The test-only override of [`DOOM_COMBAT_LOW_HEALTH`] (G-275/G-300). Inert
/// when unset, blank, or invalid — production keeps the pinned threshold.
pub const DOOM_COMBAT_LOW_HEALTH_ENV: &str = "FREDO_DOOM_COMBAT_LOW_HEALTH";

// ── Engagement vocabulary ────────────────────────────────────────────────────

/// Whether the combat layer is engaging a target or disengaging (AC3). Carried
/// on the intent for observability — the wire vocabulary is stable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CombatMode {
    /// Actively aiming/firing at a target.
    Engage,
    /// Backing away because health is low.
    Disengage,
}

impl CombatMode {
    /// The wire string (`"engage"` / `"disengage"`).
    pub fn wire(self) -> &'static str {
        match self {
            CombatMode::Engage => "engage",
            CombatMode::Disengage => "disengage",
        }
    }
}

/// The selected engagement target: the coarse `direction` bucket (`front`,
/// `left`, or `right`) and its observed `distance` in map units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CombatTarget {
    /// The target's direction bucket — one of `front`, `left`, `right`.
    pub direction: &'static str,
    /// The target's observed distance, in map units.
    pub distance: i64,
}

/// The persisted, per-run combat-policy state (mirrors
/// [`super::agent::DoomLocalPolicy`]): pure data the intent updates once per
/// tick. No RNG, no clock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DoomCombatPolicy {
    /// Engaged ticks this run (ticks that produced a [`CombatMode::Engage`]
    /// intent). Reset on a level transition via [`DoomCombatPolicy::reset`].
    pub engagements: u32,
}

impl DoomCombatPolicy {
    /// Reset the per-run counters for a level transition.
    pub fn reset(&mut self) {
        self.engagements = 0;
    }
}

/// The pure combat intent for one tick: the mode, the selected target, and the
/// bounded action list to compose through the retained pipeline.
#[derive(Clone, Debug, PartialEq)]
pub struct CombatIntent {
    /// Whether the companion is engaging or disengaging.
    pub mode: CombatMode,
    /// The selected target (`None` only when there is no intent).
    pub target: Option<CombatTarget>,
    /// The bounded per-tick actions (`shoot` / `turn-*` / `backward`).
    pub actions: Vec<Value>,
}

// ── Target selection (pure) ──────────────────────────────────────────────────

/// Select the engagement target from the observation's `enemies[]`, or `None`
/// when there is no engageable target.
///
/// Deterministic selection (pure + stable):
/// 1. a `front` enemy wins over any side bucket (fire first);
/// 2. otherwise a `left`/`right` enemy within [`DOOM_COMBAT_ACQUIRE_RANGE`] is
///    selected for acquisition (aim);
/// 3. ties are broken **first-listed-wins** (no RNG, no nearest-distance sort).
///
/// A malformed entry (non-object, missing `direction`/`distance`) is skipped;
/// an absent or non-array `enemies` key yields `None`.
pub fn combat_target(observation: &Value) -> Option<CombatTarget> {
    let enemies = observation.get("enemies").and_then(Value::as_array)?;

    // 1. front wins over sides; first-listed front wins the tie.
    for enemy in enemies {
        if enemy.get("direction").and_then(Value::as_str) != Some("front") {
            continue;
        }
        if let Some(distance) = enemy.get("distance").and_then(Value::as_i64) {
            return Some(CombatTarget {
                direction: "front",
                distance,
            });
        }
    }

    // 2/3. first-listed in-range side target (aim).
    for enemy in enemies {
        let direction = match enemy.get("direction").and_then(Value::as_str) {
            Some("left") => "left",
            Some("right") => "right",
            _ => continue,
        };
        let distance = match enemy.get("distance").and_then(Value::as_i64) {
            Some(distance) => distance,
            None => continue,
        };
        if distance <= DOOM_COMBAT_ACQUIRE_RANGE {
            return Some(CombatTarget {
                direction,
                distance,
            });
        }
    }

    None
}

// ── Low-health threshold (pure + one inert env override) ─────────────────────

/// Whether the player's `health` is at or below the effective low-health
/// threshold (AC3). `health <= combat_low_health()`.
pub fn health_disengages(health: i64) -> bool {
    health <= combat_low_health()
}

/// The effective low-health threshold: the [`DOOM_COMBAT_LOW_HEALTH_ENV`]
/// override when set to a valid integer, else the pinned
/// [`DOOM_COMBAT_LOW_HEALTH`]. Inert when unset/blank/invalid (G-275/G-300).
pub fn combat_low_health() -> i64 {
    super::decision::parse_i64(std::env::var(DOOM_COMBAT_LOW_HEALTH_ENV).ok().as_deref())
        .unwrap_or(DOOM_COMBAT_LOW_HEALTH)
}

// ── The per-tick intent (pure) ───────────────────────────────────────────────

/// Compute the bounded combat intent for one tick, or `None` when there is no
/// engageable target (R-4 — the retained pipeline drives).
///
/// * low health (`player.health <= combat_low_health()`) ⇒ [`CombatMode::Disengage`]
///   and exactly ONE bounded `backward` (no `shoot`, even with a `front` target);
/// * a `front` target ⇒ [`CombatMode::Engage`] and exactly ONE bounded `shoot`;
/// * an in-range `left`/`right` target ⇒ [`CombatMode::Engage`] and exactly ONE
///   bounded `turn-left`/`turn-right`;
///
/// Every [`CombatMode::Engage`] tick increments `policy.engagements`. Pure — no
/// RNG, no clock, no I/O.
pub fn combat_intent(
    observation: &Value,
    policy: &mut DoomCombatPolicy,
) -> Option<CombatIntent> {
    let target = combat_target(observation)?;

    let low_health = observation
        .pointer("/player/health")
        .and_then(Value::as_i64)
        .map(health_disengages)
        .unwrap_or(false);

    if low_health {
        return Some(CombatIntent {
            mode: CombatMode::Disengage,
            target: Some(target),
            actions: vec![json!({
                "type": DOOM_ACTION_BACKWARD,
                "amount": DOOM_COMBAT_RETREAT_TICS,
            })],
        });
    }

    policy.engagements += 1;
    let actions = match target.direction {
        "front" => vec![json!({
            "type": DOOM_ACTION_SHOOT,
            "amount": DOOM_COMBAT_FIRE_TICS,
        })],
        "left" => vec![json!({
            "type": DOOM_ACTION_TURN_LEFT,
            "amount": DOOM_COMBAT_TURN_AMOUNT,
        })],
        "right" => vec![json!({
            "type": DOOM_ACTION_TURN_RIGHT,
            "amount": DOOM_COMBAT_TURN_AMOUNT,
        })],
        _ => Vec::new(),
    };

    Some(CombatIntent {
        mode: CombatMode::Engage,
        target: Some(target),
        actions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An `enemies[]` entry with the observation's exact shape.
    fn enemy(direction: &str, distance: i64) -> Value {
        json!({
            "kind": "trooper",
            "hp": 20,
            "direction": direction,
            "distance": distance,
        })
    }

    /// A synthetic observation: `enemies[]` + the player's `health`.
    fn observation(enemies: Value, health: i64) -> Value {
        json!({
            "player": { "health": health },
            "enemies": enemies,
        })
    }

    fn target(direction: &'static str, distance: i64) -> Option<CombatTarget> {
        Some(CombatTarget {
            direction,
            distance,
        })
    }

    #[test]
    fn the_combat_constants_are_pinned() {
        assert_eq!(DOOM_COMBAT_LOW_HEALTH, 25);
        assert_eq!(DOOM_COMBAT_ACQUIRE_RANGE, 512);
        assert_eq!(DOOM_COMBAT_FIRE_TICS, 1);
        assert_eq!(DOOM_COMBAT_TURN_AMOUNT, 1);
        assert_eq!(DOOM_COMBAT_RETREAT_TICS, 2);
        assert_eq!(DOOM_COMBAT_LOW_HEALTH_ENV, "FREDO_DOOM_COMBAT_LOW_HEALTH");
    }

    #[test]
    fn combat_mode_serializes_to_the_wire_vocabulary() {
        assert_eq!(CombatMode::Engage.wire(), "engage");
        assert_eq!(CombatMode::Disengage.wire(), "disengage");
    }

    // 1. side bucket → aim (one bounded turn, no shot); mirrored for right.
    #[test]
    fn a_side_target_aims_toward_its_bucket_without_firing() {
        for (bucket, expected_action, expected_type) in
            [("left", DOOM_ACTION_TURN_LEFT, "turn-left"), ("right", DOOM_ACTION_TURN_RIGHT, "turn-right")]
        {
            let obs = observation(json!([enemy(bucket, 100)]), 100);
            assert_eq!(combat_target(&obs), target(bucket, 100));

            let mut policy = DoomCombatPolicy::default();
            let intent = combat_intent(&obs, &mut policy).expect("engaged");
            assert_eq!(intent.mode, CombatMode::Engage);
            assert_eq!(intent.target, target(bucket, 100));
            assert_eq!(
                intent.actions,
                vec![json!({ "type": expected_action, "amount": DOOM_COMBAT_TURN_AMOUNT })],
                "{expected_type} leg"
            );
            assert!(
                intent.actions.iter().all(|a| a["type"] != "shoot"),
                "a side target must never fire"
            );
        }
    }

    // 2. front bucket → one bounded shot; a second call is byte-identical.
    #[test]
    fn a_front_target_fires_one_bounded_shot_per_tick() {
        let obs = observation(json!([enemy("front", 100)]), 100);
        let mut policy = DoomCombatPolicy::default();

        let first = combat_intent(&obs, &mut policy).expect("engaged");
        assert_eq!(first.mode, CombatMode::Engage);
        assert_eq!(first.target, target("front", 100));
        assert_eq!(
            first.actions,
            vec![json!({ "type": DOOM_ACTION_SHOOT, "amount": DOOM_COMBAT_FIRE_TICS })]
        );
        assert_eq!(policy.engagements, 1);

        // Re-evaluated every tick: same observation ⇒ byte-identical actions.
        let second = combat_intent(&obs, &mut policy).expect("engaged");
        assert_eq!(first.actions, second.actions);
        assert_eq!(policy.engagements, 2);
    }

    // 3. the acquire bound is inclusive (512) and never chased beyond (513).
    #[test]
    fn the_acquire_bound_is_inclusive_and_not_chased_beyond() {
        let mut policy = DoomCombatPolicy::default();

        let at_bound = observation(json!([enemy("left", DOOM_COMBAT_ACQUIRE_RANGE)]), 100);
        assert_eq!(combat_target(&at_bound), target("left", DOOM_COMBAT_ACQUIRE_RANGE));
        assert!(combat_intent(&at_bound, &mut policy).is_some());

        let beyond = observation(json!([enemy("left", DOOM_COMBAT_ACQUIRE_RANGE + 1)]), 100);
        assert_eq!(combat_target(&beyond), None);
        assert_eq!(combat_intent(&beyond, &mut policy), None);
    }

    // 4. low-health threshold (default 25) and the bounded retreat.
    #[test]
    fn health_disengages_at_or_below_the_default_threshold() {
        assert_eq!(combat_low_health(), DOOM_COMBAT_LOW_HEALTH);
        assert!(health_disengages(DOOM_COMBAT_LOW_HEALTH));
        assert!(health_disengages(DOOM_COMBAT_LOW_HEALTH - 1));
        assert!(!health_disengages(DOOM_COMBAT_LOW_HEALTH + 1));
    }

    #[test]
    fn low_health_disengages_with_a_bounded_retreat_and_no_fire() {
        let obs = observation(json!([enemy("front", 100)]), DOOM_COMBAT_LOW_HEALTH);
        let mut policy = DoomCombatPolicy::default();

        let intent = combat_intent(&obs, &mut policy).expect("engaged");
        assert_eq!(intent.mode, CombatMode::Disengage);
        assert_eq!(
            intent.actions,
            vec![json!({ "type": DOOM_ACTION_BACKWARD, "amount": DOOM_COMBAT_RETREAT_TICS })]
        );
        assert!(intent.actions.iter().all(|a| a["type"] != "shoot"));
        assert_eq!(policy.engagements, 0, "a disengage tick is not engaged");
    }

    #[test]
    fn combat_low_health_is_inert_for_unset_blank_and_invalid_overrides() {
        // No test sets a VALID override, so the effective threshold stays the
        // pinned default throughout (blank/invalid parse to None); these
        // mutations therefore never leak a non-default value to sibling tests.
        std::env::remove_var(DOOM_COMBAT_LOW_HEALTH_ENV);
        assert_eq!(combat_low_health(), DOOM_COMBAT_LOW_HEALTH);

        for raw in ["", "   ", "not-a-number", "25.5"] {
            std::env::set_var(DOOM_COMBAT_LOW_HEALTH_ENV, raw);
            assert_eq!(
                combat_low_health(),
                DOOM_COMBAT_LOW_HEALTH,
                "override {raw:?} must be inert"
            );
        }

        std::env::remove_var(DOOM_COMBAT_LOW_HEALTH_ENV);
    }

    // 5. no engageable target ⇒ inert; malformed/absent enemies ⇒ inert, no panic.
    #[test]
    fn no_engageable_target_is_inert() {
        let mut policy = DoomCombatPolicy::default();

        for enemies in [
            json!([]),
            json!([enemy("back", 100)]),
            json!([
                enemy("left", DOOM_COMBAT_ACQUIRE_RANGE + 1),
                enemy("right", DOOM_COMBAT_ACQUIRE_RANGE + 10),
            ]),
            json!([42, "garbage"]),
        ] {
            let obs = observation(enemies, 100);
            assert_eq!(combat_target(&obs), None);
            assert_eq!(combat_intent(&obs, &mut policy), None);
        }

        // Absent / malformed `enemies` (and a front entry missing `distance`).
        for obs in [
            json!({ "player": { "health": 100 } }),
            json!({ "player": { "health": 100 }, "enemies": "nonsense" }),
            json!({ "player": { "health": 100 }, "enemies": [42, { "direction": "front" }] }),
        ] {
            assert_eq!(combat_target(&obs), None);
            assert_eq!(combat_intent(&obs, &mut policy), None);
        }
    }

    // Deterministic selection: front beats sides; first-listed wins the tie.
    #[test]
    fn front_wins_over_a_side_bucket_and_first_listed_wins_ties() {
        let mut policy = DoomCombatPolicy::default();

        // A `front` entry listed second still wins over a `left` listed first.
        let obs = observation(json!([enemy("left", 100), enemy("front", 300)]), 100);
        let intent = combat_intent(&obs, &mut policy).expect("engaged");
        assert_eq!(intent.target, target("front", 300));
        assert_eq!(
            intent.actions,
            vec![json!({ "type": DOOM_ACTION_SHOOT, "amount": DOOM_COMBAT_FIRE_TICS })]
        );

        // No front ⇒ the first-listed in-range side wins the tie.
        let obs = observation(json!([enemy("right", 100), enemy("left", 100)]), 100);
        assert_eq!(combat_target(&obs), target("right", 100));
        assert_eq!(
            combat_intent(&obs, &mut policy).expect("engaged").actions,
            vec![json!({ "type": DOOM_ACTION_TURN_RIGHT, "amount": DOOM_COMBAT_TURN_AMOUNT })]
        );
    }

    #[test]
    fn the_policy_counts_engaged_ticks_and_resets() {
        let obs = observation(json!([enemy("front", 100)]), 100);
        let mut policy = DoomCombatPolicy::default();

        assert!(combat_intent(&obs, &mut policy).is_some());
        assert!(combat_intent(&obs, &mut policy).is_some());
        assert_eq!(policy.engagements, 2);

        policy.reset();
        assert_eq!(policy.engagements, 0);
    }
}
