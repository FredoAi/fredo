# navigation-research — Regression

Feature: place-based navigation fluency research spike (Issue #3115). This spike must have
**ZERO production impact** (AC7 / N-1) and must add **no telemetry** (N-8). Regression here is
the negative-case baseline (no `apps/` change, no build wiring, no telemetry), doc-index
consistency, and the static source-verification rule (no prototype drive; corrected participant
columns/quotas).

> The spike's only permitted changes are additive research artifacts: the report under `docs/`,
> the spike directory under `spikes/3115-navigation-engine/`, and the QA suite under
> `.opencode/tests/navigation-research/`. Any deviation is a regression FAIL.

## No-change baseline (AC7 / N-1)

- [ ] **R-1: no `apps/` path in the spec-branch diff.**
  `git diff --name-only main...HEAD` (or the equivalent name-only diff) lists **no** path
  beginning `apps/`.
  **Expected:** the path list contains only `docs/`, `spikes/` and `.opencode/tests/` entries.
  **FAIL:** any `apps/` path, including a formatting-only change or a deleted file.
  **Edge:** a rename out of `apps/` shows both the old and new path — both count.

- [ ] **R-2: the prototype is not wired into any build or workspace.**
  Grep the prototype dir for `apps/` (imports/references) → zero; Grep `pnpm-workspace.yaml`,
  `apps/**/vite.config.*`, root/app `tsconfig*` and `package.json` workspaces for `spikes/` →
  zero.
  **Expected:** the prototype is plain static `index.html` + CSS + JS, deletable by removing
  its directory alone.
  **FAIL:** an `apps/ui` import, a workspace member, a package entry, a bundler config, or a
  symlink into `apps/`.

- [ ] **R-3: no new telemetry.**
  No span, metric or event is emitted for this spike; no source or config adds a `gen_ai.*`
  attribute, an OTLP receiver change, or a row-pipeline event type.
  **Expected:** the diff contains no production telemetry path and the plan requires no
  `telemetry_spans` query.
  **FAIL:** any telemetry addition or a plan/test that demands live span evidence.

- [ ] **R-4: builds stay green.**
  `cargo check` from `apps/tauri/src-tauri` → zero errors, zero warnings;
  `pnpm --filter @fredo/ui build` → exit 0, zero TypeScript errors (the pre-existing Vite
  chunk-size advisory is not an error).
  **Expected:** identical to `main`; the spike is not a workspace member.
  **FAIL:** any warning/error, or a "fix" that edits product code (escalate — breaches AC7).

## Doc-index consistency

- [ ] **R-5: the report is discoverable and the spike record is indexed.**
  `docs/README.md` contains a row for `docs/UX_FLUENCY_RESEARCH.md`;
  `spikes/README.md` contains a row for `spikes/3115-navigation-engine/` and the amended prose
  "one flat `spikes/<issue>-<slug>.md` record, **or** one `spikes/<issue>-<slug>/` directory
  when the spike ships artifacts".
  **Expected:** both index entries present and the relative links resolve.
  **FAIL:** a missing index row, a broken relative link, or the old "one flat file" prose left
  unamended (contradicting the 3 shipped spike directories).

## Linked suites (overlapping surface)

- [ ] **R-6: inherited hotkey/wireframe suites pass unchanged.**
  The spike changes no hotkey or Wireframe source, so `.opencode/tests/hotkeys/` and
  `.opencode/tests/wireframe/` (if present) must pass unmodified.
  **Expected:** both suites green on the spec branch, no edits to their cases.
  **Round 1: N/A if either suite is absent** — the spike touches no source they cover; re-check
  when they land.

## Verification-shape invariant

- [ ] **R-7: corrected participant columns + static source-verification rule.**
  The plan, protocol and this suite use the corrected §4.4 columns
  (`keyboard_profile ∈ keyboard-first|non-vim`, `vim_comfortable ∈ yes|no`,
  `wireframe_new ∈ yes|no`) and the quota trio (`keyboard_first_or_vim`, `non_vim`,
  `wireframe_new` — not mutually exclusive); `data-requires-selection` is the §U-5 enum
  (`none|any|single|multi|multi3`), never a boolean; no row drives the static prototype (there
  is no browser/Tauri tool for arbitrary HTML) — interactions are verified from the initial
  markup in `index.html` plus the handlers in `prototype.js`.
  **Expected:** no retired mix column, no boolean attribute, no prototype drive.
  **FAIL:** a stale mix column; a boolean `data-requires-selection`; a row demanding a
  browser/Tauri drive (plan defect, G-316).

## Notes

- This suite is reusable: any later spec that touches the navigation model / hotkeys /
  wireframe surface inherits it, and R-1..R-7 become true regression invariants then.
- The spike is a research artifact, not a shipped feature: NO-GO is a valid outcome and is
  never a regression failure.
