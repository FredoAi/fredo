# fredo-avatar — Regression Tests

> The "must not change" baseline for the 3D character cut-over (base). Run alongside
> `companion/regression.md`, `launcher/regression.md`, `desktop-shell/regression.md` and
> `app-icon/regression.md` — those suites' avatar rows were re-pointed to the new hooks by the
> same pass that wrote this file (each carries a `#3210` SUPERSEDE note).
>
> **Verification policy: live** for the runtime rows (R-AV-2, R-AV-3, R-AV-8, R-AV-10); **build/
> static** for R-AV-1, R-AV-5, R-AV-7, R-AV-9. A zero-test receipt is a FAILED DRIVE.

## R-AV-1 `[RETAINED]` — the OS app-icon provenance guard is RE-POINTED, the icon is byte-identical

- [ ] R-AV-1: Run `pnpm --filter @fredo/ui exec vitest run src/shared/components/fredo-avatar/__tests__/iconSourceParity.test.ts`
      and report the executed test count. Read the guard's assertions. Compute the SHA-256 of
      `apps/tauri/src-tauri/icons/fredo-icon-large.svg` and compare with the pre-change digest.
  **Expected:** green with a **non-zero executed count** (the geometry-derived expectations became
      literals, so the count legitimately changed — record old → new); the guard asserts the icon
      SVG's OWN invariants (58 `<rect>`, the literal bbox `87,67,840,1167`, a single `<path d>`, one
      uniform `scale(S)`, the baked palette) + a SHA-256 pin; the icon is **byte-identical** to the
      pre-change digest — the deleted geometry table must not move the shipped icon.
  - **Edge:** the guard must NOT import `fredoAvatarGeometry` (deleted); a "file absent" claim made
    with `Glob` is a false negative (G-024) — read the exact path; `scripts/generate-app-icons.mjs`
    still writes nothing under `fredo-avatar/`.

## R-AV-2 `[GUARD]` — `fredoAvatarIdle.css` (WRAPPER motion) survives

- [ ] R-AV-2: SHA-256 `apps/ui/src/shared/components/fredo-avatar/fredoAvatarIdle.css` and compare
      with the pre-change digest; confirm `FredoAvatar.tsx` still imports it; read
      `getComputedStyle(.fredo-avatar-idle).animationName` on the launcher seat.
  **Expected:** the file is byte-identical **and its import is kept**; the wrapper reports
      `fredo-idle-bob, fredo-idle-glow` (the shipped bob/glow still run); a reduced-motion pass still
      suppresses them via the file's own rule.
  - **Edge:** deleting this file would silently kill shipped motion in a green build — only
    `fredo-avatar.css` (the SVG expression overlay stylesheet) is this spec's deletion target.

## R-AV-3 `[RETAINED]` — click / double-click / Ctrl+right-click are byte-identical

- [ ] R-AV-3: Single-click the companion (joke), double-click (TicTacToe), Ctrl+right-click
      (teleport out, then in from `run-cli-terminal`); timestamp each leg and read `data-state` /
      `data-streaming`.
  **Expected:** behaviour identical to the shipped tree: `idle→talk→…→idle`; TicTacToe opens
      208×268; the teleport completes in the shipped window (≈400 ms motion + 50 ms settle per leg)
      clamped at the real 80×100 box; no stranded one-shot pose.
  - **Edge:** a state change mid-one-shot must crossfade, never freeze; the seat must not blank
    during the sequence (R-AV-10).

## R-AV-4 `[RETAINED]` — every jsdom component suite stays green through the PRODUCTION poster path

- [ ] R-AV-4: `pnpm --filter @fredo/ui test:run`; enumerate the avatar/companion suites and report
      each queue's executed test count.
  **Expected:** all green, each with a non-zero count. The suites render the REAL component and the
      poster path (no mocked component, no test-only prop); `avatarAssetContract.test.ts` is green
      and asserts the shipped GLB's own clip table ⇄ `AVATAR_CLIPS` ⇄ the authoring manifest
      (32 clips present; only `teleport-out`/`teleport-in` are `loop:false`; 1.333 s durations),
      the two poster PNG IHDRs, and CSP `connect-src` containing `'self'`; a suite-level
      console-error gate stays clean (the capability probe must not call `canvas.getContext` under
      jsdom — U-1).
  - **Edge:** a `-t`/file filter that selects nothing is a FAILED DRIVE (name the filter and the
    expected count); a gated pin that early-returns on a missing asset is corroboration only
    (G-435) — F-AV-15 owns the asset's presence.

## R-AV-5 `[NEW]` — the `md` footprint at the COMPONENT (no shipped surface renders `md`)

- [ ] R-AV-5: jsdom renders `<FredoAvatar size="md" />`; read the root's inline width/height, the
      poster layer's box, and `scrollWidth/scrollHeight`.
  **Expected:** 132×165, undistorted (the 0.8 portrait aspect), the poster fills it exactly, no
      overflow.
  - **Edge:** **do not hunt a 132×165 live box.** Both shipped surfaces are `sm` 80×100
    (`LauncherShell.tsx:1765,1773`; `CompanionEntity.tsx:1875,1882`) — the plan's SC-1 `md` clause
    is bound to this row (see `## Discussion`).

## R-AV-6 `[GUARD]` — names still MOVED to #3224 must not appear; #3223's landed names are LEGITIMATE

- [ ] R-AV-6: Comment-stripped grep the base code for `data-avatar-doom-phase`,
      `resolveAvatarClip`, `poster-detail-doom`, the 11 emotion ids
      (`uwu`,`love`,`sad`,`surprised`,`sleepy`,`skeptical`,`confused`,`silly`,`squint`,`angry`,
      `funny`) and a 23-member `FREDO_AVATAR_STATES`; run a non-vacuity control against a tree that
      DOES carry them.
  **Expected:** zero hits in base code; `FREDO_AVATAR_STATES.length === 12`; the durable-suite rows
      that own those names are POINTERS to **#3224**, never re-assertions.
  - **Edge:** a pointer sentence that NAMES a moved hook is compliance (judge polarity); above all the
    base must not pre-create **#3224's** widened vocabulary. (#3223's own Doom machine is legitimate —
    it lives in `doomPerformance.ts`/`doomClips.ts`, and `FredoAvatar.tsx` still takes a plain boolean
    and names none of it.)
  - **AMENDED by #3223 — `doomPerformance` (and `doomClips`) are REMOVED from the banned list.** This
    spec LANDS `doomClips.ts` (`DOOM_CLIPS`, `DOOM_ONE_SHOT_CLIPS`, `DOOM_WEAPON_ORDER`,
    `DOOM_WEAPON_CLIP`, `DOOM_SUPPRESSING_STATES`, `isDoomClipName`, `DoomClipName`, `DoomWeapon`) and
    `doomPerformance.ts` (`doomPerformance`, `DOOM_FLOURISH_INTERVAL_MS`, `DOOM_FLOURISH_MS`,
    `resolveDoomClip`, `advanceDoomWeapon`, `getDoomWeapon`, `setDoomPerformanceEngaged`,
    `completeDoomOneShot`, `setDoomPerformanceSuspended`, `getDoomPerformanceSnapshot`,
    `subscribeDoomPerformance`, `resetDoomPerformanceForTests`). Keeping either name banned reddens
    this guard on the spec's own success — the ban is NARROWED, not dropped: every name above still
    has zero hits.
  - **Universe (G-441):** the base avatar PRODUCT tree (the tree minus `__tests__`/`__mocks__`/
    `*.test.*`), comment-stripped; report the scanned count, the excluded count and the tree the scan
    ran in, plus the non-vacuity control's hit list. `FredoAvatar.tsx` still imports nothing from the
    Doom store — the shell takes a plain boolean — and the #3210 source scan
    (`fredoAvatarShell.test.tsx:151-172`) stays green UNMODIFIED.

## R-AV-7 `[RETAINED]` — the resolver and the size values do not move

- [ ] R-AV-7: `vitest run …/fredoAvatarResolver.test.ts …/fredoAvatarSizes.test.ts` (filter by
      file path) and report executed counts.
  **Expected:** both pass **UNCHANGED** (byte-identical test files) — the resolver and the
      `AVATAR_SM`/`AVATAR_MD` values are not this spec's surface (`fredoAvatarSizes.ts` may only
      inline the 1014:1264 aspect constant, with the values unchanged).
  - **Edge:** if either suite needs an edit, the change overran its capsule — FAIL and report.

## R-AV-8 `[GUARD]` — console clean, no re-render loop, frame budget honoured

- [ ] R-AV-8: Read `tauri_read_logs(source="console", level="error")` in BOTH windows after every
      leg; drive 5 rapid accent changes, a 12-state sweep, and a mount/unmount loop.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded` (the pre-existing
      `motion() is deprecated` WARN is exempt); no frame-driven React state; a hidden window runs no
      RAF ticks; the mount/unmount loop leaves no extra `<canvas>` in the DOM (context disposed).
  - **Edge:** accent change with the window hidden then shown; teleport during a stream.

## R-AV-9 `[RETAINED]` — the legacy durable-suite sweep is re-pointed, absence rows survive

- [ ] R-AV-9: Execute the re-pointed rows in `companion/`, `launcher/`, `desktop-shell/`,
      `app-icon/`; read every `#3210` SUPERSEDE note; confirm the doom-owned rows are pointers.
  **Expected:** every renamed row is executable and asserts the new hooks
      (`data-avatar-render`/`data-avatar-clip`/`data-avatar-poster-layer`); rows asserting a deleted
      surface ABSENT survive byte-identical (G-444); no row still drives `#fredo-expression`, a
      58-rect count, or the geometry suite; the #2917/#2922 SVG-fill blocks are marked RETIRED (a
      metric bound to deleted DOM cannot run).
  - **Edge:** re-run the sweep after any row is edited (correcting one subject changes the next
    search); a row whose expectation this round falsified is re-cut, never shipped.

## R-AV-10 `[NEW]` — a wrapper re-key (`animKey`) never blanks the seat

- [ ] R-AV-10: Install the F-AV-1 recorder, then drive a teleport (which bumps `animKey` and
      remounts the wrapper) and one non-teleport state change; read every recorded frame.
  **Expected:** every frame shows ink inside the avatar box (poster or canvas) — the seat never
      collapses to background for even one frame; the box rect is constant across the remount.
  - **Edge:** a remount mid-crossfade; a remount while the asset is still loading.

## R-AV-11 `[NEW]` (REQ-10 — UX-17) — click / double-click / Ctrl+right-click with Doom ENGAGED

- [ ] R-AV-11 Engage Doom Mode and settle into the armour idle (`get_doom_mode_status.phase ===
      "active"`, `data-avatar-clip` = a doom weapon clip). Then drive each gesture from `R-AV-3` again
      on the LIVE engaged surface, reading `data-state` / `data-streaming` / `data-avatar-clip` and
      capturing each leg.
  **Expected (each leg identical to the shipped tree, plus the overlay's independence):**
      (a) **single click** — the composer opens / the joke fires: `data-state` reaches `thinking` and
      then `joking` while `data-avatar-clip` STAYS the doom weapon clip (the armour overlay does not
      consume or block the flow), and the reply surface behaves as `F-7`/`R-AV-3` describe;
      (b) **double click** — the Tic-Tac-Toe card toggles and measures exactly **208×268**
      (`[data-testid="fredo-game-bubble"]`), no joke fires (the 250 ms discriminator,
      `CompanionEntity.tsx:1632-1656`), and a legal X→O move still completes;
      (c) **Ctrl+right-click** — leave and arrive performances still play and the companion lands at
      the shipped clamped target (`F-AV-27` owns the Doom-specific suspension clause; this row asserts
      the gesture's OUTCOME is unchanged), ending on a resting clip, never mid-teleport.
      Captures: `doom-on-click.jpeg`, `doom-on-doubleclick.jpeg`, `doom-on-teleport.jpeg`.
  - **Reddens after the change:** the engagement is what this row needs — on `main`'s tip no doom clip
    exists, so the invariant clause ("the clip stays a doom weapon clip while the flow moves") cannot
    be produced. The three gesture outcomes alone are green today and are the `[RETAINED]` half
    (`R-AV-3`), which must stay green unchanged.
  - **Edge:** a click during `doom-in` and during `doom-out`; the discriminator boundary (~240 ms =
    double, ~260 ms = single); a teleport while `flourishing`; the gesture with the composer open.
