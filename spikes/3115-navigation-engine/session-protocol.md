# Session Protocol — Navigation Engine Usability Spike

> **NORMATIVE SOURCE.** This file is the single source of truth for the moderated sessions in
> Issue #3115. The report (`docs/UX_FLUENCY_RESEARCH.md`) points here for the task script and
> question set; Phase P6 reuses this file **verbatim** when it re-measures the pilot. Do not
> paraphrase, reorder or "improve" the task text, the question text or the gate lines — every
> quoted block below is contractual.

---

## 1. Purpose and scope

The sessions test whether a **place-based navigation model** (declared place tree, object-first
verbs, a place rail with a breadcrumb, a `?` map, a launcher-centred conversation, and attributed
auto-apply with undo) feels like one coherent system to people who are not its authors.

- **Surface under test:** the throwaway static prototype only —
  `spikes/3115-navigation-engine/prototype/index.html`, opened directly from `file://`. The
  sessions never touch the shipped Fredo app, and the prototype is deleted whole at P8.
- **Session length:** **30–40 minutes** per participant, one participant per session.
- **Method:** moderated usability sessions. Each participant attempts the same seven tasks in the
  same order while thinking aloud; the moderator observes, records, and does not teach.
- **Recording:** **no audio, video, screen capture or transcript is retained without explicit
  written consent.** The default is **no recording**. If a participant declines recording, the
  moderator works from handwritten notes only and the session proceeds normally.
- **What the sessions do not measure:** this is not an A/B test against the shipped Wireframe.
  There is no controlled baseline; the shipped flat-key surface enters the analysis only as the
  documented qualitative comparator in the report's teardown. No "improvement over the shipped UI"
  claim may be based on these sessions.
- **Instrumentation:** the prototype emits **no telemetry, no logging and no `localStorage`**.
  Every observation in the metrics tables is a moderator observation recorded by hand. There is
  no machine log to reconcile against.

## 2. Participants, consent and anonymisation

### 2.1 Identity

- Participants are referenced **only** as `P1`, `P2`, … `P8`. That id is the sole key used in the
  input file, the metrics tables, the notes and the report appendix.
- **Never record** a participant's name, email address, handle, employer, organisation, team,
  location or any other identifying detail — not in the raw input file, not in a quote, not in a
  note. A quote that would identify someone is trimmed to the relevant clause.
- The link between `P<n>` and a real person lives only with the human facilitator and is never
  committed to this repository.

### 2.2 Consent

- Before the session the facilitator reads the consent statement and records the outcome as
  `consent_recorded` on the participant's block.
- `consent_recorded` must be **`true`** for a participant's data to be used at all. **A participant
  without recorded consent contributes no row** — not to the per-task table, not to the summary
  table, not to a quote. Their block is not transcribed.
- **Recording is a separate, opt-in choice and defaults to `no`.** A participant may consent to
  anonymous data use and still decline recording; that is a normal session.
- A participant may stop at any time. A stopped session is recorded as incomplete: it contributes
  no completed row (see `tasks_completed` and `completed_participants` in §7 and §8).

### 2.3 Data handling

- The raw input file is `.opencode/tmp/3115/sessions/participant-notes.md` (gitignored). It is
  **written by the human facilitator only — never by an agent**.
- Anonymised content is transcribed into the committed report appendix; the raw file is deleted at
  cleanup. No participant data lives only in `.opencode/tmp/`.

## 3. Recruitment and participant mix (quota)

- **5–8 participants**, with a **minimum of 5 completed** (see PRE-1 in §8).
- The mix is deliberate and fixed. Quotas are evaluated over the per-participant summary rows
  (§7.2), i.e. over completed, consented participants:

```
keyboard_first_or_vim = count(keyboard_profile=="keyboard-first" OR vim_comfortable=="yes") >= 2
non_vim               = count(keyboard_profile=="non-vim" AND vim_comfortable=="no") >= 2
wireframe_new         = count(wireframe_new=="yes") >= 2
```

- The three categories are **not mutually exclusive**: a `non-vim` participant may also be
  `wireframe_new`. A single person can therefore satisfy more than one quota, which is why all
  three quotas are **satisfiable at n = 5**. Do not recruit extra people to "cover" a category that
  an existing participant already covers.
- `keyboard_profile` ∈ `keyboard-first` | `non-vim` (mutually exclusive values).
  `vim_comfortable` ∈ `yes` | `no` (independent of `keyboard_profile`).
  `wireframe_new` ∈ `yes` | `no`, where `yes` means the participant had **never used Wireframe
  before this session**.

## 4. Moderator rules

The moderator's job is to create the conditions for observation, not to help, teach or rescue.

1. **Fixed script.** Read each task from §5 exactly as written, one at a time, in order. Do not
   paraphrase, reorder, explain, or add examples. Do not show the participant this file.
2. **Think aloud.** Open the session with: *"Please say out loud what you are looking at and what
   you are trying to do as you go."* Prompt for continued narration with neutral phrases
   (*"what are you thinking?"*), never with direction.
3. **Never teach keys.** The moderator must not name, hint at or point at a key, and must not
   describe where an action lives. The inline keys rendered next to on-screen actions are part of
   the model under test and are intentionally visible; the moderator does not draw attention to
   them.
4. **Ask, then record, then wait.** If the participant asks for help or stalls, the moderator says
   **"what would you try?"**, **records the participant's guess verbatim** in the notes, and only
   then may repeat the task. This is the only sanctioned intervention.
5. **Mark unaided success honestly.** Set `success_unaided = false` for a task as soon as **any**
   of these happens: a hint is given, the participant reports failure, or the participant
   abandons the task (including giving up to move on). A task completed only after a hint is
   `false`. There is no partial credit.
6. **Record the first affordance used.** For every task, record which surface the participant
   first used to look for or perform the action: `discovery_source` ∈ `rail` | `map` | `palette` |
   `guessing` | `other`. `other` requires `discovery_note` free text; the note may also be used to
   record a secondary path.
7. **Note deviations.** Anything that departs from the script or the expected environment — an
   interruption, an extra task, a participant who arrives late, a browser quirk, a reset (see
   rule 8) — is written into that participant's `## Notes` block with a one-line description.
8. **No persistence — an accidental reset is a deviation.** Reloading `index.html` restores the
   **load state**; the prototype stores nothing. A reload is a **recovery action only, never a
   task path**. If the participant accidentally triggers a reload (or the browser does), record it
   as a deviation and note which task it interrupted; do not silently restart the clock or the
   task list.
9. **Do not rescue the interface.** Do not fix the prototype live, do not open a dev console, do
   not explain a piece of chrome. If the prototype itself is broken, stop the session and record a
   deviation.
10. **Keep the room neutral.** Do not react to success or failure ("great", "oops", "that's
    fine"). Do not discuss the design with the participant until after the question set is done.
11. **One participant per session.** No observation of another participant, no group discussion.

## 5. Task script — verbatim, T1–T7

Read each line exactly as written. The ids (`T1`–`T7`) are the metric `task_id` values; do not
renumber or drop one.

- **T1** — Find out what you can create here, without being told any keys.
- **T2** — Create a rectangle and move it into place.
- **T3** — Align/arrange three elements.
- **T4** — Change the fill of one element.
- **T5** — Save/export your work.
- **T6** — Ask the companion to make a change, then undo exactly that change.
- **T7** — After a 5-minute distractor, say what you remember you could do (recall test).

Task order is fixed: T1 → T2 → T3 → T4 → T5 → T6 → distractor (§9) → T7. The post-session
questions (§6) are asked **after T7**, so the questionnaire never primes the recall test.

## 6. Post-session question set — verbatim

Ask each question exactly as written, in this order, after T7. Show the scale with the question.
Record the numeric answer (and the verbatim free text where one is requested). Do not explain
what an item "means".

### Q-WHERE (5-point)

> **"I knew where I was and what I could do next."**

Scale: **1 = strongly disagree · 2 = disagree · 3 = neither agree nor disagree · 4 = agree ·
5 = strongly agree**. Record as `where_rating_1_5` (1–5).

### Q-UX (two 7-point UMUX-Lite items)

> **Q-UX-1: "The prototype's capabilities meet my requirements."**
>
> **Q-UX-2: "The prototype is easy to use."**

Scale for both: **1 = strongly disagree · 2 · 3 · 4 = neither agree nor disagree · 5 · 6 ·
7 = strongly agree** (7-point).

Score: `umux_lite_score = ((item1 − 1) + (item2 − 1)) / 12 × 100`, rounded to **1 decimal place**.
Record the two raw item answers (`q_ux_item_1_7`, `q_ux_item_2_7`) and the computed score.

### Q-TRUST (5-point)

> **"I would trust the companion to apply a change on its own, knowing I can undo exactly that
> change."**

Scale: **1 = strongly disagree · 2 = disagree · 3 = neither agree nor disagree · 4 = agree ·
5 = strongly agree**. Record as `trust_autoapply_1_5` (1–5).

### Q-SYS (same system vs. separate app)

> **"When the companion made that change — was that part of the same system you were already
> using, or a separate app?"**

Record `launcher_same_system`:
- `true` — the participant describes the launcher change as part of the same system;
- `false` — the participant describes it as a separate app or a separate thing.

Also record the participant's **verbatim reason** ("why?") in `launcher_same_system_why`.
Ambiguity resolves to the participant's own words, not the moderator's interpretation.

### Q-RECALL (open, after the distractor)

> **"Tell me everything you remember you could do in this prototype — name as many actions or
> places as you can."**

Open answer, recorded verbatim. No prompts, no list, no "anything else?" loop beyond one neutral
follow-up. This question is the T7 recall measurement; it is asked before Q-WHERE.

## 7. Metrics — definitions and exact columns

The report's §7.2 and §7.3 tables use these column names and these domains exactly. Each row in
§7.3 is one participant × one task (T1–T7) or one participant summary.

### 7.1 Raw per-participant-per-task (report §7.3, one row per participant × task, T1–T7)

```
participant_id · keyboard_profile · vim_comfortable · wireframe_new · task_id ·
success_unaided · time_s · errors · discovery_source · discovery_note
```

| Column | Domain / definition |
|---|---|
| `participant_id` | `P1` … `P8` |
| `keyboard_profile` | `keyboard-first` \| `non-vim` (mutually exclusive) |
| `vim_comfortable` | `yes` \| `no` |
| `wireframe_new` | `yes` \| `no` (`yes` = had never used Wireframe before this session) |
| `task_id` | `T1` … `T7` |
| `success_unaided` | `true` \| `false` — `false` = hint / failure / abandonment |
| `time_s` | integer seconds; `0` if the task was not completed |
| `errors` | integer count of errors + backtracks |
| `discovery_source` | `rail` \| `map` \| `palette` \| `guessing` \| `other` |
| `discovery_note` | free text; empty unless `discovery_source = other` |

`wireframe_new` (and the other mix fields) repeat verbatim from that participant's summary row in
the per-task table. The summary row is authoritative; the repeat keeps each task row
self-contained so no join is needed to recompute a quota.

### 7.2 Raw per-participant summary (report §7.3, one row per completed participant)

```
participant_id · keyboard_profile · vim_comfortable · wireframe_new · consent_recorded ·
tasks_completed · where_rating_1_5 · umux_lite_score · trust_autoapply_1_5 ·
undo_first_attempt_success · launcher_same_system · quote_1 · quote_2
```

| Column | Domain / definition |
|---|---|
| `participant_id` | `P1` … `P8` (unique; never reused) |
| `keyboard_profile` | `keyboard-first` \| `non-vim` |
| `vim_comfortable` | `yes` \| `no` |
| `wireframe_new` | `yes` \| `no` |
| `consent_recorded` | `true` (required); a participant without consent contributes no row |
| `tasks_completed` | integer 0–7 (tasks the participant finished, aided or unaided) |
| `where_rating_1_5` | Q-WHERE answer, 1–5 |
| `umux_lite_score` | `((item1 − 1) + (item2 − 1)) / 12 × 100`, 1 dp |
| `trust_autoapply_1_5` | Q-TRUST answer, 1–5 |
| `undo_first_attempt_success` | `true` \| `false` — `false` if the first T6 undo attempt did not restore exactly the named property |
| `launcher_same_system` | `true` \| `false` — from Q-SYS |
| `quote_1` / `quote_2` | verbatim, anonymised (no names/orgs); `quote_1` required, `quote_2` preferred |

### 7.3 Aggregated (report §7.2, one row per metric)

```
metric · definition · numerator · denominator · value_pct · threshold · met
```

`value_pct` and `met` are derived from the raw rows; the definition column must state the
arithmetic used so a reader can recompute it.

## 8. Go/no-go gate lines — verbatim

These six lines are contractual. Reproduce them in the report's §9.1 unchanged; the verdict is
`GO` iff all six pass.

```
GO-1  where_rating_ge4_pct = 100 * count(where_rating_1_5 >= 4) / completed_participants        >= 70
GO-2  tasks_1_5_unaided_success_pct = 100 * count(success_unaided=true, task_id in {T1..T5})
                                        / (completed_participants * 5)                          >= 80
GO-3  undo_first_attempt_pct = 100 * count(undo_first_attempt_success=true) / completed_participants  = 100
GO-4  launcher_same_system_majority = count(launcher_same_system=true) > (completed_participants / 2)
PRE-1 completed_participants >= 5
PRE-2 non_keyboard_first_completed >= 1        # AC6
```

Definitions:

- **`completed_participants`** — the number of per-participant summary rows (§7.2) with
  `consent_recorded = true` **and** `tasks_completed >= 1`. A participant counts once. A session
  with no recorded consent contributes nothing. A participant who completed at least one task
  still counts even if they later abandoned a task (including T6).
- **`non_keyboard_first_completed`** — the count of summary rows where
  `keyboard_profile != "keyboard-first"` (i.e. the `non-vim` value). This is the AC6 cross-check
  behind PRE-2. `keyboard_profile` and `wireframe_new` are independent, so one `non-vim`
  participant may also be `wireframe_new` and satisfy both PRE-2 and the `wireframe_new` quota.
- **GO-2 is a pooled participant × task rate.** The numerator is the number of successful
  `(participant, task)` rows for T1–T5; the denominator is `completed_participants × 5`. It is
  **not** a per-task average. State the fraction explicitly, e.g. `21/25 = 84.0%`.
- **GO-4 is strictly more than half.** `count(launcher_same_system=true)` must be `>` half of
  `completed_participants` — n=5 → at least 3, n=6 → at least 4, n=7 → at least 4, n=8 → at
  least 5. Equal to half is a fail.
- **GO** iff `PRE-1` ∧ `PRE-2` ∧ `GO-1` ∧ `GO-2` ∧ `GO-3` ∧ `GO-4`.
- **NO-GO** otherwise. The report must list **each failed line** with its fraction, **what
  participants actually did instead** (drawn from the per-task `discovery_source` /
  `discovery_note` evidence), and **one concrete redesign hypothesis**. NO-GO is a valid,
  successful research outcome; it is not a failure to be retried until the numbers turn.

The tester recomputes all six lines from the §7.2/§7.3 tables and asserts the report's §9.2
matches. Any mismatch is a FAIL.

## 9. The distractor (between T6 and T7)

After T6 the moderator starts a **five-minute neutral break**:

- The participant **does not use the prototype** during the break and does not discuss the study.
- A neutral, unrelated activity is used — a short walk, a drink, or a short non-product
  demographic/background conversation written in advance. Nothing that rehearses the tasks.
- The moderator does not summarise, recap, hint or show anything from the prototype during or
  after the break.
- Record the distractor used and its actual duration in the participant's `## Notes`.
- At the end of the break the moderator returns to the prototype **exactly as the participant
  left it** and asks T7 / Q-RECALL. Nothing is reset, re-opened, summarised or highlighted for
  the participant.

## 10. Human-input contract (Gate H)

Gate H is **human-only**. No agent may run, simulate or fabricate a session, and no agent ever
writes into the input file.

1. **Create the input file by copying the template.** The facilitator copies
   `spikes/3115-navigation-engine/session-kit/gate-h-input-template.md` to
   `.opencode/tmp/3115/sessions/participant-notes.md` (creating the directory if needed).
2. **One block per participant**, using the template's field names exactly.
3. **Every field above must be filled** — the mix fields, `consent_recorded`, `tasks_completed`,
   the ratings, the undo and launcher outcomes, and one T1–T7 row per task with its
   `success_unaided`, `time_s`, `errors`, `discovery_source` and `discovery_note`.
4. **At least one verbatim quote per participant** (`quote_2` preferred), anonymised — no names,
   emails, handles or organisations.
5. **Any non-keyboard-first participant** (`keyboard_profile = non-vim`) also gets one explicit
   sentence in `helped_or_hindered` saying whether the place model helped or hindered them, in
   the participant's or the moderator's words as marked.
6. The raw file stays in `.opencode/tmp/3115/sessions/` (gitignored) until the transcription into
   the report is confirmed, then it is deleted at cleanup. The committed report is the durable
   evidence.
