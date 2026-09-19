# Research Report: Measuring Pipeline Self-Improvement — Data Audit, Current-Measurement Audit, and Redesign

**Agent:** Research Analyst (multi-track audit: data engineering, statistics/measurement, software-quality research, measurement design, red team, quantitative backtest)
**Date:** 2026-09-18
**Scope:** Everything the Self-Improver (SI) reads to audit and measure the pipeline — the full SI data surface — and a redesign of how the pipeline answers the question **"are we improving?"** New instrumentation is explicitly in scope.
**Data window:** `.opencode/state/issues/*.jsonl`, 87 logs, 10,794 events, 2026-08-10 → 2026-09-18 (~5.7 weeks). Corroborated by `pipeline-state.rs --action health --json` (integrity OK).
**Method:** Six independent parallel tracks (A–F): data-surface inventory, current-measurement audit, outcome-definition research, measurement design, adversarial review, and a backtest on real history. Synthesis below; single-track claims are marked.

---

## Start Here — How To Know If We're Improving (Today)

**The honest short answer:** no single current number tells you. The pipeline records *process activity* abundantly but does **not record the outcome that matters** — whether a delivered feature was actually accepted, or had to be redone. So today you are measuring motion, not progress. Three things are true from the existing data:

1. **Quality has not measurably improved.** The most honest stable proxy — `rework` transitions per spec — is **flat**: first-10 specs mean **0.70**, last-10 mean **0.60**, trailing-10 **0.60**, EWMA **0.44**. Under Poisson noise at n=10 that gap is < 0.5σ — **indistinguishable**. The cumulative mean (1.49) is *not* improvement; it is dilution of a mid-August spike.
2. **Throughput and speed did improve.** Weekly specs entering planning rose 7 → 25 → 19; median cycle time fell from ~12 h (late August) to ~1–2 h (September). Confounded by spec size/mix, but real.
3. **The one outcome signal you actually care about is not captured.** Audit verdict is degenerate (**76 pass / 1 fail**), `done → planning` reopen fired **once**, and your real "I don't like it" signal — a follow-up spec — is an **unlinked new issue**. A red-team estimate: if revision events are truly ~0 in 76, the 95% upper bound is 3/76 ≈ **3.9%** (rule of three) — you cannot yet distinguish "0%" from "a few percent."

**What to do now (smallest viable, ~3 additive changes):**
- Record the outcome: `revises: #N` on follow-up specs (`feature.revised` event) and an `accept`/`reject` marker at human review (`human.review` event).
- Fix the two data bugs that corrupt every headline: the `#633` orchestrator log and the `#2842` bogus `storyPoints:"2842"`.
- Then read one primary number with its interval: **human-acceptance rate** (Beta posterior + 95% CI), paired with **specs shipped** and the raw counts. "Improving" = acceptance trend up **or** flat while throughput is flat/up — never a target.

Until capture lands, the usable monthly check is: **trailing-10 spec-only `rework`/spec + machine-`failure`/spec + throughput**, read as an activity trend, explicitly *not* a quality claim.

---

## Executive Summary (Top 8 Findings)

1. **The SI's data surface records process, not outcome.** Across all 8 sources (event log, metrics, health, audit bundle, verify/script-errors, GitHub comments, `references.md` G-records, observations/triage), **no source records post-merge acceptance**, and the audit gate (76/77 pass) is near-constant — it carries ~zero information about quality. *This is the root cause of "we can't tell if we're improving."*

2. **Current headline metrics are structurally misleading.** `first_pass_rate` (41.3%, 31/75) has a survivor denominator — 12/87 (13.8%) issues, many abandoned/cancelled, are silently excluded, so killing a hard issue *raises* the number. `throughput` counts issues-ever-seen over the whole corpus span, not completions. The "Little's Law CHECK REQUIRED" flag **cannot fire by construction** (`w ≤ issues` always). `root_cause_mix` is dead (0/1 failed verdicts carry `rootCause`).

3. **Two data points corrupt the numbers.** The non-spec orchestrator log `#633` contributes **1,152/1,425 (80.8%)** of `blocked` and **1,152/1,689 (68%)** of `failures`. The bogus `#2842 storyPoints:"2842"` is **83.8%** of all story points, dragging `rework_per_10_points` to **0.195** when the correct value is ≈ **1.198** (6.1× higher). No validation catches either.

4. **"Blocked" is semantically polluted — 99.9% of it is not a blocker.** Of 1,425 `blocked`, only **21** are real `block` actions; ~1,404 are machine *guard refusals* ("actor not allowed", "worktree exists", evidence-format refusals). Recipe 1 matches `outcome=="blocked"`, so **any guardrail targeting "blocked" can never reach `after_rate==0`** — it is structurally stuck as Ineffective/Pending forever. (Correction to `research/26`: the flaw is semantic conflation, not arithmetic double-counting — the per-issue overlap is 1 event.)

5. **Recipe 1 is statistically unsound and the ledger is mostly unresolved.** `after_rate==0 AND issues_after>=2 → Confirmed` has a 95% interval of **[0, 0.84]** at 0/2 — indistinguishable from 84% failure — and it is a data-dependent stopping rule on a non-stationary process. **88/178 (49.4%)** guardrail records remain `Pending`, and nothing schedules their re-evaluation.

6. **The best available outcome metric is a "follow-up revision rate."** Research track C's recommendation: of specs shipped ≥30 days ago, the share with a linked follow-up spec classified as rework/rejection — the operator's own rejection judgment, measured at the product layer (the DORA "deployment rework rate" / escaped-defect analog). It is un-gameable as a *goal* and resurrects the near-empty reopen signal at usable sample size. Its cost is one template field plus a parser.

7. **An honest redesign is small and additive.** Three instrumentation additions — `feature.revised{revises:#N}`, `human.review{decision}` (runs during the `done` human-review window, which no action currently records), and `guardId`/`failureClass` on the 95 `guard.fired` events (all currently `attributes:{}`) — unlock: Beta-Bernoulli acceptance intervals, a Crow-AMSAA reliability-growth slope on the revise stream, and per-guardrail effectiveness. No history rewriting, no schema migration.

8. **The design must survive its own red team.** Valid attacks: base-rate sparsity (rule of three ⇒ ~150 accepted specs to halve the 3.9% bound), self-reported `revises` is missing-not-at-random (measures recording discipline), acceptance is Goodhart-able (the pipeline curates toward easy scope), selection bias (5 `canceled` specs vanish), and attribution is causal inference, not counting. Defenses: pre-registered window, uncertainty-first reporting, paired throughput, raw counts always visible, spec-only filter, explicit `pending` censoring — **and never use any of it as an agent reward or a target**.

---

## Part 1 — Data Audit: What the SI Actually Has

Source × quality scorecard (all numbers computed 2026-09-18):

| # | Source | Machine-parseable | Records outcome? | Coverage | Key defect |
|---|---|---|---|---|---|
| 1 | `state/issues/*.jsonl` | Yes (JSONL) | Process + classification only | 87 files, 10,794 events | `startTs/endTs/durationMs/sequence/tokens/acceptance` = **0** emitted; 5 undocumented event names; `phase.started` 803 vs `phase.completed` 718 (85 phases lose duration) |
| 2 | `metrics --all/--issue --json` | Yes | Process only | 87 issues | `failures`=1,691 (68% mock #633); `blocked`=1,425 (99.9% guard refusals) |
| 3 | `health` | Yes | 1 weak proxy (`first_pass`) | 87 issues | audit 76:1; Little's Law can't fail; `rework_per_10_points` corrupted by #2842 |
| 4 | `audit` bundle | Yes | **Gate only** (testing-time) | per-issue | `Verification OK` is an exit gate, not post-merge quality |
| 5 | `verify` + `script-errors.jsonl` | Yes | Process failures | 6,402 errors / 87 issues | 3,113 from mock #633; guard refusals logged as errors; no `action`/`guard` field |
| 6 | GitHub timeline comments | Headers only; bodies prose | **`## Tests Runs` verdict** | 1,233 comments / 84 issues | Prose; `## Decision` header shared with product issues; round drift (r1=83 → r26=1; #2758 alone 26 rounds) |
| 7 | `references.md` G-records | Semi (freeform) | **Guardrail efficacy** | 181 records / 178 `effectiveness:` | 3 missing the field; **3 duplicate IDs** (G-080/G-103/G-104); 88 Pending |
| 8 | `observations.md` + A2A `triage.md` | triage yes; obs prose | No | 12 obs / 15 triage | Ephemeral, cleaned at teardown |

**Field presence:** `ts/event_id/event_name/actor/entity/phase/outcome/attempt/correlation_id/attributes/message` = 100%. **Never emitted:** `startTs`, `endTs`, `durationMs`, `sequence`, `tokens`, `acceptance` (all 0 lines). **No `revises` link exists anywhere. Human-close is not in the event log** (81 machine `close-issue` events; the human's manual close is invisible).

**Event-name inventory (top):** `state_machine.call` 2,082 · `state_machine.failure` 1,689 · `upload-evidence` 1,189 · `comment` 1,022 · `phase.started` 803 · `transition` 778 · `phase.completed` 718 · `guard.fired` 95 (all `attributes:{}`) · `rework.rootcause` 79 · `audit.verdict` 77 · `pipeline.improvement` 31 · `block` 21 · `human.authorization` 1.

**The decisive gap:** the only sources that record *acceptance* are the `audit` bundle and `## Tests Runs` — both are **testing-time** gates that a FAIL never survives (a failing feature loops back before audit). There is no record of whether the shipped thing was good.

---

## Part 2 — Current-Measurement Audit: What We Use, and Why It Misleads

| Metric / recipe | Source | Formula | Flaw | Concrete failure |
|---|---|---|---|---|
| `first_pass_rate` | `health` (`pipeline-state.rs:5238,5276`) | `first_pass_issues / passed_issues`; first-pass = audit PASS + zero `rework` | Survivor denominator — 12/87 excluded, many abandoned/cancelled | Kill/abandon a hard issue → rate **rises** |
| `rework` / `is_rework` | `:4883` | count of transitions whose message contains `testing -> implementation` | Counts events, not issues/severity; blind to audit restarts + reopens; size-sensitive | #2758 (25) + #2756 (15) = 32% of all rework; raw count inflates with throughput |
| `blocked` | `:4962,5168` | `outcome=="blocked" OR event_name=="block"` | 99.9% are guard refusals, not stalls | Every "blocked"-class guardrail is structurally Ineffective |
| `rework_per_10_points` | `:5254-5282` | `Σ rework×10 / story points` | 21/75 passed issues unsized (MNAR); #2842 corrupts 83.8% of points | Real value ≈ **1.198**, reported **0.195** |
| `root_cause_mix` | `:5265-5269` | counts `rootCause` on failed verdicts | **Dead** — 0/1 failed verdicts carry it | SI allocates guardrails from narrative, not data |
| `rework_cause_mix` | `:5257-5261` | counts `rework.rootcause` | 79 events vs 124 rework loops (63.7% coverage) | 45/124 loop causes unknown; defect share gameable by misclassification |
| `guard_fired` | `:5256` | `count(guard.fired)` | 95 events, **zero attributes**, no `guardId` | Cannot tell G-020's fires from the image-ref guard's |
| `Little's Law` | `:5206-5235` | `\|throughput×avg_cycle − issues\| / issues < 2` | **Cannot fail by construction** (`w ≤ issues` always) | Prints "CONSISTENT" with 1,689 failure events on record |
| `throughput` | `:5206-5209` | `distinct issues ever seen / corpus span` | Counts arrivals, not completions; includes idle time | Opening issues raises "throughput" with zero delivery |
| `Recipe 1` | `retro-analysis/SKILL.md:41-58` | before/after windows; `after==0 && n≥2 → Confirmed` | No CI; 0/2 ⇒ [0, 0.84]; data-dependent stopping; non-stationary; `blocked` clause poisoned | Declare a guardrail on a quiet 2-spec stretch |
| Guardrail ledger | `references.md` | self-graded `effectiveness:` | 88/178 Pending (49.4%), never revisited; duplicate IDs; freeform | Improvement unmeasured — the SI's own loop is open |
| `audit_evidence` signals | `:4993-5053` | substring/token presence checks | Formality gates, not quality; `Verdict: PASS` with FAIL rows clears (G-033) | Formatted verdict passes mechanically |

**Verdict:** the current measurement set cannot answer "are we improving?" It answers "how busy was the pipeline?" — and even that is distorted by two logging artifacts.

---

## Part 3 — What "Improving" Should Mean

The operator has no internal bug loop; dissatisfaction is a **follow-up spec**. That maps onto established software-quality outcomes:

- **Deployment rework rate (DORA, added 2024)** → the direct analog: share of delivered work that is unplanned rework. [DORA](https://dora.dev/guides/dora-metrics/)
- **Escaped-defect rate / defect-removal efficiency** → defects found after the gate ÷ all defects [Jones 1996, DOI 10.1109/2.488361].
- **Issue reopen rate** → a hard-defect tripwire; empirically reopened bugs cost **1.6–2.1×** more to resolve [Shihab 2013; Zimmermann ICSE 2012; Tagra et al. 2022, arXiv:2202.08701].
- **Rework is the true signal** → Boehm & Basili: most process-maturity gains come from reducing avoidable rework [DOI 10.1109/2.962984]; attribution must be to the *artifact revised*, not the loop.
- **Reliability growth (Duane / Crow-AMSAA)** → `β<1` = failure intensity falling as defects are fixed [NIST; MIL-HDBK-189C] — purpose-built for trial→fix→trial, but statistically thin at this scale.

**Ranked candidate outcome definitions** (Track C):

| Rank | Definition | Signal | Cost | Gaming | Latency |
|---|---|---|---|---|---|
| 1 | **Follow-up Revision Rate (FRR)**: of specs shipped ≥30d ago, % with a linked follow-up classified as rework/rejection | High (operator's own judgment) | Very low | Medium (under-filing) | Weeks |
| 2 | **Human acceptance rate** at `done` review (accept/revise/reject) | High, leading | Very low | Low (single operator) | Low |
| 3 | **Reopen-based recovery time** (`done→planning`), already logged | Very high (hard defect) | Zero | Low | Low, but n≈1 |
| 4 | Reliability-growth slope on follow-ups | Medium | Medium | Low | Very high |

---

## Part 4 — Measurement Redesign (Additive Instrumentation + Estimators)

### 4.1 Outcome capture (new, additive events)

**(a) Revision link — `feature.revised`** (on the *new* issue's log): emitted by `create-issue` with an optional `--revises <N>` (and a `revises: #N` line in the intake body as a fallback), attributes `{ "revises": "<N>" }`. A SI-only `link-revision --issue <new> --revises <old>` repairs missed links. *Feature X was revised iff any log carries `feature.revised{revises == X}`.*

**(b) Human acceptance — `human.review`** (SI-only action, runs during the `done` human-review window — currently no action records it): `outcome: success|failed`, attributes `{ "decision": "accept"|"reject", "note", "reviewer" }`. A reject may also trigger the existing reopen leg; either counts as non-acceptance.

**(c) Guardrail identity — `guard.fired` attributes:** add `{ "guardId": "G-0NN", "guardKey": "<slug>", "failureClass": "<target_failure>", "site": "<action>" }` at the ~13 emit sites (currently all empty). Reorder `record-improvement` to persist the G-record first and stamp `guardrailId` on the `pipeline.improvement` event, making `guard.fired ↔ pipeline.improvement ↔ ### G-NNN` joinable.

### 4.2 Estimators (simplest valid form for each signal)

- **Acceptance rate — Beta–Bernoulli** with prior `Beta(1,1)`: `p̂ = (1+accepts)/(2+n)`, 95% CI from Beta quantiles. Decision rule is **interval separation, not a threshold**: split prior/current windows, report `P(p_now > p_prev)`; "improving" only at ≥0.95, "regressing" at ≤0.05, else "no detectable change."
- **Revision/rejection over time — Crow-AMSAA** (directional growth) on cumulative failures vs issue sequence `i`: OLS on `ln M_i = ln λ + β ln i`; `β̂<1` = improvement; report `β̂` + CI + raw cumulative count. Complement with an XmR run chart and a CUSUM (`k≈0.5σ, h≈4–5`) as the always-visible detector.
- **Phase durations — EWMA** (`λ=0.18` for m=10), raw points always shown beside the smoothed line.

### 4.3 The one number to read

**Primary:** `P(p_now > p_prev)` from the acceptance posterior (a single [0,1] indicator that carries its own uncertainty), shown with `p̂`, its 95% CI, and **raw counts** (`done / accepted / revised / rejected / pending`).
**Paired (always visible):** specs shipped per period (throughput) and the Crow-AMSAA `β̂`.
**"Improving" = acceptance up/flat while throughput is flat/up — never optimize either alone.**

### 4.4 Where to surface it

A read-only `--action improvement --json` (alongside `metrics`/`health`) emitting `{ acceptance:{n,accepted,revised,rejected,pending,mean,ci95,p_now_gt_prev,decision}, revise_growth:{beta_amsaa,ci95,raw_cumulative}, raw:{done,reopen,rework_total,events}, integrity }`; plus one summary line appended to `health`.

**Smallest viable this month:** the three capture events + the Beta posterior/CI + raw counts + a spec-only filter. Defer Crow-AMSAA/EWMA until sessions are stable.

---

## Part 5 — Backtest: What We Can Say Today (Honest)

Per-spec `rework` in time order, with a **spec-only filter** (exclude orchestrator logs `#0/#633/#10/#36`):

| i | Issue | rework x | cumulative mean | trailing-10 | EWMA(0.2) |
|---|---|---|---|---|---|
| 1 | 2688 | 5 | 5.000 | 5.000 | 5.000 |
| 10 | 2728 | 1 | 0.700 | 0.700 | 1.031 |
| 20 | 2754 | 3 | 1.550 | 2.400 | 2.638 |
| 22 | 2758 | 25 | 3.227 | **6.400** | 9.088 |
| 40 | 2807 | 2 | 2.450 | 0.400 | 0.937 |
| 60 | 2848 | 1 | 1.800 | 0.600 | 0.676 |
| 83 | 2893 | 0 | **1.494** | **0.600** | **0.438** |

- **The cumulative number (1.49) overstates current rework ~2.5×** — it never forgets the Aug-21→31 spike (peak trailing 6.40) and keeps *diluting* downward, which is easy to misread as improvement.
- **First-10 vs last-10: 0.70 → 0.60.** Poisson sd ≈ 2.6 for n=10 ⇒ **noise**. No quality trend.
- **`state_machine.failure` per spec: 11.5 → 2.0** (6×, exceeds noise) — the only monotonic signal, **but its definition drifted** as guards were added (guard refusals, illegal transitions, tooling stalls all share the event name). A candidate, not proof.
- **Outlier contamination:** `blocked` 1,425 (80.8% #633), `failures` 1,689 (68% #633), `story_points` 3,393 (83.8% #2842), `rework` top-5 issues = 46%.
- **Throughput rose** (7→25→19/wk) and **median cycle fell** (~12 h → 1–2 h), confounded by spec size/mix.
- **Instrumentation is non-stationary:** `guard.fired` absent before 08-26; ~30 pipeline improvements landed mid-window.

**Backtest verdict:** with existing data we can say the *process* got faster and busier; we **cannot** say quality improved. The only honest monthly proxy is trailing-window, spec-only `rework`/spec paired with machine-`failure`/spec and throughput — labelled as process activity, not quality.

---

## Part 6 — Red-Team Findings and Defenses

| Attack (valid) | Defense in the design |
|---|---|
| Base rate ~0 → no dynamic range (rule of three: 0/76 ⇒ ≤3.9%; ~150 specs to halve it) | Report intervals, not points; pre-register the 30-day maturity cohort; treat "insufficient data" as a first-class result |
| `revises` is self-reported, missing-not-at-random → measures discipline | PO intake field + SI `link-revision` repair; explicitly report linkage coverage alongside FRR |
| Acceptance is Goodhart-able (curate easy scope; rubber-stamp) | No target-as-goal; never agent reward; pair with throughput + scope; raw counts always visible |
| Selection bias (5 `canceled` vanish) | Intention-to-treat denominator: all started specs; report canceled/abandoned separately |
| Latency + causal attribution (weeks later, symptom not cause) | FRR is descriptive association, not causal; no per-guardrail causal claims from it |
| Burden / over-engineering (measurement can cost 1–5%; "graveyards of unused data") | Three additive events only; close the existing 49.4%-Pending loop before adding more; smallest-viable first |

**Steelman (why it's still worth building):** outcome capture is the **only un-gameable signal available**; the two event additions are cheap, additive, and `guardId` is independently useful; honest tiny-N intervals are themselves anti-Goodhart; and it closes the exact data-capture gap that makes every current metric a process proxy.

---

## Part 7 — Phased Rollout

1. **Fix the data (immediate, no design needed):** spec-only filter for `health`/`metrics` (exclude `#0/#633/#10/#36`); validate `storyPoints` (reject `#2842`'s self-referential value); split `block` actions from guard refusals; fix the Little's Law check or delete it; replace `first_pass_rate`'s survivor denominator.
2. **Capture the outcome (smallest viable):** `feature.revised`, `human.review`, `guardId`/`failureClass`.
3. **Measure honestly:** Beta acceptance CI + `P(p_now>p_prev)`; Crow-AMSAA `β̂`; raw counts; spec-only trailing rework as the interim process proxy.
4. **Close the loop:** schedule guardrail effectiveness re-evaluation (kill the 49.4% Pending); make the SI's audit read the acceptance signal, not the degenerate verdict.
5. **Only then** consider closed-loop tuning — never before the sensor exists.

**Anti-Goodhart, permanently:** metrics are diagnostics, not targets; a percentage is never shown without its numerator/denominator; no agent is ranked by acceptance or revision rate; the raw counts remain the audit surface.

---

## Part 8 — Human in the Loop: the PO-Owned Revision Link

The human's effort must stay at zero new steps. The design therefore never asks for a separate verdict — it records the **revealed** outcome the operator already produces.

### The flow

```
you test #N after it is labeled done (issue stays OPEN)
  - happy:    you say nothing (or close it)          -> #N counts as ACCEPTED (by absence)
  - unhappy:  you tell the PO what is wrong           -> PO proposes / confirms the prior issue
                                                          -> opens #M with "Revises #N"
                                                          -> feature.revised{revises:#N} on #M
                                                          -> #N counts as REVISED
```

- **Reject = a linked follow-up.** The complaint you already make is the signal; the only addition is the link.
- **Accept = the absence of a linked follow-up** over a maturity window. You never have to report a pass.
- **Old tickets never stay open for measurement.** The link is stored **forward** on the new issue; the revised issue can be closed immediately (the reopen leg is not needed for this path).

### The one extra interaction (PO-proposed, human-confirmed)

On every new task the PO **searches prior issues** (titles/bodies, preferring recently-closed in the same area), **proposes 1–3 candidates**, and asks: *"Does this revise one of these, or is it new?"* It **never infers silently** — a wrong link corrupts the metric, and a missed link hides a real rejection. The answer is recorded either way:
- confirmed prior `#N` → `create-issue --revises N --intent fix|enhancement`
- genuinely new → no `--revises`; the `create-issue` event records `revises: none`

The explicit `none` is what makes **link coverage** measurable ("X% of specs recorded a linkage decision") — so a thin signal is visible rather than trusted.

### Intent, kept minimal

Two buckets only: **`fix`** ("the prior feature did not work" — the rejection signal) and **`enhancement`** ("it works, I want more" — healthy evolution). A third bucket adds ambiguity and a gaming surface; add one only if the data demands it.

### What the human never does

- Run a script or a `pipeline-state` action (the PO/SI records it).
- Keep a ticket open, or re-open one for measurement.
- Report a pass, or learn a new phase — `done` + human review already exists.

### Honest limitations

- **Self-reported link, subject to missingness.** If a follow-up is filed without naming the original (and the PO does not ask), the revision is invisible and falsely counts as accepted. Mitigations: the PO always asks; a periodic SI `link-revision` backfill audit; the link-coverage number.
- **Accept-by-silence is an inference**, not ground truth — a feature that was never tested still counts as accepted. Mitigate with a maturity window and by reporting the count of un-reviewed features.
- **Low base rate.** With revisions near zero (reopen fired once), the interval is wide and the trend is un-actionable until enough linked events accumulate. That is expected; report it, do not fabricate precision.

---

## Source List

**Pipeline / repo artifacts**
- `.opencode/state/issues/*.jsonl` (87 logs); `pipeline-state.rs` (`is_rework:4883`, `metrics_per_issue:4887`, `metrics_aggregate:4947`, `audit_evidence:4993`, `health_report:5152`); `.opencode/state/script-errors.jsonl`
- `docs/agentic-pipeline/state-machine.md` (event schema :225-241; metric catalog :250-302; anti-metrics :304-311)
- `.opencode/skills/retro-analysis/SKILL.md` (Recipe 1 :40-58; Recipe 6 :200-228)
- `docs/agentic-pipeline/playbooks/self-improver.md` (audit step 11; guardrail step 13)
- `docs/agentic-pipeline/playbooks/references.md` (181 G-records)
- `docs/agentic-pipeline/playbooks/qa-expert.md`, `templates/PO-issue-template.md`

**Outcome / quality metrics**
- DORA metrics guide — https://dora.dev/guides/dora-metrics/ ; DORA 2024 report — https://dora.dev/research/2024/dora-report/
- Jones, *Software defect-removal efficiency*, Computer, 1996 — DOI 10.1109/2.488361
- Boehm & Basili, *Software Defect Reduction Top 10 List*, Computer 34(1), 2001 — DOI 10.1109/2.962984
- Shihab et al., *Studying Re-opened Bugs in Open Source Software*, EMSE 2013 — https://naist.repo.nii.ac.jp/record/4158/files/26Reopened.pdf
- Zimmermann et al., *Characterizing and Predicting Which Bugs Get Reopened*, ICSE 2012 — https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/zimmermann-icse-2012.pdf
- Tagra et al., *Revisiting reopened bugs*, 2022 — arXiv:2202.08701
- NIST/SEMATECH, Duane plots — https://www.itl.nist.gov/div898/handbook/apr/section1/apr192.htm ; MIL-HDBK-189C — https://www.dote.osd.mil/Portals/97/docs/TEMPGuide/MIL-HDBK-189C.pdf
- Forsgren et al., *The SPACE of Developer Productivity*, CACM 64(6), 2021 — DOI 10.1145/3453928
- Ziegler et al., *Productivity Assessment of Neural Code Completion*, MAPS '22 — DOI 10.1145/3520312.3534864
- GitHub, *Linking a pull request to an issue* — https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
- Atlassian, *Configuring issue linking* — https://confluence.atlassian.com/adminjiraserver/configuring-issue-linking-938847862.html
- DevStats, *Escaped Defects* — https://www.devstats.com/glossary/escaped-defects

**Statistics / measurement validity / Goodhart**
- Hanley & Lippman-Hand (1983), rule of three — DOI 10.1001/jama.1983.03330370053031
- Brown, Cai & DasGupta (2001), interval estimation for a binomial proportion — DOI 10.1214/ss/1009213286
- Little & Rubin (2019), *Statistical Analysis with Missing Data* 3e — DOI 10.1002/9781119482260
- Podsakoff et al. (2003), common-method bias — DOI 10.1037/0021-9010.88.5.879
- Heckman (1979), sample selection bias — DOI 10.2307/1912352
- Holland (1986), causal inference — DOI 10.1080/01621459.1986.10478354
- Barnett et al. (2005), regression to the mean — DOI 10.1093/ije/dyh299
- Campbell (1979), *Eval. Program Plann.* 2(1) — DOI 10.1016/0149-7189(79)90048-X
- Goodhart (1984) — DOI 10.1007/978-1-349-17295-5_4 ; Strathern (1997) — DOI 10.1002/(SICI)1234-981X(199707)5:3<305::AID-EURO184>3.0.CO;2-4
- Donabedian (1966/2005), structure–process–outcome — DOI 10.1111/j.1468-0009.2005.00397.x
- NASA *Software Measurement Guidebook* (1994); Berander & Jönsson (2006), GQM "graveyards" — DOI 10.1145/1159733.1159781
- Bühlmann (1967), credibility — DOI 10.1017/S0515036100008989

---

## Verdict Note

The pipeline's inability to answer "are we improving?" is **not an estimator problem — it is a data-capture problem**. The abundant signals (`audit.verdict`, `rework`, `blocked`, `failures`, `throughput`) are either degenerate, semantically polluted, or process-activity rather than product outcome; the outcome the operator actually holds in their head — *did this delivery stick, or did I have to spec it again?* — is never written down. Capture that (a `revises` link + an accept/reject marker), fix the two logs and the survivor denominator that corrupt every headline, and then the honest answer becomes a Beta posterior with an interval and a paired throughput trend. Everything else — Kalman filters, composites, reliability-growth curves — is downstream of that one missing record.
