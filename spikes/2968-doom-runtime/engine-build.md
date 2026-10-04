# Spike #2968 — ST-1 Phase-0 live build + engine-contract confirmation (fix round)

- **Issue:** #2968 (Doom Mode Slice 1 — human-directed reopen / fix round)
- **Date:** 2026-10-04
- **Sub-task:** ST-1 (Phase-0 live build + engine-contract confirmation, 3 SP)
- **Status:** **CONFIRMED LIVE.** The real `restful-doom.exe` was built from source at the pinned
  commit, staged, launched, and its HTTP/frame contract confirmed end-to-end. The SDL framebuffer
  finding (which gates ST-5) is recorded in §6.

This capture supersedes the previous (blocked) revision of this file: MSYS2 MINGW64 is present on
this machine and the round's build-path sandbox grants are active, so the Phase-0 legs that were
previously unverified now ran.

---

## 1. Environment (verified)

| Component | Value |
|---|---|
| MSYS2 root | `C:\msys64` |
| Compiler | `gcc` 16.2.0 (`mingw-w64-x86_64-gcc-16.2.0-4`) |
| SDL2 | 2.32.10 |
| SDL2_mixer | 2.8.2 |
| SDL2_net | 2.4.0 |
| libsamplerate | 0.2.2 |
| libpng | 1.6.59 |
| autoconf / automake / libtool / make | autoconf 2.73 / present / present / 4.4.1 |
| Network | reachable (clone + pinned Freedoom download both succeeded) |

---

## 2. Build — exact command, transcript, exit code

```text
$ powershell -File scripts/doom/build-restful-doom.ps1
...
[build-restful-doom] MSYS2 root: C:\msys64
[build-restful-doom] msys2> pacman -Sy --noconfirm
...
[build-restful-doom] Cloning https://github.com/mkschreder/restful-doom.git -> ...\doom\build\restful-doom
[build-restful-doom] msys2> git clone 'https://github.com/mkschreder/restful-doom.git' '...'
...
[build-restful-doom] msys2> git -C '...' checkout --force 'eded41b5597b7738ec1fa06d24f62b53db982c2c'
HEAD is now at eded41b api: make a snapshot restore a DETERMINISTIC continuation
[build-restful-doom] Applying patch 0001-mingw-portability.patch
[build-restful-doom] msys2> git -C '...' apply --whitespace=nowarn '.../scripts/doom/patches/0001-mingw-portability.patch'
[build-restful-doom] msys2> cd '...' && ./autogen.sh && ./configure --prefix=/mingw64 CFLAGS='-std=gnu11' && make -j$(nproc)
...
  CCLD     restful-doom.exe
  CCLD     restful-setup.exe
[build-restful-doom] Staged ...\build\restful-doom\src\restful-doom.exe -> ...\doom\engine\restful-doom.exe (commit eded41b5597b7738ec1fa06d24f62b53db982c2c)
C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\engine\restful-doom.exe
```

- **Exit code: 0** (stdout is the staged path, one line, per the ST-2 contract).
- **Pinned engine commit:** `eded41b5597b7738ec1fa06d24f62b53db982c2c`
  (`mkschreder/restful-doom`, `api: make a snapshot restore a DETERMINISTIC continuation`).
- **Staged artifact:** `C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\engine\restful-doom.exe`
  — **4,928,170 bytes**, SHA-256 `539c3377c2c6a24442381dba7e896121af3e64c55491bedd21a27519d112ff98`.
- The built binary and the WAD are **not committed and not bundled** (packaging rule).

---

## 3. Patches applied (and why)

The 2017-era fork does not compile as-is against gcc 16 / modern MSYS2, and the committed build
script itself did not run on this host. Four fixes were required. The first three are build-script
fixes (committed in `scripts/doom/build-restful-doom.ps1`); the fourth is the committed patch
`scripts/doom/patches/0001-mingw-portability.patch`.

### P-1 — build script failed to parse (PowerShell 5.1 + UTF-8-no-BOM)
`powershell -File scripts/doom/build-restful-doom.ps1` aborted before doing any work:

```text
At ...build-restful-doom.ps1:201 char:33
+ $buildCmd = "cd '$scratchPosix' && ./autogen.sh && ...
The token '&&' is not a valid statement separator in this version.
```

Root cause: the script was UTF-8 **without a BOM**, containing em-dashes (`—`) and box-drawing
rules (`─`). PowerShell 5.1 decodes a no-BOM file as the system ANSI codepage; the UTF-8 byte
`0x94` decodes to U+201D (a smart double quote) in CP1252, which desynchronised the parser's
string state so the double-quoted string on line 201 was read as closed and `&&` was parsed as an
operator. Fix: normalise the script to pure ASCII (em-dash → `--`, box-drawing → `-`). Verified
in isolation that the identical line parses once the file is ASCII.

### P-2 — `Invoke-Msys2Bash` returned the command's stdout, not its exit code
With the parse fixed, the pacman step reported a bogus failure:

```text
[build-restful-doom] ERROR (2): pacman database refresh failed (exit :: Synchronizing package databases... ... 0).
```

Root cause: `& $bash -lc $Command` left every stdout line on the function's success stream, so
`return $LASTEXITCODE` returned an array of output lines plus the code; `-ne 0` then matched a
non-zero string. Fix: capture `$LASTEXITCODE` into a variable immediately, then relay the output
to the host console; also relax `ErrorActionPreference` locally so pacman's benign stderr
warnings (`... is up to date -- skipping`) are not treated as terminating errors.

### P-3 — gcc 16 defaults to C23, where `false`/`true` are keywords
`make` failed compiling `doomtype.h`:

```text
../../src/doomtype.h:85:5: error: cannot use keyword 'false' as enumeration constant
   85 |     false,
      |     ^~~~~
../../src/doomtype.h:85:5: note: 'false' is a keyword with '-std=c23' onwards
```

Root cause: the fork's `boolean` enum uses `false, true`; gcc 16 defaults to `-std=gnu23`. Fix:
pass `CFLAGS='-std=gnu11'` to `./configure` — the minimal, source-free fix (autoconf 2.73 does not
know about C23 and did not select a standard itself).

### P-4 — POSIX-only `fmemopen` / `strcasestr` (MinGW-w64 has neither)
`make` then failed on the fork's HTTP/API layer:

```text
api_snapshot.c:499:14: error: implicit declaration of function 'fmemopen'; did you mean 'freopen'?
api.c:406:43: error: implicit declaration of function 'strcasestr'; did you mean 'strcasecmp'?
```

Root cause: `fmemopen` and `strcasestr` are POSIX/GNU extensions absent from MinGW-w64 (and gcc 14+
treats implicit declarations as errors). Fix: `scripts/doom/patches/0001-mingw-portability.patch`
adds, under `#ifdef _WIN32`:
- `api.c`: a `strcasestr` built from `strncasecmp` (used only for the `Connection: close` header test);
- `api_snapshot.c`: `reopen_snapshot()`, which stages the in-memory snapshot through a `tmpfile()`
  on Windows (functionally identical to the POSIX `fmemopen` path; only one handle is open per
  restore, so the fd-exhaustion the original comment worries about does not apply).

The build script re-applies the patch after the forced checkout on every run, so a fresh clone
always builds.

---

## 4. Freedoom IWAD (pinned SHA-256)

The sanctioned acquisition is the pinned release in `acquisition.rs`:
`FREEDOOM_ARCHIVE_URL = https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip`,
`FREEDOOM_ARCHIVE_SHA256 = 3f9b264f…`, `FREEDOOM_ARCHIVE_BYTES = 24_143_781`. ST-1 staged it with a
scratch script that mirrors those exact constants (ST-6 owns the durable `stage-doom-fixture.ps1`):

```text
archive=C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\freedoom\freedoom-0.13.0.zip
  bytes=24143781 sha256=3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59
iwad=C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\freedoom\freedoom1.wad
  bytes=28795076 sha256=7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d
```

The archive matches the pinned SHA-256 **exactly**; `freedoom1.wad` is the extracted IWAD staged at
the resolver's expected path (`<install_dir>/freedoom/freedoom1.wad`).

---

## 5. Live HTTP / frame contract (confirmed)

Launched the built engine directly (bounded, G-263) with the exact argv:

```text
restful-doom.exe -iwad <freedoom1.wad> -apiport <port> -apilockstep -noblit -warp 1 1 -skill 3 -nosound -nomusic
```

`GET /api/state` → **200** `application/json`, e.g.:

```json
{"tic":0,"episodeTic":0,"level":{"episode":1,"map":1,"skill":2,"tic":0,"kills":0,"totalKills":29,...},
 "player":{"id":120,"health":100,"armor":0,"x":-416,"y":256,"angle":0,"weapon":"pistol","ammo":50,...},...}
```

| Leg | Request | Result |
|---|---|---|
| whole-state read | `GET /api/state` | **200**, `tic = 0` |
| deterministic step | `POST /api/step` body `{"tics":1,"actions":[]}` | **200**, `tic = 1` |
| post-step read | `GET /api/state` | **200**, `tic = 1` |
| frame | `GET /api/frame` | **200** `{"width":320,"height":200,"format":"indexed8","pixels":"…"(85,336 b64 chars = 64,000 bytes),"palette":"…"(1,024 b64 chars = 768 bytes)}` |

- The step genuinely advanced the simulation: post-step `tic` (1) is strictly greater than the
  pre-step `tic` (0), and a read alone does not advance it.
- `/api/frame` serves the real 320×200 indexed8 framebuffer + palette (not a stub/identity frame).
- No `503` was observed on this run; the engine served `/api/state` 200 on the first poll after the
  TCP port opened.

---

## 6. SDL framebuffer finding (gates ST-5)

`-noblit` **does not** suppress the OS window: `i_video.c` only makes `I_FinishUpdate` early-return
(no blit/upscale/present), but `SetVideoMode` still calls `SDL_CreateWindow`. Empirically, launched
two ways and inspected the live process window title via `tasklist /v`:

| Child env | OS window? | HTTP contract |
|---|---|---|
| default (Windows SDL video driver) | **YES** — a visible window titled `Freedoom: Phase 1 - RESTful Doom 2.2.1` | `/api/state`, `/api/step`, `/api/frame` all 200 |
| `SDL_VIDEODRIVER=dummy` | **NO** — `tasklist /v` window title is `N/A` | `/api/state`, `/api/step`, `/api/frame` all 200 (same indexed8 frame) |

**Finding:** to run framebuffer-only (no second OS window) the child must be launched with
`SDL_VIDEODRIVER=dummy`; `-noblit` alone is insufficient. The dummy driver still populates
`I_VideoBuffer` and serves `/api/frame`, so **ST-5's lever is `SDL_VIDEODRIVER=dummy`** (set in
`spawn_doom`'s child env), not `-noblit`.

**Additional finding (packaging/runtime):** the engine links the MSYS2 SDL2/SDL2_mixer/SDL2_net/
libpng/libsamplerate DLLs. With no `C:\msys64\mingw64\bin` on the child PATH it exits immediately
with **no output** (Windows DLL-not-found), which looks exactly like a silent crash. The live probe
only reached 200 once `C:\msys64\mingw64\bin` was on the child's PATH. ST-2/ST-5 must therefore
either stage the required DLLs beside the engine or put the MINGW64 bin on the child PATH — an
engine launched without it is indistinguishable from a failed launch.

---

## 7. Teardown (G-263)

Both probe runs were bounded: launch → poll `/api/state` (≤25 s) → contract legs → `taskkill /PID
<T> /F` → 2 s wait. After each run `tasklist /FI "IMAGENAME eq restful-doom.exe"` reported
**no tasks**. Final check after both runs: no `restful-doom.exe` process remains. No orphan.

---

## 8. What ST-1 confirms (and what it does not)

Confirmed: MSYS2 MINGW64 + network build the pinned fork to a runnable `restful-doom.exe`; the
build script (with P-1…P-4) produces and stages it; the pinned Freedoom IWAD verifies against its
SHA-256; the engine serves `/api/state` (200 JSON), `/api/step` (advances `tic`), and `/api/frame`
(320×200 indexed8) on `-apiport`; the framebuffer-only lever is `SDL_VIDEODRIVER=dummy`; teardown
leaves no orphan.

Not exercised here (later sub-tasks): the in-app launch path, readiness refinement, and the AC4
error legs. No product code was changed by ST-1.

*Authored by Developer (ST-1 capture).*
