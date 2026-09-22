# app-icon — Functional Tests

Reusable functional suite for the **Fredo OS-level application icon** surface: the static raster
icon set shipped by `tauri.conf.json` (`bundle.icon`) plus the derived Windows set, and the
installed/release-build display of that set (taskbar, Start menu, window chrome, `.exe`, NSIS
installer). Seeded by spec **#2926** ("Fredo avatar as the installed app icon").

> **Verification policy: static.** The deliverable is a static raster asset set — there is no
> telemetry/span/event surface for this spec, so no `telemetry_spans` evidence is required or
> possible. AC2/AC3 still require **real screenshots of a built/installed run** plus a 1:1 composite
> render; a substantiated PASS verdict is what the static gate admits.

> **Cross-suite link:** this domain overlaps `release-pipeline` (the icon is a shipped artifact of
> the release bundle; `tauri.conf.json` is its config) and `desktop-shell` (window chrome). Every
> run of this suite MUST also run `release-pipeline/regression.md` — the icon change must not
> disturb the #2801 validate gate or `release.yml`.

Prerequisite for all cases: working tree at the `spec/2926` tip. Reference assets are Read by
**explicit absolute path** (a glob under `.opencode/**` is a FALSE NEGATIVE — dot-dirs are
excluded).

## F-1 (R-1 / AC1) — Every shipped icon regenerated from the avatar; none is the retired art

- [ ] F-1a: **Inventory.** Enumerate the 17 files under `apps/tauri/src-tauri/icons/` (list in the
      QA Plan's Required test data). EXPECT: exactly that set is present (report any addition/removal).
- [ ] F-1b: **Regenerated, not copied.** For EACH of the 17 paths assert
      `git rev-parse spec/2926:<path>` **!=** `git rev-parse main:<path>` (main tip `9beaf5a` = the
      retired blue-cyclops art). EXPECT: 17/17 differ. A file byte-identical to `main` is
      un-regenerated → FAIL.
- [ ] F-1c: **Content identity (full size).** Extract every `main:` blob to
      `.opencode/tmp/2926/e2e/baseline/`, then **Read** (absolute paths) each regenerated icon, each
      extracted baseline, and the canonical `.opencode/wireframes/fredo-avatar.png`. EXPECT: each
      regenerated icon reads as the Fredo avatar (wide hollow round-dome head, two vertical bar eyes,
      small compact body); NO icon shows the retired robot.
- [ ] F-1d: **Every embedded frame of the containers.** Open `icon.ico` and `icon.icns` and inspect
      **each** embedded resolution (not just the largest). EXPECT: every frame shows the avatar; no
      frame still carries the robot. Also check the 16px frame specifically (F-3's subject).
- [ ] F-1e: **Config paths resolve.** Assert the 5 `bundle.icon` paths in `tauri.conf.json` are a
      subset of the 17 and each exists on disk. EXPECT: 5/5 exist.

## F-2 (R-2 / AC2) — Installed / release-build surfaces show the avatar

- [ ] F-2a: **Build the release bundle.** From `apps/tauri`: `pnpm --filter @fredo/tauri build`
      (root alias `pnpm build:tauri`). EXPECT: exit 0; `target/release/Fredo.exe` and
      `target/release/bundle/nsis/Fredo_<version>_x64-setup.exe` exist (`<version>` from
      `tauri.conf.json`, currently `0.1.0`). If the release build is unreachable, record
      **UNVERIFIED-with-named-blocker (G-053)** naming the missing toolchain/bundler step — do NOT
      report PASS.
- [ ] F-2b: **`.exe` file icon.** Screenshot the built `Fredo.exe` in Explorer large-icon view into
      `.opencode/tmp/2926/e2e/`; upload via `--action upload-evidence`. EXPECT: the file icon is the
      Fredo avatar.
- [ ] F-2c: **Taskbar button.** Run the release build (or the installed app) and screenshot the
      taskbar button. EXPECT: the avatar mark.
- [ ] F-2d: **Start-menu entry.** Screenshot the Start-menu entry. EXPECT: the avatar mark.
- [ ] F-2e: **Window title-bar icon.** Screenshot the window chrome. EXPECT: the avatar mark.
- [ ] F-2f: **Dev-vs-installed parity.** Capture the dev-run (`pnpm dev:tauri`) window/taskbar icon
      too. EXPECT: same mark; a divergence is reported (the installed run remains the AC2 gate).

## F-3 (R-3 / AC3) — 16px/32px legible on both grounds; no stretch (three legs)

- [ ] F-3a: **Measurable — dimensions + no stretch.** Decode every PNG output. EXPECT exact canvases:
      `32x32.png`=32×32, `64x64.png`=64×64, `128x128.png`=128×128, `128x128@2x.png`=256×256,
      `icon.png`=its declared size, every canvas square; and the mark's opaque bbox aspect `h/w` at
      16/32px is within **±3%** of its bbox aspect at 128px (no anisotropic scale → no stretch).
- [ ] F-3b: **Perceptual — 1:1 on light and dark grounds.** Composite the 16px and 32px renders
      **1:1** over `#F3F3F3` (Win11 light taskbar), `#202020` (Win11 dark taskbar) and `#0C1117`
      (brand dark); also produce an 8× nearest-neighbour enlargement for the Read. **Read** the
      composites. EXPECT: on EVERY ground the head silhouette and BOTH eyes are distinguishable —
      not a blur; aspect preserved. This leg is authoritative for the AC3 wording.
- [ ] F-3c: **Numeric — two-tier gate.** Measure the pre-change control (legacy icon from `main` at
      the same size, in `.opencode/tmp/2926/e2e/baseline/`) FIRST, then the new render: per-ground
      silhouette coverage (opaque pixels / bbox area) and eye-edge contrast (eye-bar core luminance
      vs immediately adjacent interior) on each named ground. EXPECT: the governing tier passes —
      **Tier 1 (absolute)** derived floor `= control_coverage × 0.95` where the control clears it;
      **Tier 2 (relative)** otherwise: coverage Δ ≥ **−2.0 pp**, eye-edge contrast Δ ≥ **−0.5**.
      State which tier governs in the evidence.

## F-4 (R-4 / AC4) — Config + build validity

- [ ] F-4a: **Concrete config validator.** From `apps/tauri/src-tauri` run `cargo check` (this is
      the config-validity command: `tauri::generate_context!()` parses `tauri.conf.json` and embeds
      `icon.ico` at compile time, so a missing/malformed icon path is a hard failure). EXPECT: exit
      0, **zero warnings**.
- [ ] F-4b: **Release build.** The F-2a build completes through the bundle step. EXPECT: exit 0.
- [ ] F-4c: **Paths exist in the built bundle + correct format.** Loop the 5 `bundle.icon` paths:
      each exists AND carries the right magic bytes (`89 50 4E 47` PNG, `00 00 01 00` ICO, `icns`
      ICNS). EXPECT: 5/5 exist with the correct format. An existence-only check is insufficient.
- [ ] F-4d: **Config unchanged except the icon set.** Parse `tauri.conf.json`; assert `productName`,
      `version`, `identifier`, `bundle.active`, `bundle.targets` are byte-identical to `main`.
      EXPECT: unchanged.

## F-5 (R-5 / AC5) — Reproducible + documented

- [ ] F-5a: **Hash-stable regeneration.** Re-run the committed generator TWICE from the canonical
      source; capture SHA-256 of all 17 files after each run. EXPECT: the two hash sets are
      identical.
- [ ] F-5b: **Documented.** The exact command, the chosen canonical source (geometry render vs
      reference PNG), and the padding/background treatment are documented in-repo at the Architect's
      named path. EXPECT: all three present.
- [ ] F-5c: **Platform scope documented.** The doc lists regenerated vs scoped-out sets: Windows set
      regenerated + shipped; `icon.icns` regenerated for `bundle.icon` completeness while the macOS
      bundle is NOT shipped; android/ios scoped out. EXPECT: the distinction is explicit.
- [ ] F-5d: **24px rule addressed.** The doc explicitly addresses the brand guide's `24px minimum
      digital size` against the required 16px OS render (same mark scaled vs a simplified small-size
      variant; or an acknowledged sub-minimum deviation). EXPECT: stated — not silent.

## F-6 (NFR-5) — Dead legacy bitmaps resolved

- [ ] F-6: The four bitmaps `apps/ui/src/assets/fredo-logo.png`, `fredo-logo-trimmed.png`,
      `fredo-logo-icon.png`, `fredo.png` are **removed** (glob returns none) or **explicitly
      declared retained with a reason**; and grep of `apps/ui/src` for `fredo-logo`,
      `fredo-logo-trimmed`, `fredo-logo-icon`, `assets/fredo` returns zero reference sites.
      EXPECT: removed or declared-retained AND zero references.

_Evidence convention: pass cases keep `- [ ]` → `- [x]` + append the observed file/line/hash/
measurement; fail cases stay `- [ ]` marked `FAIL` with expected-vs-actual + repro. UNVERIFIED rows
must name the blocker (the action + the denied verb/tool)._
