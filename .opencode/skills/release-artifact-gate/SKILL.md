---
name: release-artifact-gate
description: Runs the release-artifact gate that decides whether a produced Fredo installer may become a draft release — a live, one-pass check that the installer extracts without elevation, launches, paints a styled UI with zero CSP violations, reaches first-run DB readiness on a fresh and a pre-dirtied profile, answers one companion turn through the app, leaves the MCP bridge closed, and writes a complete evidence set. Use when a row asserts the produced installer actually works (REQ-1/REQ-2/REQ-3/REQ-4/REQ-5), when you must run the manual gate before publishing, or when a red release run needs its named cause.
---

# Release Artifact Gate

## What this is

The **release-artifact gate** is the one committed harness that turns a produced Fredo
installer (`*-setup.exe`) into a verdict, a machine receipt, and human-legible evidence --
and fails closed when the artifact does not actually work. It exists so a broken artifact
cannot reach a draft release again. It is principle 9 tooling: the scripts are the logic,
this skill is the interface. Do not improvise a launch, a CDP attach, or a receipt -- use
the committed harness.

The gate has exactly **two entries**, and they run the identical assertion set with the
same schema, the same named errors and the same verdict:

1. **CI** -- the `Gate the produced installer (live assertions)` step in
   `.github/workflows/release.yml` (`id: artifact-gate`), placed **after** the payload gate
   and the companion-model steps and **before** the only `gh release create --draft`. The
   draft step is `if: success()`, so a non-zero gate exit fails the job and leaves **no
   draft release and no uploaded asset**. A companion `Negative-control legs (fail-closed
   demonstrations)` step runs the three negative legs, and an `Upload release-gate evidence`
   step uploads the evidence directory with `if: always()` so a red run still ships its logs,
   receipt and screenshot.
2. **Manual** -- a maintainer runs the committed harness from a checkout against any
   installer, before publishing:
   ```
   powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer <setup.exe> -Mode gate -Manual
   ```
   `-Manual` prints `MANUAL_ENTRY=true` and produces the **same** assertions, the **same**
   receipt schema and the **same** evidence layout as the CI entry.

```text
.opencode/scripts/gate-release-artifact.ps1   # THE harness (CI + manual entry)
.opencode/scripts/gate-artifact-window.ps1    # the live-window hook run inside the probe
.opencode/scripts/fredo-cdp.psm1              # CDP client (HTTP /json + ClientWebSocket)
```

The harness never launches the GUI itself: it delegates launch/ports/teardown to
`launch-artifact-probe.ps1` (the single sanctioned launch primitive) and extraction/payload
checks to `verify-installer-payload.ps1`. Do not add a second launcher.

## The three modes

| `-Mode` | What it does | Exit 0 means |
|---|---|---|
| `gate` (default) | Runs every assertion in **one pass**, emits one verdict and one receipt. | Every clause green. |
| `negative` | Induces **one** known defect and checks the gate fails with the expected named error. Requires `-Negative <leg>` and `-SkipCompanion`. | The induced defect reproduced: the inner gate exited non-zero **and** emitted the expected id. |
| `selftest` | Hermetic controls; needs no installer, no model, no GUI, no network. | Every control passed. |

### The three negative legs (`-Mode negative -Negative <leg>`)

| Leg | What it induces | Expected gate failure |
|---|---|---|
| `MissingDll` | Deletes a core payload DLL from a **copy** of the extracted tree; the original tree is untouched. | `LAUNCH_EXIT:-1073741515` (`0xC0000135`) |
| `Csp` | Installs a nonce-bearing `style-src` policy in the live document (via `Page.addScriptToEvaluateOnNewDocument` + `Page.reload`), reproducing the 0.2.3 condition -- the in-gate detector control the CI step runs. | `CSP_VIOLATION:<detail>` **and** `UNSTYLED:<detail>` (an `UNSTYLED`-only observation is `NEGATIVE_WRONG_ERROR`) |
| `Database` | Seeds `<FREDO_PG_DATA_DIR>/start.log` (the probe's per-run cluster dir; the seed at `<OUTDIR>\run-dirty\postgres\cluster\start.log` equals `<FREDO_PG_DATA_DIR>\start.log`) and sets `FREDO_PG_CLUSTER_QUARANTINE_FAIL=1`. The leg's probe sets `FREDO_PG_DATA_DIR=<OUTDIR>\negative-database\run-dirty\postgres\cluster`, and the inner gate proves the EFFECTIVE dir from the product (`pg_supervisor_status.dataDir`), recording `DB_EFFECTIVE_DIR=dirty=<path>` + `NEGATIVE_LEG_EFFECTIVE_DIR=`. A shared `%APPDATA%\com.fredo.app\postgres\cluster` value is `GATE_REFUSED reason=db-isolation-shared` (an instrument refusal, never an observation). | `DB_NOT_READY:dirty` |

A negative leg prints `NEGATIVE_EXPECTED=<id>`, `NEGATIVE_OBSERVED=<ids>`, `GATE_EXIT=<n>`
and exits **0 only** when the inner gate exited non-zero **and** emitted the expected id --
otherwise `NEGATIVE_NOT_REPRODUCED` / `NEGATIVE_WRONG_ERROR` and exit 1. A leg that cannot
reproduce is a leg FAIL, never a silent skip.

**Launch seam.** The probe's `-Ports` is a **specification string** -- one or more decimal
ports separated by `,`, `;` or whitespace (e.g. `-Ports 9223,16932,19631`) -- not an
`[int[]]` array. The driver and the three negative legs pass exactly that **comma-joined**
list across the native `-File` boundary, so the seam must bind the whole list, never a
single token. If the launch **instrument** itself cannot run (a parameter-bind failure, or
a child that dies before printing a `RESULT=`/`PID=` transcript), that is a named
**refusal** -- `NEGATIVE_INSTRUMENT_FAILURE` for a negative leg, `LAUNCH_NOT_RUNNING` for
a gate run -- **never** an observation (`NEGATIVE_NOT_REPRODUCED` / `NEGATIVE_WRONG_ERROR`)
and never a pass.

The **bundle-level CSP revert** (REQ-3.2b) is a **testing-round** demonstration, not a
harness mode: build a second installer from the committed overlay
`.opencode/scripts/tauri.csp-revert.json`
(`{"app":{"security":{"dangerousDisableAssetCspModification":false}}}`) with
`tauri build --config <overlay>` -- `false` is the overlay-expressible form of "removed",
because a `--config` overlay deep-merges and cannot delete a key -- then gate **that**
installer and require `CSP_VIOLATION:` and/or `UNSTYLED:` with a non-zero exit. It
re-bundles over the shared bundle path, so it runs **last**, after the installer of record
is copied aside and its SHA-256 re-asserted. The gate itself never calls `tauri`/`pnpm`.

## Named errors (stable, greppable ids -- one class, one id)

Every failure is one machine-greppable stdout line, `ID` or `ID:<detail>`, echoed into the
receipt `errors[]`. A failure class never reuses another's id.

| Named error | Emitted when |
|---|---|
| `EXTRACT_FAILED:<detail>` | No extraction route answered / the installer is unusable. |
| `PAYLOAD_MISSING:<dll>` | A manifest core DLL is absent from the extracted installer. |
| `LAUNCH_EXIT:<code>` | The app exited inside the window (e.g. `-1073741515` = `0xC0000135`). |
| `LAUNCH_NOT_RUNNING` | No process could be launched at all. |
| `UNSTYLED:<detail>` | The styled assertion failed, **or** a frame-readiness predicate failed (`UNSTYLED:screenshot-frame S<n>=<observed>`). |
| `CSP_VIOLATION:<detail>` | One or more CSP violations were recorded in the page. |
| `DB_NOT_READY:<fresh\|dirty>` | `pg_supervisor_status.state` never reached `ready` within the bound. |
| `DB_QUARANTINE_MISSING` | The dirty run reached ready but no `<cluster>.rejected-*` sibling exists. |
| `COMPANION_NO_REPLY` | No rendered reply within `-CompanionSecs`. |
| `COMPANION_ENGINE:<code>` | The engine reported a typed failure code. |
| `MCP_PORT_OPEN:<port>` | A probed bridge port accepted a connection. |
| `MCP_BRIDGE_LOG_LINE` | `WebSocket server listening` appeared in the app log. |
| `EVIDENCE_MISSING:<name>` | A required evidence artifact is absent. |
| `CDP_UNAVAILABLE` | No DevTools target after the launch, **or** the readiness gate saw a blank/incomplete document (`CDP_UNAVAILABLE:blank-document`). An instrument class, never a style/CSP attribution. |
| `GATE_REFUSED:reason=<r> detail=<d>` | A precondition refusal that is not a section-B assertion. Reasons include `outdir-unusable` / `outdir-locked` (the evidence root could not be created/written/cleaned), `db-isolation-shared` (the product reported the shared `%APPDATA%` cluster), `db-isolation-mismatch expected=<e> observed=<o>` (the product reported a dir that is not this run's `GATE_PG_DATA_DIR`), and `host-not-settled label=<fresh\|dirty> pid=<p> cdp=<open>` (the previous launch's PID or CDP port did not clear within 30 s). Refused, exit 2 -- never a product FAIL. |
| `WEBVIEW2_MISSING` | The WebView2 runtime is absent on the host (refused, exit 2). |
| `MODEL_SET_MISSING:<file>` | The companion clause is requested but a model file is absent (refused, exit 2). |
| `CDP_PORT_IN_USE` | The DevTools port was already listening before launch (refused, exit 2). |
| `NEGATIVE_NOT_REPRODUCED` | The induced defect did not fail the gate. |
| `NEGATIVE_WRONG_ERROR` | The gate failed with a different id than expected. |
| `NEGATIVE_INSTRUMENT_FAILURE:<detail>` | A negative leg's launch **instrument** could not run (a parameter-bind failure or an empty probe transcript). A named refusal, never an observation and never a pass. |

`-SelfTest` runs one control **per** named error id, so every id above is proven to be
emitted by its own control. The round-4 controls additionally pin the profile-orchestration
classes: `OUTDIR-UNUSABLE`, `DB-ISOLATION-MISMATCH`, `BLANK-FRAME-NOT-ATTRIBUTED`,
`HOST-SETTLED`.

## Profile isolation, readiness and settle

The gate's clauses are only meaningful on a **per-run isolated** app. The launch probe sets
the product seams for every run and publishes the facts; the harness records them on stdout
and in `gate.log`:

| Fact | Meaning |
|---|---|
| `OUTDIR=<dir>` | The evidence root actually used. It is created fresh each run (default a `Get-Stamp` name) and the stale `run-fresh`/`run-dirty` dirs are removed; an un-creatable, unwritable or undeletable root is `GATE_REFUSED reason=outdir-unusable\|outdir-locked` (exit 2), never a silent reuse. |
| `PG_DATA_DIR=<path>` | The probe's per-run cluster dir (probe stdout). |
| `WEBVIEW2_USER_DATA_DIR=<path>` | The per-run WebView2 user-data folder (probe stdout). Every profile gets its own, so a lingering browser process from the previous launch cannot share the next one. |
| `OTLP_PORTS=<g>,<h>` | The free OTLP gRPC/HTTP port pair the probe bound for this run (`FREDO_INGEST_GRPC_PORT` / `FREDO_INGEST_HTTP_PORT`). A host whose usual ports are wedged still gets a run. |
| `DB_ISOLATION=<isolated\|shared\|mismatch>` | The **effective-dir proof** (G-449). The hook compares the dir the PRODUCT reports (`pg_supervisor_status.dataDir`) against the run's `GATE_PG_DATA_DIR`, never against the variable alone. |
| `DB_EFFECTIVE_DIR=<fresh\|dirty>=<path>` | The product-observed cluster dir, emitted by the hook **and** re-emitted by the driver from `cdp.json`. |
| `SETTLE_fresh=ok seconds=<n>` / `SETTLE_dirty=ok seconds=<n>` | The post-launch settle: that probe's app PID is gone and the CDP port is closed. A host that does not settle is `GATE_REFUSED reason=host-not-settled label=<fresh\|dirty> pid=<p> cdp=<open>` (exit 2). The gate never name-sweeps `fredo`/`msedgewebview2` -- a human dev instance must survive. |

The three seams the probe sets from the launch profile are `FREDO_PG_DATA_DIR` (the cluster
dir), `FREDO_PG_LOCK_DIR` (the lock dir) and `WEBVIEW2_USER_DATA_FOLDER` (the browser
profile). The hook receives `GATE_PG_DATA_DIR` (expected cluster identity),
`GATE_DB_READY_SECS` (DB-ready bound) and `GATE_BOOT_SETTLE_SECS` (readiness bound).

**A shared or mismatched effective dir is a refusal, never `DB_NOT_READY`:** the product
reaching `ready` on the shared `%APPDATA%\com.fredo.app\postgres\cluster` is an isolation
breach, so the gate exits 2 with the reason above instead of blaming the product for a state
the instrument created.

**Readiness gate.** After the reload and before the clauses, the hook waits up to
`GATE_BOOT_SETTLE_SECS` (60) for `readyState=complete` **and** `href != about:blank` **and**
`__TAURI_INTERNALS__` **and** `bodyChildren>=1`. A slow boot is therefore not a DB wedge. On
a blank frame the hook emits `CDP_UNAVAILABLE:blank-document`, records
`db.state=not-observed-blank-document`, still runs the styled/screenshot clauses (so the
readiness failure is visible as `UNSTYLED:screenshot-frame S1=...`) and **skips** the DB
clause. Attribution is earned: the styled `UNSTYLED` and `CSP_VIOLATION` ids are emitted only
from a rendered document, so the F-15b discriminator is the PAIR (a `style-src 'nonce-...'`
violation plus `emotionRules=0` on `S1=true`) -- a blank frame can never produce it.

**Window derivation.** The probe's `-WaitSecs` is the hook's `GATE_WINDOW_SECS` budget. For a
non-companion profile the driver sizes it `BootSettle(60) + DbReadySecs(180) + 30 = 270`,
capped at 360; the DB bound stays `min(DbReadySecs, available)` and is counted only from a
ready document. The post-launch settle allows up to 30 s per profile.

## The live-receipt anchor: `SURFACE_RECT=`

This plan is `live`; the gate's own executed output is the receipt. The release binary runs
no OTel producer and ships no MCP bridge, so the one live token obtainable from a produced
artifact is a real DOM measurement. When the gate captures the frame it emits, on stdout
**and** into `gate.log` and the run's `cdp.json`:

```
SURFACE_RECT=launcher-command-bar x=<n> y=<n> w=<n> h=<n> viewport=<WxH> source=getBoundingClientRect
```

with `w > 0` and `h > 0`, from a **real** `getBoundingClientRect()` call in the page. A
fabricated echo, a hardcoded literal, or a missing line is an **instrument FAIL**, never a
product FAIL. Quote it verbatim when reporting a gate receipt.

## Evidence layout (all under `-OutDir`)

Default `-OutDir` is `.opencode/tmp/release-gate/<yyyyMMdd-HHmmss>` (gitignored; CI uses
`.opencode/tmp/release-gate/ci`). All run artifacts stay under `-OutDir`/`%TEMP%` -- the
repo tree is never mutated.

```
gate.log                     # full transcript (tee of harness output; ALWAYS written)
receipt.json                 # machine receipt (schema below; ALWAYS written)
installer-payload/           # extraction work dir (verify-installer-payload.ps1 -WorkDir)
run-fresh/stdout.log         # probe -LogDir for the fresh launch
run-fresh/stderr.log
run-fresh/launch-report.log  # the probe's own stdout for that run
run-fresh/cdp.json           # per-clause CDP readings (rules, font, accent, violations, db, reply)
run-fresh/screenshot.png     # CDP Page.captureScreenshot
run-dirty/...                # same set for the pre-dirtied launch
negative-<missing-dll|csp|database>/...
```

`gate.log` + `receipt.json` are written **always**, on pass and on fail -- the red run is
the evidence of the failure.

### Receipt schema (`receipt.json`)

`verdict` is `PASS|FAIL|REFUSED`; `exitCode` duplicates the process exit code so a
downloaded artifact can be read without the console. Unset optionals are **absent keys**,
never `null`.

```json
{
  "schemaVersion": 1,
  "mode": "gate",
  "negative": "Csp",
  "manual": false,
  "startedUtc": "2026-11-20T09:00:00Z",
  "durationSeconds": 412.3,
  "installer": { "path": "...", "fileName": "Fredo_0.2.4_x64-setup.exe",
                 "sha256": "<hex>", "bytes": 123456789, "version": "0.2.4" },
  "verdict": "PASS",
  "exitCode": 0,
  "checks": [
    { "id": "REQ-2.3", "name": "UI_STYLED", "ok": true,
      "detail": "rules=612 floor=1 font=Inter accent=#8b5cf6 violations=0 injectedRules=1" }
  ],
  "errors": [ { "id": "UNSTYLED", "detail": "injected style produced 0 rules" } ],
  "cdp": { "port": 9333, "endpoint": "http://127.0.0.1:9333", "targets": 1,
           "surfaceRect": "launcher-command-bar x=140 y=780 w=640 h=56 viewport=1400x900 source=getBoundingClientRect" },
  "evidence": {
    "gateLog": "gate.log",
    "payloadWorkDir": "installer-payload",
    "fresh": { "logDir": "run-fresh", "screenshot": "run-fresh/screenshot.png", "cdp": "run-fresh/cdp.json" },
    "dirty": { "logDir": "run-dirty", "screenshot": "run-dirty/screenshot.png", "cdp": "run-dirty/cdp.json" }
  }
}
```

## Screenshot copy contract

The evidence PNG is a **viewport-only capture of the app's resting first paint (the
launcher shell)** -- `Page.captureScreenshot` captures the webview viewport only, with no
`clip`, no `captureBeyondViewport` and no `Emulation`. It is **not** a desktop, window, or
OS screenshot, and it does not show the companion unless the optional companion capture is
present. The frame is gated on the six readiness predicates (S1-S6) so it cannot be a blank
rectangle; a readiness failure captures anyway and routes to
`UNSTYLED:screenshot-frame S<n>=<observed>` (no new id).

## CDP port policy

* One port per gate run: `-CdpPort` (default **9333**), chosen outside the app's own ports
  (`9223/16932/19631`), OTLP (`4317/4318`) and Vite (`5174`) so it is never confused with a
  probed bridge port.
* Env var (exact): `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
  (append ` --remote-allow-origins=*` only if the WebSocket upgrade is rejected with an
  origin error).
* The port must be **closed before launch** (`CDP_PORT_IN_USE` otherwise, exit 2) and
  **open after** (else `CDP_UNAVAILABLE`). It is never included in `-Ports`.

## Parameters and the local `-SevenZip` override

```
-Installer <path>     produced *-setup.exe (required unless -SelfTest; a \debug\ path is refused)
-Mode gate|negative|selftest   (default gate)
-Negative MissingDll|Csp|Database   (required when -Mode negative)
-OutDir <dir>         evidence root; created FRESH each run or refused (default .opencode/tmp/release-gate/<stamp>)
-CdpPort <n>          WebView2 DevTools port (default 9333)
-WaitSecs <n>         launch observation window (default 90; 1..300)
-DbReadySecs <n>      DB-ready bound per profile (default 180; the plain window is BootSettle(60) + this + 30)
-CompanionSecs <n>    companion-turn bound (default 600)
-SkipCompanion        skip the companion clause (negative legs only -- forbidden on a canonical/AC5 run)
-SevenZip <path>      optional local 7z override, forwarded to the payload verifier
-Manual               manual entry; prints MANUAL_ENTRY=true, same assertions/receipt
-SelfTest             hermetic controls; needs no installer, no model, no GUI
```

**`-SevenZip` is a local override, never a committed literal.** CI has `7z` on `PATH`; on
a dev box whose only 7z lives outside the repo, pass `-SevenZip <path>` so the gate can
extract. The required command omits it and the verifier's own route probe answers first. A
host with no extraction route and no override is the named refusal `EXTRACT_FAILED` (exit
2), never a FAIL; a supplied-but-absent override is
`ERROR=EXTRACTOR_OVERRIDE_NOT_FOUND` (exit 2).

## Model precondition (refused, never a skip)

The companion clause needs the three-model set staged under
`{home}/fredo-models/gemma-4-e2b-it-qat/`. The models are **not** in the installer payload.
When the clause is requested and a model file is absent, the gate **refuses** with
`MODEL_SET_MISSING:<file>` and exit 2 -- a **named precondition**, never a silent skip and
never a PASS. In CI the set is a provisioned input (an `actions/cache` keyed on
`MODEL_REVISION`, with a bounded-retry download on a cache miss and a verify step that
fails closed with `::error::MODEL_PROVISION_FAILED` / `::error::MODEL_PROVISION_VERIFY_FAILED`
before the gate runs). On a dev host the absence is a named blocker, not a gate FAIL; do
**not** swap in `-SkipCompanion` on a canonical/AC5 run.

## Exit codes

| Code | `-Mode gate` | `-Mode negative` | `-Mode selftest` |
|---|---|---|---|
| 0 | PASS -- every clause green | control reproduced (gate failed with the expected id) | every control passed |
| 1 | FAIL -- at least one assertion failed (named error emitted) | control NOT reproduced / wrong id | a control failed |
| 2 | REFUSED precondition (`EXTRACT_FAILED`, `WEBVIEW2_MISSING`, `MODEL_SET_MISSING`, `CDP_PORT_IN_USE`, bad args) | same | same |
| 3 | teardown left orphans (delegated probe exit 3) | same | same |

## Discipline

* **Run it inline and expect minutes.** A canonical `-Mode gate` run is bounded at 40
  minutes (CPU engine, no GPU); a bound expiring is a named failure, never a hang. Do not
  re-run the gate per row -- one canonical run supplies the clause rows.
* **Instrument first.** A green `-SelfTest` is a precondition; a red self-test means the
  instrument is untrusted and no artifact row may be reported.
* **Repo hygiene.** Everything lives under `-OutDir`; `git status --porcelain` is empty
  before and after.
* **No telemetry dependency.** The release binary runs no OTel producer; the gate must run
  with the DB probe / OTel receivers absent, and the live receipt is the gate's own output.
