# companion-command-removal — Regression

The "must not change" baseline for Issue #3152 (slice 2 of 3 of the NavigationEngine removal
programme). Every row here is a **regression invariant** from the plan's non-goals
(`## QA Expert` in `.opencode/tmp/3152/triage.md`, and ST-1's *Non-goals / regression invariants*).

Run these whenever a later spec touches the companion offer, the skill channel, or the application
open/close path. Verification policy: **MIXED** — rows are tagged `static` or `live`.

> **Scope note.** These rows protect behaviour that S2 must LEAVE ALONE. A row that fails here is a
> regression introduced by the removal, not a missing feature. Some rows overlap
> `functional.md` deliberately (a functional pin doubles as a regression pin) — that is intended
> for a removal spec, whose whole purpose is "nothing else moved".

## The three static skills are untouched

- [ ] **R-1 (static).** `SkillRegistry` (`skills.rs:138-227`), `CompanionSkill` (`:103-118`),
  `validate` (`:283-354`) and the three static declarations (`open_app` `:23-41`, `close_app`
  `:45-64`, `doom_mode` `:68-96`) are unchanged. The offer order is still `open_app`, `close_app`,
  `doom_mode` (`with_app_control_and_doom`, `:183-191`).
  **Expected:** the three names, descriptions, parameters and order are byte-identical to the
  pre-change baseline (`functional.md` Q-10). Corroborating durable pin:
  `skills.rs:441-460` (`with_app_control_and_doom_registers_open_app_close_app_doom_mode_in_order`).
  **Edge:** a reworded description is a regression, even if the tool still works.

- [ ] **R-2 (static).** `render_tools` (`skills.rs:52-67`) and `skill_turn` (`:75-93`) are
  unchanged: `{type:"function", function:{name, description, parameters}}` per skill, wire shape
  identical.
  **Edge:** a new key in the wire shape is a regression. The `render_companion_tools` re-export
  (`lib.rs:58-64`) must survive.

## The event / skill channel contract is unchanged

- [ ] **R-3 (static + live).** `llm-skill-call`, `llm-token`, `llm-done`, `llm-error` keep their
  producers and consumers. **Static:** `useAppOpenRequests.ts:272-277` and
  `useDoomModeSkill.ts:100` still subscribe to `llm-skill-call`; `TauriAdapter.ts` still binds the
  optional skill channel before the invoke (`:119-174`). **Live:** one turn still emits exactly one
  `llm-done` per settled generation (`functional.md` Q-11, Q-14).
  **Edge:** a double `llm-done` (`TauriAdapter.ts:68-69`, `:139-140` guards it) is a regression.
  A channel renamed is a regression.

## The application open/close execution paths are unchanged

- [ ] **R-4 (static + live).** `open_app` still executes through `llm-skill-call` →
  `run_open_app_cli` → `app-open-request` (`useAppOpenRequests.ts:232-250`, `:131-165`);
  `close_app` still closes through `windowStore.closeWindow` + `closeAppOwnWindow`
  (`:201-227`); `doom_mode` still routes through `useDoomModeSkill.ts:100`. **Live:** an open turn
  opens the application frame and a close turn removes it (`functional.md` Q-12, Q-13).
  **Edge:** a reply that claims an action but performs none is a regression (the `skillPending`
  deferral contract). The deterministic reply copy (`appOpenReply.ts`) must be unchanged —
  `Opening <name>`, `Closing <name>`, `<name> isn't open`, `I couldn't find "<spoken>"`,
  `I couldn't open <name>. Try again from the launcher grid.`

- [ ] **R-5 (static).** `shared/companion/composerTarget.ts` is **live** grounding
  (`CompanionEntity.tsx:1532,1544`; `CompanionComposer.tsx:93`) and is **not** part of the removed
  command path. It must exist and keep being consumed.
  **Edge:** deleting it (mistaking it for S1 residue) breaks the composer's turn target. A guard
  hit on it is a suite defect.

## The engine's channel discipline and dependency surface are unchanged

- [ ] **R-6 (static).** The LLM engine's single-threaded channel discipline
  (`applications/llm_server/engine/thread.rs`) is untouched — this slice removes *state reads*,
  never adds one. No new dependency in either `Cargo.toml`; no new IPC command.
  **Edge:** a new `AppHandle` requirement anywhere on the offer path is a regression of the
  handle-free accessor (`functional.md` Q-8).

## The build gates stay green and the guard never regresses

- [ ] **R-7 (static).** `cargo check` zero warnings; the CI-parity clippy (no `--all-targets`)
  exit 0; `cargo nextest run --locked` green (`functional.md` Q-16…Q-18). The committed guard
  stays exit `0` plain and `-SelfTest` (`functional.md` Q-1, Q-2).
  **Edge:** `--all-targets` stays red at base — never report it as a regression of this slice.

## Linked prior suites that overlap this surface

These are NOT re-authored here; run them as the inherited regression asset:

- `.opencode/tests/companion/regression.md` — **R-51** (joke / TicTacToe / teleport /
  reply-surface contracts unchanged), **R-65** (presence, persisted keys, gesture set,
  reply-surface contracts untouched). `functional.md` **F-99 / F-100 / F-102** (skill contract,
  reply copy, stability) remain in force and are the reply-path baseline.
- `.opencode/tests/companion-audio-skill-parity/` — the model-audio path's offer, whose single
  shared accessor is pinned by
  `tests/voice_invariants.rs::the_model_audio_path_obtains_its_offer_from_the_one_shared_registry`
  (`:652`). S2 re-points that test but keeps its title and its single-accessor invariant.
- `.opencode/tests/doom-mode/` — the `doom_mode` skill consumer
  (`shared/doom-mode/useDoomModeSkill.ts:100`), one of the three surviving static skills.
- `.opencode/tests/navigation-retirement/` — S1's guard and ledger precedent; the same
  *shape* this slice's guard follows (`check-navigation-retired.ps1`).
- `.opencode/tests/retired-navigation/RETIRED.md` — the ledger precedent this slice's `RETIRED.md`
  mirrors (`RETIRED.md` in this folder, authored by ST-2 Work 2b).

> **Out of scope (S3, #3153).** Prose references to the deleted commands in
> `.opencode/tests/companion/*`, `.../launcher/*`, `.../wireframe/*` and
> `navigation-retirement/regression.md:91` are S3's to retire. They lie outside both guard roots.
> A tester must NOT fail this slice for them — record them as carried by S3.
