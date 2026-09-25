# Mission Monitor — Smoke (Spec #2791 — Ghost sessions)

## Standard boilerplate

- [x] S-1 (PASS 2026-09-02 #2791): App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] S-2 (PASS 2026-09-02 #2791): No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] S-3 (PASS 2026-09-02 #2791): Feature surface reachable — Mission Monitor entry point renders its expected elements (session list + graph canvas).
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible. (NOT exercised this round — not part of the #2791 QA plan.)
- [x] S-5 (PASS 2026-09-02 #2791): Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds.

## Mission Monitor quick path

- [x] S-6 (PASS 2026-09-02 #2791): Open Mission Monitor from the maomaolabs toolbar; the session list renders.
- [x] S-7 (PASS 2026-09-02 #2791): Select a session — the canvas renders the graph (or the ghost explanatory state for a ghost session); NEVER a silent blank canvas.
- [x] S-8 (PASS 2026-09-02 #2791): Run CLI feature reachable from the desktop toolbar (`button[aria-label="Run CLI"]`) — live opencode sessions are driven through it; the `run-cli-terminal` window launches and `write_pty_input` (with trailing `\r`) submits prompts.

## Mission Monitor tool-detail quick path (Spec #2792)

- [ ] S-9 (open for #2792): Select a session with a tool call and open a tool's detail view (from the chat node's or a subagent node's `── TOOLS (N) ──` list) — the panel renders Status / Duration / Input / Output (and, for a failed call, the reason row) without console errors or layout break. `tauri_read_logs(source="console")` clean.

## Mission Monitor ghost-session follow-up quick path (Spec #2795)

- [ ] S-10 (open for #2795): Select a listed session — the canvas renders ≥1 node; NEVER a silent blank canvas and NEVER the #2791 "No graph content for this session" explanatory state.
- [ ] S-11 (open for #2795): Session list — every listed session is a real session (renders ≥1 node once its rows land); no listed session is a ghost. Cross-check `telemetry_spans` at the same instant.
- [ ] S-12 (open for #2795): Live drive — launch a session via Run CLI and confirm it appears in the sidebar and resolves to content; no ghost entry appears at any point; no real session is dropped.

## Mission Monitor realtime-data quick path (Spec #2896)

- [ ] S-13 (FAIL 2026-09-19 #2896): Open Mission Monitor with stored history — the list shows `No sessions yet` + spinner `Waiting for agent activity…` despite 29,503 canonical chat rows / 176 sessions. No persisted session renders.
- [ ] S-14 (FAIL 2026-09-19 #2896): With no session selected, `fredo emit` a `chat` event (`e2e-2896p0a1`) — the new session does NOT appear in the list; the declared table watch shows `0 delivered`; the projection failed (`no such column: sessionId`).
- [ ] S-15 (UNVERIFIED 2026-09-19 #2896 — named blocker: 0 sessions ⇒ nothing to select or switch): Select a session, switch to a second live session — no sessions exist to drive.
- [ ] S-16 (FAIL 2026-09-19 #2896): Fully restart the app and reopen Mission Monitor — `No sessions yet` again; the declared store is still 0 rows (`last_version=0`).

## Round-3 re-run (#2896, 2026-09-19, `spec/2896 @ 74449897`)

- [x] S-13 (PASS round 3): MM open with stored history lists the stored sessions (31 `.mm-session-row` in the drawer container) — no `No sessions yet`, no `Waiting for agent activity`.
- [x] S-14 (PASS round 3): with a canonical `fredo emit` mutation the declared table watch delivers `featureBatch` and the projected row appears (disposable-DB re-drive).
- [x] S-15 (PASS round 3): a session renders its Chat node on selection; declared-table `remove` re-fits the canvas (`auto-fit … epoch` console lines).
- [x] S-16 (PASS round 3): a full cold restart serves the 31 stored sessions immediately (`backfill_done=1`; no backfill re-drain in the log; only `persisted declared tables re-materialized tables=1`).

## Mission Monitor multi-CLI quick path (Spec #2945)

- [x] S-17 (PASS 2026-09-25 #2945 round 1): MM opened from the launcher ("Mission Monitor"); the session list rendered its usual entries (list + `Sessions` drawer chrome unchanged) with no `Error:`/`Uncaught`/`Maximum update depth exceeded` in the webview console.
- [x] S-18 (PASS 2026-09-25 #2945 round 1): with a live OpenCode session + a Copilot split-turn fixture in one store, every row showed a non-blank CLI chip (`◈OpenCode`, `◆GitHub Copilot`, `?Unknown CLI`); selecting the Copilot session rendered chat node + `── TOOLS (1) ──` + `── RESPONSE ──` at the same structural detail as OpenCode. `telemetry_spans` + `chat_rows` cross-checked at the same instant.
- [x] S-19 (PASS 2026-09-25 #2945 round 1): the selected session's header chip matched its list row (`◈OpenCode` / `◆GitHub Copilot`); a `provider = unknown` session showed the explicit `?Unknown CLI` fallback (non-blank, dashed warning border) and was never presented as OpenCode.
- [x] S-20 (PASS 2026-09-25 #2945 round 1): `pnpm --filter @fredo/ui build` clean (2594 modules, zero TS errors); the Rust rollup/registry was touched → `cargo check --locked` + `cargo clippy --locked -- -D warnings` + `cargo test --locked` (950 lib + integration) all green.
