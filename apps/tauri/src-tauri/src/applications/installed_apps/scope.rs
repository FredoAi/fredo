//! Spec #3146 — the data-scope chokepoint: ONE pure function that decides
//! whether an installed application may address a table, and the reason it may
//! not.
//!
//! # Why identity equality is not enough
//!
//! Application data is physically namespaced per application: the canonical
//! table name is `feature_<sanitized id>_<table>` with `-` → `_` in the id
//! ([`DynamicTableStore::canonical_table_name`], the ONE composer — this module
//! calls it rather than re-deriving it, because a second implementation would
//! drift and reopen the bypass). Ids may not contain `_`, but a TABLE name may,
//! so the composition is many-to-one:
//!
//! ```text
//! caller `mission`     + table `monitor_sessions` → feature_mission_monitor_sessions
//! built-in `mission-monitor` + table `sessions`   → feature_mission_monitor_sessions
//! ```
//!
//! `validate_namespace("mission", "monitor_sessions")` passes (its expected
//! prefix really is `feature_mission_`), so an installed application can reach
//! another application's rows **without naming that application at all**. The
//! third clause below closes that door: the canonical name must be unambiguous
//! against every other known id's namespace prefix and against every persisted
//! declaration owned by someone else.
//!
//! # Deny direction
//!
//! Every clause denies as a closed set: an ambiguous name is refused, never
//! resolved in the caller's favour. A stale id index can therefore only produce
//! a FALSE REFUSAL, never a false permit.

use crate::infrastructure::storage::application_store::DynamicTableStore;

/// What the resolver decided. `Deny` carries the caller-facing detail, which is
/// the SAME sentence for every cause so the refusal cannot be used to probe
/// which applications or tables exist (UI/UX §4's non-oracular clause).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeDecision {
    Allow,
    Deny(&'static str),
}

/// The one `scope_denied` sentence.
///
/// It names the ownership/declaration rule and says nothing about any other
/// application, table, id list or count. Deliberately identical for a foreign id,
/// an undeclared table, a composed-name collision and a canonical source: the
/// difference between "that table exists and is someone else's" and "that table
/// does not exist" is an installed-application enumeration oracle, which is
/// exactly the data AC-3 protects.
pub const SCOPE_DENIED_DETAIL: &str =
    "This application can only reach the data tables it declared for itself.";

/// Decide whether `caller_app_id` may address `table` for `requested_app_id`.
///
/// Three clauses, in order:
///
/// 1. **Ownership identity** — the requested application must BE the caller.
/// 2. **Declaration** — the caller's package must have declared that table.
/// 3. **Canonical-name unambiguity** — `canonical_table_name(caller, table)` must
///    not also be the namespace of any other known application id, and must not
///    equal the canonical name of a persisted declaration owned by someone else.
///
/// Pure and set-based: `known_app_ids` / `owned_tables` may arrive in any order
/// and with duplicates (the caller reads them from a directory listing and a
/// metadata table respectively), so the same inputs in any order give the same
/// verdict.
///
/// * `caller_app_id` — derived from the window label, never from the payload.
/// * `requested_app_id` — whatever the caller asked for (validated, not trusted).
/// * `declared_tables` — the tables the caller's package declared.
/// * `known_app_ids` — `RESERVED_APP_IDS` ∪ installed ids ∪ ids in
///   `feature_data_tables`.
/// * `owned_tables` — `Registry::persisted_tables()` as `(feature_id, table)`.
pub fn resolve_data_scope(
    caller_app_id: &str,
    requested_app_id: &str,
    table: &str,
    declared_tables: &[String],
    known_app_ids: &[String],
    owned_tables: &[(String, String)],
) -> ScopeDecision {
    // Clause 1 — an installed application may only address ITSELF.
    if requested_app_id != caller_app_id {
        return ScopeDecision::Deny(SCOPE_DENIED_DETAIL);
    }

    // Clause 2 — and only the tables its package declared.
    if !declared_tables.iter().any(|declared| declared == table) {
        return ScopeDecision::Deny(SCOPE_DENIED_DETAIL);
    }

    // Clause 3 — the canonical name must be unambiguous.
    let canonical = DynamicTableStore::canonical_table_name(caller_app_id, table);

    for other in known_app_ids {
        if other == caller_app_id {
            continue;
        }
        // `feature_<sanitized(other)>_` is a proper prefix of the canonical name
        // ⇒ this table composes INTO that application's physical namespace.
        let foreign_prefix = format!("feature_{}_", other.replace('-', "_"));
        if canonical.starts_with(&foreign_prefix) {
            return ScopeDecision::Deny(SCOPE_DENIED_DETAIL);
        }
    }

    for (owner, owned_table) in owned_tables {
        if owner == caller_app_id {
            continue;
        }
        // A persisted declaration owned by someone else that composes to the SAME
        // physical name. This clause needs no id index at all, so it still holds if
        // the index is stale relative to `feature_data_tables`.
        if DynamicTableStore::canonical_table_name(owner, owned_table) == canonical {
            return ScopeDecision::Deny(SCOPE_DENIED_DETAIL);
        }
    }

    ScopeDecision::Allow
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::installed_apps::manifest::RESERVED_APP_IDS;

    fn tables(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    fn owned(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(id, table)| ((*id).to_string(), (*table).to_string()))
            .collect()
    }

    /// A `known_app_ids` set that includes every reserved id, as the dispatcher
    /// builds it (RESERVED ∪ installed ids ∪ ids in feature_data_tables).
    fn reserved_plus(extra: &[&str]) -> Vec<String> {
        let mut known: Vec<String> = RESERVED_APP_IDS.iter().map(|id| (*id).to_string()).collect();
        known.extend(ids(extra));
        known
    }

    /// F-7.1 — the resolver is a pure, table-driven decision. Every case quotes
    /// its inputs and its verdict; (5)+(6) are the installed-vs-installed
    /// collision and its same-app discriminator, so neither "deny everything"
    /// nor "identity only" can pass.
    #[test]
    fn resolve_data_scope_cases() {
        // (1) POSITIVE CONTROL — own id, declared table, no other claimant ⇒ Allow.
        let known = ids(&["qa3146-app-a"]);
        assert_eq!(
            resolve_data_scope(
                "qa3146-app-a",
                "qa3146-app-a",
                "notes",
                &tables(&["notes"]),
                &known,
                &owned(&[]),
            ),
            ScopeDecision::Allow,
            "case 1: an over-broad deny would redden here"
        );

        // (2) ANOTHER APPLICATION'S ID ⇒ Deny.
        assert_eq!(
            resolve_data_scope(
                "qa3146-app-a",
                "qa3146-app-b",
                "records",
                &tables(&["notes"]),
                &ids(&["qa3146-app-a", "qa3146-app-b"]),
                &owned(&[]),
            ),
            ScopeDecision::Deny(SCOPE_DENIED_DETAIL),
            "case 2: naming another application must be refused"
        );

        // (3) UNDECLARED TABLE ⇒ Deny.
        assert_eq!(
            resolve_data_scope(
                "qa3146-app-a",
                "qa3146-app-a",
                "secrets",
                &tables(&["notes"]),
                &known,
                &owned(&[]),
            ),
            ScopeDecision::Deny(SCOPE_DENIED_DETAIL),
            "case 3: the declared-set clause"
        );

        // (4) THE NAMED COLLISION — caller `mission` + `monitor_sessions` composes
        // to `feature_mission_monitor_sessions`, byte-identical to built-in
        // `mission-monitor`'s `feature_mission_monitor_sessions`, and the caller
        // never names that application.
        assert_eq!(
            DynamicTableStore::canonical_table_name("mission", "monitor_sessions"),
            "feature_mission_monitor_sessions"
        );
        assert_eq!(
            DynamicTableStore::canonical_table_name("mission-monitor", "sessions"),
            "feature_mission_monitor_sessions"
        );
        assert_eq!(
            resolve_data_scope(
                "mission",
                "mission",
                "monitor_sessions",
                &tables(&["monitor_sessions"]),
                &reserved_plus(&["mission"]),
                &owned(&[]),
            ),
            ScopeDecision::Deny(SCOPE_DENIED_DETAIL),
            "case 4: the composed name must be refused even though the caller named only itself"
        );

        // (5) THE CONSTRUCTED COLLISION (installed vs installed):
        // `orbit` + `lab_notes` == `orbit-lab` + `notes`.
        let orbit_known = ids(&["orbit", "orbit-lab"]);
        assert_eq!(
            DynamicTableStore::canonical_table_name("orbit", "lab_notes"),
            DynamicTableStore::canonical_table_name("orbit-lab", "notes")
        );
        assert_eq!(
            resolve_data_scope(
                "orbit",
                "orbit",
                "lab_notes",
                &tables(&["lab_notes", "orbit_own"]),
                &orbit_known,
                &owned(&[]),
            ),
            ScopeDecision::Deny(SCOPE_DENIED_DETAIL),
            "case 5: an installed-vs-installed collision is a Deny"
        );

        // (6) THE DISCRIMINATOR — same caller, same known set, a table that does
        // not collide ⇒ Allow.
        assert_eq!(
            resolve_data_scope(
                "orbit",
                "orbit",
                "orbit_own",
                &tables(&["lab_notes", "orbit_own"]),
                &orbit_known,
                &owned(&[]),
            ),
            ScopeDecision::Allow,
            "case 6: the same-app allow that (5) alone cannot distinguish"
        );

        // (7) OWNED-TABLE CROSS-OWNER COMPOSITION, with the id list NOT naming the
        // other application: only `feature_data_tables` reveals the collision.
        assert_eq!(
            resolve_data_scope(
                "orbit",
                "orbit",
                "lab_notes",
                &tables(&["lab_notes", "orbit_own"]),
                &ids(&["orbit"]),
                &owned(&[("orbit-lab", "notes")]),
            ),
            ScopeDecision::Deny(SCOPE_DENIED_DETAIL),
            "case 7: a non-owning feature_data_tables row is enough to deny"
        );

        // (7b) ... and the SAME owned row for the CALLER is not a collision.
        assert_eq!(
            resolve_data_scope(
                "orbit",
                "orbit",
                "orbit_own",
                &tables(&["lab_notes", "orbit_own"]),
                &ids(&["orbit"]),
                &owned(&[("orbit", "orbit_own")]),
            ),
            ScopeDecision::Allow,
            "case 7b: the caller's own persisted declaration is not a foreign claim"
        );

        // (8) ORDER INDEPENDENCE — every input slice reversed gives the SAME
        // verdict, because the resolver treats them as sets.
        let mut known_rev = orbit_known.clone();
        known_rev.reverse();
        let mut declared_rev = tables(&["lab_notes", "orbit_own"]);
        declared_rev.reverse();
        let mut owned_rev = owned(&[("orbit-lab", "notes"), ("orbit", "orbit_own")]);
        owned_rev.reverse();
        assert_eq!(
            resolve_data_scope(
                "orbit",
                "orbit",
                "lab_notes",
                &declared_rev,
                &known_rev,
                &owned_rev,
            ),
            ScopeDecision::Deny(SCOPE_DENIED_DETAIL),
            "case 8: reversing every slice must not change the verdict"
        );
        assert_eq!(
            resolve_data_scope(
                "orbit",
                "orbit",
                "orbit_own",
                &declared_rev,
                &known_rev,
                &owned_rev,
            ),
            ScopeDecision::Allow,
            "case 8: ... in either direction"
        );

        // A caller whose own sanitized name merely EXTENDS another known id is
        // shadowed (fail-safe, recorded as a product note in F-7.12).
        assert_eq!(
            resolve_data_scope(
                "orbit-lab",
                "orbit-lab",
                "notes",
                &tables(&["notes"]),
                &orbit_known,
                &owned(&[]),
            ),
            ScopeDecision::Deny(SCOPE_DENIED_DETAIL),
            "an id extending another known id is shadowed on every table"
        );

        // Duplicate entries in the id list change nothing (set semantics).
        let mut duplicated = orbit_known.clone();
        duplicated.extend(orbit_known.iter().cloned());
        assert_eq!(
            resolve_data_scope(
                "orbit",
                "orbit",
                "orbit_own",
                &tables(&["orbit_own"]),
                &duplicated,
                &owned(&[]),
            ),
            ScopeDecision::Allow,
            "duplicate known ids are not a collision with the caller"
        );
    }

    /// The one `scope_denied` sentence names no other application and mentions no
    /// table, id enumeration or count (the non-oracular clause, mechanically).
    #[test]
    fn the_scope_denied_detail_is_non_oracular() {
        for banned in ["mission", "records", "feature_", "owned by", "belongs to"] {
            assert!(
                !SCOPE_DENIED_DETAIL.contains(banned),
                "the scope detail must not contain {banned:?}"
            );
        }
        assert!(!SCOPE_DENIED_DETAIL.is_empty(), "a detail is always present");
    }
}
