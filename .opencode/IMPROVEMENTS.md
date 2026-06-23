# Process Improvements

Living document. Human-maintained.

## How This File Works

### Sections
- **Active**: Guardrails agents MUST follow today — backed by a prompt, script, or pipeline step.
- **Archived**: Former Active entries now baked in, one-time insights, or guardrails no longer in effect.
- **Retro Log**: Per-spec summaries appended automatically by the Reviewer (via bash).

### Who Writes What
| Section | Author | Trigger |
|---------|--------|---------|
| Retro Log | Reviewer | After code review + e2e (automatic) |
| Active | Human | After reviewing completed spec's Retro Log + metrics.json |
| Archived | Human | When an Active guardrail is baked in or outdated |

### Promotion Flow (Human-Driven)
1. After a spec completes, read metrics.json → `reviewer_issues`, `architect_issues`, `top_failure`
2. Read the new Retro Log entry for that spec
3. Check existing Active entries for duplicates or overlaps
4. For each issue that looks like a lasting pattern:
   - Recurring? (appears in multiple Retro Log entries or metrics across specs)
   - Actionable? (can become a prompt, script, or pipeline step)
   - Not already captured? (check Active table)
   - Yes to all three → write an Active row:
     `| <date> | Spec #N | <guardrail> | <evidence from metrics> |`
5. Periodically review Active → move baked-in entries to Archived

### Metrics → Improvement Signal
| metrics field | What it tells you |
|---------------|-------------------|
| `reviewer_issues` | Capsule contract gaps, pattern violations, missing key_files |
| `architect_issues` | Decomposition flaws, missing REQ coverage, forbidden_changes gaps |
| `top_failure` | Systemic failure category — recurring across specs |
| `retries` | High retry count = unclear capsule contract or wrong patterns |

## Active

| Date | Trigger | Change | Justification |
|------|---------|--------|---------------|
| 2026-06-03 | Spec #116 | Architect must rebase spec branch onto latest main before creating capsules | Spec #116 branch created before #108 merged to main. tauri.conf.json still had GGUF resources, lib.rs ordered models_dir after resource_dir, PR #117 conflicted after #109 merged. Rebase at spec-init catches all three. |
| 2026-06-09 | Spec #141/#142 | Reviewer must verify Coder PRs don't touch forbidden_changes via capsule contract check during review | Architect added 11 Rust files to TypeScript-only spec branch; Reviewer didn't catch it before merge. Reviewer now checks capsule forbidden_changes against PR diffs in step 2-4. |
| 2026-06-11 | Spec #174 | Phase 3a must verify issue closed, PR merged, no leftover drafts before declaring spec complete | Issue #174 left OPEN after merge; human had to ask about it. Planner Phase 3a step 5 now verifies all four checks. |
| 2026-06-11 | Pipeline | Reviewer delegates automated DOM-based e2e to the e2e-tester sub-agent via the `task` tool; Reviewer owns retry/escalation, e2e-tester owns DOM inspection + evidence | All status transitions were broken (missing read:project auth scope). Added dev-tauri-manager.ps1 for persistent dev instance, tauri-e2e skill for DOM test patterns. Reviewer dispatches `task subagent_type="e2e-tester"` and reads its PASS/FAIL table to drive the retry loop - no more inline DOM mechanics in Reviewer. |
| 2026-06-11 | Pipeline | Stale branch cleanup integrated into pipeline: Reviewer FYI scan, Planner Phase 3a targeted delete | clean-stale-branches.ps1 rewritten to use gh issue view --json state instead of brittle project API. Now cleans spec branches, feat branches, and worktrees for completed specs. |
| 2026-06-15 | Spec #181 | Architect must complete Research Phase (Step 1b) before designing spec — trace real data flows, cite file:line, produce Domain Model | #181 root cause: Architect designed capsules without understanding OpenCode SDK event model (message.updated has no content, text in message.part.updated). Result: 12+ bug-fix cycles across 6 follow-up specs. |
| 2026-06-15 | Spec #181 | After 2 failed e2e cycles, Planner escalates to ARCHITECTURE ESCALATION — stop patching symptoms | #181 had 8+ bug-fix cycles patching a broken foundation. Planner Phase 3b now triggers escalation at cycle 2 with RCA template + proposed redesign. No more dispatching until human approves new direction. |
| 2026-06-15 | Spec #215 | Architect must generate contract files (contract.rs/contract.ts) for multi-capsule specs — Coders implement against typed stubs | #93 frontend used non-existent backend types (caught at review). #215 capsule AC conflicted with real SDK behavior. Contract stubs + compiler catch type mismatches before review. |
| 2026-06-15 | Pipeline | Capsules are tracked as sub-issues under the backlog parent — not as comments | Single-issue + comments model had no per-capsule status, no Projects visibility, no progress bars. Sub-issues give individual tracking, labels, assignees per capsule while keeping backlog as single source of truth. |

## Archived

| Date | Trigger | Change | Justification |
|------|---------|--------|---------------|
| 2026-05-26 | Spec #79 | [Superseded] Architect must not dispatch Coder/Reviewer directly | Pipeline model changed: Architect now dispatches Coders (step 8) and Reviewer (step 10) via task tool. The Planner dispatches only the Architect. |
| 2026-06-09 | Spec #142 | [Pattern] Lightweight ChakraProvider test pattern: use createSystem(defaultBaseConfig, { disableLayers: true, preflight: false, globalCss: {} }) | jsdom parses Chakra's ~2000 CSS token lines per render; lightweight system eliminates all CSS injection while keeping Chakra context for compound components. Not a process guardrail — useful coding pattern. |
| 2026-06-02 | Spec #93 | Cross-capsule type mismatch in check_model_files required T2 retry | T2 frontend assumed non-existent backend command types; Planner should include explicit API types in capsule acceptance criteria |
| 2026-06-02 | Spec #102 | Single-capsule visual refactor — first-pass review found 4 issues | Reviewer caught hardcoded colorPalette, missing shadow, error styling, fontFamily — all fixed in 1 retry |
| 2026-06-03 | Spec #108 | Task #110 capsule omitted build.rs from scope, CI failed on first attempt | Build script had cross-capsule dependency not captured in capsule; Coder retry fixed by switching to CI env var |
| 2026-06-03 | Spec #124 | T2 imported T3-created files — cross-capsule dependency required merge-order rebase | PR #130 needed rebase after #131 merged; 2 bugs found in first-pass review |
| 2026-06-09 | Spec #141/#142 | Planner needs fallback dispatch authority when subagent session DB is down | Without subagents, Planner had to become Coder violating role boundaries. Mitigation: detect dispatch failures early and flag to human. |
| 2026-06-11 | Spec #173 | Mutation testing at crate scale impractical for pre-merge CI | cargo-mutants mutates entire crate; narrow scope with --file flag necessary but still slow (24s per mutant) |

## Notes

Pipeline scripts intentionally merged/removed in SDD v2 (2026-05-26):
- `task-create.ps1` — not needed; task creation is inline in Architect prompt
- `pr-merge.ps1` — merged into `pr-review.ps1` (approve action squashes + deletes branch)
- `spec-finalize.ps1` — replaced by Planner Phase 3a steps (merge, close, clean)
- `labels-setup.ps1` — simplified to 2 labels managed via `gh` CLI directly

## Retro Log

| Date | Spec | Result | Note |
|------|------|--------|------|
| 2026-06-09 | #141 | 7/7 merged, 0 bugs | All capsules first-pass approved; pre-existing adapter_tests.rs CI failures unrelated |
| 2026-06-09 | #142 | 3/3 merged, 0 bugs | All capsules required tsconfig exclusion fix for CI typecheck compatibility |
| 2026-06-11 | #181 | 4/4 merged, 0 bugs | All capsules first-pass approved; 1 pre-existing test failure (SessionStart?node) unrelated |
| 2026-06-13 | #212 | 1/1 merged, 0 bugs | Single-capsule spec; first-pass approved, clean implementation |
| 2026-06-11 | #199 | 4/4 merged, 0 bugs | All capsules first-pass approved and merged; clean EARS coverage, zero retries |
| 2026-06-11 | #205 | 1/1 merged, 0 bugs | Single-capsule delta filter fix — first-pass approved and merged |
| 2026-06-15 | #215 | 1/1 merged, 0 bugs | Single capsule with 8 REQs; 1 Coder retry (test fix for text part time.end exemption); spec AC2 conflicts with SDK behavior for user text parts - text parts accepted without time.end (intentional fix cc200df) |
| 2026-06-15 | #181 | Did not pass e2e — closed after 12+ cycles | 4 initial capsules 0 bugs merged; 8+ bug-fix cycles across #198 #199 #205 #209 #212 #215; filter proven (11 events/exchange), ChatNode renders user text, but thinking/response text lost in turn system. Root cause: (1) no upfront research on OpenCode SDK event model — message.updated has no content, text in message.part.updated; (2) incremental patches on fragile foundation; (3) complex turn-based state machine error-prone. Guardrail: after 2 failed e2e cycles, escalate to architecture review — stop patching. |
| 2026-06-16 | #221 | 3/3 merged, 0 bugs | All capsules first-pass approved and merged. Incremental graph reducer, ChatNode awaiting state, and incremental counters clean implementations. E2E verified: counters display, data pipeline persists, full test suite passes (201 UI + 108 Rust). Coherent cross-capsule design with clear separation of concerns. |

| 2026-06-17 | #252 | 1/1 merged, 6 bugs fixed live | EventSubscription system + ChatNode-only Mission Monitor. 6 live bugs (isReplay guard, nodeMap rebuild, replay overwrite, flashing, session_id path, ghost sessions). 17 files +637/-1166. Rust adapter session_id fix � multi-terminal sessions now work. Note: Planner bypassed Architect?Coder?Reviewer loop for all 6 bugs � fixed directly on spec branch via live debugging (vibecoding). Process gap: Phase 3b assumes Architect owns bug fixes, but live DOM debugging needed Planner intervention.
#275: 6/5 capsules attempted, 6 merged — setLayoutVersion infinite loop was the missed root cause; E2E dev environment unreliable for verification

