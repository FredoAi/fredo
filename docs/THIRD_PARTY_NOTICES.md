# Third-Party Notices

This file records the third-party components that Fredo **bundles** or **depends on**, together
with their licenses and required attributions. Fredo itself is dual-licensed under the MIT and
Apache-2.0 licenses — see the repository-root [`LICENSE`](../LICENSE),
[`LICENSE-MIT`](../LICENSE-MIT), and [`LICENSE-APACHE-2.0`](../LICENSE-APACHE-2.0).

> **Scope.** Fredo ships three classes of third-party component with a distribution obligation:
>
> 1. **The companion inference runtime** — `llama.cpp` (built through the `llama-cpp-4` /
>    `llama-cpp-sys-4` Rust bindings and shipped as native runtime DLLs **beside `fredo.exe` in the
>    install directory**, the `engine-payload/` resource tree) plus the native GPU runtime
>    redistributable that build links against (Vulkan). See §1 and §2.
> 2. **Doom Mode** — the game data (`DOOM1.WAD`) and the engine (`neurodoom`). See §3 and §4.
> 3. Nothing else is bundled with a source-distribution obligation.
>
> Since Spec #3141 the companion runtime is **in-process** (no `llama-server` executable is shipped
> and no separate inference program is distributed); since Spec #3158 the `llama.cpp`/ggml build
> ships as the `engine-payload/` DLL set beside `fredo.exe`, so the engine is loaded in-process
> rather than linked into the executable.

---

## 1. Companion inference runtime — `llama.cpp` (via `llama-cpp-4` / `llama-cpp-sys-4`)

| Field | Value |
|-------|-------|
| Component | `llama.cpp` (upstream engine) |
| Linked through | `llama-cpp-4` 0.11.0 + `llama-cpp-sys-4` 0.11.0 (Rust bindings; pinned in `apps/tauri/src-tauri/Cargo.toml` / `Cargo.lock`) |
| Pinned upstream revision | `785322d17f` (`b12032+1`), from `https://github.com/ggml-org/llama.cpp` |
| License | **MIT OR Apache-2.0** (`llama-cpp-4`/`llama-cpp-sys-4` are dual-licensed; upstream `llama.cpp` is MIT) |
| Upstream | https://github.com/ggml-org/llama.cpp |
| Bindings upstream | https://github.com/eugenehp/llama-cpp-rs |
| Distribution form | **Shipped as native runtime DLLs** beside `fredo.exe` in the install directory (the `engine-payload/` bundle resource tree) — no `llama-server` executable, no separate inference program, no runtime download of the engine |
| Use in Fredo | The companion's in-process inference engine (`applications/llm_server/engine/`): model loading, chat templating, sampling, MTP speculative decoding, and multimodal (`mtmd`) vision/audio encoding. |

**Why it is recorded here.** `llama.cpp` is the engine that actually runs the companion model. It is
built from the crate's pinned upstream revision and shipped as the compiled `engine-payload/` DLLs
beside `fredo.exe`, so Fredo distributes a compiled copy of it. Both the MIT and Apache-2.0 licenses
permit this provided the copyright and license notices are retained — the upstream `LICENSE` (MIT)
and the crate's chosen dual license cover the shipped artifact.

---

## 2. Native GPU runtime redistributables (Vulkan)

The release build enables the `vulkan` backend (with CPU always available) so ggml can select a
device at runtime. The backend links against a vendor redistributable that the installer therefore
ships or depends on:

| Component | Role | License / terms | Upstream |
|-----------|------|-----------------|----------|
| **Vulkan** (loader + headers; the GPU driver's Vulkan ICD is supplied by the machine's graphics driver) | The GPU backend for the `vulkan` build feature | **Apache-2.0** (Vulkan-Headers / Vulkan-Loader, Khronos Group) | https://www.vulkan.org/ · https://github.com/KhronosGroup/Vulkan-Loader |
| **ggml** (in-tree in `llama.cpp`) | The tensor/graph backend both the GPU path and the CPU path run on | **MIT** (same upstream `llama.cpp` repository) | https://github.com/ggml-org/ggml |

**Notes.**
- The Vulkan ICD (driver) is **not** bundled — it comes from the user's installed graphics driver;
  Fredo bundles only the loader/headers it links, under Apache-2.0.
- **There is no CUDA redistributable.** The `cuda` backend is not compiled: Vulkan covers NVIDIA,
  AMD and Intel from a single code path, and the CUDA build (71 `.cu` translation units through
  `nvcc`/`cicc`/`ptxas`) dominated the native build cost for a 10-30% inference gain on one vendor.
  Re-introducing it would mean re-adding the `cuda` feature, the `CUDA_PATH` import-library wiring
  in `apps/tauri/src-tauri/build.rs`, the toolkit step in both workflows, and the NVIDIA EULA entry
  in the table above.
- If a release build enables only the CPU backend, no GPU redistributable is included; the entry
  above applies to the shipped Vulkan build described in `docs/ARCHITECTURE.md`.

---

## 3. Doom Mode engine — `neurodoom` 0.6.7

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
§5). Because it is a **cargo dependency** (not vendored source), Fredo distributes no engine source
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

## 4. Doom Mode game data — `DOOM1.WAD` (id Software shareware)

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

## 5. Removed GPL corresponding-source obligation (RESTful-DOOM)

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

The Doom Mode side ships **no engine source, no engine binary, and no toolchain**; its only artifact
with a distribution obligation is the shareware `DOOM1.WAD` recorded in §4.

---

## 6. Removed out-of-process companion runtime (open question)

Spec #3141 replaced the previously-bundled **`llama-server` executable** with the in-process
`llama-cpp-4` runtime documented in §1. No separate inference binary is built, bundled, or
distributed any more, so the previous notices entry for a bundled server executable no longer
applies. The `llama.cpp` engine itself is still distributed — now as the `engine-payload/` DLLs
beside `fredo.exe` (§1) — and the GPU runtime redistributables it links are recorded in §2.

---

*Authored by Developer — Spec #3023 (ST-8); amended by Spec #3141 (ST-6).*
