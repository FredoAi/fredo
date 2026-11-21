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

## Invocation discipline: run it INLINE, and expect minutes for the probe

Run the launch probe **inline** — a normal tool call, `$(...)`, `Tee-Object`, or `& powershell
... | ...`, with the stdout captured. That is the invocation the probe is built for, and it is
the invocation the harness gates.

- **Never "fix" a perceived hang by detaching the probe** (`Start-Process ... -RedirectStandardOutput
  $log`). The pre-fix probe hung inline callers: PowerShell 5.1's
  `Start-Process -RedirectStandardOutput/-RedirectStandardError` inherits the caller's
  stdout/stderr **pipe** handles into the GUI child, so the script printed `RESULT=PASS` and
  exited while the caller blocked to EOF on a pipe held by the leftover app/WebView2 tree.
  The GUI is now launched through an explicit detachment helper
  (`CreateProcess` with `EXTENDED_STARTUPINFO_PRESENT` + `STARTF_USESTDHANDLES` +
  `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` whitelisting only stdin=NUL / stdout / stderr), so no
  other handle crosses the process boundary. If an inline run blocks, that is a **regression**,
  not a reason to detach.
- **`-SelfTest`** (hermetic: no artifact, no model, no ports) proves exactly that — it launches a
  20-second child through the same helper, asserts the helper returns in `<= 5 s`
  (`DETACH_RETURN_SECONDS=`) with the child still alive (not killed, so a leaked handle cannot
  be masked), re-runs the three refusals as children (exit 2 + `RESULT=REFUSED`), asserts
  the GUI launch site still calls the helper, and runs the two CDP hook controls
  (`CDP-HOOK`, `CDP-HOOK-FAIL`). `SELFTEST: PASS` + exit 0; exit 3 on a control failure. Run
  it first if you suspect the instrument: `powershell -File
  .opencode/scripts/launch-artifact-probe.ps1 -SelfTest`.
- **`-ProbeOnly`** skips the GUI launch, port precheck, bridge scan and teardown and runs only
  the CLI legs (`--version`, and `-CompanionProbe` / `-RemoveDll` when supplied). Use it to
  re-run the expensive leg without spending the bounded window again. It is additive — the
  combined AC4 invocation above is unchanged — and it is refused together with `-RequireClosed`
  (which has nothing to assert without a launch).
- **Duration.** The run is two independent phases, announced by `PHASE=` markers carrying
  `SINCE_START_SECONDS`: `PHASE=launch-window` (bounded, seconds) then `PHASE=cli-legs`
  (then `PHASE=companion-probe` / `PHASE=dll-control` / `PHASE=report`). `-CompanionProbe`
  dominates wall-clock time: it is a **full model load plus one real engine turn — minutes, not
  seconds** — and the script prints
  `COMPANION_PROBE_HINT=full model load + one turn; expect minutes` immediately before it
  starts. A multi-minute wait after that hint is expected, never a hang.

## CDP port and in-window hook (`-CdpPort` / `-CdpProbe`)

A produced release build ships **no MCP bridge**, so WebView2 DevTools is the only remote
inspection route into its webview. The probe exposes it through two **additive** parameters:
the base launch contract above is unchanged, and `Start-DetachedProcess` remains the only GUI
launch primitive.

- **`-CdpPort <n>`** (default `0` / off) sets
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>` for the launched child
  (the detachment helper passes `lpEnvironment = NULL`, so the child inherits this process's
  environment — no new Win32 call) and prints `CDP_PORT=<n>`. The port is prechecked and
  REFUSED when already listening: `RESULT=REFUSED`, exit `2`, `ERROR=CDP_PORT_IN_USE port=<n>`,
  so a lingering webview can never be attributed to this launch. The CDP port is never a
  `-Ports` value.
- **`-CdpProbe <path>`** runs the hook script (`gate-artifact-window.ps1`) INSIDE the same
  bounded launch window, while the app is still running — there is no second launcher. The
  hook receives the binding environment `GATE_EXE`, `GATE_CDP_PORT`, `GATE_DATA_DIR`,
  `GATE_LOG_DIR`, `GATE_WINDOW_SECS`, `GATE_ASSERTIONS`. The probe prints
  `WINDOW_HOOK_EXIT=<n>` and `WINDOW_HOOK_SECONDS=<s>`; a non-zero hook exit folds into
  `FAILURE=window-hook:<n>` and a hook that outlives the window is killed and folds into
  `FAILURE=window-hook-timeout:<s>`. The hook's stdout/stderr are kept as
  `window-hook-stdout.log` / `window-hook-stderr.log` beside the run logs. `-CdpProbe` is
  refused together with `-ProbeOnly` (nothing is launched to run the hook inside), and a hook
  path that does not exist is refused (exit `2`).

The hermetic `-SelfTest` proves the mechanism without a GUI: controls 4 (`CDP-HOOK`) and 5
(`CDP-HOOK-FAIL`) run hermetic hooks through the same runner — control 4 asserts
`GATE_CDP_PORT` reached the hook and it exited `0`; control 5 asserts a hook exiting `1`
folds into `FAILURE=window-hook:1`.

## Examples

Static receipt:
```
powershell -File .opencode/scripts/inspect-webview-config.ps1
CHECK csp.script-src.no-unsafe-inline PASS script-src='self' blob: 'wasm-unsafe-eval'
CHECK capabilities.release-set.excludes-bridge PASS auto-includes the capabilities dir; ...
SUMMARY checks=25 passed=25 failed=0
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

Hermetic self-test receipt (seconds, no artifact, no model):
```
powershell -File .opencode/scripts/launch-artifact-probe.ps1 -SelfTest
CONTROL 1 - DETACHED-LAUNCH
DETACH_RETURN_SECONDS=0.2
DETACH_CHILD_ALIVE=True
CONTROL 2 - REFUSALS
CONTROL 3 - SELF-REFERENCE
SELFTEST: PASS
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
- **Exit 2 / `ERROR=CDP_PORT_IN_USE port=<n>`** — a lingering webview or dev instance already
  listens on the `-CdpPort` value. Stop the owner and re-run; the probe never attributes a
  pre-existing DevTools endpoint to this launch.
- **Exit 1 / `FAILURE=window-hook:<n>`** — the `-CdpProbe` hook exited non-zero, so one of its
  assertions failed. Read `window-hook-stdout.log` / `window-hook-stderr.log` in `LOG_DIR` for
  the hook's own `CHECK`/token lines; this is a named failure, never a PASS.
- **Exit 1 / `FAILURE=window-hook-timeout:<s>`** — the hook outlived the bounded launch window
  and was killed. A bounded wait expiring is a named failure; treat it as an instrument/hook
  problem, not a product PASS.
- **Exit 3 / `ORPHANS_LEFT`** — a redirected-handle holder survived teardown. Kill the named
  PIDs (`ORPHAN_POSTGRES_PIDS` / `ORPHAN_DESCENDANT_PIDS`) and disclose.
- **An inline invocation blocks after `RESULT=PASS`** — the launched GUI inherited the caller's
  stdout/stderr pipe. That is the #3172 ST-5 regression: the GUI launch must go through the
  detachment helper in `launch-artifact-probe.ps1`, never a plain `Start-Process`. Run
  `-SelfTest` (it fails `CONTROL 3 - SELF-REFERENCE` if the site reverted) and fix the launch —
  do not detach the probe to work around it.
- **`SELFTEST: FAIL` / exit 3** — a `-SelfTest` control failed: `CONTROL 1` the helper took more
  than 5 s or the child died early (the detachment, not the app, is broken), `CONTROL 2` a
  refusal stopped refusing, `CONTROL 3` the launch site no longer uses the helper. Never read a
  self-test FAIL as an artifact problem; the self-test launches no artifact.
- **Inspector FAIL** — quote the `CHECK` line. Fix the config, or update the inspector's
  expected values in the same change (a legitimate new capability file must be added to
  `-ExpectedCapabilities`). Never launch to "prove" a static value.
- `capabilities.no-installed-window-reach` FAIL — a capability's `windows`/`webviews`
  entry glob-matches an `installed-*` window label (or names the installed namespace at
  all, or the file declares no window reach so it cannot be shown to exclude it). This is
  the installed-app isolation boundary (Spec #3147 AC-2): an installed application must
  match NO capability. Fix: narrow that capability's `windows` array. Never read a FAIL
  here as "the directory gained a file" — the file count is `capabilities.expected-files`.
- **Never** use `Test-NetConnection` (stalls on CLOSED ports), `Add-Type` C# Win32, window
  enumeration, or `CopyFromScreen` for this job — that combination hung in #3077.

## Resources

- Static inspector: [inspect-webview-config.ps1](../../scripts/inspect-webview-config.ps1)
- Live probe: [launch-artifact-probe.ps1](../../scripts/launch-artifact-probe.ps1)
- Suite rows: [webview-security-boundary/functional.md](../../tests/webview-security-boundary/functional.md) — F-1, F-3, F-5, F-6, F-9, F-10
- Harness pin: `powershell -File .opencode/scripts/test-scripts.ps1` — its
  `launch-artifact-probe.ps1: -SelfTest returns inline` leg captures the self-test's stdout
  through a pipe and fails past 15 s, so an inheritance regression hangs the harness itself.
- Process cleanup: [process-hygiene.ps1](../../scripts/process-hygiene.ps1) via [dev-environment](../dev-environment/SKILL.md)
- Principles: [principles.md](../../../docs/agentic-pipeline/principles.md) — rule 9 (scripts are called through skills)
- Skill anatomy: [skill-authoring](../skill-authoring/SKILL.md)
