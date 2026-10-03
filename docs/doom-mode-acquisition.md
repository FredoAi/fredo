# Doom Mode — Acquisition, WAD, GPL-2.0 & Packaging Decision

- **Issue:** #2968 (Doom Mode Slice 1 — ST-9 decision doc; informed by the ST-1 Phase-0 spike)
- **Date:** 2026-10-03
- **Status:** DECIDED — engine = **user-supplied binary + documented build recipe** (no trustworthy
  prebuilt exists); game data = **Freedoom (libre) default**, retail WAD user-supplied only;
  engine runs as an **arm's-length separate process over loopback HTTP**; installer ships **no GPL
  binary and no WAD**.
- **Raw ST-1 captures:** [`spikes/2968-doom-runtime/`](../spikes/2968-doom-runtime/README.md)
  ([engine finding](../spikes/2968-doom-runtime/engine-acquisition.md) ·
  [contract](../spikes/2968-doom-runtime/engine-contract.md) ·
  [Freedoom](../spikes/2968-doom-runtime/freedoom-iwad.md) ·
  [provenance](../spikes/2968-doom-runtime/sources.md))

This document satisfies **AC5** ("The acquisition, WAD, GPL/packaging decision is recorded and
reviewable, and the Windows build path (toolchain/dependencies) is documented well enough to
reproduce"). It is the reviewable record; the spike directory holds the raw captures it is derived
from.

---

## 1. Decision at a glance

| Question | Decision |
|----------|----------|
| How is the engine obtained? | **User-supplied binary** via the `doom_engine_path` setting (resolved configured → PATH → *no downloaded fallback*). **Runtime-download is deferred** — no trustworthy prebuilt asset exists (ST-1). |
| How is the game data obtained? | **Freedoom** (libre IWAD) is the default, acquired by **SHA-256-pinned download**. The **retail WAD is user-supplied only** (`doom_iwad_path`); Fredo never downloads or redistributes it. |
| How is GPL-2.0 handled? | The engine runs as a **separate OS process over a loopback HTTP socket** (arm's-length aggregation, not linked). The **installer ships no GPL binary**. The acquisition UI surfaces the engine license + source-offer URL. |
| What ships in the installer? | **Nothing engine- or WAD-related** (~0 growth). No GPL binary, no non-open WAD. |
| Is the path reproducible? | **Yes** — §6 gives the pinned artifacts + the exact Windows toolchain/deps/build/launch argv. |

---

## 2. Engine acquisition decision

### 2.1 Finding (ST-1)

**There is no trustworthy prebuilt Windows x86_64 RESTful-DOOM archive.** The cited fork
(`mkschreder/restful-doom`) and its upstream (`jeff-1amstudios/restful-doom`) have **no GitHub
Releases and no Packages** — both are **source-only**. Plain Chocolate Doom *does* publish Windows
binaries, but it has **no HTTP API** and is not a substitute. Full evidence:
[`spikes/2968-doom-runtime/engine-acquisition.md`](../spikes/2968-doom-runtime/engine-acquisition.md).

### 2.2 Decision

Take the plan's pre-authorized **fallback**:

- **Engine = user-supplied binary.** The user builds the fork once (recipe in §6) or obtains a
  binary they trust, and points Fredo at it via the `doom_engine_path` setting. Resolution order
  mirrors `resolve_llama_server_order`: **configured `doom_engine_path` → PATH → (no downloaded
  fallback)**. When nothing resolves, the window renders the typed `notConfigured` error (AC4) —
  never a bogus download.
- **Runtime-download is deferred, not deleted.** ST-4 may keep the
  `FREDO_DOOM_ARCHIVE_URL` / `FREDO_DOOM_ARCHIVE_SHA256` env-override mechanism (mirroring
  `FREDO_PG_ARCHIVE_URL`/`_SHA256`) so a future pinned asset can be enabled, but with **no default
  URL**. A default acquire therefore fails closed to `notConfigured`.

### 2.3 Why not a third-party binary

A prebuilt of a 2017-era GPL C game engine from an unofficial source has no reproducible build, no
publisher identity, and no canonical digest — it is not a "trustworthy prebuilt asset". The primary
path requires a **SHA-256-pinned** artifact from a canonical release; absent that, the documented
fallback is the correct, supply-chain-safe decision.

### 2.4 Criteria to re-enable runtime-download later

A future prebuilt becomes pinnable only with: (1) a published reproducible build recipe; (2) a
versioned release/tag with a maintainer-published **SHA-256** (or a signed checksum, as Freedoom
provides); (3) an x86_64 Windows target; (4) a clear license/source-offer. Until then the pinned
URL/SHA-256 stay unset.

### 2.5 Shipped acquisition surface (CU-3 / ST-4)

`apps/tauri/src-tauri/src/features/doom/acquisition.rs` implements the decision above:

- **No default engine archive URL is compiled in** (`DOOM_ENGINE_ARCHIVE_URL_DEFAULT` is the empty
  string). `acquire_engine` therefore returns `Ok(None)` on the shipped default, and
  `launch_doom_runtime` falls back to the user-supplied `doom_engine_path` — never a bogus download,
  never a build failure.
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

The SHA-256 above is the pin for ST-4's manifest constant. Acquisition goes through the shared
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
3. **No GPL binary in the installer.** Because the engine is **user-supplied**, Fredo's
   distribution carries **no GPL obligation on its own artifact**. Fredo does not distribute the
   engine at all.
4. **License + source offer surfaced.** When Fredo offers to use/acquire an engine, the acquisition
   UI surfaces the engine's license and its upstream source URL (the fork) so the user can obtain
   corresponding source. The fork's source is the canonical source-offer location.
5. **Deferred runtime-download would re-open the obligation.** If Fredo later ships a
   runtime-download of a GPL engine binary, that distribution step must include the GPL §3
   corresponding-source offer. This is **not** in scope while the engine is user-supplied, and is
   recorded as the gate on re-enabling runtime-download (§2.4).

The Freedoom WAD is open-licensed and carries no such obligation; the retail WAD is never
distributed.

---

## 5. Packaging decision

- **Installer delta for engine/WAD: ~0 bytes.** The Tauri bundle ships **no engine binary** and
  **no WAD**.
- The engine is resolved at runtime from a user path (§2.2); Freedoom is downloaded on demand to
  `{app_data_dir}/doom/` (§3.1); the retail WAD is user-supplied (§3.2).
- The `doom` window's failure paths render in-window (typed `DoomErrorCode`) and never panic the
  app; a missing engine/WAD yields `notConfigured`, a failed download `acquireFailed` (AC4).
- NFR-6 (shared acquisition engine): all downloads use the single shared
  `infrastructure/companion/download` façade — no forked downloader.

---

## 6. Reproducible Windows build recipe

The engine is built from source once, per machine. **Platform:** Windows x86_64. **Shell:** MSYS2
"MINGW64" (a POSIX shell is required for the autotools build).

### 6.1 Toolchain

- **MSYS2** (https://www.msys2.org/) — provides the MinGW-w64 toolchain and the autotools.
- In the **MSYS2 MINGW64** shell:

```bash
pacman -Syu
pacman -S --needed base-devel git \
  mingw-w64-x86_64-toolchain \
  mingw-w64-x86_64-SDL2 \
  mingw-w64-x86_64-SDL2_mixer \
  mingw-w64-x86_64-SDL2_net \
  mingw-w64-x86_64-libsamplerate \
  mingw-w64-x86_64-libpng
```

- **Dependencies** (declared in the fork's `configure.ac`): **SDL2 ≥ 2.0.2** (required),
  **SDL2_mixer** (required), **SDL2_net** (required), libsamplerate (optional), libpng/zlib
  (optional), `libm`, `windres` (MinGW resource compiler), autoconf/automake/pkg-config. Python is
  optional.

### 6.2 Get + build the fork

```bash
git clone https://github.com/mkschreder/restful-doom.git
cd restful-doom

# Option A — the fork's intended dependency/bootstrap path (uses vendored chocpkg).
#   ./configure-and-build.sh   # -> cd chocpkg && chocpkg/chocpkg build restful-doom

# Option B — MSYS2-native path (uses the MSYS2 SDL2 packages installed above).
./autogen.sh          # generates configure from configure.ac (autotools)
./configure --prefix=/mingw64
make
```

- Output: **`src/restful-doom.exe`** (the fork's README: "`src/restful-doom` will be created if the
  compile succeeds").
- `chocpkg` is a set of shell scripts primarily targeting Linux/macOS; on Windows, **Option B** is
  the practical path because MSYS2 supplies the SDL2 packages directly.

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

Full contract + the plan divergences (frame is indexed8 JSON, not PNG; step body is `{tics,
actions}`) are in [`engine-contract.md`](../spikes/2968-doom-runtime/engine-contract.md).

### 6.4 Engine HTTP surface (as consumed by Fredo)

```http
GET  http://127.0.0.1:{port}/api/state   -> 200 application/json   # whole observation (one request)
POST http://127.0.0.1:{port}/api/step    -> 200 application/json   # body {tics, actions}; post-step state
GET  http://127.0.0.1:{port}/api/frame   -> 200 application/json   # {width,height,format:"indexed8",pixels,palette}
```

All engine HTTP is **Rust-side** (the webview CSP forbids `connect-src` to the engine; the webview
receives decoded frames). The engine binds **loopback only**.

---

## 7. Cross-check against the ST-1 captures (no drift)

| Claim in this doc | ST-1 capture | Consistent? |
|-------------------|--------------|-------------|
| Engine has no prebuilt | `engine-acquisition.md` §Evidence (both release indices = 0) | yes |
| Freedoom URL + SHA-256 | `freedoom-iwad.md` pinned table | yes |
| Port flag `-apiport` | `engine-contract.md` launch argv | yes |
| `/api/frame` = indexed8 JSON | `engine-contract.md` `GET /api/frame` | yes |
| `POST /api/step` = `{tics, actions}` | `engine-contract.md` `POST /api/step` | yes |
| GPL-2.0 + source-only | `engine-acquisition.md` + `sources.md` (`configure.ac` license line) | yes |

No drift: every number/flag above is copied from the ST-1 captures, which cite the upstream URLs.

---

## 8. Open items & risks

1. **Runtime-download deferred (engine).** Re-enabling requires a canonical, reproducible,
   SHA-256-pinned prebuilt (§2.4). Until then, engine acquisition is user-supplied.
2. **Contract divergences reconciled in CU-3** (from ST-1): `-apiport` (not `-port`); the
   `/api/frame` indexed8 + palette JSON is expanded by the Rust client (`client.rs`) to a base64 PNG
   so CU-4's canvas keeps the binding `DoomFrame { png_base64 }` shape; `POST /api/step` sends
   `{tics, actions}`. `/api/state` stays a shape-agnostic `serde_json::Value` passthrough.
3. **Headless/SDL video.** `-noblit` skips present, but the fork still initialises SDL video; a
   truly headless run may need `SDL_VIDEODRIVER=dummy` or a hidden window. Unverified in this spike
   (no binary could be built in-sandbox) — flagged for ST-3 to confirm at launch.
4. **Sandbox limitation.** The sandbox cannot download binary archives or build C/SDL/autotools, so
   the build recipe is **sourced from upstream build scripts**, not executed here. The engine
   finding itself rests on the authoritative release indices (a repo either has a Release asset or
   it does not), not on a local build.

---

*Authored by Developer*
