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

> ### ⚠ ACCEPTED EVIDENCE DISPOSITION — F-2 OS-rendered surfaces (`n/a — environment-limited (PO-accepted)`)
>
> **Authority:** the Product Owner amendment on #2926 (`Status` — "AC2 evidence amendment
> (environment-limited surfaces)"), supported by the Software Architect's round-2 `## Fix Plan`
> (`Root cause class: scope`, no product change). Recorded here so a future `app-icon` spec does
> **not** re-burn a round on this un-drivable fixture.
>
> **The blocker is structural, not environmental-to-this-machine:** the agent sandbox exposes **no
> OS-level screen-capture lever** — `tauri_webview_screenshot` captures the **webview viewport
> only**, `tauri_manage_window action="info"` returns title/geometry but **no icon bitmap**, and an
> ad-hoc `System.Drawing`/`CopyFromScreen` capture `.ps1` is **outside the closed named-script
> allowlist** (only `dev-env.ps1` / `clean-fredo-db.ps1` / `test-scripts.ps1` /
> `wait-telemetry.ps1` / `process-hygiene.ps1` / `telemetry-query.ps1` are permitted). No technique
> change exists in **any** agent sandbox.
>
> **Dispositions (do not re-classify these as UNVERIFIED — that re-opens a settled PO amendment):**
>
> | Surface | Disposition |
> |---|---|
> | F-2b built `.exe` file icon | **PASS (mechanism)** — the PE-resource extraction of `Fredo.exe` (exactly the 7 `icon.ico` frames, sha256 byte-identical to the shipped frames, 0 legacy-art blobs) is the accepted evidence; the file icon **is** that resource, so no OS screenshot is required |
> | F-2c taskbar button | `n/a — environment-limited (PO-accepted)` — named blocker above |
> | F-2d Start-menu entry | `n/a — environment-limited (PO-accepted)` — named blocker above |
> | F-2e window title bar | `n/a — environment-limited (PO-accepted)` — named blocker above |
> | F-2f dev-vs-installed parity | `n/a — environment-limited (PO-accepted)` — dev run verified; OS chrome not capturable |
> | NSIS installer icon | `n/a — environment-limited (PO-accepted)` — the setup exe stores its icon non-PNG (PNG-signature scan → 0); the prebuilt bundler's installer-icon sourcing is **not traceable in-repo** |
>
> **Residual in-repo substantiation for the accepted legs:** R-1 PASS (all 17 artifacts are the
> regenerated avatar, none legacy) → `icons/icon.ico` is the **only** `.ico` in `bundle.icon`
> (`tauri.conf.json`) and embeds into the built `Fredo.exe` **byte-identically** (measured) → that
> resource is the sole source of the file/Start-menu/taskbar icon, and `tauri.conf.json` is
> **byte-unchanged** so the derivation wiring is identical (R-4 PASS). **The final pre-release
> visual check of the installed app (taskbar / Start menu / window chrome / installer) belongs to
> the human release manager.**

## F-1 (R-1 / AC1) — Every shipped icon regenerated from the avatar; none is the retired art

- [x] F-1a: **Inventory.** Enumerate the 17 files under `apps/tauri/src-tauri/icons/`. EXPECT:
      exactly that set is present (report any addition/removal). **OBSERVED (round 2, `67c6297`):**
      the directory holds exactly 20 top-level entries = the 17 shipped artifacts + the 2 SVG masters
      (`fredo-icon-large.svg`, `fredo-icon-small.svg`) + `manifest.sha256`; `android/` and `ios/`
      are absent.
- [x] F-1b: **Regenerated, not copied.** For EACH of the 17 paths assert
      `git rev-parse spec/2926:<path>` **!=** `git rev-parse main:<path>`. EXPECT: 17/17 differ.
      **OBSERVED:** `git diff --raw --abbrev=40 main spec/2926 -- apps/tauri/src-tauri/icons` → all
      **17 artifacts `M` with distinct blob SHAs on both sides** — e.g. `32x32.png`
      `febfa896…`→`03ede1ca…`, `64x64.png` `7737d1cc…`→`9fc47408…`, `icon.png`
      `7e4d1722…`→`1b2cb66e…`, `icon.ico` `834168bd…`→`b3d5daa2…`, `icon.icns`
      `8890cb9c…`→`1dbb7eb4…`. The 3 NEW paths are `A` (main side `0000…`):
      `fredo-icon-large.svg` `66398576…`, `fredo-icon-small.svg` `14d07ad9…`,
      `manifest.sha256` `46bc22ee…`.
- [x] F-1c: **Content identity (full size).** Read each regenerated icon, each extracted baseline,
      and the canonical `.opencode/wireframes/fredo-avatar.png`. EXPECT: each reads as the Fredo
      avatar; NO icon shows the retired robot. **OBSERVED:** the uploaded 18-tile contact sheet
      (17 regenerated artifacts + the `origin/main` legacy control on a light ground) shows the
      cyan-on-dark Fredo avatar on every regenerated tile; the final tile is the white/blue-cyclops
      legacy art, plainly different. `icon.png` (512×512, read at full size) = rounded `#0c1117`
      tile, cyan dome head with two vertical bar eyes, bow-tie + body.
- [x] F-1d: **Every embedded frame of the containers.** Open `icon.ico` and `icon.icns` and inspect
      **each** embedded resolution. EXPECT: every frame shows the avatar; the 16px frame
      specifically. **OBSERVED:** all **7 ICO frames** (16/24/32/48/64/128/256) and all **5 ICNS
      elements** (`icp4`, `icp5`, `ic07`, `ic08`, `ic09`) were extracted and read — 16/24 are the
      deliberate head-only small render (head + both eyes + opaque tile), 32+ are the full bust; no
      frame carries the robot.
- [x] F-1e: **Config paths resolve.** Assert the 5 `bundle.icon` paths are a subset of the 17 and
      each exists on disk. EXPECT: 5/5 exist. **OBSERVED:** 5/5 exist with correct magic bytes
      (`89 50 4E 47` PNG ×3, `69 63 6E 73` ICNS, `00 00 01 00` ICO).

## F-2 (R-2 / AC2) — Installed / release-build surfaces show the avatar

- [x] F-2a: **Build the release bundle.** EXPECT: exit 0; `target/release/Fredo.exe` and
      `target/release/bundle/nsis/Fredo_<version>_x64-setup.exe` exist. **OBSERVED (round 2,
      re-confirmed at the tip — not rebuilt, per the round-2 "no product change" scope):**
      `Fredo.exe` = **23,599,104 bytes, sha256 `2ff147415985f7edfcaf93223958fe6445194d4e8a9a784bb90aafabd9df3d1f`**;
      `Fredo_0.1.0_x64-setup.exe` = **6,247,710 bytes, sha256
      `331bd2537eef79f6cd15fdeb17231a0b15ee4af1deac17a3b9f783a034cbff6f`**. Both `Test-Path` → True.
- [x] F-2b: **`.exe` file icon. PASS (mechanism) — accepted disposition, see the boxed note above.**
      **OBSERVED:** a bounded PE scan of `Fredo.exe` found **exactly 7 PNG payloads and all 7 match
      the shipped `icon.ico` frames byte-for-byte by sha256**: 16 `ce98ed4f…`, 24 `90ea449f…`,
      32 `615fb8c2…`, 48 `6bb9585d…`, 64 `28dbe063…`, 128 `4cb8c501…`, 256 `5bafd727…`;
      **0** embedded legacy-art blobs (15 `origin/main` baselines compared). The uploaded 8-tile
      sheet shows those 7 extracted resources + the legacy control. Explorer's rendering of the file
      icon **is** the OS displaying that exact resource; the Explorer screenshot itself is
      `n/a — environment-limited (PO-accepted)`.
- [ ] F-2c: **Taskbar button.** `n/a — environment-limited (PO-accepted)` — named blocker: no
      OS screen-capture lever (`tauri_webview_screenshot` = viewport only; `tauri_manage_window
      action="info"` returns no icon bitmap; ad-hoc capture `.ps1` denied by the sandbox allowlist).
      Residual: the sole `.ico` in `bundle.icon` → exe resource (F-2b, measured) + R-1/R-4.
- [ ] F-2d: **Start-menu entry.** `n/a — environment-limited (PO-accepted)` — same named blocker;
      residual: the shortcut renders the exe's icon resource (F-2b) + R-1/R-4.
- [ ] F-2e: **Window title-bar icon.** `n/a — environment-limited (PO-accepted)` — same named
      blocker; residual: Tauri's framework `default_window_icon` from the compile-time-embedded
      bundle icon (0 in-repo `set_icon`/`default_window_icon` sites) + R-1.
- [ ] F-2f: **Dev-vs-installed parity.** `n/a — environment-limited (PO-accepted)` — OS chrome not
      capturable; **dev run re-verified this round**: `dev-env.ps1 -Action Status` → dev:tauri
      running (Vite :5174 OK, MCP :9223 OK) serving `spec/2926 @ 67c6297a`; DOM probe → `#root` with
      255 indexed elements; console clean (S-2).
- [ ] F-2g: **NSIS installer icon.** `n/a — environment-limited (PO-accepted)` — the setup exe's
      frames are **not PNG payloads** (a bounded PNG-signature scan returned **0**), so the same
      in-repo extraction cannot compare them; the bundler's installer-icon sourcing is **not
      traceable in-repo** (prebuilt `@tauri-apps/cli`; `nsis/installer-hooks.nsh` carries no icon
      directive). Labeled hypothesis (DIB-stored frames vs bundler default) is explicitly **not**
      asserted as verified.

## F-3 (R-3 / AC3) — 16px/32px legible on both grounds; no stretch (three legs)

- [x] F-3a: **Measurable — dimensions + no stretch.** **OBSERVED:** exact square canvases
      (`32x32`=32×32, `64x64`=64×64, `128x128`=128×128, `128x128@2x`=256×256, `icon`=512×512, all
      `Square*`/`StoreLogo` at their declared sizes); the opaque **TILE bbox aspect `h/w` =
      1.0000 at 16 px, 32 px and 128 px**; the real no-stretch invariant is the single uniform
      `scale(S)` in the large master, mechanically enforced by `iconSourceParity.test.ts` →
      **13/13 passed** (`vitest run …/iconSourceParity.test.ts`, `scale(sx,sy)` forbidden).
- [x] F-3b: **Perceptual — 1:1 on light and dark grounds. AUTHORITATIVE for the AC3 wording.**
      **OBSERVED:** 1:1 + 8× nearest-neighbour composites over `#F3F3F3`, `#202020`, `#0C1117` were
      read at full size; the uploaded 2×3 matrix (rows 16 px / 32 px; cols light / dark / brand)
      shows the head silhouette AND both eyes **crisp and distinguishable on every ground** — 16 px
      head-only (dome + 2 eyes), 32 px full bust — no blur; the opaque tile carries the mark on both
      taskbar grounds.
- [x] F-3c: **Numeric — two-tier gate.** **OBSERVED:** head-bbox accent-ink coverage, like-for-like
      vs the `origin/main` legacy control — control 16 px **0.1429**, new 16 px **0.2262**
      (Δ **+8.3 pp**); control 32 px **0.1095**, new 32 px **0.1500** (Δ **+4.1 pp**); derived floor
      `control×0.95` = `0.1358`/`0.1040`. **Tier 1 (absolute) governs** (the control clears the
      derived floor and the new render exceeds it); Tier 2 tolerance (Δ ≥ −2.0 pp) is also cleared.
      Eye-edge contrast (8× read, ink `0,209,209` vs adjacent interior `10,55,60`) = **WCAG
      ratio 6.796:1** at both 16 px and 32 px (≥ 3:1 floor). The legacy control is a solid head with
      no adjacent interior, so its edge ratio is `null`/undefined.

## F-4 (R-4 / AC4) — Config + build validity

- [x] F-4a: **Concrete config validator.** `cargo check` (via
      `pnpm exec cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml`) — this is the
      config-validity command (`tauri::generate_context!()` parses `tauri.conf.json` and embeds
      `icon.ico` at compile time). EXPECT: exit 0, **zero warnings**. **OBSERVED:**
      ``Finished `dev` profile [unoptimized + debuginfo] target(s) in 2m 09s`` — **0 warnings**.
- [x] F-4b: **Release build.** **OBSERVED:** the bundle outputs exist and were re-confirmed
      (F-2a); the round-2 scope prescribes no product change, so no rebuild was performed.
- [x] F-4c: **Paths exist in the built bundle + correct format.** **OBSERVED:** 5/5 exist with
      correct magic bytes — `32x32.png` `89504e470d0a1a0a` (PNG), `128x128.png` `89504e47…` (PNG),
      `128x128@2x.png` `89504e47…` (PNG), `icon.icns` `69636e73…` (ICNS), `icon.ico`
      `0000010007001010` (ICO, 7 frames). `pnpm icons:check` → exit 0.
- [x] F-4d: **Config unchanged except the icon set.** **OBSERVED:** `git diff --name-status main
      spec/2926 -- apps/tauri/src-tauri/tauri.conf.json` → **empty** (byte-identical);
      `productName: "Fredo"`, `version: "0.1.0"`, `identifier: "com.fredo.app"`, `bundle.active:
      true`, `bundle.targets: "all"`, `bundle.windows.nsis = {installMode: perMachine,
      installerHooks: nsis/installer-hooks.nsh}` — all unchanged; `bundle.icon` keeps its exact
      5 paths.

## F-5 (R-5 / AC5) — Reproducible + documented

- [x] F-5a: **Hash-stable regeneration.** **OBSERVED:** `pnpm icons:generate` run **twice** from
      the canonical masters — both runs printed an **identical sha256 set** for all 17 artifacts
      (e.g. `icon.png` `0ba0c1f6…`, `32x32.png` `615fb8c2…`, `icon.ico` `555c7cab…`,
      `icon.icns` `9eb7dc09…`), and the post-run hash dump is byte-identical between runs (combined
      `b0ba83be…`); all 17 icon files remain byte-unchanged vs the committed blobs. `pnpm icons:check`
      → `icons:check OK — config, icons inventory, sizes and determinism verified` /
      `17 artifacts + manifest.sha256`, **exit 0** (its determinism leg regenerates into a temp dir
      and byte-compares). Only a Windows CRLF working-tree smudge on the text `manifest.sha256`
      differs — its content is byte-identical to the committed blob (1401 bytes, 0 CRLF, LF sha256
      `d1164193…`; `workEqHead: true`).
- [x] F-5b: **Documented.** **OBSERVED (G-178, exact lines from `docs/app-icons.md`):** `:15` "The
      icon is derived from the **canonical SVG geometry**"; `:18-21` the frozen 58-rect figure +
      interior fill bands in the `1014 × 1264` reference space; `:26` "Two **committed SVG masters**
      are the raster generator's only inputs:"; `:30-31` "`…/fredo-icon-large.svg` | target sizes
      **≥ 30 px**" / "`fredo-icon-small.svg` | target sizes **16 px and 24 px**"; `:58-60` "a
      full-bleed, opaque, rounded **`#0c1117`** tile … **corner radius = 12.5% of the canvas** …
      Corners outside the radius are transparent."; `:61-62` "the figure sits inside an **86%
      content box**"; `:63-65` "**one** uniform `scale(S)` about its bbox. A non-uniform
      `scale(sx, sy)` is forbidden"; `:110-113` "`pnpm icons:generate     # -> node
      scripts/generate-app-icons.mjs`" / "`pnpm icons:check        # -> node
      scripts/check-app-icons.mjs`".
- [x] F-5c: **Platform scope documented.** **OBSERVED:** `:164` "`icons/android/**` and
      `icons/ios/**` — **deleted**. They are unreferenced by any in-repo config and mobile is not a
      shipped platform."; `:166-167` "`icon.icns` **is regenerated** for `bundle.icon` completeness
      and config validity, even though the **macOS bundle is not shipped** today."
- [x] F-5d: **24px rule addressed.** **OBSERVED:** `:173-177` "The brand guide sets a **24 px
      minimum digital size**, while AC3 requires a **16 px** render … an acknowledged, documented
      deviation: 16 / 24 px are handled by the deliberate **grid-aligned head-only small master**
      with a derived **≥ 1-grid-unit presence floor**".

## F-6 (NFR-5) — Dead legacy bitmaps resolved

- [x] F-6: The four bitmaps `apps/ui/src/assets/fredo-logo.png`, `fredo-logo-trimmed.png`,
      `fredo-logo-icon.png`, `fredo.png` are **removed** and grep of `apps/ui/src` for `fredo-logo`,
      `fredo-logo-trimmed`, `fredo-logo-icon`, `assets/fredo` returns zero reference sites.
      **OBSERVED:** `Test-Path` → **False** for all four; `git diff --name-status main spec/2926 --
      apps/ui/src/assets` shows all four as `D`; a Read of `apps/ui/src/assets/` shows only
      `fonts/`; grep of `apps/ui/src` for the four basenames / the `assets/fredo` prefix → **0
      matches**. No replacement bitmap was introduced.

_Evidence convention: pass cases keep `- [ ]` → `- [x]` + append the observed file/line/hash/
measurement; fail cases stay `- [ ]` marked `FAIL` with expected-vs-actual + repro. UNVERIFIED rows
must name the blocker (the action + the denied verb/tool). `n/a — environment-limited (PO-accepted)`
rows are a settled PO amendment — do **not** re-drive them in an agent sandbox._
