# navigation-fleet — Exploratory

Feature: NavigationEngine P7 fleet migration (Spec #3121). Unscripted probes beyond the QA Plan,
scoped to the FIVE migrated surfaces (terminal, window traversal, mission-monitor, SQL Studio,
dev-mode). A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin
note). Do not write pass/fail thresholds here; record what you did and what you saw.

## Prompt lines

- Terminal passthrough under stress: rapid key repeat, a held key, `Ctrl+C` mid-command, an
  `\x1b[A` arrow sequence split across frames, IME composition, paste. Does any keystroke get
  swallowed or duplicated? Does `data-fredo-passthrough` ever flicker false while the PTY still has
  focus?
- Terminal focus transitions: click into the PTY, then directly onto a rail row, then back into the
  PTY. Is there exactly one enter/exit pair? Does the rail's verb list ever stay at the session place
  after focus left? Does `F2` behave differently when the selected session has no persisted record?
- Window traversal: three windows with one maximized, one minimized, one focused. Does
  `Ctrl+Tab`/`Ctrl+Shift+Tab` ever land focus on `body` or on a window that is not raised? Does the
  launcher toggle while a modal is open? Does the floating dock ever swallow a click intended for the
  window underneath?
- Mission Monitor: collapse the drawer, press `s`, expand it, press `s`. Does the collapsed case stay
  inert, and does the expanded case focus the input without a stale journal entry? With a detail
  panel open, does `Escape` close it once (no double pop when the cursor is in `mission-monitor.detail`)?
- SQL Studio: select a connection, then a different connection, then a table, then a result-set tab.
  Does each selection flip only its own map rows (connection vs table vs resultSet) with no remount and
  no cursor move? Press `Ctrl/Cmd+Enter` while the autocomplete popup is open — does Enter accept the
  option instead of running? Open two tabs, close the active one — does the remaining tab keep its SQL
  and results? Does `history.clear` still require the shipped confirmation?
- SQL Studio error paths: a failed connection, an empty result set, a cancelled destructive confirm,
  a load-more with no further pages. Does the map availability stay truthful and the dispatch become a
  noop (never a toast/banner the legacy flow did not show)?
- Dev Mode: complete the 10-key Konami on Home, then press a wrong key mid-sequence. Does the
  sequence reset without opening a window? Zero events → press `x`; then generate events and press `x`
  in the Application Data view; then press `b` twice; then press `v` in the Application Data view. Are
  all inert/acting cases distinguishable (no journal entry on noop, `v` a visible no-op there)?
- Cross-app: mount two migrated apps at once (dev-mode via Konami + mission-monitor), then read
  `listRegisteredSurfaces()` / `describeContext` for each. Any cross-contamination of appId, verbs or
  selection? The retired application trees are deleted in P8, so there is no frozen-app surface left
  to interact with the migrated ones (the 8-id boot set is pinned by `retainedApplicationSet.test.ts`).
- Accessibility: with a rail row focused, press `Tab`/`Shift+Tab`. Does focus leave the app window
  or loop? Does the map close and restore the invoker? Does the window dock expose distinguishable
  `Command bar` landmarks?
- Theme + reduced motion: both themes, dark accent, `prefers-reduced-motion: reduce`. Does the rail
  restyle with tokens only and animate opacity/transform only?
- Long-running: leave the app open ~10 minutes with a streaming agent. Does the rail/trail stay
  bounded (≤8 rows, ≤10 entries) and the terminal stay responsive?
