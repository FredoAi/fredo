# Pilot Exit Review — NavigationEngine P6 rework (#3120)

> **PARTICIPANT DATA IS HUMAN-PRODUCED, NEVER PIPELINE-PRODUCED.**
> This file is a **committed, durable template**. It ships with **no participant data, no
> ratings, no quotes, no prefilled verdict and no fabricated rows** — every data cell below is an
> empty slot. Only the **human facilitator** fills it, from sessions the human ran. No agent may
> run, simulate, transcribe or fabricate a session, and no agent may write participant data into
> this file or into the Gate H input file. **The pipeline does not run Gate H.** The pipeline's
> deliverable is the instrument; the evidence and the verdict belong to the human.

> **NOTICE — the task script is reworked; the method is not.**
> This instrument **supersedes the protocol's task script (T1–T7)** because the experience under
> test was reworked after the protocol was written (the bottom command bar replaced the left
> rail; the teleport-attached instruction composer replaced the launcher as the conversation
> surface; the launcher is launch/search + global commands only). The **method** (the protocol's
> §4 moderator rules), the **question set** (the protocol's §6, reproduced in §4.3 below), the
> **cohort quotas** (the protocol's §3, reproduced in §3.1 below) and the **six gate lines** (the
> protocol's §8, reproduced in §8 below) are reproduced **verbatim** from
> `spikes/3115-navigation-engine/session-protocol.md` and remain in force. **That protocol file
> is not edited by #3120.** Where this document and the protocol could differ on method,
> questions, quotas or gate lines, **the protocol wins**; on the task script, **this document
> wins**.

---

## 1. Status of this document

| Field | State as committed by #3120 |
|---|---|
| Deliverable | This template — the pilot-exit-review instrument |
| Participant rows | **none** (empty slots only) |
| Ratings / quotes / answers | **none** |
| Gate outcome | **not computed** — the six lines are reproduced verbatim, unscored (§8) |
| Session result | **none** — §11 carries the ONE empty outcome line with both options |
| Filled by | The human facilitator, after the sessions |
| Method source | `spikes/3115-navigation-engine/session-protocol.md` — method, verbatim questions, cohort quotas and six gate lines reused unchanged |
| Task-script source | §4 of this document — reworked for the bottom command bar, teleport composer, attributed undo and the details-panel Backspace fix |

## 2. This issue is the pilot gate

**#3120 is the pilot gate.** #3115's numeric GO/NO-GO gate was **deferred to this issue** — the
human chose to test real users on the real Wireframe pilot rather than a greybox prototype. The
deferral was a **scope decision, not a failed gate**: no threshold was missed and no result was
suppressed in #3115.

The human's `GO` / `NO-GO` recorded against this document **is** the program's fleet-migration
decision. **#3121 (fleet migration) must not be dispatched, planned or started without a recorded
`GO`** (or an explicit, recorded human decision to proceed on `NO-GO`).

## 3. Session requirement and participant mix

- **5–8 participants**, with a **minimum of 5 completed**.
- Each session is **30–40 minutes**, one participant per session, moderated think-aloud, on the
  **real reworked pilot** (bottom command bar + map + trail, teleport-attached companion
  composer), following the #3115 protocol's method unchanged and the task script in §4.
- The **question set** is the protocol's verbatim Q-WHERE, Q-UX-1, Q-UX-2 (UMUX-Lite), Q-TRUST,
  Q-SYS and Q-RECALL (§6); the **metric columns** are the protocol's §7 columns reproduced in §7.
- Any deviation from the kit must be recorded explicitly with its reason (see §12).

### 3.1 Cohort quota — reproduced verbatim from the protocol's §3

```
keyboard_first_or_vim = count(keyboard_profile=="keyboard-first" OR vim_comfortable=="yes") >= 2
non_vim               = count(keyboard_profile=="non-vim" AND vim_comfortable=="no") >= 2
wireframe_new         = count(wireframe_new=="yes") >= 2
```

- The three categories are **not mutually exclusive**: a `non-vim` participant may also be
  `wireframe_new`. A single person can therefore satisfy more than one quota, which is why all
  three quotas are **satisfiable at n = 5**. Do not recruit extra people to "cover" a category
  that an existing participant already covers.
- `keyboard_profile` ∈ `keyboard-first` | `non-vim` (mutually exclusive values).
  `vim_comfortable` ∈ `yes` | `no` (independent of `keyboard_profile`).
  `wireframe_new` ∈ `yes` | `no`, where `yes` means the participant had **never used Wireframe
  before this session**.
- In addition, **≥ 1 non-keyboard-first participant** (`keyboard_profile = non-vim`) must
  **complete** the task set (PRE-2 in §8).
- **Per-cohort results are required** (§3.2). **No finding may rest on keyboard-first
  participants alone**, and a cohort with a single member must not be generalised.

### 3.2 Per-cohort report (fill in — one row per cohort, empty slots only)

| cohort (non-exclusive) | participant_ids | n | where_rating ≥ 4 | T1–T5 unaided successes | undo first-attempt successes | same-system count | cohort finding |
|---|---|---|---|---|---|---|---|
| keyboard-first or vim-comfortable |  |  |  |  |  |  |  |
| non-vim |  |  |  |  |  |  |  |
| new to Wireframe |  |  |  |  |  |  |  |
| non-keyboard-first, completed |  |  |  |  |  |  |  |

## 4. Task script — verbatim, T1–T7 (reworked)

The moderator reads each line **exactly as written**, one at a time, in order. The ids `T1`–`T7`
are the metric `task_id` values; do not renumber or drop one. The moderator does not teach keys,
point at a control or name a surface (protocol §4 rules 1–3 still apply). The participant's first
affordance is recorded as `discovery_source` (§7.2); **discovery is measured, never asserted**.

- **T1** — Look at the bottom command bar. Tell me where you are and what you could do next,
  without me telling you any keys. Then show me how you would find the rest of the actions for
  this place.
- **T2** — Move to a different place at the same level as the one you are in. Find it yourself —
  do not use a keyboard shortcut.
- **T3** — Bring Fredo into this window and type an instruction into the box that appears —
  **without clicking into the box first**.
- **T4** — Ask for a change to the app Fredo is in front of. Do not name the app.
- **T5** — Ask for a change to a different app by naming that app explicitly.
- **T6** — Ask the companion to change the card's label to "Reports". Then undo exactly that
  label change. After that, clear the Label field in the details panel — press Backspace until
  the field is empty.
- **T7** — After a 5-minute distractor, say what you remember you could do (recall test).

Task order is fixed: T1 → T2 → T3 → T4 → T5 → T6 → distractor (protocol §9) → T7. The post-session
questions (§6) are asked **after T7**, so the questionnaire never primes the recall test.

### 4.1 What each task exercises (the facilitator's checklist — never read to the participant)

| Task | Reworked surface exercised | Observable outcome |
|---|---|---|
| T1 | Bottom command bar + breadcrumbs | the place path is visible; 4–8 contextual verb rows (fewer only when the place has fewer bound verbs); no horizontal scrolling; `more…` is present when the place overflows and opens the map **filtered to the current place** |
| T2 | `? Map` sibling-place move | the participant reaches a sibling place; `discovery_source` records `map`, `bar`, `guessing` or `other` — the route is measured, not prescribed |
| T3 | Teleport-attached composer | the instruction box opens on the teleport arrival and its input receives focus **with no click** |
| T4 | Default target | the turn is grounded on the app Fredo is in front of (the app frame containing his landing point; else the focused app) — no app is named |
| T5 | Explicit named target | a named, showable app overrides the default target for that turn |
| T6 | Label edit → attributed undo → details-panel Backspace | the card label becomes "Reports"; the first undo attempt restores exactly the previous label; the trail attributes the change to `Companion` and the reversal to `You`; pressing Backspace in the details-panel Label field empties it and **focus stays in the field** (the fixed bug) |
| T7 | Recall after the distractor | the participant names actions/places unprompted |

**T3 setup note.** The teleport gesture may be demonstrated once as a setup step if the
participant has not used it before; record that demonstration as a deviation. The measured
outcome is the **no-click** focus of the instruction box, not the gesture itself.

### 4.2 T6 observed outcomes (fill in — empty slots only)

The summary row's `undo_first_attempt_success` records the undo half. This table records the
label-edit and Backspace halves so RQ3 and the details-input regression can be read directly:

| participant_id | label_change_applied | undo_first_attempt_restored | label_field_cleared_with_backspace | focus_retained_in_field |
|---|---|---|---|---|
| P__ |  |  |  |  |

### 4.3 Post-session question set — verbatim (protocol §6)

Ask each question exactly as written, in this order, after T7. Show the scale with the question.
Record the numeric answer (and the verbatim free text where one is requested). Do not explain
what an item "means". **The wording is reproduced verbatim from the protocol — including the word
"prototype" — so the instrument does not paraphrase it.**

**Q-WHERE (5-point)**

> **"I knew where I was and what I could do next."**

Scale: **1 = strongly disagree · 2 = disagree · 3 = neither agree nor disagree · 4 = agree ·
5 = strongly agree**. Record as `where_rating_1_5` (1–5).

**Q-UX (two 7-point UMUX-Lite items)**

> **Q-UX-1: "The prototype's capabilities meet my requirements."**
>
> **Q-UX-2: "The prototype is easy to use."**

Scale for both: **1 = strongly disagree · 2 · 3 · 4 = neither agree nor disagree · 5 · 6 ·
7 = strongly agree** (7-point).

Score: `umux_lite_score = ((item1 − 1) + (item2 − 1)) / 12 × 100`, rounded to **1 decimal place**.
Record the two raw item answers (`q_ux_item_1_7`, `q_ux_item_2_7`) and the computed score.

**Q-TRUST (5-point)**

> **"I would trust the companion to apply a change on its own, knowing I can undo exactly that
> change."**

Scale: **1 = strongly disagree · 2 = disagree · 3 = neither agree nor disagree · 4 = agree ·
5 = strongly agree**. Record as `trust_autoapply_1_5` (1–5).

**Q-SYS (same system vs. separate app)**

> **"When the companion made that change — was that part of the same system you were already
> using, or a separate app?"**

Record `same_system`:
- `true` — the participant describes the companion change as part of the same system;
- `false` — the participant describes it as a separate app or a separate thing.

Also record the participant's **verbatim reason** ("why?") in `same_system_why`. Ambiguity
resolves to the participant's own words, not the moderator's interpretation.

**Q-RECALL (open, after the distractor)**

> **"Tell me everything you remember you could do in this prototype — name as many actions or
> places as you can."**

Open answer, recorded verbatim. No prompts, no list, no "anything else?" loop beyond one neutral
follow-up. This question is the T7 recall measurement; it is asked before Q-WHERE.

## 5. Stage 1 — Gate H: collect participant notes (human-only)

Gate H is **human-only**. No agent may run, simulate or fabricate a session, and no agent ever
writes into the input file.

1. **Create the input file by copying the template.** The facilitator copies
   `spikes/3115-navigation-engine/session-kit/gate-h-input-template.md` to
   `.opencode/tmp/3115/sessions/participant-notes.md` (creating the directory if needed).
2. **One block per completed participant**, using the template's field names exactly. A
   `completed_participant` is a participant with `consent_recorded: true` and `tasks_completed`
   ≥ 1.
3. **Consent gate.** `consent_recorded` must be `true` for a participant's data to be used at all.
   **A participant without recorded consent contributes no row** — not to the per-task table, not
   to the summary table, not to a quote — and their block is not transcribed. Recording is a
   separate, opt-in choice that defaults to **no**.
4. **Identifiers only.** Participants are referenced **only** as `P1`, `P2`, … `P8`. Never record
   a name, email, handle, employer, organisation, team, location or any other identifying detail
   — not in the raw file, not in a quote, not in a note. A quote that would identify someone is
   trimmed to the relevant clause. The link between `P<n>` and a real person lives only with the
   human facilitator and is never committed.
5. **Every field filled.** The mix fields, `consent_recorded`, `tasks_completed`, the ratings, the
   undo and same-system outcomes, and one T1–T7 row per task with its `success_unaided`,
   `time_s`, `errors`, `discovery_source` and `discovery_note`; plus the T6 observed outcomes
   (§4.2).
6. **At least one verbatim, anonymised quote per participant** (`quote_2` preferred).
7. **`helped_or_hindered`** is required when `keyboard_profile = non-vim` — one explicit sentence
   on whether the place model helped or hindered that participant.
8. **No example rows.** Do not add example rows, sample answers, ratings or quotes to the input
   file.

The raw file stays in `.opencode/tmp/3115/sessions/` (gitignored) until transcription is
confirmed, then it is deleted at cleanup. The raw file is written by the human facilitator only —
never by an agent.

## 6. Stage 2 — transcription procedure

Transcribe the anonymised content from `.opencode/tmp/3115/sessions/participant-notes.md` into
this document, in this order:

1. Compute `completed_participants` — the number of per-participant summary rows (§7.1) with
   `consent_recorded = true` **and** `tasks_completed >= 1`. A participant counts once. A session
   with no recorded consent contributes nothing. A participant who completed at least one task
   still counts even if they later abandoned a task (including T6).
2. Fill the **per-participant summary table** (§7.1) — one row per completed participant, ids
   `P1`…`P8` unique and never reused.
3. Fill the **per-task table** (§7.2) — one row per participant × task, T1–T7, with the mix fields
   repeated verbatim from that participant's summary row (the summary row is authoritative; the
   repeat keeps each task row self-contained so no join is needed to recompute a quota).
4. Fill the **T6 observed outcomes** (§4.2).
5. Fill the **cohort report** (§3.2) and confirm every quota in §3.1 holds over completed,
   consented participants.
6. Fill the **three RQ evidence rows** (§9) with attributed rows cited from the tables and at
   least two attributed verbatim quotes each.
7. **Recompute the six gate lines** (§8) from the two tables and record the fraction, the value
   and whether each line is met.
8. For every failed line, record the fraction, **what participants actually did instead** (from
   the per-task `discovery_source` / `discovery_note` evidence) and **one concrete redesign
   hypothesis** (§11).
9. Write the single outcome line (§11).
10. **Mirror that outcome as a `## Status` comment on issue #3120**, together with the
    per-participant table and the six recomputed gate lines. **#3121 must not start without a
    recorded `GO`.**
11. Confirm the transcription, then delete the raw file at cleanup. This committed document is the
    durable evidence; no participant data may live only in `.opencode/tmp/`.

## 7. Metric columns and data tables

### 7.1 Per-participant summary — columns (protocol §7.2, plus the two UMUX-Lite raw items)

| Column | Domain / definition |
|---|---|
| `participant_id` | `P1` … `P8` (unique; never reused) |
| `keyboard_profile` | `keyboard-first` \| `non-vim` |
| `vim_comfortable` | `yes` \| `no` |
| `wireframe_new` | `yes` \| `no` (`yes` = had never used Wireframe before this session) |
| `consent_recorded` | `true` (required); a participant without consent contributes no row |
| `tasks_completed` | integer 0–7 (tasks the participant finished, aided or unaided) |
| `where_rating_1_5` | Q-WHERE answer, 1–5 |
| `q_ux_item_1_7` | Q-UX-1 raw answer, 1–7 |
| `q_ux_item_2_7` | Q-UX-2 raw answer, 1–7 |
| `umux_lite_score` | `((item1 − 1) + (item2 − 1)) / 12 × 100`, rounded to 1 decimal place |
| `trust_autoapply_1_5` | Q-TRUST answer, 1–5 |
| `undo_first_attempt_success` | `true` \| `false` — `false` if the first T6 undo attempt did not restore exactly the named property |
| `same_system` | `true` \| `false` — from Q-SYS (the instruction box / companion change read as the same system vs a separate app) |
| `same_system_why` | the participant's verbatim reason for the Q-SYS answer |
| `quote_1` / `quote_2` | verbatim, anonymised (no names/orgs); `quote_1` required, `quote_2` preferred |
| `helped_or_hindered` | required when `keyboard_profile = non-vim` — one explicit sentence on whether the place model helped or hindered |

> The metric key `launcher_same_system` in the protocol's gate line (§8, GO-4) is the **same
> measurement**; it is labelled `same_system` here because the conversation surface is the
> teleport-attached instruction box, not the launcher. The gate line itself is reproduced
> verbatim in §8 and its key is never renamed there.

**Fill-in table.** One row per completed participant. The single `P__` row below is an **empty
placeholder** — repeat it once per participant and replace every blank. No row in this table is
data until the human fills it.

| participant_id | keyboard_profile | vim_comfortable | wireframe_new | consent_recorded | tasks_completed | where_rating_1_5 | q_ux_item_1_7 | q_ux_item_2_7 | umux_lite_score | trust_autoapply_1_5 | undo_first_attempt_success | same_system | same_system_why | quote_1 | quote_2 | helped_or_hindered |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P__ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### 7.2 Per-task — columns (protocol §7.1) and rows T1–T7

| Column | Domain / definition |
|---|---|
| `participant_id` | `P1` … `P8` |
| `keyboard_profile` | `keyboard-first` \| `non-vim` |
| `vim_comfortable` | `yes` \| `no` |
| `wireframe_new` | `yes` \| `no` |
| `task_id` | `T1` … `T7` |
| `success_unaided` | `true` \| `false` — `false` = hint / failure / abandonment |
| `time_s` | integer seconds; `0` if the task was not completed |
| `errors` | integer count of errors + backtracks |
| `discovery_source` | `bar` \| `map` \| `composer` \| `guessing` \| `other` |
| `discovery_note` | free text; empty unless `discovery_source = other` (or to note a secondary path, a bar overflow/scroll observation, or the T6 Backspace observation) |

> **Required substitution.** The protocol's §7.1 domain is `rail | map | palette | guessing |
> other`. The left rail and the `>` palette no longer exist in the reworked experience, so this
> instrument records the first affordance as `bar | map | composer | guessing | other`. Every
> other column, and the six gate lines in §8, are unchanged.

**Fill-in table.** One row per participant × task. The `P__` block below is an **empty
placeholder** — repeat all seven rows for each completed participant and replace every blank. The
task ids are fixed and must not be renumbered or dropped.

| participant_id | keyboard_profile | vim_comfortable | wireframe_new | task_id | success_unaided | time_s | errors | discovery_source | discovery_note |
|---|---|---|---|---|---|---|---|---|---|
| P__ |  |  |  | T1 |  |  |  |  |  |
| P__ |  |  |  | T2 |  |  |  |  |  |
| P__ |  |  |  | T3 |  |  |  |  |  |
| P__ |  |  |  | T4 |  |  |  |  |  |
| P__ |  |  |  | T5 |  |  |  |  |  |
| P__ |  |  |  | T6 |  |  |  |  |  |
| P__ |  |  |  | T7 |  |  |  |  |  |

## 8. The six gate lines — verbatim (protocol §8)

These six lines are contractual and are reproduced **unchanged** from
`spikes/3115-navigation-engine/session-protocol.md` §8 — same tokens, same operators, same
thresholds. Do not re-word them. The outcome is `GO` iff all six pass.

```
GO-1  where_rating_ge4_pct = 100 * count(where_rating_1_5 >= 4) / completed_participants        >= 70
GO-2  tasks_1_5_unaided_success_pct = 100 * count(success_unaided=true, task_id in {T1..T5})
                                        / (completed_participants * 5)                          >= 80
GO-3  undo_first_attempt_pct = 100 * count(undo_first_attempt_success=true) / completed_participants  = 100
GO-4  launcher_same_system_majority = count(launcher_same_system=true) > (completed_participants / 2)
PRE-1 completed_participants >= 5
PRE-2 non_keyboard_first_completed >= 1        # AC6
```

Notes that are part of the arithmetic:

- **`completed_participants`** — the number of per-participant summary rows (§7.1) with
  `consent_recorded = true` **and** `tasks_completed >= 1`.
- **`non_keyboard_first_completed`** — the count of summary rows where
  `keyboard_profile != "keyboard-first"`.
- **GO-2 is a pooled participant × task rate**, not a per-task average: the numerator is the number
  of successful `(participant, task)` rows for T1–T5, the denominator is
  `completed_participants × 5`. State the fraction explicitly, e.g. `21/25 = 84.0%`.
- **GO-4 is strictly more than half** — n=5 → at least 3, n=6 → at least 4, n=7 → at least 4,
  n=8 → at least 5. Equal to half is a fail.
- **`launcher_same_system` in GO-4 is the Q-SYS measurement** recorded as `same_system` in §7.1
  (the key is kept verbatim above; do not rename the gate line).

### 8.1 Recompute table (fill in — empty slots only)

| gate line | numerator | denominator | fraction | value | met? |
|---|---|---|---|---|---|
| GO-1 |  |  |  |  |  |
| GO-2 |  |  |  |  |  |
| GO-3 |  |  |  |  |  |
| GO-4 |  |  |  |  |  |
| PRE-1 |  |  |  |  |  |
| PRE-2 |  |  |  |  |  |

## 9. Research-question evidence

Each research question is answered **explicitly from the per-participant data** — no RQ may be
answered by inference, and every claim cites rows in the tables above. Each RQ carries **at least
two attributed verbatim quotes** (quote slots are empty; attribution is the `P<n>` id only).

### RQ1 — Does the bottom command bar with a visible place path improve felt flow?

| # | evidence — cites table rows | reading |
|---|---|---|
| E1 |  |  |
| E2 |  |  |

- Quote 1 — `P__`: ""
- Quote 2 — `P__`: ""

### RQ2 — Does the teleport-attached instruction box feel like part of the same system as the app it changes?

| # | evidence — cites table rows | reading |
|---|---|---|
| E1 |  |  |
| E2 |  |  |

- Quote 1 — `P__`: ""
- Quote 2 — `P__`: ""

### RQ3 — Does attributed undo by description build trust in auto-apply?

| # | evidence — cites table rows | reading |
|---|---|---|
| E1 |  |  |
| E2 |  |  |

- Quote 1 — `P__`: ""
- Quote 2 — `P__`: ""

## 10. The P1 comparator

The comparator is the **documented qualitative flat-key baseline** plus the **six thresholds** in
§8. It is **not** a numeric participant baseline, because **P1 produced no participant rows**: no
sessions were run in #3115 (`docs/UX_FLUENCY_RESEARCH.md:544`, `:550-552`, `:614`), so a measured
"improvement over P1" would be false (`docs/NAVIGATION_ENGINE.md:544`).

| comparator | value | source |
|---|---|---|
| Flat-key surface (qualitative baseline) | 36 simultaneous bindings, hidden mode set | `docs/UX_FLUENCY_RESEARCH.md:561-563` (§3 teardown, §8.1) |
| P1 numeric participant baseline | **none** — P1 produced no participant rows | `docs/UX_FLUENCY_RESEARCH.md:544, 550-552, 614`; `docs/NAVIGATION_ENGINE.md:544` |
| Thresholds applied to the pilot | the six gate lines in §8 | `spikes/3115-navigation-engine/session-protocol.md` §8 |

**Do not invent a P1 numeric baseline.** Do not render a P1 column with a number, an estimated
value or an interim percentage. The pilot's numbers stand on their own against the fixed
thresholds; the comparison to the flat-key surface is qualitative and is stated as such.

## 11. Outcome procedure

- **`GO` iff `PRE-1 ∧ PRE-2 ∧ GO-1 ∧ GO-2 ∧ GO-3 ∧ GO-4`.** Any miss is `NO-GO` / REDESIGN.
- For **each failed line**, record its fraction, **what participants actually did instead** (drawn
  from the per-task `discovery_source` / `discovery_note` evidence, not from the moderator's
  summary memory) and **one concrete redesign hypothesis**.
- `NO-GO` is a **valid, decision-enabling research outcome**, not a pipeline failure and not an
  instruction to retry until the numbers turn.
- Write the outcome **once**, as the single line below, replacing nothing else:

```
Verdict: GO|NO-GO
```

- **Mirror that line as a `## Status` comment on issue #3120**, together with the per-participant
  table and the six recomputed gate lines. An outcome that exists only in this file is not
  recorded. **#3121 must not start without a recorded `GO`.**

### 11.1 Failed-line record (fill in only if a line fails)

| failed line | fraction | what participants did instead (discovery evidence) | one concrete redesign hypothesis |
|---|---|---|---|
|  |  |  |  |

## 12. Deviations and session integrity

- Record every departure from the kit — a reduced session length, an extra task, an interruption,
  a browser quirk, a prototype reset, a demonstrated teleport gesture — with its reason.
  Deviations are recorded, never silently absorbed.
- No audio, video, screen capture or transcript is retained without explicit written consent; the
  default is no recording.
- Participants are `P1`–`P8` only. This document must contain no identifying detail.
- This document must contain no participant data until the human fills it. If a committed revision
  of this file ever shows participant rows, ratings, quotes or an outcome, that content is
  human-produced and its provenance is the facilitator's raw notes — never the pipeline.

---

*Instrument authored by the #3120 pipeline (ST-9). Instruments only: every participant datum and
the verdict are supplied by the human facilitator. The pipeline does not run Gate H.*
