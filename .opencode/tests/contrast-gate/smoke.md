# Contrast Gate — Smoke

> The standardized app-boot boilerplate (`tauri_webview_dom_snapshot` / `tauri_read_logs` /
> screenshot) does **not** apply: this feature is a developer-facing, static CI instrument with **no
> user-visible surface** (no DOM, no route, no telemetry). The "core path" this smoke confirms is
> the gate command + its CI wiring. **Verification policy: static.**

- [ ] **S-1 (gate command runs):** `pnpm --filter @fredo/ui contrast:gate` executes and exits 0 on
      the tested tip (once #3035 lands). Expected: green; the suite
      `apps/ui/src/app/theme/contrast/__tests__/` is discovered and run.
- [ ] **S-2 (gate is inside the whole suite):** `pnpm --filter @fredo/ui test:run` includes and
      passes the contrast suites (green). Expected: no exclusion, no skip.
- [ ] **S-3 (CI step present + legible):** `.github/workflows/validate.yml` carries a step named
      exactly `Contrast gate` running `pnpm --filter @fredo/ui contrast:gate` in `ui-validate`.
      Expected: the step exists and would run on a UI-touching PR.
- [ ] **S-4 (build gate):** `pnpm --filter @fredo/ui build` exit 0, zero TS errors after the
      `contrast/` modules are added.
- [ ] **S-5 (bounded + read-only):** the gate completes < ~5 s wall; no file under the repo is
      modified by the gate run (`git status --porcelain` clean after the run). Expected: bounded,
      no writes.
