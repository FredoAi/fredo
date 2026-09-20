# Research Report: Kalman Filtering as a Self-Improvement Measure for the Agentic Pipeline

**Agent:** Research Analyst (multi-track audit: control theory, Bayesian statistics, SPC/process analytics, agentic-AI evaluation, applied feasibility, red team)
**Date:** 2026-09-17
**Scope:** Whether a Kalman filter (or state-space filter family) should become the measurement layer of the pipeline's self-improvement cycle (the ACE generate → reflect → curate loop in `.opencode/skills/retro-analysis/SKILL.md`, audited by the Self-Improver per `docs/agentic-pipeline/principles.md` rule 6).
**Model evaluated:** The append-only per-issue JSONL event log (`.opencode/state/issues/*.jsonl`), 87 issue logs, ~5.7 weeks, 10,79x events, plus the naive guardrail-effectiveness classifier in Recipe 1.
**Method:** Six independent parallel research tracks (A–F), one deliberately adversarial; synthesis below resolves contradictions and marks single-track claims.

> **Premise correction (operator challenge, 2026-09-17).** The first draft treated internal tester pass/fail, `rework`, and `blocked` events as the primary outcome signal. The operator points out the pipeline does not run on internal "bugs": specs proceed straight forward, and dissatisfaction is expressed as a **follow-up spec**. Re-reading the transition record confirms it — the audit verdict passes 76/77 and `done → planning` reopen fired once, while the outcome that actually matters (human acceptance) is not recorded at all. The report is amended in §4.6 and the recommendation is reordered around it. The Kalman-specific conclusions in §1–3 are unaffected.

---

## Executive Summary (Top 8 Findings)

1. **A plain linear-Gaussian Kalman filter is the wrong *primary* measure for this pipeline.** The pipeline's core signal is discrete (pass/fail, rework counts, blocked flags) with small-N and a process that deliberately mutates itself (~26 guardrails/week). All three assumptions a KF leans on — linear-Gaussian observations, known noise covariances, stationary dynamics — fail. This is the convergent verdict of the control-theory, Bayesian, SPC, and red-team tracks.

2. **"Kalman = Bayes" is true, and that is precisely why it loses here.** The KF is recursive Bayes under a linear-Gaussian conjugate model; it is *exactly* optimal only while that model holds. Put a Bernoulli observation in it and conjugacy is lost (EKF/UKF/particle filter required), so the optimality argument evaporates [Kalman 1960; Särkkä 2013; Fahrmeir 1992].

3. **For discrete rates the best-matched estimator is Beta–Bernoulli + partial pooling, not a filter.** Beta posteriors give honest tiny-N intervals (0/2 is not "0"); hierarchical/credibility shrinkage borrows strength across agents; Bühlmann credibility is the mature actuarial analog of "how much do I trust this agent's 3 samples?" [Bühlmann 1967; Stein 1956; James & Stein 1961].

4. **For drift, the generative story is a step change, not diffusion — so change-point/CUSUM beats a constant-Q filter.** A guardrail is an intervention. CUSUM/EWMA detect small persistent shifts in ~10 samples vs ~44 for Shewhart; BOCPD models the step directly [Page 1954; Adams & MacKay 2007].

5. **For "are we actually getting more reliable?", the established answer is a reliability-growth model (Duane / Crow-AMSAA), and no one has claimed it here.** The Crow-AMSAA NHPP slope (β<1 = growth) over a frozen definition of "failure" is the 60-year-old engineering answer to exactly this question [Duane 1964; Crow 1974; MIL-HDBK-189A]. It is not currently in the pipeline.

6. **There is no prior art for Kalman/state-space filtering of LLM-agent reliability as a self-improvement measure.** The Kalman-family prior art is online competitive skill rating (Elo/Glicko/TrueSkill; Duffield et al. 2024 explicitly frames Glicko as a local EKF) and very recent cross-sectional latent-reliability models (HMM/DTMC). The field's established estimators are anytime-valid confidence sequences, SPRT, Bayesian credible intervals, and bandits [Herbrich et al. 2006; arXiv:2308.02414; arXiv:2607.22951; arXiv:2604.24579]. Novel ≠ impossible, but it means no proven playbook.

7. **The signal a filter would estimate is barely instrumented — and the abundant signal is the wrong one.** On real data the audit verdict is near-degenerate (**76/77 pass**; one `failed` in the entire log), `rework` (testing→implementation, **124**) is a *process-friction* signal (tester/QA churn, CI/environment, technique) rather than a product-quality one, and `blocked` is dominated by guard refusals (**1,405** `outcome=="blocked"` vs **21** `block` actions). The outcome that actually matters — did the human accept the delivery, or ask for a follow-up spec — is **not recorded**: dissatisfaction arrives as a *new issue* with no back-link, and `done → planning` reopen fired **once**. So the real blocker for any latent-state measure is **data capture, not estimation**.

8. **Honest recommendation: first record the outcome, then estimate it — with the simplest matched method, not a filter.** **Stage 0 (now, the real blocker): instrument human acceptance** — link each follow-up spec to the feature it revises and record an explicit accepted/rejected marker; without it every estimator fits process noise. **Stage 1:** replace Recipe 1's hard thresholds with Beta–Bernoulli intervals + a change-point test, add a Crow-AMSAA reliability-growth slope *over the recorded acceptance outcome*, and keep a run chart + CUSUM on `rework` as the internal process surface. **Stage 2** (if continuous metrics land): EWMA, then a regime-aware state-space filter only for genuine multi-signal fusion. **Stage 3** (defer): closed-loop tuning — not computable until token telemetry and machine-readable guardrail linkage exist.

---

## 1. How Kalman Filtering Works (and What It Assumes)

### 1.1 The model and recursion

Linear-Gaussian state-space model (`x_k` latent state, `z_k` observation):

```
x_k = F_k x_{k-1} + B_k u_k + w_{k-1},   w ~ N(0, Q_k)
z_k = H_k x_k + v_k,                     v ~ N(0, R_k),  E[w_j v_k'] = 0
```

Predict: `x̂⁻ = F x̂`, `P⁻ = F P F' + Q`.
Update: innovation `y = z − H x̂⁻`, `S = H P⁻ H' + R`, gain `K = P⁻ H' S⁻¹`, `x̂ = x̂⁻ + K y`, `P = (I − K H) P⁻`.

`K` is the minimum-MSE gain under the model; `F` encodes assumed latent dynamics, `B u` an exogenous intervention (e.g. a guardrail), `H` the observation channel. The filter returns a **posterior distribution** (`x̂`, `P`), not a scalar score — any scalar "self-improvement metric" is a separate functional of that posterior.

### 1.2 Assumptions — and what each violation breaks

| # | Assumption | Violation → failure |
|---|---|---|
| A1 | Linearity of `F`, `H` | Optimality proof lost; EKF/UKF needed |
| A2 | Gaussian `w, v, x_0` | `K` no longer minimum-MSE; χ² diagnostics invalid |
| A3 | Known, correct `Q`, `R` | Over/under-confidence, lag, or divergence — the dominant practical risk |
| A4 | Zero-mean noise | Persistent state bias |
| A5 | White (uncorrelated) noise | Autocorrelated innovations; filter double-counts information |
| A6 | Markov property | Missing state absorbed into `Q`; false confidence |
| A7 | Independence of `w, v` | Update invalid without a correlated-noise formulation |
| A8 | (Time-)invariance of `F, Q, H, R` | Fixed-gain filter lags deliberate process changes; needs adaptive/IMM |
| A9 | Observability of `(F, H)` | Unobservable modes grow unbounded; `P` stops contracting |
| A10 | Initial `x̂_0, P_0` correct-ish | Wrong `P_0` biases the transient; recovers only if the filter contracts |

### 1.3 Variants and when they are required

- **EKF / UKF** — only if `H`/`F` are nonlinear. A Bernoulli pass/fail mapped from a latent rate via a **logit link** is exactly this case [Julier & Uhlmann 1997; Fahrmeir 1992].
- **Particle filters** — for genuinely non-Gaussian / multimodal / categorical posteriors (restart-phase classes) [Gordon et al. 1993; Särkkä 2013].
- **Adaptive `Q`/`R`** — innovation-based (IAE), correlation-based [Mehra 1970], Sage–Husa [Sage & Husa 1969]. **IMM** is the standard for abrupt regime changes [Blom & Bar-Shalom 1988] — directly relevant to a self-mutating pipeline.
- **Steady-state KF** — constant gain `K∞`; cheap, requires A9/A10.
- **RTS smoother** — backward pass using all data; lower-variance offline estimates [Rauch et al. 1965]. Ideal for small-N retrospective measurement.

### 1.4 Tuning and diagnostics (the real cost)

`Q`/`R` are set by Allan variance [Allan 1966], innovation-based adaptation, EM/ML with an RTS smoother [Shumway & Stoffer 1982], or Bayesian optimization on NIS/NEES costs [arXiv:2306.07225]. Mis-set `Q` too small → sluggish and divergence-prone; too large → chases noise; `R` too small → noise enters the state. Diagnostics: under a correctly tuned filter, innovations are zero-mean white with covariance `S`; test `NIS = y'S⁻¹y ~ χ²(m)` and, when truth is known, `NEES`. **NIS consistency does not imply NEES consistency**, and gating can itself bias innovation statistics [arXiv:2512.18508].

### 1.5 The decisive structural point

A filter is a **model-based smoother**. It only "discovers" what its model can represent. In this pipeline the thing we most want to detect — a guardrail improving reliability — is an **abrupt intervention**, while a random-walk `Q` models **diffusion**. High `Q` makes the filter chase noise and, per the SPC track, **absorb a slow regression as if it were normal drift** — the exact failure the pipeline fears [Track C].

---

## 2. The Three Candidate Applications

### 2.1 Latent agent/phase reliability (discrete) — **not sound as a plain KF**

Observations are Bernoulli/categorical. A plain linear-Gaussian KF cannot ingest them: `H` is nonlinear (or undefined), A2/A4 fail, and `Q` (an additive Gaussian variance *in rate units per step*) is uninterpretable for a bounded rate — it can push the latent rate outside [0,1] and forces a logit EKF that discards conjugacy [Track B].

**Defensible alternatives, in order of fit:** Beta–Bernoulli posterior with credible intervals; hierarchical/partial-pooling Bayes (borrow strength across agents/phases); Bühlmann–Straub credibility (minimum-variance linear Bayes, with `K` as the "half-credibility sample size"); BOCPD/CUSUM for the step. If a state-space form is genuinely wanted, it must be a **dynamic GLM / EKF on log-odds**, an **HMM**, or a **particle filter**, with **adaptive/regime-switching dynamics** [Fahrmeir 1992; Gordon et al. 1993; Blom & Bar-Shalom 1988].

There is also a Markov-violation specific to this pipeline: rework loops mean later observations depend on earlier failures, so the measurement process feeds back into itself (A6/A7 weak).

### 2.2 Continuous metric smoothing / drift detection — **plausible, but small marginal gain**

For phase durations / latency / cost, a local-level or local-linear-trend model (`F = I` or `[[1,dt],[0,1]]`) is a standard, appropriate fit. **However**, for a scalar level-tracking problem the steady-state Kalman gain *is* the EWMA coefficient: EWMA = constant-gain scalar KF. A reproducible monitoring experiment found EWMA and a scalar KF had nearly identical smoothing/detection latency, but the KF produced **2.75× more false positives**, needed `Q` tuned across two orders of magnitude, and — with higher `Q` — absorbed a memory-leak-like creep. Practitioner guidance (Tiddens et al.) is to reserve KF for a specific asset with varying conditions and no representative degradation data; otherwise use simpler reliability statistics [Track C].

**Verdict:** use EWMA (the KF's steady-state special case) unless there is a real multi-signal fusion requirement, in which case a regime-aware state-space filter earns its keep.

### 2.3 Closed-loop tuning — **not computable today**

"Use the estimate to tune retry caps / staffing / guardrail strength / restart phase" is a control problem, and the correct control counterpart to a filter is a **bandit / sequential decision** method (Thompson sampling, best-arm identification, sequential Bayesian A/B) — not an LQR over a latent scalar [Thompson 1933; Agrawal & Goyal 2012]. But the pipeline lacks the inputs: no per-agent token usage, no machine-readable `guardrail_id`↔failure-event linkage (`guard.fired` events carry `attributes: {}`), and only coarse per-agent call counts [Track E]. **Defer.**

---

## 3. The Comparison — Kalman vs the Rivals

### 3.1 Kalman is one Bayesian estimator among many

The KF computes `p(x_t|y_{1:t}) = N(μ_t, Σ_t)` exactly because the Gaussian is conjugate to the linear-Gaussian likelihood; the gain is the Bayes data-vs-prior weight. Under weak assumptions it is also the BLUE. **But the "it's just Bayes" advantage ends at the first nonlinearity** — which the discrete case introduces immediately.

### 3.2 Decision table (synthesis of Tracks B, C, D, F)

| Target quantity | Best-matched method | Why | Cost |
|---|---|---|---|
| Discrete pass/fail rate | **Beta–Bernoulli** + hierarchical pooling / credibility | Exact tiny-N intervals; bounded support; borrows strength | Trivial |
| Count / time-to-event (rework, blocked) | **Poisson–Gamma** (negative-binomial if overdispersed) | Correct support for counts/hazards | Low |
| "Is reliability growing as we fix things?" | **Crow-AMSAA reliability growth** (β + CI) | Purpose-built for trial→fix→trial; 60-year precedent | Low |
| Drift / did-guardrail-take-effect | **CUSUM** (known shift) / **BOCPD** (unknown abrupt) / EWMA chart | Matches the step-change generative story; ~10 samples to detect | Low |
| Continuous latency/cost | **EWMA** (= steady-state scalar KF); KF only for multi-signal fusion | KF collapses to EWMA for one scalar | Low |
| Latent multi-signal "health" with calibrated uncertainty | **State-space filter** (adaptive / regime-aware), reported as a distribution | Fuses heterogeneous signals; explicit covariance | Moderate–high |
| Choosing which intervention next | **Thompson sampling / BAI / sequential Bayes** | Regret-optimal exploration; valid sequential decisions | Moderate |
| Running the whole improvement loop | **XmR run chart + CUSUM + reliability growth** as the default surface | Preserves every point; robust to small n and soft data; hides nothing | Low |

**Where Kalman genuinely wins:** continuous, near-Gaussian state; linear(izable) observation; frequent regular observations; known/estimable dynamics; **fusion of multiple noisy sensors**; need for prediction and calibrated uncertainty; strict real-time recursion.

### 3.3 The non-stationarity category error (red-team, strongest argument)

A KF's `Q` models exogenous, unmodeled stochastic drift. Here **the drift is the intervention**: the guardrail/prompt/script edit the pipeline deliberately injects. Encoding it as i.i.d. Gaussian `Q` treats the signal as noise to be smoothed away. This is regime/change-point structure, not random-walk noise. A constant-`Q` filter is provably slow to recognize abrupt parameter change — hence IMM, which adds a model per regime, i.e. more parameters than this data can identify [Track F; Adams & MacKay 2007; Blom & Bar-Shalom 1988].

---

## 4. Applied Feasibility Against This Repository

*Computed by Track E read-only from `.opencode/state/issues/*.jsonl` (87 logs, 2026-08-10 → 2026-09-18), `pipeline-state.rs` metrics/health, and `references.md`. Numbers are exact from those sources.*

### 4.1 Signal inventory

| Candidate observation | Available today? | Anchor |
|---|---|---|
| Discrete pass/fail per phase | **Partial** — no per-phase pass/fail field; only `audit.verdict` emits `passed/failed` | `state-machine.md:229-241`; 77 verdicts |
| Rework count per issue | **Yes** — `is_rework()` = transition containing `testing -> implementation` | `pipeline-state.rs:4883`; 124 events / 44 issues |
| Blocked occurrences | **Yes, but two meanings** — `block` action (21) vs `outcome=="blocked"` (1,405, mostly guard refusals); Recipe 1 conflates them | `pipeline-state.rs:4910`; `SKILL.md:47` |
| Audit verdict + restart phase + rootCause | **Partial** — verdict + phase on 77 events; `rootCause` is a separate `rework.rootcause` event (79: defect 36 / technique 24 / environment 15 / scope 4) | `state-machine.md:239`; `pipeline-state.rs:2777` |
| Phase durations | **Yes, derived** from `phase.started`/`phase.completed` pairs — `startTs`/`endTs`/`durationMs` emit **0** lines | `state-machine.md:235-236,256` |
| storyPoints | **Yes** on `audit.verdict` attributes; 54 sized issues / 3,393 pts | `pipeline-state.rs:3829` |
| Guardrail effectiveness records | **Yes, prose only** — 181 `### G-` headings, 178 `effectiveness:` lines, not machine-readable/linked to events | `references.md:52` |

### 4.2 Sample-size reality

- Issues with event logs: **87**; total events **10,796**.
- `audit.verdict`: **77 → 76 passed, 1 failed** (#2711, phase=planning, restart).
- `testing -> implementation` rework transitions: **124**, across **44 issues** (43 issues with zero rework).
- Health headline: first-pass rate **41% (31/75)**; record integrity OK; Little's Law consistent.
- G-record effectiveness: **92 Pending, 60 Confirmed, 19 Partial, 4 Resolved, 3 re-validated (178 lines)** — i.e. **52% of the pipeline's own effectiveness measurements remain unresolved.**

### 4.3 Stationarity / process-noise evidence (the knell for constant-Q)

- **181 guardrails in ~7 weeks ≈ 26 documented process changes/week** (`references.md` activation dates).
- `pipeline.improvement` events: 31 in ~6 weeks (~5/week); `guard.fired`: 95.
- The process is **regime-switching by design**. A constant-`Q` (or constant-hazard) model is not defensible without a change-point/adaptive component; `Q` should inflate on `pipeline.improvement`/G-activation dates.

### 4.4 Worked micro-example — per-issue rework, time-ordered

Raw series: 87 issues ordered by first event timestamp. Total rework **124**, mean **1.425**; binary `1[rework≥1]` = **44/87 = 0.506**.

| idx | raw Σ rework | raw mean | naive cumulative count | EWMA(0.15) binary | RW-Kalman count |
|---|---|---|---|---|---|
| 0-9 | 7 | 0.70 | 0.70 | 0.509 | 0.778 |
| 10-19 | 24 | 2.40 | 1.55 | 0.701 | 1.964 |
| 20-29 | 58 | 5.80 | 2.97 | 0.900 | 4.137 |
| 30-39 | 7 | 0.70 | 2.40 | 0.347 | 1.744 |
| 40-49 | 5 | 0.50 | 2.02 | 0.393 | 0.921 |
| 50-59 | 5 | 0.50 | 1.77 | 0.391 | 0.684 |
| 60-69 | 8 | 0.80 | 1.63 | 0.595 | 0.828 |
| 70-79 | 8 | 0.80 | 1.53 | 0.651 | 0.748 |
| 80-86 | 2 | 0.29 | **1.425** | **0.332** | **0.524** |

- **Recipe-1-style naive after-rate** (split at the median: first 43 vs last 44): before = 99/43 = **2.30** reworks/issue, after = 25/44 = **0.57** → the verbatim classifier (`after < before`) returns **"Partial" forever**, because the early heavy tail is never forgotten.
- **Filtered/trailing estimates** track the recent regime: last-10/20/30 raw windows = 0.40/0.65/0.63 (count) and 0.40/0.50/0.53 (binary). The naive cumulative count overstates current intensity ~**2–3×**.
- **Honest uncertainty:** n=87 with 44 failures; the count series is heavy-tailed (**2 issues = 32% of all rework**) and the binary series is clustered (runs at idx 13–25 and 57–80). Bernoulli noise at p≈0.5 is maximal, so ~87 samples give only a ±~0.11 (1σ) band. **Only a large shift is detectable.**

### 4.5 Feasibility verdict

| Application | Computable today? | What must be added |
|---|---|---|
| Latent reliability | **Yes, crudely** (77 verdicts, 124 reworks) — but must be adaptive, not constant-`Q` | Per-phase pass/fail; `guardrail_id` on `audit.verdict`; adaptive-`Q` on improvement dates |
| Continuous-metric smoothing | **Yes** (durations derived, rework/blocked counts) | Emit `startTs`/`endTs`/`durationMs` so in-flight durations aren't inferred |
| Closed-loop tuning | **No** | `gen_ai.usage.*` tokens; per-agent outcome/latency attribution; machine-readable `guardrail_id`↔failure linkage; `sequence` |

### 4.6 Premise correction — what the pipeline actually records

An operator challenge ("we don't have bugs; specs go straight forward, and if I don't like something I ask with another spec") prompted a re-read of the transition record. The internal health signals the first draft leaned on are **not the signals that matter most**, and the audit channel is nearly degenerate.

| Transition (from → to) | Count |
|---|---|
| implementation → testing | 202 |
| testing → implementation (`rework`) | 124 |
| planning → implementation | 81 |
| backlog → planning | 79 |
| testing → audit | 77 |
| audit → cleanup (success) | 76 |
| audit → planning (auto restart) | 1 |
| done → planning (reopen) | 1 |
| implementation → planning (rescope) | 1 |

- **The audit verdict carries almost no signal.** `audit.verdict outcome=failed` occurs **once** in the whole log; 76/77 audits pass. Using "audit failure" as the reliability observation channel is effectively fitting a constant.
- **`rework` is real and frequent (124 across 44 issues) but it is a *process* signal**, not product truth: tester/QA friction, CI/environment, technique. Its own reason is half-unlabelled — `rework.rootcause` exists for only 79 of the 124 (defect 36 / technique 24 / environment 15 / scope 4). The operator's "we don't have bugs" is consistent with this distribution.
- **The true "this did not land" signal is the human follow-up spec — and it is entirely unrecorded.** Post-delivery dissatisfaction is expressed as a *new issue*, not a `done → planning` reopen (1 occurrence). The event log has no field linking a follow-up spec to the feature it revises.
- **`blocked` is not a clean stall signal either** — 1,405 `outcome=="blocked"` (mostly guard refusals) versus 21 `block` actions.

**Consequence for the research question:** a filtered estimator is only as good as the observation it filters. The pipeline's *outward-facing* outcome (was the delivery accepted?) is essentially unrecorded, while its *inward-facing* process signal (tester/`rework` churn) is abundant but weakly related to product quality. The naive Recipe-1 rework series is still stale (see §4.4), but the priority is not to filter it — it is to **record the acceptance outcome first**. This is a data-capture problem, not an estimation problem, and it is the same conclusion whether the estimator is a Kalman filter, a Beta posterior, or a run chart.

---

## 5. Anti-Patterns / Goodhart Cautions

1. **Smoothing hides regressions.** A small-λ EWMA or high-`Q` KF can absorb a slow degradation as legitimate level drift — demonstrated in the SPC track's monitoring experiment. Never let the smoothed curve be the only view.
2. **A latent score is harder to audit than a raw count.** "3 reworks in issues 70–79" is falsifiable; a posterior mean invites post-hoc tuning. Keep raw counts as the audit surface [Strathern 1997].
3. **`Q`/`R` tuning as post-hoc rationalization.** Nudging `Q` until the curve looks believable makes the "measure" a tuning artifact — the anti-Goodhart failure mode in disguise [Track F; HotStorage 2020 knob-tuning literature].
4. **Non-constant process noise.** Treating deliberate self-modification as stationary noise is a category error (Section 3.3).
5. **Small-N prior domination.** With single-digit events, the estimate is mostly prior. Naive diffuse-prior Bayesian estimation can be *more* biased than frequentist at small n [Smid et al. 2019]; default priors silently become informative when the likelihood is weak [arXiv:2107.14054].
6. **Rolling z-tests false-alarm.** The industry-default rolling z-test false-alarms on a reported **75%** of drift-free streams — prefers anytime-valid confidence sequences for continuous drift monitoring [arXiv:2606.15474].
7. **Opportunity cost.** The cheapest variance reduction is *more n* and better task fidelity, not estimator sophistication [Miller 2024, arXiv:2411.00640; MAST arXiv:2503.13657]. With 90 issues, two guardrails are probably indistinguishable regardless of estimator.

---

## 6. Honest Opinion & Staged Recommendation

**Bottom line: the Kalman filter is the wrong *primary* measure, but its conceptual vocabulary is right.** The pipeline's real constraints are (1) it does not record the outcome it wants to improve, and (2) sample size and non-stationarity — not estimator sophistication. Adopt the ideas — latent state, explicit uncertainty, process-vs-measurement noise, innovation monitoring — and implement them with the simplest method that matches each signal. Do not build a filter to smooth discrete small-N data the pipeline already logs plainly.

**Stage 0 — now, and the actual bottleneck: record the outcome before estimating it.**
0. **Instrument human acceptance.** The pipeline cannot measure self-improvement because it does not record whether a delivered feature was accepted. Concretely: (a) when a new spec revises or supersedes an earlier feature, stamp the link (a `revises: #N` field on the issue / a `feature.revised` event); (b) add an explicit human acceptance/rejection marker at human review so `done → planning`-style dissatisfaction is captured even when it arrives as a brand-new issue. Without this, every estimator below is fitting process noise — Kalman included.

**Stage 1 — now, in-domain, low-cost (recommended):**
1. Replace Recipe 1's raw before/after thresholds with **Beta–Bernoulli posteriors + credible intervals** (so "0/2" stops reading as zero) and a **change-point test** (did the post-activation interval exclude the pre-rate?).
2. Add a **Crow-AMSAA reliability-growth slope (β + CI)** over a frozen definition of "failure" as the headline "are we improving as we fix things?" metric.
3. Add a **CUSUM (k≈0.5σ, h≈4–5)** on rework counts and an **XmR run chart** as the always-visible raw surface.
4. Fix the measurement plumbing: emit `startTs`/`endTs`/`durationMs`, stamp `guardrail_id` on `audit.verdict`, and stop conflating `outcome=="blocked"` with the `block` action.

**Stage 2 — conditional, once continuous metrics exist:** use **EWMA** (the steady-state scalar KF) for durations/cost. Escalate to a **regime-aware state-space filter** only if there is a genuine need to fuse multiple continuous signals with calibrated uncertainty; if so, validate with **NIS/NEES**, use an RTS smoother for retrospectives, and report the **posterior distribution**, never a bare score.

**Stage 3 — defer:** closed-loop tuning. The right tool (bandits/sequential Bayes) is sound, but the inputs (tokens, per-agent attribution, machine-readable guardrail linkage) do not exist yet; building the controller before the sensor is a category error of its own.

**If someone still wants a Kalman filter specifically:** require it to be the **adaptive/regime-switching** variant, keep the raw counts visible alongside it, pre-register the model, and treat "the smoothed score looks better" as inadmissible evidence. The red-team case (Sections 3.3, 5) is not a reason the filter is impossible — it is a reason it would be expensive, opaque, and prone to hiding exactly the discrete evidence this pipeline already records.

---

## Source List

**Kalman / filtering theory**
- Kalman, R.E. (1960). *A New Approach to Linear Filtering and Prediction Problems.* J. Basic Eng. 82(1):35–45. DOI 10.1115/1.3662552
- Welch, G. & Bishop, G. (2004). *An Introduction to the Kalman Filter.* UNC-CH TR 95-041. https://techreports.cs.unc.edu/papers/95-041.pdf
- Särkkä, S. (2013). *Bayesian Filtering and Smoothing.* Cambridge UP. DOI 10.1017/CBO9781139344203 (free PDF: https://users.aalto.fi/~ssarkka/pub/cup_book_online_20131111.pdf)
- Julier, S.J. & Uhlmann, J.K. (1997). *A New Extension of the Kalman Filter to Nonlinear Systems.* Proc. SPIE 3068:182–193. DOI 10.1117/12.280797
- Rauch, H.E., Tung, F. & Striebel, C.T. (1965). *Maximum likelihood estimates of linear dynamic systems.* AIAA J. 3(8):1445–1450. DOI 10.2514/3.3166
- Fahrmeir, L. (1992). *Posterior Mode Estimation by Extended Kalman Filtering for Multivariate Dynamic GLMs.* JASA 87(418):501–509. DOI 10.1080/01621459.1992.10475232
- Gordon, N.J., Salmond, D.J. & Smith, A.F.M. (1993). *Novel approach to nonlinear/non-Gaussian Bayesian state estimation.* IEE Proc. F 140(2):107–113. DOI 10.1049/ip-f-2.1993.0015
- Blom, H.A.P. & Bar-Shalom, Y. (1988). *The interacting multiple model algorithm.* IEEE TAC 33(8):780–783. DOI 10.1109/9.1299
- Mehra, R.K. (1970). *On the identification of variances and adaptive Kalman filtering.* IEEE TAC 15(2):175–184. DOI 10.1109/TAC.1970.1099422
- Sage, A.P. & Husa, G.W. (1969). *Adaptive filtering with unknown prior statistics.* Proc. JACC 760–769 (no DOI; DTIC AD0705247)
- Shumway, R.H. & Stoffer, D.S. (1982). *… time series smoothing and forecasting using the EM algorithm.* JTSA 3(4):253–264. DOI 10.1111/j.1467-9892.1982.tb00349.x
- Allan, D.W. (1966). *Statistics of atomic frequency standards.* Proc. IEEE 54(2):221–230. DOI 10.1109/PROC.1966.4634
- Chen, Z. et al. (2023). *KF Auto-tuning … with Bayesian Optimization.* arXiv:2306.07225

**Bayesian / small-sample / credibility**
- Bühlmann, H. (1967). *Experience Rating and Credibility.* ASTIN Bulletin 4(3):199–207. DOI 10.1017/S0515036100008989 (distinct from Bühlmann–Straub 1970)
- Stein, C. (1956). *Inadmissibility of the usual estimator…* Proc. 3rd Berkeley Symp. 1:197–206
- James, W. & Stein, C. (1961). *Estimation with Quadratic Loss.* Proc. 4th Berkeley Symp. 1:361–379
- Smid, S. et al. (2019). *Bayesian versus frequentist … small samples.* SEM. DOI 10.1080/10705511.2019.1577140
- de Heide, R. & Grünwald, P. (2021). *Why optional stopping can be a problem for Bayesians.* Psychon. Bull. Rev. 28(3):795–812. DOI 10.3758/s13423-020-01803-x
- Rouder, J.N. (2014). *Optional stopping: No problem for Bayesians.* DOI 10.3758/s13423-014-0595-4
- Schönbrodt, F.D. et al. (2017). *Sequential hypothesis testing with Bayes factors.* DOI 10.1037/met0000061
- Carpenter, B. (2016). *Hierarchical Partial Pooling for Repeated Binary Trials.* https://mc-stan.org/learn-stan/case-studies/pool-binary-trials.html

**SPC / reliability growth / delivery metrics**
- Shewhart, W.A. (1931). *Economic Control of Quality of Manufactured Product.* Van Nostrand
- Page, E.S. (1954). *Continuous inspection schemes.* Biometrika 41(1–2):100–115. DOI 10.1093/biomet/41.1-2.100
- Roberts, S.W. (1959). *Control chart tests based on geometric moving averages.* Technometrics 1(3):239–250. DOI 10.1080/00401706.1959.10489860
- Duane, J.T. (1964). *Learning curve approach to reliability monitoring.* IEEE Trans. Aerospace 2(2):563–566. DOI 10.1109/TA.1964.4319640
- Crow, L.H. (1974/1975). *Reliability Analysis for Complex, Repairable Systems.* AMSAA TR-138 (MIL-HDBK-189A, 2009; DTIC ADA020296 — no DOI)
- Goel, A.L. & Okumoto, K. (1979). *Time-dependent error-detection rate model.* IEEE Trans. Reliability R-28(3):206–211. DOI 10.1109/TR.1979.5220566
- Montgomery, D.C. (2020). *Introduction to Statistical Quality Control* (8th ed.). Wiley. ISBN 9781119723097
- NIST/SEMATECH e-Handbook of Statistical Methods §6.3.2. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc32.htm
- Lucas, J.M. & Saccucci, M.S. (1990). *EWMA control schemes.* Technometrics 32(1):1–12
- Forsgren, N., Humble, J. & Kim, G. (2018). *Accelerate.* IT Revolution. ISBN 9781942788331
- DORA (2023). *Accelerate State of DevOps Report.* https://dora.dev/research/2023/dora-report/
- Fowler, M. (2020). *Don't Compare Averages.* https://www.martinfowler.com/articles/dont-compare-averages.html
- Perla, R.J., Provost, L.P. & Murray, S.K. (2011). *The run chart.* BMJ Qual Saf 20(1):46–51. DOI 10.1136/bmjqs.2009.037895

**Change-point / drift**
- Adams, R.P. & MacKay, D.J.C. (2007). *Bayesian Online Changepoint Detection.* arXiv:0710.3742
- Greenberg et al. (2021). *Detecting Rewards Deterioration in Episodic RL.* ICML, PMLR v139
- *Who Drifted: the System or the Judge?* arXiv:2606.15474
- Ramdas, A. et al. (2022). *Game-Theoretic Statistics and Safe Anytime-Valid Inference.* arXiv:2210.01948

**Bandits / sequential decisions**
- Thompson, W.R. (1933). Biometrika 25(3–4):285–294. DOI 10.1093/biomet/25.3-4.285
- Agrawal, S. & Goyal, N. (2012). *Analysis of Thompson Sampling…* COLT, PMLR 23:39.1–39.26
- Russo, D. et al. (2016). *Simple Bayesian Algorithms for Best Arm Identification.* arXiv:1602.08448
- Wald, A. & Wolfowitz, J. (1948). *Optimum character of the SPRT.* Ann. Math. Statist. 19(3):326–339. DOI 10.1214/aoms/1177730197

**Agentic-AI evaluation / reliability**
- Chen, M. et al. (2021). *Evaluating Large Language Models Trained on Code* (pass@k). arXiv:2107.03374
- Yao, S. et al. (2024). *τ-bench* (pass^k). arXiv:2406.12045
- Rabanser, Kapoor, Narayanan et al. (2026). *Towards a Science of AI Agent Reliability.* arXiv:2602.16666
- Miller, E. (2024). *Adding Error Bars to Evals.* arXiv:2411.00640
- *Don't Pass@k* (2025). arXiv:2510.04265
- Cemri, M. et al. (2025). *Why Do Multi-Agent LLM Systems Fail?* (MAST). arXiv:2503.13657
- Skalse et al. (2022). *Defining and Characterizing Reward Hacking.* arXiv:2209.13085
- Zhang et al. (2026). *ACE: Agentic Context Engineering.* arXiv:2510.04618
- Herbrich, Minka, Graepel (2006). *TrueSkill.* NeurIPS
- Glickman, M. (1999). *Glicko.*
- Duffield, Power & Rimella (2024). *A State-Space Perspective on Online Skill Rating.* arXiv:2308.02414 / DOI 10.1093/jrsssc/qlae035
- *LLM Reliability via latent HMM.* arXiv:2607.22951
- *TraceToChain: absorbing DTMC reliability.* arXiv:2604.24579
- *tinyBenchmarks.* arXiv:2402.14992

**Goodhart / measurement**
- Goodhart, C.A.E. (1975/1984). *Problems of monetary management.* DOI 10.1007/978-1-349-17295-5_4
- Strathern, M. (1997). *"Improving ratings".* European Review 5(3):305–321. DOI 10.1002/(SICI)1234-981X(199707)5:3<305::AID-EURO184>3.0.CO;2-4

**Repository artifacts**
- `docs/agentic-pipeline/state-machine.md` (event schema :225-241; metric catalog :250-302)
- `.opencode/skills/retro-analysis/SKILL.md` (Recipe 1 :40-58)
- `docs/agentic-pipeline/playbooks/self-improver.md` (step 13; DoD; actions)
- `docs/agentic-pipeline/playbooks/references.md` (`Known Failure Modes`; G-records)
- `.opencode/scripts/pipeline-state.rs` (`is_rework` :4883; `rework.rootcause` :2777)
- `.opencode/state/issues/*.jsonl` (87 logs)

---

## Verdict Note

The highest-leverage change is **not** adding a Kalman filter. It is, first, **recording human acceptance** — today a follow-up spec is an unlinked new issue, so the pipeline cannot tell whether a feature landed; second, replacing Recipe 1's un-intervaled before/after threshold with a **Beta posterior + change-point test** over that recorded outcome; third, adding a **Crow-AMSAA reliability-growth slope** as the headline improvement metric; and fourth, fixing the measurement plumbing (`startTs`/`endTs`/`durationMs`, `guardrail_id` linkage, un-conflating "blocked", and treating the near-degenerate audit verdict as a formality rather than a quality signal). Those are cheap, auditable, and directly attack why 52% of guardrails remain `Pending`. A state-space filter becomes worth its cost only when the pipeline has continuous, multi-signal telemetry and a stable enough dynamic story to make `Q` meaningful — today it does not.
