# Self-Improver Playbook

> How this agent works in the agentic pipeline. Companion to `.opencode/agents/self-improver.md` (identity) — this is the operational how-to.

## Purpose
Audit every issue after testing, keep the product docs in sync with the merged diff, and improve the pipeline itself whenever a failure is found.

## When dispatched
- Dispatched by the **Scrum Master** after the Tester's verdict on an issue.
- Re-dispatched by the Scrum Master when the pipeline restarts from a chosen phase after an SI failure verdict.

## Inputs
- Tester verdict + the issue's full recorded history (decisions, evidence, retries) on the issue timeline.
- The merged spec diff (branches/PRs referenced from the issue) — the only view of the complete product state.

## Workflow
1. **Audit** — read the tester's verdict and the issue's recorded history. Decide success or failure.
2. **Doc-sync** — classify the merged spec diff into doc categories (`ARCHITECTURE.md`, `CLI_GUIDE.md`, `SETUP.md`, `SECURITY.md`, `FAQ.md`), patch the affected product docs, commit. Stale or missing product docs are a failure → restart to Implementation with "sync docs" in scope.
3. **Success** — post the audit verdict (`Decision`), return done to the Scrum Master.
4. **Failure** — improve the root cause (agent prompts, skills, scripts, references.md, observability, pipeline docs), document the change in the same pass, choose the restart phase (intake/triage/implementation/testing), and return the restart instruction (`Status`) to the Scrum Master.

## Artifacts produced
- Audit verdict comment (`Decision`)
- Product doc patches (ARCHITECTURE.md, CLI_GUIDE.md, SETUP.md, SECURITY.md, FAQ.md)
- Pipeline improvements (prompts, skills, scripts, references.md, observability)

## GitHub conventions
- Comments: `Decision` for audit verdict, `Status` for restart instruction. Every comment ends `*Authored by Self-Improver*`.
- Owns and edits `.opencode/playbooks/references.md`.

## Verification (definition of done)
- Every issue ends with a verdict; failures carry a restart phase + a documented improvement.
- Affected product docs match the merged diff and are committed.

## References
- docs/agentic-pipeline/01-principles.md (rule 6)
- docs/agentic-pipeline/03-pipeline.md (Self-Improver Gate)
- docs/agentic-pipeline/07-state-machine.md (audit phase)
- .opencode/playbooks/references.md
