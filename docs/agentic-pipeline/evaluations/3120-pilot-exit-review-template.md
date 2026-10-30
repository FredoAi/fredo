# Pilot Exit Review — NavigationEngine P6 (#3120)

> **PARTICIPANT DATA IS HUMAN-PRODUCED, NEVER PIPELINE-PRODUCED.**
> This file is a **committed, durable template**. It ships with **no participant data, no
> ratings, no quotes, no prefilled verdict and no fabricated rows** — every data cell below is an
> empty slot. Only the **human facilitator** fills it, from sessions the human ran. No agent may
> run, simulate, transcribe or fabricate a session, and no agent may write participant data into
> this file or into the Gate H input file. The pipeline's deliverable is the instrument; the
> evidence and the verdict belong to the human.

---

## 1. Status of this document

| Field | State as committed by #3120 |
|---|---|
| Deliverable | This template — the pilot-exit-review instrument |
| Participant rows | **none** (empty slots only) |
| Ratings / quotes / answers | **none** |
| Gate outcome | **not computed** — the six lines are reproduced verbatim, unscored |
| Verdict | **none** — a single template line exists in §10 with both options |
| Filled by | The human facilitator, after the sessions |
| Source of truth for method | `spikes/3115-navigation-engine/session-protocol.md` (reused **verbatim**) |

The method — task script T1–T7, question set (Q-WHERE, the two UMUX-Lite items, Q-TRUST, Q-SYS,
Q-RECALL), metric definitions, distractor and the six gate lines — lives **only** in
`spikes/3115-navigation-engine/session-protocol.md`. That file is reused **unchanged** by this
spec (AC-G1): #3120 **did not edit it**, and this document does not paraphrase, reorder or
"improve" any of its contractual text. Where this template and the protocol could differ, **the
protocol wins**.

## 2. This issue is the pilot gate (AC-G6)

**#3120 is the pilot gate.** #3115's numeric GO/NO-GO gate was **deferred to this issue** — the
human chose to test real users on the real Wireframe pilot (Wireframe + launcher + companion +
trail) rather than a greybox prototype. The deferral was a **scope decision, not a failed gate**:
no threshold was missed and no result was suppressed in #3115.

The human's `GO` / `NO-GO` recorded against this document **is** the program's fleet-migration
decision. #3121 (fleet migration) must not be dispatched, planned or started on `NO-GO` without an
explicit, recorded human decision to proceed anyway. On `GO`, #3121 becomes dispatchable in normal
dependency order.

## 3. Session requirement and participant mix (AC-G1, AC-G2)

- **5–8 participants**, with a **minimum of 5 completed**.
- Each session is **30–40 minutes**, one participant per session, moderated think-aloud, on the
  **real pilot** (Wireframe + launcher + companion + trail), following the #3115 protocol
  unchanged.
- The **task set** is the protocol's verbatim T1–T7 script; the **question set** is the protocol's
  verbatim Q-WHERE, Q-UX-1, Q-UX-2 (UMUX-Lite), Q-TRUST, Q-SYS and Q-RECALL; the **metric
  columns** are the protocol's §7 columns reproduced in §6 of this document.
- Any deviation from the kit must be recorded explicitly with its reason (see §11).

### 3.1 Cohort quota (AC-G2) — reproduced verbatim from the protocol's §3

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
  **complete** the task set (PRE-2 in §7).
- **Per-cohort results are required** (§3.2). **No finding may rest on keyboard-first
  participants alone**, and a cohort with a single member must not be generalised.

### 3.2 Per-cohort report (fill in — one row per cohort, empty slots only)

| cohort (non-exclusive) | participant_ids | n | where_rating ≥ 4 | T1–T5 unaided successes | undo first-attempt successes | same-system count | cohort finding |
|---|---|---|---|---|---|---|---|
| keyboard-first or vim-comfortable |  |  |  |  |  |  |  |
| non-vim |  |  |  |  |  |  |  |
| new to Wireframe |  |  |  |  |  |  |  |
| non-keyboard-first, completed |  |  |  |  |  |  |  |

## 4. Stage 1 — Gate H: collect participant notes (human-only)

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
   a name, email, handle, employer, organisation, team, location or any other identifying detail —
   not in the raw file, not in a quote, not in a note. A quote that would identify someone is
   trimmed to the relevant clause. The link between `P<n>` and a real person lives only with the
   human facilitator and is never committed.
5. **Every field filled.** The mix fields, `consent_recorded`, `tasks_completed`, the ratings, the
   undo and launcher outcomes, and one T1–T7 row per task with its `success_unaided`, `time_s`,
   `errors`, `discovery_source` and `discovery_note`.
6. **At least one verbatim, anonymised quote per participant** (`quote_2` preferred).
7. **`helped_or_hindered`** is required when `keyboard_profile = non-vim` — one explicit sentence
   on whether the place model helped or hindered that participant.
8. **No example rows.** Do not add example rows, sample answers, ratings or quotes to the input
   file.

The raw file stays in `.opencode/tmp/3115/sessions/` (gitignored) until transcription is
confirmed, then it is deleted at cleanup. The raw file is written by the human facilitator only —
never by an agent.

## 5. Stage 2 — transcription procedure

Transcribe the anonymised content from `.opencode/tmp/3115/sessions/participant-notes.md` into
this document, in this order:

1. Compute `completed_participants` — the number of per-participant summary rows (§6.1) with
   `consent_recorded = true` **and** `tasks_completed >= 1`. A participant counts once. A session
   with no recorded consent contributes nothing. A participant who completed at least one task
   still counts even if they later abandoned a task (including T6).
2. Fill the **per-participant summary table** (§6.1) — one row per completed participant, ids
   `P1`…`P8` unique and never reused.
3. Fill the **per-task table** (§6.2) — one row per participant × task, T1–T7, with the mix fields
   repeated verbatim from that participant's summary row (the summary row is authoritative; the
   repeat keeps each task row self-contained so no join is needed to recompute a quota).
4. Fill the **cohort report** (§3.2) and confirm every quota in §3.1 holds over completed,
   consented participants.
5. Fill the **three RQ evidence rows** (§8) with attributed rows cited from the tables and at least
   two attributed verbatim quotes each.
6. **Recompute the six gate lines** (§7) from the two tables and record the fraction, the value and
   whether each line is met.
7. For every failed line, record the fraction, **what participants actually did instead** (from
   the per-task `discovery_source` / `discovery_note` evidence) and **one concrete redesign
   hypothesis** (§10).
8. Write the single verdict line (§10).
9. **Mirror the verdict as a `## Status` comment on issue #3120**, together with the per-participant
   table and the six recomputed gate lines (AC-G5).
10. Confirm the transcription, then delete the raw file at cleanup. This committed document is the
    durable evidence; no participant data may live only in `.opencode/tmp/`.

## 6. Metric columns and data tables

### 6.1 Per-participant summary — columns (protocol §7.2, plus the two UMUX-Lite raw items)

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
| `launcher_same_system` | `true` \| `false` — from Q-SYS |
| `launcher_same_system_why` | the participant's verbatim reason for the Q-SYS answer |
| `quote_1` / `quote_2` | verbatim, anonymised (no names/orgs); `quote_1` required, `quote_2` preferred |
| `helped_or_hindered` | required when `keyboard_profile = non-vim` — one explicit sentence on whether the place model helped or hindered |

**Fill-in table.** One row per completed participant. The single `P__` row below is an **empty
placeholder** — repeat it once per participant and replace every blank. No row in this table is
data until the human fills it.

| participant_id | keyboard_profile | vim_comfortable | wireframe_new | consent_recorded | tasks_completed | where_rating_1_5 | q_ux_item_1_7 | q_ux_item_2_7 | umux_lite_score | trust_autoapply_1_5 | undo_first_attempt_success | launcher_same_system | launcher_same_system_why | quote_1 | quote_2 | helped_or_hindered |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P__ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### 6.2 Per-task — columns (protocol §7.1) and rows T1–T7

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
| `discovery_source` | `rail` \| `map` \| `palette` \| `guessing` \| `other` |
| `discovery_note` | free text; empty unless `discovery_source = other` (or to note a secondary path) |

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

## 7. The six gate lines — verbatim (protocol §8)

These six lines are contractual and are reproduced **unchanged** from
`spikes/3115-navigation-engine/session-protocol.md` §8 — same tokens, same operators, same
thresholds. Do not re-word them. The verdict is `GO` iff all six pass.

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

- **`completed_participants`** — the number of per-participant summary rows (§6.1) with
  `consent_recorded = true` **and** `tasks_completed >= 1`.
- **`non_keyboard_first_completed`** — the count of summary rows where
  `keyboard_profile != "keyboard-first"`.
- **GO-2 is a pooled participant × task rate**, not a per-task average: the numerator is the number
  of successful `(participant, task)` rows for T1–T5, the denominator is
  `completed_participants × 5`. State the fraction explicitly, e.g. `21/25 = 84.0%`.
- **GO-4 is strictly more than half** — n=5 → at least 3, n=6 → at least 4, n=7 → at least 4,
  n=8 → at least 5. Equal to half is a fail.

### 7.1 Recompute table (fill in — empty slots only)

| gate line | numerator | denominator | fraction | value | met? |
|---|---|---|---|---|---|
| GO-1 |  |  |  |  |  |
| GO-2 |  |  |  |  |  |
| GO-3 |  |  |  |  |  |
| GO-4 |  |  |  |  |  |
| PRE-1 |  |  |  |  |  |
| PRE-2 |  |  |  |  |  |

## 8. Research-question evidence (AC-G3)

Each research question is answered **explicitly from the per-participant data** — no RQ may be
answered by inference, and every claim cites rows in the tables above. Each RQ carries **at least
two attributed verbatim quotes** (quote slots are empty; attribution is the `P<n>` id only).

### RQ1 — Does the place tree improve felt flow?

| # | evidence — cites table rows | reading |
|---|---|---|
| E1 |  |  |
| E2 |  |  |

- Quote 1 — `P__`: ""
- Quote 2 — `P__`: ""

### RQ2 — Does launcher-only conversation feel connected?

| # | evidence — cites table rows | reading |
|---|---|---|
| E1 |  |  |
| E2 |  |  |

- Quote 1 — `P__`: ""
- Quote 2 — `P__`: ""

### RQ3 — Does auto-apply with visible undo build trust?

| # | evidence — cites table rows | reading |
|---|---|---|
| E1 |  |  |
| E2 |  |  |

- Quote 1 — `P__`: ""
- Quote 2 — `P__`: ""

## 9. The P1 comparator (R-8.4)

The comparator is the **documented qualitative flat-key baseline** plus the **six thresholds** in
§7. It is **not** a numeric participant baseline, because **P1 produced no participant rows**: no
sessions were run in #3115 (`docs/UX_FLUENCY_RESEARCH.md:544`, `:550-552`, `:614`), so a measured
"improvement over P1" would be false (`docs/NAVIGATION_ENGINE.md:544`).

| comparator | value | source |
|---|---|---|
| Flat-key surface (qualitative baseline) | 36 simultaneous bindings, hidden mode set | `docs/UX_FLUENCY_RESEARCH.md:561-563` (§3 teardown, §8.1) |
| P1 numeric participant baseline | **none** — P1 produced no participant rows | `docs/UX_FLUENCY_RESEARCH.md:544, 550-552, 614`; `docs/NAVIGATION_ENGINE.md:544` |
| Thresholds applied to the pilot | the six gate lines in §7 | `spikes/3115-navigation-engine/session-protocol.md` §8 |

**Do not invent a P1 numeric baseline.** Do not render a P1 column with a number, an estimated
value or an interim percentage. The pilot's numbers stand on their own against the fixed
thresholds; the comparison to the flat-key surface is qualitative and is stated as such.

## 10. Verdict procedure (AC-G4, AC-G5)

- **`GO` iff `PRE-1 ∧ PRE-2 ∧ GO-1 ∧ GO-2 ∧ GO-3 ∧ GO-4`.** Any miss is `NO-GO` / REDESIGN.
- For **each failed line**, record its fraction, **what participants actually did instead** (drawn
  from the per-task `discovery_source` / `discovery_note` evidence, not from the moderator's
  summary memory) and **one concrete redesign hypothesis**.
- `NO-GO` is a **valid, decision-enabling research outcome**, not a pipeline failure and not an
  instruction to retry until the numbers turn.
- Write the verdict **once**, as the single line below, replacing nothing else:

```
Verdict: GO|NO-GO
```

- **Mirror that verdict as a `## Status` comment on issue #3120**, together with the
  per-participant table and the six recomputed gate lines. A verdict that exists only in this file
  is not recorded (AC-G5).
- #3121 stays blocked until a recorded `GO` (or an explicit, recorded human decision to proceed on
  `NO-GO`).

### 10.1 Failed-line record (fill in only if a line fails)

| failed line | fraction | what participants did instead (discovery evidence) | one concrete redesign hypothesis |
|---|---|---|---|
|  |  |  |  |

## 11. Deviations and session integrity

- Record every departure from the kit — a reduced session length, an extra task, an interruption, a
  browser quirk, a prototype reset — with its reason. Deviations are recorded, never silently
  absorbed.
- No audio, video, screen capture or transcript is retained without explicit written consent; the
  default is no recording.
- Participants are `P1`–`P8` only. This document must contain no identifying detail.
- This document must contain no participant data until the human fills it. If a committed revision
  of this file ever shows participant rows, ratings, quotes or a verdict, that content is
  human-produced and its provenance is the facilitator's raw notes — never the pipeline.

---

*Template authored by the #3120 pipeline (ST-7). Instruments only: every participant datum and the
verdict are supplied by the human facilitator.*
