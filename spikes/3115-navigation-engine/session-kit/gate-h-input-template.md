# Gate H — Participant Notes

<!--
  HUMAN-ONLY INPUT FILE TEMPLATE. No agent may fill this in, and no value here may be
  invented. The facilitator copies this file to
  `.opencode/tmp/3115/sessions/participant-notes.md` and fills one completed-participant
  block per person. See `spikes/3115-navigation-engine/session-protocol.md` for the normative
  task script, question set, metric definitions and gate arithmetic.

  Rules:
  - Participants are referenced ONLY as P1, P2, ... P8. Never write a name, email, handle,
    employer, organisation or any identifying detail.
  - `consent_recorded` must be `true` for the participant's data to be used. A participant
    without recorded consent contributes no row — delete or leave their block untranscribed.
  - Recording is opt-in and defaults to no. Do not record audio/video/screen without explicit
    written consent.
  - Leave a field blank only while the session is in progress; a finished block has no blanks.
  - Do not add example rows, sample answers, ratings or quotes to this file.
-->

## Completed participant

<!--
  Repeat this entire section (heading through `## Quotes`) once per participant.
  `completed_participant` = a participant with `consent_recorded: true` and
  `tasks_completed` >= 1. Order blocks by participant_id.
-->

### Participant

<!--
  participant_id: P1 ... P8. Unique; never reused. This is the only identifier used anywhere.
  keyboard_profile: keyboard-first | non-vim   (mutually exclusive values)
  vim_comfortable: yes | no                     (independent of keyboard_profile)
  wireframe_new: yes | no                       (yes = never used Wireframe before this session)
  consent_recorded: true | false                (false => this block contributes NO row)
  tasks_completed: 0-7                          (tasks finished, aided or unaided)
-->

participant_id: P__
keyboard_profile: ____
vim_comfortable: ____
wireframe_new: ____
consent_recorded: ____
tasks_completed: __

<!--
  where_rating_1_5: Q-WHERE answer, 1-5.
  q_ux_item_1_7 / q_ux_item_2_7: the two 7-point UMUX-Lite item answers, 1-7.
  umux_lite_score: ((item1 - 1) + (item2 - 1)) / 12 * 100, rounded to 1 decimal place.
  trust_autoapply_1_5: Q-TRUST answer, 1-5.
  undo_first_attempt_success: true | false  (false if the first T6 undo attempt did not
    restore exactly the named property).
  launcher_same_system: true | false          (Q-SYS: true = same system, false = separate app).
  launcher_same_system_why: the participant's verbatim reason for the Q-SYS answer.
  quote_1 / quote_2: verbatim, anonymised (no names/orgs). quote_1 required; quote_2 preferred.
  helped_or_hindered: REQUIRED when keyboard_profile is non-vim — one explicit sentence on
    whether the place model helped or hindered this participant.
-->

where_rating_1_5: __
q_ux_item_1_7: __
q_ux_item_2_7: __
umux_lite_score: __
trust_autoapply_1_5: __
undo_first_attempt_success: ____
launcher_same_system: ____
launcher_same_system_why: ____
quote_1: ""
quote_2: ""
helped_or_hindered: ____

### Per-task rows (T1-T7)

<!--
  One row per task, T1 through T7. Keep the task ids exactly as written.

  success_unaided: true | false   (false = hint / failure / abandonment)
  time_s: integer seconds; 0 if the task was not completed
  errors: integer count of errors + backtracks
  discovery_source: rail | map | palette | guessing | other
  discovery_note: free text; empty unless discovery_source is other (or to note a second path)

  T7 (recall) has no affordance path: record whether the participant recalled anything
  unaided, time_s of the recall answer, and errors = 0 unless the answer was prompted.
-->

| task_id | success_unaided | time_s | errors | discovery_source | discovery_note |
|---|---|---|---|---|---|
| T1 |  |  |  |  |  |
| T2 |  |  |  |  |  |
| T3 |  |  |  |  |  |
| T4 |  |  |  |  |  |
| T5 |  |  |  |  |  |
| T6 |  |  |  |  |  |
| T7 |  |  |  |  |  |

### Notes

<!--
  Free text: think-aloud observations, the participant's guesses after "what would you try?",
  the distractor used and its actual duration, and every deviation from the script or the
  expected environment. Record an accidental prototype reset (reload) here as a deviation,
  naming the task it interrupted. Never record identifying details.
-->

### Quotes

<!--
  Verbatim, anonymised quotes (at least one; two preferred). Quotes may also be repeated in
  the fields above — keep them identical. No names, emails, handles or organisations.
-->
