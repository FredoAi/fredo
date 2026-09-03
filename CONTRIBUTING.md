# Contributing to Fredo

Thank you for your interest in contributing to Fredo — a desktop platform for working with AI coding agents. This document covers how to build Fredo from source, what we expect from pull requests, and what is out of scope.

## Building from Source

### Prerequisites

- **Rust toolchain** (stable) — the backend is Tauri v2 / Rust
- **Node.js 20+** with **pnpm** — the frontend is React 19 / TypeScript
- Platform-specific build prerequisites for Tauri v2 on your operating system (WebView2 runtime on Windows, Xcode command line tools on macOS, `webkit2gtk` and friends on Linux)

### Setup

From the repository root:

```sh
pnpm install
pnpm dev:tauri
```

`pnpm dev:tauri` starts the Vite dev server (port 5174) and launches the desktop app against it.

### CI-parity command set

Continuous integration (`.github/workflows/validate.yml`) runs the following commands with these exact flags. Run the full set locally before opening a pull request:

```sh
pnpm --filter @fredo/ui typecheck
pnpm --filter @fredo/ui build
pnpm --filter @fredo/ui test:run
cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --locked
cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings
```

All of these must pass with zero errors and zero warnings before a PR can be merged.

## Pull Request Checklist

- [ ] The CI-parity command set above passes locally
- [ ] Evidence is included in the PR description (screenshots and/or command output, before and after) — the PR template has an Evidence section for this
- [ ] No refactor-only changes (see [Non-goals](#non-goals))
- [ ] Documentation is updated if the change affects user-facing behavior or build steps
- [ ] AI-assisted contributions are disclosed (see below)

## Contribution Priorities

We review and prioritize contributions in this order:

1. **Bug fixes**
2. **Security**
3. **Cross-platform** (Windows, macOS, and Linux parity)
4. **Performance**
5. **New features**
6. **Documentation**

## Pipeline Issues

Some issues in this repository are **pipeline issues** — they are controlled and driven by Fredo's automated agentic pipeline (tracked by labels such as `backlog`, `planning`, `ready-for-dev`, `testing`, `audit`, `cleanup`, `done`). Their conversations are **locked** (lock reason `off-topic`), so only users with write access (collaborator/member/owner) can comment. The pipeline state machine retains write access and keeps posting `Status`, `Triage Plan`, and `Tests Runs` comments on them.

This is intentional. The pipeline reads issue comment text as trusted context, so an untrusted third-party comment is a prompt-injection / context-poisoning risk now that this repository is public. Comment-restricting pipeline issues keeps that surface maintainer-controlled while continuing to let the pipeline do its work.

If you have a genuine bug report, feature request, or security concern, do **not** post it as a comment on a pipeline issue — public comments there are not read by the pipeline. Instead:

- Open a regular GitHub issue for non-security bug reports and feature requests.
- Report security-sensitive findings privately via the repository's Security tab (a private advisory) — see [SECURITY.md](docs/SECURITY.md).

There is no moderation or bot workflow for these comments; the restriction is configuration plus policy, and genuine reports are routed through the channels above.

> Note: the repo-level interaction limit (`collaborators_only`) is a temporary belt-and-suspenders control — GitHub caps its expiry at six months, so it must be re-applied. The durable guard is per-conversation lock-on-create.

## Non-goals

- **No refactor-only PRs.** Pull requests whose content is purely restructuring — no behavior change, no bug fix, no user-visible improvement — are out of scope. Refactors happen when maintainers drive them, motivated by concrete work.
- **Fredo's core is closed.** Third-party integrations (new agent providers, new transports, companion tools) ship as standalone plugin repositories, not as changes to Fredo's core. If your integration needs a new extension point, open an issue describing the integration first.
- **The CHANGELOG is maintainers-only.** Do not modify `CHANGELOG.md` in a pull request; maintainers curate it at release time.

## AI-Assisted Contributions

Pull requests created with AI assistance are welcome. They must:

- Be clearly marked as AI-assisted in the PR description.
- Include evidence of the work: the prompts used and the outputs/commands demonstrating that the change works as claimed.

Undisclosed AI-assisted PRs that fail review for that reason will be asked to re-disclose; repeated concealment may result in contribution restrictions.
