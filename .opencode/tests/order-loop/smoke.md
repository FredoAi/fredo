# Order Loop — Smoke

> Standardized boilerplate (`.opencode/tests/README.md`) adapted to the placed order loop.
> **Verification policy: live.**
>
> **Prerequisites:** the spec-branch isolated env is Up
> (`dev-env.ps1 -Action Up -Spec 3243 -EnvId <id> -EnvSlot <n> -RequireIsolation`), the companion is ON
> at the seat, the in-process engine is healthy for PATH-A. Fill the served SHA per round.
>
> **Booking:** every live row states PATH-A (a real in-process turn) or FALLBACK-F (a driven selection
> through the shipped `llm-skill-call` channel / the `FREDO_ORDER_SKILL_LEVER` seam) with the literal
> disclosure `model-turn not exercised`.

- [ ] **S-1: App boots and the companion is reachable.** Launch the tip; open the launcher.
  **Expected:** the app renders; the launcher input is focusable and EMPTY; console
  (`tauri_read_logs(source="console")`) is clean of `Error:` / `Uncaught` / `Maximum update depth
  exceeded`; `tauri_webview_screenshot` succeeds.

- [ ] **S-2: The order field reaches the placed state.** Ctrl+right-click the companion to teleport it
  into an overlay (or click the avatar once); wait for `[data-testid="fredo-companion-composer"]` count
  **1**.
  **Expected:** the target chip (`fredo-companion-composer-target`) resolves to an app name (`for
  Wireframe`) — NOT `No app in front of Fredo`; the field is `fredo-companion-composer-input`; Send and
  Close are present and named. An immediate re-read finding 0 composers is a FALSE FAIL (the settle
  arms the open).

- [ ] **S-3: A typed order runs and settles.** With the chip `for Wireframe` and a shape selected, type
  a fill order and submit (PATH-A).
  **Expected:** the shape's `data-wireframe-selection-fill` changes; `[data-testid="fredo-reply-surface"]`
  renders NON-EMPTY text naming the action and the app; the ticker
  (`[data-testid="fredo-order-ticker"]`) leaves `running` for `done`; the avatar's `data-state` is not
  `error`; console shows exactly one `[companion] llm-done received` for the turn.
  **Disclosure:** if the model does not select `order`, record `model-turn not exercised` and drive the
  selection with FALLBACK-F; a turn stuck on `Hung on model…` past the 15 s watchdog is a FAIL.

- [ ] **S-4: The confirmation gate is reachable and blocks.** FALLBACK-F: dispatch
  `wireframe.element.fill`.
  **Expected:** the document is UNCHANGED; `[data-testid="fredo-order-confirmation"]` is present with
  role `dialog`, `aria-modal="true"`, computed name `Confirm this order`; the ticker reads
  `data-order-state="needs-confirmation"`; focus is on Cancel. A run that changes the document with no
  dialog is a FAIL, not a fast path.

- [ ] **S-5: Evidence + telemetry receipt.** A capture from S-1/S-3 is uploaded via `upload-evidence` per
  AC, the raw URL resolves, and it is embedded in `## Tests Runs` with a textual description; the body
  also references a `telemetry_spans` query (NON-ZERO rows, recent `max(ingested_at)`) for
  `event_type='companion.injection'` against the env's PostgreSQL via the telemetry-query skill
  (`-Manifest .opencode/tmp/envs/<id>/manifest.json`). If the pool refuses `psql`, use the named
  `telemetry_get_stats` fallback and DISCLOSE.

- [ ] **S-6: Console clean across the loop.** After S-2..S-4, re-read the console.
  **Expected:** no `Error:` / `Uncaught` / `Maximum update depth exceeded` introduced by the order
  surface (the pre-existing `motion() is deprecated` WARN is exempt). A re-render loop on the ticker or
  the composer is a FAIL (the ticker renders from the module store via `useSyncExternalStore`; nothing
  polls).
