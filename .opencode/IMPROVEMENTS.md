# Process Improvements

Living document. Max 50 lines. Archive oldest entries to IMPROVEMENTS-archive.md.

## Active

| Date | Trigger | Change | Justification |
|------|---------|--------|---------------|
| 2026-05-26 | Spec #79 | Architect must not dispatch Coder/Reviewer directly — must dispatch Planner who owns the pipeline | Coder PR #81 was non-draft, targeted main, merged without pr:approved label or CI gate. Planner script ensures pr-create --draft, target spec branch, and reviewer runs pr-merge.ps1 with gates. |

## Archived

_Archived entries moved to IMPROVEMENTS-archive.md when this file exceeds 50 lines._