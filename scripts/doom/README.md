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

## Relationship to the runtime

The runtime resolves the engine (`apps/tauri/src-tauri/src/features/doom/resolver.rs`)
in the order **configured → PATH → staged `<install_dir>/engine/restful-doom.exe`**.
This script is the sanctioned producer of the staged candidate. The engine is
launched by the runtime as an arm's-length child process over loopback HTTP; the
build itself never runs inside Fredo.
