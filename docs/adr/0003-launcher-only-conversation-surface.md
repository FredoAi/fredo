# ADR-3: Launcher-Only Conversation Surface

- **Status:** Accepted

## Context

#3099 had to publish a mirrored action list so the companion could run what applications already
had (`apps/ui/src/shared/companion/manifest.ts`, published by
`apps/ui/src/shared/companion/publisher.ts:55-80`). A per-application chat panel would multiply that
surface again: each panel needs its own grounding, its own dispatch path, and its own copy of the
capability list. `docs/UX_FLUENCY_RESEARCH.md` §3.2 already records the launcher as the only
conversation surface and lists "none in-app" for every application.

## Decision

The launcher is the only conversation surface. No application renders a chat panel, docked
assistant, floating overlay, or command-bar chat. The companion grounds on `describeContext(appId)`
(§7) and dispatches through the single `dispatch(intent)` entry point (§5) — the same one the rail,
palette, keys, and toolbar use.

## Consequences

- There is one conversation surface to ground, instrument, secure, and test.
- Application UIs carry no conversational chrome; they declare verbs and a context envelope instead.
- A new application gains conversation by declaring verbs, not by building a chat client.
- The companion can act only through the shared entry point, so it cannot drift from the manual surface.

## Rejected alternatives

- **A docked chat panel per application.** It re-creates the #3099 mirror in every app and gives the companion several dispatch paths.
- **A floating assistant overlay.** It floats above every application, so its scope is ambiguous and its grounding is undefined.
- **Command-bar chat inside each app.** It hides conversation behind an application-specific affordance and defeats the single-surface rule.
