# app-icon — Exploratory Tests

Unscripted edge/failure probes for the OS-icon surface. Add findings on the fly; a confirmed probe
**promotes** to `functional.md` as a new `F-` row (keep the origin note). Verification policy is
**static** — probes are asset/config/build reads plus built-artifact screenshots, not telemetry
queries.

> ### ⚠ E-6 is a settled PO amendment — do NOT re-drive it
> `E-6 Explorer icon-cache staleness` requires driving Windows Explorer / the taskbar, which the
> agent sandbox cannot do (no OS screen-capture lever; see the disposition box in `functional.md`).
> The Product Owner amendment on #2926 records it as `n/a — environment-limited (PO-accepted)`.
> **A future `app-icon` spec must not re-burn a round on this fixture** — the cache-staleness check
> belongs to the human release manager's pre-release visual pass.

## Prompts (seed probes)

- [x] E-1: **Multi-resolution container truth.** Extract every frame of `icon.ico` (and every size
      inside `icon.icns`) and compare each against the corresponding standalone PNG. Does any frame
      disagree in shape/scale? **OBSERVED (round 2, `67c6297`):** every shared resolution is the
      **same bytes** as its standalone sibling — `ico-032` == `32x32.png` (`615fb8c2…`), `ico-064`
      == `64x64.png` (`28dbe063…`), `ico-128` == `128x128.png` (`4cb8c501…`), `ico-256` ==
      `128x128@2x.png` (`5bafd727…`); ICNS `icp5` == `32x32.png`, `ic07` == `128x128.png`, `ic08` ==
      `128x128@2x.png`, `ic09` == `icon.png` (`0ba0c1f6…`). No stale frame at any size.
- [x] E-2: **Mask / circular-crop survival.** Simulate the Windows taskbar and Start-menu crops
      (circular mask, rounded-square mask) over the 32px and 48px renders. **OBSERVED:** measured
      the ink (mark) pixel set of the 16/32/48 renders against (a) a centered circular mask of
      radius = ½ canvas and (b) a rounded-square mask with the tile's own 12.5% radius —
      **clip fraction = 0.0000 on both masks at all three sizes** (16 px: 38 ink px; 32 px: 84;
      48 px: 242). The mark sits inside the safe area (the 86% content box); nothing is clipped.
- [x] E-3: **Background treatment on both grounds.** **OBSERVED:** the F-3 composites over
      `#F3F3F3`, `#202020` and `#0C1117` all render the mark; the opaque `#0c1117` tile supplies its
      own ground, so the cyan mark reads on a light AND a dark taskbar. Top-colour decomposition of
      the 16 px render = `{12,17,23}` tile 122 px, `{10,55,60}` interior 92 px, `{0,209,209}` ink
      38 px — the baked palette only. No vanish on either named ground.
- [x] E-4: **Aspect / stretch audit.** **OBSERVED:** the figure is uniformly scaled and centred —
      the 128 px render's ink bbox aspect `h/w` = **1.375** vs 1.4 at 32 px and 1.3924 at 256/512 px
      (all within the ±3% no-stretch band); the large master carries exactly **one** uniform
      `scale(S)` (parity guard 13/13). No naive non-uniform scale.
- [x] E-5: **Stale-art resurfacing.** **OBSERVED:** none. All 17 shipped artifacts differ
      byte-wise from `main` (17/17 distinct both-side blob SHAs, F-1b); **0** embedded legacy-art
      blobs in the built `Fredo.exe` (15 `origin/main` baselines compared, F-2b); and a perceptual
      check against a naive downscale of the retired art gives a mean absolute RGB difference of
      **62.6** (16 px) / **59.8** (32 px) — plainly a different mark, not a rescaled legacy one.
- [ ] E-6: **Explorer icon-cache staleness.** `n/a — environment-limited (PO-accepted)` — named
      blocker: driving Explorer/the taskbar and running `ie4uinit.exe -show` requires OS
      interaction the sandbox forbids (no OS screen-capture lever; arbitrary `.ps1` is outside the
      closed named-script allowlist). Residual: the built `Fredo.exe` embeds the regenerated
      `icon.ico` frames byte-for-byte (F-2b), so any Explorer cache would serve the new resource
      after a normal refresh.
- [x] E-7: **Generator determinism across environments.** **OBSERVED:** two consecutive
      `pnpm icons:generate` runs produced an identical sha256 set for all 17 artifacts, and
      `pnpm icons:check`'s determinism leg regenerates into an alternate `--out` directory and
      byte-compares — exit 0. No path-dependent or cache-dependent encode.
- [x] E-8: **Doc ↔ artifact drift.** **OBSERVED:** every claim in `docs/app-icons.md` checked
      against the shipped bytes — the documented commands exist verbatim (`docs/app-icons.md:110-113`),
      the documented source (canonical SVG geometry, `:15-31`) matches the one actually used, the
      documented treatment (opaque `#0c1117` tile, 12.5% corner radius, 86% content box, one uniform
      `scale(S)`, `:58-65`) matches the shipped alpha/geometry, and the documented ICO frame set
      (16/24/32/48/64/128/256) matches the packed container. No drift.
- [x] E-9: **`.icns` validity without macOS.** **OBSERVED:** `icon.icns` is a structurally valid
      ICNS container — header magic `69636e73` (`icns`) + a TOC listing 5 PNG-typed elements
      (`icp4` 16, `icp5` 32, `ic07` 128, `ic08` 256, `ic09` 512). It is regenerated for
      `bundle.icon` completeness even though the macOS bundle is not shipped.
- [x] E-10: **Unreferenced Windows logo assets.** **OBSERVED:** `Square*Logo.png` / `StoreLogo.png`
      are regenerated (AC1) but referenced by **no in-repo config** — a repo grep for
      `StoreLogo|Square150x150Logo|bundle\.icon` returns only the generator manifest
      (`scripts/generate-app-icons.mjs`), the verifier (`scripts/check-app-icons.mjs`), the docs, and
      this suite; `tauri.conf.json` names only the 5 `bundle.icon` paths. Scope question for the PO
      (MSIX/Store assets, unused by the NSIS bundle), not a defect.

_Confirmed probes promote to `functional.md`; UNVERIFIED/tooling-limited probes carry a named blocker
(G-053). `n/a — environment-limited (PO-accepted)` probes are a settled amendment — do not re-drive
them in an agent sandbox._
