# Fredo CLI — Exploratory

> Unscripted edge/failure probes for the `fredo` CLI surface. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> named blocker (G-053), never fabricated.

- [ ] E-1: **App killed mid-call.** Start the open command and kill the app immediately. Does the CLI
      fail cleanly (bounded, readable, a defined exit code) or hang? Any hang/unhandled panic is a
      finding (promotes to F-3/F-4).
- [ ] E-2: **Concurrent CLI invocations.** Run several open commands back-to-back/in parallel. Does the
      socket handle them without a duplicate window, a lost response, or a crash? Promotes to F-5.
- [ ] E-3: **Identity edge forms.** Probe empty/whitespace/unicode/very long identities, and a feature
      id of a non-showable feature. Does every case produce a readable outcome and open nothing wrong?
      Promotes to F-3.
- [ ] E-4: **Stale socket vs live app.** With a leftover socket file but no app, does the CLI follow
      the documented exit-2 fallback or hang? Promotes to F-4.
