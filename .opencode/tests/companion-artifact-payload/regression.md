# Companion Artifact Payload — Regression

> "Must not change" baseline for the installer-payload work (Spec #3158). Every row is an invariant
> the payload change must not disturb. This domain is a **packaging/config + artifact** domain, so
> the verification policy is **static** (artifact and source receipts, no webview, no telemetry
> producer on an installed release build).
>
> **Command notation:** `RC("<cmd>")` =
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"` (prints the output plus
> `EXITCODE=<n>`). Non-git verbs (`Get-Item`, `Get-ChildItem`, `New-Item`, `Copy-Item`,
> `Remove-Item`, `Select-String`) are **not** independently allowlisted for the tester — call them
> inside `RC(...)` or inside a `.opencode/tmp/3158/*.ps1` script. A bare invocation is a sandbox
> refusal, never a product signal. `cargo nextest` is likewise **not** allowlisted — use
> `cargo build --tests` / `cargo check` for local compile legs, with the CI `rust-validate` nextest
> run as corroboration.
>
> **Cross-suite links — everything here MUST also run:**
> - `.opencode/tests/companion-embedded-engine/` — the in-process engine's own behaviour (its F-2 row
>   pins `bundle.externalBin == []`; F-27 there is the additive payload row this spec adds — F-2 must
>   survive **byte-identical**).
> - `.opencode/tests/release-pipeline/` — the release line's workflow/config contract (`release.yml`
>   triggers, CODEOWNERS, the build-only `tauri-apps/tauri-action` step + the single draft publish). The
>   build-only → locate → gate → single-draft-publish sequence must be ADDITIVE to the
>   trigger/CODEOWNERS contract.
> - `.opencode/tests/ci-pipeline/` — the `validate` merge gate on `main`.
> - `.opencode/tests/llama-setup/` and `.opencode/tests/setup/` — model acquisition/readiness (the
>   GGUF trio stays OUT of the payload).

## R-1 — `bundle.externalBin` stays `[]` (no shipped sidecar) — pinned, not weakened

- [ ] **R-1.** Read `apps/tauri/src-tauri/tauri.conf.json`; read
      `apps/tauri/src-tauri/tests/companion_teardown.rs`; and
      `RC("cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml --locked --tests -j 2")`.
  - **Expected:** `bundle.externalBin` is exactly `[]`; the committed pin
    `the_bundle_external_bin_stays_empty` (`tests/companion_teardown.rs:294-304`) still exists with its
    **unchanged** assertion message ("`bundle.externalBin` must stay `[]` — there is no shipped
    llama-server sidecar"); `EXITCODE=0` (the pin compiles).
  - **Edge (drivability, stated so this is not a false FAIL):** `cargo test --test
    companion_teardown` **cannot be relied on from this shell** — `dynamic-link` means every test
    binary statically imports the ggml/llama DLLs, and the test binary lives in `target/debug/deps`
    while the DLLs are in `target/debug` (the exact failure `validate.yml:195-218` documents), so the
    loader reds with `0xc0000135` before the test body runs. The row's ground is therefore the
    **source read of the pin** plus its compilation; the executed green is the CI `rust-validate` run
    (`cargo nextest`), cited as corroboration. A missing pin or a weakened assertion message ⇒
    **FAIL**.
  - **Why:** the payload is delivered as **resources**, not as sidecar binaries. Turning the DLLs into
    `externalBin` entries would be a different mechanism (and would change the loader's search
    semantics). The pin existing and passing is the invariant.

## R-2 — No `llama-server` process, no loopback HTTP transport (retained)

- [ ] **R-2.** After F-4's probe turn and after any GUI launch in this round, list the process table
      (`RC("powershell -File .opencode/scripts/process-hygiene.ps1 -List")`) and read
      `docs/SECURITY.md` + `docs/ARCHITECTURE.md` for the no-child-process/no-socket claim.
  - **Expected:** no `llama-server` image in the process table at any sample; the docs still state
    **no child process and no loopback HTTP transport** for companion inference; the payload change
    adds none.
  - **Edge:** the payload files must not be accompanied by a spawned executable — a payload that
    *requires* a helper process is a mechanism change and a **FAIL**.

## R-3 — Model/GGUF contract untouched (the model stays OUT of the payload)

- [ ] **R-3.** Read `apps/tauri/src-tauri/src/infrastructure/companion/models.rs`'s compiled
      `DEFAULT_MANIFEST` and `.opencode/scripts/payload-manifest.json`.
  - **Expected:** the manifest still declares exactly **three** GGUF specs
    (`gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` / 2,620,370,976; `mmproj-BF16.gguf` / 986,833,728;
    `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf` / 59,235,648) under subdir `gemma-4-e2b-it-qat`; the
    payload manifest lists **no `.gguf`** file; the payload file count is `<= 14`.
  - **Edge:** a `.gguf` appearing in the payload manifest ⇒ **FAIL** (out of scope; ~3.66 GB; the
    issue puts model/GGUF changes out of scope).

## R-4 — Release-line contract unchanged (the gate step is ADDITIVE)

- [ ] **R-4.** Read `.github/workflows/release.yml`.
  - **Expected:** `on.push.branches` is still exactly `['release/stable']` (+ `workflow_dispatch`);
    no `pull_request` trigger and no `main` trigger; every `uses:` still SHA-pinned;
    `pnpm install --frozen-lockfile` present; `projectPath: apps/tauri/src-tauri` unchanged; the
    SHA-pinned `tauri-apps/tauri-action` step carries **no** `tagName`, `releaseName`, `releaseBody`,
    `releaseDraft` or `releaseId` (build-only ⇒ no release call — moving `tagName: app-v__VERSION__` /
    `releaseDraft: true` **off the action** is the fix, not a regression); strictly **after** it, a
    **locate** step for the newest `apps/tauri/src-tauri/target/release/bundle/nsis/*-setup.exe`
    (taken from `steps.tauri.outputs.artifactPaths`, newest-by-mtime directory fallback) and exactly
    **one gate** step that invokes `verify-installer-payload.ps1` and fails the job with
    `::error::PAYLOAD_INCOMPLETE_IN_ARTIFACT`; the workflow's **only** publish step is a later
    `gh release create "app-v<version>" <installer> --draft` guarded by `if: success()`.
  - **Edge:** a `tagName`/`releaseName`/`releaseBody`/`releaseDraft`/`releaseId` present on the
    `tauri-action` step ⇒ **FAIL** (that is the `app-v0.2.0` mode: the draft is created inside the build
    step, before any gate). A gate step placed **before** `tauri-action` ⇒ **FAIL** (nothing to gate
    yet). An unpinned action or a changed trigger ⇒ **FAIL**. A publishing step other than the single
    `gh release create "app-v<version>" <installer> --draft`, or one not guarded by `if: success()`
    ⇒ **FAIL** (out of scope).

## R-5 — Main's `validate` gate and CODEOWNERS unchanged

- [ ] **R-5.** Read `.github/workflows/validate.yml` and `.github/CODEOWNERS` against the `main` tip.
  - **Expected:** `.github/CODEOWNERS` still carries `* @pktron`; `validate.yml` main-PR behaviour is
    byte-identical (the only legitimate `release/stable` addition is already there from #2803); no new
    main-gating check is introduced by this spec.
  - **Edge:** a new required check on `main` ⇒ **FAIL** (cross-ref `release-pipeline/regression.md`
    R-1/R-2 and `ci-pipeline/regression.md`).

## R-6 — Ordinary builds stay green (pristine and shared-target)

- [ ] **R-6.** `RC("cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked")`, on a tree
      where `engine-payload/` exists but is empty (F-27 covers the empty case explicitly).
  - **Expected:** `EXITCODE=0`; no `GlobPathNotFound`; no `ResourcePathNotFound`.
  - **Edge:** the design's whole reason for a **directory** entry (not a glob, not a named file) is
    this row — a red here means the resource entry's shape regressed (Architect §Domain Model 2).

## R-7 — No config rewrite during build (the `.bak` hazard stays gone)

- [ ] **R-7.** After any build in this round:
      `RC("Test-Path 'apps\tauri\src-tauri\tauri.conf.json.bak'")` and read
      `apps/tauri/src-tauri/build.rs`.
  - **Expected:** `False`; `build.rs` performs **no** read/write/rename of `tauri.conf.json` at all
    (no `fs::rename`, no `fs::write` of the config, no `.bak` path).
  - **Edge:** any surviving rewrite ⇒ **FAIL** — a build killed mid-rewrite leaves the tree with a
    mutated config plus a stray backup (the hazard ST-1 removes).

_Evidence convention: pass cases keep `- [x]` and append the file:line or command output observed;
fail cases leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro._
