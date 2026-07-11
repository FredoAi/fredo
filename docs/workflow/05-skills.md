# Skills Catalog

Specialized instruction packs loaded by agents for specific tasks. Skills are additive — they layer domain knowledge onto the agent's base prompt.

---

## Skill Reference

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **git-operations** | GitHub/pipeline operations: comments, PRs, issues, labels, sub-issues, project status, worktrees | Any `gh` CLI or pipeline script usage |
| **dev-environment** | Dev instance lifecycle (Up/Down/Status/Restart/Logs) + E2E testing methodology + DOM test patterns | Tauri app interaction (QA, Engineering Lead) |
| **fredo-cli-events** | Mock event injection via `fredo emit` — 6 validated recipes for triggering UI states | E2E testing with mock events |
| **opencode-cli-runner** | Real agent/subagent dispatch via `opencode run` + `opencode serve` for integration testing | Live agent integration E2E |
| **telemetry-query** | SQLite3 read-only queries on `fredo.db` — 16 recipes for spans, metrics, errors, retention | Research, debugging, investigation |
| **frontend-design** | Chakra v3 theme token table, 7 aesthetic directions, anti-patterns for UI capsule design | UI spec design (Software Architect, UI/UX Architect) |
| **retro-analysis** | Guardrail effectiveness computation, cross-spec pattern detection, improvement strategy selection, ACE curation lifecycle | Post-spec Self-Improver evaluation |
| **spec-test-gen** | Auto-generate user-observable ACs from EARS requirements when spec has no AC section | Specs without `## Acceptance Criteria` section |
| **chakra-ui-builder** | Chakra component decision tree, theming patterns, charting | UI/UX Architect component selection |
| **chakra-ui-migrate** | Chakra v2→v3 migration patterns: prop renaming, compound components, provider setup | Developer upgrading components |
| **chakra-ui-refactor** | Chakra component review: token usage, layout structure, HTML/CSS → Chakra conversion | Developer refactoring UI |
| **threejs** | Three.js integration patterns for 3D scenes | Developer implementing 3D |

---

## Skill → Agent Map

| Skill | PO | SA | UX | QAL | Dev | EL | QA | SI | DK |
|-------|----|----|----|----|-----|----|----|-----|----|
| git-operations | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| dev-environment | — | — | — | — | — | ✓ | ✓ | — | — |
| fredo-cli-events | — | — | — | — | — | — | ✓ | — | — |
| opencode-cli-runner | — | — | — | — | — | — | ✓ | — | — |
| telemetry-query | — | ✓ | — | — | — | — | ✓ | ✓ | — |
| frontend-design | — | ✓ | ✓ | — | — | — | — | — | — |
| retro-analysis | — | — | — | — | — | — | — | ✓ | — |
| spec-test-gen | — | — | — | — | — | — | ✓ | — | — |
| chakra-ui-builder | — | — | ✓ | — | — | — | — | — | — |
| chakra-ui-migrate | — | — | — | — | ✓ | — | — | — | — |
| chakra-ui-refactor | — | — | — | — | ✓ | — | — | — | — |
| threejs | — | — | — | — | ✓ | — | — | — | — |

---

## Skill Profiles

### git-operations
Loaded by **all agents** for any GitHub interaction. Covers: posting comments via `--body-file` (never heredoc), creating PRs, managing issues/labels/sub-issues, project status transitions, git worktree operations, branch cleanup.

### dev-environment
Loaded by **Engineering Lead** (dev instance management) and **QA** (full lifecycle). Covers: `dev-env.ps1` commands, DOM testing patterns (snapshots, interactions, state verification, regression smoke test), webview freeze recovery (Stop → Start → WaitForReady → reconnect → retry ×3).

### fredo-cli-events
Loaded by **QA** for mock event injection. 6 validated recipes:
1. Agent session lifecycle (Init → Update → Response)
2. Tool use lifecycle (PreToolUse → PostToolUse)
3. Chat message lifecycle
4. Error event injection
5. Multi-tool parallel execution
6. OTLP span simulation

**Critical format rules:** lowercase state, hyphenated provider, underscore event type, unique session IDs for test isolation.

### opencode-cli-runner
Loaded by **QA** for real agent integration testing via `opencode run`. Covers: session initiation, subagent dispatch, result capture, DOM verification of real agent output.

### telemetry-query
Loaded by **Software Architect** (research), **QA** (investigation), and **Self-Improver** (cross-spec analysis, before/after metrics comparison). 16 validated SQL recipes against `telemetry_spans` table. Never use raw `event-dump.jsonl` (1.1GB+).

### frontend-design
Loaded by **Software Architect** (for UI capsule design) and **UI/UX Architect** (for design consultation). Covers: Fredo theme token table (bg/fg/accent/status), 7 aesthetic directions (Brutalist, Luxury, Playful, Editorial, Industrial, Organic, Retro-futuristic), Chakra v3 anti-patterns, verboten patterns (no hardcoded colors, no `colorScheme`, no `isDisabled`).

### retro-analysis
Loaded by **Self-Improver** after Phase 4. Covers the full self-improvement loop:

- **Failure classification:** reads metrics.json + e2e report + script-errors.jsonl, classifies failure as phase-level (restart from phase N) or systemic (improvement needed)
- **Strategy selection:** chooses improvement target (agent prompt, script, skill, observability) + strategy (patch prompt, add validation, strengthen skill, add observability)
- **Three-gate validation:** acceptance → attribution → improvement
- **Mutation rules:** max 3 attempts per strategy, forced category rotation after exhaustion, escalation after all 4 categories exhausted
- **Cross-spec pattern detection:** same `top_failure` in ≥2 specs → Active guardrail candidate
- **Guardrail promotion logic:** recurring pattern + actionable + not already captured → Active entry
- **Deepseek prompt patterns:** output anchors, negative examples, task sandwich, role+task at top
- **AXI principles for scripts:** pre-computed aggregates, minimal schemas, definitive empty states, contextual disclosure

### spec-test-gen
Loaded by **QA** when spec has no AC section. Auto-generates user-observable ACs from EARS `## Requirements` section. Events → visual checks. State-driven → render checks. Unwanted → error state checks.

### chakra-ui-builder
Loaded by **UI/UX Architect** for component selection. Covers: component decision tree, v3 compound component patterns, theming tokens, chart component integration.

### chakra-ui-migrate
Loaded by **Developer** for upgrading legacy Chakra v2 components. Covers: `colorScheme`→`colorPalette`, `isDisabled`→`disabled`, `isLoading`→`loading`, compound component refactoring.

### chakra-ui-refactor
Loaded by **Developer** for component cleanup. Covers: token usage review, HTML/CSS→Chakra conversion, layout structure improvements.

### threejs
Loaded by **Developer** for 3D scene implementation. Covers: Three.js integration with React, scene management, rendering lifecycle.
