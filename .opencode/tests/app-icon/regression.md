# app-icon — Regression Tests

The "must not change" baseline for the OS-icon work: replacing the shipped icon set must not disturb
the release pipeline, the build, the theming/avatar system, or the desktop shell. Verification
policy is **static** (asset + config + build domain).

> **Cross-suite links (run both when this suite runs):**
> - `release-pipeline/regression.md` — the icon set is a shipped artifact of the release bundle and
>   `tauri.conf.json` is the release workflow's config. The #2801 validate gate, `release.yml`
>   triggers, and CODEOWNERS must be untouched.
> - `desktop-shell/regression.md` + `launcher/regression.md` — the in-app avatar geometry and its
>   consumers are NOT changed by this spec (the icon generator must not mutate
>   `fredoAvatarGeometry.ts` or any avatar component).

## R-1 — Release contract unchanged (icon is an additive asset change)

- [ ] R-1: `.github/workflows/release.yml`, `.github/workflows/validate.yml`,
      `.github/workflows/validate-fast.yml` and `.github/CODEOWNERS` are byte-identical to the
      `main` tip. EXPECT: no workflow/CI file touched by this spec.
- [ ] R-2: `apps/tauri/src-tauri/tauri.conf.json` differs ONLY in the icon set (if at all):
      `productName`, `version`, `identifier`, `bundle.active`, `bundle.targets`,
      `bundle.windows.nsis` (`installMode`, `installerHooks`) are byte-identical to `main`.
      EXPECT: unchanged — a spec that re-targets the bundle is out of scope.
- [ ] R-3: `apps/tauri/src-tauri/nsis/installer-hooks.nsh` is unchanged. EXPECT: the NSIS
      installer's hook behavior is untouched (only its icon art changed).

## R-2 — Build stays green

- [ ] R-4: `cargo check` from `apps/tauri/src-tauri` exits 0 with **zero warnings** (the
      zero-warnings rule). EXPECT: no new warning introduced by the icon change.
- [ ] R-5: `pnpm --filter @fredo/ui build` exits 0 with zero TypeScript errors. EXPECT: the UI build
      is unaffected (the icon change must not touch UI source; a *new* TS error is a FAIL).
- [ ] R-6: `pnpm --filter @fredo/tauri build` completes end-to-end (the release bundle still builds
      with the new icon set). EXPECT: exit 0.

## R-3 — In-app avatar + theming untouched

- [ ] R-7: `apps/ui/src/shared/components/fredo-avatar/**` is byte-identical to the `main` tip (the
      frozen 58-rect table and its geometry test must NOT be the generator's output target).
      EXPECT: unchanged.
- [ ] R-8: No new hardcoded color literal enters `apps/ui/src` — if the generator or any helper is
      TS/JS under `apps/ui`, the token-first rule still applies (brand cyan `#00D1D1`/brand dark
      `#0C1117` may appear as *generator input data*, never as component color usage); no
      `var(--x)NN` alpha-append. EXPECT: zero new component-level literals.

## R-4 — Other icon-like surfaces not disturbed

- [ ] R-9: The in-app launcher/companion avatar renders unchanged in a dev run (dev-run DOM: the
      shared `FredoAvatar` still paints its 58 rects; no console error). EXPECT: no regression from
      the asset work.
- [ ] R-10: `apps/ui/src/assets/` gains no replacement bitmap (the icon set lives under
      `apps/tauri/src-tauri/icons/`; UI assets are not reintroduced as an icon source). EXPECT: no
      new unreferenced bitmap dropped into UI assets.

## R-5 — Single-master icon source (revised by #2930)

- [ ] R-11: `apps/tauri/src-tauri/icons/fredo-icon-small.svg` is **deleted** and no generator, test,
      or doc path selects a second master: grep `scripts/`, `apps/ui/src/`, `docs/` for
      `fredo-icon-small`, `SMALL_MASTER`, `master: 'small'` returns **zero code/selection sites**;
      `scripts/generate-app-icons.mjs` `masterFile()` has no small branch; the ICO frame set still
      packs `{16,24,32,48,64,128,256}` — from the one master. EXPECT: one master, no dead two-master
      machinery (a bare historical/prose mention in `docs/` is not a selection site).
- [ ] R-12: `apps/tauri/src-tauri/icons/manifest.sha256` is regenerated and lists the ONE master
      (`fredo-icon-large.svg`) + the 17 artifacts, and does **not** list `fredo-icon-small.svg`.
      EXPECT: manifest ↔ shipped bytes match; `pnpm icons:check` exit 0.
- [ ] R-13: `apps/ui/src/shared/components/fredo-avatar/__tests__/iconSourceParity.test.ts` is
      rewritten for the single master (no two-master / head-only expectation) and passes. EXPECT:
      `vitest run …/iconSourceParity.test.ts` green; exactly one uniform `scale(S)`; no
      `scale(sx, sy)`.

_Evidence convention: pass cases keep `- [x]` + append the observed file/line/receipt; fail cases
leave `- [ ]` marked `FAIL` with expected-vs-actual + repro._
