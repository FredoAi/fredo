# Doom Mode — Acquisition, WAD, GPL-2.0 & Packaging Decision

- **Issue:** #2968 (Doom Mode Slice 1 — acquisition/GPL/packaging decision; **rewritten by the fix round, ST-7**)
- **Date:** 2026-10-04 (fix round; original 2026-10-03)
- **Status:** DECIDED — engine = **built from source at development/QA time** by the committed
  MSYS2 MINGW64 build script (`scripts/doom/build-restful-doom.ps1`); game data = **Freedoom
  (libre) default**, retail WAD user-supplied only; engine runs as an **arm's-length separate
  process over loopback HTTP**; installer ships **no GPL binary and no WAD**.
- **Raw captures (provenance):** [`spikes/2968-doom-runtime/`](../spikes/2968-doom-runtime/README.md)
  ([live build + contract](../spikes/2968-doom-runtime/engine-build.md) ·
  [acquisition finding](../spikes/2968-doom-runtime/engine-acquisition.md) ·
  [contract](../spikes/2968-doom-runtime/engine-contract.md) ·
  [Freedoom](../spikes/2968-doom-runtime/freedoom-iwad.md) ·
  [provenance](../spikes/2968-doom-runtime/sources.md))

This document satisfies **AC5** ("The acquisition, WAD, GPL/packaging decision is recorded and
reviewable, and the Windows build path (toolchain/dependencies) is documented well enough to
reproduce"). It is the reviewable record; the spike directory holds the raw captures it is derived
from.

> **Fix-round change.** The Slice-1 document decided "engine = user-supplied binary; runtime-download
> deferred" because the planning spike could not build in-sandbox and found no trustworthy prebuilt.
> The human-directed fix round **supersedes** that engine decision: the real engine is now **built
> from source** at dev/QA time by a committed, reproducible script, and launched/supervised as the
> real `restful-doom.exe`. §2.2 is marked SUPERSEDED; §2.3, §4, §5 and §6 record the built-engine
> reality. The prior captures remain as provenance.

---

## 1. Decision at a glance

| Question | Decision |
|----------|----------|
| How is the engine obtained? | **Built from source at development/QA time** by the committed `scripts/doom/build-restful-doom.ps1` (MSYS2 MINGW64), staged at `<install_dir>/engine/restful-doom.exe`. The **runtime does NOT build** (no end-user toolchain dependency). Runtime-download remains **deferred** (no trustworthy prebuilt exists — §2.1), but the engine is no longer merely "user-supplied": the repo ships the reproducible producer. |
| How is the game data obtained? | **Freedoom** (libre IWAD) is the default, acquired by **SHA-256-pinned download**. The **retail WAD is user-supplied only** (`doom_iwad_path`); Fredo never downloads or redistributes it. |
| How is GPL-2.0 handled? | The engine runs as a **separate OS process over a loopback HTTP socket** (arm's-length aggregation, not linked). The engine is **built at dev/QA time**, not distributed; the **installer ships no GPL binary**. The acquisition UI surfaces the engine license + source-offer URL. |
| What ships in the installer? | **Nothing engine- or WAD-related** (~0 growth). No GPL binary, no non-open WAD. |
| Is the path reproducible? | **Yes** — §6 gives the pinned commit + the exact Windows toolchain/deps/build/launch argv; `scripts/doom/build-restful-doom.ps1` executes it. |

---

## 2. Engine acquisition decision

### 2.1 Finding (planning spike, ST-1)

**There is no trustworthy prebuilt Windows x86_64 RESTful-DOOM archive.** The cited fork
(`mkschreder/restful-doom`) and its upstream (`jeff-1amstudios/restful-doom`) have **no GitHub
Releases and no Packages** — both are **source-only**. Plain Chocolate Doom *does* publish Windows
binaries, but it has **no HTTP API** and is not a substitute. Full evidence:
[`spikes/2968-doom-runtime/engine-acquisition.md`](../spikes/2968-doom-runtime/engine-acquisition.md).

### 2.2 SUPERSEDED — "user-supplied binary / runtime-download deferred"

> **SUPERSEDED by the fix round (2026-10-04).** The original Slice-1 decision was:
>
> - Engine = **user-supplied binary**; the user builds the fork once or obtains a binary they trust,
>   and points Fredo at it via the `doom_engine_path` setting. Runtime-download **deferred** — no
>   default archive URL.
> - A default acquire therefore failed closed to `notConfigured`.
>
> This was the correct call given a planning spike that **could not build in-sandbox**. It is no
> longer the decision: the human-directed fix round proved the build runs on this toolchain (ST-1)
> and committed the build script (ST-2), so the engine is **built from source** (§2.3). The deferred
> runtime-download mechanism is retained only as an env-gated seam (§2.6); the staged engine is now
> produced by the build script, not by the user.

### 2.3 Decision (fix round) — build from source at dev/QA time

The real **RESTful-DOOM** engine is built from source by the committed, reproducible
`scripts/doom/build-restful-doom.ps1`, which:

1. locates the **MSYS2 MINGW64** toolchain (exit 2 — TOOLING GAP — when absent),
2. refuses all network when `FREDO_DOOM_BUILD_OFFLINE=1` (exit 3),
3. ensures the pinned pacman dependency set (idempotent, `--needed`),
4. clones `mkschreder/restful-doom` and checks out the **pinned commit**,
5. applies the in-repo MinGW portability patch (`scripts/doom/patches/`),
6. runs `./autogen.sh && ./configure --prefix=/mingw64 CFLAGS=-std=gnu11 && make`,
7. stages `src/restful-doom.exe` at **`<install_dir>/engine/restful-doom.exe`** (default install dir
   `%APPDATA%\com.fredo.app\doom`).

**Pinned commit:** `eded41b5597b7738ec1fa06d24f62b53db982c2c`
(`mkschreder/restful-doom`, `api: make a snapshot restore a DETERMINISTIC continuation`).

**Staged artifact (ST-1 build):** 4,928,170 bytes, SHA-256
`539c3377c2c6a24442381dba7e896121af3e64c55491bedd21a27519d112ff98`.

The engine is resolved by the unchanged resolver order — **configured
(`FREDO_DOOM_ENGINE_PATH`/`doom_engine_path`) → PATH → the staged candidate**
`<install_dir>/engine/restful-doom.exe` (`resolver.rs`). Nothing resolves ⇒ `notConfigured`.

**Test seams (all inert when unset).** `FREDO_DOOM_BUILD_OFFLINE=1` (build failure);
`FREDO_DOOM_REQUIRE_REAL_ENGINE=1` (refuse an engine whose basename is not `restful-doom.exe` — the
anti-stub guard); `FREDO_DOOM_ARCHIVE_URL` / `_SHA256` / `_BYTES` (the retained runtime-download
seam). `scripts/doom/stage-doom-fixture.ps1` stages the engine + IWAD into
`.opencode/tmp/2968/fixtures/` and prints the exact exports for these levers.

### 2.4 Why not a third-party binary

A prebuilt of a 2017-era GPL C game engine from an unofficial source has no reproducible build, no
publisher identity, and no canonical digest — it is not a "trustworthy prebuilt asset". The primary
path requires a **SHA-256-pinned** artifact from a canonical release; absent that, **building from
source at the pinned commit** is the correct, supply-chain-safe decision (it is verifiable and
reproducible in a way an unofficial binary is not).

### 2.5 Criteria to re-enable runtime-download later

A future prebuilt becomes pinnable only with: (1) a published reproducible build recipe; (2) a
versioned release/tag with a maintainer-published **SHA-256** (or a signed checksum, as Freedoom
provides); (3) an x86_64 Windows target; (4) a clear license/source-offer. Until then the pinned
URL/SHA-256 stay unset. Building from source (§2.3) does **not** depend on this.

### 2.6 Shipped acquisition surface (CU-3 / ST-4)

`apps/tauri/src-tauri/src/features/doom/acquisition.rs` implements the decision above:

- **No default engine archive URL is compiled in** (`DOOM_ENGINE_ARCHIVE_URL_DEFAULT` is the empty
  string). `acquire_engine` therefore returns `Ok(None)` on the shipped default, and
  `launch_doom_runtime` resolves the **build-script-staged** engine (or a configured/PATH engine) —
  never a bogus download, never a build inside Fredo.
- The env-override mechanism is declared so a future pinned asset can be enabled:
  `FREDO_DOOM_ARCHIVE_URL`, `FREDO_DOOM_ARCHIVE_SHA256`, and `FREDO_DOOM_ARCHIVE_BYTES`. The URL and
  digest are inert when unset. **A configured URL additionally requires the exact byte size**,
  because the shared streaming engine gates on the exact on-disk length (a real pinned archive must
  publish its size alongside the digest); an unsized/unverified archive is refused with
  `acquireFailed`.
- The **Freedoom** archive is pinned (`FREEDOOM_ARCHIVE_URL` + `FREEDOOM_ARCHIVE_SHA256` +
  `FREEDOOM_ARCHIVE_BYTES`, matching §3.1) and acquired through the shared engine; `freedoom1.wad`
  is extracted from the `.zip` by a minimal in-module ZIP reader (stored + raw-deflate), since the
  shared engine is a file downloader, not an archive extractor. Any failure maps to
  `DoomErrorCode::AcquireFailed`.

---

## 3. Game data (WAD) decision

### 3.1 Default: Freedoom (libre)

**Freedoom** provides all the content needed to play without the proprietary retail WADs, under an
open license (BSD-style; `COPYING.adoc`). It is the **default** game data and the only artifact
Fredo downloads.

| Field | Value |
|-------|-------|
| Release | Freedoom **0.13.0** (2024-01-29; tag `v0.13.0`, commit `cfb8644`) |
| Download URL | `https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip` |
| Network-transfer size | **24,143,781 bytes** |
| **SHA-256** | `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59` |
| Checksum source | PGP-signed `freedoom-0.13.0-CHECKSUM` (same release) |
| Default IWAD in zip | **`freedoom1.wad`** (Phase 1, Ultimate-Doom-compatible) — also `freedoom2.wad` (Phase 2, Doom-II-compatible) |
| Extracted `freedoom1.wad` | **28,795,076 bytes**, SHA-256 `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` (ST-1 build capture) |

The archive SHA-256 above is the pin for the `acquisition.rs` manifest constant; the extracted-IWAD
digest is the ST-1 staging verification. Acquisition goes through the shared
`infrastructure/companion/download` engine (`download_missing_files`), staged under
`{app_data_dir}/doom/`. Details: [`freedoom-iwad.md`](../spikes/2968-doom-runtime/freedoom-iwad.md).

### 3.2 Retail WAD: user-supplied only

`DOOM.WAD` / `DOOM2.WAD` are **proprietary**. Fredo **never** downloads, bundles, or redistributes
them. A user who owns a retail copy may point Fredo at it via the `doom_iwad_path` setting; that
path is a user action outside Fredo's distribution. The default remains Freedoom.

---

## 4. GPL-2.0 posture

RESTful-DOOM is a fork of **Chocolate Doom**, distributed under the **GNU GPL, version 2** (the
fork's `configure.ac` declares `PACKAGE_LICENSE="GNU General Public License, version 2"`; the
upstream README states "Chocolate Doom is distributed under the GNU GPL").

**How Fredo stays at arm's length:**

1. **Separate process.** The engine is spawned as its own OS child process (no shell), exactly like
   the managed `llama-server` (`std::process::Command` + `CREATE_NO_WINDOW`). It is **not** linked
   into the Fredo binary, and no GPL headers/symbols are compiled into Fredo.
2. **Loopback HTTP boundary.** Fredo communicates with the engine only over a `127.0.0.1` HTTP
   socket (`/api/state`, `/api/step`, `/api/frame`). Process boundary + network boundary = an
   arm's-length aggregation, not a derived work of Fredo's own artifact.
3. **No GPL binary in the installer.** The engine is **built at development/QA time** by the
   committed `scripts/doom/build-restful-doom.ps1` and staged into the local app-data directory. It
   is **not part of Fredo's distribution**: the build script and the staged binary never enter the
   Tauri bundle, and Fredo's distribution carries **no GPL obligation on its own artifact**.
4. **License + source offer surfaced.** When Fredo offers to use/acquire an engine, the acquisition
   UI surfaces the engine's license and its upstream source URL (the fork) so the user can obtain
   corresponding source. The fork's source is the canonical source-offer location; the build script
   pins the exact commit, making the corresponding source unambiguous.
5. **A future runtime-download would re-open the obligation.** The `FREDO_DOOM_ARCHIVE_URL` seam is
   inert by default (§2.6). If Fredo later ships a runtime-download of a GPL engine binary, that
   distribution step must include the GPL §3 corresponding-source offer. This is **not** in scope
   while the engine is built at dev/QA time, and is recorded as the gate on re-enabling
   runtime-download (§2.5).

The Freedoom WAD is open-licensed and carries no such obligation; the retail WAD is never
distributed.

---

## 5. Packaging decision

- **Installer delta for engine/WAD: ~0 bytes.** The Tauri bundle ships **no engine binary** and
  **no WAD**.
- The engine is produced by `scripts/doom/build-restful-doom.ps1` at **dev/QA time** and staged at
  `<install_dir>/engine/restful-doom.exe`; the runtime **resolves** it (§2.3) but never builds.
  Freedoom is downloaded on demand to `{app_data_dir}/doom/` (§3.1); the retail WAD is
  user-supplied (§3.2).
- The `doom` window's failure paths render in-window (typed `DoomErrorCode`) and never panic the
  app; a missing engine/WAD yields `notConfigured`, a failed download `acquireFailed`, a failed
  spawn `spawnFailed` (AC4).
- NFR-6 (shared acquisition engine): all downloads use the single shared
  `infrastructure/companion/download` façade — no forked downloader.

---

## 6. Reproducible Windows build recipe

The engine is built from source at development/QA time. **Platform:** Windows x86_64. **Shell:**
MSYS2 "MINGW64" (a POSIX shell is required for the autotools build). The committed script
`scripts/doom/build-restful-doom.ps1` automates the whole recipe; this section records it so a
reviewer can reproduce it by hand.

### 6.1 Toolchain (verified on the ST-1 host)

- **MSYS2** (https://www.msys2.org/) — provides the MinGW-w64 toolchain and the autotools.
- In the **MSYS2 MINGW64** shell, the pinned dependency set (the script installs exactly this with
  `pacman -S --needed`):

```bash
pacman -S --needed base-devel git \
  mingw-w64-x86_64-toolchain \
  mingw-w64-x86_64-SDL2 \
  mingw-w64-x86_64-SDL2_mixer \
  mingw-w64-x86_64-SDL2_net \
  mingw-w64-x86_64-libsamplerate \
  mingw-w64-x86_64-libpng
```

- **Verified versions (ST-1):** gcc 16.2.0, SDL2 2.32.10, SDL2_mixer 2.8.2, SDL2_net 2.4.0,
  libsamplerate 0.2.2, libpng 1.6.59, autoconf 2.73, automake + libtool present, make 4.4.1.
- **Dependencies** (declared in the fork's `configure.ac`): **SDL2 ≥ 2.0.2** (required),
  **SDL2_mixer** (required), **SDL2_net** (required), libsamplerate (optional), libpng/zlib
  (optional), `libm`, `windres` (MinGW resource compiler), autoconf/automake/pkg-config. Python is
  optional.

### 6.2 Get + build the fork

The sanctioned producer is the committed script:

```powershell
powershell -File scripts/doom/build-restful-doom.ps1
# -> stages <install_dir>\engine\restful-doom.exe and prints that path (exit 0)
```

The manual equivalent (what the script runs inside MSYS2 MINGW64):

```bash
git clone https://github.com/mkschreder/restful-doom.git
cd restful-doom
git checkout --force eded41b5597b7738ec1fa06d24f62b53db982c2c
# apply the in-repo MinGW portability patch (scripts/doom/patches/0001-mingw-portability.patch)
./autogen.sh
./configure --prefix=/mingw64 CFLAGS='-std=gnu11'
make
```

- Output: **`src/restful-doom.exe`**; the script copies it to
  `<install_dir>/engine/restful-doom.exe` and writes a `.restful-doom-commit` marker (idempotency).
- **Why the patches/flags (ST-1 findings):**
  - `CFLAGS='-std=gnu11'` is **required**: this 2017-era fork predates C23 and gcc 16 defaults to
    `-std=gnu23`, where `false`/`true` are keywords, so its `doomtype.h` boolean enum fails to
    compile.
  - `scripts/doom/patches/0001-mingw-portability.patch` provides the two POSIX-only functions
    MinGW-w64 lacks: a `strcasestr` built from `strncasecmp` (the `Connection: close` header test)
    and a `reopen_snapshot()` `tmpfile()` path replacing `fmemopen` in the snapshot layer. The script
    re-applies the patch after the forced checkout on every run.
- `chocpkg` (the fork's own bootstrap) primarily targets Linux/macOS; the MSYS2-native path above is
  the practical Windows path.

### 6.3 Launch argv (exact)

```text
restful-doom.exe -iwad <path\to\freedoom1.wad> -apiport <port> -apilockstep -noblit -warp 1 1 -skill 3 -nosound -nomusic
```

| Flag | Note |
|------|------|
| `-iwad <path>` | The IWAD — `freedoom1.wad` by default; a retail WAD only if user-supplied. |
| **`-apiport <port>`** | **The port flag is `-apiport`.** (The Triage Plan's `-port` was a guess; ST-1 corrected it.) |
| `-apilockstep` | The game advances only on `POST /api/step`; without it, step returns **409**. |
| `-noblit` | Keep rendering into the framebuffer (so `/api/frame` works) while skipping present. |
| `-warp 1 1` | Episode 1 / map 1 (Doom-1 style, `freedoom1.wad`). Phase 2 uses `-warp <map>`. |
| `-skill <0–4>` | Difficulty. |
| `-nosound -nomusic` | No audio. |
| `-apiverbose` | Optional; per-request access log (off by default). |

**Framebuffer-only lever (ST-1 finding).** `-noblit` alone is **insufficient**: `i_video.c` only
makes `I_FinishUpdate` early-return, but `SetVideoMode` still calls `SDL_CreateWindow`, so a visible
OS window appears. To run framebuffer-only the child must be launched with
**`SDL_VIDEODRIVER=dummy`** (verified: `tasklist /v` window title `N/A` while `/api/state`,
`/api/step`, and `/api/frame` all still return 200). The runtime sets this in `spawn_doom`'s child
env (ST-5).

**Runtime-DLL dependency (ST-1 finding).** The engine links the MSYS2 SDL2 / SDL2_mixer / SDL2_net /
libpng / libsamplerate DLLs. With no `C:\msys64\mingw64\bin` on the child PATH it exits immediately
with **no output** (Windows DLL-not-found), indistinguishable from a silent crash. The runtime must
therefore stage the required DLLs beside the engine (or put the MINGW64 bin on the child PATH);
`scripts/doom/stage-doom-fixture.ps1` stages them into the fixture directory for QA.

Full contract + the plan divergences (frame is indexed8 JSON, not PNG; step body is `{tics,
actions}`) are in [`engine-contract.md`](../spikes/2968-doom-runtime/engine-contract.md).

### 6.4 Engine HTTP surface (as consumed by Fredo)

```http
GET  http://127.0.0.1:{port}/api/state   -> 200 application/json   # whole observation (one request)
POST http://127.0.0.1:{port}/api/step    -> 200 application/json   # body {tics, actions}; post-step state
GET  http://127.0.0.1:{port}/api/frame   -> 200 application/json   # {width,height,format:"indexed8",pixels,palette}
                                         -> 503 (transient: graphics not up yet) -> frameNotReady
```

All engine HTTP is **Rust-side** (the webview CSP forbids `connect-src` to the engine; the webview
receives decoded frames). The engine binds **loopback only**.

---

## 7. Cross-check against the ST-1 captures (no drift)

| Claim in this doc | ST-1 capture | Consistent? |
|-------------------|--------------|-------------|
| Engine builds + stages from the pinned commit | `engine-build.md` §2 (exit 0, staged path) | yes |
| Pinned commit `eded41b5…` | `engine-build.md` §2 + `build-restful-doom.ps1` default | yes |
| Toolchain + deps + versions | `engine-build.md` §1 | yes |
| `-std=gnu11` + portability patch | `engine-build.md` §3 (P-3, P-4) | yes |
| Freedoom URL + SHA-256 + bytes | `engine-build.md` §4 + `freedoom-iwad.md` | yes |
| Extracted `freedoom1.wad` digest | `engine-build.md` §4 | yes |
| Port flag `-apiport` | `engine-build.md` §5 + `engine-contract.md` | yes |
| `/api/frame` = indexed8 JSON | `engine-build.md` §5 + `engine-contract.md` | yes |
| `POST /api/step` = `{tics, actions}` | `engine-build.md` §5 + `engine-contract.md` | yes |
| `SDL_VIDEODRIVER=dummy` framebuffer lever | `engine-build.md` §6 | yes |
| MSYS2 DLL dependency | `engine-build.md` §6 | yes |
| GPL-2.0 + source-only | `engine-acquisition.md` + `sources.md` (`configure.ac` license line) | yes |

No drift: every number/flag above is copied from the ST-1 captures, which cite the upstream URLs.

---

## 8. Open items & risks

1. **Runtime-download deferred (engine).** Re-enabling requires a canonical, reproducible,
   SHA-256-pinned prebuilt (§2.5). Until then the engine is built from source at dev/QA time; the
   `FREDO_DOOM_ARCHIVE_URL` seam stays inert.
2. **Runtime DLL dependency.** A staged engine is only launchable with its MSYS2 DLLs beside it (or
   MINGW64 on the child PATH). The runtime owns staging them for the production path (ST-5);
   `stage-doom-fixture.ps1` stages them for QA. An engine launched without them is indistinguishable
   from a failed launch (§6.3).
3. **SDL video.** `-noblit` does not suppress the OS window; `SDL_VIDEODRIVER=dummy` is the
   confirmed framebuffer-only lever (§6.3). ST-5 sets it in the child env.
4. **Contract divergences reconciled in CU-3** (from ST-1): `-apiport` (not `-port`); the
   `/api/frame` indexed8 + palette JSON is expanded by the Rust client (`client.rs`) to a base64 PNG
   so CU-4's canvas keeps the binding `DoomFrame { png_base64 }` shape; `POST /api/step` sends
   `{tics, actions}`. `/api/state` stays a shape-agnostic `serde_json::Value` passthrough.

---

*Authored by Developer (fix round, ST-7). Original Slice-1 decision doc retained in git history;
this revision supersedes §2.2 and records the built-engine reality.*
