# app-icon — Exploratory Tests

Unscripted edge/failure probes for the OS-icon surface. Add findings on the fly; a confirmed probe
**promotes** to `functional.md` as a new `F-` row (keep the origin note). Verification policy is
**static** — probes are asset/config/build reads plus built-artifact screenshots, not telemetry
queries.

## Prompts (seed probes)

- [ ] E-1: **Multi-resolution container truth.** Extract every frame of `icon.ico` (and every size
      inside `icon.icns`) and compare each against the corresponding standalone PNG. Does any frame
      disagree in shape/scale (a stale robot frame at one size, a frame with a different padding)?
      EXPECT: every container frame is the same mark at the same relative scale as its standalone
      sibling.
- [ ] E-2: **Mask / circular-crop survival.** Simulate the Windows taskbar and Start-menu crops
      (circular mask, rounded-square mask) over the 32px and 48px renders. Is the head silhouette
      still complete, or does a corner-touching mark get clipped? EXPECT: the mark sits inside the
      safe area; report the clipped fraction if not.
- [ ] E-3: **Background treatment on both grounds.** With the shipped background treatment, is the
      mark visible on a light ground (`#F3F3F3`) AND a dark ground (`#202020`)? Probe the boundary:
      at what ground luminance does the mark vanish? EXPECT: visible on both; a vanish at one ground
      is a FAIL promoted to F-3.
- [ ] E-4: **Aspect / stretch audit.** Reconstruct the mark's bbox from the 128px render and the
      16px render and compare `h/w`. Does scaling to a square canvas distort the 1014:1264 figure
      (naive non-uniform scale), or is the figure uniformly scaled + centred? EXPECT: uniform scale;
      report the measured ratios.
- [ ] E-5: **Stale-art resurfacing.** Is any shipped icon byte-identical to — or merely downscaled
      from — a legacy bitmap under `apps/ui/src/assets/` (`fredo-logo.png`, `fredo-logo-trimmed.png`,
      `fredo-logo-icon.png`, `fredo.png`) or the `main` retired art? EXPECT: none; a hit is a FAIL
      for F-1/NFR-5 with the source named.
- [ ] E-6: **Explorer icon-cache staleness.** After the release build, does Explorer (or the
      taskbar) serve a cached old icon? Try `ie4uinit.exe -show` and re-check. EXPECT: the fresh icon
      appears; document the cache step the tester had to perform so it is not mistaken for a defect.
- [ ] E-7: **Generator determinism across environments.** Run the generator twice in the same
      environment and once from a different working directory / with a cleared cache. Are the
      SHA-256 sets identical each time? EXPECT: identical (a path-dependent or cache-dependent
      encode is a FAIL for F-5a).
- [ ] E-8: **Doc ↔ artifact drift.** Re-read the R-5 documentation and check every claim against the
      shipped bytes: does the documented command exist verbatim, does the documented source match the
      one actually used, does the documented background treatment match the shipped alpha? EXPECT:
      no drift; a mismatch is a FAIL for F-5 with the diff named.
- [ ] E-9: **`.icns` validity without macOS.** Is `icon.icns` a structurally valid ICNS container
      (header magic + listed image types) even though it is never consumed on Windows? EXPECT: valid
      container; a corrupt/renamed file is a FAIL for F-4c (it is still listed in `bundle.icon`).
- [ ] E-10: **Unreferenced Windows logo assets.** `Square*Logo.png` / `StoreLogo.png` are MSIX/Store
      assets not used by this NSIS bundle. Confirm they are regenerated (AC1) but that no config
      references them — and record whether they are needed at all (a scope question for the PO, not a
      defect).

_Confirmed probes promote to `functional.md`; UNVERIFIED/tooling-limited probes carry a named blocker
(G-053)._
