# Companion Artifact Payload — Exploratory

> Unscripted edge/failure probes for the installer-payload work (Spec #3158). Confirm a finding, then
> **promote** it to `functional.md` as a new `F-` row (keep the origin note). A confirmed defect is a
> `## Tests Runs` FAIL; a probe that cannot be driven is a **named blocker**, never a PASS.
>
> Verification policy: **static** (artifact + process-execution receipts — script `PAYLOAD_*` /
> `RESULT=` / `EXITCODE=` lines, the probe's JSON stdout, directory enumerations, SHA-256). No
> `tauri_webview_*` probe: the installed release build registers no MCP bridge
> (`src/lib.rs:197-207`).

- **E-1 — no extractor at all.** On a shell with neither `7z` on `PATH`, nor
  `$env:ProgramFiles\7-Zip\7z.exe`, nor a working NSIS `/S /D=` silent install, run
  `verify-installer-payload.ps1` (F-10). Record `EXITCODE=2` + `ERROR=EXTRACTOR_MISSING` as a
  **named blocker** for artifact presence — never "verify" by reading a build log. Does the script
  name *which* probes it tried? A silent exit-2 with no probe list is a finding (promote to F-10's
  edge).

- **E-2 — model files absent.** On a host where `{home}\fredo-models\gemma-4-e2b-it-qat\` lacks the
  three GGUFs, run the probe (F-4). Record the typed `code` (`modelMissing` / `mmprojInitFailed` /
  `mtpInitFailed`) and the `detail` text. This is a **precondition blocker**, not an artifact FAIL.
  Probe also: exactly ONE file missing (does `detail` name only that one?); a GGUF present at the
  **wrong size** (does the engine refuse typed rather than load a truncated file?).

- **E-3 — the Vulkan loader is undiscoverable.** Run
  `stage-engine-payload.ps1 -Profile release -VulkanLoader 'C:\no-such\vulkan-1.dll'`. Expect
  `ERROR=VULKAN_LOADER_NOT_FOUND searched=<list>` + `EXITCODE=1`. Probe also: `$env:VULKAN_SDK`
  pointing at a real directory whose `runtime\` subtree has no `x64` dir — does the candidate set
  still find `$env:SystemRoot\System32\vulkan-1.dll`, and does it say which candidate answered?

- **E-4 — a stale `engine-payload/` from a previous run.** Leave a **foreign** file (e.g. a copied
  `ggml-cuda.dll`) in `apps\tauri\src-tauri\engine-payload\`, then run F-18. Does the staging pass
  remove it (all-or-nothing stage-then-rename) so exactly the allowlist remains? A surviving foreign
  file ⇒ the idempotence contract is broken (promote).

- **E-4b — an interrupted staging run.** Kill the staging script mid-copy (or make `-OutDir`
  read-only for one file). Is the previous good `engine-payload/` left intact (the sibling-temp +
  rename discipline), or is it half-written? A half-written dir that a subsequent bundle would ship
  is a **finding** — the whole point of the all-or-nothing rename.

- **E-5 — the probe with no GUI app running, from a directory with a hostile cwd.** Run F-14 from a
  cwd that also contains a *decoy* DLL set (a stale `ggml-base.dll` from an older build in the cwd).
  The loader searches the exe's own dir first — so the decoy must NOT be picked up. If the probe
  loads the decoy (a version-mismatched engine), that is a **finding** about the payload's trust
  boundary.

- **E-5b — a partial install (a single core DLL deleted, other than `ggml-base.dll`).** Delete
  `ggml-vulkan.dll` from the disposable tree and run the probe. Record what happens: a loader
  `0xC0000135` (static import miss), or an engine start failure with a typed code, or — worst — a
  silent CPU fallback that reports `success: true`. The last one is a **blocker-class finding** (the
  product would claim a payload it does not have).

- **E-6 — the produced installer cannot be obtained this round.** If neither a local
  `pnpm --filter @fredo/tauri build` nor a `workflow_dispatch` run of `release.yml` on the release
  line yields an installer, record the blocker in this exact shape: *"the artifact leg is NOT RUN:
  no installer could be produced this round (producer = local build, attempt: <what failed>; and
  `workflow_dispatch` of `release.yml` on `release/stable`, not attempted / attempted with outcome
  <x>). A build log is not a substitute. Presence stays UNVERIFIED until an installer is produced on
  a host where the Vulkan SDK lookup succeeds."* Do **not** substitute `cargo run`, `pnpm
  dev:tauri`, `pnpm dev:tauri:release`, a `target/<profile>` run, or a build-log line.

- **E-7 — the release gate step's own failure mode.** Read the gate step in `release.yml` and ask: if
  `verify-installer-payload.ps1` exits 2 (`EXTRACTOR_MISSING`) on the `windows-latest` runner, does
  the job fail, or does a `$LASTEXITCODE` check pass it through? A gate that treats exit 2 as
  success would let an unverified artifact publish — a **blocker-class finding** (promote to F-22).

- **E-8 — payload growth.** Record the measured `PAYLOAD_TOTAL_BYTES` and the installer `Length`.
  Compare them for context only: the compressed installer vs the uncompressed tree is a
  cross-artifact-class comparison, so against the `45,646,403` B install-tree baseline the delta is
  **negative** (measured 18,853,619 B vs 111,806,850 B) and is never a defect. Do **not** assert a
  ceiling (the carried #3141 ceiling is an open human question). If growth is surprising
  (> 2× the payload's file sizes, or dominated by one unexpected file), report the per-file
  breakdown so the human can size the ceiling.

- **E-9 — the six `llama-*-impl.dll` tool modules.** Measure the PE import closure: are any of the
  six tool modules imported by `ggml.dll` / `llama.dll` / `mtmd.dll` / `fredo.exe`? If none is, the
  payload could shrink by dropping them — record the measurement (do NOT change the shipped
  allowlist in a testing round; the trim is a one-line list edit for a later decision).

- **E-10 — the uninstall path.** After the silent install (F-3), run `uninstall.exe` and check the
  `$INSTDIR` is empty of payload files and the HKLM `PATH` entry is removed
  (`nsis/installer-hooks.nsh:9-13`). Orphaned DLLs or a stale `PATH` entry is a finding.
