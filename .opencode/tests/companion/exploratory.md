# Companion — Exploratory

> Unscripted edge/failure probes for the companion overlay feature domain (Spec #2850). The
> Tester adds findings here; a confirmed finding PROMOTES to `functional.md` as a new `F-` row
> (keep the origin note). A confirmed regression-free probe is recorded here (no promotion).

## Prompt lines

- [ ] E-1: **State-expression edge at the sm scale.** Trigger talk, teleport-out, and teleport-in
      at the 80×100 sm render and screenshot each. Do the mouth overlay, closed-eye lines, streak,
      and sparkle highlights stay crisp (uniform crisp cells — no subpixel smear, no anti-alias
      fill-in of the hollow head / fragmentation gaps) at the small scale? Any illegible/merged
      detail is a finding (promotes to functional F-3).
- [ ] E-2: **Rapid click churn.** Rapidly single-click / double-click / triple-click the avatar
      (joke + TicTacToe + teleport interleaved). Does the 250 ms discriminator stay correct (no
      stray joke after a game-open double-click, no stuck talk/idle), and does the console stay
      clean? Any mis-discrimination / stuck state / console error is a finding.
- [ ] E-3: **Rapid teleport spam.** Ctrl+right-click several points in quick succession (and
      across both windows when the terminal window is open). Does the out → hidden → in sequence
      settle cleanly each time (no mid-teleport state corruption, no double-mount, no ghost avatar
      in the wrong window)? Any race/corruption is a finding (promotes to functional F-6/F-10).
- [ ] E-4: **Near-edge teleport + resize mid-idle.** Teleport the companion to a point where the
      sm avatar's +20 px height is critical (bottom edge, right edge), then resize the window
      while it idles there. Does the avatar stay fully on-screen and un-clipped after the resize,
      and does the next bubble/teleport re-derive correctly? Any off-screen/clipped avatar or stale
      anchor is a finding (promotes to functional F-5/F-11).
- [ ] E-5: **Fractional-DPI render of the expression overlays.** At a fractional OS/webview zoom,
      do the state overlays (mouth, closed-eye lines, streak, sparkles) stay proportional with no
      seam-shifted cells / merged rects? Any distortion at non-integer scale is a finding.
- [ ] E-6: **Re-theme while a bubble is open + streaming.** Switch themes/presets mid-stream and
      mid-bubble-hold. Does the avatar + bubble chrome + cursor all re-tint together with no stale
      color (border/tail/cursor all follow `--accent-primary`)? Any element stuck on a stale color
      is a finding (promotes to functional F-14).
- [ ] E-7: **Legacy-key chaos.** Seed `Fredo_companion_color`/`Fredo_companion_auto_walk` with
      mixed/bogus values across localStorage AND the AppStore simultaneously, then open the
      settings modal and relaunch. Any crash / resurrected color UI / console error is a finding
      (promotes to functional F-13).
- [ ] E-8: **Joke-stream error path.** Stop the model / drop the mmproj mid-session and single-click
      the avatar. Does the bubble show the loading/error path and recover to idle (no stuck talk,
      no cursor left blinking, no console error)? Any stuck state is a finding.
- [ ] E-9: **Cross-window teleport with an open game.** Open TicTacToe in main, then Ctrl+right-click
      in the terminal window. Does the game bubble close cleanly on out and does main return to
      idle-with-no-bubble after the teleport? Any orphaned bubble/game state in either window is a
      finding.
- [ ] E-10: **Reduced-motion teleport legibility.** Under `prefers-reduced-motion: reduce`, is the
      teleport still readable as a teleport (opacity crossfade out/in ~400 ms), and is the mouth
      still visible while talking? Any state that becomes indistinguishable under reduced motion is
      a finding.
