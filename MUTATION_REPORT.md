# Mutation Test Report

> **Generated**: 2026-06-09T23:57:50Z
> **Git Commit**: `a0645245ac493ae79270dfa4bec3c4ebb2dc7388`
> **Tools**: cargo-mutants 27.1.0 (Rust), Stryker Mutator (TypeScript)

## Module Selection Rationale

**Rust (cargo-mutants):**
1. `infrastructure/comm/adapters/opencode.rs` — 61-arm event-type match, nested OTLP parsing, shared mutable state, 3 real bug-fix commits
2. `features/llm/engine.rs` — unsafe Send/Sync on C FFI pointer, dual generation loops, conditional compilation forks, template fallback priority
3. `features/setup/commands.rs` — highest bug-fix churn (4 fixes), OS-conditional compilation, 11 Tauri command handlers, download streaming

**TypeScript (Stryker):**
1. `shared/utils/adapterBridge.ts` — IPC bridge with 4 code paths per function, dynamic import fallbacks, most thorough existing test suite (22 tests)
2. `features/mission-monitor/hooks/useMissionMonitor.ts` — most complex module (862 lines), 8+ fix commits, 15-field state machine, 25+ event-type routing
3. `shared/contexts/StreamContext.tsx` — central event nervous system, deduplication + TTL filtering reducer, memoized selectors

---

## Rust — cargo-mutants Results

**Configuration**: `apps/tauri/src-tauri/Cargo.toml` [`dev-dependencies`] + `cargo-mutants 27.1.0`
**Invocation**: `cargo mutants --file "src/infrastructure/comm/adapters/opencode.rs" --file "src/features/llm/engine.rs" --file "src/features/setup/commands.rs" --in-place`
**Total mutants detected**: 183 (across all 3 modules)
**Tested**: 12 mutants (baseline passed, remaining 171 not tested due to time constraints — each mutant requires a full recompile)

### engine.rs (`src/features/llm/engine.rs`)

| Metric | Value |
|--------|-------|
| Mutants detected | 55 |
| Tested | 12 |
| Killed (caught by tests) | 1 |
| Survived | 8 |
| Unviable (failed to compile) | 3 |
| Mutation score (tested) | 11.1% (1/9 viable) |
| Mutation score (overall) | 1.8% (1/55) |

#### Killed Mutants

| # | Line | Mutant | Status |
|---|------|--------|--------|
| 1 | 50:9 | replace `LlmEngine::load_chat_template_from_dir -> Option<LlamaChatTemplate>` with `None` | Killed |

#### Surviving Mutants

| # | Line | Mutant | Status |
|---|------|--------|--------|
| 1 | 110:35 | replace `/` with `%` in `LlmEngine::load_with_vision` | Survived |
| 2 | 110:35 | replace `/` with `*` in `LlmEngine::load_with_vision` | Survived |
| 3 | 143:9 | replace `LlmEngine::has_vision -> bool` with `true` | Survived |
| 4 | 143:9 | replace `LlmEngine::has_vision -> bool` with `false` | Survived |
| 5 | 158:9 | replace `LlmEngine::generate_with_image -> Result<()>` with `Ok(())` | Survived |
| 6 | 193:37 | replace `+` with `-` in `LlmEngine::generate_with_image` | Survived |
| 7 | 193:37 | replace `+` with `*` in `LlmEngine::generate_with_image` | Survived |
| 8 | 193:24 | replace `+` with `-` in `LlmEngine::generate_with_image` | Survived |

#### Unviable Mutants

| # | Line | Mutant | Reason |
|---|------|--------|--------|
| 1 | 50:9 | replace `load_chat_template_from_dir` with `Some(Default::default())` | Failed to compile |
| 2 | 69:9 | replace `LlmEngine::load` with `Ok(Default::default())` | Failed to compile |
| 3 | 83:9 | replace `LlmEngine::load_with_vision` with `Ok(Default::default())` | Failed to compile |

### opencode.rs (`src/infrastructure/comm/adapters/opencode.rs`)

| Metric | Value |
|--------|-------|
| Mutants detected | 57 |
| Tested | 0 |
| Mutation score | N/A (not tested) |

**Note**: Testing was interrupted before this module was reached. Results reflect the 12 fastest-compiling mutants (all in `engine.rs`).

**Mutant types detected (not tested)**: 28 match-arm deletions (event-type dispatch), 10 FnValue replacements (return empty/default), 6 BinaryOperator mutations, 4 ! deletions, 2 || → && mutations, 2 == → != mutations, 1 `delete !` in OT LP negation.

### commands.rs (`src/features/setup/commands.rs`)

| Metric | Value |
|--------|-------|
| Mutants detected | 71 |
| Tested | 0 |
| Mutation score | N/A (not tested) |

**Note**: Testing was interrupted before this module was reached. 71 mutants were enumerated but not yet tested.

**Mutant types detected (not tested)**: FnValue replacements (29), operator mutations (12), !-deletions (14), match guard mutations (4), match arm deletions (1).

---

## TypeScript — Stryker Results

**Configuration**: `apps/ui/stryker.config.json` including `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`
**Invocation**: `npx stryker run apps/ui/stryker.config.json`
**Test Runner**: Vitest (via `apps/ui/vitest.config.ts`)

### Overall Summary

| Metric | Value |
|--------|-------|
| Total mutants | 1521 |
| Killed | 26 |
| Survived | 328 |
| No coverage | 1167 |
| Mutation score (total) | **1.71%** |
| Mutation score (covered) | **7.34%** |

### useMissionMonitor.ts (`src/features/mission-monitor/hooks/useMissionMonitor.ts`)

| Metric | Value |
|--------|-------|
| Mutants detected | 1317 |
| Killed | 26 |
| Survived | 328 |
| No coverage | 963 |
| Mutation score (total) | **1.97%** |
| Mutation score (covered) | **7.34%** |

**Note**: This module has the most extensive test coverage of the three TS modules. The 26 killed mutants indicate the tests catch basic value replacements and conditional mutations. The 328 surviving mutants in covered code suggest the complex state machine logic (15-field state, 25+ event-type routing) has gaps in test assertions — the code runs but the mutations don't change observable test outcomes.

### StreamContext.tsx (`src/shared/contexts/StreamContext.tsx`)

| Metric | Value |
|--------|-------|
| Mutants detected | 139 |
| Killed | 0 |
| Survived | 0 |
| No coverage | 139 |
| Mutation score | **0.00%** |

**Mutant types (all no-coverage)**: 139 mutants in the StreamProvider, reducer, hooks — none covered by tests. Includes ConditionalExpression, BlockStatement, StringLiteral, ObjectLiteral, ArrowFunction, ArrayDeclaration, BooleanLiteral, OptionalChaining, MethodExpression, EqualityOperator, ArithmeticOperator, BinaryOperator mutations.

**Note**: Zero test coverage for the stream context module. The `StreamProvider`, `streamReducer`, `useStream`, `useStepperEvents`, `useLatestStepperEvent`, `useConnectionStatus` hooks have no dedicated tests. All 139 mutants are in code never reached by any test.

### adapterBridge.ts (`src/shared/utils/adapterBridge.ts`)

| Metric | Value |
|--------|-------|
| Mutants detected | 65 |
| Killed | 0 |
| Survived | 0 |
| No coverage | 65 |
| Mutation score | **0.00%** |

**Mutant types (all no-coverage)**: BlockStatement, BooleanLiteral, ConditionalExpression, LogicalOperator, EqualityOperator, StringLiteral, ArrowFunction, OptionalChaining, ObjectLiteral mutations — all unreachable by tests.

**Surviving mutant examples (no-coverage)**:
- `if (!_invoke)` → `if (_invoke)` (line 54)
- `if (!_llmChat)` → `if (true)` (line 87)
- `typeof window !== 'undefined'` → `typeof window === 'undefined'` (line 56)
- dynamic imports of `@tauri-apps/api/core` and `@tauri-apps/api/event`

**Note**: Despite 22 tests targeting adapterBridge, the dynamic import fallback paths (which require `__TAURI_INTERNALS__` in window) are not covered in the Vitest test environment. The fallback paths are designed to activate only inside a Tauri webview.

---

## Summary

| Language | Module | Mutants | Killed | Survived | No Coverage | Score (total) | Score (covered) |
|----------|--------|---------|--------|----------|-------------|---------------|-----------------|
| Rust | engine.rs | 55 | 1 | 8 | — | 1.8% tested | 11.1% tested |
| Rust | opencode.rs | 57 | 0 | 0 | — | N/A | N/A |
| Rust | commands.rs | 71 | 0 | 0 | — | N/A | N/A |
| TS | useMissionMonitor.ts | 1317 | 26 | 328 | 963 | 1.97% | 7.34% |
| TS | StreamContext.tsx | 139 | 0 | 0 | 139 | 0.00% | 0.00% |
| TS | adapterBridge.ts | 65 | 0 | 0 | 65 | 0.00% | 0.00% |
| **Rust total** | | **183** | **1** | **8** | **—** | **0.5% (partial)** | **11.1% (partial)** |
| **TS total** | | **1521** | **26** | **328** | **1167** | **1.71%** | **7.34%** |

## Recommendations

1. **Rust: add tests for `LlmEngine::has_vision`, `generate_with_image`, and `load_with_vision`** — these functions had surviving mutants in arithmetic and boolean-operations, indicating the tests don't verify computational logic.
2. **TypeScript: add test coverage for `StreamContext.tsx`** — the entire stream reducer, provider, and hooks are untested (139 unreachable mutants).
3. **TypeScript: add Tauri-environment tests for `adapterBridge.ts`** — the dynamic import fallback paths are completely uncovered (65 mutants).
4. **Complete full mutation run** — 171 untested Rust mutants (in opencode.rs and commands.rs) may reveal additional gaps when tested.
