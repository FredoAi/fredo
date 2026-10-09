# Doom Mode — Acquisition, WAD, GPL-2.0 & Packaging Decision

- **Issues:** #2968 (Doom Mode Slice 1 — acquisition/GPL/packaging decision) · **#3012**
  (runtime provisioning from vendored source — this revision)
- **Date:** 2026-10-08 (Spec #3012 revision; Slice-1 fix round 2026-10-04; original 2026-10-03)
- **Status:** DECIDED — engine = **built at RUNTIME on first activation** from the **vendored,
  pinned GPL-2.0 source** at `vendor/restful-doom/` (`scripts/doom/build-restful-doom.ps1
  -SourceDir`) using a **managed MSYS2 toolchain** downloaded on first use; the shipped installer
  carries the **corresponding GPL-2.0 source** (a Tauri resource, no binary); game data =
  **Freedoom (libre) default**, retail WAD user-supplied only; the engine runs as an **arm's-length
  separate process over loopback HTTP**; the installer ships **no GPL engine binary and no WAD**.
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

> **Spec #3012 revision (reverses #2968).** Slice 1 decided the engine was **built at
> development/QA time** by the committed build script, and that the runtime did **not** build ("no
> end-user toolchain dependency"). Spec #3012 supersedes that: the pinned source is now **vendored
> in-repo** (`vendor/restful-doom/`, pinned commit
> `eded41b5597b7738ec1fa06d24f62b53db982c2c`) and **shipped as source**, and the **runtime builds
> the engine on first activation** from that source using a managed toolchain. The installer
> therefore now distributes the **GPL-2.0 corresponding source** — but still **no compiled binary
> and no WAD**. §2.3, §4 and §5 record the runtime-build reality; the §2.2 Slice-1 decision is
> retained as history.

---

## 1. Decision at a glance

| Question | Decision |
|----------|----------|
| How is the engine obtained? | **Built from source at RUNTIME (first activation).** The GPL-2.0 source is **vendored in-repo** at `vendor/restful-doom/` (pinned commit `eded41b…`) and shipped as a Tauri resource; on first activation Fredo downloads a **managed MSYS2 toolchain** and runs `scripts/doom/build-restful-doom.ps1 -SourceDir <vendored>` to produce `<install_dir>/engine/restful-doom.exe`. No toolchain or engine is required on the user's machine beforehand. |
| How is the game data obtained? | **Freedoom** (libre IWAD) is the default, acquired by **SHA-256-pinned download**. The **retail WAD is user-supplied only** (`doom_iwad_path`); Fredo never downloads or redistributes it. |
| How is GPL-2.0 handled? | The **corresponding source is distributed** with Fredo (`vendor/restful-doom/` → `doom/source` resource; `scripts/doom/` → `doom/scripts`) at the exact pinned commit, satisfying the GPL §3 source-offer. The engine runs as a **separate OS process over a loopback HTTP socket** (arm's-length aggregation, not linked); **no compiled GPL binary is bundled or distributed**. The provisioning UI surfaces the license name + source offer. |
| What ships in the installer? | **GPL-2.0 source + build scripts only.** No engine binary, no WAD, no toolchain archive (~tens of MB of vendored text source; no binary). |
| Is the path reproducible? | **Yes** — §6 gives the pinned commit + the exact Windows toolchain/deps/build/launch argv; the vendored tree + `scripts/doom/build-restful-doom.ps1` are both in-repo and shipped. |

---

## 2. Engine acquisition decision

### 2.1 Finding (planning spike, ST-1)

**There is no trustworthy prebuilt Windows x86_64 RESTful-DOOM archive.** The cited fork
(`mkschreder/restful-doom`) and its upstream (`jeff-1amstudios/restful-doom`) have **no GitHub
Releases and no Packages** — both are **source-only**. Plain Chocolate Doom *does* publish Windows
binaries, but it has **no HTTP API** and is not a substitute. Full evidence:
[`spikes/2968-doom-runtime/engine-acquisition.md`](../spikes/2968-doom-runtime/engine-acquisition.md).

### 2.2 SUPERSEDED — "user-supplied binary / build only at dev-QA time"

> **SUPERSEDED by Spec #3012 (2026-10-08).** Slice 1's fix round decided:
>
> - Engine = **built from source at development/QA time** by the committed
>   `scripts/doom/build-restful-doom.ps1`, staged into app-data; **the runtime did not build** and
>   did not depend on an end-user toolchain.
> - The installer shipped **nothing engine-related**; the GPL obligation was avoided by never
>   distributing any engine artifact.
>
> This was correct for a source-only upstream with no trustworthy prebuilt. It is no longer the
> decision: Spec #3012 **vendors the source in-repo** and makes the runtime the producer, so Doom is
> reproducible from a fresh clone with no manual setup. Vendoring the source (rather than avoiding
> distribution) is what discharges the GPL-2.0 obligation — see §4. The Slice-1 build script and its
> findings remain the basis of §6.

### 2.3 Decision (Spec #3012) — build at runtime from the vendored pinned source

The real **RESTful-DOOM** engine is vendored at `vendor/restful-doom/` (upstream
`https://github.com/mkschreder/restful-doom.git`, pinned commit
`eded41b5597b7738ec1fa06d24f62b53db982c2c`; provenance in
[`vendor/restful-doom/VENDOR.md`](../vendor/restful-doom/VENDOR.md)) and built **on first
activation** by the committed `scripts/doom/build-restful-doom.ps1` invoked with `-SourceDir`
pointing at the vendored tree. The provisioning path (Spec #3012 ST-2/ST-3):

1. **Resolves build inputs** — env override (`FREDO_DOOM_SOURCE_DIR`) → the bundled resource
   (Tauri resource_dir `doom/source`) → the repo checkout `vendor/restful-doom/`.
2. **Acquires the managed toolchain** — downloads a single **SHA-256-pinned MSYS2 base archive**
   (URL/SHA-256/byte count recorded by ST-1; see
   [`scripts/doom/README.md`](../scripts/doom/README.md) §"Managed toolchain archive pin") and
   extracts it to `<install_dir>/toolchain/msys2`; `FREDO_DOOM_TOOLCHAIN_ROOT` short-circuits to an
   existing MSYS2 root, and `FREDO_DOOM_BUILD_OFFLINE=1` fails closed **before any network**.
3. **Builds the engine** — copies the vendored tree to scratch (the tracked tree is never
   mutated), applies the in-repo MinGW portability patch (`scripts/doom/patches/`), runs
   `./autogen.sh && ./configure --prefix=/mingw64 CFLAGS=-std=gnu11 && make`, and stages
   `src/restful-doom.exe` with its MSYS2 DLL closure at
   `<install_dir>/engine/restful-doom.exe` (+ `.restful-doom-commit` marker).
4. **Streams progress + is bounded/cancellable** — `doom-provision-progress` events; download ≤ 900 s,
   build ≤ 900 s, overall ≤ 1800 s, cancel hard-kill ≤ 5 s (typed failure, no orphan, retryable).

The engine is resolved at launch **managed-only** — the single staged candidate
`<install_dir>/engine/restful-doom.exe` (validated by `provision::staged_engine_path`;
`apps/tauri/src-tauri/src/applications/doom/resolver.rs`). There is no configured override
and no `PATH` lookup. When the managed engine is absent or unbuilt, the launch reports the
provisioning/failure state (`provisionRequired` / `provisionFailed`) instead of substituting
or downloading another engine. When a staged engine + matching `.restful-doom-commit` marker
already exist, provisioning is **skipped** and the engine launches directly.

**Pinned commit:** `eded41b5597b7738ec1fa06d24f62b53db982c2c`
(`mkschreder/restful-doom`, `api: make a snapshot restore a DETERMINISTIC continuation`).

**Staged artifact (ST-1 build capture):** 4,928,170 bytes, SHA-256
`539c3377c2c6a24442381dba7e896121af3e64c55491bedd21a27519d112ff98`. This is a **build-output**
digest captured for the ST-1 gate; it is **not committed and not bundled** (the engine is
machine/toolchain-derived from source).

**Test seams (all inert when unset).** `FREDO_DOOM_BUILD_OFFLINE=1` (fail closed); the
toolchain-archive overrides `FREDO_DOOM_TOOLCHAIN_ARCHIVE_URL` / `_SHA256` / `_BYTES`;
`FREDO_DOOM_SOURCE_DIR` (missing tree ⇒ `sourceMissing`, broken tree ⇒ `buildFailed`);
`FREDO_DOOM_TOOLCHAIN_ROOT`; the test-only timeouts `FREDO_DOOM_PROVISION_TIMEOUT_S` /
`FREDO_DOOM_BUILD_TIMEOUT_S` / `FREDO_DOOM_TOOLCHAIN_DOWNLOAD_TIMEOUT_S`; and the engine
spawn-failure lever `FREDO_DOOM_FAIL_ENGINE_SPAWN=1` (test-only; inert when unset).
`scripts/doom/stage-doom-fixture.ps1` stages the engine + IWAD into
`.opencode/tmp/2968/fixtures/` and prints the exact exports for the QA levers.

### 2.4 Why not a third-party binary

A prebuilt of a 2017-era GPL C game engine from an unofficial source has no reproducible build, no
publisher identity, and no canonical digest — it is not a "trustworthy prebuilt asset". The primary
path requires a **SHA-256-pinned** artifact from a canonical release; absent that, **building from
source at the pinned commit** is the correct, supply-chain-safe decision (it is verifiable and
reproducible in a way an unofficial binary is not). The engine is now built from the *vendored*
copy of that source, so the build input itself is pinned in-repo, not fetched.

### 2.5 Criteria to re-enable a *prebuilt-engine* download later

A future prebuilt becomes pinnable only with: (1) a published reproducible build recipe; (2) a
versioned release/tag with a maintainer-published **SHA-256** (or a signed checksum, as Freedoom
provides); (3) an x86_64 Windows target; (4) a clear license/source-offer. Until then no engine
archive URL is compiled in. Building from the vendored source (§2.3) does **not** depend on this.

### 2.6 Shipped acquisition surface

- **No engine binary download.** The engine is produced locally from the vendored source; there is
  no engine archive URL. (The Slice-1 `FREDO_DOOM_ARCHIVE_URL` engine-download seam is obsolete and
  is not the acquisition path.)
- **The toolchain is the only large download**, gated on the ST-1-recorded exact byte count +
  SHA-256 of the pinned MSYS2 base archive (`FREDO_DOOM_TOOLCHAIN_ARCHIVE_URL` / `_SHA256` /
  `_BYTES`; see [`scripts/doom/README.md`](../scripts/doom/README.md)). A configured URL requires
  the exact byte size; an unsized/unverified archive is refused.
- **The Freedoom archive is pinned** (`FREEDOOM_ARCHIVE_URL` + `FREEDOOM_ARCHIVE_SHA256` +
  `FREEDOOM_ARCHIVE_BYTES`, matching §3.1) and acquired through the shared streaming engine
  (`infrastructure/companion/download`); `freedoom1.wad` is extracted from the `.zip` by a minimal
  in-module ZIP reader. Any failure maps to a typed `DoomProvisionErrorCode`/`DoomErrorCode`.
- The vendored source + build script are **packaged as Tauri resources**
  (`apps/tauri/src-tauri/tauri.conf.json` → `doom/source`, `doom/scripts`) so a fresh install has
  the build inputs even without the repo checkout.

---

## 3. Game data (WAD) decision

### 3.1 Default: Freedoom (libre)

**Freedoom** provides all the content needed to play without the proprietary retail WADs, under an
open license (BSD-style; `COPYING.adoc`). It is the **default** game data and the only artifact
Fredo downloads (besides the toolchain).

| Field | Value |
|-------|-------|
| Release | Freedoom **0.13.0** (2024-01-29; tag `v0.13.0`, commit `cfb8644`) |
| Download URL | `https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip` |
| Network-transfer size | **24,143,781 bytes** |
| **SHA-256** | `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59` |
| Checksum source | PGP-signed `freedoom-0.13.0-CHECKSUM` (same release) |
| Default IWAD in zip | **`freedoom1.wad`** (Phase 1, Ultimate-Doom-compatible) — also `freedoom2.wad` (Phase 2, Doom-II-compatible) |
| Extracted `freedoom1.wad` | **28,795,076 bytes**, SHA-256 `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` (ST-1 build capture) |

The archive SHA-256 above is the pin for the acquisition manifest constant; the extracted-IWAD
digest is the ST-1 staging verification. Acquisition goes through the shared
`infrastructure/companion/download` engine (`download_missing_files`), staged under
`{app_data_dir}/doom/`. Details: [`freedoom-iwad.md`](../spikes/2968-doom-runtime/freedoom-iwad.md).

### 3.2 Retail WAD: user-supplied only

`DOOM.WAD` / `DOOM2.WAD` are **proprietary**. Fredo **never** downloads, bundles, or redistributes
them. A user who owns a retail copy may point Fredo at it via the `doom_iwad_path` setting; that
path is a user action outside Fredo's distribution. The default remains Freedoom. The provisioning
path **stages no WAD**; the IWAD is acquired separately by the existing pinned `acquire_iwad`.

---

## 4. GPL-2.0 posture (Spec #3012: source is now distributed)

RESTful-DOOM is a fork of **Chocolate Doom**, distributed under the **GNU GPL, version 2** (the
fork's `configure.ac` declares `PACKAGE_LICENSE="GNU General Public License, version 2"`; the
upstream README states "Chocolate Doom is distributed under the GNU GPL").

**How the obligation is discharged:**

1. **Corresponding source is distributed.** The exact pinned source is vendored at
   `vendor/restful-doom/` (pinned commit `eded41b5597b7738ec1fa06d24f62b53db982c2c`, upstream
   `https://github.com/mkschreder/restful-doom.git`, provenance
   [`vendor/restful-doom/VENDOR.md`](../vendor/restful-doom/VENDOR.md)) and is **bundled as a Tauri
   resource** (`apps/tauri/src-tauri/tauri.conf.json` → `doom/source`). This is the GPL §3
   corresponding source for the engine the runtime builds.
2. **No compiled GPL binary is distributed.** The engine is produced locally at first use into
   `<install_dir>` (app-data, outside the Tauri bundle); **no `.exe` is committed, bundled, or
   downloaded**. The installer carries source, not a binary.
3. **Separate process + loopback HTTP boundary.** The engine is spawned as its own OS child process
   (no shell), exactly like the managed `llama-server`; it is **not** linked into the Fredo binary
   and no GPL headers/symbols are compiled into Fredo. Fredo communicates with it only over a
   `127.0.0.1` HTTP socket (`/api/state`, `/api/step`, `/api/frame`) — an arm's-length aggregation.
4. **License + source offer surfaced at provision time.** The provisioning UI renders the engine
   license (**GNU GPL version 2** / GPL-2.0) and the corresponding-source offer — the vendored path
   `vendor/restful-doom/`, the upstream URL, and the pinned commit — before the build starts and
   during it (`doom-provision-license`, `doom-provision-source-offer` in the provisioning dialog,
   `apps/ui/src/applications/doom/DoomProvisionDialog.tsx` — Spec #3012 ST-4).
5. **A future prebuilt-engine download would re-open the obligation** for that artifact; it stays
   disabled (§2.5).

The Freedoom WAD is open-licensed and carries no such obligation; the retail WAD is never
distributed.

---

## 5. Packaging decision (Spec #3012)

- **Installer delta for engine/WAD: GPL-2.0 SOURCE only.** The Tauri bundle ships the vendored
  engine **source** + the build scripts as resources; it ships **no engine binary and no WAD**.
- **Bundle resources** (`apps/tauri/src-tauri/tauri.conf.json`; paths relative to `src-tauri/`):

  ```json
  "resources": {
    "../../../vendor/restful-doom/": "doom/source/",
    "../../../scripts/doom/": "doom/scripts/"
  }
  ```

  Both are **directory** resources, so Tauri copies them recursively **preserving structure**
  (`doom/source/src/…`, `doom/source/configure.ac`, `doom/scripts/build-restful-doom.ps1`,
  `doom/scripts/patches/…`). **No `.exe`/`.wad` glob is declared and none exists under either
  source path** — the resource set is text source + scripts only. The provisioning path resolves
  the build inputs env → bundled resource → repo (`vendor/restful-doom/`).
- The engine is produced at **runtime** into `<install_dir>/engine/restful-doom.exe`; the runtime
  **builds once** on first activation and **skips** on later activations (§2.3). Staged
  engine/WAD/scratch live under `<install_dir>` and are never committed (`.gitignore`).
- The `doom` window's failure paths render in-window (typed codes) and never panic the app; a
  missing engine/WAD yields `notConfigured`, a failed download `acquireFailed`, a failed spawn
  `spawnFailed`, and a failed provision a typed `DoomProvisionErrorCode` surfaced as
  `provisionFailed` (AC4). Since **Spec #3007** the window is **game-only** (no header/footer or
  in-window controls): a runtime failure shows only the typed `doom-error` card + `doom-retry-button`,
  and an autoplay **run** failure shows only the minimal `doom-autoplay-note` (`role="status"` pill) —
  the engine/runtime failure paths are otherwise unchanged.
- NFR-6 (shared acquisition engine): all downloads (toolchain archive, Freedoom) use the single
  shared `infrastructure/companion/download` façade — no forked downloader.

---

## 6. Reproducible Windows build recipe

The engine is built from source **at runtime on first activation** (and standalone by a developer or
QA). **Platform:** Windows x86_64. **Shell:** MSYS2 "MINGW64" (a POSIX shell is required for the
autotools build). The committed script `scripts/doom/build-restful-doom.ps1` automates the whole
recipe; this section records it so a reviewer can reproduce it by hand.

### 6.1 Toolchain (verified on the ST-1 host)

- **MSYS2** (https://www.msys2.org/) — provides the MinGW-w64 toolchain and the autotools. At
  runtime this is acquired **managed**: the pinned MSYS2 base archive is downloaded and extracted to
  `<install_dir>/toolchain/msys2`; `FREDO_DOOM_TOOLCHAIN_ROOT` or an existing MSYS2 root may be used
  instead. The archive pin (URL/SHA-256/bytes) is in
  [`scripts/doom/README.md`](../scripts/doom/README.md).
- In the **MSYS2 MINGW64** shell, the pinned dependency set (the script installs exactly this with
  `pacman -S --needed`):

```bash
pacman -S --needed base-devel git autoconf automake libtool \
  mingw-w64-x86_64-toolchain \
  mingw-w64-x86_64-SDL2 \
  mingw-w64-x86_64-SDL2_mixer \
  mingw-w64-x86_64-SDL2_net \
  mingw-w64-x86_64-libsamplerate \
  mingw-w64-x86_64-libpng
```

- **Verified versions (ST-1):** gcc 16.2.0, SDL2 2.32.10, SDL2_mixer 2.8.2, SDL2_net 2.4.0,
  libsamplerate 0.2.2, libpng 1.6.59, autoconf 2.73, automake + libtool, make 4.4.1.
- **Dependencies** (declared in the fork's `configure.ac`): **SDL2 ≥ 2.0.2** (required),
  **SDL2_mixer** (required), **SDL2_net** (required), libsamplerate (optional), libpng/zlib
  (optional), `libm`, `windres` (MinGW resource compiler), autoconf/automake/pkg-config. Python is
  optional. The autotools (**`autoconf`**, **`automake`**, **`libtool`**) are installed explicitly:
  the pinned MSYS2 base archive's `base-devel` package does not depend on them, and the build's
  `./autogen.sh` runs `autoreconf` (which needs `autoconf` + `automake`; `libtool` matches the
  fork's own `autotools` group).

### 6.2 Build from the vendored source

The sanctioned producer is the committed script, pointed at the vendored tree:

```powershell
powershell -File scripts/doom/build-restful-doom.ps1 -SourceDir vendor/restful-doom
# -> stages <install_dir>\engine\restful-doom.exe and prints that path (exit 0)
```

The runtime invokes the same script via its provisioning path, passing `-SourceDir` (the bundled
`doom/source` resource or `vendor/restful-doom/`) and `-Msys2Root` (the managed
`<install_dir>/toolchain/msys2`). The manual equivalent (what the script runs inside MSYS2 MINGW64):

```bash
# -SourceDir is copied to the scratch dir first; the tracked tree is never mutated.
cd <scratch>/restful-doom
git checkout --force eded41b5597b7738ec1fa06d24f62b53db982c2c   # clone path only
# apply the in-repo MinGW portability patch (scripts/doom/patches/0001-mingw-portability.patch)
./autogen.sh
./configure --prefix=/mingw64 CFLAGS='-std=gnu11'
make
```

- Output: **`src/restful-doom.exe`**; the script copies it to
  `<install_dir>/engine/restful-doom.exe`, stages its MSYS2 DLL closure beside it, and writes a
  `.restful-doom-commit` marker (idempotency).
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
`/api/step`, and `/api/frame` all still return 200).

**Runtime-DLL dependency (ST-1 finding).** The engine links the MSYS2 SDL2 / SDL2_mixer / SDL2_net /
libpng / libsamplerate DLLs. With no MINGW64 `bin` on the child PATH it exits immediately with **no
output** (Windows DLL-not-found), indistinguishable from a silent crash. The build script therefore
stages the required DLL closure beside the engine (Windows searches the executable's own directory
first), so the staged engine is self-contained (§2.3).

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
| Pinned commit `eded41b5…` | `engine-build.md` §2 + `vendor/restful-doom/VENDOR.md` + `build-restful-doom.ps1` default | yes |
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
| Vendored source is the corresponding source | `vendor/restful-doom/VENDOR.md` + `tauri.conf.json` `doom/source` | yes (Spec #3012) |

No drift: every number/flag above is copied from the ST-1 captures, which cite the upstream URLs.

---

## 8. Open items & risks

1. **Managed toolchain availability / pin drift.** The runtime depends on the pinned MSYS2 base
   archive; if the mirror changes the URL/bytes/digest, the pin must be re-recorded
   (`scripts/doom/record-toolchain-pin.ps1`). `FREDO_DOOM_BUILD_OFFLINE=1` fails closed before
   network. The AC5 "no MSYS2" path is the managed download; `FREDO_DOOM_TOOLCHAIN_ROOT` is a
   disclosed shortcut.
2. **Runtime DLL dependency.** A staged engine is only launchable with its MSYS2 DLLs beside it (or
   MINGW64 on the child PATH); the build script stages the closure so the staged engine is
   self-contained (§6.3). An engine launched without them is indistinguishable from a failed launch.
3. **SDL video.** `-noblit` does not suppress the OS window; `SDL_VIDEODRIVER=dummy` is the
   confirmed framebuffer-only lever (§6.3).
4. **Repo hygiene.** `vendor/restful-doom/**` is tracked SOURCE only (`text eol=lf
   linguist-vendored` in `.gitattributes`, so the patches apply and the tree is excluded from
   language stats); no `.exe`/`.wad` is committed or bundled, and staged engine/WAD/scratch stay
   untracked (`.gitignore`). Repo growth is the source tree only (~tens of MB, no binary).
5. **Contract divergences reconciled in the runtime client** (from ST-1): `-apiport` (not `-port`);
   the `/api/frame` indexed8 + palette JSON is expanded by the Rust client to a base64 PNG; `POST
   /api/step` sends `{tics, actions}`. `/api/state` stays a shape-agnostic `serde_json::Value`
   passthrough.

---

*Authored by Developer (Spec #3012, ST-5). Supersedes the Slice-1 (#2968) "build at dev/QA time"
decision; the original decision doc is retained in git history.*
