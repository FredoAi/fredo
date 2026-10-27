# Audit Verdict Comment Template

> Drafted by the **Auditor** as `.opencode/tmp/<issue>/audit-verdict.md`, posted as the `## Audit Verdict` timeline comment by the `audit-record` action. This is the Auditor's **ONE** structured message per audit — the verdict plus the per-AC re-derivation against the evidence the record holds. The Auditor is read-only: this comment is its only output; it never edits the work.

<!-- The verdict line MUST be the first content line: "Verdict: **SUCCESS**" or "Verdict: **RESTART → <phase>**". -->

Verdict: **SUCCESS**

## Integrity gate

- `verify`: INTEGRITY OK — the event/error logs are append-only and unmodified.

## Per-AC re-derivation

| AC | Verdict | Evidence in the record | Basis |
|----|---------|------------------------|-------|
| GA-1 | PASS | <the recorded evidence — the `## Tests Runs` row and its live receipt> | <how the plan's stated observable is met> |
| GA-2 | PASS | <recorded evidence> | <...> |
| GA-3 | UNVERIFIED | <named blocker: the specific tool failure / environment wedge / data absence, with the command or query attempted> | <why it cannot be judged — never a guess> |

<!-- Every acceptance criterion maps to the evidence the record actually holds.
     A PASS with no supporting evidence is a false PASS and is rejected.
     An UNVERIFIED/FAIL row MUST name its blocker — a bare UNVERIFIED is returned, not accepted.
     Judge from the record (the audit bundle + the `## Tests Runs` verdict), never from the author's reasoning. -->

## Verdict rationale

- <SUCCESS: every AC is supported by evidence in the record and the integrity gate passed — state it plainly.>
- <RESTART: the phase to re-enter, the structured root cause (`defect` | `technique` | `environment` | `scope`), and the missed-AC list the next round must complete — this list is the retry context every re-dispatched agent reads.>

*Authored by Auditor*
