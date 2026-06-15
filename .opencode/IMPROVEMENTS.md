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
| 2026-06-11 | Pipeline | Reviewer runs automated DOM-based e2e testing via Tauri MCP; 1 retry then bug | All status transitions were broken (missing read:project auth scope). Added dev-tauri-manager.ps1 for persistent dev instance, tauri-e2e skill for DOM test patterns, integrated into pipeline. |
| 2026-06-11 | Pipeline | Stale branch cleanup integrated into pipeline: Reviewer FYI scan, Planner Phase 3a targeted delete | clean-stale-branches.ps1 rewritten to use gh issue view --json state instead of brittle project API. Now cleans spec branches, feat branches, and worktrees for completed specs. |

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

## Retro Log

| Date | Spec | Result | Note |
|------|------|--------|------|
| 2026-06-09 | #141 | 7/7 merged, 0 bugs | All capsules first-pass approved; pre-existing adapter_tests.rs CI failures unrelated |
| 2026-06-09 | #142 | 3/3 merged, 0 bugs | All capsules required tsconfig exclusion fix for CI typecheck compatibility |
| 2026-06-11 | #181 | 4/4 merged, 0 bugs | All capsules first-pass approved; 1 pre-existing test failure (SessionStart?node) unrelated |
| 2026-06-11 | #199 | 4/4 merged, 0 bugs | All capsules first-pass approved and merged; clean EARS coverage, zero retries |
| 2026-06-11 | #205 | 1/1 merged, 0 bugs | Single-capsule delta filter fix � first-pass approved and merged |
| 2026-06-15 | #215 | 1/1 merged, 0 bugs | Single capsule with 8 REQs; 1 Coder retry (test fix for text part time.end exemption); spec AC2 conflicts with SDK behavior for user text parts - text parts accepted without time.end (intentional fix cc200df) |
