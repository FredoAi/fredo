---
name: doc-sync
description: Syncs the product documentation and the pipeline's own run edits at the audit gate. Classifies the merged spec diff into the product-doc categories (ARCHITECTURE.md, CLI_GUIDE.md, SETUP.md, SECURITY.md, FAQ.md), patches the affected docs, then opens + force-merges (`--admin`) the consolidated SPEC MAINT PR through the machine (`maint-pr`). Use when the Orchestrator reaches the post-audit gate after a successful audit, or when the Auditor flags stale or missing product docs.
---

# Doc-Sync — The Gate Product-Doc + Pipeline Sync

## What this skill does

At the audit gate the Orchestrator is the **product-doc owner**. The merged spec diff is the only complete view of the product state, and the gate — running last — is the only point positioned to see it. This skill turns that view, plus the run's own pipeline edits, into **ONE consolidated SPEC MAINT PR opened and merged by the machine**:

1. **Classify** the merged spec diff into the product-doc categories.
2. **Patch** only the docs the diff actually affects.
3. **Open the SPEC MAINT PR** through the machine's `maint-pr` action — a single `maint/<N>` PR carrying both the pipeline's own edits and the product docs — which the machine **force-merges** as the privileged writer (`--admin`, skipping the required `validate` status check — the repo has auto-merge disabled).

The **machine** performs the branch push, commit, PR, and merge. The Orchestrator has **no direct `main` write**; the single-writer rule has exactly **one** exception — the developer's `git push origin HEAD:spec/<N>` — and this skill adds none.

It is a **judgment task**: classification and patching are judgment; the `maint-pr` invocation is exact. Follow the invocation exactly; use judgment for *what* to classify and patch.

## When to use it

- **At the success gate** — in the `post-audit` phase, after the Auditor records `audit-record --verdict success` (which transitions `audit → post-audit`). Run the `maint-pr` call once, then `transition post-audit → cleanup`. The post-audit **success** exit is **gated**: it requires BOTH the **Curator's** `record-improvement` (a `pipeline.improvement` event) AND the **merged SPEC MAINT PR** (a `maint-pr` event with `merged: true`) — so dispatch the Curator first and let the merge complete, or the transition is blocked. (A **restart** exit requires neither — the run is not final.)
- **After a "sync docs" restart** — when the Auditor failed the issue because the merged product state did not match the docs and restarted to Implementation with "sync docs" in scope; the run reaches the eventual success gate, where this skill runs.
- **Do NOT run it on a restart verdict.** The product is not final — there is nothing to gate. Preserve the run's own edits (Step 2) so they ride the eventual success gate.
- Load the **`pipeline-state`** skill first for the `maint-pr` action, the summary comment, and the transition.

## Procedure / Steps

### Step 1 — Read the merged spec diff

`origin/main` already carries the merged product diff (the spec PR squash-merged at `testing → audit`).

```
git fetch origin
git log --oneline origin/main -20
```

Find the spec PR's squash-merge commit (title `Spec #<N>: …`), then inventory and read it:

```
git show --stat <merge-sha>
git diff <merge-sha>~1 <merge-sha>
```

**Do not use a `..` revision range** — the shell rules deny it. Use two-ref forms or `<sha>~1`.

Classify each changed area into a product-doc category:

| Category | Classify when the diff touches… |
|----------|--------------------------------|
| `docs/ARCHITECTURE.md` | module map, event flow, IPC, feature modules, a new subsystem |
| `docs/CLI_GUIDE.md` | a `fredo` CLI command or flag (its value set/help) |
| `docs/SETUP.md` | prerequisites, model download, OTLP config, launch/install steps |
| `docs/SECURITY.md` | trust boundaries, sandbox/permission posture, hardening |
| `docs/FAQ.md` | a user-facing question the change answers or invalidates |

A diff that touches none of a category's surface leaves that doc **untouched**.

### Step 2 — Inventory the run's own edits

The Curator, Machinist, and Toolsmith edit the pipeline in the served tree during the run; the Orchestrator's doc patches join them. These edits are **uncommitted** — `maint-pr` commits them, so **do not commit or push them by hand**.

```
git status --short
```

The SPEC MAINT PR carries all of these paths in **one** commit:

| Paths `maint-pr` stages | |
|---|---|
| `docs/agentic-pipeline/`, `.opencode/skills/`, `.opencode/scripts/`, `.opencode/pipeline.json`, `opencode.json` | the pipeline's own edits |
| `docs/ARCHITECTURE.md`, `docs/CLI_GUIDE.md`, `docs/SETUP.md`, `docs/SECURITY.md`, `docs/FAQ.md` | the product docs |

**Never** include product source (`apps/**`) or agent identity (`.opencode/agents/**` — human-owned, proposed never edited by an agent).

**Preserve before any forced checkout (G-1976).** `maint-pr` reads the working tree; a forced checkout can discard uncommitted edits with no signal. If a forced checkout is unavoidable, copy pending in-domain edits under `.opencode/tmp/<N>/` first (or commit them), then re-apply before running `maint-pr`.

### Step 3 — Patch the affected docs

Edit only the categories Step 1 identified: `docs/ARCHITECTURE.md`, `docs/CLI_GUIDE.md`, `docs/SETUP.md`, `docs/SECURITY.md`, `docs/FAQ.md`. Keep each patch anchored to the merged diff; leave an unaffected doc untouched.

### Step 4 — Open + merge the SPEC MAINT PR

Run exactly this — the machine creates the branch `maint/<N>`, commits all the paths above, pushes, opens the PR, **force-merges it with `--admin`** (skipping the required `validate` check), and verifies the merge landed:

```
rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent orchestrator --action maint-pr
```

- On success: `SPEC MAINT PR MERGED: <url> (maint/<N>)`.
- Optional `--title "<t>"` / `--body-file <f>` override the PR title/body.
- If the working tree has **no** changes to any of those paths it prints `NO-OP: no post-audit changes for #<N>` and opens no PR — but a no-op does **not** satisfy the success gate (a real post-audit is never empty: the Curator authors a `### G-NNN` record).
- If the PR cannot merge (it closes unmerged / the bounded verification times out) the action **errors** — the run cannot leave `post-audit` for `cleanup`, so `done` is unreachable until the SPEC MAINT PR lands.

### Step 5 — Summary comment

Draft the summary to `.opencode/tmp/<N>/doc-sync.md` — the classified categories, the SPEC MAINT PR URL (merged), and the pipeline edits included — and post it through the state machine (the only agent-facing prefix):

```
rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent orchestrator --action comment --prefix Status --body-file .opencode/tmp/<N>/doc-sync.md
```

Then continue the phase: `transition post-audit → cleanup`.

## Examples

Full sequence for spec `#3100` at the success gate (root on `spec/3100`):

```
git fetch origin
git log --oneline origin/main -20
# → a1b2c3d Spec #3100: add the widget subsystem

git show --stat a1b2c3d
git diff a1b2c3d~1 a1b2c3d
# → apps/ui/src/... + apps/tauri/src-tauri/src/... + docs touched: none
# classify: new module + IPC seam → ARCHITECTURE; new CLI flag → CLI_GUIDE

git status --short
# → M docs/agentic-pipeline/playbooks/orchestrator.md
#   M docs/agentic-pipeline/playbooks/references.md
#   M .opencode/scripts/pipeline-state.rs
#   ?? .opencode/skills/doc-sync/SKILL.md

# ... patch docs/ARCHITECTURE.md + docs/CLI_GUIDE.md with the edit tool ...

rust-script .opencode/scripts/pipeline-state.rs --issue 3100 --agent orchestrator --action maint-pr
# → SPEC MAINT PR MERGED: https://github.com/.../pull/41 (maint/3100)

rust-script .opencode/scripts/pipeline-state.rs --issue 3100 --agent orchestrator --action comment --prefix Status --body-file .opencode/tmp/3100/doc-sync.md
```

## Failure modes

| Symptom | Cause | Correct response |
|---------|-------|------------------|
| `BLOCKED: actor <x> not allowed to maint-pr` | only the Orchestrator may open the SPEC MAINT PR | run it as `--agent orchestrator` |
| `NO-OP: no post-audit changes for #<N>` | every path is clean | expected only if the run made no edits — a no-op does not satisfy the success gate; ensure the Curator recorded the `### G-NNN` record |
| The action errored on the merge | the merge did not land (the PR closed unmerged / the bounded verification timed out) | re-run `maint-pr`; the gate blocks `cleanup` until the PR is MERGED |
| A run edit never reached the PR | a forced checkout discarded it before `maint-pr` ran (G-1976) | preserve pending in-domain edits under `.opencode/tmp/<N>/` (or commit) before the checkout, then re-apply |
| You hand-committed/hand-pushed to `main` | the Orchestrator has no direct `main` write | stop — the machine opens + merges the PR; the only push exception is the developer's `spec/<N>` push |
| The summary comment is missing | skipped the state-machine `comment` action | post it via `--action comment --prefix Status` — never a direct `gh` call |
| Stale or missing product docs remain | classification missed an affected category | re-run the classification against the full merged diff; a missed doc is an audit failure |

## Resources

- The gate action contract: [state-machine.md](../../../docs/agentic-pipeline/state-machine.md) (the `maint-pr` row — the single SPEC MAINT PR; the `post-audit` row; the single-exception note)
- Gate rationale + rule 9: [principles.md](../../../docs/agentic-pipeline/principles.md) (rule 6 — the gate-time doc sync; rule 9 — scripts via skills)
- The Orchestrator's gate step: [playbooks/orchestrator.md](../../../docs/agentic-pipeline/playbooks/orchestrator.md) (step 11 — gate doc-sync; step 12 — post-audit)
- The phase: [pipeline.md](../../../docs/agentic-pipeline/pipeline.md) (Phase 5 — Audit)
- The single-writer rule: [github.md](../../../docs/agentic-pipeline/github.md)
- The `maint-pr` + comment + transition actions: the `pipeline-state` skill
