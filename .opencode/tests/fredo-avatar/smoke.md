# fredo-avatar — Smoke

> Standardized boilerplate (`.opencode/tests/README.md`) adapted to the avatar surface. Live policy —
> capture + console-clean at each step. Serving checkout: the spec branch on a running Fredo desktop
> app (`com.fredo.app`), captures under `.opencode/tmp/3210/e2e/`.

- [ ] S-AV-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-AV-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-AV-3: The avatar renders on the launcher seat — with the companion OFF, the launcher seat
      shows ONE `[data-avatar-render]` (80×100) with a painted figure (capture `smoke-seat.jpeg`);
      no `<svg>` inside the avatar root; console clean.
- [ ] S-AV-4: The companion renders — toggle the companion ON (Settings → Companion): exactly one
      Fredo at the centre seat (`.fredo-companion-avatar`), `[data-avatar-render]` present at
      80×100, the wrapper `aria-label="Fredo companion -- <state>"` set (capture `smoke-companion.jpeg`).
- [ ] S-AV-5: The character animates — single-click the companion: `data-avatar-clip` becomes
      `talk`/`joking` during the reply and returns to the resting clip afterwards (capture
      `smoke-talk.jpeg`); console clean.
- [ ] S-AV-6: The accent reaches the character — change the accent in Settings → Appearance →
      Accent Colors (`input[aria-label="Primary color"]`): `data-avatar-body-color` changes with no
      reload (capture `smoke-accent.jpeg`).
- [ ] S-AV-7: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/3210/e2e/smoke.jpeg")` succeeds.
