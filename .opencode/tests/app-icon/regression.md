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

> ### #2930 round 1 run record (2026-09-22, `spec/2930` @ `e7ea8c00`)
> The decisive lever for "unchanged" claims is the **whole-tree**
> `git diff --name-status origin/main spec/2930`, which returned **exactly 7 paths** —
> `D apps/tauri/src-tauri/icons/fredo-icon-small.svg`,
> `M apps/tauri/src-tauri/icons/icon.icns`,
> `M apps/tauri/src-tauri/icons/icon.ico`,
> `M apps/tauri/src-tauri/icons/manifest.sha256`,
> `M apps/ui/src/shared/components/fredo-avatar/__tests__/iconSourceParity.test.ts`,
> `M docs/app-icons.md`, `M scripts/generate-app-icons.mjs` — so every other path in the repo is
> byte-identical to `origin/main`. Scratch extractions live under `.opencode/tmp/2930/`.

## R-1 — Release contract unchanged (icon is an additive asset change)

- [x] R-1: `.github/workflows/release.yml`, `.github/workflows/validate.yml`,
      `.github/workflows/validate-fast.yml` and `.github/CODEOWNERS` are byte-identical to the
      `main` tip. EXPECT: no workflow/CI file touched by this spec.
      **OBSERVED (#2930 r1):** the whole-tree diff lists **no** `.github/**` path → byte-identical.
- [x] R-2: `apps/tauri/src-tauri/tauri.conf.json` differs ONLY in the icon set (if at all):
      `productName`, `version`, `identifier`, `bundle.active`, `bundle.targets`,
      `bundle.windows.nsis` (`installMode`, `installerHooks`) are byte-identical to `main`.
      EXPECT: unchanged — a spec that re-targets the bundle is out of scope.
      **OBSERVED (#2930 r1):** `git diff --name-status origin/main spec/2930 --
      apps/tauri/src-tauri/tauri.conf.json` → **empty output** (byte-unchanged); `pnpm icons:check`
      exit 0 re-asserts the frozen 5-path `bundle.icon`.
- [x] R-3: `apps/tauri/src-tauri/nsis/installer-hooks.nsh` is unchanged. EXPECT: the NSIS
      installer's hook behavior is untouched (only its icon art changed).
      **OBSERVED (#2930 r1):** not present in the whole-tree diff → byte-identical.

## R-2 — Build stays green

- [x] R-4: `cargo check` from `apps/tauri/src-tauri` exits 0 with **zero warnings** (the
      zero-warnings rule). EXPECT: no new warning introduced by the icon change.
      **OBSERVED (#2930 r1):** `pnpm exec cargo check --manifest-path
      apps/tauri/src-tauri/Cargo.toml --locked` → exit 0, ``Finished `dev` profile [unoptimized +
      debuginfo] target(s) in 1m 45s``, **0 warnings**.
- [x] R-5: `pnpm --filter @fredo/ui build` exits 0 with zero TypeScript errors. EXPECT: the UI build
      is unaffected (the icon change must not touch UI source; a *new* TS error is a FAIL).
      **OBSERVED (#2930 r1):** `pnpm --filter @fredo/ui build` → exit 0 (`tsc && vite build`,
      `✓ built in 9.90s`), zero TypeScript errors (the only warning is the pre-existing chunk-size
      notice).
- [ ] R-6: `pnpm --filter @fredo/tauri build` completes end-to-end (the release bundle still builds
      with the new icon set). EXPECT: exit 0.
      **NOT RE-RUN (#2930 r1) — NAMED BLOCKER:** the round brief explicitly forbids rebuilding the
      release bundle and forbids asserting against the pre-existing `target/**` artifacts (they
      predate this change). The icon's config validity + compile-time embed path is instead covered
      by R-4 (`tauri::generate_context!()` parses `tauri.conf.json` and embeds `icon.ico`) and by
      `pnpm icons:check` exit 0.

## R-3 — In-app avatar + theming untouched

- [x] R-7: `apps/ui/src/shared/components/fredo-avatar/**` is byte-identical to the `main` tip (the
      frozen 58-rect table and its geometry test must NOT be the generator's output target).
      EXPECT: unchanged.
      **OBSERVED (#2930 r1):** the only change under that directory is the parity test
      `__tests__/iconSourceParity.test.ts` (the ST-4 rewrite). `fredoAvatarGeometry.ts`,
      `FredoAvatar.tsx` and every other file are absent from the whole-tree diff → byte-identical.
- [x] R-8: No new hardcoded color literal enters `apps/ui/src` — if the generator or any helper is
      TS/JS under `apps/ui`, the token-first rule still applies (brand cyan `#00D1D1`/brand dark
      `#0C1117` may appear as *generator input data*, never as component color usage); no
      `var(--x)NN` alpha-append. EXPECT: zero new component-level literals.
      **OBSERVED (#2930 r1):** the only changed file under `apps/ui/src` is the parity test; its
      `BAKED_PALETTE = ['#0c1117', '#00d1d1', '#0a373c']` allow-list predates this spec (present in
      the `origin/main` version) → **no new literal**; the diff adds no `var(--…)NN` alpha-append.

## R-4 — Other icon-like surfaces not disturbed

- [ ] R-9: The in-app launcher/companion avatar renders unchanged in a dev run (dev-run DOM: the
      shared `FredoAvatar` still paints its 58 rects; no console error). EXPECT: no regression from
      the asset work.
      **NOT RUN (#2930 r1) — NAMED BLOCKER:** the round brief prohibits launching the dev instance
      for this static-asset spec (`dev-env.ps1 -Action Status` → `stopped`; no webview driving).
      Source-level identity is covered by R-7 (the avatar module is byte-identical to `main`), and
      the parity test re-asserts the 58-rect table equals `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`.
- [x] R-10: `apps/ui/src/assets/` gains no replacement bitmap (the icon set lives under
      `apps/tauri/src-tauri/icons/`; UI assets are not reintroduced as an icon source). EXPECT: no
      new unreferenced bitmap dropped into UI assets.
      **OBSERVED (#2930 r1):** no `apps/ui/src/assets/**` path in the whole-tree diff; the generator
      writes only into `apps/tauri/src-tauri/icons/` (and an explicit `--out` dir).

## R-5 — Single-master icon source (revised by #2930)

- [x] R-11: `apps/tauri/src-tauri/icons/fredo-icon-small.svg` is **deleted** and no generator, test,
      or doc path selects a second master: grep `scripts/`, `apps/ui/src/`, `docs/` for
      `fredo-icon-small`, `SMALL_MASTER`, `master: 'small'` returns **zero code/selection sites**;
      `scripts/generate-app-icons.mjs` `masterFile()` has no small branch; the ICO frame set still
      packs `{16,24,32,48,64,128,256}` — from the one master. EXPECT: one master, no dead two-master
      machinery (a bare historical/prose mention in `docs/` is not a selection site).
      **OBSERVED (#2930 r1):** `D …/fredo-icon-small.svg`; `Test-Path` → False. `scripts/` has
      **zero** selection tokens — only `:57 export const MASTER = 'fredo-icon-large.svg';`, `:60
      MASTER_PX = 1024`, and the uses at `:230`/`:234`/`:242`; the per-row `master` field,
      `MASTER_PX.small` and `masterFile()` are all gone. `apps/ui/src/` hits are the two **absence
      guards** in the parity test (`:211` `existsSync(...fredo-icon-small.svg) === false`, `:215`
      `not.toContain('SMALL_MASTER')`) — negative assertions, not selection sites. `docs/` hits are
      the explicit removal/absence notes (`docs/app-icons.md:32`, `:145-146`). The ICO frame set is
      still exactly `{16,24,32,48,64,128,256}` (parsed from the shipped bytes).
      **Non-blocking nit (not this AC's surface):** `docs/SETUP.md:172`/`:176` still say "the
      committed SVG **masters**" (plural prose, no selection path) — worth a one-line cleanup later.
- [x] R-12: `apps/tauri/src-tauri/icons/manifest.sha256` is regenerated and lists the ONE master
      (`fredo-icon-large.svg`) + the 17 artifacts, and does **not** list `fredo-icon-small.svg`.
      EXPECT: manifest ↔ shipped bytes match; `pnpm icons:check` exit 0.
      **OBSERVED (#2930 r1):** the manifest is **17 rows — the 17 artifacts only** (masters were
      never manifest rows; `check-app-icons.mjs`'s frozen `artifactPaths()` contract expects exactly
      the 17 artifacts). It matches the shipped bytes (all 17 sha256 verified) and contains **no**
      row for `fredo-icon-small` (nor for the large master). Two consecutive fresh `--out`
      regenerations reproduce the same 17 rows byte-for-byte (modulo the CRLF working-tree smudge on
      the text file). `pnpm icons:check` → exit 0.
- [x] R-13: `apps/ui/src/shared/components/fredo-avatar/__tests__/iconSourceParity.test.ts` is
      rewritten for the single master (no two-master / head-only expectation) and passes. EXPECT:
      `vitest run …/iconSourceParity.test.ts` green; exactly one uniform `scale(S)`; no
      `scale(sx, sy)`.
      **OBSERVED (#2930 r1):** `pnpm --filter @fredo/ui exec vitest run
      src/shared/components/fredo-avatar/__tests__/iconSourceParity.test.ts` → **9/9 passed**; the
      rewritten suite keeps the frozen 58-rect multiset, the interior-path equality, the
      single-uniform-`scale(S)` pin (a two-argument `scale()` is mechanically rejected) and the
      palette-only/no-effects checks, and adds the small-master-absent + generator-selects-no-second-
      source guards.

_Evidence convention: pass cases keep `- [x]` + append the observed file/line/receipt; fail cases
leave `- [ ]` marked `FAIL` with expected-vs-actual + repro._
