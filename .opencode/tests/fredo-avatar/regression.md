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

## R-AV-6 `[INVERTED by #3224 — was a GUARD]` — the 11 emotion ids are now PRESENT; the still-banned names stay absent

- [ ] R-AV-6 (**INVERTED by #3224**, G-444 polarity) — this row used to ban the 11 emotion ids and
      pin `FREDO_AVATAR_STATES.length === 12`; both are inverted by design. Comment-strip the base
      avatar PRODUCT tree (the tree minus `__tests__`/`__mocks__`/`*.test.*`) and:
      (a) grep for the tokens that are STILL forbidden — `data-avatar-doom-phase`,
      `resolveAvatarClip`, `poster-detail-doom`;
      (b) assert the PRESENT state the widened vocabulary now requires — all 11 ids (`uwu`, `love`,
      `sad`, `surprised`, `sleepy`, `skeptical`, `confused`, `silly`, `squint`, `angry`, `funny`)
      are members of `FREDO_AVATAR_EMOTION_STATES` in `fredoAvatarStates.ts`, and
      `FREDO_AVATAR_STATES.length === 23` with `Object.keys(AVATAR_CLIPS).length === 23`.
      Run a non-vacuity control: a planted probe carrying `data-avatar-doom-phase` must be REPORTED.
  **Expected:** zero hits for the three still-banned tokens; the 11 ids PRESENT and the union 23;
      the durable rows that own the widened vocabulary are `functional.md` F-AV-30…F-AV-35 and this
      file's R-AV-12…R-AV-14.
  - **Edge:** a pointer sentence that NAMES a still-banned hook is compliance (judge polarity); the
    base must not pre-create a SECOND vocabulary (no parallel 23-list beside `FREDO_AVATAR_STATES`).
  - **#3223's own Doom machine is legitimate** — it lives in `doomPerformance.ts`/`doomClips.ts`
    (the ban list above was narrowed by #3223, not dropped); `FredoAvatar.tsx` still takes a plain
    boolean and names none of it.
  - **Universe (G-441):** report the scanned count, the excluded count, the tree the scan ran in,
    and the non-vacuity control's hit list. `fredoAvatarShell.test.tsx:151-172`'s source scan (the
    shell names no emotion id) stays green **UNMODIFIED** — it is the belt-and-suspenders half.

## R-AV-7 `[RETAINED — NARROWED by #3224]` — the size values do not move (the resolver suite legitimately does)

- [ ] R-AV-7: `vitest run …/fredoAvatarSizes.test.ts` (filter by file path) and report the executed
      count. Read `AVATAR_SM` / `AVATAR_MD` and the aspect constant.
  **Expected:** `fredoAvatarSizes.test.ts` passes **UNCHANGED** (byte-identical test file) —
      `AVATAR_SM` = 80×100, `AVATAR_MD` = 132×165, the 1014:1264 aspect constant inline and
      unchanged.
  - **#3224 NARROWING (was: "resolver + sizes pass UNCHANGED"):** `fredoAvatarResolver.test.ts` is
    **no longer** an unchanged-file row — widening the vocabulary to 20 ranked members is ST-2's
    deliberate change, and its 9-member order pin is re-cut to the 20-member subsequence form. The
    resolver's contract is owned by **`functional.md` F-AV-33** and by **R-AV-12** below (the 12's
    relative order unchanged). Do not assert "byte-identical" for the resolver suite any more.
  - **Edge:** a filtered run that executes 0 tests is a FAILED DRIVE; any size value moving is a
    capsule overrun — FAIL and report.

## R-AV-8 `[GUARD]` — console clean, no re-render loop, frame budget honoured

- [ ] R-AV-8: Read `tauri_read_logs(source="console", level="error")` in BOTH windows after every
      leg; drive 5 rapid accent changes, a 12-state sweep, and a mount/unmount loop.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded` (the pre-existing
      `motion() is deprecated` WARN is exempt); no frame-driven React state; a hidden window runs no
      RAF ticks; the mount/unmount loop leaves no extra `<canvas>` in the DOM (context disposed).
  - **Edge:** accent change with the window hidden then shown; teleport during a stream.
  - **#3224:** the sweep is now the **23-state** sweep (`functional.md` F-AV-30 leg E) — the same
    gates apply to it, and a state that adds a frame-driven React update is a FAIL.

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

---

# fredo-avatar — the 23-state vocabulary (Spec #3224)

> **Verification policy: live** (the build/static rows are named as such). Instruments are
> `functional.md`'s **Q-1** (the DEV flow lever), **Q-2** (the three mount paths), **Q-3** (the clip
> recorder). Every runtime row pairs its capture with a same-task `execute_js` read; the uploaded
> capture in the round's POSTED `## Tests Runs` is the durable record (G-415).

## R-AV-12 `[RETAINED]` — the 12 shipped states' product behaviour is unchanged

- [ ] R-AV-12: Re-run **F-AV-12**'s 12 recipes on BOTH surfaces (the recipe table at
      `functional.md:17-36`), reading `data-avatar-clip`, wrapper `data-state` and `aria-label` per
      state; then read the timings: `AVATAR_CLIP_TIME_SCALE` (only the two teleports),
      `resolveAvatarMotion`'s `talk`-without-stream rule, `HAPPY_HOLD_MS`,
      `AVATAR_ONE_SHOT_CLIPS`, and the resting cadence constants.
  **Expected:** every one of the 12 reports the SAME applied clip and `data-state` as on the
      pre-change tree; `idle` is still the only state whose applied clip is `idle`;
      `aria-label="Fredo companion -- <state>"`; every timing value unchanged.
  - **Edge:** an emotion whose new rank STEALS one of the 12's sole triggers is a FAIL of this row
    (the 12's recipes must remain reachable — G-220); the launcher seat still reports only its 4-state
    product selection when no lever is set (`LauncherShell.tsx:687-690`).
  - **Scope note:** this row is the 12's product behaviour; the 23-state matrix is F-AV-30 and the
    20-ranked order is F-AV-33.
  - **UX-22 clause (c-copy, static — bound here):** assert **zero** new authored copy naming an emotion
    or the word "emotion" anywhere a user can read it — no label, tooltip, settings row, toast or
    onboarding/empty/error sentence (`CompanionEntity.tsx:1881`'s shipped `title` names no state), and
    **zero** new focusable nodes / `[data-state='<emotion>']` CSS rules (the only wrapper state rule is
    the shipped `happy` one — an emotion rule is a FAIL, not a fix). An emotion id MAY appear in the
    wrapper's `aria-label` (a state-id echo) — that is intended, never a FAIL.

## R-AV-13 `[RETAINED]` — the Doom channel stays parallel and disjoint, and the fit does not move while engaged

- [ ] R-AV-13 **leg A (static).** Read `doomClips.ts` + `avatarClips.ts`: `DOOM_CLIPS` is still the
      six authored names; `isDoomClipName(S) === false` for ALL 23; `isAvatarClipName(doomName) ===
      false` for all 6; `AVATAR_CLIPS` has no `doom-*` property; `DOOM_CLIPS` has no state name;
      `AVATAR_ONE_SHOT_CLIPS` is still exactly `teleport-out`/`teleport-in`; `DOOM_ONE_SHOT_CLIPS`
      still exactly `doom-in`/`doom-out`.
- [ ] R-AV-13 **leg B (source order).** Confirm the Doom action map is still built AFTER the camera
      framing measurement (`avatarRenderer.ts:391-414`) — the armour poses/props never size the
      camera.
  **Expected:** disjointness both ways; the six Doom clips 1.333 s; the framing call still precedes
      the doom map.
- [ ] R-AV-13 **leg C (live, the fit holds engaged).** Engage Doom Mode (`get_doom_mode_status.phase
      === "active"`), capture `s3224-doom-framing.jpeg`, and re-read the silhouette off the same
      instrument F-AV-19 uses.
  **Expected:** the silhouette fractions still hold (`0.8284 W × 0.9233 H` ±2 %, feet `0.9763 H`) —
      the 23-member widening plus the armour poses did not move the fit; the `[data-avatar-clip]`
      while engaged is one of the six doom names and returns to a member of
      `FREDO_AVATAR_STATUS_STATES` on release.
  - **Edge:** engaging straight from an EMOTION (the release must restore a STATUS state, never a
    stranded armoured frame); `doom-mode/regression.md` R-21 carries the vocab-count half.
  - **Reddens after the change:** an emotion name added to `DOOM_CLIPS` (or vice versa), a fit that
    moves while engaged, or a `doom-*` name reachable through `AVATAR_CLIPS`.

## R-AV-14 `[RETAINED]` — no emotion reaches a shipped surface without a product reason

- [ ] R-AV-14: Cold-reload the app (**`window.__FREDO_QA_AVATAR_FLOW__` must be `undefined`** afterwards
      — verify it by value, not by presence of the module). Then: (a) with the companion OFF, sample
      the L1 seat's `data-state`/`data-avatar-clip` across ≥12 s of rest including at least one
      `playful` beat; (b) with the companion ON at the seat, drive one joke turn, one skill turn
      (`open Mission Monitor`) and one error turn (`open NotARealApp`), sampling throughout.
  **Expected:** every sampled `data-state` / `data-avatar-clip` is one of the **12 status states**
      (`FREDO_AVATAR_STATUS_STATES`); the lever global is `undefined` after the reload (no
      persistence, not reachable from a URL/query/hash — UX-23).
  - **Polarity (UX-22 — do NOT invert this row):** this row does **not** ban an emotion id from
    `aria-label`. The wrapper label is a state-id echo (`Fredo companion -- ${displayAnim}`,
    `CompanionEntity.tsx:1882`) that already yields `teleport-out` / `joking`; an emotion id there is
    the **intended** consequence of R-1b. The checkable form of the no-new-copy rule is: zero authored
    strings naming an emotion, zero new focusable nodes, zero `[data-state='<emotion>']` CSS rules
    (asserted statically in `F-AV-35`), never a token ban in the live DOM.
  - **Scope (G-466 — this row must not contradict F-AV-34):** the clause covers the shipped **FLOW
    derivation** only. A **model-declared** status may legitimately settle to an emotion (F-AV-34
    leg B) — that is the product reason this spec exists — so no turn with a model status in flight
    is part of this row, and none of the three turns above declares one (a joke/skill/error turn
    settles to `happy`/`working`/`error`).
  - **Edge:** the launcher's `desktopState` derivation passes no `modelStatus` at all
    (`LauncherShell.tsx:687-690`) — it can never reach an emotion; a soft navigation that keeps the
    module alive is NOT a reload (reload properly); an emotion persisting across a remount after the
    lever is cleared is a FAIL (state must be derived, never remembered).
