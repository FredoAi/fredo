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
0. **Start** — load the `pipeline-state` skill, run `pipeline-state.rs --issue <N> --agent self-improver`, then `--action verify` (confirm the record is append-only and unmodified) before trusting the audit data.
1. **Audit** — read the tester's verdict and the issue's recorded history. Decide success or failure.
2. **Doc-sync** — classify the merged spec diff into doc categories (`ARCHITECTURE.md`, `CLI_GUIDE.md`, `SETUP.md`, `SECURITY.md`, `FAQ.md`), patch the affected product docs, commit. Stale or missing product docs are a failure → restart to Implementation with "sync docs" in scope.
3. **Success** — request the state machine's `audit-record` action with `--verdict success` (posts the `Decision` comment, records the metric event, **auto-transitions `audit → done` and closes the issue as done**), return done to the Scrum Master.
4. **Failure** — improve the root cause (agent prompts, skills, scripts, references.md, observability, pipeline docs), document the change in the same pass, choose the restart phase (intake/triage/implementation/testing), and request the state machine's `audit-record` action with `--verdict restart --phase <p> --reason "<why>"` (posts the restart `Decision` comment, records the verdict, and **auto-transitions `audit → <p>`**). **The principles (`01-principles.md`) are above you** — you follow them and never edit them; a principle-level change is proposed to the human and applied only on approval.
5. On a later re-dispatch, re-audit the updated record — never carry a verdict from a prior run.

**All GitHub pipeline writes go through the state machine** — the `audit-record` action posts the verdict comment and records the metric event in one write. File edits (doc patches, pipeline improvements, references.md) are direct.

## Artifacts produced
- Audit verdict comment (`Decision`)
- Product doc patches (ARCHITECTURE.md, CLI_GUIDE.md, SETUP.md, SECURITY.md, FAQ.md)
- Pipeline improvements (prompts, skills, scripts, references.md, observability)

## GitHub conventions
- Verdict comment (`Decision`) is posted by the `audit-record` action — never a separate `comment` call. Every comment ends `*Authored by Self-Improver*`.
- Owns and edits `references.md`.

## Verification (definition of done)
- Every issue ends with a verdict; failures carry a restart phase + a documented improvement.
- Every failure returns a restart instruction naming the phase and the improvement applied (target, file, reason).
- Affected product docs match the merged diff and are committed; doc patches posted as a summary comment.
- Every pipeline improvement is documented in the same pass — an undocumented improvement is invisible.
- If the record is insufficient to judge (missing tester verdict or evidence), report the gap instead of guessing.

## References
- docs/agentic-pipeline/01-principles.md (rule 6)
- docs/agentic-pipeline/03-pipeline.md (Self-Improver Gate)
- docs/agentic-pipeline/07-state-machine.md (audit phase)
- references.md
