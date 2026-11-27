# Order Loop — Regression (the "must not change" baseline)

> **Spec #3243.** Two invariants are deliberately WIDENED by this slice and one is REPAIRED; everything
> else here is a do-not-break baseline.
>
> **Verification policy: live** except where a row is tagged `[static]`.
>
> **`.opencode/tests/**` is NOT edited by this spec** (a live round may hold the root). Every row this
> spec invalidates is therefore **re-cut HERE**, and the supersession table below names each one. When
> this suite is promoted at `planning → implementation`, the old rows keep their text until a later QA
> pass owns them; until then **this suite is the operative contract** for the two widened invariants.

---

## A. The fourth static skill — RE-CUT, not deleted

**What changes:** `order` joins the offer, so `companion_skill_registry()` returns **four** names:
`open_app`, `close_app`, `doom_mode`, `order`. The constructors gain
`SkillRegistry::with_order_support()`; the accessor keeps its **ZERO-argument** signature.

**What must NOT change (a plain count change is NOT enough — the defect world):**

- [ ] **R-1 (the three stay byte-identical).** The first three rendered `tools` entries are byte-identical
  (name + description + parameters, in order) to the pre-change baseline. The shipped pin
  `static_skills_are_byte_identical_to_the_pre_change_baseline` stays GREEN and its literals stay
  unchanged. **FAIL if:** a description is reworded, a parameter added/dropped, or the three reordered.
- [ ] **R-2 (a rename cannot slip through).** The offer-order pin asserts the four names **in sequence**,
  as an ORDERED list — not a set, not a count. **FAIL if:** a count-only change (`len() == 4`) is the
  whole assertion.
- [ ] **R-3 (the accessor stays handle-free).** `companion_skill_registry()` takes **zero parameters**; a
  `companion_skill_registry(app)` arity is a FAIL. No `.try_state` / `state::<…>` / `surfaces` read
  enters its body.
- [ ] **R-4 (typed/audio parity survives UNWEAKENED).** The audio turn and the typed turn obtain the SAME
  four-name offer from the ONE accessor and their `tools` arrays are byte-equal. **Retiring or weakening
  the parity suite to go green is a FAIL** — only the asserted CONTENT moves (three → four).
- [ ] **R-5 (the `order` declaration is closed).** The offered `order` schema's property set is exactly
  `["action", "arguments"]`. Nothing the model can fill authorises an action.
- [ ] **R-6 (the four filters stay separate).** `open_app` / `close_app` / `doom_mode` listeners still
  ignore every other skill name (the shipped single-shared-dispatcher discipline); `order` is a FOURTH
  filter on the SAME one `llm-skill-call` channel — never a second channel or a second dispatch funnel.
- [ ] **R-7 (full-suite receipt).** The receipt for the Rust change is the **FULL** Rust suite, not a
  touched-file subset: a consumer of "exactly three" lives in another crate and a touched-file receipt
  cannot see it.
- [ ] **R-8 (docs are not left asserting a false absolute).** `ARCHITECTURE.md`'s offer row, the
  capability-table row and the Doom-trigger sentence, plus the ADR, are re-worded to "four, with the
  three byte-identical" — in the same landing. A surviving "exactly three" sentence is a FAIL.

### A.1 The supersession table — every `.opencode/tests/**` row this spec invalidates

Each row below is owned by `.opencode/tests/**` (not editable by this spec) and its "three static
skills" / "no fourth skill" / "no TTS output" clause is **superseded by this suite** as noted. The old
row keeps its text until a later QA pass; the successor rows are the operative ones.

| # | Old row (suite · id · anchor) | What its text now contradicts | Successor here |
|---|---|---|---|
| 1 | `companion/functional.md` · **F-145** (`#3099 extension`, "offered ONLY the three static skills") | the offer is four; "no fourth name" is false | F-38, R-1, R-2 |
| 2 | `companion/functional.md` · **F-146** ("offer identical on every turn … no re-publish path") | still true in substance, but the three-name claim it rests on moved | F-38 (four, stable across turns) |
| 3 | `companion/functional.md` · **F-152** ("the descriptor is not one of the three static skills") | `order` IS now offered; the "not one of the three" reasoning is stale | F-27 (an undeclared action id is refused), F-32 |
| 4 | `companion/functional.md` · **F-157** ("`listActions` is not one of the three static skills") | the offer set moved; `order` is the carry of the action list | F-27, F-38 |
| 5 | `companion/functional.md` · **F-159** (shipped pin asserts exactly three names) | the pin is RE-CUT to four with the three byte-identical | R-1, R-2, F-38 |
| 6 | `companion/smoke.md` · header note (":365-368") + **S-48** ("offer is the three static skills") | four; and `order` is now a real selectable skill | F-38, R-1 |
| 7 | `companion/smoke.md` · **S-49** ("`listActions` is not one of the three static skills") | the set moved; no action LIST is still composed, but for a different reason | F-38, F-21 |
| 8 | `companion/smoke.md` · **S-50** (honest rejection, "the relay does not exist") | still true (no relay), but its three-name premise is stale | F-27 |
| 9 | `companion/regression.md` · banner (":1007-1011") + **R-70** ("offer order is exactly `open_app, close_app, doom_mode`") | the offer order is now four; validation of the three unchanged | R-1, R-2, R-3 |
| 10 | `companion/regression.md` · **R-71** ("one accessor serves typed AND audio") | the SUBJECT is preserved; its "three-name offer" content moved | R-3, R-4 |
| 11 | `companion/exploratory.md` · **E-79** ("offers exactly three skills, every turn") | four, every turn | F-38 (edge: identical four on a second turn) |
| 12 | `companion/exploratory.md` · **E-80** (unknown skill name does nothing, twice) | still true; premise wording stale | F-27 |
| 13 | `launcher/functional.md` · **F-136** ("the companion offer is the three static skills") | four | R-1, R-2, F-38 |
| 14 | `launcher/functional.md` · **F-137** ("the companion's Rust side carries only `companion_skill_registry()` and the three static skills") | it now also carries `order` + `with_order_support()` | R-3, R-6 |
| 15 | `launcher/regression.md` · **R-81** ("offer is exactly `open_app`, `close_app`, `doom_mode`") | four | R-1, R-2 |
| 16 | `launcher/exploratory.md` · **E-86** ("drive one shipped companion skill — the three static skills") | the driver set is four; `order` is now a legitimate in-flight driver for this probe | F-33, F-34 (the in-flight/undo interaction), R-6 |
| 17 | `wireframe/functional.md` · **F-48** ("the offer is the three static skills, no listener declares a `wireframe` skill") | four; and an `order` selection DOES now reach Wireframe through the order surface | F-1, R-6 |
| 18 | `wireframe/functional.md` · **F-49** ("the offer is exactly those three … There is no fourth, generated or application-named skill") | `order` IS a fourth **static** skill (still not application-named, still not generated) | R-1, R-2, F-38 |
| 19 | `wireframe/functional.md` · the **F-43…F-49 disposition bullet** (":1289-1295", "The offer is the three static skills … a `wireframe` `llm-skill-call` is inert") | the remaining is still not a `wireframe`-named skill, but the offer set moved | R-6, F-27 |
| 20 | `wireframe/regression.md` · **R-5** ("`open_app`, `close_app`, `doom_mode` behave identically, and that is the WHOLE offer") | the whole offer is four | R-1, R-2, R-6 |
| 21 | `wireframe/regression.md` · **R-27** ("the offer is the three static skills … no element appears") | a named `order` selection for a DECLARED action now changes the document **after the gate**; an UNDECLARED one stays inert | F-24, F-27, R-6 |
| 22 | `wireframe/exploratory.md` · **E-19** ("The live transport now offers exactly the three static skills") | four | F-38 |
| 23 | `companion-audio-skill-parity/functional.md` · header (":3-16") + **F-1** (":42") | both turns now offer four; parity unchanged | R-4, F-38 |
| 24 | `companion-audio-skill-parity/functional.md` · **F-2** (":43", "offered the same three skills") | four, same for both paths | R-4 |
| 25 | `companion-audio-skill-parity/functional.md` · **F-4** (":45", pins "EXACTLY `open_app`, `close_app`, `doom_mode` … len()==3") | the pin is RE-CUT to four (`len()==4`) with the three byte-identical | R-1, R-2, R-7 |
| 26 | `companion-audio-skill-parity/functional.md` · **F-10** (":51", the typed offer content/order unchanged) | order now includes `order` | R-1, R-2 |
| 27 | `companion-audio-skill-parity/functional.md` · **F-11** (":52", "no TTS/audio-output surface") | **an audio-OUTPUT surface now ships** (see §B) | B-1, B-2 |
| 28 | `companion-audio-skill-parity/functional.md` · **F-13** (":54", the four-pin guard set) | the guard set names a pin whose subject changed | R-1, R-2, R-7 |
| 29 | `companion-audio-skill-parity/smoke.md` · header (":5-7") + **S-3** (":23-27", "offered set is exactly the three … no fourth name") | four | R-4, F-38 |
| 30 | `companion-audio-skill-parity/regression.md` · banner (":6") + **R-1** (":9", typed offer + its pin frozen) | the pin is re-cut; its subject (parity) is preserved | R-4 |
| 31 | `companion-audio-skill-parity/exploratory.md` · probes (":11", ":20", ":22") | each probes "the three static skills" / "the SAME three-skill offer" | R-4 |
| 32 | `navigation-retirement/regression.md` · **R-14** (":90-100", "the companion offer is exactly the three static skills") | four | R-1, R-2 |
| 33 | `navigation-prose-retirement/functional.md` · **P-16** (":407-428", "the offer set is the three static skills") | four; P-16's own edge (d) — "the 4-skill negative assertion … is CORRECT and must stay" — now refers to a DIFFERENT four (this slice's `order`, not the deleted generated skill) and must not be harmonised blindly | R-1, R-2, R-5 |
| 34 | `companion-command-removal/functional.md` · **Q-7** (":164-172", "`len() == 3`, no application-named skill") | `len() == 4`; still no application-named skill | R-1, R-2, R-3 |
| 35 | `companion-command-removal/functional.md` · **Q-9** (":183-194", "the rendered `tools` array has exactly three elements") | four | R-1, R-2 |
| 36 | `companion-command-removal/functional.md` · **Q-10** (":196-205", the byte-identical baseline) | the baseline is the FIRST THREE of four; the pin must stay green unchanged | R-1 |
| 37 | `companion-command-removal/regression.md` · **R-1** (":17-24", "The offer order is still `open_app`, `close_app`, `doom_mode`") | the order is four | R-1, R-2 |
| 38 | `companion-command-removal/regression.md` · **R-2** (":26-30", "A new key in the wire shape is a regression") | the wire shape per entry is unchanged; the ARRAY grew | R-1, R-6 |

> **Note on the count.** The Architect's estimate was "~20 live-suite rows"; the executed enumeration
> above finds **38 sites across 18 suite files in 7 suite domains** (§B.1 adds 4 more, for **42 sites
> across 20 files in 9 domains**), because many suites carry the same invariant in a header, a functional
> row and a regression row. The invariant census is unchanged — the extra sites are duplicates of the same
> clause, not new invariants. **No site is left with no disposition.**
>
> **Ordering rule for a later QA pass (G-476):** new durable rows are appended after the highest existing
> id in the target suite, read from the file — never from a remembered range.

---

## B. The audio-OUTPUT surface — a REPAIR, not a deletion

**What changes:** the companion gains a spoken reply for **order outcomes** (`speakCompanionReply` via
the webview's platform voice). `docs/ARCHITECTURE.md`'s "no companion audio/TTS output surface" and
`docs/SECURITY.md`'s "no audio is emitted" become FALSE on merge.

**What must NOT change (G-522 — the repair must not widen what it repairs):**

- [ ] **B-1 (Doom Mode still suppresses output).** While Doom Mode is active, no order reply is spoken:
  `isPerformanceGateActive()` is read by the sink, `speechSynthesis.speaking` stays false, and the
  sentence is carried by the polite region instead. **This is what keeps `SECURITY.md`'s surviving claim
  TRUE.** **FAIL if:** an utterance starts while Doom Mode is active, or the doc sentence is deleted
  rather than re-scoped.
- [ ] **B-2 (welcome / joke / game stay VISUAL-ONLY).** The turn-on welcome bubble, the joke stream and
  the game emit no speech. The `CompanionContext` unit assertion that `speechSynthesis` is not called on
  turn-on stays GREEN at its new, NARROWER scope — **it is re-cut, never deleted.** **FAIL if:** the
  welcome is spoken, or the assertion is deleted to go green.
- [ ] **B-3 (the input pipeline is untouched).** The captured-audio path, the 15 s watchdog, the FIFO and
  the single `llm-done` discipline are unchanged. No Rust is added and no crate (`Cargo.toml`
  unchanged). **FAIL if:** a new audio crate appears, or the input path changes.

### B.1 The `no TTS output` rows this spec invalidates

| # | Old row (suite · id · anchor) | What its text now contradicts | Successor here |
|---|---|---|---|
| 39 | `voice-input/functional.md` · **F-12** (":71-73", "STT-only … no synthesized audio playback") | an order outcome IS now synthesized | B-1, B-2, F-3 |
| 40 | `voice-input/functional.md` · **F-33** (":203", "No TTS … no TTS/audio playback surface") | an output surface now ships, scoped to order outcomes | B-1, B-2; the INPUT half stays true |
| 41 | `doom-mode/functional.md` · **F-36 edge** (":269", "the companion has NO audio/TTS output … A literal TTS-mute surface does not exist; do NOT assert one") | there IS one; Doom Mode suppresses it | **B-1** (the replacement clause — Doom Mode suppresses the new output) |
| 42 | `companion/functional.md` · **F-61** (":887-890", "NO audio element/`speechSynthesis`/TTS call is made (visual only)" for the welcome bubble) | STILL TRUE, but only at its narrowed scope — it must carry an explicit "scope: the welcome/joke/game only; an ORDER outcome IS spoken" note so a later reader cannot read it as a global silence claim | B-2, F-3 |

> **Historical run-log lines that mention `speechSynthesis.speaking=false`** (`companion/functional.md`
> round-3 records, `companion/smoke.md` S-45/S-46 PASS notes, `voice-input/functional.md` F-33 PASS) are
> **records of a past run at a past SHA — kept verbatim as history, never re-read as a claim about the
> shipped product** (the same convention those files already use for the four-skill era).

---

## C. The gesture — consumed, never re-derived

- [ ] **C-1 (the launcher's gesture is untouched).** `launcherSpaceHold.ts` is NOT edited; its unit suite
  (`__tests__/launcherSpaceHold.test.ts` — the precedence table, the `2^7−1` non-qualifying
  combinations, the `no-words-space` branch, the write-table totality, the two purity sweeps) is GREEN
  and its file is byte-unchanged. `launcherVoiceDictation.test.tsx` is unchanged.
  **FAIL if:** the precedence was re-derived for the order field rather than delegated (a reorder must
  redden BOTH suites).
- [ ] **C-2 (the launcher's keyup owner is unchanged).** The single document keyup owner and the
  window-blur stop keep their exact semantics. The order field's cancels are FIELD-scoped, inside the
  composer's own React tree — **no second `window`/`document` blur or keydown handler is added.**
- [ ] **C-3 (three chords, still three).** `PLATFORM_CHORDS` is byte-unchanged (see F-43). The hold-Space
  gesture is field-scoped and is NOT a platform chord; a fourth chord is a design decision this slice
  does not take.

---

## D. The shipped composer, the reply surface, the ONE polite region

- [ ] **D-1 (the composer's shipped submit behaviour is byte-identical when no capture is armed).**
  `Enter` submits, `Shift+Enter` newlines, `Escape` dismisses, auto-grow caps at `COMPOSER_MAX_H`, and
  `event.nativeEvent.isComposing` short-circuits so an IME composition never arms a capture.
  `CompanionComposer.tsx`'s header invariant ("adds NO `aria-live` region and NO document-level key
  listener") still holds.
- [ ] **D-2 (the ONE polite region is still ONE).** `fredo-companion-live-region` remains the single
  polite region; no second `aria-live` region is added (the composer's announcement routes through the
  existing one via a prop). **FAIL if:** a second live region appears anywhere on the companion surface.
- [ ] **D-3 (the shipped app-open reply path is unchanged).** `useAppOpenRequests` / `close_app` /
  `doom_mode` replies behave exactly as before; the one-channel rule is scoped to the ORDER reply push
  only.
- [ ] **D-4 (the reply surface stays re-readable).** `fredo-reply-surface` remains a navigable `region`
  named for the user; a settled order sentence stays re-readable there after the bubble's hold expires.

---

## E. Everything the slice must not touch

- [ ] **E-1 (`CompanionContext`).** `teleport` / `isAway` / `composerOpen` / `openComposer` are unchanged
  in behaviour; the placement store is added BESIDE them, never inside.
- [ ] **E-2 (the Wireframe store + history).** `wireframeDocumentStore.ts` and `wireframeHistory.ts` are
  NOT edited; `WIREFRAME_HISTORY_LIMIT` (100) is untouched; the app's own Undo/Redo controls stay
  functional on the same history. The order's undo **delegates** to the app's shipped inverse — a second
  history or a re-implemented inverse is a FAIL.
- [ ] **E-3 (`WIREFRAME_ACTIONS`).** No new row, no new id. The four declared order actions live in
  `wireframeOrderSurface.ts`; the 35-verb table and the pointer strip are untouched.
- [ ] **E-4 (the 8 apps that declare no order surface).** They can be placed but an order against them
  classifies `unknown` and is refused — the gate is honest by construction (F-27).
- [ ] **E-5 (the row pipeline / RTDB).** Not a party: `infrastructure/comm/` and `infrastructure/rtdb/`
  are untouched; the `companion.injection` span gains three REQUIRED fields (`serde`, no defaults) and
  `image_tokens` keeps its shipped optional/absent-key rule.
- [ ] **E-6 (no new dependency or capability).** `apps/ui/package.json` + the lockfile importer unchanged
  key-for-key; no new Tauri capability/plugin; no new persisted settings key; `Cargo.lock` unchanged.
- [ ] **E-7 (no second instruction input).** The order field IS the shipped composer. A second input
  would be a second dispatch route — a FAIL on sight.

---

## F. Overlapping suites to re-run on the tip (their surviving intent)

- `.opencode/tests/companion/` — R-1..R-69 remain in force; A.1 names the 12 rows whose three-name
  clause moved.
- `.opencode/tests/companion-audio-skill-parity/` — the **parity** subject survives unweakened (R-4).
- `.opencode/tests/launcher/` — the hold-Space gesture's own rows remain the control (C-1).
- `.opencode/tests/wireframe/` — the document semantics, the app-local history and the pointer strip
  remain (E-2, E-3).
- `.opencode/tests/navigation-retirement/` + `navigation-prose-retirement/` — their offer-set clauses
  moved (A.1 #32, #33); their deletion claims (no publish path, no relay, no manifest) are untouched.
- `.opencode/tests/doom-mode/` — Doom Mode suppression is now the repaired claim (B-1).
- `.opencode/tests/voice-input/` + `voice-dictation/` — the INPUT path is untouched (B-3).
