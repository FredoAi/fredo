---
name: pipeline-checks
description: Runs the pipeline's committed audit checks — plan drivability (flag undrivable QA rows before planning→implementation) and product-subtree diff (decide whether a docs/pipeline-only commit after a live capture invalidates served evidence). Load when validating a plan before implementation, or when deciding whether a re-serve is owed after a post-capture commit.
---

# Pipeline Checks

Two committed instruments that turn prose guardrails into deterministic checks.

## 1. Plan drivability census

```
powershell -NoProfile -File .opencode/scripts/check-plan-drivability.ps1 -Issue <N>
# or: -File <path>   [-WarnOnly]
```

Reads the `## QA Expert` section of `.opencode/tmp/<issue>/triage.md` and reports
every QA row that cannot be driven as written:

- an obvious placeholder — `<executor>`, `<evidence>`, `<how>`, `TBD`, `TODO`, `upload-pending`;
- a data row with an empty evidence cell;
- no QA table at all.

Run it before `transition planning → implementation`; fix every `PROBLEM:` line
first. Exit codes: **0 = drivable**, **1 = not drivable**, **2 = error**.
`-WarnOnly` reports problems but exits 0 (advisory). `-SelfTest` runs the three
built-in controls.

## 2. Product-subtree diff

```
powershell -NoProfile -File .opencode/scripts/product-subtree-diff.ps1 -Served <sha> -Intended <sha>
```

Compares the PRODUCT subtree (`apps`, `package.json`, `pnpm-lock.yaml`,
`apps/tauri/src-tauri/Cargo.toml`, `Cargo.lock`) between two commits. Exit codes:
**0 = UNCHANGED** (a docs/pipeline-only commit after the serve does not invalidate
product evidence — re-stamp the evidence), **2 = CHANGED** (re-serve before
re-testing), **1 = error**. Mirrors the state machine's env-evidence tolerance
(C1). `-SelfTest` runs the two built-in controls.

## Notes

- Both scripts are read-only — they never write to the repo, the event log, or GitHub.
- After editing either script, run `-SelfTest` and then the pipeline harness
  (`test-scripts.ps1`), which pins both self-tests.
- The plan census is a *pre-flight*: the state machine's A3 guard independently
  refuses the same placeholders at the planning exit, so the two agree by design.
