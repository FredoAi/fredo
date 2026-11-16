# ST-1 raw capture — engine acquisition finding

- **Issue:** #2968 · **Date:** 2026-10-03
- **Question:** Is there a trustworthy **prebuilt Windows x86_64 RESTful-DOOM archive** to pin by
  URL + SHA-256 for runtime-download?

## Finding

**NO trustworthy prebuilt asset exists.** The RESTful-DOOM fork is **source-only**; there is no
official binary distribution and no release asset to pin. Runtime-download of a prebuilt engine is
therefore **not possible today** and is **deferred**; the pre-authorized fallback (per the Triage
Plan's Acquisition Decision item 1) applies: **user-supplied engine binary + a documented Windows
build recipe**.

## Evidence

| Source | Checked | Result |
|--------|---------|--------|
| `https://github.com/mkschreder/restful-doom/releases` (the fork the issue cites) | Releases / Tags | "**There aren't any releases here**" — 0 releases, 0 packages |
| `https://github.com/jeff-1amstudios/restful-doom/releases` (the upstream fork) | Releases / Tags | "**There aren't any releases here**" — 0 releases, 0 packages |
| `mkschreder/restful-doom` repo root | file list | Source tree only (`src/`, `RAML/`, `data/`, `chocpkg/`, autotools files); no `dist/`, no prebuilt `*.exe`/`*.zip` |
| `https://github.com/chocolate-doom/chocolate-doom/releases` | Releases | Upstream **Chocolate Doom** ships Windows binaries — but it has **no HTTP API** (`/api/state`, `/api/step`, `/api/frame`). It is **not** a substitute for the RESTful fork. |

The fork's own README confirms the source-only posture: the only documented acquisition path is
"Building dependencies … `./configure-and-build.sh`" then "Run `make` … `src/restful-doom` will be
created if the compile succeeds." There is no download/binary section.

**Trust caveat (why we do not go hunting):** a random third-party binary of a 2017-era GPL C game
engine is not a "trustworthy prebuilt asset" — there is no reproducible build, no publisher identity,
and no digest from a canonical source. The plan's primary path requires a **SHA-256-pinned** asset
from a canonical release; absent that, the fallback is the correct decision, not a supply-chain risk.

## Consequence (what downstream capsules must do)

- **ST-4 (`acquisition.rs`)** must **not** attempt to download an engine. Engine resolution is
  **user-supplied**: configured `doom_engine_path` → PATH → (no downloaded fallback). The
  `FREDO_DOOM_ARCHIVE_URL` / `FREDO_DOOM_ARCHIVE_SHA256` env-override mechanism may still be declared
  for a future pinned asset, but with **no default URL** (or a default that is absent/inert), so a
  default acquire fails closed to `notConfigured`, not to a bogus download.
- **Freedoom** is the only artifact acquired by download (it *does* have a canonical pinned release;
  see [`freedoom-iwad.md`](freedoom-iwad.md)).
- The **decision doc** (`docs/doom-mode-acquisition.md`) records the engine decision + the
  reproducible Windows build recipe (AC5), and marks runtime-download as deferred.

## What a future prebuilt would have to satisfy (so the primary path can be re-enabled)

For a prebuilt to become pinnable, it must come from a canonical source with all of:

1. A **reproducible build** recipe published alongside the artifact (toolchain + deps pinned).
2. A **versioned release/tag** with an immutable **SHA-256** digest published by the maintainer (or
   a digest we can verify against a signed checksum, as Freedoom does).
3. An **x86_64 Windows** target artifact.
4. A clear **license/source-offer** (the engine is GPL-2.0 — see the decision doc's GPL posture).

Until then, the pinned URL + SHA-256 fields stay unset and runtime-download is deferred.

## Sandbox limitation (recorded, not a filesystem hunt)

The implementation sandbox **cannot fetch or execute binary archives** (`webfetch` returns
text/HTML; there is no download/`curl` lever) and **has no C/SDL/autotools toolchain**, so this
finding is derived from the authoritative upstream release indices and build scripts — **not** from a
local build attempt. No filesystem search outside `C:\Code\fredo` was performed (G-172). This is the
same limitation the plan anticipated; it does **not** block the fallback, which is documentation-only.
