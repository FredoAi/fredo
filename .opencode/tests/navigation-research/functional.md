# navigation-research — Functional

Feature: place-based navigation fluency research (Issue #3115, P1 of the navigation-engine
program, umbrella #3114). Deliverables: the UX research report, a **throwaway static**
prototype, the normative session protocol, and Gate-H evidence transcribed into the report.

Verification policy: **static** — the ACs are artifact existence/completeness, a numeric
recomputation over a committed table, a participant-mix check, and a prove-a-negative over the
spec diff. There is no telemetry/webview/app-launch surface for this feature; no
`telemetry_spans` evidence applies and none is planned.

> **Human-only gate (ST-5).** AC3/AC4/AC5/AC6 depend on real moderated sessions run by a human.
> No agent may fabricate participants, notes, ratings or quotes, and no case below instructs one
> to. The tester verifies document completeness + internal consistency + arithmetic and cites
> the Orchestrator's `## Status` comment on #3115 as the human attestation.

> **Precondition:** testing runs only AFTER ST-6. If the report still carries
> `> STATUS: PENDING GATE H — NO DATA`, F-3/F-4/F-5 are FAIL — the round is premature, not a
> product signal.

## Cases

- [ ] **F-1 (R-1 / AC1) — report exists with every required section.**
  Read `docs/UX_FLUENCY_RESEARCH.md`. **Expected:** non-empty; line 1 carries the front-matter
  `> **Status:**` line; H1 is `# Fredo Navigation Fluency Research (Issue #3115)`; every H2/H3
  from Architect §4.2 appears exactly once, in order (§1–§11 including `### 2.1`,
  `### 3.1`–`### 3.4`, `### 4.1`/`### 4.2`, `### 5.1`–`### 5.3`, `### 6.1`–`### 6.3`,
  `### 7.1`–`### 7.3`, `### 8.1`–`### 8.3`, `### 9.1`–`### 9.3`, `### 10.1`–`### 10.3`,
  `### 11.1`).
  **Required path:** `docs/UX_FLUENCY_RESEARCH.md`.
  - [ ] **F-1a** §2.1 has ≥10 principle rows, each with an `http(s)://` source, a non-empty
    Fredo-specific rule, and the observable §4.1 scores.
  - [ ] **F-1b** §3.2 names the then-shipped surfaces, each with `file:line` anchors. **P8
    supersession:** the current surface inventory is the retained set (`wireframe`, `terminal`,
    `mission-monitor`, `database-client`, `dev-mode`, `window-system`, launcher), asserted by
    `retainedApplicationSet.test.ts`; the report is historical for #3115.
  - [ ] **F-1c** counts re-derived with the Architect §3.1 recipe match the report for the
    then-shipped surfaces. **P8 supersession:** legacy element-key counts are historical and the
    committed `legacyAbsence.test.ts` now owns the zero-reference gate; the current counts are the
    declaration's published verbs/places, asserted by the navigation suites.
  - [ ] **F-1d** §4.1 rubric exists; §4.2 has ≥1 finding per surface and **every** finding
    cites ≥1 repo path (spot-read ≥2 cited paths).
  - [ ] **F-1e** §3.3 duplicate-declaration analysis and §3.4 claimed→verified corrections are
    present (incl. the `spikes/README.md:3` flat-file correction and the dev-mode
    `showable=false` note).
  **Edge:** missing/renamed/duplicated heading; a vibes-only finding; a count disagreeing with
  the recipe; a cited path that does not exist (G-299).

- [ ] **F-2 (R-2 / AC2) — throwaway prototype is complete and self-contained.**
  Read the prototype directory. **Expected:** `README.md` contains `THROWAWAY`, a P8 deletion
  statement and the "open index.html" instruction; `index.html` references only relative paths
  (`./prototype.css`, `./prototype.js`) — no CDN, no absolute URL, no bundler import; Grep for
  `apps/` in the prototype dir returns nothing; no build/workspace config references `spikes/`.
  **Required paths:** `spikes/3115-navigation-engine/prototype/{README.md,index.html,prototype.css,prototype.js}`.
  - [ ] **F-2a** all 30 `data-testid` hooks from Architect §4.3 present in `index.html` with
    their required attributes; non-repeatable hooks appear exactly once; repeatable
    initial-markup counts: `proto-place-node` = 7, `proto-root-alias` = 6,
    `proto-breadcrumb-crumb` 1..n, `proto-verb` **5 at `place.canvas` (root)** and **4 at each
    of the 6 child places** — pinned (never 6 at root: the promoted `verb.style.setFill` is
    removed and exists only at `place.canvas.style`), `proto-map-group` = 8, `proto-object` ≥1
    with `data-selected="true"|"false"`; `proto-undo-status` present once with **no**
    `data-undo-state` (the documented exception). Interaction-only rows are source-asserted,
    never demanded in the initial DOM: the `proto-launcher-reply` container exists in
    `index.html` and `prototype.js` has the reply renderer path (quote function/lines); the
    `prototype.js` palette dataset has ≥1 row for every place and the renderer emits
    `proto-palette-result` with the three cells (quote function/lines).
  - [ ] **F-2b** the 7 places render with the exact `data-place-id`/`data-place-path`/
    `data-child-of` from §4.3; the 6 root aliases render `r e t m s f` with the exact
    `data-verb-id`s (`r`→`verb.create.rect`, `e`→`verb.create.ellipse`, `t`→`verb.create.text`,
    `m`→`verb.place.arrange`, `s`→`verb.place.style`, `f`→`verb.place.file`) plus `/`
    (`verb.ask.open`) and `?` (`verb.map.open`). The root rail's 5 verbs carry keys `r e t a l`
    → `verb.create.rect` / `verb.create.ellipse` / `verb.create.text` / `verb.select.all` /
    `verb.arrange.alignLeft`, and `r`/`e`/`t` map to the **same** `data-verb-id` as the matching
    alias chip; `verb.style.setFill` does **not** appear on the root rail.
  - [ ] **F-2c** `proto-place-rail` has `data-place-id`; `proto-breadcrumb` has
    `data-crumb-count` with ≥1 crumb; `proto-contextual-verbs` has `data-verb-count` equal to
    its rendered `proto-verb` count **in every place** — `5` at `place.canvas` and `4` at each
    child place (7 places checked, none outside the pinned counts).
  - [ ] **F-2c2 (collision guard)** build a `(data-place-id, data-key) → data-verb-id` map from
    every `proto-verb` plus every `proto-root-alias`/`proto-map-key` row assigned to a place:
    within any one `data-place-id` no two `data-key` values map to different `data-verb-id`
    values. The same key in a *different* place is allowed (place-scoped keys). At the root the
    key set is `r,e,t,a,l` (rail) + `m,s,f` (aliases) + `/`,`?` (entries).
  - [ ] **F-2d** (a) initial markup: `proto-map-overlay[data-open="false"]`, the 8
    `proto-map-group`s (7 places + `place.aliases`) each with ≥1 `proto-map-key`
    (`data-key` + `data-verb-id`) — quote it; (b) `prototype.js` has the open handler bound to
    `proto-map-entry`/`?` writing `data-open="true"` and the close handler bound to
    `proto-map-close`/Escape writing `"false"`; a map-row handler opens the verb's owning
    place and flashes the verb without executing it (map rows navigate only) — quote the
    function names. **No drive.**
  - [ ] **F-2e** (a) initial markup with `data-selection-count="0"`: every selection-dependent
    `proto-verb` carries `data-requires-selection` from the §U-5 enum
    (`none|any|single|multi|multi3`) and `!= "none"`, with `data-disabled="true"` — at the root
    that is exactly `verb.arrange.alignLeft` (`multi`) and `verb.select.all` (`any`); every
    `proto-object` carries `data-selected="false"` — quote it. `verb.style.setFill` is **not** a
    root verb: at `place.canvas.style` it is present with `data-requires-selection="single"` and
    `data-disabled="true"` — quote it. (b) the `prototype.js` selection handler writes
    `data-selected="true"`, updates `data-selection-count`, and flips `data-disabled` to
    `"false"` only on verbs whose requirement the new count meets: with **two** objects selected
    `verb.arrange.alignLeft` flips to `"false"` at `place.canvas`; at `place.canvas.style`
    `verb.style.setFill` flips on a **single** selection (and is `"true"` again at two) — quote
    the function. **No drive.**
  - [ ] **F-2f** (a) initial markup: `proto-launcher[data-open="false"]` with a default
    `data-launcher-mode="natural"`, the `proto-launcher-input` + reply container, and
    `proto-undo-status` with **no** `data-undo-state` — quote it; (b) `prototype.js` has the
    submit handler appending `proto-launcher-reply` naming object+property and revealing
    `proto-undo-toast` with `data-change-target`, `data-change-property`,
    `data-attribution="companion"`; the undo handler restoring exactly the named property and
    writing `proto-undo-status[data-undo-state="applied"]` (only `available`/`applied` ever
    written); the palette-mode handler writing `data-launcher-mode="palette"` and emitting rows
    with the three cells — quote each function. **No drive.**
  - [ ] **F-2g** the AC2 "unaided" clause is Gate-H-bound: §7.3 T1–T6 rows and §5.2's
    affordance map are cited; the tester does **not** drive the prototype, and the F-2a–F-2f
    source proofs cover only affordance paths (markup + handlers exist), never unaided
    completion.
  **Edge:** a CDN/network dependency; an `apps/` import; a duplicated non-repeatable hook; a
  **6th root verb or a root `verb.style.setFill`** (the removed collision — FAIL; root is 5
  verbs, `setFill` lives only at `place.canvas.style`); a stroke mapped to two different verb ids
  inside one place (F-2c2 — the same key in another place is allowed); a reply/palette row
  demanded in the initial DOM (they are renderer paths); a map row that executes instead of
  navigating; a palette row counted as T6 (it self-executes); undo resetting the whole object;
  `/` and `?` bound directly (allowed — §11.1, not a FAIL); a row demanding a browser drive (plan
  defect, G-316).

- [ ] **F-3 (R-3 / AC3) — protocol + sessions evidence are complete and consistent.**
  Read `spikes/3115-navigation-engine/session-protocol.md` and report §6/§7/§10.
  **Expected:** the protocol contains verbatim T1–T7 and the question set (Q-WHERE, Q-UX ×2,
  Q-TRUST, Q-SYS, Q-RECALL), the consent/anonymisation rule, moderator rules, the §4.4 metric
  definitions including the corrected `keyboard_profile`/`vim_comfortable`/`wireframe_new`
  columns, the §4.5 six gate lines byte-for-byte, the corrected recruitment quotas
  (`keyboard_first_or_vim >= 2` / `non_vim >= 2` / `wireframe_new >= 2`, not mutually
  exclusive) and the distractor instruction; report §6.1 points at it without duplicating task
  text.
  - [ ] **F-3a** `completed_participants` (summary rows with `consent_recorded=true` AND
    `tasks_completed>=1`) is **5–8 inclusive**; §7.3 carries the corrected columns
    (`keyboard_profile ∈ keyboard-first|non-vim`, `vim_comfortable ∈ yes|no`,
    `wireframe_new ∈ yes|no`) and §6.2 states the mix. Recompute all three quotas from §7.3:
    `keyboard_first_or_vim = count(keyboard_profile=="keyboard-first" OR vim_comfortable=="yes") >= 2`,
    `non_vim = count(keyboard_profile=="non-vim" AND vim_comfortable=="no") >= 2`,
    `wireframe_new = count(wireframe_new=="yes") >= 2`. The categories are **not** mutually
    exclusive (a non-vim participant may also be new to Wireframe), so all three hold at n=5.
  - [ ] **F-3b** §10.1 has exactly one note block per `participant_id` in §7.3 and vice versa;
    §7.2 aggregated + §7.3 raw tables carry the exact §4.4 columns; no `consent_recorded !=
    true` row; no raw names; the `STATUS: PENDING GATE H` marker is absent.
  **Required paths:** `spikes/3115-navigation-engine/session-protocol.md`,
  `docs/UX_FLUENCY_RESEARCH.md` (§6, §7, §10).
  **Edge:** n=4 (PRE-1 fails), n=9; a quota computed from a retired mix column; a participant
  in raw rows but absent from the summary; duplicate ids; an orphan note; the marker left in
  §8/§9 only.

- [ ] **F-4 (R-4 / AC4) — the three research questions are answered with evidence.**
  Read report §8.1/§8.2/§8.3. **Expected:** each states a conclusion, ≥1 number traceable to
  §7, and ≥2 verbatim quotes each attributed to a `participant_id` present in §7.3; the quotes
  match that participant's `quote_1`/`quote_2` (or the §10.2 index) and are distinct unless
  explicitly marked as reused.
  **Required path:** `docs/UX_FLUENCY_RESEARCH.md` (§7, §8, §10.2).
  **Edge:** a conclusion with no number; a number not derivable from §7; an unattributed quote;
  a paraphrase as verbatim; the same quote reused across RQs unmarked.

- [ ] **F-5 (R-5 / AC5) — numeric verdict is recorded and recomputes.**
  Read report §9.1/§9.2/§9.3 and the issue's `## Status` comment. **Expected:** §9.2 has exactly
  one `^Verdict: (GO|NO-GO)$` line; the tester recomputes all six §4.5 lines from §7.3, states
  each fraction and denominator, and they match §9.1/§9.2; `GO` iff all six pass. On NO-GO:
  failed lines + observed alternative + one redesign hypothesis + the §9.3 human-decision slot.
  The Orchestrator's `## Status` comment is cited as the human attestation.
  **Required path:** `docs/UX_FLUENCY_RESEARCH.md` (§4.5 as the definition source, §7.3, §9) and
  the `## Status` comment on #3115.
  **Edge:** two verdict lines; GO-2 as a per-task average; GO-4 using `>=` half; even n (n=6
  needs ≥4, n=8 needs ≥5); a T6 abandonment (T6-only false, still in GO-3's denominator); NO-GO
  treated as a FAIL (it is a valid outcome, N-7).

- [ ] **F-6 (R-6 / AC6) — a non-keyboard-first participant completes and is cited.**
  Read §7.3 and §10.1. **Expected:** ≥1 per-participant row with `keyboard_profile !=
  "keyboard-first"` and `tasks_completed >= 1`; that participant's note contains an explicit
  helped/hindered statement about the place model; every §8 conclusion cites ≥1 such
  participant.
  **Required path:** `docs/UX_FLUENCY_RESEARCH.md` (§7.3, §8, §10.1).
  **Edge:** only keyboard-first participants; a non-keyboard-first participant with no
  helped/hindered sentence; one such quote reused across all three conclusions (allowed if
  real and attributed).

- [ ] **F-7 (R-7 / AC7) — no production source under `apps/` is modified.**
  (a) name-only spec-branch diff vs `main`; (b) Grep the prototype for `apps/`; (c) Grep
  build/workspace config for `spikes/`; (d) `cargo check` from `apps/tauri/src-tauri` and
  `pnpm --filter @fredo/ui build`.
  **Expected:** (a) zero `apps/` paths; (b) no prototype `apps/` reference; (c) no build config
  references `spikes/`; (d) both commands exit 0 with zero warnings/errors (the pre-existing
  Vite chunk-size advisory is not an error).
  **Edge:** a formatting-only `apps/` change; a deleted `apps/` file; a package added to the
  workspace; a "fix" to product code to make a build green (escalate — breaches AC7).

## Suite-level pass/fail

PASS overall = F-1..F-7 all green, each with the exact file/section read and observed value
quoted. A single unaddressed gate-arithmetic mismatch is a FAIL. A row needing human data with
none is BLOCKED (report the ST-6 precondition), never PASS. NO-GO is a PASS of F-5.

---

## #3120 rescope extension — Gate H instrument replacement (static, NOT pipeline-run)

> Issue #3120's human-directed rescope REPLACES the launcher-centric pilot-exit instrument with one
> that exercises the reworked experience. Rows map 1:1 to the QA Plan `R-9` in
> `.opencode/tmp/3120/triage.md` `## QA Expert`. **Verification policy: static** — the deliverable is
> the committed instrument's CONTENT; there is no app/webview/telemetry surface for it, and the
> pipeline does NOT run it and never fills participant data (G-414). Required artifact:
> `docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md` (committed on `spec/3120`,
> owned by ST-9). Method source (READ-ONLY, never edited):
> `spikes/3115-navigation-engine/session-protocol.md`.

- [ ] **F-8 (R-9.1, static) — the committed instrument exercises the reworked experience.**
  **Steps:** `Read` the template by exact path; extract its task script; map each task to the reworked
  surfaces.
  **Expected:** the task script contains a task for EACH of: (a) the BOTTOM command bar with place
  breadcrumbs (show the bar's shape; name what a place change does), (b) the teleport instruction box
  AUTO-FOCUSED on arrival (no click), (c) the DEFAULT target (the app Fredo is in front of) vs an
  EXPLICITLY NAMED app, (d) a companion CARD-LABEL edit, (e) UNDO-BY-DESCRIPTION (`undo the label
  change`), (f) the details-panel text-input DELETION fix (type then Backspace). A task tally is
  quoted (task id → surface). The retired `>` palette is NOT taught or run.
  - **Edge:** a task that only names a surface without an observable step is a FAIL; a task that
    teaches the removed `>` palette is a FAIL.
  - **Receipt:** E-STATIC (the task-script excerpt per surface).

- [ ] **F-9 (R-9.2, static) — the participant gate, cohort quotas, verbatim questions and six gate lines are preserved.**
  **Steps:** read the same file; compare with the protocol's §4.4/§4.5/§7.3.
  **Expected:** the template states **5–8 participants with a minimum of 5 completed**; keeps the
  three cohort predicates verbatim —
  `keyboard_first_or_vim = count(keyboard_profile=="keyboard-first" OR vim_comfortable=="yes") >= 2`,
  `non_vim = count(keyboard_profile=="non-vim" AND vim_comfortable=="no") >= 2`,
  `wireframe_new = count(wireframe_new=="yes") >= 2` — and the per-cohort reporting rule; keeps the
  QUESTION SET verbatim (Q-WHERE, Q-UX ×2, Q-TRUST, Q-SYS, Q-RECALL); keeps the SIX gate lines
  byte-matching protocol §8 (`GO` iff `PRE-1 ∧ PRE-2 ∧ GO-1 ∧ GO-2 ∧ GO-3 ∧ GO-4`); carries a
  `notice` that the task script supersedes the protocol's task list while the method/questions/gates
  stand; `session-protocol.md` is NOT modified (no diff entry).
  - **Edge:** a wrapped gate line (every token still matches); a renamed task id with the six lines
    intact (allowed); a quota predicate reworded (FAIL); a question paraphrased (FAIL).
  - **Receipt:** E-STATIC (the quoted gate/quota/question text).

- [ ] **F-10 (R-9.3, static) — no participant data, no prefilled verdict; the pipeline did not run the instrument.**
  **Steps:** read the template; scan the spec branch for participant artifacts (`P1`–`P8` rows with
  ratings/quotes, `session-notes.md`, `participant-notes.md`, session recordings) and for a prefilled
  verdict; read `.opencode/tmp/3120/` only to confirm no run was recorded (a draft is never evidence —
  G-415).
  **Expected:** the banner `PARTICIPANT DATA IS HUMAN-PRODUCED; THE PIPELINE DOES NOT RUN THIS` (or its
  exact committed wording) is present; every data cell is an empty slot (zero participant rows /
  ratings / quotes); exactly ONE `^Verdict: (GO|NO-GO)$` line and it is EMPTY/unfilled (never a
  prefilled `GO`/`NO-GO`); no committed participant artifact exists anywhere on the branch; no
  pipeline role's event/comment records a participant session; the task is handed to the human.
  - **Edge:** an empty quote slot (`[]` is wrong — an empty slot is correct); an interim percentage; a
    fabricated baseline; a verdict line added by a developer (a FAIL — the verdict is the human's).
  - **Receipt:** E-STATIC (the banner + the empty-cell/verdict facts + the absence scan).

## Suite-level pass/fail (this extension)

PASS = F-8..F-10 green, each quoting the exact file/section read and the observed value, with the
artifact's commit on `spec/3120` named. A row that needs participant data is BLOCKED (human leg),
never PASS; the pipeline must not fabricate one. The pipeline never runs this instrument.
