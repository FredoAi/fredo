---
feature: <feature-name>
id: TC-<FEAT>-<N>
source: AC-R<N>, Backlog #<N>
type: event-driven | interaction | state | visual
status: active
last_pass: <ISO date>
last_spec: <N>
---

# <Brief description of what this test verifies>

**Prerequisites**: Dev instance running, <feature> open, unique test session ID

**Steps**:
1. <Step 1 — use e2e-inject.ps1 or DOM interaction or JS execution>
2. <Step 2 — wait, observe, verify>
3. <Step 3 — capture evidence>

**Expected**:
- <Concrete, verifiable DOM/state/console assertion>
- <Use accessibility tree roles, console patterns, or JS return values>

**Actual (last run)**: PENDING — <YYYY-MM-DD>
