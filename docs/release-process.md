# Release Process — Owner Manual (#2803)

**Who runs this:** the human maintainer — the repo owner/admin of `FredoAi/fredo`. This document
is the deterministic, step-by-step record of the steps the **pipeline principal cannot perform**
(it is a GitHub **collaborator**, not a repo **ADMIN**). AI agents never create or protect branches,
never apply a ruleset, never approve or merge into the protected release branch, and never publish a
release; their only in-repo deliverable was the workflow/owner-rule files this document references.

**What it produces:** a protected `release/stable` branch whose merges are owner-gated and whose
pushes always run a one-trigger Tauri build that builds the **Windows-only** installer, verifies the
engine payload inside the produced installer, and lands it on a **DRAFT** GitHub Release — Windows is
the only supported platform, so a release is Windows-only and carries the single NSIS `.exe`
installer. That means every artifact a user downloads has first passed (a) the thorough `validate`
gate, (b) an owner code-owner approval, (c) the installer-payload gate, and (d) a deliberate owner
publish of the draft — **no release is public without the owner's hand on it.**

> <!-- machine-parsing note: this file is the reference for the AC1/AC2/AC3/AC4 "documented"
>      rows in the QA plan; the admin-enforced legs remain owner-gated and are UNVERIFIED
>      in the pipeline. -->

---

## Reach split (what the pipeline can and cannot do)

| Step | Who performs it | Where it lives |
|------|-----------------|----------------|
| Author `.github/workflows/release.yml` | Developer (this spec) | in-repo — landed on `spec/2803` |
| Author `.github/CODEOWNERS` `* @pktron` rule | Developer (this spec) | in-repo — landed on `spec/2803` |
| Author this document | Developer (this spec) | in-repo — landed on `spec/2803` |
| Additive `release/stable` trigger to `validate.yml` | Developer (this spec) | in-repo — landed on `spec/2803` |
| **Create + protect `release/stable`** | **Owner (manual)** | **repo setting — owner only** |
| **Apply + enforce the ruleset** | **Owner (manual)** | **repo setting — owner only** |
| **Place `@pktron` as required reviewer** | **Owner (manual)** | **repo setting — owner only** |
| **Enable workflow write permissions / verify `release.yml` runs** | **Owner (manual)** | **repo setting — owner only** |
| **Cut a release (approve PR → merge → publish draft)** | **Owner (manual)** | **GitHub UI / `gh` — owner only** |

The three in-repo files are all **additive and non-gating**: they define the release path and confirm
the owner rule, but they do **not** themselves protect the branch or publish anything. Protection and
publishing are repo settings/actions only an admin can reach.

---

## The in-repo release contract (verify before you start)

These are the files this manual drives, exactly as they exist on the branch. Confirm them before
performing the owner-manual steps — if any differ, stop and reconcile rather than proceed.

### 1. `.github/workflows/release.yml` — the one-trigger build + publish

- **Name:** `Release`
- **Trigger:** `on: push: branches: ['release/stable']` **plus** `workflow_dispatch: {}` (owner
  manual re-run fallback).
  - **It does NOT trigger on `main`** and **does NOT trigger on a tag** — the only push trigger is a
    commit to `release/stable`, i.e. an owner-approved merge. (A `workflow_dispatch` run is the
    explicit owner re-run, not a second automatic trigger.)
- **Permissions:** `permissions: contents: write` at the **workflow level** — the `GITHUB_TOKEN`
  needs write to create/publish the Release object and upload artifacts.
- **Build matrix (Windows x64 only — single `windows-2022` leg):** `windows-2022` (x64), with no
  `--target` arg. `fail-fast: false`. The leg is **pinned** (`windows-latest` is not used): the
  current `windows-latest` image ships VS 18 / MSVC 14.52, whose STL hard-asserts *"expected Clang
  22 or newer"* inside `llama-cpp-sys-4`'s bindgen step, so the engine would not compile.
- **Steps:** checkout → pnpm/action-setup → setup-node 20 with pnpm cache (the pnpm setup MUST
  precede setup-node, which resolves the `pnpm` binary for its cache) → `oven-sh/setup-bun`
  (builds the OpenCode plugin via `beforeBuildCommand`) → dtolnay/rust-toolchain stable →
  Swatinem/rust-cache (`workspaces: apps/tauri/src-tauri`) → `jakoch/install-vulkan-sdk-action`
  (LunarG Vulkan SDK, **`cache: false` + `install_runtime: true`**) → `pnpm install
  --frozen-lockfile` → read `version` from `tauri.conf.json` → `tauri-apps/tauri-action@v1`
  (**build only**) → locate the produced `*-setup.exe` → `verify-installer-payload.ps1`
  (**payload gate**) → `gh release create … --draft` (the only publish step) → draft cleanup.
  `cache: false` is load-bearing: the action's SDK cache holds the SDK tree only, so on a cache
  hit it skips the install path entirely and `install_runtime` never runs — leaving no
  `vulkan-1.dll` for the staged payload.
- **`tauri-action` inputs:** only `projectPath: apps/tauri/src-tauri` (the Tauri project is **not**
  at the repo root) and `args: ${{ matrix.args }}`. The action carries **no** `tagName`,
  `releaseName`, `releaseBody`, `releaseDraft` or `releaseId`, so it makes no release API call and
  publishes nothing.
- **The tag** is `app-v<version>` (`<version>` is read from `tauri.conf.json` = `0.2.2`) and is
  applied by the draft step, not by the action: `gh release create "app-v<version>" <installer>
  --draft --title "Fredo v<version>" --notes "<fixed template>"`, gated `if: success()` **after**
  the payload gate.
- **The payload gate is the deliberately-reviewed artifact check**, and it runs as one step
  **before** the draft. It (a) runs both scripts' `-SelfTest` legs — `stage-engine-payload.ps1`
  (eleven controls: the original seven plus a forbidden load-time import, a forbidden delay-load
  import, a non-root import gap and a scan-completeness control) and `verify-installer-payload.ps1`
  (eight controls: the original five plus forbidden-import, delay-import and unresolved-import
  checks on an extracted tree); (b) statically asserts the checked-in
  `[package.metadata.llama-cpp-sys-4.cmake]` table carries `LLAMA_OPENSSL = "OFF"`, failing the job
  with `::error::ENGINE_OPENSSL_NOT_DISABLED` when the key is absent; and (c)
  `verify-installer-payload.ps1` extracts the produced NSIS installer, asserts the eight core
  `engine-payload/` DLLs are present, and scans every present payload DLL's **load-time and
  delay-load** imports — printing `ARTIFACT_PAYLOAD_SCANNED=<n> of=<n>` and `IMPORT_SCAN=PASS
  dlls=<n>`, and failing on a forbidden import
  (`ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=<dll> module=<module> kind=<import|delay-import>`)
  or an unresolved import
  (`ERROR=PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT edge=<dll> -> <module> kind=<import|delay-import>`).
  A gate failure leaves **no draft and no uploaded asset**. Nothing is public until the owner
  publishes the draft; do **not** remove `--draft` (that would auto-publish and bypass owner
  review).
- **Every `uses:` action is SHA-pinned** (e.g. `actions/checkout@11bd71... # v4.2.2`,
  `tauri-apps/tauri-action@1deb37... # v1`) per the repo convention (NFR-2). `pnpm install
  --frozen-lockfile` + the committed `Cargo.lock` make the build reproducible from the branch tip.

### 2. `.github/workflows/validate.yml` — the thorough merge gate

- **Trigger:** `on: pull_request: branches: ['main', 'release/stable']` — `release/stable` is an
  **ADDITIVE** entry. A `release/stable` PR therefore runs `validate` (which is what makes the
  "green `validate`" precondition in the cut-a-release flow real).
- **`validate` is the thorough, single required status check.** It is an aggregator job that runs
  `if: always()` and exits non-zero only if `ui-validate` or `rust-validate` failed. `validate-fast`
  and the per-stack `ui-validate` / `rust-validate` are **NOT** required checks.
- **The `release/stable` trigger additive does NOT change `main` behavior.** For a `main` PR the
  trigger and all jobs behave byte-identically to before; a `main` PR still triggers `validate` (and
  its per-stack children) exactly as it always did. `main` behavior is unchanged — only an additional
  target branch was added to the trigger.
- **`base` is intentionally omitted** from the `dorny/paths-filter` so it defaults to the PR's base
  branch — correct for both `main` PRs and `release/stable` PRs (a hardcoded `base: main` would
  wrongly diff a release PR against `main`).

### 3. `.github/CODEOWNERS` — owner-governance rule

- `* @pktron` — `@pktron` is the **code owner of every path**. CODEOWNERS is **path-based**, not
  branch-based; the branch scoping is done by the **ruleset** (step 2 below), not by this file.
- When the ruleset sets `require_code_owner_review: true`, any PR into `release/stable` that touches
  a shipped path demands `@pktron`'s approval. **The owner rule must name the owner (`@pktron`), never
  a bot or collaborator** — no unowned path may be approvable by non-owner automation.

### 4. `apps/tauri/src-tauri/tauri.conf.json` — bundle config consumed by the release build

- `productName: "Fredo"`, `version: "0.2.2"` (read by the workflow and injected into the
  `app-v<version>` tag/title), `identifier: "com.fredo.app"`.
- `bundle.active: true`, `bundle.targets: "all"`; Windows NSIS `perMachine`.
- **Engine payload (Spec #3158).** `bundle.resources` is exactly `{"engine-payload/": ""}` (a map
  with the empty-string destination, **not** a glob), and `build.beforeBundleCommand` runs
  `.opencode/scripts/stage-engine-payload.ps1`, which stages the canonical allowlist
  (`.opencode/scripts/payload-manifest.json`) into `engine-payload/`. The payload installs **beside
  `fredo.exe` in the install directory**; `bundle.externalBin` stays `[]` (the DLLs are resources,
  not sidecar binaries). **What to change:** nothing in the config for an ordinary release — but the
  produced installer is gated by `.opencode/scripts/verify-installer-payload.ps1`, which extracts
  the NSIS `.exe`, fails the job when any core payload DLL is missing, and scans every present
  payload DLL's load-time **and** delay-load imports, failing on a forbidden (`libssl*`/`libcrypto*`)
  or unresolved import. **No signing identity is configured** (`macOS.signingIdentity: null`) — code
  signing/notarization is deferred (NFR-4).

---

## Owner-manual steps

### Step 1 — Create the `release/stable` branch from `main`

Create the release branch from the current `main` tip. It is a **dedicated, protected line** — from
here on, only owner-approved PRs land on it.

- **Click-path (GitHub web):** `main` branch → **Branch** dropdown → type `release/stable` → **Create
  branch**. (Alternatively use `gh api` in a local clone. The pipeline is **not** doing this — it ends
  at `spec/2803`.)
- From a local clone:
  ```
  gh repo sync FredoAi/fredo -b main
  git switch -c release/stable origin/main
  git push -u origin release/stable
  ```
- The branch is created from `main` at the moment you cut it. **Do not create it from a tag or from
  `spec/2803`** — only `main`.

### Step 2 — Apply + enforce the repository ruleset on `release/stable`

A **repository ruleset** (not classic branch protection) is required. Classic branch protection
**always** lets repo admins push past it (the admin bypass cannot be disabled); a ruleset with an
**empty bypass list** prevents **everyone** — including admins — from bypassing, which is exactly
what AC1's "cannot be bypassed, including by admins" demands.

- **Click-path:** `Settings → Rules → Rulesets → New ruleset → New branch ruleset`
  - Ruleset name: `protect-release-stable`
  - **Enforcement status: Active**
  - **Bypass list: leave empty** — `bypass_actors: []`. No one, including repository admins, may
    bypass. (This is the difference from a classic protection and the whole point of the gate.)
  - Target branches: **Add target → Include by pattern → `refs/heads/release/stable`**
  - Rules — enable:
    - ✅ **Restrict deletions** (equivalent to `block_deletion`)
    - ✅ **Block force pushes**
    - ✅ **Require a pull request before merging** — this forbids direct (non-PR) pushes to the
      branch; all changes must arrive via a PR. Set **Required approvals: 1**.
    - ✅ **Require code owner reviews** — `@pktron` (the code owner) must approve.
    - ✅ **Require status checks to pass** — add exactly the check name **`validate`** (the thorough
      gate). `validate-fast` and the per-stack `ui-validate`/`rust-validate` must **NOT** be added
      here (they are signal, not the gate; matching `docs/CI_GATE_CONTRACT.md`).
    - Do **NOT** enable "require signed commits" or "require linear history" in this slice (NFR-4
      defers those; linear history is a reasonable later hardening).
  - Click **Create**.

- **CLI (`gh api` REST endpoint) — save this payload as `protect-release-stable.json`:**
  ```json
  {
    "name": "protect-release-stable",
    "target": "branch",
    "enforcement": "active",
    "bypass_actors": [],
    "conditions": {
      "ref_name": { "include": ["refs/heads/release/stable"], "exclude": [] }
    },
    "rules": [
      { "type": "deletion" },
      { "type": "non_fast_forward" },
      {
        "type": "pull_request",
        "parameters": {
          "required_approving_review_count": 1,
          "dismiss_stale_reviews_on_push": false,
          "require_code_owner_review": true,
          "require_last_push_approval": false,
          "required_review_thread_resolution": false
        }
      },
      {
        "type": "required_status_checks",
        "parameters": {
          "strict_status_check_policy": false,
          "required_status_checks": [
            { "context": "validate", "integration_id": null }
          ]
        }
      }
    ]
  }
  ```
  Then create it:
  ```
  gh api --method POST repos/FredoAi/fredo/rulesets --input protect-release-stable.json
  gh api repos/FredoAi/fredo/rulesets        # verify it is present + active
  ```

**This is the step that makes AC1/AC2 real.** After it, a `release/stable` PR **without** `@pktron`'s
approval is blocked at merge **even if every status check is green** — the owner-approval
precondition is independent of CI status (AC2's negative gate). And no one, not even a repo admin, can
push directly to the branch or bypass the ruleset (AC1).

### Step 3 — Place `@pktron` as the required reviewer for `release/stable`

The ruleset `require_code_owner_review: true` + the `* @pktron` CODEOWNERS rule already make
`@pktron` the required approving reviewer, but also make it explicit at the branch level:

- **Click-path:** on the `protect-release-stable` ruleset editor, under **Rules → Require a pull
  request before merging → Required approving reviews** confirm the count is **1**; under **Require
  code owner reviews** confirm it is **ON**. (These are the same fields set in Step 2.)
- (Optional belt-and-suspenders) **Branch protection UI:** `Settings → Branches → Add rule →
  `release/stable` → **Require review from Code owners** on. However, a ruleset is the authoritative
  mechanism; classic branch protection is redundant and would re-introduce the admin-bypass caveat —
  rely on the ruleset.

### Step 4 — Enable workflow write permissions / verify `release.yml` runs

- **Repo default read-only (recommended):** `Settings → Actions → General → Workflow
  permissions` → select **"Read repository contents and packages permissions"** → **Save**. The
  release workflow opts into write via its own `permissions: contents: write` block (Step 1 file) —
  it does not rely on a repo-wide write default. Also ensure **"Allow GitHub Actions to create and
  approve pull requests"** is **off**.
  ```
  gh api --method PUT repos/FredoAi/fredo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_requests=false
  ```
- **Verify `release.yml` is a runnable workflow:** it must appear under `Actions → Release`. Because
  it **only** triggers on a push to `release/stable` (which does not exist until Step 1) it will show
  no runs until the first release PR merges — that is expected, not a misconfiguration.
- **Confirm Actions are enabled** for the repo (`Settings → Actions → General → Actions permissions:
  Allow all actions` or the intended policy; the SHA-pinned actions must be permitted).
- **Dry-check the trigger wiring** (read-only): a manual `workflow_dispatch` run can be triggered from
  the `Actions → Release` page (owner only) to smoke-test the build without merging, but it will still
  create a draft release — use it only when you intend to validate artifacts.

### Step 5 — Cut a release

The release loop, in order. **The owner does every step; the pipeline never opens, approves, merges,
or publishes.**

1. **Open a PR into `release/stable`.** The PR brings `main` (or a `v` preview state) into
   `release/stable`. Use the GitHub UI or `gh` (the pipeline principal cannot run `gh pr create`).
   - Because of the Step 2 ruleset, this PR must pass **`validate`** (the additive
     `release/stable` trigger in `validate.yml` makes that run) and must carry **`@pktron`'s code-owner
     approval**.
2. **Wait for the green `validate` gate.** Watch `gh pr checks <PR>` / the PR page until the
   `validate` check is green **and** the per-stack checks it aggregates are green.
3. **Wait for owner approval.** `@pktron` reviews and approves. A **green gate alone is not enough** —
   without the owner's approval the merge is blocked regardless of CI (AC2).
4. **Merge.** Once approved **and** green, merge the PR into `release/stable`. (Because the ruleset
   requires a PR, there is no direct-merge path; the merge itself is the PR merge.)
5. **`release.yml` fires on the merge push.** The push to `release/stable` triggers `Release`, which
   runs the Windows-only matrix, builds the Windows installer, locates the produced `*-setup.exe`,
   and runs `verify-installer-payload.ps1` on it. Only after that gate passes does the draft step
   `gh release create app-v0.2.2 Fredo_0.2.2_x64-setup.exe --draft` upload it to a **DRAFT** GitHub
   Release at the branch tip.
6. **The owner reviews the DRAFT and publishes it.** Open the draft under `Releases`, confirm the
   artifact (the Windows NSIS `.exe` installer), then **Publish**. Users only download
   deliberately-reviewed artifacts because nothing is public before this step.

> **Reproducibility note:** every artifact is built from the `release/stable` tip with a fixed ref,
> `pnpm install --frozen-lockfile`, the committed `Cargo.lock`, and SHA-pinned actions — so a given
> tip always yields the same build. The bundle `version` (`0.2.2`) is read from
> `tauri.conf.json` at build time and injected into the release tag/name.

---

## Verify the gate is working

Run these read-only checks after Step 2/4 (owner can; a non-admin would see the protection but cannot
exercise a merge):

```
gh api repos/FredoAi/fredo/rulesets                                   # expect protect-release-stable, active, bypass_actors: []
gh api repos/FredoAi/fredo/actions/permissions/workflow              # expect default_workflow_permissions: read
gh api repos/FredoAi/fredo/commits/release/stable/check-runs          # after a release PR: validate green
gh release list                                                       # after Step 5.6: the published release
```

Expected: the ruleset is **active** with an **empty** bypass list; workflow permissions default to
**read**; a `release/stable` PR shows a green `validate`; the released artifact list matches the build
matrix.

---

## Version bumps — the ORDER is load-bearing

A release ships whatever version `tauri.conf.json` holds, and a release sync sets the
`release/stable` tree to **exactly `main`**. That makes `main` the single source of truth for the
version, and it makes the **order** of a bump non-negotiable.

### The rule

**A version bump lands on `main` FIRST. Only then is `release/stable` synced from `main`.**

```
  1. bump  ->  PR into main              (version change lives here, once)
  2. sync  ->  PR into release/stable    (tree = main, bump included)
  3. the merge to release/stable fires release.yml -> DRAFT release
  4. owner reviews + publishes the draft
```

Never open a release PR that carries version content `main` does not already have. The
`release-version-guard` job in `validate.yml` fails closed on exactly that shape, on every PR
into `release/stable`.

### Why the order matters (a real incident)

PR #3156 bumped the version to `0.2.0` on `release/stable` while `main` stayed on `0.1.0`. The
release that shipped was correct — but the **next** release sync would have reset the tree to
`main`, silently rebuilding `0.1.0` and reusing the old `app-v0.1.0` tag. Nothing caught it; it
was found by comparing the two branches after the release had already been cut, and repaired by a
second PR (#3157) that backfilled the bump onto `main`.

The failure is silent by construction: the two branches each look internally consistent, and only
their *comparison* reveals the drift. Hence the automated guard rather than a convention.

### The version lives in five places (all must agree)

| File | Consumed by |
|------|-------------|
| `apps/tauri/src-tauri/tauri.conf.json` | `version` → the `app-v<version>` tag + draft title |
| `apps/tauri/src-tauri/Cargo.toml` | `CARGO_PKG_VERSION` = `HOST_FREDO_VERSION` — the host version an installed app targets via `engines.fredo` |
| `apps/tauri/src-tauri/Cargo.lock` | the locked crate version (must be regenerated, not hand-edited) |
| `apps/tauri/package.json`, `apps/ui/package.json` | workspace identity |

Bump all five in one commit on the `main` PR. Regenerate the lock with
`cargo update --workspace --offline -p fredo` rather than editing it by hand.

**Constraint on the value:** `installed_apps::tests::the_host_version_is_a_parseable_semver`
asserts the host **major is 0**. A `1.0.0` bump fails that test by design — it is a deliberate
signal that jumping majors needs a decision about `engines.fredo` compatibility, not an accident
to work around.

**Semver policy for the value itself** (what counts as major/minor/patch) remains out of scope
below — this section fixes only the *order* the bump must travel.

---

## Explicit non-goals (deferred — NFR-4)

This manual does **not** cover the following — they are deliberately deferred to a later slice and
must **not** be added to this process without a new spec:

- **Versioning scheme / tag strategy** — `release.yml` uses the single `app-v<version>` tag
  derived from `tauri.conf.json`; a semver policy for *which* number to increment, and a tag
  strategy, are out of scope. (The bump *order* and the file set are specified above; only the
  policy for choosing the number is deferred.)
- **Code signing / notarization** — `release.yml` has no signing/notarize inputs and
  `tauri.conf.json` has no signing identity.
- **Changelog / release-notes generation** — the draft step's `--notes` is a fixed template string;
  there is no changelog step.
- **Hotfix / patch-branch policy** — a long-lived `release/*` matrix, patch branch promotion, etc.
  are out of scope.
- **Publishing on merge** — the draft step (`gh release create … --draft`) stays; do not switch to
  publish-on-merge.

## Constraints the pipeline must respect (regression invariants)

- **`release.yml` never triggers on `main`** and never on a tag — only on a push to `release/stable`
  (or an owner `workflow_dispatch`). This keeps the main dev-trunk spec flow (AC5) untouched.
- **`validate.yml`'s `release/stable` trigger is additive** — `main` PR behavior is byte-identical;
  `validate` remains the single thorough required check on `main`, and `release.yml` is **not** a
  required check on `main`.
- **`.github/CODEOWNERS` stays `* @pktron`** — the owner, never a bot/collaborator.
- **No in-repo change weakens the gate** — the pipeline principal cannot protect the branch or publish
  a release; that is the owner's manual responsibility, recorded here.
