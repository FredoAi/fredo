# ADR-8: Teleport-Attached Companion Turn

- **Status:** Accepted
- **Supersedes:** [ADR-3](0003-launcher-only-conversation-surface.md)

## Context

ADR-3 made the launcher the **only** conversation surface. It was written to stop every
application from re-implementing a chat client, and it did: the companion had one grounding path,
one dispatch path and one capability list. But it also separated conversation from the work.
While a user is inside Wireframe, the thing they want changed is on screen in front of them; a
launcher that must be raised, that renders an app-scoped context header and a place palette, and
that answers from a detached overlay turns a one-sentence correction into a navigation task. The
P6 rescope kept ADR-3's core rule — **no per-application chat panel** — but replaced the launcher
as the conversation surface.

## Decision

The companion's turn surface is a **compact instruction box attached to Fredo's teleport
landing** in the window that hosts him (`CompanionComposer`, `shared/components/companion/`).

- **Teleport-attached, not launcher-attached.** The box opens on the teleport-in settle (and on
  the same path for an explicit "bring Fredo here" request). It auto-focuses its input so the
  user types without clicking; Escape dismisses it and restores focus to the app, never `body`.
- **The target is the app in front of Fredo.** Target resolution is one pure function
  (`composerTarget.ts`): an explicit request naming an app wins; otherwise the topmost app frame
  containing Fredo's landing point, then the standalone window's app, then the focused app. A
  whole-word, case-insensitive app mention in the instruction overrides the default.
- **One funnel.** The turn is grounded on `describeContext(targetApp)` and submitted through the
  existing skill-aware `ask` path; the box adds no second dispatch route, no transcript and no
  history.
- **The launcher stays launch/search.** It opens apps, filters the grid and runs global commands;
  it does not render an app-scoped navigation palette or ground a conversation turn. `>` is
  ordinary search text.
- **The box never covers Fredo or the reply.** Placement is the pure `computeComposerPlacement`
  decision, ranked `above > right > left` and never `below`, holding at least the 14 px avatar
  clearance; it shrinks and scrolls rather than covering him.
- **No new chat surface.** There is still no in-app chat panel, docked assistant or conversation
  transcript. The box is a turn composer, not a client.

## Consequences

- Conversation happens where the change happens, so the target app is the default grounding
  context instead of something the user must re-state.
- The companion remains one system: the same `describeContext`, the same `dispatch()`, the same
  journal and the same companion manifest as the command bar, keys and agent bridge.
- The launcher gets simpler and truthful: one search/launch surface, one global-command path, and
  a confirmation dialog that renders whenever a destructive/external request is pending — even
  with the launcher closed.
- Application UIs still carry no conversational chrome; they declare verbs and a context envelope.
- The turn surface is bounded: no history, no persistence, no `aria-live` region, no document
  key listener.

## Rejected alternatives

- **ADR-3's launcher-only conversation.** It is the status quo this ADR supersedes: it forces a
  navigation detour away from the work and made the launcher carry an app-scoped palette it did
  not need.
- **A docked chat panel per application.** Still rejected — it re-creates the #3099 mirror in
  every app and gives the companion several dispatch paths.
- **A floating always-on assistant overlay.** It floats above every application, so its target is
  ambiguous and its grounding is undefined.
- **A persistent instruction box.** Keeping the box open across turns reintroduces a transcript
  surface and the persistence and stale-target problems that come with it; the box is per-turn.
