# Fix Plan Comment Template

> Drafted by the **Software Architect** as `.opencode/tmp/<issue>/fix-plan.md` on a retry round — dispatched by the Self-Improver with the tester's FAIL verdict BEFORE the feature re-enters implementation. Auto-posted by the state machine as the machine-stamped `## Fix Plan (round N)` timeline comment on the feature issue (the `(round N)` header is derived by the machine — never write the round yourself). Retry rounds only: a stray draft on a first entry is never posted.

```markdown
## Failed ACs

- AC<n>: <expected vs actual — one line per failed/unverified AC, from the tester's verdict>
- ...

## Root Cause (file:line)

- <traced mechanism with file:line citations; label hypotheses explicitly and
  pair each with a developer discrimination step>

## Fix Scope

- [ ] ST-<n> <this round's actionable work — deltas against the full plan's ST items,
      reusing their IDs where a prior item is reworked; carry over non-goals and
      regression invariants that still apply>
- [ ] ...

*Authored by Software Architect*
```

Notes:
- The full plan is unchanged — reference it (`## Triage Plan` comment) for context; do not repeat it.
- Environment wedges (G-046/G-052 signatures) are NOT fix scope — route them back to the Self-Improver instead of prescribing product fixes.
- The anti-spoofing gate refuses drafts without an `*Authored by*` footer.
