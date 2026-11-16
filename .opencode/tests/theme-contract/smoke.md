# Theme Contract — Smoke

> This feature has a **user-visible surface** (Settings → Appearance → Theming) AND a developer-facing
> static instrument (the contract + the gate command). Smoke therefore combines the standardized
> app-boot boilerplate with the gate command. **Verification policy: live.**
> Full DOM + visual execution methodology lives in the `dev-environment` skill.

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:` /
      `Uncaught` / `Maximum update depth exceeded` (the #523 re-render-loop pattern is a known risk when
      preset/accent churn re-derives tokens).
- [ ] **S-3: Theming surface reachable** — Settings → Appearance → Theming renders the preset selector
      (`chakra.select`, `aria-label="Theme presets"`, `ThemingSettings.tsx:82`) and the accent colour
      inputs (`ThemingSettings.tsx:155`).
- [ ] **S-4: Theme switch is live** — selecting a preset (e.g. Light Default) updates the rendered
      surfaces immediately; computed `--accent-primary`/`--body-bg` reflect the selection.
- [ ] **S-5: Gate command runs** — `pnpm --filter @fredo/ui contrast:gate` executes and exits 0 on the
      tested tip (green once #3035 lands; two-tier until then — see `functional.md` F-3). The suite
      `apps/ui/src/app/theme/contrast/` is discovered and run.
- [ ] **S-6: Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/3034/e2e/smoke.jpeg")` succeeds.
