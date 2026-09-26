# workspace-layout — Exploratory Probes

Unscripted edge/failure probes for the customizable workspace (issue #2949). A CONFIRMED finding PROMOTES to `functional.md` as a new `F-` case (keep the origin note). Drive via `pnpm dev:tauri`; confirm the target pane/window via DOM before each capture; read the webview console after every probe. Live policy: include the `telemetry_spans` reference with the round evidence.

## Probes to run beyond the script

- [ ] E-1 (OPEN — save/restore round-trip fidelity at scale): Build 4+ panes across several regions and a corner, save as a named layout, scramble the arrangement, restore. Do all regions/rects (incl. corner slots) round-trip exactly, or does any pane snap/default/reset? A mismatch is a finding (promotes to F-6/F-7).
- [ ] E-2 (OPEN — restore a layout whose app was closed mid-session): Save `twopane`, close Mission Monitor, then restore. Is the missing slot handled per R9 (empty slot, siblings intact) or does the whole restore fail/throw? Confirm console clean. A throw or sibling-shift is a finding (promotes to F-9).
- [ ] E-3 (OPEN — delete the active/default layout): With a named layout active, delete it (and/or delete the persisted default). Does the workspace degrade to the ad-hoc arrangement (`activeLayoutId:null`) without crash, and does the next restart stay clean? A crash or a resurrected layout is a finding.
- [ ] E-4 (OPEN — divider at extremes + 3-pane axis): Drag a divider fully against one pane, then the second divider in a 3-pane row. Does the min clamp hold (≥320×200), do the other panes stay stable, and does the combined extent stay constant? Any overlap/negative size/collapse is a finding (promotes to F-4/F-6).
- [ ] E-5 (OPEN — rapid divider drag + save during gesture): Drag a divider rapidly back and forth, then trigger a save/restore before the gesture ends. Does persistence stay suppressed during the gesture (R5) and is the final arrangement consistent? A write-during-gesture or a lost final rect is a finding.
- [ ] E-6 (OPEN — restart during an active gesture / app kill): Kill the app mid-drag (no graceful close), relaunch. Does boot hydrate the last PERSISTED arrangement without throwing, and is the dragging flag never persisted? A blank/partial workspace or a stale `dragging:true` in storage is a finding (promotes to F-14/F-8).
- [ ] E-7 (OPEN — theme/accent flip mid-gesture): Start a divider drag, flip Classic↔Turbo (or the user accent) mid-drag, release. Do the panes/dividers re-tint without a layout jump, and does the gesture complete? Any stale color or geometry reset is a finding (promotes to F-11).
- [ ] E-8 (OPEN — maximize/restore under tiling): Maximize a pane, save a layout while maximized, restore, then restart. Does the arrangement stay uncorrupted (R13) and does the maximized window not get serialized as a pane rect? A corrupted saved arrangement is a finding (promotes to F-13).
- [ ] E-9 (OPEN — many panes / narrow viewport): Open as many distinct features as the catalog allows and tile them; repeat in a narrow viewport. Do all panes remain reachable (no off-workspace pane, no zero-size pane), does the summary save/restore still work, and is the payload ≤ 16 KB? A clipped/unreachable pane is a finding.
- [ ] E-10 (OPEN — corrupt/unknown persisted value): Pre-seed `Fredo_workspace_layout` with malformed JSON, an unknown `version`, and an unknown `windowId`. Reload each. Does the app boot to a clean desktop (or graceful partial) with console clean? A throw on mount is a finding (promotes to F-8).
- [ ] E-11 (OPEN — HTML5 drag-and-drop failure mode): Attempt a region drop outside any drop target, and drop onto an already-occupied region. Does the source pane stay in a sane place (snap-back/no-op), and does the drop-target highlight clear? A lost/duplicated pane is a finding (promotes to F-3).
- [ ] E-12 (OPEN — accessibility tree of panes/dividers): Snapshot the a11y tree with a tiled arrangement. Are panes exposed as reachable regions/groups, is the divider a labeled `role="separator"` with `aria-orientation`, and are region drop targets labeled? A missing/unlabeled control is a finding (promotes to F-18).
- [ ] E-13 (OPEN — multi-window features under tiling): Open the Run CLI terminal (a separate OS window, `run-cli-terminal`) while a tiled arrangement is active on main. Is the separate window unaffected, and does the main arrangement stay stable? Cross-surface corruption is a finding (scope note #2947).
- [ ] E-14 (OPEN — reduced motion): With `prefers-reduced-motion: reduce`, do pane drop/reflow/divider transitions stay subtle (no distracting animation)? A jarring animation is a finding.

## Promoted findings

> Record promotions here as `- E-n → F-m (reason)`.

- E-11 → F-21 (round 1: committing a move to `pane-region-bottom-right`/`right` did not change `data-pane-region` — `movePane` reflows by slot order when the target region overlaps; no move announcement).
- AC1 entry-path probe → F-22 (round 1: no arrange control exists at 0 tiled panes; `workspace-arrange` is gated on an existing slot and `dock-arrange` is absent).
- E-6/F-15 → F-23 (round 1: full restart hydrates only the slots — apps are not reopened and render as `App not available`; re-opened apps arrive full-bleed/maximized).
