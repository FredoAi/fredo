//! Deterministic opportunistic-looting policy (Spec #3054 ST-3).
//!
//! The **loot layer** gives the Doom Companion an opportunistic reflex: when a
//! reachable pickup (`MobjFlag::Special`) sits within the bounded observation's
//! `items[]` list and within [`DOOM_LOOT_ACQUIRE_RANGE`], the companion steers
//! toward it (a bounded `turn-to` bearing toward the pickup's coarse bucket plus
//! a bounded `forward` hold) so it walks over the pickup and collects it, then
//! resumes its route. It is a **pure function of the observation + the persisted
//! [`DoomLootPolicy`]** — no RNG, no wall clock, no I/O — mirroring the purity
//! contract of [`super::combat`] and [`super::plan`] (NFR-DET / AC5).
//!
//! # Vocabulary
//!
//! The observation's `items[]` entries are `{"kind", "direction", "distance"}`
//! where `direction` is a coarse bearing bucket (`front`/`left`/`right`/`back`)
//! produced by the engine's `relative_direction` rule. This layer consumes that
//! vocabulary **as-is** — it never changes the perception contract.
//!
//! # Opportunism + boundedness (R-1 / R-4 / AC1 / AC4)
//!
//! Looting is **opportunistic**: it never abandons the route to the exit. Every
//! seek is bounded by [`DOOM_LOOT_SEEK_WINDOW_TICKS`]; when the window is
//! exhausted without collecting the item, the item set's [`loot_signature`] is
//! recorded as `blocked_signature` and the route resumes. The SAME item set is
//! not re-chased while it is blocked; a set that changes (a pickup collected, a
//! new pickup appearing) releases the block for a fresh bounded seek. This
//! prevents route/pickup thrash (AC4).
//!
//! # Precedence (R-4 / AC4)
//!
//! The continuous loop composes loot AFTER the #3031 escape window and the
//! #3053 combat layer, and only when it is neither escaping nor engaging a
//! target — so `escape > combat > loot > base route`. This module is
//! self-contained; it holds no reference to the escape or combat policies.
//!
//! # Test-only induction seam (G-275/G-300)
//!
//! The decision layer is driven live through the existing
//! `FREDO_DOOM_INJECT_OBSERVATION` lever (it only reads the observation), so no
//! new env seam is introduced here.

use serde_json::{json, Value};

use super::actions::{DOOM_ACTION_FORWARD, DOOM_ACTION_TURN_TO};

// ── Pinned constants (Architect-owned, G-255) ────────────────────────────────

/// A pickup is "reachable" (in the acquire range) at or below this distance, in
/// map units (AC1). An item beyond it is never chased.
pub const DOOM_LOOT_ACQUIRE_RANGE: i64 = 512;

/// The bounded seek window, in ticks (AC4): after this many consecutive seek
/// ticks the current item set is recorded blocked and the route resumes — so a
/// pickup the companion cannot walk over cannot cause route thrash.
pub const DOOM_LOOT_SEEK_WINDOW_TICKS: u32 = 24;

/// The per-tick bounded `forward` hold (in tics) appended with the loot bearing
/// (AC5 — every emitted action stays bounded).
pub const DOOM_LOOT_FORWARD_AMOUNT: i64 = 10;

// ── FNV-1a (deterministic signature, no randomly-seeded hasher) ──────────────

/// The FNV-1a 64-bit offset basis.
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
/// The FNV-1a 64-bit prime.
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Fold one byte into an FNV-1a hash.
fn fnv_step(hash: u64, byte: u8) -> u64 {
    (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
}

// ── Target / intent models ───────────────────────────────────────────────────

/// The selected loot target: the pickup's wire `kind`, its coarse `direction`
/// bucket (`front`/`left`/`right`/`back`), and its observed `distance`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LootTarget {
    /// The pickup's friendly kind (e.g. `stimpack`, `shotgun`).
    pub kind: String,
    /// The pickup's direction bucket — one of `front`, `left`, `right`, `back`.
    pub direction: &'static str,
    /// The pickup's observed distance, in map units.
    pub distance: i64,
}

/// The pure loot intent for one tick: the selected target and the bounded action
/// list (`turn-to` + `forward`) to compose through the retained pipeline.
#[derive(Clone, Debug, PartialEq)]
pub struct LootIntent {
    /// The selected target.
    pub target: LootTarget,
    /// The bounded per-tick actions (a `turn-to` bearing + a `forward` hold).
    pub actions: Vec<Value>,
}

/// The persisted, per-run loot-policy state (mirrors
/// [`super::combat::DoomCombatPolicy`]): pure data the intent updates once per
/// tick. No RNG, no clock.
///
/// `seek_ticks` counts the consecutive ticks of the ACTIVE seek; `blocked_signature`
/// is the [`loot_signature`] of an item set the companion gave up on after the
/// bounded window. Reset on a level transition via [`DoomLootPolicy::reset`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DoomLootPolicy {
    /// Consecutive seek ticks in the active window.
    pub seek_ticks: u32,
    /// The item-set signature the companion stopped chasing, if any.
    pub blocked_signature: Option<u64>,
}

impl DoomLootPolicy {
    /// Reset the per-run state for a level transition: a new level means a new
    /// item set with a fresh id namespace, so any active seek and any recorded
    /// block are cleared.
    pub fn reset(&mut self) {
        self.seek_ticks = 0;
        self.blocked_signature = None;
    }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/// The deterministic, POSITION-INVARIANT signature of the observation's
/// `items[]` set (AC4): FNV-1a over the sorted multiset of item **kinds**.
///
/// The item set the companion is skipping must be identified independently of
/// where the player stands: the observation's `items[]` carries no entity id, and
/// its `distance`/`direction` change on every tic the player moves or turns, so a
/// distance-bearing signature would change every tick and release the block
/// continuously — re-chasing an unreachable pickup forever and thrashing the route
/// (violating AC4 and the #3039 route-completion invariant). The kind multiset
/// changes exactly when a pickup is COLLECTED/added (the engine's `world.remove`
/// drops the mobj from the world order the `items[]` list is drawn from), which is
/// the event the plan's block is meant to key on.
///
/// The signature is deterministic (no RNG, no hash-seed variance); two item sets
/// with the same kinds (any order, any distances) hash identically, and a
/// collected/added pickup changes it. Entries are bounded by the caller's
/// observation (`items[]` is already capped at `OBSERVATION_MAX_ENTRIES`).
pub fn loot_signature(observation: &Value) -> u64 {
    let mut kinds: Vec<&str> = observation
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("kind").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    kinds.sort_unstable();

    let mut hash = FNV_OFFSET_BASIS;
    for kind in kinds {
        for byte in kind.as_bytes() {
            hash = fnv_step(hash, *byte);
        }
        // A 0x00 separator keeps `["ab"]` distinct from `["a","b"]` shapes.
        hash = fnv_step(hash, 0);
    }
    hash
}

/// The absolute map heading (0-359) for a direction bucket and the current
/// facing — the corrected #3031 mapping (see
/// [`super::agent::escape_heading`]), extended with the `back` bucket:
///
/// * `front` → `current_angle`
/// * `left`  → `(current_angle + 90).rem_euclid(360)`
/// * `right` → `(current_angle + 270).rem_euclid(360)`
/// * `back`  → `(current_angle + 180).rem_euclid(360)`
///
/// An unknown bucket maps to `front` (`current_angle`). Pure.
pub fn loot_heading(direction: &str, current_angle: i64) -> i64 {
    let delta = match direction {
        "left" => 90,
        "right" => 270,
        "back" => 180,
        _ => 0,
    };
    (current_angle + delta).rem_euclid(360)
}

/// Select the loot target from the observation's `items[]`, or `None` when there
/// is nothing to chase.
///
/// Deterministic selection: the FIRST-listed `items[]` entry with
/// `distance <= DOOM_LOOT_ACQUIRE_RANGE` wins (no nearest-distance sort, no RNG).
/// A malformed entry (missing/non-numeric `distance`, or an unknown `direction`
/// bucket) is skipped; an absent/non-array `items` key yields `None`. When the
/// current [`loot_signature`] equals the recorded `blocked_signature`, the target
/// is suppressed entirely (the item set is being skipped until it changes) — AC4.
pub fn loot_target(observation: &Value, policy: &DoomLootPolicy) -> Option<LootTarget> {
    if policy.blocked_signature == Some(loot_signature(observation)) {
        return None;
    }
    let items = observation.get("items").and_then(Value::as_array)?;
    for item in items {
        let direction = match item.get("direction").and_then(Value::as_str) {
            Some("front") => "front",
            Some("left") => "left",
            Some("right") => "right",
            Some("back") => "back",
            _ => continue,
        };
        let distance = match item.get("distance").and_then(Value::as_i64) {
            Some(distance) => distance,
            None => continue,
        };
        if distance <= DOOM_LOOT_ACQUIRE_RANGE {
            return Some(LootTarget {
                kind: item
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                direction,
                distance,
            });
        }
    }
    None
}

/// Compute the bounded loot intent for one tick, or `None` when the companion
/// should keep to its route (R-4 — the retained pipeline drives; AC1/AC4/AC5).
///
/// Behaviour (pure + bounded, no RNG/clock/I-O):
/// * a recorded `blocked_signature` that no longer matches the current item set
///   is released and the seek counter restarts;
/// * with a target, `seek_ticks` increments once; on reaching
///   [`DOOM_LOOT_SEEK_WINDOW_TICKS`] the current set is recorded blocked and the
///   tick yields (`None`) so the route resumes;
/// * otherwise it emits exactly `[{turn-to heading}, {forward amount}]` — a
///   bounded steer toward the pickup.
pub fn loot_intent(observation: &Value, policy: &mut DoomLootPolicy) -> Option<LootIntent> {
    // Release a stale block when the item set has changed (a pickup was
    // collected/added) so a fresh bounded seek is allowed.
    if let Some(blocked) = policy.blocked_signature {
        if blocked != loot_signature(observation) {
            policy.blocked_signature = None;
            policy.seek_ticks = 0;
        }
    }

    let target = loot_target(observation, policy)?;

    policy.seek_ticks = policy.seek_ticks.saturating_add(1);
    if policy.seek_ticks >= DOOM_LOOT_SEEK_WINDOW_TICKS {
        // The bounded window is exhausted without collecting: stop chasing this
        // item set and resume the route.
        policy.blocked_signature = Some(loot_signature(observation));
        policy.seek_ticks = 0;
        return None;
    }

    let current_angle = observation
        .pointer("/player/angle")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let heading = loot_heading(target.direction, current_angle);
    let actions = vec![
        json!({ "type": DOOM_ACTION_TURN_TO, "angle": heading }),
        json!({ "type": DOOM_ACTION_FORWARD, "amount": DOOM_LOOT_FORWARD_AMOUNT }),
    ];
    Some(LootIntent { target, actions })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An `items[]` entry with the observation's exact shape.
    fn item(kind: &str, direction: &str, distance: i64) -> Value {
        json!({ "kind": kind, "direction": direction, "distance": distance })
    }

    /// A synthetic observation: `items[]` + the player's `angle`.
    fn observation(items: Value, angle: i64) -> Value {
        json!({
            "player": { "angle": angle },
            "items": items,
        })
    }

    fn target(kind: &str, direction: &'static str, distance: i64) -> LootTarget {
        LootTarget {
            kind: kind.to_string(),
            direction,
            distance,
        }
    }

    #[test]
    fn the_loot_constants_are_pinned() {
        assert_eq!(DOOM_LOOT_ACQUIRE_RANGE, 512);
        assert_eq!(DOOM_LOOT_SEEK_WINDOW_TICKS, 24);
        assert_eq!(DOOM_LOOT_FORWARD_AMOUNT, 10);
    }

    // 1. An in-range pickup yields a deterministic target + bounded steer (F-1).
    #[test]
    fn an_in_range_pickup_yields_a_target_and_a_bounded_steer() {
        let obs = observation(json!([item("health", "front", 100)]), 0);
        let policy = DoomLootPolicy::default();
        assert_eq!(
            loot_target(&obs, &policy),
            Some(target("health", "front", 100))
        );

        let mut policy = DoomLootPolicy::default();
        let intent = loot_intent(&obs, &mut policy).expect("loot intent");
        assert_eq!(intent.target, target("health", "front", 100));
        assert_eq!(
            intent.actions,
            vec![
                json!({ "type": DOOM_ACTION_TURN_TO, "angle": 0 }),
                json!({ "type": DOOM_ACTION_FORWARD, "amount": DOOM_LOOT_FORWARD_AMOUNT }),
            ],
            "exactly one bounded turn-to + forward"
        );
        assert_eq!(policy.seek_ticks, 1);
    }

    // 1b. The acquire bound is inclusive (512) and never chased beyond (513).
    #[test]
    fn the_acquire_bound_is_inclusive_and_not_chased_beyond() {
        let mut policy = DoomLootPolicy::default();
        let at_bound = observation(json!([item("health", "left", DOOM_LOOT_ACQUIRE_RANGE)]), 0);
        assert_eq!(
            loot_target(&at_bound, &policy),
            Some(target("health", "left", DOOM_LOOT_ACQUIRE_RANGE))
        );
        assert!(loot_intent(&at_bound, &mut policy).is_some());

        let beyond = observation(json!([item("health", "left", DOOM_LOOT_ACQUIRE_RANGE + 1)]), 0);
        assert_eq!(loot_target(&beyond, &policy), None);
        assert_eq!(loot_intent(&beyond, &mut policy), None);
    }

    // 1c. Empty/absent/non-array items and malformed entries are inert, no panic.
    #[test]
    fn no_chaseable_item_is_inert() {
        let mut policy = DoomLootPolicy::default();
        for items in [
            json!([]),
            json!([item("health", "left", DOOM_LOOT_ACQUIRE_RANGE + 1)]),
            json!([42, "garbage"]),
            json!([{ "kind": "health", "distance": 10 }]),  // no direction
            json!([{ "kind": "health", "direction": "sideways", "distance": 10 }]), // bad bucket
            json!([{ "kind": "health", "direction": "front" }]), // no distance
        ] {
            let obs = observation(items, 0);
            assert_eq!(loot_target(&obs, &policy), None);
            assert_eq!(loot_intent(&obs, &mut policy), None);
        }
        for obs in [
            json!({ "player": { "angle": 0 } }),
            json!({ "player": { "angle": 0 }, "items": "nonsense" }),
        ] {
            assert_eq!(loot_target(&obs, &policy), None);
            assert_eq!(loot_intent(&obs, &mut policy), None);
        }
    }

    // 1d. Two in-range entries → first-listed wins.
    #[test]
    fn the_first_listed_in_range_entry_wins() {
        let obs = observation(
            json!([item("health", "left", 100), item("shotgun", "front", 200)]),
            0,
        );
        let policy = DoomLootPolicy::default();
        assert_eq!(
            loot_target(&obs, &policy),
            Some(target("health", "left", 100))
        );
    }

    // 1e. loot_heading maps the four buckets and agrees with the #3031 mapping.
    #[test]
    fn loot_heading_maps_the_four_buckets() {
        assert_eq!(loot_heading("front", 40), 40);
        assert_eq!(loot_heading("left", 0), 90);
        assert_eq!(loot_heading("right", 0), 270);
        assert_eq!(loot_heading("back", 0), 180);
        // Wraps into 0-359 for an arbitrary facing.
        assert_eq!(loot_heading("right", 300), 210);
        assert_eq!(loot_heading("left", 300), 30);
        // Agrees with the retained #3031 mapping for the three shared buckets.
        for angle in [0, 40, 90, 179, 270, 359] {
            for bucket in ["front", "left", "right"] {
                assert_eq!(
                    loot_heading(bucket, angle),
                    crate::applications::doom::agent::escape_heading(bucket, angle),
                    "{bucket} at {angle}"
                );
            }
        }
    }

    // 2. The seek window bounds the chase; the item set is then blocked (F-8).
    #[test]
    fn the_seek_window_is_bounded_and_blocks_the_same_item_set() {
        let obs = observation(json!([item("health", "front", 100)]), 0);
        let mut policy = DoomLootPolicy::default();

        // The window yields for `DOOM_LOOT_SEEK_WINDOW_TICKS - 1` ticks, then the
        // window-exhaustion tick returns None.
        let mut emitted = 0;
        for _ in 0..DOOM_LOOT_SEEK_WINDOW_TICKS - 1 {
            assert!(loot_intent(&obs, &mut policy).is_some());
            emitted += 1;
        }
        assert_eq!(emitted, DOOM_LOOT_SEEK_WINDOW_TICKS - 1);
        assert_eq!(
            loot_intent(&obs, &mut policy),
            None,
            "the window is exhausted and the route resumes"
        );
        assert_eq!(
            policy.blocked_signature,
            Some(loot_signature(&obs)),
            "the item set is recorded blocked"
        );

        // The SAME item set (same signature) is never re-chased while blocked.
        for _ in 0..5 {
            assert_eq!(loot_intent(&obs, &mut policy), None);
            assert_eq!(loot_target(&obs, &policy), None);
        }
    }

    // 2b. A changed item set releases the block (F-8).
    #[test]
    fn a_changed_item_set_releases_the_block() {
        let obs = observation(json!([item("health", "front", 100)]), 0);
        let mut policy = DoomLootPolicy::default();
        for _ in 0..DOOM_LOOT_SEEK_WINDOW_TICKS {
            let _ = loot_intent(&obs, &mut policy);
        }
        assert!(policy.blocked_signature.is_some());
        assert!(loot_intent(&obs, &mut policy).is_none(), "still blocked");

        // The item set changed (a pickup was collected / a new one appeared).
        let changed = observation(json!([item("shotgun", "right", 200)]), 0);
        let intent = loot_intent(&changed, &mut policy).expect("released");
        assert_eq!(intent.target, target("shotgun", "right", 200));
        assert!(policy.blocked_signature.is_none(), "the block is released");
    }

    // 3. The signature is deterministic, order-independent, and position-invariant
    //    (F-11): the item SET identity is the kind multiset, so a moving player
    //    (changing distances/directions) does not churn it — only a collected or
    //    added pickup does.
    #[test]
    fn the_signature_is_deterministic_and_position_invariant() {
        let a = observation(
            json!([item("health", "front", 100), item("shotgun", "left", 50)]),
            0,
        );
        // Same kinds, different order / direction / distance ⇒ SAME signature
        // (position-invariant — a moving player must not release the block).
        let same_kinds = observation(
            json!([item("shotgun", "right", 777), item("health", "back", 12)]),
            180,
        );
        assert_eq!(loot_signature(&a), loot_signature(&same_kinds));
        assert_eq!(loot_signature(&a), loot_signature(&a), "stable");

        // A different kind multiset ⇒ different signature.
        let different = observation(json!([item("health", "front", 100)]), 0);
        assert_ne!(loot_signature(&a), loot_signature(&different));

        // Collecting one of a repeated kind changes the multiset ⇒ different.
        let two = observation(
            json!([item("health", "front", 100), item("health", "left", 100)]),
            0,
        );
        let one = observation(json!([item("health", "front", 100)]), 0);
        assert_ne!(loot_signature(&two), loot_signature(&one));

        // A malformed entry (no kind) is skipped, not panicking.
        let malformed = observation(json!([item("health", "front", 100), 42]), 0);
        assert_ne!(loot_signature(&malformed), 0);
    }

    // 4. Two identical invocations are byte-identical (F-11).
    #[test]
    fn loot_intent_is_byte_identical_for_identical_inputs() {
        let obs = observation(json!([item("health", "left", 100)]), 90);
        let mut first_policy = DoomLootPolicy::default();
        let mut second_policy = DoomLootPolicy::default();
        first_policy.seek_ticks = 3;
        second_policy.seek_ticks = 3;
        assert_eq!(
            loot_intent(&obs, &mut first_policy),
            loot_intent(&obs, &mut second_policy)
        );
    }

    #[test]
    fn the_policy_reset_clears_both_fields() {
        let mut policy = DoomLootPolicy {
            seek_ticks: 7,
            blocked_signature: Some(42),
        };
        policy.reset();
        assert_eq!(policy, DoomLootPolicy::default());
    }
}
