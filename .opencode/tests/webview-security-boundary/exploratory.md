# webview-security-boundary — Exploratory Tests

Unscripted probes for the hardened boundary. A confirmed finding **promotes** to `functional.md`
as a new `F-` row (keep the origin note). Probes are cheap live checks in the DEV instance or a
bundle — no new fixtures.

> Do not probe the admin/GitHub surface; this suite is about the webview runtime only.

## Prompts (seed probes)

- [ ] E-1: **Duplicate / conflicting permission.** Does any capability file grant a shell permission under a variant id (`shell:allow-open` vs `shell:default`, or `mcp-bridge:default` in a third file)? Read every file, not just the two known ones. EXPECT: none — a single grant anywhere re-opens the privilege.
- [ ] E-2: **ACL denial is an ACL error, not a parsing error.** Send a deliberately malformed `plugin:shell|execute` payload (missing `program`) and a well-formed one. EXPECT: both reject; the well-formed case must name the capability/ACL, proving the grant is absent rather than the args being wrong.
- [ ] E-3: **XSS-shaped inline script.** In DEV, `execute_js` a document that appends an inline `<script>` that sets `window.__xss=1`. EXPECT: in PROD-POLICY the inline script does not execute and a CSP `Refused to execute inline script` violation is logged; in DEV it does execute (`devCsp`, expected). If the production policy silently allows it, the hardening is ineffective.
- [ ] E-4: **Global handle absent in a production-policy build.** `typeof window.__TAURI__`, `typeof window.__TAURI_INTERNALS__` in the `--debug` bundle and in the release exe (via a native channel if available). EXPECT: `__TAURI__` undefined; `__TAURI_INTERNALS__` present (unconditional injection) → product IPC still works.
- [ ] E-5: **Dev override leak.** Does `pnpm --filter @fredo/tauri build` (release) pick up `tauri.dev.conf.json` in any way (a `--config` in the script, an env var, a stale `TAURI_CONFIG`)? EXPECT: no; `__TAURI__` absent in the release exe / `--debug` bundle.
- [ ] E-6: **Bridge port replay after a crash.** Kill only the DEV app (leave Vite), then relaunch `Up`. EXPECT: the bridge rebinds its recorded port (or scans and logs the new one) and the driver can attach; a killed bridge must not leave `get_pty_buffer`/`execute_js` silently dead without a log line.
- [ ] E-7: **Multiple windows, one probe each.** Run the shell-denial probe from `main`, `terminal`, `doom`, and an `app-*` window. EXPECT: denied on all four (a per-window capability scoping bug would let one window through).
- [ ] E-8: **HMR-free production policy.** In the `--debug` bundle, does any Vite/dev-only script or `@vite/client` reference remain (which would need inline script)? EXPECT: none — a prod-policy build must not depend on the dev CSP.
- [ ] E-9: **Screenshot/native channel degradation.** After the F-12 `execute_js` probe (which destroys the bridge result channel), confirm `tauri_manage_window action="list"` and a host/native screenshot still work. EXPECT: window enumeration works; document the exact tool that degrades so a later tester does not report a product defect.
- [ ] E-10: **External link double activation.** Click a link twice quickly. EXPECT: no queued second window, no duplicate shell probe, console clean (baseline parity).

_Confirmed probes promote to `functional.md`; a probe blocked by a sandbox/tooling limit is recorded `UNVERIFIED` with a named blocker — never a PASS._
