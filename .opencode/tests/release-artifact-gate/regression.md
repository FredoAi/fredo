# Release Artifact Gate — Regression

> "Must not change" baseline for Spec #3181 (the release-gate harness + its `release.yml` wiring).
> Every row is an invariant the new gate must not disturb. This suite **extends**, never
> supersedes, `.opencode/tests/companion-artifact-payload/` (payload + probe),
> `.opencode/tests/release-pipeline/` (draft-publish contract) and
> `.opencode/tests/webview-security-boundary/` (release bridge closed) — no row here restates
> another suite's observable with a different literal (G-444).
>
> **Command notation:** `RC("<cmd>")` =
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"`. Non-git verbs go inside
> the wrapper or inside a `.opencode/tmp/release-gate/*.ps1` script run with
> `RC("powershell -NoProfile -File .opencode/tmp/release-gate/<name>.ps1")`. No `..`, no `|`,
> no `;`, no `&`.
>
> **Cross-suite runs — everything here MUST also run:** `companion-artifact-payload/regression.md`
> (R-4 payload-gate ordering, R-8 control counts), `release-pipeline/regression.md` (R-3/R-4
> trigger + draft contract), `webview-security-boundary/functional.md` F-5 (release bridge closed),
> `ci-pipeline/regression.md` (the `validate` merge gate).

## R-1 — The payload gate is untouched and still runs FIRST

- [ ] **R-1.** Read `.github/workflows/release.yml` around the gate steps; and
  `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'PAYLOAD_GATE=PASS'")`,
  `-Pattern 'verify-installer-payload.ps1 -SelfTest'`,
  `-Pattern 'stage-engine-payload.ps1 -SelfTest'`.
  - **Expected:** the `Verify installer payload` step (`id: gate`) is byte-identical in behaviour:
    the static `LLAMA_OPENSSL = "OFF"` assert, both instrument self-tests, the produced-installer
    verification, and the final `PAYLOAD_GATE=PASS` line; it still runs **before** the new
    `Gate the produced installer (live assertions)` step; the new gate adds no second payload
    check and does not relax any `ERROR=PAYLOAD_INCOMPLETE_IN_ARTIFACT` line.
  - **Edge:** the new gate placed **before** the payload gate ⇒ **FAIL** (the payload gate owns
    the artifact-completeness class; the new gate owns the runtime class). A removed
    `PAYLOAD_GATE=PASS` or a removed self-test invocation ⇒ **FAIL**.

## R-2 — Runner pin, Vulkan provisioning and SHA-pinned `uses:` unchanged

- [ ] **R-2.** Read `.github/workflows/release.yml`.
  - **Expected:** `runs-on` is still `windows-2022` (the pin is load-bearing: `windows-latest`
    ships VS 18 whose STL hard-fails `llama-cpp-sys-4`'s bindgen); the Vulkan provisioning step
    keeps `cache: false` and `install_runtime: true`; every `uses:` (existing **and** the new
    `actions/upload-artifact`) is a 40-hex SHA pin; `pnpm install --frozen-lockfile` present.
  - **Edge:** `windows-latest` ⇒ **FAIL**; Vulkan `cache: true` ⇒ **FAIL** (a cache hit skips the
    install and leaves no `vulkan-1.dll` for the payload); any `@vN` tag ⇒ **FAIL**.

## R-3 — The single draft publish and its fail-closed guard unchanged

- [ ] **R-3.** Read `.github/workflows/release.yml`; and
  `RC("Select-String -Path '.github/workflows/release.yml' -Pattern 'gh release create'")`.
  - **Expected:** exactly ONE `gh release create "app-v$VERSION" <installer> --draft` (the
    workflow's only publish step), still guarded `if: success()`, still after the new gate and the
    negative-control legs; the cleanup step still reads
    `if: failure() && steps.draft.outcome == 'failure'`; no `--draft` removal, no `--auto`.
  - **Edge:** a second publish step (or a `tauri-action` release input) ⇒ **FAIL** (the 0.2.0
    mode); `if: success()` dropped ⇒ **FAIL**; the cleanup condition widened to `if: always()` ⇒
    **FAIL** (it would run on a gate failure and mask the no-draft proof).

## R-4 — Product config and product code unchanged (no version bump, no CSP change)

- [ ] **R-4.** Read `apps/tauri/src-tauri/tauri.conf.json`.
  - **Expected:** `version` is still `0.2.4`; `app.security.csp` and
    `app.security.dangerousDisableAssetCspModification: ["style-src"]` are **unchanged**;
    `withGlobalTauri: false`; `bundle.resources` is still the `{"engine-payload/": ""}` map;
    `bundle.externalBin` is still `[]`; `bundle.windows.nsis.installMode` is still `perMachine`;
    `build.beforeBundleCommand` still points at `../../.opencode/scripts/stage-engine-payload.ps1`
    (`-Profile release`).
  - **Edge:** a version bump ⇒ **FAIL** (this spec ships no product change); removing
    `dangerousDisableAssetCspModification` in the committed config ⇒ **FAIL** (the REQUIRED F-15b
    leg applies the committed overlay `.opencode/scripts/tauri.csp-revert.json` through
    `--config` at build time — the shipped config is never edited, and no overlay is applied to the
    artifact of record); `withGlobalTauri: true` ⇒ **FAIL** (the gate's page-evaluated route assumes
    `__TAURI_INTERNALS__`).

## R-5 — Existing instrument control sets stay intact (extension is additive)

- [ ] **R-5.** `RC("powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -SelfTest")`
  and `RC("powershell -NoProfile -File .opencode/scripts/stage-engine-payload.ps1 -SelfTest")`;
  read `.opencode/scripts/test-scripts.ps1`'s asserted control-name lists.
  - **Expected:** the verifier keeps `CONTROL 1 - PASS-ON-COMPLETE` … `CONTROL 8 - ARTIFACT-IMPORT-GAP`
    under their unchanged names and assertions and gains the new control (9) for the `-SevenZip`
    override ordering / not-found refusal; the stager keeps its 11 controls unchanged; both print
    `SELFTEST: PASS` with `EXITCODE=0`.
  - **Edge:** a renamed or dropped pre-existing control ⇒ **FAIL**; a weakened assertion ⇒ **FAIL**;
    the `-SevenZip` route becoming the DEFAULT route (rather than first-among-routes when supplied)
    ⇒ **FAIL**.

## R-6 — The single GUI launch primitive survives (no second launcher)

- [ ] **R-6.** `RC("powershell -NoProfile -File .opencode/scripts/launch-artifact-probe.ps1 -SelfTest")`;
  read `.opencode/scripts/launch-artifact-probe.ps1`.
  - **Expected:** `SELFTEST: PASS` with the three original controls (including the inline-handle
    inheritance control) green plus the two new controls (4 `CDP-HOOK`, 5 `CDP-HOOK-FAIL`); the
    source still carries `Start-DetachedProcess` as the only GUI launch,
    `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, `EXTENDED_STARTUPINFO_PRESENT` and `STARTF_USESTDHANDLES`;
    `-CdpPort`/`-CdpProbe` are **additive** and the existing `-ProbeOnly`/`-RemoveDll`/`-SanitizePath`
    semantics are unchanged.
  - **Edge:** a second spawn path for the app (a `Start-Process`/`Process::Start` outside the
    primitive) ⇒ **FAIL** (re-introduces the #3172 ST-5 inheritance hang); the hand-off of
    stdin/stdout/stderr no longer whitelisted ⇒ **FAIL**; `-CdpPort` sharing a probed bridge port
    (`9223`/`16932`/`19631`) ⇒ **FAIL**.

## R-7 — The webview-security-evidence skill's pinned tokens stay green

- [ ] **R-7.** `RC("powershell -NoProfile -File .opencode/scripts/test-scripts.ps1")` and read
  `.opencode/skills/webview-security-evidence/SKILL.md`.
  - **Expected:** the existing token pins for that skill still pass (the harness leg list includes
    them), and the skill documents the **new** `-CdpPort`/`-CdpProbe` contract **additively** —
    no previously pinned sentence is deleted or reworded out of the pin set.
  - **Edge:** a skill edit that unsets a pinned token ⇒ **FAIL** (the harness leg reddens); the
    new parameters documented as mandatory (rather than optional, default off) ⇒ **FAIL**.

## R-8 — No product source change (Rust/React untouched)

- [ ] **R-8.** `RC("git diff --name-only main HEAD")` (two-endpoint form — a `...` range is refused
  by the sandbox) on the spec branch.
  - **Expected:** every changed path is under `.opencode/**`, `.github/workflows/release.yml`, or
    `docs/release-process.md` (optionally `docs/SETUP.md`/`docs/FAQ.md` gate paragraphs). **Zero**
    paths under `apps/**`.
  - **Edge:** any file under `apps/` ⇒ **FAIL** (this spec is tooling + CI only); a change to
    `AGENTS.md` or `opencode.json` outside the machine-editable `permission` blocks ⇒ **FAIL**
    (human-owned).

## R-9 — Cross-suite invariants still hold on the same tree

- [ ] **R-9.** Run the overlapping rows: `companion-artifact-payload/functional.md` F-1b, F-2,
  F-10, F-22 and `regression.md` R-4/R-8; `release-pipeline/functional.md` F-4/E-2 and
  `regression.md` R-3/R-4; `webview-security-boundary/functional.md` F-5.
  - **Expected:** all still green with their own literals unchanged (`PAYLOAD_PRESENT=`,
    `RESULT=PASS`, `PAYLOAD_INCOMPLETE_IN_ARTIFACT`, the build-only `tauri-action`, the single
    `if: success()` draft publish, the release bridge closed).
  - **Edge:** any of those rows reddening ⇒ **FAIL** of this spec (the wiring is additive, not a
    replacement). Do **not** "fix" a reddening by editing the other suite's literal — route it as
    a finding.

## R-10 — Suite polarity: this suite extends, never contradicts (G-444)

- [ ] **R-10.** Read `.opencode/tests/companion-artifact-payload/functional.md` +
  `regression.md` beside this suite's rows.
  - **Expected:** no row in this suite asserts an observable that another suite records as ABSENT,
    and the payload-gate ordering rows here (F-2/F-18) assert the **additive** structure
    (payload gate → new gate → negative legs → single draft), which is consistent with
    `companion-artifact-payload` F-22/R-4.
  - **Edge:** a contradiction between two suites about the same subject ⇒ **FAIL** — return it as a
    suite defect (the QA Expert reconciles row-by-row on meaning; a row already asserting absence
    survives byte-identical).

---

_Evidence convention: pass cases keep `- [x]` and append the file:line or command output observed;
fail cases leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro._
