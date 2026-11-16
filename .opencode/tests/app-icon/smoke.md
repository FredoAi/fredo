# app-icon — Smoke Tests

Short standardized sanity checks for the OS-icon surface. The app-boot legs matter because the icon
change must not break the bundle/config; the visual legs are the icon set + built artifact, not the
webview. Verification policy is **static** (no telemetry reference required).

> ### #2930 round 1 run record (2026-09-22, `spec/2930` @ `e7ea8c00`)
> Static policy. The round brief prohibits launching the dev instance for this spec (the deliverable
> is a shipped raster; there is no webview surface to drive). `dev-env.ps1 -Action Status` →
> `stopped`. Therefore S-1/S-2/S-5 (inherently webview legs) are dispositioned **not run** with the
> named blocker; S-3/S-4 ran green.

## S-1 — App window renders (boot not broken by the config/asset change)

- [ ] S-1: `tauri_webview_dom_snapshot(type="structure")` on a dev run returns a non-empty `<body>`.
      EXPECT: the app still boots after the icon/config change.
      **NOT RUN (#2930 r1) — NAMED BLOCKER:** no dev instance launched (round brief: no webview
      driving; `dev-env.ps1 -Action Status` → `stopped`). The boot path is instead covered by S-4
      (`cargo check` parses `tauri.conf.json` + embeds `icon.ico`) and by `pnpm icons:check` exit 0.

## S-2 — No console errors

- [ ] S-2: `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` /
      `Maximum update depth exceeded`. EXPECT: console clean.
      **NOT RUN (#2930 r1) — NAMED BLOCKER:** same as S-1 (no dev instance / no webview). This spec
      changes no Rust or TypeScript product code (the only `apps/ui/src` change is the parity test),
      so there is no runtime path that could produce a console error.

## S-3 — Icon set present and decodable (single master, revised by #2930)

- [x] S-3: All 17 shipped artifacts under `apps/tauri/src-tauri/icons/` exist and decode (PNG
      signature, ICO signature, ICNS signature), **exactly one** SVG master
      (`fredo-icon-large.svg`) is present, `fredo-icon-small.svg` is **absent**, and
      `manifest.sha256` exists. EXPECT: 17/17 artifacts present + decodable; 1 master; the 5
      `bundle.icon` paths are a subset.
      **OBSERVED (#2930 r1):** 19 top-level entries = 15 PNG artifacts + `icon.ico` + `icon.icns` +
      `manifest.sha256` + `fredo-icon-large.svg`; the ICO container parses (`ICONDIR count = 7`,
      frames `{16,24,32,48,64,128,256}`), the ICNS TOC parses (`{icp4, icp5, ic07, ic08, ic09}`),
      every PNG decodes with the `89 50 4E 47` magic; `fredo-icon-small.svg` absent;
      `pnpm icons:check` exit 0 → the 5 `bundle.icon` paths exist.

## S-4 — Config + Rust build sanity

- [x] S-4: `cargo check` from `apps/tauri/src-tauri` exits 0 with zero warnings (the config parse +
      `icon.ico` embed path). EXPECT: green.
      **OBSERVED (#2930 r1):** `pnpm exec cargo check --manifest-path
      apps/tauri/src-tauri/Cargo.toml --locked` → exit 0, ``Finished `dev` profile [unoptimized +
      debuginfo] target(s) in 1m 45s``, **zero warnings**.

## S-5 — Screenshot captured

- [ ] S-5: `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/2926/e2e/smoke.jpeg")` succeeds for the app boot, and the icon-set
      evidence (F-2 screenshots + F-3 composites) is saved under `.opencode/tmp/2926/e2e/`.
      EXPECT: capture succeeds; the evidence dir holds the icon screenshots.
      **NOT RUN (#2930 r1) — NAMED BLOCKER:** no webview to capture (no dev instance). The
      icon-set evidence for this round is instead the **container-frame extraction + composites**
      under `.opencode/tmp/2930/e2e/` (the shipped raster bytes are the artifact, not a webview
      render), uploaded via `upload-evidence` into the round's `## Tests Runs` comment.

_Full DOM + visual execution methodology lives in the `dev-environment` skill. The OS-chrome
screenshots are OS-level captures (Explorer/taskbar/Start), not webview captures — see F-2._
