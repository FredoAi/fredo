# navigation-research — Smoke

Feature: place-based navigation fluency research spike (Issue #3115). This spec ships
**documents + a throwaway static prototype** and changes no runtime behaviour, so the standard
app-boot smoke (S-1..S-5: window renders, no console errors, surface reachable, settings
accessible, screenshot) **does NOT apply** — there is no app surface to boot and no webview to
drive. Mirroring the prior `persistence-spike` convention, the smoke is reduced to
artifact-presence + static-open + marker + build receipts.

## Cases

- [ ] **S-1: committed artifacts present and non-empty.**
  Read each path and assert it exists with non-zero size:
  `docs/UX_FLUENCY_RESEARCH.md`, `docs/README.md`, `spikes/README.md`,
  `spikes/3115-navigation-engine/README.md`,
  `spikes/3115-navigation-engine/session-protocol.md`,
  `spikes/3115-navigation-engine/session-kit/gate-h-input-template.md`,
  `spikes/3115-navigation-engine/prototype/README.md`,
  `spikes/3115-navigation-engine/prototype/index.html`,
  `spikes/3115-navigation-engine/prototype/prototype.css`,
  `spikes/3115-navigation-engine/prototype/prototype.js`,
  `.opencode/tests/navigation-research/{functional,regression,exploratory,smoke}.md`.
  **Expected:** all present and non-empty (a file that lives only under `.opencode/tmp/` does
  not count).
  **FAIL:** any missing or empty artifact.

- [ ] **S-2: prototype opens as a static HTML page.**
  `index.html` references only relative paths (`./prototype.css`, `./prototype.js`); no CDN, no
  absolute URL, no `fetch`/`XMLHttpRequest`, no import map, no service worker, no bundler-only
  import.
  **Expected:** the directory is a self-contained static page — opening `index.html` directly
  needs no server and no network.
  **FAIL:** any external dependency or a reference to `apps/`.

- [ ] **S-3: no `PENDING GATE H` marker in the report.**
  Search `docs/UX_FLUENCY_RESEARCH.md` for the literal `STATUS: PENDING GATE H`.
  **Expected:** absent (ST-6 replaced it with the transcribed human data). A round still
  carrying it is premature — see the functional precondition.
  **FAIL:** the marker is present.

- [ ] **S-4: build receipts green.**
  `cargo check` from `apps/tauri/src-tauri` → exit 0, zero warnings; `pnpm --filter @fredo/ui
  build` → exit 0, zero TypeScript errors (the pre-existing Vite chunk-size advisory is not an
  error).
  **Expected:** identical to `main`; the prototype is not a workspace member.
  **FAIL:** any warning/error, or a "fix" that edits product code (escalate — breaches AC7).

## Not applicable

- **S-1..S-5 (app boot) do NOT apply.** This spike has no UI surface, no webview and no
  runtime — `tauri_webview_dom_snapshot`, `tauri_read_logs`, `tauri_webview_screenshot` are
  meaningless here and must not be planned. Any future spec that gives this feature a
  runtime/UI surface must restore the standard app-boot checks.
- **No telemetry smoke:** the spike emits no spans/metrics/events and requires no
  `telemetry_spans` query.
