# Settings — Exploratory

> Unscripted edge/failure probes for the shared Settings dialog shell (`ProfileSettingsModal`).
> Seeded at Issue #2864. The Tester adds findings here; a confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note).

## Prompt lines

- [ ] E-1: **Theme switch with the modal open + a section mid-edit.** Switch dark↔light and change
      the accent while a setting is focused/half-edited. Does the chrome re-tint with no stale
      color, and is the in-progress edit preserved? Any stale color, lost edit, or console error
      is a finding (promotes to F-6/F-9).
- [ ] E-2: **Sidebar overflow/nav-count extremes.** With the fewest and the most nav items
      (feature settings registered), is the scrollbar thumb visible and legible on both themes,
      and does the nav group label render? Any invisible thumb / clipped nav / layout collapse is
      a finding (promotes to F-6/F-9).
- [ ] E-3: **Rapid section churn.** Click through every nav section rapidly (Companion →
      Appearance → Fredo Setup → Telemetry → feature). Any flash of stale chrome, crash, orphan
      content, or `Maximum update depth exceeded` is a finding (promotes to R-3/R-6).
- [ ] E-4: **Narrow window / small viewport.** Shrink the window while the dialog is open (fixed
      960px width). Does the dialog clip or overflow, and does the sidebar/content stay usable in
      both themes? Any clipped control or unreadable chrome is a finding (promotes to F-9).
- [ ] E-5: **Dock position + theme interplay (Appearance).** Change the Dock position and switch
      theme/accent; does the Appearance content remain token-native and unshifted? Any regression
      is a finding (promotes to F-10; cross-ref app-dock).

### #2864 testing round 1 (spec/2864 @ f2c8923) — findings

- **E-1 FINDING — regression-free.** Theme/accent switch with Settings open re-tints the chrome with no stale color; an out-of-range draft (`9999`, `aria-invalid=true`, red border/help) preserved its text across a theme change and healed to `3600` on commit (live region `Auto-return set to 3600 s`).
- **E-2 FINDING — regression-free.** Sidebar nav + `FEATURES` group render; the `--scrollbar-thumb` derived thumb is visible in both themes (after set + `scrollbar-{dark,light}.png`).
- **E-3 FINDING — regression-free.** Rapid section churn (Companion → Appearance → Fredo Setup → Telemetry → Run CLI) rendered each section with no stale chrome, crash, or `Maximum update depth exceeded`. NOTE: the Telemetry section wedges the MCP bridge for `html2canvas` full-viewport screenshots (tooling; a `maxWidth 900` capture succeeds) — environment, not product.
- **E-4 NOT DRIVEN.** Narrow-window clipping sub-case not exercised (dialog geometry is fixed 960×620; no window resize driven).
- **E-5 FINDING — regression-free.** Dock position + theme/accent interplay leaves the Appearance content token-native and unshifted.

## #2865 extension — wizard-in-dialog probes

> Unscripted visual/a11y probes for the #2865 wizard audit inside the shared dialog. A confirmed
> finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

- [ ] **E-6 — Wizard content width with long paths.** With the wizard open and a long resolved
      path/filename, does the content stay within the dialog content pane (no horizontal scroll /
      clipping / Retry pushed off-card) at 960×620 and narrower? Any overflow is a finding
      (promotes to F-16).

- [ ] **E-7 — Wizard-vs-sibling drift.** Flip between the Companion wizard and Fredo Setup several
      times; do heading scale, card padding/radii, control heights, and body text match (no
      visible jump/drift)? Any divergence is a finding (promotes to F-16; H4/H5).

- [ ] **E-8 — Semantic-token resolution inside the dialog.** Read `getComputedStyle` for
      `--chakra-colors-fg-muted`/`-fg-subtle`/`-fg-default`/`-bg-hover`/`-fg-onAccent`/
      `-accent-solid` vs `--text-secondary`/`--text-subtle`/`--hover-bg`/`--accent-contrast`. Any
      token still stock/empty is a finding (promotes to F-16; the R3 root cause).

- [ ] **E-9 — Theme/accent switch mid-wizard-work.** Switch dark↔light and change the accent while a
      step is running/downloading and while an error is shown; does the wizard re-tint with no
      stale color and stay legible? Any stale color is a finding (promotes to F-16/F-18).

---

## #2868 extension — Settings-as-app-window probes

> Unscripted edge/failure probes for the retired-modal → feature-window container swap. A confirmed
> finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note). Live policy.

- [ ] **E-10 — Window close/reopen with a dirty section.** Half-edit a setting that registers a Save
      fn (e.g. Run CLI) and/or the companion idle-timeout draft, then close the Settings window
      without saving and reopen it. Is the in-progress edit lost cleanly (no stale/ghost value), and
      does `SettingsSaveProvider` reset so a stale `saveFn` cannot fire? Any phantom save, stale
      content, or console error is a finding (promotes to F-31/F-32).

- [ ] **E-11 — Theme/accent switch with the Settings window open + section mid-edit.** Switch
      dark↔light and set a non-default accent while a section is focused/half-edited. Does the
      window chrome re-tint with no stale color, and is the edit preserved? Any stale color, lost
      edit, or `Maximum update depth exceeded` is a finding (promotes to F-40).

- [ ] **E-12 — Rapid launcher re-invoke.** Click the Settings tile several times in quick
      succession (Ctrl+Space between tries) and via keyboard Enter. Does `useWindows()` ever gain a
      second "Settings" entry / duplicate frame, or does the first window flicker/lose content? Any
      duplicate or focus steal is a finding (promotes to F-27/F-28).

- [ ] **E-13 — Companion gate flips across the window open/close.** Open Settings → Companion while
      not ready, close the window, make the backend ready, reopen Settings → Companion. Does the
      section swap to the controls in place with no orphan/reload, and does re-opening mid-swap
      leave a consistent state? Any stuck wizard/orphan is a finding (promotes to F-35/F-36).

- [ ] **E-14 — Zero/again-discovered feature sections.** What happens if a feature's settings
      section errors while rendering, or if the discovered list is empty/only one? Does the window
      degrade gracefully (no crash/blank pane/empty "Features" header)? Any orphan grouping or
      unhandled error is a finding (promotes to F-33/F-34).

- [ ] **E-15 — Minimize to the app dock and restore from a different z-position.** Minimize Settings
      behind two other windows, then restore it from the dock; does it return focused at the top
      with its content intact and its single window id? Any stale frame/duplicate/geometry reset is
      a finding (promotes to F-23/F-26).

### #2868 testing round 1 (spec/2868 @ 90da8de) — findings

- **E-10 FINDING — regression-free.** Closing/reopening the Settings window remounts `SettingsSurface` (fresh `activeSection='companion'`) and `SettingsSaveProvider` resets; no phantom save, no stale value.
- **E-11 FINDING — regression-free.** Theme/accent switch with the window open re-tints the chrome token-native (header/active-nav/`--hover-bg`); no stale color, no re-render error.
- **E-12 FINDING — regression-free.** Rapid launcher re-invoke + keyboard activation never produced a second Settings window (`settingsWindows` held at 1); the launcher collapses.
- **E-13 FINDING — regression-free.** Companion gate flipped wizard → controls in place; reopening re-rendered consistently (controls when ready).
- **E-14 NOT DRIVEN (live).** Zero-discovered-section live state is structurally unreachable (G-138); covered by the owned component test `SettingsSurface.zeroSections.test.tsx` (2/2).
- **E-15 FINDING — regression-free.** Minimize keeps the single dock entry `Settings (minimized)`; restore re-raises the same window with content intact.
- **E-16 (ENV) — Telemetry section wedges the MCP bridge.** Selecting Settings → Telemetry caused a
  `tauri_webview_execute_js` + `read_logs` timeout (already known from #2864 E-3: Telemetry's
  full-viewport capture wedges html2canvas/the bridge). Recovered by driver-session stop/start (G-067);
  no product error in the console. Environment/tooling, not a Settings-as-app defect.

---

## #2892 extension — send-during-reply settings edge probes

> Unscripted probes for the two new persisted settings. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> named blocker (G-053) with a static/unit pin — never fabricated. Cross-ref `companion`
> E-58..E-63 + `launcher` E-62..E-66.

- [ ] E-17: **Setting changed while a reply is in flight.** Open Settings -> Companion mid-stream and
      flip the disposition. Does the change persist immediately (no Save dependency) and govern the
      NEXT send, with no stale in-flight behavior change or console error? Any lost edit or
      mid-stream crash is a finding (promotes to F-41/F-43).
- [ ] E-18: **Adversarial stored values.** Seed `Fredo_companion_send_during_reply` = `garbage`
      and `Fredo_companion_reply_leave_grace_ms` = `abc` / `-99999` / empty in localStorage AND the
      AppStore, then launch. Does the panel heal to `queue` / `2000` (or clamp) without a crash,
      and are the seeded keys left inert rather than deleted? Any crash/wedge/re-written garbage is a
      finding (promotes to F-41/F-42).
- [ ] E-19: **Settings window closed mid-edit.** Half-type a grace value, close the Settings window
      without committing, reopen. Is the draft discarded cleanly with the persisted value intact (no
      phantom save, no stale draft)? Any phantom persistence or resurrected draft is a finding
      (promotes to F-42/R-19).
- [ ] E-20: **Theme/accent change with the two controls focused.** Focus the disposition select and
      the grace input in turn, then switch dark↔light + a non-default accent. Do both re-tint
      token-native with no lost draft, stale border, or invisible native `<option>` list? Any stale
      color / unthemed dropdown is a finding (promotes to F-45; NativeSelect fallback check).

### #2892 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_
