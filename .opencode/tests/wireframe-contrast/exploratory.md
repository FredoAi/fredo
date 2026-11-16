# Wireframe Contrast — Exploratory

> Unscripted probes for the Wireframe-contrast domain. A confirmed finding **promotes** to
> `functional.md` as a new `F-` row (keep the origin note). Nothing here is an AC on its own.

## Probe prompts

- [ ] **E-1:** Force every interactive state the page-settings controls can reach — `:hover`,
      `:active` (pressed), `:focus-visible`, `disabled` — on each segmented item and each slider
      part, and recompute the ratio in EACH state. Does any state drop below its floor that the
      resting state cleared? (The names block marks `*exempt` rows for the inactive-component
      WCAG exemption — confirm a `disabled` state is genuinely exempt and not merely below floor.)
- [ ] **E-2:** Switch rapidly through ALL 19 shipped presets while the page-settings panel is
      open and recompute each anchor on each preset. Does any preset (especially the short /
      solarized / highest-contrast presets) fall below a floor on a pair the gate reports green?
      A gate-vs-rendered divergence is the G-366 signature — record the preset, anchor, computed
      values and recomputed ratio.
- [ ] **E-3:** Open the `Discard unsaved changes?` dialog over the canvas with a document loaded;
      recompute the `status-solid|default|label` pair live. Does the `overlay.scrim` backdrop or
      the dialog's compositing shift the effective ratio?
- [ ] **E-4:** Force the file-error banner (`FREDO_WIREFRAME_FAIL_FILE=1`) and recompute
      `banner|default|label` / `|icon` / `|border` live; then trigger it over a dark theme. The
      banner is a composed pair (`status.error` on `tint(status.error,10)` over canvas) — does
      the composed background match the gate's `composite(statusError, bodyBg, 0.10)` model?
- [ ] **E-5:** The Konva canvas chrome resolves at paint time; read the CSS vars from
      `document.documentElement` and compare them to the values the gate resolves for the same
      preset. Does a canvas pair diverge from its DOM-anchored counterpart?
- [ ] **E-6:** A shape whose fill equals the page background — is the border still visible at or
      above the border floor? Does a `tint()`-derived translucent surface stay above floor?
- [ ] **E-7:** Zoom the canvas (Fit / 400 % / 10 %) and recompute the page-settings anchors — does
      zoom change any rendered colour (it should not)?
- [ ] **E-8:** Set the page dimensions so the segment control shows the derived `Custom` state
      (NO chip selected) and recompute every segment anchor in that state — is the unselected
      segment label still above floor with no indicator painted?
- [ ] **E-9:** Toggle the app's focus context (focus another window) and recompute the toolbar
      anchors — does the unfocused toolbar change any colour?
- [ ] **E-10:** In the webview console, run the gate's `buildContrastMatrix()` and compare EVERY
      page-settings rendered ratio to its gate row; list any pair whose |Δ| > 0.05.

## Known risk areas to probe hardest

- `control-ghost|pressed|label` (accent text on an 18 % accent tint over surface — the Architect's
  highest-risk row).
- `slider|default|track` / `segmented|default|track` (`bg.muted` on `bg.surface` — close in
  luminance on light presets).
- The dark theme's darkest preset (the whole surface family shifts at once).
