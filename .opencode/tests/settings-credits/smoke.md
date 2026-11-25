# settings-credits — Smoke

> Short, standardized boot + core-path checks for **Settings → Credits** (Spec #3206). Adapted
> from the boilerplate in `.opencode/tests/README.md`; S-6..S-8 are this feature's own quick
> paths. **Verification policy: live** — every row here drives the running artifact. (S-7 pairs
> its live console reading with a read of the committed built bundle, because "offline" cannot be
> proven by cutting the webview's network; see that row's substitution note.)

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a
      non-empty `<body>`.
  **Expected:** the document has children and the launcher surface is painted (a fresh isolated
  boot can take 3–5 minutes before first paint — `.opencode/skills/dev-environment`; a `about:blank`
  window or a `Request timeout after 2000ms` inside that window is BOOTING, not a defect).
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`,
      no `Uncaught`, no `Maximum update depth exceeded`.
  **Expected:** clean console on the launcher and after opening Settings → Credits.
  **Edge:** a pre-existing error unrelated to Credits is disclosed with its message — never
  attributed to this feature without a Credits-mounted repro.
- [ ] S-3: Settings surface reachable — open the launcher (`Ctrl+Space`, or the notch
      `div[role="button"][aria-label="Fredo launcher"]`), then prove the tile before clicking:
      `document.querySelectorAll('#fredo-launcher-grid [role="button"][aria-label="Settings"]').length`
      must be exactly **1** — the tile is a `div[role="button"]` inside
      `div#fredo-launcher-grid[role="grid"][aria-label="Applications"]`
      (`LauncherAppGrid.tsx:52-56`, `:93-104`). Click it.
  **Expected:** the Settings window `div[role="group"][aria-label="Settings"]` renders with its
  sidebar. **A tile count of 0 is a FAILED DRIVE, not a PASS** — the launcher is closed or the
  selector drifted; open the launcher and re-count. That `role="group"` node is the WINDOW, so it
  is the expected post-click node and must never be used as the tile selector.
- [ ] S-4: The Credits entry is present in the Settings sidebar —
      `document.querySelector('[data-testid="settings-nav-credits"]')` is non-null and its text
      is `Credits`.
  **Expected:** present with **no** click, no wait, no scroll into view.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/3206/e2e/smoke.jpeg")` succeeds.
  **Expected:** the file is written; upload it with
  `rust-script .opencode/scripts/pipeline-state.rs --issue 3206 --agent tester --action upload-evidence --image <path>`
  and record the returned `user-attachments` URL.
- [ ] S-6: The Credits pane renders — click `settings-nav-credits`, then a structure snapshot.
  **Expected:** `[data-testid="credits-settings"]` exists; the six entry roots
  (`credits-entry-llama-cpp`, `-vulkan`, `-ggml`, `-neurodoom`, `-doom1-wad`,
  `-posable-doomguy`), `credits-fredo-licence` and `credits-doom-trademark` are all in the
  document.
- [ ] S-7: The Credits content is INLINED in the shipped bundle (offline by construction), not
      fetched. Open Credits (S-6), read the console
      (`tauri_read_logs(source="console", lines=50)`), then check the committed built asset:
      `Select-String -Path apps/tauri/dist/assets/*.js -Pattern '<literal>' -SimpleMatch` for each
      of the six upstream URLs (F-2a's five plus `https://www.thingiverse.com/thing:4873090`) and
      for `MIT License`.
  **Expected:** every search returns **≥1** match in `apps/tauri/dist/assets/*.js` (the notices are
  baked into the shipped JS), the pane shows all six entries, and the console shows no
  `Failed to fetch`, no CSP `connect-src` refusal and no `net::ERR` attributable to the Credits
  mount.
  **Substitution, stated (there is no network partitioning from the bridge):** the bridge cannot
  cut or filter the webview's network, so "offline" is NOT proven by disabling connectivity — an
  earlier form of this row asked for exactly that and was undrivable. The offline property is
  proven from the **committed artifact** above: content that is present as a literal in the
  shipped bundle needs no request to render. A zero-match literal is the FAIL (content absent from
  the bundle). The exhaustive version is F-10 (`F-10a` bundle literals + `F-10b` source scan);
  this row is the quick path.
  **Precondition:** `apps/tauri/dist/assets/*.js` must exist (F-9a builds it otherwise — run
  `pnpm --filter @fredo/tauri build:webview` and record its `EXITCODE=0`). An ABSENT asset is
  `UNVERIFIED` with that named blocker — never a PASS on a zero-match scan of nothing.
- [ ] S-8: No new window, no navigation — `tauri_manage_window action="list"` before and after
  opening Credits.
  **Expected:** identical window set; `document.title` unchanged.

_Evidence convention: pass keeps `- [x]` + the observed value; fail leaves `- [ ]` with
expected-vs-actual; a row that cannot run is `UNVERIFIED` with a named blocker._
