# multi-env-isolation — Smoke

Quick app-boot + core-path sanity for the multiple-isolated-environments feature (#2944). Full
detail lives in `functional.md`.

> **Verification policy: LIVE** — a live receipt (per-env DB row, process/port list, DOM +
> screenshot) is required for a live verdict; a static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** envs are started/stopped ONLY through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -EnvId <id>`. Time-bound every
> leg; never run an unbounded binary.

## Standard boilerplate

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>` (per env).
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded` (check again after event injection).
- [ ] **S-3:** Feature surface reachable — Mission Monitor's entry point renders its expected elements (session list + graph canvas) in each env.
- [ ] **S-4:** Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2944/e2e/smoke.jpeg")` succeeds.

## Multi-env quick paths

- [ ] **S-6:** Start env A and env B concurrently — each env's Vite / MCP / OTLP gRPC / OTLP HTTP endpoints respond on its own port, and the two port sets are disjoint.
- [ ] **S-7:** Down env A — env B's endpoints stay reachable and B's PIDs/DB are intact; no global image-name kill is observed.
- [ ] **S-8:** Mission Monitor renders a live session / tools / tokens from each env's own store (functional F-6) — cross-check that env's DB at the same instant.

## Smoke-level pass/fail

PASS = S-1..S-3 and S-6..S-8 green; S-4/S-5 green or a named blocker. Any cross-env bleed, any
cross-env kill, a silent port fallback, or an unbounded wait = **FAIL**.
