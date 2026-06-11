# Process Improvements

Living document. Max 50 lines.

## Active

| Date | Trigger | Change | Justification |
|------|---------|--------|---------------|
| 2026-05-26 | Spec #79 | Architect must not dispatch Coder/Reviewer directly — must dispatch Planner who owns the pipeline | Coder PR #81 was non-draft, targeted main, merged without pr:approved label or CI gate. Planner script ensures pr-create --draft, target spec branch, and reviewer runs pr-merge.ps1 with gates. |
| 2026-06-03 | Spec #116 | Architect must rebase spec branch onto latest main before creating capsules | Spec #116 branch created before #108 merged to main. tauri.conf.json still had GGUF resources, lib.rs ordered models_dir after resource_dir, PR #117 conflicted after #109 merged. Rebase at spec-init catches all three. |
| 2026-06-09 | Spec #141/#142 | Architect must verify Coder PR diffs don't touch forbidden_files before Reviewer dispatch | Architect added 11 Rust files to TypeScript-only spec branch; Reviewer didn't catch it before merge. Verification step at Capsule->PR gate would have caught it. |
| 2026-06-09 | Spec #142 | Lightweight ChakraProvider test pattern: use createSystem(defaultBaseConfig, { disableLayers: true, preflight: false, globalCss: {} }) | jsdom parses Chakra's ~2000 CSS token lines per render; lightweight system eliminates all CSS injection while keeping Chakra context for compound components |
| 2026-06-11 | Spec #174 | Retrospective must verify backlog issue is closed before declaring spec complete | Issue #174 left OPEN after merge; human had to ask about it. Phase 4 now verifies gh issue view --json state before proceeding. |
| 2026-06-11 | Pipeline | Reviewer runs automated DOM-based e2e testing via Tauri MCP; 1 retry then bug | All status transitions were broken (missing read:project auth scope). Added dev-tauri-manager.ps1 for persistent dev instance, tauri-e2e skill for DOM test patterns, integrated into pipeline. |
| 2026-06-11 | Pipeline | Stale branch cleanup integrated into pipeline: Reviewer FYI scan, Planner Phase 4 targeted delete | clean-stale-branches.ps1 rewritten to use gh issue view --json state instead of brittle project API. Now cleans spec branches, feat branches, and worktrees for completed specs. |

## Archived

| Date | Trigger | Change | Justification |
|------|---------|--------|---------------|
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
