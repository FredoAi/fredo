# RETIRED — the Rust companion command-surface path (spec #3152)

Spec #3152 (slice 2 of the NavigationEngine removal) deletes the Rust companion
command-surface path so the model's offer on a turn is the three shipped static
skills (`open_app`, `close_app`, `doom_mode`) and nothing generated.

Every deleted path is listed below with its reason. **A path that is gone but
unlisted is a defect; a listed path that still exists is a defect.** The counts
were recounted against the pre-change source, not copied from the plan.

Verified by `.opencode/scripts/check-companion-commands-retired.ps1` (two scanned
roots: `apps/tauri/src-tauri`, `apps/ui/src`; a one-entry evidence allowlist —
this folder).

## Deleted modules

| Path | Issue | Reason |
|---|---|---|
| `apps/tauri/src-tauri/src/infrastructure/companion/surface_registry.rs` | #3152 | The published application command-surface registry and the generated per-surface skill offer. Its only consumers were the two IPC commands below and the generated-skill tests; the frontend half of the command path was removed in #3151, leaving zero live callers. |
| `apps/tauri/src-tauri/src/infrastructure/app_command.rs` | #3152 | The generic application command intent relay (`app_command_intent` / `_take` / `_result`, the `app-command-intent` / `app-command-intent-result` event pair, and its four wire types). Zero TS consumers and zero Rust callers: its only purpose was dispatching the *generated* skills this slice removes. Classified DELETE, not kept. |

## Deleted test targets

| Path | Issue | Reason |
|---|---|---|
| `apps/tauri/src-tauri/tests/companion_manifest.rs` | #3152 | 578 lines, **9 test functions**; its subject was the published-surface registry and the generated offer. Deleted whole. ONE assertion was relocated verbatim (see "Relocated" below); the remaining **8** are gone with their subject. |

## Test functions (36 retired: 35 deleted outright, 1 relocated)

### `surface_registry.rs` — 17 deleted

| Test | Reason |
|---|---|
| `publishing_upserts_in_place_and_leaves_other_apps_untouched` | Subject (the upserting registry) deleted. |
| `an_empty_publish_is_a_no_op_never_a_clear` | Subject deleted. |
| `a_skill_name_that_is_not_the_app_id_is_rejected` | Publish-validation rule; no publish exists. |
| `every_reserved_skill_name_is_rejected` | Reserved-name rule guarded the generated offer. |
| `a_duplicate_app_id_within_one_publish_is_rejected` | Publish-validation rule. |
| `duplicate_command_ids_within_one_surface_are_rejected` | Publish-validation rule. |
| `every_blank_identity_or_description_is_rejected` | Publish-validation rule. |
| `the_surface_bound_is_enforced_atomically` | `APP_COMMAND_SURFACE_MAX_SURFACES` deleted with its bound. |
| `the_command_bound_is_enforced_atomically` | `APP_COMMAND_SURFACE_MAX_COMMANDS` deleted with its bound. |
| `a_zero_command_surface_generates_no_skill` | Generated-skill rule. |
| `the_generated_skill_declares_every_id_then_list_actions` | Subject (`surface_skill` / the generated action enum) deleted. |
| `a_removed_id_disappears_from_the_next_offer_after_a_same_app_republish` | Generated-offer rule. |
| `a_navigation_command_serializes_risk_and_aliases_and_round_trips` | Wire shape of the deleted `CompanionCommandManifest`. |
| `a_navigation_command_with_no_aliases_omits_the_key_never_null` | Wire shape of a deleted struct. |
| `a_legacy_command_omits_risk_and_aliases` | Wire shape of a deleted struct. |
| `both_wire_shapes_deserialize_and_publish_through_the_registry` | Wire shapes + registry, both deleted. |
| `surface_registry_is_transport_only_and_cannot_diverge` | The divergence proof for a module that no longer exists. |

### `app_command.rs` — 8 deleted

| Test | Reason |
|---|---|
| `the_relay_binding_names_are_pinned` | The event-name constants were deleted with the relay. |
| `the_queue_is_fifo_and_take_drains_it` | The relay queue was deleted. |
| `the_queue_is_bounded_and_evicts_the_oldest_intent` | The relay queue was deleted. |
| `take_filters_by_app_and_keeps_the_untouched_remainder_in_order` | The relay queue was deleted. |
| `the_intent_payload_is_camel_case_and_keeps_the_arguments` | Wire shape of a deleted struct. |
| `the_result_payload_is_camel_case_and_omits_an_absent_detail` | Wire shape of a deleted struct. |
| `the_outcome_round_trips_through_its_pascal_case_names` | Deleted enum `AppCommandOutcome`. |
| `intent_requests_are_validated_fail_closed` | Validator for a deleted command. |

### `tests/companion_manifest.rs` — 8 deleted, 1 relocated

| Test | Reason |
|---|---|
| `the_rendered_offer_carries_the_published_manifest_projection` | Its subject was the generated per-surface projection. |
| `the_published_wire_omits_absent_optionals_instead_of_emitting_null` | Wire shape of four deleted structs. |
| `a_published_manifest_reads_back_exactly_and_an_empty_publish_is_a_no_op` | The publish/read contract. |
| `an_upsert_replaces_in_place_and_leaves_other_apps_untouched` | The upserting registry. |
| `the_rejection_matrix_leaves_the_registry_untouched` | Publish-validation matrix. |
| `the_registry_bounds_are_enforced_atomically` | The deleted bounds. |
| `a_zero_command_surface_generates_no_skill_but_stays_published` | Generated-skill rule. |
| `a_removed_id_disappears_from_the_next_offer_after_a_same_app_republish` | Generated-offer rule. |
| `static_skills_are_byte_identical_to_the_pre_change_baseline` | **RELOCATED verbatim** (literals unchanged) into `tests/companion_offer_static_only.rs` — the "no drift on the three static skills" invariant survives the deletion. |

### `src/infrastructure/companion/skills.rs` — 2 deleted

| Test | Reason |
|---|---|
| `the_generated_registry_keeps_the_static_three_first_then_one_skill_per_surface` | Subject was the generated skill per published surface. |
| `a_generated_skill_validates_the_declared_action_and_fails_closed_otherwise` | Subject was validating a generated skill's `action`. |

**Note:** the surviving order/declaration coverage for the three static skills
already existed independently at `skills.rs`
`with_app_control_and_doom_registers_open_app_close_app_doom_mode_in_order` and
is untouched.

## Replaced test (1)

| Path | Test | Issue | Reason |
|---|---|---|---|
| `apps/tauri/src-tauri/src/applications/llm_server/status.rs` | `the_live_offer_carries_the_generated_wireframe_skill_with_its_projected_description` | #3152 | Replaced by `the_turn_offer_is_exactly_the_three_static_skills`, the AC2 pin: it calls the turn path's own accessor `companion_skill_registry()` and asserts exactly `["open_app", "close_app", "doom_mode"]` in order, `len() == 3`, no application-named skill, plus the R-2b structural leg (no parameters, no `AppHandle`, no `try_state` / `state::<` / `surfaces`). |

## Re-pointed test (1, title kept verbatim)

| Path | Test | Issue | Reason |
|---|---|---|---|
| `apps/tauri/src-tauri/tests/voice_invariants.rs` | `the_model_audio_path_obtains_its_offer_from_the_one_shared_registry` | #3152 | Re-pointed in place — the TITLE is unchanged because it is the durable index. Its `surface_registry.rs`-as-text subject and its deleted-builder assertions are replaced by the post-change facts: the accessor takes no `AppHandle`, reads no managed state and consults no surfaces, and it IS the one `SkillRegistry::with_app_control_and_doom()` construction site. The `allowed` path list no longer names the deleted registry file. |

## Deleted registrations (same landing — the tree must always compile)

| Path | Issue | Reason |
|---|---|---|
| `apps/tauri/src-tauri/src/lib.rs` — `AppCommandSurfaceRegistry` managed state + 5 handler entries | #3152 | Both commands and the relay state were deleted. `render_companion_tools` (`pub use … render_tools`) is KEPT and re-commented: the new integration target consumes it. |
| `apps/tauri/src-tauri/src/infrastructure/companion/mod.rs` — `pub mod surface_registry;` | #3152 | Module deleted. |
| `apps/tauri/src-tauri/src/infrastructure/mod.rs` — `pub mod app_command;` | #3152 | Module deleted. |
| `apps/tauri/src-tauri/src/runtime/command_manifest.rs` — 5 `COMMAND_MANIFEST` entries | #3152 | A stale entry makes `build.rs` autogenerate a permission no command backs. |
| `apps/tauri/src-tauri/permissions/app/default.toml` — 5 `allow-*` grants | #3152 | Must move in the same commit as the manifest entries or `AppManifest` permission generation breaks. |

## Copy + comments corrected (not paths — recorded for the audit trail)

| Path | Issue | Reason |
|---|---|---|
| `apps/ui/src/applications/wireframe/components/WireframeCanvasImpl.tsx` (`EMPTY_HINT`) | #3152 | The hint named a generated Companion draft command that no longer exists. Now: `Add an element from Insert to start your wireframe.` |
| `apps/ui/src/applications/wireframe/__tests__/WireframeCanvas.test.tsx` | #3152 | The asserted literal moved in the same commit as the source string. |
| `apps/tauri/src-tauri/src/lib.rs:58` (re-export comment) | #3152 | The comment named the deleted `tests/companion_manifest.rs`. |
| `apps/tauri/src-tauri/src/applications/wireframe/mod.rs` (module doc) | #3152 | Claimed a live companion intent relay in `infrastructure::app_command`. |
| `apps/ui/src/applications/wireframe/actions/wireframeActions.ts` (module doc) | #3152 | Claimed the Companion lists the action descriptions. |

## Not this slice (deferred to #3153)

Product documentation (`docs/ARCHITECTURE.md`, `docs/NAVIGATION_ENGINE.md`, the
ADRs, `ENGINEERING_RULES.md`, `FAQ.md`) still narrates the retired mechanism.
Documentation is out of scope for #3152 and is owned by #3153.

*Authored by Developer*
