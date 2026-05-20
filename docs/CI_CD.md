# Fredo — CI/CD Pipeline

## Status

CI/CD workflows are **planned but not yet implemented**. No `.github/workflows` directory currently exists in the repository.

This document describes the intended pipeline design for when CI/CD is set up.

---

## Planned CI Workflow

Triggered on: `push` to `main`, `pull_request` to `main`

### Jobs

#### `ui-check`
Verifies the React/TypeScript frontend has no type errors.

```yaml
- uses: actions/checkout@v4
- uses: pnpm/action-setup@v3
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @fredo/ui build
```

Pass criteria: `tsc` exits 0 and `vite build` produces output.

#### `rust-check`
Verifies the Rust backend compiles cleanly.

```yaml
- uses: actions/checkout@v4
- uses: dtolnay/rust-toolchain@stable
- uses: Swatinem/rust-cache@v2
- run: cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml
```

Pass criteria: `cargo build` exits 0 with zero warnings (`RUSTFLAGS="-D warnings"`).

---

## Planned Release Workflow

Triggered on: tag push matching `v*.*.*`

Builds signed installers for Windows, macOS, and Linux in parallel using `tauri-action`.

```yaml
jobs:
  release:
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-22.04]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        with:
          tagName: ${{ github.ref_name }}
          releaseName: Fredo ${{ github.ref_name }}
          releaseBody: See CHANGELOG for details.
```

### Artifacts

| OS | Artifact |
|----|---------|
| Windows | `.msi` installer (NSIS) — adds `fredo` to system PATH |
| macOS | `.dmg` disk image |
| Linux | `.AppImage` portable binary |
| Linux | `.deb` package |

Artifacts will be attached to the GitHub Release and available for download immediately after the workflow completes.

---

## Local Pre-flight

Run the same checks locally before pushing:

```bash
# TypeScript
pnpm --filter @fredo/ui build

# Rust
cd apps/tauri/src-tauri && cargo build

# Full Tauri dev build (verifies integration)
pnpm dev:tauri
```

---

## Branch Strategy (Planned)

| Branch | Triggers |
|--------|---------|
| `main` | CI check on every push |
| `v*.*.*` tag | Release build + GitHub Release |

Feature branches are not required by the workflow but are recommended for larger changes.
