# Process Improvements

Living document. Max 50 lines. Archive oldest entries to IMPROVEMENTS-archive.md.

## Active

| Date | Trigger | Change | Justification |
|------|---------|--------|---------------|
| 2026-05-26 | Spec #79 | Architect must not dispatch Coder/Reviewer directly — must dispatch Planner who owns the pipeline | Coder PR #81 was non-draft, targeted main, merged without pr:approved label or CI gate. Planner script ensures pr-create --draft, target spec branch, and reviewer runs pr-merge.ps1 with gates. |
| 2026-06-03 | Spec #116 | Architect must rebase spec branch onto latest main before creating capsules | Spec #116 branch created before #108 merged to main. tauri.conf.json still had GGUF resources, lib.rs ordered models_dir after resource_dir, PR #117 conflicted after #109 merged. Rebase at spec-init catches all three. |

## Archived

| Date | Trigger | Change | Justification |
|------|---------|--------|---------------|
| 2026-06-02 | Spec #93 | Cross-capsule type mismatch in check_model_files required T2 retry | T2 frontend assumed non-existent backend command types; Planner should include explicit API types in capsule acceptance criteria |
| 2026-06-02 | Spec #102 | Single-capsule visual refactor — first-pass review found 4 issues | Reviewer caught hardcoded colorPalette, missing shadow, error styling, fontFamily — all fixed in 1 retry |
| 2026-06-03 | Spec #108 | Task #110 capsule omitted build.rs from scope, CI failed on first attempt | Build script had cross-capsule dependency not captured in capsule; Coder retry fixed by switching to CI env var |

| 2026-06-03 | Spec #124 | T2 imported T3-created files — cross-capsule dependency required merge-order rebase; FocusWindow eventType mismatch and permission normalization bugs caught | PR #130 needed rebase after #131 merged; 2 bugs found in first-pass review (FocusWindow used 'chatNode' vs 'chat', permission normalization missed hook formats) |
#142: 3/3 capsules merged, 0 bugs — All 3 capsules required tsconfig exclusion fix for CI typecheck compatibility
#141: 7/7 capsules merged, 0 bugs - All capsules first-pass approved; pre-existing adapter_tests.rs CI failures unrelated to PRs
| 2026-06-09 | Spec #141/#142 | Architect must verify Coder PR diffs don't touch forbidden_files before Reviewer dispatch; cross-spec file contamination required full branch rebuild on #142 | Architect added 11 Rust files to TypeScript-only spec branch; Reviewer didn't catch it before merge. Verification step at Capsule→PR gate would have caught it. |
| 2026-06-09 | Spec #142 | Lightweight ChakraProvider test pattern documented: use createSystem(defaultBaseConfig, { disableLayers: true, preflight: false, globalCss: {} }) to avoid jsdom CSS injection memory leaks in component tests | jsdom parses Chakra's ~2000 CSS token lines per render; lightweight system eliminates all CSS injection while keeping Chakra context for compound components |
| 2026-06-09 | Spec #141/#142 | Planner needs fallback dispatch authority when subagent session DB is down — 7+ dispatches failed with insert conflicts | Without subagents, Planner had to become Coder (write source fixes, config, test logic) violating role boundaries. Mitigation: detect dispatch failures early and flag to human. |
| 2026-06-11 | Spec #173 | Mutation testing at crate scale impractical for pre-merge CI � 596 mutants, 4h runs, mostly noise; future attempts should target single high-risk files only | cargo-mutants mutates entire crate by default; workspace-relative resource paths in tauri.conf.json break when crate is copied to temp dir; narrow scope with --file flag is necessary but still slow (24s per mutant) |
