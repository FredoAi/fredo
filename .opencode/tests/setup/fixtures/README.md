# setup fixtures — `opencode` shims (#3198)

QA-authored test data for the version gate. Every leg that drives the gate goes through the
committed forwarder `.opencode/scripts/setup-version-shim.ps1`.

| File | Behaviour of `opencode --version` | Drives |
|---|---|---|
| `shim-opencode-1x/opencode.cmd` | prints `OpenCode 1.15.5`, exit 0; every other argv exits 1 | AC1 in-app + CLI (F-9, F-10) |
| `shim-opencode-junk/opencode.cmd` | prints `hello from a fake cli`, exit 0 (unparseable → `parse_major() == None`) | R-1b undetermined (F-11) |
| `shim-opencode-nonzero/opencode.cmd` | no output, exit 1 (probe's non-zero-exit path) | R-1b undetermined (F-11) |
| `shim-opencode-slow/opencode.cmd` | blocks ~7 s, then prints `OpenCode 1.15.5` | NFR-3 probe bound (F-12) |
| `shim-opencode-service-ok/opencode.cmd` | `opencode v2.4.1`; `service status` → `http://127.0.0.1:28894` exit 0 (no longer probed); `service restart` → exit 0 **and journaled** | No-restart guard: a real write must dispatch nothing (F-17 b / S-10) |

The `*-service-ok` fixture is the **fake control CLI** kept from fix-plan addendum ST-A5: it is
reached through the product's own resolver, so `install_plugin` → version gate → hash-guarded write
→ result/exit code runs inside the product with **zero** contact with the real background service
(which hosts this pipeline's own session — G-461). Round 3 removed the install-time restart, so the
receipt is inverted: the journal must stay **EMPTY**. The two fixtures that existed only for the
deleted restart-failure and no-service branches (`shim-opencode-service-fail`,
`shim-opencode-service-none`) and their roster rows were deleted with the same round-3 re-cut.

**Journal contract.** `service restart` appends its argv to `%FREDO_QA_SHIM_JOURNAL%`, else to
`%TEMP%\fredo-3198-shim-journal.txt`. Set the journal explicitly per run (it is the receipt): the
CLI leg sets it inside a scratch wrapper under `.opencode/tmp/3198/`; the in-app leg sets it with
the forwarder's `-ExtraEnvVar "FREDO_QA_SHIM_JOURNAL=<abs path>"`. Delete the journal file before
the first run, then `Get-Content` it: **absent or empty is the PASS** — one line `service restart`
means the removed dispatch came back.

**Version literal.** Every service fixture reports `opencode v2.4.1` — a major **≥**
`MIN_SUPPORTED_OPENCODE_MAJOR`. If that constant ever exceeds 2 the fixtures must be bumped in the
same pass (G-136/G-428); the rows read the constant at test time and would catch the drift.

## L-1 — PATH shadowing is the forwarder's job, and **no `.exe` fixture may exist**

The product probes the runtime with `where.exe` over each candidate **in order** —
`opencode.exe`, `opencode.cmd`, `opencode.bat`, bare
(`apps/tauri/src-tauri/src/infrastructure/opencode_version.rs` `resolve_opencode_binary()`), and
`where.exe` scans the **whole PATH** for one candidate before the next is tried. On a host with an
installed `opencode.exe` (a bun install puts one in `%USERPROFILE%\.bun\bin`) a `.cmd`-only shim
never wins, so the app probes the real runtime and AC1's in-app face is undriven. Round 1 hit
exactly this.

**Rejected: an `opencode.exe`-named fixture.** A `.cmd` renamed `opencode.exe` is not a PE image;
`CreateProcessW` refuses it, so the probe would report R-1b's *undetermined* state instead of
R-1a's *unsupported* one — the wrong row passing for the wrong reason. A real `.exe` stub is not
authorable in-repo (no compiler in the sandbox, and a binary blob is forbidden).

**The fix lives in the forwarder** (work item F4 — Toolsmith/Machinist-owned; QA never edits it):
`powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode <Up|Restart|Cli> -ShimDir <fixture
dir> [...]` prepends the fixture directory **and drops every PATH entry that resolves an
`opencode.*`**, then hands the same PATH to `dev-env.ps1` (which never recomposes PATH itself).
**This is AC2-critical, not only AC1** (addendum ST-A6): the fake control CLI above is reachable
only through that same resolver, so without the shadow fix the dispatch receipts cannot run.

**Two recipes that look plausible but do not work:**

* `-EnvVar "PATH=<fixture dir>"` — a PATH holding only the fixture cannot boot: `-Action Up` runs
  `pnpm dev:tauri`, whose `beforeDevCommand` is `pnpm --filter @fredo/fredo-opencode-plugin build`
  → `bun build`, so `pnpm`/`bun`/`node` must stay reachable. (Dropping the whole `.bun\bin`
  directory instead also drops `bun` and breaks the same step.)
* prepending the fixture without dropping the installed binary — see above.

**Drive gate (product-side, not harness-side):** the check/plan payload's `binary_path` (plan step
`in_path`) must resolve **inside the fixture directory** and the detected version token must be the
fixture's (`1.15.5`; absent for the R-1b fixtures; `2.4.1` for the three service fixtures, which must
pass the gate so the install path runs). A payload naming the host's installed runtime is a
**FAILED DRIVE** — never a product FAIL. `where opencode.exe` on the host is the discriminating
control: a payload reporting the fixture's token on a host whose `where opencode.exe` names a path
cannot have come from the installed runtime.

## L-2 — the slow fixture must not hold the captured pipe

`ping -n 8` is a `cmd.exe` **grandchild**, and `run_bounded` kills only the direct child
(`opencode_version.rs:369-384`). Unredirected, `ping` inherits the invocation's captured stdout pipe
(shell → `fredo` → `cmd.exe` → `ping`), so after the product's kill the survivor keeps the pipe
open, the shell waits for it, and the invocation measures **7 270 ms** while the product's 5 000 ms
bound fired correctly. The fixture therefore redirects **both** streams
(`ping -n 8 127.0.0.1 >nul 2>nul`), leaving the survivor no handle to the captured pipe.

The asserted observable is the **product's own** timeout branch — the undetermined detail containing
`did not finish within` plus the rendered `VERSION_PROBE_TIMEOUT_MS` value
(`opencode_version.rs:53`, `:376-379`) — with the shim's wall clock demoted to a hang detector
(≤ 15 s). `powershell -File` + `fredo` startup sit outside the product's budget; the shell's clock
is recorded, never the AC (F-12).

## Retired round-1 candidate

`boot-with-shim.ps1` (a QA-authored filtered-PATH wrapper that discovered the shadowing binary and
bridged `bun` back) was **rejected in round 2**: the shadowing belongs in the forwarder (F4), and a
suites-folder script is not executable in the tester's sandbox anyway (only `.opencode/scripts/*`
and `.opencode/tmp/*` are). **It is not referenced by any row — delete
`.opencode/tests/setup/fixtures/boot-with-shim.ps1` and `.opencode/tmp/3198/boot-with-shim.ps1`.**
