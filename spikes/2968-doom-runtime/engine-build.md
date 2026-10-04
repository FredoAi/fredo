# Spike #2968 — ST-1 Phase-0 live build + engine-contract confirmation (fix round)

- **Issue:** #2968 (Doom Mode Slice 1 — human-directed reopen / fix round)
- **Date:** 2026-10-04
- **Sub-task:** ST-1 (Phase-0 live build + engine-contract confirmation, 3 SP)
- **Status:** **BLOCKED — TOOLING GAP** (MSYS2 MINGW64 absent) **and sandbox command denial** (see §5).
  The live build and the live HTTP/frame confirmation could **not** be executed in this environment.

This capture records exactly what was attempted, what the environment returned, and what remains
unverified. It is the raw evidence for the `block` action; it does **not** claim a build that did
not happen (G-033/G-172).

---

## 1. Question

1. Is **MSYS2 MINGW64** present on this machine, and is the network reachable?
2. Can `mkschreder/restful-doom` be cloned, configured, and built to a runnable
   `src/restful-doom.exe`?
3. Does the built engine, launched with `-apiport`, serve `GET /api/state`, `POST /api/step`
   (body `{tics, actions}`), and `GET /api/frame`?
4. Does `-noblit` (with `SDL_VIDEODRIVER=dummy` if needed) render into the framebuffer without a
   second OS window / without a display?

---

## 2. Method + exact commands

The build path is gated by the sandbox permissions granted for this round
(`powershell -File scripts/doom/*`, `git clone*`, `*restful-doom*`). Those grants are present in
`opencode.json` (lines 330-332) but were **not active in this opencode session** — the effective
permission set is the pre-grant one, so the sanctioned commands were refused (see §5).

### 2.1 Network + toolchain probe (read-only)

A read-only probe was run through the developer-allowed `node` tool
(`node .opencode/tmp/2968/probe-env.mjs`, worktree `.worktrees/2968-a`). It performs only
`fs.existsSync` checks and one HTTPS `HEAD` to `github.com`. Full probe paths:
`C:/msys64`, `C:/msys64/usr/bin/{bash,pacman}.exe`, `C:/msys64/mingw64/bin/{bash,gcc,make,git}.exe`,
`C:/msys64/mingw64/include/SDL2/SDL.h`, and
`C:/msys64/mingw64/lib/{libSDL2,libSDL2_mixer,libSDL2_net}.dll.a`, `libpng.a`, `libsamplerate.a`.

Transcript (verbatim):

```text
absent   C:/msys64
absent   C:/msys64/usr/bin/bash.exe
absent   C:/msys64/usr/bin/pacman.exe
absent   C:/msys64/mingw64/bin/bash.exe
absent   C:/msys64/mingw64/bin/gcc.exe
absent   C:/msys64/mingw64/bin/make.exe
absent   C:/msys64/mingw64/bin/git.exe
absent   C:/msys64/mingw64/include/SDL2/SDL.h
absent   C:/msys64/mingw64/lib/libSDL2.dll.a
absent   C:/msys64/mingw64/lib/libSDL2_mixer.dll.a
absent   C:/msys64/mingw64/lib/libSDL2_net.dll.a
absent   C:/msys64/mingw64/lib/libpng.a
absent   C:/msys64/mingw64/lib/libsamplerate.a
WHERE bash: C:\Windows\System32\bash.exe | C:\Users\pktro\AppData\Local\Microsoft\WindowsApps\bash.exe
WHERE gcc: not found on PATH
WHERE make: not found on PATH
WHERE git: C:\Program Files\Git\cmd\git.exe
WHERE pacman: not found on PATH
WHERE sh: not found on PATH
NETWORK github.com: HTTP 200
NETWORK github.com: TIMEOUT
```

> `bash` on PATH is the **WSL launcher** (`C:\Windows\System32\bash.exe`), not MSYS2 MINGW64; no
> `gcc`/`make`/`pacman`/`sh` are on PATH. The trailing `NETWORK ... TIMEOUT` line is the probe's
> own request-timeout event firing after the HTTP 200 response had already resolved the promise
> (the socket was not destroyed on success); the authoritative result is **HTTP 200 — network is
> reachable**.

### 2.2 Clone the fork (sanctioned command — DENIED)

```text
$ git clone https://github.com/mkschreder/restful-doom.git "C:\Users\pktro\AppData\Local\Temp\opencode\restful-doom"
DENIED by the sandbox: no rule matched (the effective allow-list is the pre-grant set; it contains
no `git clone*` rule). Exact denial reproduced in §5.
```

### 2.3 Run the build script (sanctioned command — DENIED)

```text
$ powershell -File scripts/doom/build-restful-doom.ps1
DENIED by the sandbox: the effective allow-list contains no `powershell -File scripts/doom/*` rule.
```

### 2.4 Resolve the pinned commit (allowed `webfetch`)

`GET https://api.github.com/repos/mkschreder/restful-doom/commits?per_page=3` (default-branch HEAD):

| # | Commit | Date | Summary |
|---|--------|------|---------|
| 1 | `eded41b5597b7738ec1fa06d24f62b53db982c2c` | 2026-09-23 | `api: make a snapshot restore a DETERMINISTIC continuation` |
| 2 | `2decd23f3912f971033e0d5c81a06426898d89de` | 2026-09-21 | `api: a snapshot outlives a change of level` |
| 3 | `8bbd4230b157df20c3ca3c3053bf8f41b2384d82` | 2026-09-21 | `api: a snapshot outlives an episode of the same level` |

**Pinned engine commit (ST-1 output): `eded41b5597b7738ec1fa06d24f62b53db982c2c`.**

This is the default used by `scripts/doom/build-restful-doom.ps1 -EngineCommit`.

---

## 3. Findings

| # | Question | Finding |
|---|----------|---------|
| 1 | MSYS2 MINGW64 present? | **NO.** `C:\msys64` does not exist; no MSYS2 `bash`/`gcc`/`make`/`pacman`/`sh` on PATH. Only the WSL `bash.exe` launcher is present. |
| 2 | Network reachable? | **YES.** HTTPS `HEAD https://github.com/` → HTTP 200. |
| 3 | SDL2 / SDL2_mixer / SDL2_net / libsamplerate / libpng dev libs present? | **NO.** They are MSYS2 packages and MSYS2 is absent. |
| 4 | Fork cloned / built? | **NO.** The clone command is denied by the sandbox (§5); the toolchain is also absent, so no build is possible even if the clone were allowed. |
| 5 | Engine serves `/api/state`, `/api/step`, `/api/frame` on `-apiport`? | **NOT CONFIRMED LIVE.** The contract is documented from the upstream RAML spec/README in [`engine-contract.md`](engine-contract.md); the built-engine confirmation is the unverified leg. |
| 6 | `-noblit` / `SDL_VIDEODRIVER=dummy` framebuffer finding? | **NOT CONFIRMED.** Requires a built binary to run. This was the ST-1 question that ST-5 depends on. |

---

## 4. What was delivered anyway (ST-2)

`scripts/doom/build-restful-doom.ps1` + `scripts/doom/README.md` were written and committed. The
script implements the ST-2 contract in full — pinned commit default, MSYS2 MINGW64 discovery,
idempotent dependency install, clone/checkout/build, staging to
`<InstallDir>/engine/restful-doom.exe`, `FREDO_DOOM_BUILD_OFFLINE=1` refusal, and the typed exit
codes `0/2/3/4`. It **could not be executed** in this session (§5); it is untested on this machine
for that reason. Its correctness must be validated once MSYS2 MINGW64 is installed and the
build-path sandbox grants are active.

---

## 5. Blockers (exact)

### 5.1 TOOLING GAP — MSYS2 MINGW64 absent (primary)

- **Tried:** read-only presence probe of `C:\msys64` and its `usr\bin`/`mingw64\bin` toolchain, plus
  `where` for `bash`/`gcc`/`make`/`git`/`pacman`/`sh` (§2.1).
- **Missing dependency/tool:** MSYS2 MINGW64 (`bash`, `gcc`, `make`, `pacman`) and, transitively,
  the `mingw-w64-x86_64-SDL2*` dev packages the fork requires.
- **Exact command + error:** `C:\msys64` absent; `WHERE gcc: not found on PATH`;
  `WHERE make: not found on PATH`; `WHERE pacman: not found on PATH`; `WHERE sh: not found on PATH`.

### 5.2 Sandbox command denial — build-path grants not active in this session

The SI granted the developer/tester the build-path bash permissions in `opencode.json`
(lines 330-332: `powershell -File scripts/doom/*`, `git clone*`, `*restful-doom*`). The effective
permission set in **this opencode session** is the pre-grant set, so the sanctioned commands are
refused. Denied commands and their denials:

| Command | Result |
|---------|--------|
| `git clone https://github.com/mkschreder/restful-doom.git "…\restful-doom"` | DENIED — effective allow-list has no `git clone*` rule. |
| `powershell -File scripts/doom/build-restful-doom.ps1` | DENIED — effective allow-list has no `powershell -File scripts/doom/*` rule. |
| `git -C .worktrees/2968-a status --short --branch` | DENIED — no `git -C *` rule (worked around by using the tool's `workdir` parameter, which is not a sandbox bypass). |

Per the dispatch brief, these were **not** worked around; they are reported here for the SI to
resolve (restart opencode so the config reloads, then re-dispatch ST-1/ST-2 verification).

---

## 6. What ST-1 must still confirm (once unblocked)

1. Clone + build `mkschreder/restful-doom` at `eded41b5597b7738ec1fa06d24f62b53db982c2c` with the
   MSYS2 MINGW64 dependency set; capture the `autogen.sh`/`configure`/`make` transcript.
2. Launch `src/restful-doom.exe -iwad <freedoom1.wad> -apiport <port> -apilockstep -noblit -warp 1 1
   -skill 3 -nosound -nomusic` and confirm `GET /api/state` 200, `POST /api/step {tics,actions}`
   200, `GET /api/frame` 200 on `-apiport` (bounded start/stop; no orphan — G-263).
3. Confirm the SDL-video finding: does `-noblit` (+ `SDL_VIDEODRIVER=dummy` if needed) render into
   the framebuffer without a second OS window / without a display? This gates ST-5.

---

*Authored by Developer (ST-1 capture).*
