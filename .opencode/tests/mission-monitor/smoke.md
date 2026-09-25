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

- [ ] S-17 (open for #2945): Open Mission Monitor — the session list renders with its usual entries; the sidebar/drawer chrome is unchanged and no console error appears.
- [ ] S-18 (open for #2945): With both an OpenCode and a Copilot-shaped session present, each list row shows a non-blank CLI label; selecting the Copilot session renders its activity (chat node + tools or zero-tools) at the same structural detail as an OpenCode session. Cross-check `telemetry_spans` at the same instant.
- [ ] S-19 (open for #2945): The selected session's header shows the same CLI label as its list row; a session with `provider = unknown` shows the explicit non-blank fallback and is not presented as OpenCode.
- [ ] S-20 (open for #2945): UI build gate — `pnpm --filter @fredo/ui build` completes clean (TypeScript zero errors); if the Rust rollup/declaration is touched, `cargo check` + `cargo clippy --locked -- -D warnings` are clean.
