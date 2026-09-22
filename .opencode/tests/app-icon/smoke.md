# app-icon — Smoke Tests

Short standardized sanity checks for the OS-icon surface. The app-boot legs matter because the icon
change must not break the bundle/config; the visual legs are the icon set + built artifact, not the
webview. Verification policy is **static** (no telemetry reference required).

## S-1 — App window renders (boot not broken by the config/asset change)

- [ ] S-1: `tauri_webview_dom_snapshot(type="structure")` on a dev run returns a non-empty `<body>`.
      EXPECT: the app still boots after the icon/config change.

## S-2 — No console errors

- [ ] S-2: `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` /
      `Maximum update depth exceeded`. EXPECT: console clean.

## S-3 — Icon set present and decodable

- [ ] S-3: All 17 files under `apps/tauri/src-tauri/icons/` exist and decode (PNG signature, ICO
      signature, ICNS signature). EXPECT: 17/17 present + decodable; the 5 `bundle.icon` paths are a
      subset.

## S-4 — Config + Rust build sanity

- [ ] S-4: `cargo check` from `apps/tauri/src-tauri` exits 0 with zero warnings (the config parse +
      `icon.ico` embed path). EXPECT: green.

## S-5 — Screenshot captured

- [ ] S-5: `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/2926/e2e/smoke.jpeg")` succeeds for the app boot, and the icon-set
      evidence (F-2 screenshots + F-3 composites) is saved under `.opencode/tmp/2926/e2e/`.
      EXPECT: capture succeeds; the evidence dir holds the icon screenshots.

_Full DOM + visual execution methodology lives in the `dev-environment` skill. The OS-chrome
screenshots are OS-level captures (Explorer/taskbar/Start), not webview captures — see F-2._
