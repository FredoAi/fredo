## Status: spec-draft
**Current phase:** Spec creation — awaiting leader review
**Last updated:** 2026-05-20T15:30:00Z by @fredo

---

## Spec: Fix llama-cpp-sys-2 Build Failure on Windows

### Overview

`cargo build` fails on Windows because the `llama-cpp-sys-2` native dependency's CMake build step uses the Visual Studio 17 2022 generator, which requires `.vcxproj` files for MSBuild. CMake 4.3 generates the build configuration (`CMakeCache.txt`, `CMakeFiles/`) but does not produce the necessary `.vcxproj` target files, causing `cmake --build ... --target install --config Release` to fail with `MSB1009: Project file does not exist`.

The fix is to configure `llama-cpp-sys-2` to use the Ninja generator instead of the Visual Studio generator. Ninja is a simpler, faster build system that doesn't require `.vcxproj` files and is already available on the system. This is a well-known solution for native Rust crate builds on Windows.

### Architecture Decisions

- **DEC-1**: Use Ninja as the CMake generator for `llama-cpp-sys-2` instead of Visual Studio. Ninja avoids the `.vcxproj` generation problem entirely and produces faster builds.
- **DEC-2**: Set the `CMAKE_GENERATOR` environment variable at build time via a Cargo build script or `.cargo/config.toml`, not globally (to avoid affecting other projects).
- **DEC-3**: The fix shall be limited to Windows only. Unix/macOS builds continue using the default generator (Make/Ninja).

### Requirements

- **REQ-1**: When `cargo build` is run on Windows, the `llama-cpp-sys-2` crate **shall** use Ninja as its CMake generator instead of Visual Studio 17 2022.
- **REQ-2**: When `cargo build` is run on Unix/macOS, the `llama-cpp-sys-2` crate **shall** continue using the default CMake generator without changes.
- **REQ-3**: The build configuration **shall** not require global environment variable changes (i.e., `CMAKE_GENERATOR` must be scoped to the project, not set system-wide).
- **REQ-4**: After the fix, `cargo build` from `apps/tauri/src-tauri/` **shall** complete successfully with zero errors from `llama-cpp-sys-2`.
- **REQ-5**: The `llama-cpp-2` Rust crate version and features **shall** remain unchanged (no version bumps).

### Root Cause Analysis

The CMake configure step succeeds (generates `CMakeCache.txt`, finds compilers, etc.) but the Visual Studio generator fails to produce `.vcxproj` target files. When `cmake --build` invokes MSBuild with `--target install`, MSBuild looks for `INSTALL.vcxproj` which doesn't exist. This appears to be a CMake 4.x compatibility issue with the Visual Studio generator on Windows when invoked from a Cargo build script.

The Ninja generator doesn't use `.vcxproj` files — it produces a `build.ninja` file directly, which is deterministic and reliable for native crate builds.

### Acceptance Criteria

- [ ] AC-1: `cargo build` succeeds on Windows with zero errors from `llama-cpp-sys-2`
- [ ] AC-2: `cargo build` on Unix/macOS is unaffected (no regressions)
- [ ] AC-3: The `CMAKE_GENERATOR` environment variable is not required to be set globally
- [ ] AC-4: The `Cargo.toml` llama-cpp-2 dependency version is unchanged
- [ ] AC-5: `pnpm dev:tauri` launches the Tauri app successfully with the LLM engine loaded

### Tasks

- [ ] #TBD — Add `.cargo/config.toml` (or Windows-specific `.cargo/config.toml`) with `CMAKE_GENERATOR=Ninja` for the `llama-cpp-sys-2` build
- [ ] #TBD — Verify `cargo build` succeeds end-to-end on Windows
- [ ] #TBD — Verify `pnpm dev:tauri` launches the app with the LLM engine

### Files to Modify

| File | Action | Notes |
|------|--------|-------|
| `apps/tauri/src-tauri/.cargo/config.toml` | Create or edit | Set `CMAKE_GENERATOR=Ninja` for Windows targets |
| `apps/tauri/src-tauri/.cargo/config.win32.toml` | Possibly create | Windows-specific Cargo config (alternative approach) |

### Possible Approaches

**Approach A: `.cargo/config.toml` with target-specific overrides**

Create `apps/tauri/src-tauri/.cargo/config.toml` with:
```toml
[target.x86_64-pc-windows-msvc.llama-cpp-sys-2]
rustc-env = { CMAKE_GENERATOR = "Ninja" }
```

**Approach B: `.cargo/config.toml` with build-env**

This may not work since `llama-cpp-sys-2` reads `CMAKE_GENERATOR` as a regular environment variable, not a Cargo setting. We need to ensure the env var is set before the build script runs.

**Approach C: Wrapper build script**

Add a `build.rs` to the Tauri crate that sets `CMAKE_GENERATOR=Ninja` before the `llama-cpp-sys-2` build script runs. However, Cargo build scripts run in parallel, so this may not work reliably.

**Approach D: Global `.cargo/config.toml` with `[env]`**

```toml
[env]
CMAKE_GENERATOR = "Ninja"
```

This is the simplest approach but sets the variable for the entire workspace. Since Ninja is a valid generator everywhere, this is acceptable.

**Recommended: Approach A or D** — The simplest and most reliable approach.

### Constraints

- Do not change the `llama-cpp-2` crate version or features
- Do not require users to install additional software beyond what's already on the system (Ninja must be checked)
- The fix must work for both `cargo build` and `pnpm dev:tauri`
- Do not add `#[allow(...)]` attributes to suppress warnings

### Test Plan

_To be filled by @fredo-tester_

---

### Status History
| Timestamp | Status | Agent | Notes |
|-----------|--------|-------|-------|
| 2026-05-20T15:30:00Z | spec-draft | @fredo | Initial spec created |

---
*Generated by @fredo*