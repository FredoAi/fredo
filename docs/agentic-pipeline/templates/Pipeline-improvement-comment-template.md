# Pipeline Improvement Comment Template

> Drafted by the **Curator** as `.opencode/tmp/<issue>/pipeline-improvement.md`, posted as the `## Pipeline Improvement` timeline comment by the `record-improvement` action. **ONE comment per curation pass** — never one comment per guardrail. The guardrail ids are a list *inside* this single comment, so a pass that touches G-401/G-402/G-403 still produces one message, not three. The state machine allocates the `G-NNN` id(s); the Curator writes the `### G-` record(s) in `references.md` in the same pass.

<!-- A curation-only pass (dedup / retire / strengthen, no new record) still posts this ONE comment with Guardrails: none and an Effectiveness line. -->

## Class

<the recorded root-cause class this pass answers — `defect` | `technique` | `environment` | `scope` | doc drift>

## Root cause

<the mechanism, derived from the failure record — the audit verdict, the retry `## Fix Plan`, the event log, `.opencode/tmp/<issue>/observations.md` — never from memory of the round>

## Lever

<the home that makes the lesson real — `playbook` | `skill` | `machine` | `doc`. A script/machine lever routes to the Toolsmith/Machinist; a principle / `AGENTS.md` / agent-identity change is proposed to the human, never applied.>

## Guardrails

<the `### G-NNN` record(s) written or curated this pass — one line each with its failure class — or `none (curation only: deduped / retired / strengthened)`>

## Effectiveness

<the `effectiveness:` outcome for **every** guardrail this round exercised — `Pending` | `Applied` | `Confirmed` | `Partial` | `Retired`, each with the evidence that sets it>

*Authored by Curator*
