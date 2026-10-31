# ADR-4: Risk-Classified Auto-Apply with Attributed Journal Undo

- **Status:** Accepted

## Context

Auto-apply is only acceptable when a mistake is reversible and attributable. The retired
per-application command spec carried no `risk` field, and its outcome type carried no journal —
nothing recorded who changed what or how to reverse it.

## Decision

Apply risk-classified policy. Verbs with `risk:'safe'` or `risk:'mutating'` apply without a
confirmation and write one journal entry. Verbs with `risk:'destructive'` or `risk:'external'`
require a confirmation carrying the verb, target labels, consequence, and undo availability. Every
mutation is journaled with an inverse and is queryable by actor, count, since, and verbId;
`journal.undo` accepts `actor: 'human' | 'companion' | 'system'`. A non-undoable external effect must
declare its consequence copy.

## Consequences

- Auto-apply is safe only because every mutation is journaled with an inverse and queryable by actor/count/since/verbId.
- Confirmation is reserved for irreversible or outside-the-application effects, so fluency survives.
- Undo is a query, not a hidden stack, so a companion can undo its own last action without touching a human's.
- A verb that cannot be undone must say so in its own words; the UI never invents a generic apology.

## Rejected alternatives

- **Confirm everything.** It kills fluency and trains users to dismiss the dialog without reading it.
- **No-undo auto-apply.** It accepts unattributable, unrecoverable risk; neither a user nor the companion can correct a mistake.
- **A per-application undo stack.** It is not queryable across channels and cannot attribute an entry to the actor that caused it.
