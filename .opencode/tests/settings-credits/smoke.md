# settings-credits — Smoke

> Short, standardized boot + core-path checks for **Settings → Credits** (Spec #3206). Adapted
> from the boilerplate in `.opencode/tests/README.md`; S-6..S-8 are this feature's own quick
> paths. **Verification policy: live** — every row here is a running-artifact observable.

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
- [ ] S-3: Settings surface reachable — the launcher tile `Settings` opens
      `div[role="group"][aria-label="Settings"]`.
  **Expected:** the Settings window renders with its sidebar.
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
- [ ] S-7: The Credits pane is static — the same click sequence with no network available to the
  frontend (content comes from the built module).
  **Expected:** the pane renders identically; the console shows no fetch/`net::ERR` entry at
  mount. (The exhaustive proof is F-10; this is the quick path.)
- [ ] S-8: No new window, no navigation — `tauri_manage_window action="list"` before and after
  opening Credits.
  **Expected:** identical window set; `document.title` unchanged.

_Evidence convention: pass keeps `- [x]` + the observed value; fail leaves `- [ ]` with
expected-vs-actual; a row that cannot run is `UNVERIFIED` with a named blocker._
