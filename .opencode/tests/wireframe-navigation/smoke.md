# wireframe-navigation — Smoke

Feature: the **declaration-driven Wireframe surface** (Spec #3119, P5 pilot) — the surface is
declared as data (`applications/wireframe/wireframeSurface.ts`: six places under `Canvas`, 55
verbs, 3 root direct aliases) and mounted with `CommandRail` + `NavigationMap` +
`ActivityTrail`; the 33-control toolbar, `wireframeCommandSurface.ts`,
`WireframeHotkeyCarrier.tsx`, `WIREFRAME_ACTIONS.hotkey` and every `g+*` binding are gone.

> **Verification policy: live** — every case below is a runtime observation of the running app;
> the feature emits no telemetry, so no `telemetry_spans` receipt applies (see
> `.opencode/tests/wireframe/` for the same convention).
>
> **Isolated env (binding):**
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3119 -EnvId wf3119-a -EnvSlot 1 -RequireIsolation -EnvVar "FREDO_WIREFRAME_SAVE_PATH=C:\Code\fredo\.opencode\tmp\3119\e2e\doc-a.wireframe.json" -EnvVar "FREDO_WIREFRAME_OPEN_PATH=C:\Code\fredo\.opencode\tmp\3119\e2e\doc-a.wireframe.json" -EnvVar "FREDO_WIREFRAME_EXPORT_PATH=C:\Code\fredo\.opencode\tmp\3119\e2e\page-export"`
>
> **Driver (binding):** the built-in `tauri_driver_session start` with `appIdentifier` = the
> env's MCP **port as a decimal string** (`"16001"` for slot 1). Forbidden: a scratch MCP
> client, `pnpm dev:ui` in a browser, a CDP/Playwright stand-in, a synthetic
> `KeyboardEvent` dispatch used as a key receipt (E-22).
>
> **Key technique:** press keys with the driver's real key events, from a host whose focused
> element is NOT a text control (`document.activeElement === document.body` or a rail row
> button). `Escape`, `ArrowLeft/Right` and `+`/`-` are declared strokes; `?` resolves DIRECTLY to
> the declared `app.map` verb (never synthesised as `m`, because Create binds `m`→add.image);
> `/` is inert and announces nothing.

## Cases

- [ ] **S-N1: App window renders.**
      `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>` with no
      `vite-error-overlay`.

- [ ] **S-N2: Wireframe opens with the navigation surfaces.**
      Launcher → `Wireframe`. **Expected:** `[data-testid="wireframe-root"]` renders with
      `data-wireframe-place="wireframe.canvas"`, plus `wireframe-canvas`,
      `navigation-rail`, `navigation-trail` and `wireframe-property-panel`; the rail renders
      the six place rows (`Create, Edit, Arrange, Style, View, File`) above its verb rows.

- [ ] **S-N3: No toolbar and no hotkey bar for Wireframe.**
      With Wireframe focused: `document.querySelector('[data-testid="wireframe-toolbar"]')`
      is `null`, `document.querySelectorAll('[data-testid^="wireframe-action-"]').length` is
      **0**, and `document.querySelectorAll('[data-testid="hotkeys-keybar"]').length` is **0**.
      **Non-vacuity control:** open Mission Monitor → `hotkeys-keybar` is present (the
      instrument exists whether or not the Wireframe claim holds).

- [ ] **S-N4: Keyed quick path — create a rectangle.**
      Press `c` then `r`, then drag on the canvas using DOM `MouseEvent` sequences on
      `.konvajs-content` (an `interact` swipe does not deliver Konva's drag shape).
      **Expected:** `data-wireframe-element-count` 0→1, `-selection-type="shape"`,
      `-selection-shape="rect"`, `data-wireframe-arm="none"`, and after the drag
      `data-wireframe-place="wireframe.canvas"` (the transient Create place auto-exited).
      The trail shows exactly one entry.

- [ ] **S-N5: Map opens with `?` and lists the six places.**
      Press `?` (the adapter maps it DIRECTLY to the declared `app.map` verb).
      **Expected:** `[data-testid="navigation-map"]` opens with `role="dialog"`,
      `aria-modal="true"`, `aria-label="Navigation map"`; the place blocks appear in tree order
      `Canvas, Canvas › Create, Canvas › Edit, Canvas › Arrange, Canvas › Style, Canvas › View,
      Canvas › File`; exactly one block carries `data-nav-current="true"`.
      Then `Escape` closes it and focus returns to the invoker (never `body`).

- [ ] **S-N6: Screenshot captured.**
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3119/e2e/smoke.jpeg")`
      succeeds and is uploaded with `pipeline-state.rs --issue 3119 --agent tester --action
      upload-evidence --image <path>`.

- [ ] **S-N7: No console errors.**
      `tauri_read_logs(source="console", lines=50)` shows no `Error:`, `Uncaught`,
      `Maximum update depth exceeded`, and no `flushSync` warning, across S-N2…S-N5.

- [ ] **S-N8: Build + suite gates.**
      `pnpm --filter @fredo/ui build` exit 0 with zero TS errors;
      `pnpm --filter @fredo/ui test:run` green; `pnpm --filter @fredo/ui contrast:gate` green
      (46/46 expected pre-change baseline); `cargo check --manifest-path
      apps/tauri/src-tauri/Cargo.toml --locked` zero warnings.

## Suite-level pass/fail

PASS = S-N1…S-N8 green, each documented with a quoted tool result (and an uploaded capture for
S-N4/S-N6). A blank window, a present toolbar/hotkey bar, or a stale `dist` is a FAIL. The
receipt is the POSTED `## Tests Runs` comment plus the committed suite — never a
`.opencode/tmp/3119/` draft.
