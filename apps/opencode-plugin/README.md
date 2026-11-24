# `@fredo/fredo-opencode-plugin`

The Fredo OpenCode plugin. It runs inside the OpenCode **V2** plugin host and exports OTLP
traces, metrics and logs to Fredo's receiver, so every OpenCode session — launched by Fredo or
by an external TUI — lands in Mission Monitor and session history.

- **V2-native.** The module default-exports `Plugin.define({ id: "fredo", setup })` and consumes
  the host's event stream through `ctx.event.subscribe`. There is no V1 hooks-object export, no
  V1 shim and no dual export.
- **Default-on, opt-out.** With no telemetry variable set, a session is captured. The opt-out is
  `FREDO_TELEMETRY=0` (also `false` / `off`); `OPENCODE_ENABLE_TELEMETRY=0`/`false` also disables;
  the plugin option `enabled: false` takes precedence over both.
- **Endpoint.** `http://localhost:4317` over gRPC by default; override with
  `OPENCODE_OTLP_ENDPOINT` / `OPENCODE_OTLP_PROTOCOL` or the matching plugin options.

## Build

Run from the repo root:

```powershell
pnpm --filter @fredo/fredo-opencode-plugin build
```

The build is the single `bun build src/index.ts --outdir dist --target bun` script and produces
**`apps/opencode-plugin/dist/index.js`** — the one artifact the Setup path installs and that
`#3198` consumes. Unit tests: `pnpm --filter @fredo/fredo-opencode-plugin test`.

## Install (native path only)

Install the built artifact through Fredo's own setup path — **Setup → SetupWizard** /
`install_plugin`. The target is the flat global plugin file
`~/.config/opencode/plugins/fredo.js`.

**Never copy `dist/index.js` into the plugins directory by hand.** A filesystem copy bypasses the
install step's own behaviour and makes the currency proof below meaningless; the app's
`install_plugin` command is the only sanctioned install route.

## Byte-currency proof

After installing, prove the installed file is the artifact you just built:

```powershell
Get-FileHash ~\.config\opencode\plugins\fredo.js
Get-FileHash apps\opencode-plugin\dist\index.js
```

The two hashes must be **equal**. Never grep or otherwise inspect the `~` plugin path — it is
outside the repo, and reading it tells you nothing about its bytes.

## Verify a session landed

Run a session (an external `opencode` session for the external leg), then query the isolated
environment's store through the telemetry skill:

```powershell
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Query "SELECT span_name, status_code, attributes_json::jsonb ->> 'gen_ai.operation.name' AS op, end_time_ns FROM telemetry_spans WHERE session_id='<sid>' ORDER BY start_time_ns" -Manifest .opencode/tmp/envs/<envId>/manifest.json -Format md
```

A captured session carries `fredo.session` (session/turn root), `fredo.llm` (model step) and
`fredo.tool.<name>` (tool call) rows, each with a non-null `gen_ai.operation.name`. A plugin that
did not load produces **zero rows** — an empty Mission Monitor is never evidence of health; the
producer-side rows are.

Useful lever: `FREDO_CAPTURE_EVENTS=<path>.jsonl` (default off) appends one `{ type, event }`
JSON line per received V2 event — the way to capture real payload shapes or failure-path evidence.
