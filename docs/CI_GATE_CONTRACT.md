# CI Gate Contract (#2801)

What runs when on a `pull_request` targeting `main`, and which check is the gate.

## Required status check

- **`validate`** (the aggregator job in `.github/workflows/validate.yml`) is the **only**
  required status check. It runs `if: always()`, so it always produces a check run — it never
  goes to GitHub's ambiguous "Expected — waiting for status".
- **`ui-validate`**, **`rust-validate`**, and **`fast-validate`** (`.github/workflows/validate-fast.yml`)
  are **NOT** required checks. They are per-stack signal; only the `validate` aggregator gates merge.

## Per-stack gating (what runs when)

The `paths` discriminator job uses `dorny/paths-filter` (`base: main`) to decide which stack a
PR changed, then each per-stack job runs only when its stack is touched:

- **UI-touching PR** (`apps/ui/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or the
  `validate.yml`/`validate-fast.yml` workflows) → `ui-validate` runs (install + typecheck + build + test:run);
  the unrelated `rust-validate` job is skipped.
- **Rust-touching PR** (`apps/tauri/`, `**/Cargo.toml`, `**/Cargo.lock`, or the validate workflows) →
  `rust-validate` runs (cargo check + nextest + clippy `-D warnings`, with `Swatinem/rust-cache` warm-cache
  reuse); the unrelated `ui-validate` job is skipped.
- **Docs-only / no-stack PR** → neither `ui-validate` nor `rust-validate` runs; the `validate` aggregator
  still passes (both dependencies report `skipped`, which the aggregator treats as pass) and a
  docs-only PR is mergeable in well under a minute.

The gate is thus **scoped per changed stack**: a genuine break in a stack the PR touches still blocks
merge, while a stack the PR does not touch pays no runner cost. On a PR that touches both stacks, both
jobs run (the path filters are a UNION, not an intersection).

## Branch protection (a repo setting, not a file)

Branch-protection is configured in the GitHub repository settings (not a repo file) and must be
confirmed there: the sole required status check for the `main` branch is **`validate`**. `ui-validate`,
`rust-validate`, and `fast-validate` must NOT be added as required checks. This document records the
intended contract; it does not change the repo settings.
