# app-icon — Functional Tests

Reusable functional suite for the **Fredo OS-level application icon** surface: the static raster
icon set shipped by `tauri.conf.json` (`bundle.icon`) plus the derived Windows set, and the
installed/release-build display of that set (taskbar, Start menu, window chrome, `.exe`, NSIS
installer). Seeded by spec **#2926** ("Fredo avatar as the installed app icon"); **revised by #2930**
("single-master revision" — #2926 shipped a two-master split where 16/24 px were a head-only mark,
and #2930 requires **one** SVG master to drive **every** artifact).

> **Verification policy: static.** The deliverable is a static raster asset set — there is no
> telemetry/span/event surface for this spec, so no `telemetry_spans` evidence is required or
> possible. AC2/AC3 still require **real reads of the extracted container frames** (per-size pixel
> reads of `icon.ico` / `icon.icns` / the PNGs, plus the built `.exe` resources) and a 1:1 composite
> render; a substantiated PASS verdict is what the static gate admits.

> **Cross-suite link:** this domain overlaps `release-pipeline` (the icon is a shipped artifact of
> the release bundle; `tauri.conf.json` is its config) and `desktop-shell` (window chrome). Every
> run of this suite MUST also run `release-pipeline/regression.md` — the icon change must not
> disturb the #2801 validate gate or `release.yml`.

Prerequisite for all cases: working tree at the `spec/2930` tip. **#2926's `spec/2926` observations
below are retained as the pre-change (BEFORE) baseline only** — a member of the single-master
revision must NOT read them as current expectations. Reference assets are Read by **explicit
absolute path** (a glob under `.opencode/**` is a FALSE NEGATIVE — dot-dirs are excluded).

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
> **Residual in-repo substantiation for the accepted legs:** R-1 PASS (all shipped artifacts are the
> regenerated avatar, none legacy) → `icons/icon.ico` is the **only** `.ico` in `bundle.icon`
> (`tauri.conf.json`) and embeds into the built `Fredo.exe` **byte-identically** (measured) → that
> resource is the sole source of the file/Start-menu/taskbar icon, and `tauri.conf.json` is
> **byte-unchanged** so the derivation wiring is identical (R-4 PASS). **The final pre-release
> visual check of the installed app (taskbar / Start menu / window chrome / installer) belongs to
> the human release manager.**

## F-1 (R-1, R-2 / AC1, AC2) — Every shipped icon is the full-bust avatar from ONE master; none is the retired art

- [ ] F-1a: **Inventory.** Enumerate the files under `apps/tauri/src-tauri/icons/`.
      **EXPECT (revised #2930):** exactly **19** top-level entries = the 17 shipped artifacts +
      **ONE** SVG master (`fredo-icon-large.svg`) + `manifest.sha256`; `fredo-icon-small.svg`
      **ABSENT**; `android/` and `ios/` absent. **PRIOR (#2926, `67c6297`, two-master baseline):**
      20 entries = 17 artifacts + the 2 masters (`fredo-icon-large.svg`, `fredo-icon-small.svg`) +
      `manifest.sha256`.
- [ ] F-1b: **Removed + regenerated, not copied.** Assert the small master is **deleted** vs `main`
      (`git diff --name-status main spec/2930 -- apps/tauri/src-tauri/icons` → `D
      …/fredo-icon-small.svg`) and that the artifacts whose frames changed (at minimum `icon.ico`,
      `icon.icns`, and the standalone PNGs that carry a 16/24 px source) differ from `main`.
      **EXPECT:** small master `D`; every artifact carrying a 16/24 px frame has a distinct blob SHA
      on both sides. **PRIOR (#2926):** all 17 artifacts were `M` with distinct both-side SHAs —
      e.g. `32x32.png` `febfa896…`→`03ede1ca…`, `icon.ico` `834168bd…`→`b3d5daa2…`; the added paths
      were `fredo-icon-large.svg` `66398576…`, `fredo-icon-small.svg` `14d07ad9…`,
      `manifest.sha256` `46bc22ee…`.
- [ ] F-1c: **Content identity (full size).** Read each regenerated icon at full size and compare
      against the canonical `.opencode/wireframes/fredo-avatar.png`. **EXPECT:** each reads as the
      Fredo avatar (cyan dome head with two vertical bar eyes, bow-tie + body on the rounded
      `#0c1117` tile); NO icon shows the retired robot. **PRIOR (#2926):** the uploaded 18-tile
      contact sheet showed the avatar on every regenerated tile; `icon.png` (512×512) = rounded
      `#0c1117` tile + cyan dome + two bar eyes + bow-tie + body.
- [ ] F-1d: **Every embedded frame of the containers — FULL BUST at every size.** Open `icon.ico`
      and `icon.icns` and inspect **each** embedded resolution. **EXPECT (revised #2930):** all
      **7 ICO frames** (16/24/32/48/64/128/256) and all **5 ICNS elements** (`icp4` 16, `icp5` 32,
      `ic07` 128, `ic08` 256, `ic09` 512) show the **full-bust** figure — head **AND** body/bow-tie
      on the opaque tile. **The 16 px and 24 px frames are full-bust**; no frame anywhere is a
      head-only mark; no frame carries the robot. **PRIOR (#2926, the DEFECT this suite now
      inverts):** 16/24 were the deliberate **head-only** small render (dome rim + two eyes, no
      body) while 32+ were the full bust — that split is exactly what #2930 removes.
- [x] F-1e: **Config paths resolve.** Assert the 5 `bundle.icon` paths are a subset of the shipped
      set and each exists on disk. **EXPECT:** 5/5 exist. **OBSERVED (#2926):** 5/5 exist with
      correct magic bytes (`89 50 4E 47` PNG ×3, `69 63 6E 73` ICNS, `00 00 01 00` ICO) — the path
      list itself is **frozen** (AC4), so this leg carries over.

## F-2 (R-2 / AC2) — Installed / release-build surfaces show the avatar

- [x] F-2a: **Build the release bundle.** EXPECT: exit 0; `target/release/Fredo.exe` and
      `target/release/bundle/nsis/Fredo_<version>_x64-setup.exe` exist. **OBSERVED (#2926 round 2):**
      `Fredo.exe` =
      **23,599,104 bytes, sha256 `2ff147415985f7edfcaf93223958fe6445194d4e8a9a784bb90aafabd9df3d1f`**;
      `Fredo_0.1.0_x64-setup.exe` = **6,247,710 bytes, sha256
      `331bd2537eef79f6cd15fdeb17231a0b15ee4af1deac17a3b9f783a034cbff6f`**. **#2930 must rebuild**
      (the icon bytes change), so the size/hash are expected to differ — only existence + a fresh PE
      extraction (F-2b) are asserted.
- [x] F-2b: **`.exe` file icon. PASS (mechanism) — accepted disposition, see the boxed note above.**
      **OBSERVED (#2926):** a bounded PE scan of `Fredo.exe` found **exactly 7 PNG payloads and all 7
      match the shipped `icon.ico` frames byte-for-byte by sha256**: 16 `ce98ed4f…`, 24 `90ea449f…`,
      32 `615fb8c2…`, 48 `6bb9585d…`, 64 `28dbe063…`, 128 `4cb8c501…`, 256 `5bafd727…`; **0**
      embedded legacy-art blobs. **#2930 re-run:** the same bounded scan must now find the 7 frames
      **byte-identical to the NEW shipped frames** (the 16/24 payloads will therefore differ from the
      #2926 values) and still **0 legacy-art blobs**.
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
      capturable; the dev run is re-verified only to the same extent as #2926 (`dev-env.ps1 -Action
      Status` → dev:tauri running, MCP :9223 OK; DOM probe → non-empty `#root`; console clean, S-2).
- [ ] F-2g: **NSIS installer icon.** `n/a — environment-limited (PO-accepted)` — the setup exe's
      frames are **not PNG payloads** (a bounded PNG-signature scan returned **0**), so the same
      in-repo extraction cannot compare them; the bundler's installer-icon sourcing is **not
      traceable in-repo** (prebuilt `@tauri-apps/cli`; `nsis/installer-hooks.nsh` carries no icon
      directive). Labeled hypothesis (DIB-stored frames vs bundler default) is explicitly **not**
      asserted as verified.

## F-3 (R-3, R-4 / AC3, AC4) — 16/32 px treatment + legibility vs the pre-change head-only control

- [x] F-3a: **Measurable — dimensions + no stretch.** **OBSERVED (#2926):** exact square canvases
      (`32x32`=32×32, `64x64`=64×64, `128x128`=128×128, `128x128@2x`=256×256, `icon`=512×512, all
      `Square*`/`StoreLogo` at their declared sizes); the opaque **TILE bbox aspect `h/w` =
      1.0000 at 16 px, 32 px and 128 px**; the real no-stretch invariant is the single uniform
      `scale(S)` in the one master, mechanically enforced by `iconSourceParity.test.ts` →
      **13/13 passed** (`vitest run …/iconSourceParity.test.ts`, `scale(sx,sy)` forbidden).
      **#2930:** same expectation against the rewritten single-master parity test — re-run and
      append the fresh count.
- [ ] F-3b: **Perceptual — 1:1 on light, dark and brand grounds. AUTHORITATIVE for the AC3 wording.**
      **EXPECT (#2930 — the human-required visual read):** the 16 px and 32 px renders composited
      1:1 **and** nearest-neighbour magnified (8×) over `#F3F3F3`, `#202020`, `#0C1117`, read
      perceptually: **16 px now reads as the full figure** — silhouette + bow-tie/body mass present,
      both eyes distinguishable, no blur; 32 px full bust. **PRIOR (#2926 — the two-master render):**
      the uploaded 2×3 matrix showed "16 px head-only (dome + 2 eyes), 32 px full bust"; the opaque
      tile carried the mark on both taskbar grounds. **#2930 must upload the new matrix; the 16 px
      row changing from head-only to full-bust is the visible acceptance.**
- [ ] F-3c: **Numeric — legibility gate vs the BEFORE control (Tier 1 absolute governs).**
      **EXPECT (#2930):**
      (1) **Body-band ink > 0** at 16, 24 and 32 px — accent-ink pixels present in the lower half of
      the 86% content box prove the full figure. The BEFORE control (head-only) scores **0** here, so
      this single number falsifies a head-only regression.
      (2) **Accent-ink coverage** (head/tile-bbox metric) at 16 px ≥ the control × 0.95 floor.
      (3) **Eye-edge WCAG contrast** (ink vs adjacent interior) ≥ 3:1 at 16 px and 32 px.
      **PRIOR (#2926):** control 16 px coverage **0.1429**, new 16 px **0.2262** (Δ +8.3 pp);
      control 32 px **0.1095**, new 32 px **0.1500** (Δ +4.1 pp); derived floor `control×0.95` =
      `0.1358`/`0.1040`; eye-edge ratio **6.796:1** at both sizes (ink `0,209,209` vs interior
      `10,55,60`); the legacy control's edge ratio was `null`. **#2930 note:** the new 16/24 px
      renders come from the large master, so the measured coverage **will change** — the gate is the
      **floor vs the re-measured control**, not the #2926 absolute values.

## F-4 (R-5 / AC4) — Config + build validity

- [x] F-4a: **Concrete config validator.** `cargo check` (via
      `pnpm exec cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml`) — this is the
      config-validity command (`tauri::generate_context!()` parses `tauri.conf.json` and embeds
      `icon.ico` at compile time). EXPECT: exit 0, **zero warnings**. **OBSERVED (#2926):**
      ``Finished `dev` profile [unoptimized + debuginfo] target(s) in 2m 09s`` — **0 warnings**.
- [x] F-4b: **Release build.** EXPECT: the bundle outputs exist. **OBSERVED (#2926):** both outputs
      present (see F-2a). **#2930 must re-build** because the icon bytes change.
- [x] F-4c: **Paths exist in the built bundle + correct format.** **OBSERVED (#2926):** 5/5 exist
      with correct magic bytes — `32x32.png` `89504e470d0a1a0a` (PNG), `128x128.png` `89504e47…`
      (PNG), `128x128@2x.png` `89504e47…` (PNG), `icon.icns` `69636e73…` (ICNS), `icon.ico`
      `0000010007001010` (ICO, 7 frames). `pnpm icons:check` → exit 0.
- [x] F-4d: **Config unchanged except the icon set.** **OBSERVED (#2926):**
      `git diff --name-status main spec/2926 -- apps/tauri/src-tauri/tauri.conf.json` → **empty**
      (byte-identical); `productName: "Fredo"`, `version: "0.1.0"`, `identifier: "com.fredo.app"`,
      `bundle.active: true`, `bundle.targets: "all"`, `bundle.windows.nsis = {installMode:
      perMachine, installerHooks: nsis/installer-hooks.nsh}` — all unchanged; `bundle.icon` keeps its
      exact **5 paths**. **#2930:** `tauri.conf.json` must again be **byte-unchanged** (`bundle.icon`
      is frozen) — the only diff under `apps/tauri/src-tauri/` is the icon bytes + manifest.

## F-5 (R-5, R-6 / AC4, AC5) — Reproducible + documented (single-source)

- [ ] F-5a: **Hash-stable regeneration.** **EXPECT (#2930):** `pnpm icons:generate` run into a
      **fresh `--out` directory** is byte-identical to the shipped bytes, and two consecutive
      generations print an identical sha256 set for every artifact; `pnpm icons:check` → exit 0
      (`icons:check OK — config, icons inventory, sizes and determinism verified`). **PRIOR
      (#2926):** both runs printed an identical sha256 set for all 17 artifacts, the post-run hash
      dump was byte-identical between runs (`b0ba83be…`), and `icons:check` exited 0 with `17
      artifacts + manifest.sha256`; only a Windows CRLF working-tree smudge on the text
      `manifest.sha256` differed (content byte-identical, `workEqHead: true`). **#2930:** the
      manifest now covers the **one** master + 17 artifacts (18 entries, not 19).
- [ ] F-5b: **Documented — single-source scheme.** **EXPECT (#2930, cite exact lines from
      `docs/app-icons.md`):** the doc states **one committed SVG master**
      (`…/fredo-icon-large.svg`) drives **every** target size including **16 px and 24 px**; the
      frozen 58-rect figure + interior fill bands in the `1014 × 1264` reference space; the opaque
      rounded `#0c1117` tile (corner radius 12.5%, transparent outside); the **86% content box**;
      the single uniform `scale(S)` (a non-uniform `scale(sx, sy)` forbidden); the 16 px disposition
      + residual; and both commands (`pnpm icons:generate`, `pnpm icons:check`). **PRIOR (#2926, the
      doc text #2930 must REPLACE):** `:26` "Two **committed SVG masters** are the raster
      generator's only inputs:" with `:30-31` mapping `fredo-icon-large.svg` → "target sizes **≥ 30
      px**" and `fredo-icon-small.svg` → "target sizes **16 px and 24 px**".
- [x] F-5c: **Platform scope documented.** **OBSERVED (#2926):** `:164` "`icons/android/**` and
      `icons/ios/**` — **deleted**. They are unreferenced by any in-repo config and mobile is not a
      shipped platform."; `:166-167` "`icon.icns` **is regenerated** for `bundle.icon` completeness
      and config validity, even though the **macOS bundle is not shipped** today." (unchanged by
      #2930).
- [ ] F-5d: **24px rule re-anchored (head-only master gone).** **EXPECT (#2930):** the doc's
      minimum-size passage states the brand guide's **24 px minimum digital size** against AC3's
      16 px requirement, and the **new** disposition: both 16 and 24 px are rendered from the
      **single full-bust master**; the residual is the reduced per-eye/body detail at 16 px (no
      second master). **PRIOR (#2926, the text #2930 must REPLACE):** `:173-177` described 16/24 px
      as "handled by the deliberate **grid-aligned head-only small master** with a derived ≥ 1-grid-
      unit presence floor".

## F-6 (NFR-5) — Dead legacy bitmaps resolved

- [x] F-6: The four bitmaps `apps/ui/src/assets/fredo-logo.png`, `fredo-logo-trimmed.png`,
      `fredo-logo-icon.png`, `fredo.png` are **removed** and grep of `apps/ui/src` for `fredo-logo`,
      `fredo-logo-trimmed`, `fredo-logo-icon`, `assets/fredo` returns zero reference sites.
      **OBSERVED (#2926):** `Test-Path` → **False** for all four; all four showed `D` vs `main`; a
      Read of `apps/ui/src/assets/` shows only `fonts/`; grep → **0 matches**. No replacement bitmap
      introduced.

## F-7 (R-7 / AC5, NFR) — Baked palette + token rule

- [ ] F-7: **Static-raster token-rule exception stands.** The baked palette
      (`#0c1117` tile / `#00D1D1` ink family) is **generator input data**, not component color
      usage; grep `apps/ui/src` for new hardcoded hex literals and for `var(--…)NN` alpha-append →
      **0 new sites**. **EXPECT:** the regenerated renders use only the baked palette (top-colour
      decomposition at 16 px = `{12,17,23}` tile, `{10,55,60}` interior, `{0,209,209}` ink — no
      foreign colours), and the opaque tile makes the mark legible on **both** a light (`#F3F3F3`)
      and a dark (`#202020`) taskbar. **PRIOR (#2926):** exactly that decomposition was measured.

_Evidence convention: pass cases keep `- [ ]` → `- [x]` + append the observed file/line/hash/
measurement; fail cases stay `- [ ]` marked `FAIL` with expected-vs-actual + repro. UNVERIFIED rows
must name the blocker (the action + the denied verb/tool). `n/a — environment-limited (PO-accepted)`
rows are a settled PO amendment from #2926 — do **not** re-drive them in an agent sandbox. The
**BEFORE control** for every #2930 leg is `git show main:apps/tauri/src-tauri/icons/<path>`
(`main` IS the two-master state) — never a `git worktree`._
