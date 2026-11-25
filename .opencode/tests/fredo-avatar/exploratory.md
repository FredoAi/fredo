# fredo-avatar — Exploratory

> Unscripted probes for the 3D character cut-over. A confirmed finding is PROMOTED to
> `functional.md` as a new `F-AV-` row (keep the origin note). Live policy; capture anything visual
> under `.opencode/tmp/3210/e2e/`.

- [ ] E-AV-1: Rapidly toggle the companion OFF→ON→OFF while the asset is still loading. Does any
      frame show a blank seat, a doubled avatar, or a stale canvas? Probe the in-page rAF recorder.
- [ ] E-AV-2: Change the accent 10 times in a row while a reply streams. Any drift between
      `data-avatar-body-color` and the computed `--accent-primary`? Any frame where the body is the
      PREVIOUS accent after the change settles? Any `Maximum update depth exceeded`?
- [ ] E-AV-3: Put the window in the background (hidden) for 60 s with the companion ON, then
      restore it. Does the character resume on the CURRENT clip/state, or a stale one? Are RAF ticks
      zero while hidden?
- [ ] E-AV-4: Sleep/undock (GPU reset) or drive `WEBGL_lose_context.loseContext()` from the page
      context. Does the surface fall back to the poster for the rest of the mount (never blank, never
      a retry storm)? Capture `e-av-4-context-lost.jpeg`.
- [ ] E-AV-5: With reduced motion stubbed in jsdom, force a one-shot (`teleport-out`). Does it clamp
      into a still frame rather than loop the one-shot?
- [ ] E-AV-6: Resize the window to the 900×600 minimum mid-teleport. Does the avatar box, the seat
      slot and the command-bar `y` stay fixed? Any overflow/scrollbar?
- [ ] E-AV-7: Trigger `error` (`open NotARealApp`) then immediately teleport away and back. Is the
      state machine's hold preserved (no stranded `error`, no stranded one-shot pose)?
- [ ] E-AV-8: Move the asset aside while the app is RUNNING (not reloaded) and remount the avatar.
      Does the load failure degrade to the poster, or throw/blank?
