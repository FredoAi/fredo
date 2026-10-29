# CI Gate Contract (#2801)

What runs when on a `pull_request` targeting `main`, and which check is the gate.

## Required status check

- **`validate`** (the aggregator job in `.github/workflows/validate.yml`) is the **only**
  required status check. It runs `if: always()`, so it always produces a check run — it never
  goes to GitHub's ambiguous "Expected — waiting for status".
- **`validate` fails closed.** It exits non-zero when the `paths` discriminator job does not
  report exactly `success`, and when either per-stack job reports anything other than exactly
  `success` or `skipped` (so `failure`, `cancelled`, and any unexpected value are rejected).
  `if: always()` is load-bearing: it guarantees the aggregator itself is never skipped, which is
  what makes a failed or cancelled dependency (including a failed `paths` job) turn the required
  check red instead of silently passing.
- **`ui-validate`**, **`rust-validate`**, and **`fast-validate`** (`.github/workflows/validate-fast.yml`)
  are **NOT** required checks. They are per-stack signal; only the `validate` aggregator gates merge.

## Per-stack gating (what runs when)

The `paths` discriminator job uses `dorny/paths-filter` to decide which stack a PR changed, then
each per-stack job runs only when its stack is touched. `base` is intentionally omitted: on a
`pull_request` event `paths-filter` defaults to the PR's base branch, which is correct for both
`main` and `release/stable` PRs (a hardcoded `base: main` would diff release PRs against `main`).

- **UI-touching PR** (`apps/ui/`, `apps/opencode-plugin/`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, or the `validate.yml`/`validate-fast.yml` workflows) → `ui-validate` runs
  (install + typecheck + build + test:run + the OpenCode plugin build); the unrelated
  `rust-validate` job is skipped.
  - The install is deterministic (`pnpm install --frozen-lockfile`), so an out-of-sync
    `pnpm-lock.yaml` fails the leg instead of silently rewriting resolution. The install filter
    includes `@fredo/fredo-opencode-plugin...` because `@fredo/ui` and `@fredo/tauri` have no
    dependency edge on the plugin.
  - The leg sets up `bun` and runs `pnpm --filter @fredo/fredo-opencode-plugin build`, so a plugin
    compile break — which also breaks the app, since the plugin is a Tauri build hook — fails the
    gate.
- **Rust-touching PR** (`apps/tauri/`, `**/Cargo.toml`, `**/Cargo.lock`, or the validate workflows) →
  `rust-validate` runs (cargo check + nextest + clippy `-D warnings`, with `Swatinem/rust-cache` warm-cache
  reuse); the unrelated `ui-validate` job is skipped.
- **Docs-only / no-stack PR** → neither `ui-validate` nor `rust-validate` runs; the `validate` aggregator
  still passes and a docs-only PR is mergeable in well under a minute. Two facts make that pass safe:
  both dependencies report `skipped` (which the aggregator accepts) **and** the `paths` discriminator
  succeeded — the green aggregate is conditional on `paths == success`, so a docs-only PR cannot pass
  by way of a failed discriminator.

The gate is thus **scoped per changed stack**: a genuine break in a stack the PR touches still blocks
merge, while a stack the PR does not touch pays no runner cost. On a PR that touches both stacks, both
jobs run (the path filters are a UNION, not an intersection).

**`fast-validate`** (`.github/workflows/validate-fast.yml`) remains an explicitly non-gating early
signal: its trigger-level `paths` list is unchanged, it is never in `validate`'s `needs`, and it must
never become a required check. Its single install also passes `--frozen-lockfile` so the fast signal
fails on a desynced lockfile exactly like the thorough leg.

## Branch protection (a repo setting, not a file)

Branch-protection is configured in the GitHub repository settings (not a repo file) and must be
confirmed there: the sole required status check for the `main` branch is **`validate`**. `ui-validate`,
`rust-validate`, and `fast-validate` must NOT be added as required checks. This document records the
intended contract; it does not change the repo settings.
