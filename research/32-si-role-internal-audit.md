# Research Report: Internal Audit — The Self-Improver (SI) Role in Fredo's Agentic Pipeline

**Agent:** Internal Audit (read-only, very thorough)
**Date:** 2026-10-25
**Scope:** Audit the CURRENT "Self-Improver" role — every responsibility it carries, its ownership gates, and its overload / conflict-of-interest evidence — to decide whether to split it into Orchestrator / Documentator / Auditor / SelfImprover (+ candidates).
**Evidence base:** `.opencode/agents/self-improver.md`; `docs/agentic-pipeline/playbooks/self-improver.md`; `docs/agentic-pipeline/{README,pipeline,state-machine,staffing,artifacts,common-rules,principles}.md`; `.opencode/skills/pipeline-state/SKILL.md`; `.opencode/skills/retro-analysis/SKILL.md`; the SI's permissions in `opencode.json`; the `references.md` guardrails; and the in-repo research reports `research/26` and `research/27`.

---

## 1. Responsibility Inventory

"Separable?" = whether it cleanly moves to one of the four proposed roles.

| # | Responsibility | Concern | Defining file:line | Separable? |
|---|---|---|---|---|
| 1 | Orchestrate the whole flow end-to-end (single orchestrator) | ORCH | `README.md:3`; `pipeline.md:10`; `agents/self-improver.md:6` | Yes → Orchestrator |
| 2 | Dispatch triage cluster (two-wave if new named contracts; else parallel) | ORCH | `playbooks/self-improver.md:30`; `pipeline.md:96-102` | Yes → Orchestrator |
| 3 | Dispatch developer pool; per-dev worktrees; `requires:` ordering | ORCH | `playbooks/self-improver.md:34`; `pipeline.md:140-147,163` | Yes → Orchestrator |
| 4 | Dispatch tester; inline brief guards (G-104, footer, plan source) | ORCH | `playbooks/self-improver.md:37` | Yes → Orchestrator |
| 5 | Run all `transition` actions | ORCH | `playbooks/self-improver.md:29,33,38,69`; `state-machine.md:88` | Yes → Orchestrator |
| 6 | Write orchestrator plan sections + `## Convergence: agreed` | ORCH/DOC | `playbooks/self-improver.md:31-32`; `artifacts.md:130-133`; `pipeline.md:101` | Partial → Orchestrator/Documentator |
| 7 | Review each dev push vs plan/ACs; return failed work | ORCH/AUD | `playbooks/self-improver.md:35`; `pipeline.md:175` | Partial |
| 8 | Retry loop: dispatch Architect to author `fix-plan.md`; re-entry transition | ORCH | `playbooks/self-improver.md:42-47`; `software-architect.md:9,30-42` | Yes → Orchestrator |
| 9 | Reopen leg (`done→planning`) after post-merge defect | ORCH/AUD | `playbooks/self-improver.md:51-53`; `pipeline.md:243` | Partial |
| 10 | Human-authorized pre-verdict rework (`--human-authorized`) | ORCH | `playbooks/self-improver.md:49` | Yes → Orchestrator |
| 11 | Sync `spec/<N>` with `main` (G-032/G-026); serving-currency checks | ORCH | `playbooks/self-improver.md:34,37`; `github.md:69` | Yes → Orchestrator |
| 12 | Assemble `dev-summary.md` from per-agent drafts | DOC | `references.md:347,350`; `github.md:109` | Yes → Documentator |
| 13 | Run `audit` bundle + integrity gate (`verify`) | AUD | `playbooks/self-improver.md:28,54`; `state-machine.md:99,105` | Yes → Auditor |
| 14 | Record verdict `audit-record --verdict success\|restart` | AUD | `playbooks/self-improver.md:57-59`; `state-machine.md:100`; `pipeline-state.rs:4774` | Yes → Auditor |
| 15 | Independently check evidence vs ACs; reject false PASS | AUD | `playbooks/self-improver.md:54,163`; `references.md:3283,3287` | Yes → Auditor |
| 16 | Choose restart phase; write missed-AC `--reason` | AUD | `playbooks/self-improver.md:59`; `common-rules.md:66` | Yes → Auditor |
| 17 | Reopen "verify-before-reopen" against telemetry | AUD | `playbooks/self-improver.md:51-53` | Partial (contradiction — §3/C10a) |
| 18 | Maintain `observations.md` log while orchestrating | IMP | `playbooks/self-improver.md:36`; `artifacts.md:57` | Yes → SelfImprover |
| 19 | `record-improvement` on-the-go | IMP | `playbooks/self-improver.md:36,79`; `pipeline-state.rs:4777` | Yes → SelfImprover |
| 20 | Retro Recipe 6 — persist guardrails every audit | IMP | `playbooks/self-improver.md:56`; `retro-analysis/SKILL.md:211-241` | Yes → SelfImprover |
| 21 | Re-validate guardrail `effectiveness:` (Recipe 1) | IMP/MET | `playbooks/self-improver.md:56`; `retro-analysis/SKILL.md:31-69` | Yes → SelfImprover (self-graded — §3/C2) |
| 22 | Class → Lever routing (`dominant_root_cause_class`) | IMP | `playbooks/self-improver.md:191-218`; `state-machine.md:103,278` | Yes → SelfImprover |
| 23 | Own `### G-` guardrail records in `references.md` | IMP/DOC | `common-rules.md:29`; `playbooks/self-improver.md:133` | Yes → SelfImprover |
| 24 | Own `common-rules.md` | DOC | `playbooks/self-improver.md:108` | Yes → Documentator |
| 25 | Own the pipeline docs set (except `principles.md`) | DOC | `principles.md:126`; `playbooks/self-improver.md:129` | Yes → Documentator |
| 26 | Doc-sync product docs + **fast-forward push `main`** | DOC/SEC | `playbooks/self-improver.md:55`; `principles.md:127`; `github.md:146` | Yes → Documentator (privileged write) |
| 27 | Write the `## SI Summary` closing narrative | DOC | `templates/SI-summary-comment-template.md:1-37`; `artifacts.md:176` | Yes → Documentator |
| 28 | Author/patch skills + grant them (`set-permission --tool skill`) | TOOL | `playbooks/self-improver.md:101,129` | Partial → Platform/Tooling |
| 29 | Harden `pipeline-state.rs` + `.opencode/scripts/*` | TOOL/SM | `playbooks/self-improver.md:56,129,134`; `principles.md:136` | No (§5) |
| 30 | Own the state machine's *logic* | SM | `state-machine.md:61`; `principles.md:136` | No (§5) |
| 31 | `set-permission` — edit agent `permission` blocks | SEC | `state-machine.md:95`; `permissions.md:43-61`; `pipeline-state.rs:4772` | No (§5) |
| 32 | Own the `external_directory` sandbox map | SEC | `permissions.md:38-39` | No (§5) |
| 33 | Public-repo hardening (`hardening-lock-open-issues`, `interaction-limit`) | SEC | `state-machine.md:106-107`; `github.md:138-139`; `pipeline-state.rs:4779-4780` | No (§5) |
| 34 | `close-dependabot-prs` | SEC | `pipeline-state.rs:4781` | No (§5) |
| 35 | Own `pre-commit.ps1` git hook | TOOL | `pipeline-state/SKILL.md:88` | No (§5) |
| 36 | Read `metrics`/`health`/`improvement`; classify `rootCause` on restart | MET | `playbooks/self-improver.md:81`; `state-machine.md:101-103`; `pipeline-state/SKILL.md:54` | Partial → Measurement |
| 37 | Fix metric/data-capture bugs (survivor denominators, `blocked` conflation, dead `root_cause_mix`, `guardId`) | MET | `research/27:32-42,185-191`; `research/26:230-237` | No (§5) |
| 38 | Staffing heuristic `ceil(points/5)`, max 2 active/dev | STF | `playbooks/self-improver.md:34`; `staffing.md:9-40` | Yes → Orchestrator |
| 39 | Block/unblock; 4h SLA; escalate >3 rejections | BLK | `playbooks/self-improver.md:36,75`; `staffing.md:55-63`; `pipeline.md:251-255` | Yes → Orchestrator |
| 40 | Model-availability triage (G-048) | BLK | `playbooks/self-improver.md:36` | Yes → Orchestrator |
| 41 | Cleanup/teardown: remove worktrees, prune, `close-issue --to-phase done` | CLN | `playbooks/self-improver.md:57-58`; `pipeline.md:217-229`; `pipeline-state.rs:4763` | Yes → Orchestrator |
| 42 | `link-revision` backfill (with PO) | MET/ORCH | `pipeline-state/SKILL.md:29`; `pipeline-state.rs:4778` | Partial |
| 43 | `upload-evidence` (shared with Tester) | ORCH | `state-machine.md:96`; `pipeline-state.rs:4775` | Shared |
| 44 | `tests-commit` (shared with Tester) | ORCH | `state-machine.md:86`; `pipeline-state.rs:4773` | Shared |

**Root of the bundling:** the SI's own identity (`agents/self-improver.md:2`) and `opencode.json:450` explicitly bundle "orchestrator AND auditor … documentation owner … improves the pipeline."

---

## 2. Ownership Gates (what the SI exclusively owns)

**State-machine / pipeline authority (role-gated in `pipeline-state.rs:4754-4781`):**
- `transition` (`:4761`), `close-issue` (`:4763`), `audit-record` (`:4774`), `update-plan` (`:4766`), `triage-init` (`:4767`), `record-improvement` (`:4777`), `set-permission` (`:4772`), `hardening-lock-open-issues`/`interaction-limit`/`close-dependabot-prs` (`:4779-4781`) — SI only.
- `block`/`unblock` (`:4762`) — SI + Developer.
- `link-revision` (`:4778`) — SI + PO.
- `tests-commit`/`upload-evidence`/`post-comments` (`:4773-4776`) — SI + Tester.

**State-machine *maintenance* (asset ownership):**
- Sole editor of `pipeline-state.rs`, `pipeline.json`, `state-machine.md`, the `pipeline-state` skill (`state-machine.md:61`; `principles.md:136`).
- Every edit must pass `test-scripts.ps1` (`state-machine.md:65`; `principles.md:142`).
- Anti-tamper: edits logic, **never the append-only record** (`state-machine.md:67`; `principles.md:144`).

**Knowledge-base / documentation ownership:** `### G-` records (`common-rules.md:29`); `common-rules.md` (`playbooks/self-improver.md:108`); the pipeline docs set except `principles.md` (`principles.md:126,138`).

**Security / sandbox:** agent `permission` blocks via `set-permission` (`permissions.md:43-61`); the `external_directory` map (`permissions.md:38-39`); public-repo hardening (`github.md:138-139`).

**Single-writer exception:** `git push origin main` (doc-sync only, fast-forward) (`github.md:146`; `opencode.json:507`).

**Explicitly NOT owned (proposed only):** `principles.md` (`principles.md:138`), `AGENTS.md` (`playbooks/self-improver.md:132`), non-permission `opencode.json` (`permissions.md:58-59`), agent identity files (incident `references.md:582`), `references.md` generally (SI owns only the `G-` records).

---

## 3. Overload / Conflict-of-Interest Findings

- **C1 — The SI orchestrates the exact feature it then audits.** *"the same agent that orchestrated the pipeline now audits it"* (`pipeline.md:203`); the SI's own guardrail concedes *"you orchestrated the very feature you audit"* (`playbooks/self-improver.md:130`). Mitigations exist (record-anchored verdicts, `verify` at start, the `audit` bundle) but the structural conflict remains.
- **C2 — The SI authors the guardrails and then self-grades their effectiveness.** It persists `### G-` records at every audit (`retro-analysis/SKILL.md:211-241`) and self-grades `effectiveness:` (`retro-analysis/SKILL.md:31-69`). Independent audits found the loop *open*: **88/178 (49.4%)** records stay `Pending`, with duplicate IDs and freeform structure (`research/27:38,60,85`; `research/26:153`). `research/27:30` names this the root cause of "we can't tell if we're improving."
- **C3 — The SI owns the referee's code that enforces the guards it is subject to.** It is *"the only agent that edits the state machine's logic"* (`state-machine.md:61`; `principles.md:136`), so it can change the exit guards/transitions/metrics that bind it. Safety gates exist (`test-scripts.ps1`, anti-tamper) but the auditor/improver editing the adjudication logic is a real separation-of-duties concern.
- **C4 — The SI writes the plan sections, the dev narrative, and the closing verdict.** It authors `## Summary`/`## Staffing Plan`/`## Deployment Notes`/`## Risks & Mitigations` (`artifacts.md:130-133`), assembles `dev-summary.md`, and writes the `## SI Summary` (`SI-summary-comment-template.md`). It produces the artifacts it judges.
- **C5 — The SI both writes product docs and judges doc coherence.** It patches product docs and pushes them (`principles.md:127`) while its own audit rule says *"if the product state doesn't match the docs, that is a failure"* (`pipeline.md:208`).
- **C6 — Overbroad write/exec surface for one role.** `opencode.json:456` gives `edit: "allow"` (whole repo) plus `cargo*`/`pnpm*`/`npm*`/`bun*`/`node*` (`:540-543`) and `Remove-Item .opencode/*`. `research/34-security-audit-2026-10-22.md:112` flags this. This contradicts its stated boundary — *"you never research code … you do not open the product source"* (`agents/self-improver.md:8`) and *"The Self-Improver never edits product source code"* (`principles.md:148`).
- **C7 — Brief-composition overload is an evidenced, recurring SI-side root cause.** Omissions are recorded as **SI-side root causes**: G-104 evidence-renderability guard re-fired #2824/#2872/#2905 (`references.md:2612`); author-footer omission in the tester brief (`references.md:1638`); G-098/G-116 QA brief suite-file omissions (#2807/#2797/#2810/#2826/#2838/#2848; `references.md:3565,3614`); G-020 dispatch without the transition (#2770/#2876; `references.md:2015,2928-2934`); dev-summary round mis-stamp (#3029/#3035; `references.md:345-353`). One agent carrying orchestration + audit + improvement + docs exceeds a reliable working set.
- **C8 — The SI repeatedly performs ad-hoc git surgery on the served tree** (force-clean after `tests-commit` residue) — #3035/#3055/#3053/#3048/#3066/#3070 (`references.md:272-281,1022,2479`). Overload manifests as manual recovery labour.
- **C9 — The SI's audit gate carries almost no signal, yet the SI is the measurement owner.** `research/26:205`: `audit.verdict outcome=failed` occurred **once in the whole log; 76/77 pass**; `research/27:30`: the audit gate *"is near-constant — it carries ~zero information about quality."* `root_cause_mix` is dead; `blocked` is 99.9% guard refusals (1,405 vs 21; `research/27:36`).
- **C10 — Two internal contradictions in the SI's own definition.** (a) It is told it has **no telemetry scope** (`agents/self-improver.md:8`), yet the reopen rule requires it to *"verify the failure class against telemetry FIRST"* (`playbooks/self-improver.md:53`). (b) `record-improvement` posts a `## Pipeline Improvement` comment (`playbooks/self-improver.md:79`), but the canonical timeline-comment set is only five and does not include it (`state-machine.md:127`).

---

## 4. Observed Failure Modes (concrete incidents)

| Incident | What broke | Citation |
|---|---|---|
| #2694 | Planner spun 177 context reads; raw A2A template posted 3× | `state-machine.md:326-344` |
| #2717 | SI dispatched all devs to one shared worktree; work lost | `references.md:3195` |
| #2750 r5-6 | SI left served worktree on stale commit; 2 rounds lost | `references.md:2893` |
| #2758 | tauri-driver staleness consumed 7+ rounds | `references.md:2837` |
| G-104 re-fires | Evidence-renderability guard omitted from brief — SI-side | `references.md:2612` |
| G-020 (#2770, #2876) | SI dispatched tester without the transition | `references.md:2015,2928-2934` |
| G-116 (#2838, #2848) | QA brief omitted/forbade suite-file writes | `references.md:3565,3614` |
| #3029/#3035 | No `## Development Summary`; round-2 mis-stamp | `references.md:345-353` |
| #3035/#3055/#3053/#3048/#3066/#3070 | `tests-commit` dirty tree; SI force-cleaned repeatedly | `references.md:272-281,1022` |
| G-033 (#2734, #2974, #2932) | False PASS with FAIL/UNVERIFIED rows | `references.md:3283,3287-3288` |
| Measurement loop | 88/178 guardrails `Pending`; dead `root_cause_mix`; survivor-denominator `first_pass_rate` | `research/27:38,60,79`; `research/26:153` |
| Audit signal | Audit gate 76/77 pass — near-zero information | `research/26:205`; `research/27:30` |

---

## 5. Proposed Concern Map

### Cleanly separable (map to the four roles)
- **Orchestrator** — rows 1-5, 8, 10-11, 38-41, 43-44 (+ orchestration half of 6-7, 9, 42).
- **Auditor** — rows 13-16 (+ judgment half of 7, 9). Note: this split *removes* C1 but **does not** fix C9 (the gate is near-degenerate regardless of who holds it).
- **Documentator** — rows 12, 24-27.
- **SelfImprover** — rows 18-23 (+ 21's measurement read). Remains self-graded (C2) unless effectiveness re-validation moves to the Auditor.

### Does NOT fit any of the four (candidates for additional role(s))
- **A. Pipeline-platform / state-machine stewardship** — rows 29-30, 35. Strongest case for a 5th role. Cannot sit with the Auditor (judged owns judge's code — C3) nor cleanly with the SelfImprover (guardrails enforced by the machine the SI edits).
- **B. Permissions / security hardening** — rows 31-34. A security concern, not orchestration/audit/improvement/docs. `research/34-security-audit-2026-10-22.md:112` already flags the SI's overbroad exec surface (C6).
- **C. Measurement / data-capture** — rows 36-37 (+ 21's effectiveness). Both in-repo reports conclude the core problem is **data capture, not estimation** (`research/26:230-231`; `research/27:42,185-191`). None of the four named roles owns it.
- **D. Skill authoring + consumer granting** — row 28. Overlaps A; could fold into A.

### Recommendation: are 4 roles ENOUGH?
**No — 4 roles are not enough as a clean partition. The evidence supports a 5-role minimum:**
1. **Orchestrator** (rows 1-5, 8, 10-11, 38-41, 43-44)
2. **Auditor** (rows 13-16)
3. **Documentator** (rows 12, 24-27)
4. **SelfImprover** (rows 18-23, minus effectiveness re-validation)
5. **Pipeline Platform / Steward** (rows 28-37: state-machine stewardship + tooling + permissions/security + measurement instrumentation)

**Rationale:**
- The 4-role split fixes C1/C4/C5 and gives orchestration the focus its own failure record demands (C7) — the strongest argument *for* splitting.
- **But it leaves the two highest-privilege concerns unowned:** the referee's code (C3) and the sandbox/permission map (C6). Assigning either back to the Auditor or SelfImprover recreates a conflict equal to or worse than C1.
- **It does not fix C9** (the audit carries ~zero signal). Splitting the auditor off without fixing measurement just relocates a near-constant gate. Measurement/data-capture must be an explicit owner.

**If the constraint is exactly 4 roles**, the least-bad allocation is: give the state-machine + tooling + measurement cluster to the **SelfImprover** (it already owns the machine), and move `set-permission`/`external_directory`/hardening to the **Documentator** or to the human — explicitly accepting conflict C3 and keeping the security surface bundled.

**Practical sequencing note:** the split with the highest evidence-backed payoff is **Orchestrator vs Auditor** (C1 + C7), followed immediately by **separating measurement** (C9). State-machine stewardship is best split only if a 5th role is acceptable; otherwise pair it with the strongest possible external gate (`test-scripts.ps1` as a non-SI-run check).

---

## Appendix — Key Ownership/Config Facts

- SI permission block: `opencode.json:449-577` (`edit:"allow"` `:456`; `task` allow-list = the 5 pipeline roles `:461-468`; skills = `pipeline-state`, `retro-analysis`, `dev-environment` `:474-479`; `git push origin main` allow `:507`).
- Role gates: `pipeline-state.rs:4754-4781`.
- Phase ownership (`pipeline.json`): `planning`/`audit`/`cleanup`/`done` owned by `self-improver` (`:16,34,40,46`).
- SI declared improvement toolkit: playbooks, skills, scripts, references, pipeline docs; agent identity + `AGENTS.md` + principles + non-permission `opencode.json` are **proposed only** (`principles.md:120-129`).
