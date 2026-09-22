# app-icon — Exploratory Tests

Unscripted edge/failure probes for the OS-icon surface. Add findings on the fly; a confirmed probe
**promotes** to `functional.md` as a new `F-` row (keep the origin note). Verification policy is
**static** — probes are asset/config/build reads plus built-artifact reads, not telemetry queries.

> **#2930 revision banner.** #2926 shipped a **two-master** set (16/24 px = head-only small master).
> #2930 requires **one** master for every artifact, so any #2926 observation whose expectation
> depended on the small master is retained below only as the **BEFORE baseline** and must be
> **re-run** (rows reset to `- [ ]`). The `#2926` OBSERVED strings are the prior record, not current
> expectations. **BEFORE lever:** `git show main:apps/tauri/src-tauri/icons/<path>` (main IS the
> two-master state) — never a `git worktree`.

> ### ⚠ E-6 is a settled PO amendment — do NOT re-drive it
> `E-6 Explorer icon-cache staleness` requires driving Windows Explorer / the taskbar, which the
> agent sandbox cannot do (no OS screen-capture lever; see the disposition box in `functional.md`).
> The Product Owner amendment on #2926 records it as `n/a — environment-limited (PO-accepted)`.
> **A future `app-icon` spec must not re-burn a round on this fixture** — the cache-staleness check
> belongs to the human release manager's pre-release visual pass.

## Prompts (seed probes)

- [ ] E-1: **Multi-resolution container truth (single-master re-run).** Extract every frame of
      `icon.ico` and every size inside `icon.icns` and compare each against the corresponding
      standalone PNG. Does any frame disagree in shape/scale? **EXPECT (#2930):** every shared
      resolution is the **same bytes** as its standalone sibling; **and additionally the 16/24 px
      frames are now full-bust** (they will therefore NO LONGER match their #2926 values — a 16 px
      frame that still equals the old head-only bytes is a FAIL). **PRIOR (#2926, two-master):**
      `ico-032` == `32x32.png` (`615fb8c2…`), `ico-064` == `64x64.png` (`28dbe063…`), `ico-128` ==
      `128x128.png` (`4cb8c501…`), `ico-256` == `128x128@2x.png` (`5bafd727…`); ICNS `icp5` ==
      `32x32.png`, `ic07` == `128x128.png`, `ic08` == `128x128@2x.png`, `ic09` == `icon.png`
      (`0ba0c1f6…`). The 16/24 px frames were the head-only render.
- [ ] E-2: **Mask / circular-crop survival (single-master re-run).** Simulate the Windows taskbar
      and Start-menu crops (circular mask radius = ½ canvas; rounded-square mask at the tile's 12.5%
      radius) over the 16/32/48 px renders. **EXPECT (#2930):** **clip fraction = 0.0000** on both
      masks at all three sizes (the mark sits inside the 86% content box) **and the 16 px ink count
      now exceeds the head-only baseline** (the body/bow-tie is extra ink inside the safe area).
      **PRIOR (#2926):** clip fraction 0.0000 at all three sizes; 16 px: 38 ink px; 32 px: 84; 48 px:
      242.
- [ ] E-3: **Background treatment on both grounds (single-master re-run).** **EXPECT (#2930):** on
      the composites over `#F3F3F3`, `#202020` and `#0C1117` the mark renders; the opaque `#0c1117`
      tile supplies its own ground, so the cyan mark reads on a light AND a dark taskbar; top-colour
      decomposition at 16 px uses the baked palette only; no vanish on either named ground. **PRIOR
      (#2926):** 16 px decomposition = `{12,17,23}` tile 122 px, `{10,55,60}` interior 92 px,
      `{0,209,209}` ink 38 px; those **counts will change** with the full bust.
- [ ] E-4: **Aspect / stretch audit.** **EXPECT (#2930):** the figure is uniformly scaled and
      centred — the no-stretch invariant is carried by the single uniform `scale(S)` in the one
      master (parity guard). **PRIOR (#2926):** ink-bbox aspect `h/w` = 1.375 (128 px) vs 1.4 (32 px)
      and 1.3924 (256/512 px), all within the ±3% band; large master carried exactly one uniform
      `scale(S)` (13/13).
- [ ] E-5: **Stale-art resurfacing + head-only regression.** **EXPECT (#2930):** no shipped artifact
      matches a `main` blob for a size whose source changed; **0** embedded legacy-art blobs in the
      built `Fredo.exe`; **0 frames are head-only** (the specific regression this revision guards);
      and a perceptual check against a naive downscale of the retired art gives a large mean absolute
      RGB difference (plainly a different mark, not a rescaled legacy one). **PRIOR (#2926):** all 17
      artifacts differed byte-wise from `main`; 0 legacy blobs; mean absolute RGB difference **62.6**
      (16 px) / **59.8** (32 px).
- [ ] E-6: **Explorer icon-cache staleness.** `n/a — environment-limited (PO-accepted)` — named
      blocker: driving Explorer/the taskbar and running `ie4uinit.exe -show` requires OS interaction
      the sandbox forbids (no OS screen-capture lever; arbitrary `.ps1` is outside the closed
      named-script allowlist). Residual: the built `Fredo.exe` embeds the regenerated `icon.ico`
      frames byte-for-byte (F-2b), so any Explorer cache would serve the new resource after a normal
      refresh.
- [ ] E-7: **Generator determinism across environments.** **EXPECT (#2930):** two consecutive
      `pnpm icons:generate` runs (and one into a **fresh `--out`**) produce an identical sha256 set
      for every artifact, and `pnpm icons:check`'s determinism leg byte-compares an alternate `--out`
      — exit 0. No path-dependent or cache-dependent encode. **PRIOR (#2926):** held with the
      17-artifact set.
- [ ] E-8: **Doc ↔ artifact drift (single-source scheme).** **EXPECT (#2930):** every claim in
      `docs/app-icons.md` checks against the shipped bytes — the documented source is **ONE** master
      (`…/fredo-icon-large.svg`) driving every size incl. 16/24; the documented treatment (opaque
      `#0c1117` tile, 12.5% corner radius, 86% content box, one uniform `scale(S)`) matches the
      shipped alpha/geometry; the documented ICO frame set (16/24/32/48/64/128/256) matches the
      packed container; the documented 16 px disposition matches the recorded residual; the
      commands exist verbatim; and there is **no stale "two masters" table**. **PRIOR (#2926):** the
      doc asserted two masters and mapped the small one to 16/24 px — exactly the drift #2930
      removes.
- [ ] E-9: **`.icns` validity without macOS.** **EXPECT (#2930):** `icon.icns` is a structurally
      valid ICNS container — header magic `69636e73` (`icns`) + a TOC listing 5 PNG-typed elements
      (`icp4` 16, `icp5` 32, `ic07` 128, `ic08` 256, `ic09` 512) — and `icp4` (16) is **full-bust**.
      **PRIOR (#2926):** container was structurally valid; `icp4` was the head-only render.
- [ ] E-10: **Unreferenced Windows logo assets.** **OBSERVED (#2926):** `Square*Logo.png` /
      `StoreLogo.png` are regenerated (AC1) but referenced by **no in-repo config** — a repo grep for
      `StoreLogo|Square150x150Logo|bundle\.icon` returns only the generator manifest
      (`scripts/generate-app-icons.mjs`), the verifier (`scripts/check-app-icons.mjs`), the docs, and
      this suite; `tauri.conf.json` names only the 5 `bundle.icon` paths. Scope question for the PO
      (MSIX/Store assets, unused by the NSIS bundle), not a defect. **#2930:** unchanged — but their
      16/24-bearing siblings must still be full-bust (they are PNG artifacts under R1).

_Confirmed probes promote to `functional.md`; UNVERIFIED/tooling-limited probes carry a named blocker
(G-053). `n/a — environment-limited (PO-accepted)` probes are a settled amendment from #2926 — do not
re-drive them in an agent sandbox._
