---
name: webview-security-evidence
description: Collects evidence that Fredo's Tauri webview security boundary is intact — a release artifact whose MCP bridge port stays closed, and a production CSP/capability set with no shell-exec, dev bridge, or inline-script escape. Use when a test asserts the release bridge is closed, withGlobalTauri is false, the CSP/capabilities are hardened, shell-exec is unavailable, or the webview-security-boundary rows F-1/F-3/F-5/F-6/F-9/F-10 need evidence.
---

# Webview Security Evidence

## What this skill does

Documents the two committed probes that replaced the recurring ad-hoc scripts under
`.opencode/tmp/<issue>/e2e/` (Spec #3077):

- **`inspect-webview-config.ps1`** — a read-only **static** inspector. Parses
  `tauri.conf.json`, the capability set, and the MCP-bridge plugin registration; prints one
  `CHECK <name> PASS|FAIL <detail>` line per assertion and `RESULT=PASS|FAIL`. It launches
  nothing.
- **`launch-artifact-probe.ps1`** — a **live release** probe. Launches a built exe, waits a
  bounded window, probes each port with a fast TCP connect, scans the logs for the bridge
  line, then tears the app + its embedded PostgreSQL down (no orphans).

The skill is the interface; the scripts are the logic (principle 9). Do not improvise a port
probe or a CSP parser — use these.

## When to use it

- A row asserts a **static** boundary: production CSP, `withGlobalTauri`, capability set, no
  shell permission, no `__TAURI__` global. Use the inspector + `Read`/`Grep`. **Never launch**
  for a static row.
- A row asserts a **live release** observable: the MCP bridge port is closed and no
  `WebSocket server listening` line appears. Use the launch probe on the release `fredo.exe`.
- You are about to write another release-launch / CSP-check script under `.opencode/tmp/`.
  Stop — this is the promoted tool.
- **Not for** the DEV or PROD-POLICY rows that attach the MCP driver (F-4, F-12). Those use
  `tauri_driver_session`; the launch probe deliberately refuses a `\debug\` exe.

## Procedure / Steps

1. **Static first.** Run exactly this, do not add flags:
   ```
   powershell -File .opencode/scripts/inspect-webview-config.ps1
   ```
   It covers F-1 (capability set / no shell), F-3 (bridge dev-only + plugin gate), F-6
   (no `shell:allow-open`), F-9 (CSP + `withGlobalTauri`), and F-10 (no `__TAURI__`). Exit
   `0` = all checks pass, `1` = a FAIL, `2` = the config could not be read. Quote the failing
   `CHECK` line in the verdict; do not launch to "prove" a config value.
2. **Live release probe** (only for a live release row). Build the release artifact first
   (`pnpm --filter @fredo/tauri build`), then run exactly this:
   ```
   powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe apps\tauri\src-tauri\target\release\fredo.exe -Ports 16932,9223 -RequireClosed
   ```
   - `-Exe` is the app executable, **not** the NSIS installer. A path containing `\debug\` is
     refused (exit `2`) — a production/negative AC must use the release artifact.
   - `-Ports` is a comma list. `-McpPort` (default: the first `-Ports` value) is exported as
     `FREDO_MCP_BASE_PORT`, so a release build that wrongly registered the bridge would
     target a probed port.
   - The observation window is `-WaitSecs` (default `40`). Each port is probed with
     `TcpClient.BeginConnect` + **600 ms** — never `Test-NetConnection`.
   - It scans stdout/stderr for `WebSocket server listening` and tears down the app, its
     descendant tree, and only the embedded `postgres` that appeared during this launch.
3. **Read the receipt.** A PASS needs `RESULT=PASS`, `HAS_EXITED=false`, every
   `PORT_<n>=closed`, `BRIDGE_LOG_HITS=0`, and `ORPHANS_LEFT=0`. Paste those lines into the
   `## Tests Runs` comment (with the `LOG_DIR`/`STDOUT` paths as evidence).
4. **Teardown check.** If `ORPHANS_LEFT` > 0 the probe exits `3`: run
   `powershell -File .opencode/scripts/process-hygiene.ps1 -List`, stop only the named probe
   PIDs, and disclose. Never leave the app running.
5. **Static case** = inspector + `Read`/`Grep`; no launch.

## Examples

Static receipt:
```
powershell -File .opencode/scripts/inspect-webview-config.ps1
CHECK csp.script-src.no-unsafe-inline PASS script-src='self' blob: 'wasm-unsafe-eval'
CHECK capabilities.release-set.excludes-bridge PASS auto-includes the capabilities dir; ...
SUMMARY checks=24 passed=24 failed=0
RESULT=PASS
```

Live release receipt:
```
powershell -File .opencode/scripts/launch-artifact-probe.ps1 -Exe apps\tauri\src-tauri\target\release\fredo.exe -Ports 16932,9223 -RequireClosed
...
PORT_16932=closed
PORT_9223=closed
BRIDGE_LOG_HITS=0
ORPHANS_LEFT=0
RESULT=PASS
```

## Failure modes

- **Exit 2 / `refusing a debug artifact`** — you passed a `\debug\` exe. Build release. Do
  not use this probe for F-12 (the debug-bundle driver row).
- **Exit 2 / `port <n> is already open`** — a stale app or dev instance owns the port. Run
  `process-hygiene.ps1 -List`, stop the owner, re-run. A pre-existing listener is never
  evidence for this launch and is never attributed to the artifact.
- **Exit 1 / `FAILURE=app-exited`** — the artifact did not stay running (WebView2, PG lock,
  single-instance handoff). Read `STDERR`; not a PASS. If a dev instance holds the shared PG
  cluster, re-run with `-DataDir .opencode\tmp\<issue>\probe-data` or stop the dev instance.
- **Exit 1 / `FAILURE=port-open:<n>`** — under `-RequireClosed` a probed port is open. Check
  the owner (`netstat -ano`) before blaming the product; if the probe's own app bound it,
  that is the FAIL (bridge registered in release).
- **Exit 1 / `FAILURE=bridge-log-line`** — the release build registered the bridge; a real
  FAIL (cfg regression).
- **Exit 3 / `ORPHANS_LEFT`** — a redirected-handle holder survived teardown. Kill the named
  PIDs (`ORPHAN_POSTGRES_PIDS` / `ORPHAN_DESCENDANT_PIDS`) and disclose.
- **Inspector FAIL** — quote the `CHECK` line. Fix the config, or update the inspector's
  expected values in the same change (a legitimate new capability file must be added to
  `-ExpectedCapabilities`). Never launch to "prove" a static value.
- **Never** use `Test-NetConnection` (stalls on CLOSED ports), `Add-Type` C# Win32, window
  enumeration, or `CopyFromScreen` for this job — that combination hung in #3077.

## Resources

- Static inspector: [inspect-webview-config.ps1](../../scripts/inspect-webview-config.ps1)
- Live probe: [launch-artifact-probe.ps1](../../scripts/launch-artifact-probe.ps1)
- Suite rows: [webview-security-boundary/functional.md](../../tests/webview-security-boundary/functional.md) — F-1, F-3, F-5, F-6, F-9, F-10
- Harness pin: `powershell -File .opencode/scripts/test-scripts.ps1`
- Process cleanup: [process-hygiene.ps1](../../scripts/process-hygiene.ps1) via [dev-environment](../dev-environment/SKILL.md)
- Principles: [principles.md](../../../docs/agentic-pipeline/principles.md) — rule 9 (scripts are called through skills)
- Skill anatomy: [skill-authoring](../skill-authoring/SKILL.md)
