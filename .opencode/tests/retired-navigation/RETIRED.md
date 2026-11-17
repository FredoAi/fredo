# Retired navigation test suites — the reason record

**No durable suite is deleted silently in this slice.** Every path deleted by the navigation-engine
retirement programme (issue **#3151**, slice 1 of 3) is listed below with the suite it belonged to,
the issue it was retired in, and a factual statement of why its subject no longer exists.

Read this record with the deleted paths it names: a path that is gone but unlisted is a defect, and
a listed path that still exists on disk is likewise a defect. The subject of every row below is the
**NavigationEngine** (declaration model, host dispatch funnel, shared journal, the surfaces it drove,
and the research/protocol programme that produced it) — that engine is deleted in #3151, so the
suites that exercised it have nothing left to exercise.

> **Appended by later sub-tasks.** This file is the single retirement ledger for the slice. The rows
> below cover the four **durable** suite directories retired by ST-7. Additional **in-tree** suite
> rows (the `apps/ui/src/**` vitest files whose subject is a deleted surface, provider or golden) are
> appended to this same table by the deletion landing (ST-6), and the committed absence-guard
> invocation recipe is appended by ST-8. Those rows are deliberately **not** written here — this
> record must match what has actually landed.

## Retired paths

| path | suite | retired in | reason |
|---|---|---|---|
| `.opencode/tests/navigation/coverage-map.md` | navigation | #3151 | subject: the coverage ledger of the navigation engine's P8 decommission (deleted legacy suites → their engine successors); the engine and every successor it names are deleted in #3151 |
| `.opencode/tests/navigation/functional.md` | navigation | #3151 | subject: the headless NavigationEngine core, its four UI surfaces and its P5 contract changes (`CommandRail`/`NavigationMap`/`ActivityTrail`, dispatch funnel, journal, validation rules V-01…V-12); the engine is deleted in #3151 |
| `.opencode/tests/navigation/regression.md` | navigation | #3151 | subject: the engine's P3–P8 must-not-change baseline (engine module set, surface contracts, one dispatch funnel, one announcement region); the engine is deleted in #3151 |
| `.opencode/tests/navigation/smoke.md` | navigation | #3151 | subject: the engine's module-presence/dispatchability smoke (eleven headless modules, golden manifest, one host mount); the engine is deleted in #3151 |
| `.opencode/tests/navigation/exploratory.md` | navigation | #3151 | subject: unscripted probes of the engine's prefix grammar, armed state, place scoping and store-mutation boundary; the engine is deleted in #3151 |
| `.opencode/tests/navigation-fleet/functional.md` | navigation-fleet | #3151 | subject: the engine's fleet migration of five application surfaces (terminal, window traversal, mission monitor, SQL Studio, dev mode) onto declared `Surface` trees; the engine and those declarations are deleted in #3151 |
| `.opencode/tests/navigation-fleet/regression.md` | navigation-fleet | #3151 | subject: the fleet migration's must-not-change baseline (no key re-tuning, terminal passthrough, window traversal, per-surface outcomes through the engine); the engine is deleted in #3151 |
| `.opencode/tests/navigation-fleet/smoke.md` | navigation-fleet | #3151 | subject: the fleet migration's app-boot smoke (engine surfaces mounting on the five migrated apps); the engine is deleted in #3151 |
| `.opencode/tests/navigation-fleet/exploratory.md` | navigation-fleet | #3151 | subject: unscripted probes of the migrated fleet's keystroke/focus/availability behaviour under the engine; the engine is deleted in #3151 |
| `.opencode/tests/navigation-research/functional.md` | navigation-research | #3151 | subject: the navigation-engine research spike's deliverable checks (fluency report, static prototype, session protocol, Gate-H evidence) for the engine programme being retired in #3151 |
| `.opencode/tests/navigation-research/regression.md` | navigation-research | #3151 | subject: the research spike's zero-production-impact baseline for the engine prototype/protocol artefacts; the programme is retired in #3151 |
| `.opencode/tests/navigation-research/smoke.md` | navigation-research | #3151 | subject: artifact-presence smoke for the engine research spike's report, prototype and protocol; the programme is retired in #3151 |
| `.opencode/tests/navigation-research/exploratory.md` | navigation-research | #3151 | subject: unscripted probes of the engine research spike's evidence quality (prototype leaks, quote integrity, threshold drift); the programme is retired in #3151 |
| `.opencode/tests/wireframe-navigation/functional.md` | wireframe-navigation | #3151 | subject: the declaration-driven Wireframe surface (its declared places/verbs/keys, the engine-driven bar/map/trail and the journal); the declaration and engine are deleted in #3151 |
| `.opencode/tests/wireframe-navigation/regression.md` | wireframe-navigation | #3151 | subject: the Wireframe declaration surface's must-not-change baseline (single undo journal, one dispatch funnel, no legacy runtime dependence); the declaration and engine are deleted in #3151 |
| `.opencode/tests/wireframe-navigation/smoke.md` | wireframe-navigation | #3151 | subject: the Wireframe declaration surface's boot smoke (engine bar/map/trail mounting on the Wireframe shell); the declaration and engine are deleted in #3151 |
| `.opencode/tests/wireframe-navigation/exploratory.md` | wireframe-navigation | #3151 | subject: unscripted probes of the Wireframe declaration surface's armed strokes, place scoping and undo tiers; the declaration and engine are deleted in #3151 |
