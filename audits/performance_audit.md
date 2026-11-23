# Fredo Pipeline — Performance Audit

_Generated from the pipeline's own event store, docs, and instrumentation. Read-only research: no product or pipeline code was changed._
_Verified 2026-11-23 against the raw event store, `pipeline-state.rs`, `references.md`, playbooks, and `opencode.json`. Every headline number below was re-derived from source; definitions and residual caveats are in "Measurement definitions & verification" at the bottom._

Sources: `.opencode/state/issues/*.jsonl`, `.opencode/scripts/pipeline-state.rs`, `docs/agentic-pipeline/**`, all 11 role playbooks, and `references.md`.

---

## Headline numbers (71 real specs #3000+, excluding fixture #633; 64 reached implementation)

| Signal | Value |
|---|---|
| Implementation entries / classified rework rounds / audit restarts | 118 / 45 / 6 |
| Fix Plan comments posted (5 via the unclassified fallback path — see B3) | 50 |
| Worktrees created / evidence uploads / ad-hoc scripts (deduped) | 376 / 438 / **548** |
| Real `state_machine.failure` events | 134 |
| Guardrail records in `references.md` | **446** (1.2 MB, 97.8% in one section) |
| Of those: never verified / no executable artifact behind them / stub headings / duplicate IDs | 41% (184) / 71% / 30 / 3 (G-080, G-103, G-104) |
| Oct → Nov: mean rounds · mean story pts · first-pass share | 1.6→2.7 · 15.9→27.5 · 59%→30% |
| First-pass vs reworked impl span (mean/median) | 70/35 min vs 473/237 min |
| First-pass vs reworked **pure impl phase time** (mean/median) | 70/35 min vs 311/125 min |

### Phase-time split

"Span" = first phase start → last phase end (for multi-round specs this **includes the testing/audit gaps between rounds**); "pure" = sum of started→completed phase intervals only. First-pass specs are single-round, so span = pure.

| | first-pass specs (n=35) | reworked specs (n=29) |
|---|---|---|
| impl span (mean / median) | 70 / 35 min | **473 / 237 min** |
| impl pure phase time (mean / median) | 70 / 35 min | **311 / 125 min** |
| testing span (mean) | 89 min | 369 min |
| active cycle, planning start → close (mean / median) | 315 / 137 min | **633 / 295 min** |

Reworked specs burn ~2× the active cycle and ~4.4× the pure implementation time. The impl-span ratio (6.8×) overstates implementation work because it counts inter-round verification gaps — quote the pure numbers for implementation effort, the span for round-trip cost.

### Oct → Nov trend (the "last week" effect)

| window | impl span mean | impl span median | pure impl mean | mean rounds | mean story pts | first-pass |
|---|---|---|---|---|---|---|
| Oct (#3000–3122, n=54) | 164 min | 73 min | 106 min | 1.6 | 15.9 | 59% |
| Nov (#3141–3188, n=10) | **732 min** | **487 min** | **572 min** | **2.7** | **27.5** | **30%** |

Both variables moved the wrong way at once: specs doubled in size _and_ the rework rate nearly doubled. Caveat: November specs were also intrinsically harder (native bindgen toolchain, release-artifact gates), so size and difficulty are confounded — the size cap (A1) must ship with the drivability census (A3), not alone.

---

## Top rework/slowness cases

| Issue | Signal |
|---|---|
| #3141 | 69.6 h active (79.7 h wall − 10.1 h blocked); 5 impl, 4 rework, 1 restart; 45.9 h pure impl at **1.61 events/h** (74 events) — waiting on a broken bindgen toolchain; 122 ad-hoc scripts |
| #3120 | 9 impl entries, 7 Fix Plan rounds (rounds 2/3/4/6/7/8/9 — the round-5 stamp was skipped by formula divergence, B1), 5 classified root causes; 3 blocks, all human Gate-H pilot sessions that cannot be fabricated |
| #3181 | 5 impl, 4 rework, 2 blocks — both blocks are forbidden-to-edit sibling files (`test-scripts.ps1`, `launch-artifact-probe.ps1`) |
| #3147 | 54.2 h backlog idle + 101 ad-hoc scripts; audit restart for stale env evidence with a byte-identical `apps/` subtree |
| #3152 | 4 impl rounds lost to evidence/verdict plumbing: the flush refuses a valid verdict draft and the round-advance deadlock fails the leg closed (pipeline-state.rs:4940–4965); 134 ad-hoc scripts |
| #3071 | Longest wall-clock (157 h) but 145.2 h was backlog idle; single restart was a doc-sync gap |

---

## The root-cause model (4 layers)

1. **Scope layer — specs got too big.** Plans went 57–60 KB (early Oct) → 146–207 KB (Nov); 21–30 SP specs average 2.83 rounds (n=12). Bigger plan = more ACs + more live evidence = more surface to fail.
2. **Instrument layer — rounds are lost on paperwork, not product.** Nov rework mix flipped to `technique=6/14` (43%, was 2/31 = 6% in Oct): stale-by-head verdicts, undrivable plan rows, consumed-draft evidence, guard over-credit.
3. **Machine layer — mechanics leak wall-clock and extra rounds.** Four round-stamp formulas (`retry_state` max-formula :6849, Fix Plan impl-entries+1 :4289, Dev Summary testing-entries+1 :4361, Tests Runs `retry_state` at post time :4369), no `gh`/`git` timeouts (:230/:239), full-timeline re-download per action (:1640), one-env-per-issue, post-audit detour on every restart.
4. **Multiplier — instruction bloat.** Every agent loads 75–250 KB at wake; guardrail prose is inlined into 6 playbooks (G- citations: orchestrator 117, tester 91, QA 89, architect 84, developer 48, auditor 18) and re-narrated from a 446-record ledger where only ~29% of lessons mention an executable check.

Note: raw wall-clock is also dominated by **backlog idleness** (#3071 sat 145 h in backlog; #3147 54 h). Genuine in-phase slowness is **build/toolchain waits** (#3141) and **diagnostic loops** (#3147/#3152/#3181: 100+ ad-hoc scripts each).

---

## Fix table — A. Scope & planning

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **A1** | SP 15.9→27.5; 21–30 SP = 2.83 rounds. Planning never caps size. | **Hard WIP/size cap** — reject a plan >~15 SP or >N ACs unless PO splits. PO/architect enforce in `triage.md`; orchestrator convergence refuses oversize. **Ship paired with A3** — size correlates with rework but Nov difficulty confounds it; the cap alone treats the symptom. | Attacks the strongest predictor of rework. | More specs; more planning handoffs; PO pushback. | S / **High** |
| **A2** | Plans 146–207 KB, one giant comment; #3036 lost its plan (post failure during an API outage, pipeline-state.rs:4316). | **Plan size budget + section-per-comment**; machine splits/warns on >X KB. | Smaller reads per role; no lost plan. | More comments to navigate. | M / Med |
| **A3** | Technique rounds from undrivable rows (#3141 two-env, #3151 9/43, G-316/419/440/452). | **Plan-time drivability census** — QA must name the executor + evidence path per AC; a toolsmith script proves each row is drivable before `planning→implementation`. | Kills the fastest-growing rework class. | New gate to maintain; needs tooling. | M / **High** |
| **A4** | #3120/#3115 blocked on human pilot sessions that can't be fabricated. | **Refuse human-gate ACs in the pipeline** or mark them `human-gated` and exclude from the verdict. PO intake rule + machine allowlist. | Unblocks structurally unpassable specs. | Some features leave the pipeline. | S / Med |

## B. Rework mechanics (state machine)

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **B1** | Four round-stamp formulas; G-427 saw rounds 6/7/8 vs 4/5/6 + double fix plan; #3120's Fix Plans skip round 5. | **One round authority** — compute round once, stamp every artifact from it. Machinist edits `pipeline-state.rs` (`retry_state`, fix-plan title, summary, tests). | Removes a documented recurring defect. | Central refactor of tested code. | M / **High** |
| **B2** | `is_rework_reentry` keys on source phase (:4261) → fix plan posts on PASS legs (G-095/G-339). | **Key on destination + prior verdict=FAIL**, not source phase. | No spurious Fix Plans / confusion. | Needs verdict lookup (already available). | S / Med |
| **B3** | Fallback fix plan only keeps `ST`-prefixed lines (:2703) → can be empty; fallback bypasses root-cause classification — 5 of 50 Fix Plans posted unclassified. | **Fix extraction** (match template) + **require root-cause on fallback** too. | Fallback stops emitting empty/unclassified rounds; rework metrics become complete. | Touches comments path. | S / Med |
| **B4** | Every restart detours through post-audit + mandatory Curator event before dev resumes (serialized, :3847). | **Parallelize, don't skip**: dispatch the rework developer immediately and run the Curator pass concurrently (curation lands via the existing maint-pr before the next success gate). Keep post-audit mandatory for success only. | One less serialized hop per restart; preserves principle 6. | Needs a concurrency-safe curation lane (human OK). | M / Med |
| **B5** | Round guard reads round, not commit (:3643) → stale-by-head PASS advances (G-434). | **Bind verdict to tested commit SHA**; guard compares SHA to merged tip. | Closes a silent false-green. | Requires verdicts to carry SHA. | S / **High** |

## C. Evidence & verification

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **C1** | Any post-capture commit invalidates served-commit; byte-identical product still re-serves (#3147 restart message, G-357). | **Product-subtree diff**: re-serve only if product changed; otherwise re-stamp. Toolsmith script + tester rule. | Saves full re-serve+re-test rounds. | Subtle subtree-boundary logic (docs/pipeline-only commits must not force re-serve either). | M / **High** |
| **C2** | Citing a consumed draft as AC evidence FAILs zero-defect specs (G-415). | **Machine-flag draft references** in verdicts (refuse as evidence). | Prevents a whole class of technique rounds. | Small guard addition. | S / Med |
| **C3** | Strict verdict reader requires body to START with `## Tests Runs` (:3016); lenient flush treats ANY line carrying the header as already-headed (:4382) → flush posts a verdict the reader cannot see; #3152 round-advance deadlock (:4940). | **One parser** shared by verification + flush. | Removes a deadlock. | Must preserve both behaviours. | S / Med |
| **C4** | Absence guards prove a token list, not the clause (G-430/441/445). | **Machine-checked guard universe** (scanned/excluded counts, built-vs-pristine equality) generated, not prose. | Turns over-credit into a hard failure. | Tooling investment. | M / Med |
| **C5** | Env-id fallback `spec<N>` (:3378/:3465) vs actual `wf<N>-a`/`qa<N>-a` ids; formatting/footer/image gates deadlock. | **Harden env-record + formatting gates** (single env-id source; pre-post lint of footer/URL/BOM). | Fewer paperwork deadlocks. | Low. | S / Low-Med |

## D. Tooling & automation

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **D1** | 548 ad-hoc scripts across 18 issues; slowest specs are the ad-hoc-heavy ones (#3152: 134, #3141: 122, #3147: 101). | **Promote recurring probe families to committed tools** (env scan, port-bind, CSP/webview, evidence capture, comment fetch). Toolsmith ships script + skill + test pin. Leave one-off probes ad hoc — do not toolify every script. | Big cut in diagnosis time; reusable. | Upfront build; needs owners. | L / **High** |
| **D2** | Deterministic checks done in prose: sweeps, inventories, literal counts, tree receipts (G-444/443/441/432). | **Automate them** as lint scripts invoked by name (not docs). | Faster, repeatable, no missed re-derivation. | New tooling surface. | M-L / **High** |
| **D3** | 17 of 18 evidence-upload failures were missing-path; `gh-image` auth breaks. | **Evidence preflight** (path exists, ext, auth) before the round. | Stops evidence-driven round loss. | Small. | S / Med |
| **D4** | Architect told to read `telemetry_spans` via `telemetry-query` (software-architect.md:33) but the skill is denied in `opencode.json`. | **Grant the skill** (human-owned `opencode.json`). | Root-cause research works. | Human edit only. | S / Low |

## E. Instruction & guardrail bloat

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **E1** | 446 records, 184 Pending (41%), 30 stubs, 3 dup IDs, only ~29% mention an executable check. | **Curate pass**: rename stubs, merge duplicate-ID/family records (estimated ~25–30% collapsible — judgment call, not measured), retire stale Pending. Curator/Machinist. | Smaller, greppable, trustworthy ledger. | Judgement + time. **No policy change needed**: the Curator already owns `Known Failure Modes` (references.md:3); only the event log is append-only. | M / **High** |
| **E2** | Guardrail text copied into 6 playbooks; 1.2 MB ledger re-narrated per role. | **Progressive disclosure** — playbooks cite G-IDs, load only phase-relevant ones. | Cuts wake load 75–250 KB → far less. | Agents must fetch on demand. | M / **High** |
| **E3** | Curator mandatory at every success gate (:3847) → monotonic growth, no retirement. | **Run Curator only on failure or when a lesson exists**; enforce retire-when-extinct. | Stops accumulation. | Some lessons unrecorded. | S / Med |
| **E4** | Orchestrator 78 KB, Tester 74 KB, QA 54 KB, Architect 50 KB. | **Split playbooks** (core + phase appendices). | Less attention tax every dispatch. | Restructure effort. | M / Med |
| **E5** | Toolsmith/Machinist playbooks named as fix home in only **3** of 446 records (10 more route tooling fixes there in prose). | **Route Class→Lever** to code/script first; prose only as last resort. | Lessons actually prevent recurrence. | Requires discipline. | S / Med |

## F. Machine/process serialization

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **F1** | No timeouts on `gh`/`git` (:230/:239); one hang stalls an action. | **Add bounded timeouts + retries** in `run_cmd`/`run_gh`. | Removes silent stalls. | Low risk. | S / Med |
| **F2** | Every action re-downloads the whole timeline (:1640, no cache/pagination); `read_issue_events` re-reads the full event file per call — `retry_state` alone calls it 3× (:6834–6850). | **Cache + paginate comments/events**; read once per wake; memoize `retry_state` inputs. | Biggest per-action latency win; the triple-read is a trivial first cut. | Caching invalidation. | M / **High** |
| **F3** | Single orchestrator writer + serialized dev waves + one spec branch. | **Parallelize disjoint waves**; allow dev branches merged to spec. **DEFER** — rework is dominated by technique/evidence failures, not serialization; low evidence of payoff. | More concurrency. | Merge conflicts; principle 2 rewrite. | L / Med (deferred) |
| **F4** | Cross-owner blocks: dev can't edit `test-scripts.ps1` / `launch-artifact-probe.ps1` (#3181 ×2, verbatim in block events). | **Fix-plan ownership pre-check**: route sibling-owned edits to the owner or pre-grant scope. | Removes avoidable round-killing blocks. | Permission churn. | S / **High** |
| **F5** | Tester can't block (`block`/`unblock` gated to orchestrator/developer, :6018) or author suite nits → orchestrator round-trip. | **Let tester block + patch trivial suite defects.** | Fewer hops. | Slightly more test power. | S / Med |
| **F6** | One env per issue; no parallel testing. | **Per-round parallel envs** for independent ACs. **DEFER** — same evidence gap as F3; cost/complexity high. | Shorter testing wall-clock. | Cost/complexity; principle change. | L / Low-Med (deferred) |

## G. Measurement & hygiene

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **G1** | Fixture `633.jsonl` (3.7 MB, 10,756 events, 345 full cycles / 690 worktree creates) lives in the real event store. It dominates `phase=unknown` (9,470 store-wide) and contributes 1,170 of 8,766 store-wide `self-improver` events (13% — the rest are real Oct specs using that actor name). | **Quarantine fixtures** out of `.opencode/state/issues`; rename the legacy `self-improver` actor in trend queries. | Metrics become real. | Need to verify integrity. | S / **High** (on decisions) |
| **G2** | 2.87 GB runaway log (`dev-env-stdout-20261008-153613.log`, 2,939 MB); 13.4 GB `.opencode/tmp` (105,553 files). | **Rotate/cap logs; prune tmp at cleanup.** | Disk + scan speed; less noise. | Housekeeping. | S / Med |
| **G3** | 4 open blocks: #2694 (103.9 days), #2711 (103.1 days), #3081 (28 days), #3172 (3.8 days). | **Close the abandoned specs** (the two 103-day blocks are dead work, not live blockers); auto-escalate only recent blocks (>240 min). | Cleaner WIP. | Confirm abandonment with PO before closing. | S / Low-Med |
| **G4** | Pilot exit review template carries no cycle-time/rounds/rework/ad-hoc fields — an empty instrument for pipeline measurement. | **Add a real retrospective**: rounds, rework class, cycle time, ad-hoc count per spec. | Lets you see if fixes work. | Build effort. | M / **High** |
| **G5** | Event-store integrity: 1 malformed JSON line in `2745.jsonl` (missing opening brace); `ad-hoc-scripts` events double-stamped (every count recorded twice — metrics must dedup). | **Validate-on-append + emit-side dedup** in the state machine; a store-integrity check in `test-scripts.ps1`. | Trustworthy measurement substrate. | Small. | S / Med |

## H. Legacy surface & safety

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **H1** | 33 verbs incl. dead `generate-work` (prints "REMOVED", records a blocked event), legacy labels, mock verbs (`mock-gh`/`mock-git`/`mock-commit`) in prod binary. | **Prune deprecated actions/labels/mock verbs.** | Smaller, clearer surface. | Back-compat breaks. | M / Med |
| **H2** | Duplicate channels: 2 verdict (comment + draft flush, plus reconcile), 2 fix-plan (authored + fallback compaction), 2 dev-verify (dev-verify drafts + Development Summary). | **Collapse to one channel each.** | Fewer wrong turns. | Migration. | M / Med |
| **H3** | Worktree default is shared per-issue and reused (:5250/:5269); the create-path sweeps leftover dirs with `remove_dir_all` without a dirty check (:5274). `--human-authorized` is scoped (testing→implementation only, non-empty reason required, auditable event — :4926–4997) but **nothing verifies a human actually authorized it**: the orchestrator can self-assert the flag. | **Dirty-check before sweep + unique worktree paths + human-provenance check on the flag** (e.g. a recorded human comment reference). | Prevents silent loss/abuse. | Careful test coverage. | S / Med |

---

## Recommended sequence

**Do now (high impact, low effort):** G1, G5, B5, C3, F1, B1, C1, F4, G2, E3.

**Next (tooling investment):** A1+A3 (ship together), D1, D2, E1, E2, F2 (start with the `retry_state` triple-read), C4.

**Structural (needs a principle/human decision):** B4 (parallel-curator variant), H1/H2.

**Deferred (low evidence of payoff):** F3, F6 — rework is technique/evidence-driven, not serialization-driven; revisit only after the instrument-layer fixes land and G4 retrospectives show serialization still dominates.

**Housekeeping:** G3 — close #2694/#2711 as abandoned (PO confirm), escalate #3081/#3172.

**Human-owned touchpoints** (agents can't edit): `AGENTS.md`, `opencode.json` (D4 grant, F4 permission), `principles.md` (B4/F3/F6). Those need human sign-off.

---

## Measurement definitions & verification

Re-derived 2026-11-23 from the raw store (71 files ≥#3000; fixture #633 excluded):

- **Rounds** = the machine's own `retry_state` formula: `max(testing entries, rework re-entries + 1)`. Oct 1.61 / Nov 2.70.
- **Rework loops** = `rework.rootcause` events (45). Fix Plan comments = 50; the 5-event gap is the unclassified fallback path (B3). The original draft's "44" matched neither raw count and is corrected.
- **First-pass** = exactly 1 implementation entry and no audit restart (35 of 64 specs that reached implementation; Oct 59%, Nov 30%).
- **Impl span vs pure phase time**: span = first impl start → last impl end (includes inter-round testing/audit gaps); pure = sum of started→completed intervals. Reworked: span 473/237, pure 311/125. The original "total cycle 994 min" was a sum of overlapping phase spans (double-counts interleaved rounds); replaced by the clean active-cycle metric (planning start → close: 315 vs 633 min).
- **Ad-hoc scripts** = per-issue counts deduped (events are double-stamped, G5): sum 548 across 18 issues.
- **Guardrail ledger**: 446 `### G-` records; 97.8% of bytes in `Known Failure Modes`; 184 effectiveness=Pending; 30 `on_the_go_improvement` stubs; duplicate IDs G-080/G-103/G-104; ~29% of records mention an executable artifact (script/test/runner) anywhere — the other 71% are prose-only. "~25–30% collapsible" (E1) is an estimate, not a measurement.
- **Not locally verifiable**: the "2,826-comment spec" figure is GitHub-side (comment events + uploads make it plausible, but it was not re-counted via `gh`). Treat as indicative.
- **Corrections applied to the original draft**: rework count 44→45 (+50 Fix Plans); "impl phase" relabeled as span with pure numbers added; total cycle 994→633 (definition fixed); verbs 34→33; `--human-authorized` "unchecked" → scoped-but-unprovenanced; fixture inflation framed correctly (store-wide actor counts vs fixture contribution); E1 retirement con removed (Curator already owns the section); G3 escalation → close-abandoned; F3/F6 deferred; B4 → parallel-curator; G5 added.

---

## Bottom line

The pipeline is slow mainly because **specs are too big and rounds are lost on evidence/plan instrumentation**, then compounded by state-machine round-stamp bugs, serialization, and a 1.2 MB guardrail ledger that mostly re-writes prose instead of shipping executable checks. The "do now" items above address the largest share without changing the architecture; A1+A3 together attack the scope layer, and G4 retrospectives are how you'll know any of it worked.
