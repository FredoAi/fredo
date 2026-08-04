# Fredo Test Suites

Durable, **reusable per-feature** test suites — created on the go, when needed, and committed to `main` as the regression asset. Tests are organized by **feature domain** (not by spec/issue number), so they accumulate across specs: a later spec touching the same area inherits and extends the earlier suites.

> These files are **not** scratch. `.opencode/tmp/<issue>/` is ephemeral and gitignored; `.opencode/tests/<feature>/` is version-controlled (`tests-commit`) and survives as the feature's test record.

## Layout

```
.opencode/tests/
├── README.md
└── <feature>/                 # lowercase-kebab feature domain (e.g. mission-monitor, settings)
    ├── functional.md          # "does the new behavior work?" — per-requirement test cases
    ├── regression.md          # "did we break existing behavior?" — no-change baseline + links
    ├── exploratory.md         # unscripted edge/failure probes — added on the fly
    └── smoke.md               # app-boots + core-path sanity — standardized boilerplate
```

**Feature naming:** `<feature>` is the durable feature domain the spec touches, derived from the Architect's Domain Model (frontend `features/<name>`, backend `infrastructure/...`, or a shared cross-cutting name). Lowercase-kebab, ASCII. When a spec touches a feature with no folder yet, create it; when it touches several, add files to each.

## Category semantics

| Category | Question | Contents | When it runs |
|----------|----------|----------|--------------|
| **Functional** | Does the new behavior work? | One `- [ ]` case per requirement, observable expected outcome. Formalizes the QA Plan table (REQ / Test case / Expected / Edge cases). | On this feature's testing phase; when a later spec extends the feature |
| **Regression** | Did we break existing behavior? | The "must not change" baseline (regression invariants from the plan's non-goals) + links to prior features' suites whose surface overlaps this feature. | On every testing phase that touches the feature's surface |
| **Exploratory** | What edge/failure did we not script? | Unscripted probes, error/failure states, "what-if" sequences. A confirmed finding **promotes** to `functional.md`. | On this feature's testing phase (tester probes beyond the script) |
| **Smoke** | Does the app still boot + core paths work? | Short standardized checks (boilerplate below) + any feature-specific quick paths. | On this feature's testing phase; on any regression-smoke for zero-observable-AC specs |

## File conventions

- `- [ ]` checkbox per case, ID prefix `F-<n>` / `R-<n>` / `E-<n>` / `S-<n>`.
- Each case states an **observable expected outcome** and any required test data (mock event injection, fixtures, env).
- On pass, keep the checkbox and append evidence; on fail, leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro.
- Promoted exploratory probes move to `functional.md` as a new `F-` row (keep the origin note).
- The QA Plan table in the Implementation Plan stays the plan; these files are the executable checklist the Tester works from.

## Lifecycle

- **Triage (QA Expert):** seeds/extends the feature's files — functional from the QA Plan, smoke from the boilerplate, regression scope from the Domain Model's "what must not change", exploratory empty with prompt lines.
- **Testing (Tester):** executes functional + smoke, then regression + exploratory; appends findings, promotes confirmed probes, marks evidence per case.
- **Persist:** the Scrum Master (after triage) or the Tester (after execution) requests the state machine's `tests-commit --issue <N> --feature <name>` action, which commits the folder to `main`. It ships with the feature and is inherited by later specs.
- **Regression runs:** any spec whose Domain Model overlaps a feature's surface runs that feature's `regression.md` too — that is how suites accumulate value across specs.

## Smoke boilerplate

Standard smoke cases every feature's `smoke.md` starts from (adapt counts/labels to the app):

```
- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — the feature's entry point (toolbar item, route, panel) renders its expected elements
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
```

Full DOM + visual execution methodology lives in the `dev-environment` skill.
