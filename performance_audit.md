# Fredo Pipeline — Performance Audit

_Generated from the pipeline's own event store, docs, and instrumentation. Read-only research: no product or pipeline code was changed._

Sources: `.opencode/state/issues/*.jsonl`, `.opencode/scripts/pipeline-state.rs`, `docs/agentic-pipeline/**`, all 11 role playbooks, and `references.md`.

---

## Headline numbers (71 real specs #3000+, excluding fixture #633)

| Signal | Value |
|---|---|
| Implementation entries / rework loops / audit restarts | 118 / 44 / 6 |
| Worktrees created / evidence uploads / ad-hoc scripts | 376 / 438 / **548** |
| Real `state_machine.failure` events | 134 |
| Guardrail records in `references.md` | **446** (1.2 MB, 97.9% in one section) |
| Of those: never verified / no code-or-test behind them / stub headings / duplicate IDs | 41% / 71% / 30 / 3 |
| Oct → Nov: mean rounds · mean story pts · first-pass share | 1.6→2.7 · 15.9→27.5 · 59%→30% |
| First-pass vs reworked impl (mean/median) | 70/35 min vs 473/237 min |

### Phase-time split

| | first-pass specs | reworked specs |
|---|---|---|
| impl phase (mean / median) | 70 / 35 min | **473 / 237 min** |
| testing phase (mean) | 89 min | 369 min |
| total cycle (mean) | 308 min | **994 min** |

### Oct → Nov trend (the "last week" effect)

| window | impl mean | impl median | mean rounds | mean story pts | first-pass |
|---|---|---|---|---|---|
| Oct (#3000–3122, n=54) | 164 min | 73 min | 1.6 | 15.9 | 59% |
| Nov (#3141–3188, n=10) | **732 min** | **487 min** | **2.7** | **27.5** | **30%** |

Both variables moved the wrong way at once: specs doubled in size _and_ the rework rate nearly doubled.

---

## Top rework/slowness cases

| Issue | Signal |
|---|---|
| #3141 | 69 h active; 5 impl, 4 rework, 1 restart; 46 h impl at **1.6 events/h** — waiting on a broken bindgen toolchain |
| #3120 | 9 impl entries, 7 rework, 3 blocks; blocked on human Gate-H pilot sessions that cannot be fabricated |
| #3181 | 5 impl, 4 rework, 2 blocks — both blocks are forbidden-to-edit sibling files (`test-scripts.ps1`, `launch-artifact-probe.ps1`) |
| #3147 | 54 h backlog idle + 101 ad-hoc scripts; audit restart for stale env evidence with a byte-identical product tree |
| #3152 | 4 rounds lost to evidence/verdict plumbing and a lenient-vs-strict verdict parser mismatch |
| #3071 | Longest wall-clock (157 h) but 145 h was backlog idle; single restart was a doc-sync gap |

---

## The root-cause model (4 layers)

1. **Scope layer — specs got too big.** Plans went 50–80 KB → 140–214 KB; 21–30 SP specs average 2.8 rounds. Bigger plan = more ACs + more live evidence = more surface to fail.
2. **Instrument layer — rounds are lost on paperwork, not product.** Nov rework mix flipped to `technique=6/14` (43%, was 6%): stale-by-head verdicts, undrivable plan rows, consumed-draft evidence, guard over-credit.
3. **Machine layer — mechanics leak wall-clock and extra rounds.** Four round-stamp formulas, no `gh`/`git` timeouts, full-timeline re-download per action, one-env-per-issue, post-audit detour on every restart.
4. **Multiplier — instruction bloat.** Every agent loads 75–250 KB at wake; guardrail prose is inlined into 5–6 playbooks and re-narrated from a 446-record ledger where only 29% of lessons became executable checks.

Note: raw wall-clock is also dominated by **backlog idleness** (#3071 sat 145 h in backlog; #3147 54 h). Genuine in-phase slowness is **build/toolchain waits** (#3141) and **diagnostic loops** (#3147/#3152/#3181: 100+ ad-hoc scripts).

---

## Fix table — A. Scope & planning

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **A1** | SP 15.9→27.5; 21–30 SP = 2.8 rounds. Planning never caps size. | **Hard WIP/size cap** — reject a plan >~15 SP or >N ACs unless PO splits. PO/architect enforce in `triage.md`; orchestrator convergence refuses oversize. | Attacks the strongest predictor of rework. | More specs; more planning handoffs; PO pushback. | S / **High** |
| **A2** | Plans 140–214 KB, one giant comment; #3036 lost its plan. | **Plan size budget + section-per-comment**; machine splits/warns on >X KB. | Smaller reads per role; no lost plan. | More comments to navigate. | M / Med |
| **A3** | Technique rounds from undrivable rows (#3141 two-env, #3151 9/43, G-316/419/440/452). | **Plan-time drivability census** — QA must name the executor + evidence path per AC; a toolsmith script proves each row is drivable before `planning→implementation`. | Kills the fastest-growing rework class. | New gate to maintain; needs tooling. | M / **High** |
| **A4** | #3120/#3115 blocked on human pilot sessions that can't be fabricated. | **Refuse human-gate ACs in the pipeline** or mark them `human-gated` and exclude from the verdict. PO intake rule + machine allowlist. | Unblocks structurally unpassable specs. | Some features leave the pipeline. | S / Med |

## B. Rework mechanics (state machine)

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **B1** | Four round-stamp formulas; G-427 saw rounds 6/7/8 vs 4/5/6 + double fix plan. | **One round authority** — compute round once, stamp every artifact from it. Machinist edits `pipeline-state.rs` (`retry_state`, fix-plan title, summary, tests). | Removes a documented recurring defect. | Central refactor of tested code. | M / **High** |
| **B2** | `is_rework_reentry` keys on source phase → fix plan posts on PASS legs (G-095/G-339). | **Key on destination + prior verdict=FAIL**, not source phase. | No spurious Fix Plans / confusion. | Needs verdict lookup (already available). | S / Med |
| **B3** | Fallback fix plan only keeps `ST`-prefixed lines (template says "Sub-task") → can be empty; fallback unclassified. | **Fix extraction** (match template) + **require root-cause on fallback** too. | Fallback stops emitting empty/unclassified rounds. | Touches comments path. | S / Med |
| **B4** | Every restart detours through post-audit + mandatory Curator event before dev resumes (serialized). | **Allow `audit→<phase>` direct on restart**; keep post-audit for success only. | One less hop per restart. | Weakens "improve before rerun" principle (needs human OK). | M / Med |
| **B5** | Round guard reads round, not commit → stale-by-head PASS advances (G-434). | **Bind verdict to tested commit SHA**; guard compares SHA to merged tip. | Closes a silent false-green. | Requires verdicts to carry SHA. | S / **High** |

## C. Evidence & verification

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **C1** | Any post-capture commit invalidates served-commit; byte-identical product still re-serves (#3147, G-357). | **Product-subtree diff**: re-serve only if product changed; otherwise re-stamp. Toolsmith script + tester rule. | Saves full re-serve+re-test rounds. | Subtle subtree-boundary logic. | M / **High** |
| **C2** | Citing a consumed draft as AC evidence FAILs zero-defect specs (G-415). | **Machine-flag draft references** in verdicts (refuse as evidence). | Prevents a whole class of technique rounds. | Small guard addition. | S / Med |
| **C3** | Lenient vs strict verdict parsers → flush refuses a valid verdict, fails leg closed (#3152). | **One parser** shared by verification + flush. | Removes a deadlock. | Must preserve both behaviours. | S / Med |
| **C4** | Absence guards prove a token list, not the clause (G-430/441/445). | **Machine-checked guard universe** (scanned/excluded counts, built-vs-pristine equality) generated, not prose. | Turns over-credit into a hard failure. | Tooling investment. | M / Med |
| **C5** | Env-id fallback `spec<N>` vs documented `wf<N>-a`; formatting/footer/image gates deadlock. | **Harden env-record + formatting gates** (single env-id source; pre-post lint of footer/URL/BOM). | Fewer paperwork deadlocks. | Low. | S / Low-Med |

## D. Tooling & automation

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **D1** | 548 ad-hoc scripts across 18 issues; slowest specs are the ad-hoc-heavy ones. | **Promote recurring probes to committed tools** (env scan, port-bind, CSP/webview, evidence capture). Toolsmith ships script + skill + test pin. | Big cut in diagnosis time; reusable. | Upfront build; needs owners. | L / **High** |
| **D2** | Deterministic checks done in prose: sweeps, inventories, literal counts, tree receipts (G-444/443/441/432). | **Automate them** as lint scripts invoked by name (not docs). | Faster, repeatable, no missed re-derivation. | New tooling surface. | M-L / **High** |
| **D3** | 17 evidence uploads failed on missing path; `gh-image` auth breaks. | **Evidence preflight** (path exists, ext, auth) before the round. | Stops evidence-driven round loss. | Small. | S / Med |
| **D4** | Architect told to read `telemetry_spans` but has no `telemetry-query` grant. | **Grant the skill** (human-owned `opencode.json`). | Root-cause research works. | Human edit only. | S / Low |

## E. Instruction & guardrail bloat

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **E1** | 446 records, 41% Pending, 30 stubs, 3 dup IDs, only 29% executable. | **Curate pass**: rename stubs, merge duplicate-ID/family records (~25–30% collapsible), retire stale Pending. Curator/Machinist. | Smaller, greppable, trustworthy ledger. | Judgement + time; append-only policy must allow retirement. | M / **High** |
| **E2** | Guardrail text copied into 5–6 playbooks; 1.2 MB re-narrated per role. | **Progressive disclosure** — playbooks cite G-IDs, load only phase-relevant ones. | Cuts wake load 75–250 KB → far less. | Agents must fetch on demand. | M / **High** |
| **E3** | Curator runs on every success gate → ~2 records/spec, monotonic growth, no retirement. | **Run Curator only on failure or when a lesson exists**; enforce retire-when-extinct. | Stops accumulation. | Some lessons unrecorded. | S / Med |
| **E4** | Orchestrator 78 KB, Tester 74 KB, QA 54 KB, Architect 50 KB. | **Split playbooks** (core + phase appendices). | Less attention tax every dispatch. | Restructure effort. | M / Med |
| **E5** | Toolsmith/Machinist named as fix home in only **3** of 446 records. | **Route Class→Lever** to code/script first; prose only as last resort. | Lessons actually prevent recurrence. | Requires discipline. | S / Med |

## F. Machine/process serialization

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **F1** | No timeouts on `gh`/`git`; one hang stalls an action. | **Add bounded timeouts + retries** in `run_cmd`. | Removes silent stalls. | Low risk. | S / Med |
| **F2** | Every action re-downloads the whole timeline (2 826-comment specs) + rescans event log repeatedly. | **Cache + paginate comments/events**; read once per wake. | Biggest per-action latency win. | Caching invalidation. | M / **High** |
| **F3** | Single orchestrator writer + serialized dev waves + one spec branch. | **Parallelize disjoint waves**; allow dev branches merged to spec. | More concurrency. | Merge conflicts; principle 2 rewrite. | L / Med |
| **F4** | Cross-owner blocks: dev can't edit `test-scripts.ps1` / `launch-artifact-probe.ps1` (#3181 ×2). | **Fix-plan ownership pre-check**: route sibling-owned edits to the owner or pre-grant scope. | Removes avoidable round-killing blocks. | Permission churn. | S / **High** |
| **F5** | Tester can't block or author suite nits → orchestrator round-trip. | **Let tester block + patch trivial suite defects.** | Fewer hops. | Slightly more test power. | S / Med |
| **F6** | One env per issue; no parallel testing. | **Per-round parallel envs** for independent ACs. | Shorter testing wall-clock. | Cost/complexity; principle change. | L / Low-Med |

## G. Measurement & hygiene

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **G1** | Fixture `633.jsonl` (3.7 MB, ~690 cycles) lives in the real event store; inflates `self-improver=8766`, `unknown=9472`. | **Quarantine fixtures** out of `.opencode/state/issues`. | Metrics become real. | Need to verify integrity. | S / **High** (on decisions) |
| **G2** | 2.87 GB runaway log; 13.7 GB `.opencode/tmp`. | **Rotate/cap logs; prune tmp at cleanup.** | Disk + scan speed; less noise. | Housekeeping. | S / Med |
| **G3** | 4 blockers stale >240 min (#2694/#2711 ~103 days). | **Auto-escalate/close stale blocks.** | Cleaner WIP. | Could close live work. | S / Low-Med |
| **G4** | Pilot exit review is an empty instrument; no cycle-time/retro data. | **Add a real retrospective**: rounds, rework class, cycle time, ad-hoc count per spec. | Lets you see if fixes work. | Build effort. | M / **High** |

## H. Legacy surface & safety

| ID | Why (evidence) | Fix → How | Pros | Cons | Effort / Impact |
|---|---|---|---|---|---|
| **H1** | 34 verbs incl. dead `generate-work`, legacy labels, mock verbs in prod binary. | **Prune deprecated actions/labels/mock verbs.** | Smaller, clearer surface. | Back-compat breaks. | M / Med |
| **H2** | Duplicate channels: 2 verdict, 2 fix-plan, 2 dev-verify. | **Collapse to one channel each.** | Fewer wrong turns. | Migration. | M / Med |
| **H3** | `--human-authorized` bypasses guards unchecked; worktree default is shared/reused; `remove_dir_all` can nuke dirty work. | **Precondition-check + unique worktree paths + safe removal.** | Prevents silent loss/abuse. | Careful test coverage. | S / Med |

---

## Recommended sequence

**Do now (high impact, low effort):** A1, B1, B5, C1, C3, F4, G1, G2, E3.

**Next (tooling investment):** A3, D1, D2, E1, E2, F2, C4.

**Structural (needs a principle/human decision):** B4, F3, F6, H1/H2.

**Human-owned touchpoints** (agents can't edit): `AGENTS.md`, `opencode.json` (D4 grant, F4 permission), `principles.md` (B4/F3/F6). Those need human sign-off.

---

## Bottom line

The pipeline is slow mainly because **specs are too big and rounds are lost on evidence/plan instrumentation**, then compounded by state-machine round-stamp bugs, serialization, and a 1.2 MB guardrail ledger that mostly re-writes prose instead of shipping executable checks. The 9 "do now" items above address the largest share without changing the architecture.
