# scripts/doom

Development / QA-time producers for the Doom runtime's external artifacts.

> **Nothing here runs at runtime and nothing here is bundled.** The Fredo
> installer ships **no GPL engine binary and no WAD** (see
> [`docs/doom-mode-acquisition.md`](../../docs/doom-mode-acquisition.md)). These
> scripts exist so a developer or QA run can produce the real engine locally and
> stage it where the runtime resolver already looks.

## `build-restful-doom.ps1`

Builds the real **RESTful-DOOM** engine — `mkschreder/restful-doom`, the
Chocolate-Doom-derived fork that exposes the HTTP+JSON API Fredo drives — from
source and stages it at the resolver's candidate path
`<InstallDir>/engine/restful-doom.exe`.

- Engine repo: `https://github.com/mkschreder/restful-doom.git` (fork of Chocolate Doom)
- Pinned commit: `eded41b5597b7738ec1fa06d24f62b53db982c2c` (ST-1 pin; the `-EngineCommit` default)
- Toolchain: **MSYS2 "MINGW64"** with `base-devel`, `git`, `mingw-w64-x86_64-toolchain`,
  `mingw-w64-x86_64-SDL2`, `mingw-w64-x86_64-SDL2_mixer`, `mingw-w64-x86_64-SDL2_net`,
  `mingw-w64-x86_64-libsamplerate`, `mingw-w64-x86_64-libpng`
- Staged output: `<InstallDir>/engine/restful-doom.exe` (default `InstallDir` is
  `{app_data_dir}/doom` = `%APPDATA%\com.fredo.app\doom`), plus a
  `.restful-doom-commit` marker used for idempotency
- **Self-contained runtime:** the script also stages the engine's MSYS2 runtime
  DLL closure beside `restful-doom.exe`, plus a `.restful-doom-runtime-dlls`
  manifest. Windows searches the executable's own directory first, so the staged
  engine launches with **no `C:\msys64\mingw64\bin` on the child PATH** (without
  its DLLs the engine exits silently — ST-1 §6). The closure is computed from the
  built binary's PE import tables via the toolchain `objdump`, so it cannot drift.
  For the ST-1 pinned commit the closure is the 16 DLLs:

  ```text
  libFLAC.dll            libmpg123-0.dll   libogg-0.dll        libopus-0.dll
  libopusfile-0.dll      libpng16-16.dll   libsamplerate-0.dll libvorbis-0.dll
  libvorbisfile-3.dll    libwavpack-1.dll  libwinpthread-1.dll libxmp.dll
  SDL2.dll               SDL2_mixer.dll    SDL2_net.dll        zlib1.dll
  ```

The script does **not** commit the built binary or the WAD and does **not**
change the resolver order (`resolver.rs`: configured → PATH → staged candidate).

### Usage

```powershell
# Default staging dir + pinned commit.
powershell -File scripts/doom/build-restful-doom.ps1

# Explicit staging dir / commit.
powershell -File scripts/doom/build-restful-doom.ps1 -InstallDir D:\doom -EngineCommit eded41b5
```

On success the script prints the staged engine path (one line) on stdout.

### Parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `-InstallDir` | `%APPDATA%\com.fredo.app\doom` | Staging directory; the engine lands in `<InstallDir>\engine\restful-doom.exe`. |
| `-EngineCommit` | `eded41b5597b7738ec1fa06d24f62b53db982c2c` | Pinned fork commit to build. |
| `-Msys2Root` | auto-probe | Explicit MSYS2 root (e.g. `C:\msys64`). |
| `-RepoUrl` | upstream fork | Clone URL. |
| `-ScratchDir` | `<InstallDir>\build\restful-doom` | Clone + object scratch (never committed). |

### Environment

| Variable | Effect |
|----------|--------|
| `FREDO_DOOM_BUILD_OFFLINE=1` | Refuse all network access; exit **3** with a typed message and stage nothing. |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Staged OK — stdout is the staged engine path (one line). |
| `2` | **TOOLING GAP** — MSYS2 MINGW64 not found, or the dependency install failed. |
| `3` | Offline requested, or clone/fetch/checkout failed. |
| `4` | `autogen.sh` / `configure` / `make` failed. |

### Reproducing the failure paths (QA)

```powershell
$env:FREDO_DOOM_BUILD_OFFLINE = '1'
powershell -File scripts/doom/build-restful-doom.ps1   # exit 3, typed "offline" message
Remove-Item Env:\FREDO_DOOM_BUILD_OFFLINE
```

## `stage-doom-fixture.ps1`

Stages the **real engine + the Freedoom IWAD** into an in-repo fixture directory
(`.opencode/tmp/2968/fixtures/` by default) and prints the exact environment
exports QA needs — both the happy path and one line per AC4 / R-1.4 induction
lever. Idempotent: a re-run copies nothing it already has.

Layout produced under `-FixtureDir`:

| Path | Contents |
|------|----------|
| `engine/restful-doom.exe` | The real built engine (from `build-restful-doom.ps1`). |
| `engine/*.dll` | The engine's MSYS2 runtime DLLs, copied beside it so the fixture is self-contained (ST-1 §6: without them the child exits immediately, indistinguishable from a failed launch). |
| `engine/doom-engine.invalid.exe` | A deliberately non-PE file → `FREDO_DOOM_ENGINE_PATH` `spawnFailed` lever. |
| `freedoom/freedoom1.wad` | The pinned Freedoom 0.13.0 IWAD (verified by SHA-256). |
| `freedoom/freedoom-0.13.0.zip` | The verified archive (only when downloaded by this script). |

**Nothing is committed.** The built binary and the WAD never enter the repo
(G-172); `.opencode/tmp/` is gitignored.

### Usage

```powershell
# Stage into the default in-repo fixture dir (builds/copies the engine + IWAD).
powershell -File scripts/doom/stage-doom-fixture.ps1

# Show the resolved paths + exports without touching the network or filesystem.
powershell -File scripts/doom/stage-doom-fixture.ps1 -PlanOnly
```

### Parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `-FixtureDir` | `<repo>\.opencode\tmp\2968\fixtures` | Destination. |
| `-EngineCommit` | `eded41b5597b7738ec1fa06d24f62b53db982c2c` | Pinned commit forwarded to the build script. |
| `-SourceInstallDir` | `%APPDATA%\com.fredo.app\doom` | Reuse an already-staged engine/WAD from here before building/downloading. |
| `-Msys2Root` | auto-probe | Forwarded to the build script. |
| `-SkipEngine` / `-SkipIwad` | off | Require the artifact to already be staged. |
| `-PlanOnly` | off | Print the plan + exports only (no network/filesystem writes). |

### Environment

| Variable | Effect |
|----------|--------|
| `FREDO_DOOM_BUILD_OFFLINE=1` | Refuse the network: no IWAD download; exit **3** when none is staged. |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Staged OK — stdout carries the `NAME=value` env exports. |
| `2` | **TOOLING GAP** — the engine toolchain is absent / the engine could not be produced. |
| `3` | Offline requested, or a download failed / failed its pin. |
| `4` | IWAD extraction or SHA-256 verification failed. |

### AC4 / R-1.4 induction levers

The script prints these; inject one at a time via the dev-environment skill
(`dev-env.ps1 -Action Up -Spec 2968 -EnvVar "NAME=value"`). Every seam is inert
when unset.

| Env | Induces |
|-----|---------|
| `FREDO_DOOM_ENGINE_PATH=<engine/doom-engine.invalid.exe>` | `spawnFailed` |
| `FREDO_DOOM_IWAD_PATH=<freedoom/missing.wad>` | `notConfigured` |
| `FREDO_DOOM_ARCHIVE_URL` + `_SHA256` + `_BYTES` | `acquireFailed` |
| `FREDO_DOOM_REQUIRE_REAL_ENGINE=1` + the built stub path | anti-stub refusal |
| `FREDO_DOOM_BUILD_OFFLINE=1` | build-script failure (`build-restful-doom.ps1` exit 3) |
| `FREDO_DOOM_STUB_FRAME_503=<count\|duration>` | `frameNotReady` (stub only; e.g. `10`, `250ms`, `2s`, `1m`) |

## Relationship to the runtime

The runtime resolves the engine (`apps/tauri/src-tauri/src/features/doom/resolver.rs`)
in the order **configured → PATH → staged `<install_dir>/engine/restful-doom.exe`**.
This script is the sanctioned producer of the staged candidate. The engine is
launched by the runtime as an arm's-length child process over loopback HTTP; the
build itself never runs inside Fredo.
