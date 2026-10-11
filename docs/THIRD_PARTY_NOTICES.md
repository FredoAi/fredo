# Third-Party Notices

This file records the third-party components that Fredo **bundles** or **depends on**, together
with their licenses and required attributions. Fredo itself is dual-licensed under the MIT and
Apache-2.0 licenses — see the repository-root [`LICENSE`](../LICENSE),
[`LICENSE-MIT`](../LICENSE-MIT), and [`LICENSE-APACHE-2.0`](../LICENSE-APACHE-2.0).

> **Scope.** The only third-party component with a distribution obligation that Fredo ships today
> is the Doom Mode game data (`DOOM1.WAD`). The Doom Mode engine is an ordinary cargo dependency
> (`neurodoom`, BSD-3-Clause) — pure Rust, in-process, and **not** vendored or bundled as source.

---

## 1. Doom Mode engine — `neurodoom` 0.6.7

| Field | Value |
|-------|-------|
| Component | `neurodoom` |
| Version | **0.6.7** (pinned in `apps/tauri/src-tauri/Cargo.toml`; resolved in `Cargo.lock`) |
| License | **BSD-3-Clause** |
| Upstream | https://codeberg.org/olanod/NeuroDoom |
| Package page | https://crates.io/crates/neurodoom/0.6.7 |
| Author / publisher | Daniel Olano (`olanod`) |
| Distribution form | Cargo dependency — **not vendored**, **not shipped as source**, **not prebuilt** |
| Use in Fredo | Doom Mode's native, in-process, deterministic, headless Doom engine adapter (`apps/tauri/src-tauri/src/applications/doom/engine.rs`) embedded with the bundled `DOOM1.WAD`. |

**Why it was chosen (license).** `neurodoom` is pure Rust (`#![no_std]` + `alloc`, `std` feature on
by default) and permissively licensed under **BSD-3-Clause**, so it carries **no GPL obligation and
no corresponding-source obligation**. It replaces the previous GPL-2.0 RESTful-DOOM engine (see
§3). Because it is a **cargo dependency** (not vendored source), Fredo distributes no engine source
and builds no engine at runtime.

### BSD 3-Clause License

Copyright (c) 2025, NeuroDoom contributors

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

---

## 2. Doom Mode game data — `DOOM1.WAD` (id Software shareware)

| Field | Value |
|-------|-------|
| File | `apps/tauri/src-tauri/doom/DOOM1.WAD` (bundled, **tracked** in git) |
| Size | 4,196,020 bytes |
| Content | id Software DOOM, **shareware** release — Episode 1, "Knee-Deep in the Dead" (`E1M1`–`E1M9`) |
| Provenance | id Software's shareware distribution of DOOM v1.9 (distribution archive `doom19s.zip`), released for free redistribution |
| Modification | **Unmodified** — the upstream shareware IWAD, byte-for-byte |
| Use in Fredo | The native engine's IWAD input; embedded into the binary at build time (`include_bytes!`) and embedded in the app bundle. |

**Redistribution note.** The DOOM shareware release is the first episode of DOOM, which id Software
released expressly for free redistribution. id Software's shareware distribution terms permit
redistributing the shareware episode **in its original, unmodified form** free of charge (no fee
beyond a reasonable cost of duplication/distribution). Fredo therefore bundles the unmodified
shareware `DOOM1.WAD` as Doom Mode's game data — **not** the retail/commercial `DOOM.WAD`, which is
proprietary and is never downloaded, bundled, or redistributed.

References:

- id Software shareware distribution — `doom19s.zip` / `doom19s.txt` on
  `ftp://ftp.idsoftware.com/idstuff/doom/`, mirrored in the idgames archive
  (https://www.doomworld.com/idgames/?id=7043).
- Doom Wiki — *Shareware* (the first nine-level episode, shared for free redistribution):
  https://doom.fandom.com/wiki/Shareware

**Trademarks.** DOOM and the DOOM logo are trademarks of id Software LLC / ZeniMax Media Inc. Fredo
is **not affiliated with, endorsed by, or sponsored by** id Software; the DOOM name is used only to
identify the bundled shareware game data.

---

## 3. Removed GPL corresponding-source obligation (RESTful-DOOM)

The previous Doom Mode engine was **RESTful-DOOM**, a fork of Chocolate Doom distributed under the
**GNU GPL, version 2**. Fredo discharged that obligation by vendoring the exact pinned GPL-2.0
**corresponding source** in-repo and shipping it as a Tauri bundle resource (Spec #3012;
`doom/source` / `doom/scripts`).

Spec #3023 replaced that engine with the BSD-3-Clause `neurodoom` adapter. The GPL
corresponding-source obligation therefore **no longer applies**, and Spec #3023 (ST-6) has removed
the resources it required:

- `vendor/restful-doom/**` — the vendored GPL-2.0 corresponding source. **Removed.**
- `scripts/doom/**` — the from-source build scripts and patches. **Removed.**
- `apps/tauri/src-tauri/tauri.conf.json` → the `bundle.resources` entries
  (`"../../../vendor/restful-doom/": "doom/source/"` and `"../../../scripts/doom/": "doom/scripts/"`)
  — the GPL corresponding-source bundle resources. **Removed.**
- `docs/doom-mode-acquisition.md` — the superseded GPL/provisioning decision record. **Removed.**

The bundle now ships **no engine source, no engine binary, and no toolchain**; the only Doom Mode
artifact with a distribution obligation is the shareware `DOOM1.WAD` recorded in §2.

---

*Authored by Developer — Spec #3023 (ST-8).*
