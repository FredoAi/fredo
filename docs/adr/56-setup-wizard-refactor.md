# ADR-56: Setup Wizard Refactor — Detect-Review-Execute-Done Pattern

## Status
Proposed

## Context
The Fredo Setup feature currently auto-runs three tasks (Fredo CLI PATH, OTEL config, plugin install) when the window opens. There is no review step — the user cannot see what commands will run or approve the plan. This creates opacity and anxiety, especially for a tool that modifies the user's PATH and environment variables. Additionally, the opencode CLI check is buried as a mid-execution warning rather than a gating condition.

## Decision
Refactor the Setup Wizard into a 4-screen state machine:

1. **Detecting** — auto-runs environment checks in parallel, shows spinner
2. **Review** — presents a plan table with each step's status badge, label, and exact shell command(s) in code blocks. If opencode CLI is missing, shows a blocking banner and disables Continue.
3. **Executing** — runs only "needed" steps sequentially, highlighting the active task's command with live status updates
4. **Done** — shows summary of all outcomes with Run again/Done buttons

Add one new Tauri backend command `get_setup_plan` that runs all detection checks and returns a `SetupPlan` struct. This struct contains `SetupPlanStep` entries, each with an `id`, `label`, `status` (skipped/needed/blocked), and `command` string. The frontend consumes this plan for both the Review screen and execution flow.

OTEL configuration is not a separate step — it's already handled inside `install_plugin` and displayed as part of that step's command block.

## Consequences
### Positive
- User transparency: people see exactly what will run before it runs
- Explicit consent: no actions happen without the user clicking Continue
- Gating: opencode CLI absence blocks the flow with actionable docs link
- Single source of truth: backend returns the plan and command strings
- Less frontend complexity: wizard driven by plan, not hardcoded task list

### Negative
- More clicks for returning users who already have everything installed (just a Continue + Done)
- Backend change required (new `get_setup_plan` command)

### Risks
- `get_setup_plan` command strings could become stale if the install commands change — mitigated by keeping them close to the Rust implementation
- Cross-platform command string differences (PowerShell vs bash) need to be tested on both Windows and Unix