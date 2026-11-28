# The AC1 falsification receipt — both directions, all rows OBSERVED (Spec #3201 ST-8)

**A guard whose reddening you have not seen is a guard you have not tested (G-406).**
Every row below was executed on this tree, the mutation applied, the command run, the
output pasted, and the mutation reverted. Nothing here is asserted from reading the code.

Tree: the developer worktree detached at **`87cdcbc`** (`spec/3201` tip; ST-7 landed, the
platform compiles). Cargo target dir: the shared out-of-tree
`C:\Code\fredo\.opencode\state\cargo-target`. Guard invocations go through
`.opencode/scripts/run-exitcode.ps1` (the sanctioned native-exit-code harness — the
developer sandbox cannot chain commands, so `$LASTEXITCODE` is otherwise unreachable), and
every one carries `EXITCODE=` in its output.

---

## The two instruments, and why BOTH are required

AC1 ("the crate cannot reach the platform") is an **absence claim**, and an absence claim
with no failing mode is not a measurement. Two layered instruments assert it because they
answer different questions and each has a stated limit:

| | Instrument | Question it answers | How |
|---|---|---|---|
| **(i)** | `.opencode/scripts/verify-domain-boundary.ps1` | Does the **resolved dependency graph** of the crate contain the platform, directly or transitively? | `cargo tree -p telemetry-domain --edges normal,build`, parsed node-wise |
| **(ii)** | `.opencode/scripts/guard-universe.ps1` (**reused as-is, never forked**) | Does the crate's **source text** name a platform symbol the graph never sees? | token scan over the crate tree |

**Instrument (i)'s disclosed limit.** It proves the resolved graph only. It is blind to a
source-level reference that never becomes a dependency edge — a `use crate::infrastructure::…`
left in a `#[cfg(test)]` module is not an edge. Instrument (ii) closes that.

**Instrument (ii)'s disclosed limit.** `guard-universe.ps1` is a **text** scan and cannot
see a transitively-resolved `path` dependency — the word simply is not in the file it reads.
Instrument (i) closes that.

**Neither instrument alone satisfies AC1.** They are bound together for exactly this reason,
and row 4 below is the executed proof that the text instrument alone would ship a false green.

---

## The asymmetry (Spec #3201 §7) — asserted, never forbidden

The direction invariant is **asymmetric**:

> **The crate must never depend on the platform. A platform module depending on the domain
> crate is the correct direction.**

`comm/adapter.rs` and `comm/adapters/internal.rs` legitimately import the crate. A symmetric
"no cross-crate edges" pin would redden on that **correct** code — worse than no guard,
because the first person to hit it deletes it. Instrument (i) therefore **asserts the
platform→crate edge EXISTS** and forbids only the reverse. Rows 3 and 5 are the two
directions of that claim, both observed.

---

## The six-row table — every row OBSERVED

### Row 1 — Baseline: the correct tree is GREEN

| | |
|---|---|
| Command | `verify-domain-boundary.ps1 -Root apps/tauri/src-tauri -Locked` |
| Output | `CRATE GRAPH POPULATION: 41 resolved node(s)` · `CRATE GRAPH HITS: 0` · `MANIFEST path ENTRIES: 0` · `PLATFORM GRAPH POPULATION: 1890 resolved node(s)` · `ASYMMETRY: 'telemetry-domain' IS resolved in the 'fredo' graph` · `VIOLATIONS: 0` · `RESULT: PASS` |
| Exit | **`EXITCODE=0`** |

### Row 2 — Add a direct `tauri = "2"` to the crate: RED, naming `tauri`

| | |
|---|---|
| Mutation | `tauri = "2"` appended to `crates/telemetry-domain/Cargo.toml` `[dependencies]` |
| Command | `verify-domain-boundary.ps1 -Root apps/tauri/src-tauri` (no `-Locked`: the mutation cannot resolve under a stale lock) |
| Output | `CRATE GRAPH POPULATION: 648 resolved node(s)` · `HIT: tauri` · `HIT: tauri-build` · `HIT: tauri-runtime` · `HIT: tauri-runtime-wry` · `VIOLATIONS: 4` · `RESULT: VIOLATED` |
| Exit | **`EXITCODE=1`** |
| Restore | line removed; `-Locked` re-run → `HITS: 0`, `RESULT: PASS`, `EXITCODE=0`; `git status` shows only this capsule's two new files |

**R-1a and R-1b are the observed pair:** added → red naming the package; removed → green.

### Row 3 — Remove the platform→crate edge: RED (the §7 asymmetry assertion fires)

| | |
|---|---|
| Mutation | `telemetry-domain = { path = "crates/telemetry-domain" }` deleted from `apps/tauri/src-tauri/Cargo.toml` `[dependencies]` |
| Command | `verify-domain-boundary.ps1 -Root apps/tauri/src-tauri` |
| Output | `CRATE GRAPH HITS: 0` (the crate is still clean) · `PLATFORM GRAPH POPULATION: 1882 resolved node(s)` · `VIOLATIONS: 1` · `- ASYMMETRY BROKEN: 'telemetry-domain' is NOT resolved in the 'fredo' graph - the platform no longer depends on the domain crate, so the boundary is not being exercised at all (section 7 expects this edge to EXIST)` · `RESULT: VIOLATED` |
| Exit | **`EXITCODE=1`** |
| Restore | `git checkout -- apps/tauri/src-tauri/Cargo.toml …/Cargo.lock`; re-run → `ASYMMETRY: … IS resolved`, `VIOLATIONS: 0`, `EXITCODE=0`; `git status` clean apart from this capsule's files |

This is the row that proves the guard is **not** the symmetric pin §7 forbids: the forbidden
direction reddens (row 2), and the **absence of the correct** direction ALSO reddens (row 3) —
because a boundary nobody crosses is not being exercised.

### Row 4 — A transitive `path` dep re-exposes the platform: RED, and a manifest grep would MISS it

**This is the row that justifies choosing the resolved graph over a manifest grep.**

| | |
|---|---|
| Mutation | new throwaway crate `crates/__probe/` (`tauri = "2"` in its manifest), and `__probe = { path = "../__probe" }` added to the domain crate's `[dependencies]`; `__probe` itself is **inside `crates/`**, so clause 2 (the path leg) stays quiet and clause 1 alone must catch it |
| The grep-invisible property | a manifest dependency-line search over the crate's `Cargo.toml` for `^\s*(tauri\|tauri-build\|tauri-runtime)\s*=` → **No matches found**. The words `tauri` appear ONLY in pre-existing comments (`:6`, `:11`), never as a dependency |
| Command | `verify-domain-boundary.ps1 -Root apps/tauri/src-tauri` |
| Output | `CRATE GRAPH POPULATION: 649 resolved node(s)` · `HIT: tauri` · `HIT: tauri-build` · `HIT: tauri-runtime` · `HIT: tauri-runtime-wry` · `MANIFEST path ENTRIES: 1` / `inside crates/: __probe = { path = "../__probe" }` · `VIOLATIONS: 4` · `RESULT: VIOLATED` |
| Exit | **`EXITCODE=1`** |
| Restore | dependency line removed; `crates/__probe/` removed |

**A manifest-grep implementation exits 0 on this tree.** The resolved graph reddens and names
the transitively reached packages. This is R-1c, observed.

**Instrument (ii) on this same tree also stays silent** — the probe's `tauri` edge lives in
`crates/__probe/Cargo.toml`, outside the scan root (the domain crate), and the domain crate's
own text names no platform symbol. That is the **text instrument's stated limit, executed**:
row 4 is exactly the case `guard-universe.ps1` cannot see, and instrument (i) catches it. It
is why the two are bound together and why neither alone satisfies AC1.

### Row 5 — The false guard (a symmetric pin) REDDENS on CORRECT code

| | |
|---|---|
| Mutation | a probe clause added to `verify-domain-boundary.ps1` that forbids the platform→crate edge (a "no cross-crate edges" pin) |
| Command | `verify-domain-boundary.ps1 -Root apps/tauri/src-tauri -Locked` — on the **correct, unmodified** tree |
| Output | `CRATE GRAPH HITS: 0` (the crate is clean) · `ASYMMETRY: 'telemetry-domain' IS resolved…` · `VIOLATIONS: 1` · `- FALSE GUARD PROBE: the symmetric no-cross-crate-edge pin is VIOLATED on correct code` · `RESULT: VIOLATED` |
| Exit | **`EXITCODE=1`** |
| Restore | probe clause deleted; re-run → `VIOLATIONS: 0`, `EXITCODE=0` |

The pin reddens while every real boundary property **holds**. That is why the shipped guard
asserts the edge present instead — row 3 is its complement (it reddens when the edge is
*absent*), so the pair pins the asymmetry in both directions without forbidding correct code.

### Row 6 — Instrument (ii): a source leak in the crate REDDENS the token scan

| | |
|---|---|
| Mutation | `// use crate::infrastructure::rtdb::commands::Rtdb;` added to `crates/telemetry-domain/src/lib.rs` (a doc comment — the scan is textual, so a mention counts) |
| Command | `guard-universe.ps1 -Root apps/tauri/src-tauri/crates/telemetry-domain -Tokens .opencode/tests/telemetry-domain-crate/boundary-tokens.txt` |
| Output | `SCANNED: 19` · `EXCLUDED: 0` · `HITS: 1` |
| Exit | **`EXITCODE=1`** |
| Restore | comment removed; re-run → `HITS: 0`, exit 0 |

---

## Instrument (i) on the clean tree — the raw resolved graph

`cargo tree -p telemetry-domain --locked --edges normal,build` (workspace root
`apps/tauri/src-tauri`), full output:

```
telemetry-domain v0.1.0 (C:\Code\fredo\.worktrees\3201\apps\tauri\src-tauri\crates\telemetry-domain)
├── anyhow v1.0.104
├── async-trait v0.1.91 (proc-macro)
│   ├── proc-macro2 v1.0.106
│   │   └── unicode-ident v1.0.24
│   ├── quote v1.0.45
│   │   └── proc-macro2 v1.0.106 (*)
│   └── syn v3.0.6
│       ├── proc-macro2 v1.0.106 (*)
│       ├── quote v1.0.45 (*)
│       └── unicode-ident v1.0.24
├── chrono v0.4.44
│   ├── num-traits v0.2.19
│   │   [build-dependencies]
│   │   └── autocfg v1.5.0
│   ├── serde v1.0.228
│   │   ├── serde_core v1.0.228
│   │   └── serde_derive v1.0.228 (proc-macro)
│   │       ├── proc-macro2 v1.0.106 (*)
│   │       ├── quote v1.0.45 (*)
│   │       └── syn v2.0.117
│   │           ├── proc-macro2 v1.0.106 (*)
│   │           ├── quote v1.0.45 (*)
│   │           └── unicode-ident v1.0.24
│   └── windows-link v0.2.1
├── serde v1.0.228 (*)
├── serde_json v1.0.149
│   ├── itoa v1.0.18
│   ├── memchr v2.8.0
│   ├── serde_core v1.0.228
│   └── zmij v1.0.21
├── tracing v0.1.44
│   ├── pin-project-lite v0.2.17
│   ├── tracing-attributes v0.1.31 (proc-macro)
│   │   ├── proc-macro2 v1.0.106 (*)
│   │   ├── quote v1.0.45 (*)
│   │   └── syn v2.0.117 (*)
│   └── tracing-core v0.1.36
│       └── once_cell v1.21.4
└── uuid v1.23.1
    └── getrandom v0.4.2
        └── cfg-if v1.0.4
```

**No node named `tauri`, `tauri-build`, `tauri-runtime`, `tauri-runtime-wry`,
`tauri-plugin-shell`, `tauri-plugin-mcp-bridge`, `fredo`, `fredo_lib` or `applications`.**
Every node is a general-purpose library.

**The asymmetry assertion, from the same run:** `cargo tree -p fredo --depth 1` contains
`telemetry-domain v0.1.0 (…\crates\telemetry-domain)`, and the guard prints
`ASYMMETRY: 'telemetry-domain' IS resolved in the 'fredo' graph - the expected
platform->crate edge holds (section 7)`.

## Instrument (ii) on the clean tree — `HITS 0`, non-vacuous, equality real

```
powershell -NoProfile -File .opencode/scripts/guard-universe.ps1 `
  -Root apps/tauri/src-tauri/crates/telemetry-domain `
  -Tokens .opencode/tests/telemetry-domain-crate/boundary-tokens.txt `
  -PristineRoot <a second, independently-created checkout of the same crate>
```

```
SCANNED: 19
EXCLUDED: 0 (dirs: .git, node_modules, target, dist, .next)
HITS: 0
PRISTINE SCANNED: 19  HITS: 0
EQUALITY: MATCH
```

- **`SCANNED: 19`** — the EXACT count, and non-zero. **A zero-file scan is a vacuous pass and
  would be reported as INSTRUMENT FAILURE, never a PASS (G-524).**
- **`HITS: 0`** — no token from `boundary-tokens.txt` appears in the crate.
- **`EQUALITY: MATCH`** — and it is a **real** measurement, not a tautology. The
  discriminating control: a token was seeded into the **pristine** tree only, and the receipt
  flipped to `PRISTINE SCANNED: 19  HITS: 1` / **`EQUALITY: MISMATCH`** (exit **1**). It was
  then reverted and the run returned to `MATCH`. An equality receipt that cannot print
  `MISMATCH` proves nothing; this one did.

The `-PristineRoot` tree was materialised with `git worktree add --detach` (an independent
checkout), **not** by pointing at the same directory — a same-directory equality is a
trivially-true comparison.

## The token file, and why each token is what it is

`.opencode/tests/telemetry-domain-crate/boundary-tokens.txt` (fixed path; the QA row F-7
consumes it and `tests-commit` persists the whole directory):

```
tauri::
tauri_
fredo_lib::
SettingsStore
crate::infrastructure
crate::applications
Rtdb::
&Rtdb
: Rtdb
Arc<Rtdb>
```

**Every token is a form that can only appear if the platform leaked into the crate** — a
compilable path (`tauri::`, `crate::infrastructure`), a type position (`: Rtdb`, `Arc<Rtdb>`,
`&Rtdb`, `Rtdb::`), or a name the crate has no business mentioning (`SettingsStore`,
`fredo_lib::`).

**Why the bare `Rtdb` token was NOT used, measured not guessed.** A scan with the single token
`Rtdb` reports **`HITS: 6`** on the CLEAN tree — every hit a doc comment that correctly says
the crate never names `Rtdb`:

```
src/lib.rs:59                     /// Implemented by the platform's `Rtdb` composition root
src/lib.rs:60                     /// (`rtdb/commands.rs::impl RowSink for Rtdb`); the crate never names `Rtdb`.
src/classifier/agent.rs:7         //! [`RowSink`](crate::RowSink) instead of `IngestRow` / `Rtdb`).
src/classifier/relationship.rs:8  //! [`RowSink`](crate::RowSink) instead of `IngestRow` / `Rtdb`).
src/classifier/session.rs:7       //! (`RowUpsert` / [`RowSink`] instead of `IngestRow` / `Rtdb`).
src/classifier/turn.rs:7          //! (`RowUpsert` / [`RowSink`] instead of `IngestRow` / `Rtdb`).
```

A bare `fredo_lib` likewise hits the crate manifest's own comment (`:6`). A guard that reddens
on correct code gets deleted, so the token set uses the **type-position** forms of `Rtdb`, which
hit zero on the clean tree while still catching every real leak (`use … Rtdb;`, a field type, an
`Arc<Rtdb>`, a receiver). **This narrows the token, never the predicate**: a leaked `Rtdb::` or
a declared `: Rtdb` is exactly what a platform leak looks like, and all four forms are pinned.
The trade is disclosed: a leak that references `Rtdb` in some other position (e.g. a bare
`Rtdb` in a generic bound) would rely on instrument (i) instead — which is why the two are
bound together and why neither alone satisfies AC1.

## Instrument (i)'s own controls — `-SelfTest`, 8 controls, observed

```
CONTROL 1 (clean graph: population 6, zero forbidden) PASS
CONTROL 2 (added tauri edge) PASS - reddens naming 'tauri'
CONTROL 3 (path dep on the application crate) PASS - reddens naming 'fredo'
CONTROL 4 (transitive path dep re-exposes tauri) PASS - reddens naming the reached 'tauri'
CONTROL 5 (zero population is an instrument failure) PASS - population 0 is reported, not passed
CONTROL 6 (lookalike name is not a hit) PASS - exact node-name comparison
CONTROL 7 (asymmetry: platform->crate is asserted, never forbidden) PASS
CONTROL 8 (manifest path legs: comment ignored, real escape parsed) PASS
RESULT: CLEAN (8 controls)
EXITCODE=0
```

Controls 5 and 6 are the two anti-false-green guards: a **zero-population** scan is reported
as an instrument failure rather than a clean bill (G-524), and **exact node-name** comparison
keeps a lookalike name (`tauri-utils-lookalike`) from being a hit — the documented disposition
for a resolved artifact whose name merely contains a forbidden token.

## One defect found and fixed by this capsule's own receipt (G-315)

While running row 2 with `-Locked` restored, the script died with a **generic** termination
instead of its documented typed refusal:

```
cargo.exe : error: cannot update the lock file … because --locked was passed to prevent this
    + FullyQualifiedErrorId : NativeCommandError
EXITCODE=1
```

Under `$ErrorActionPreference = 'Stop'`, PowerShell 5.1 promotes a redirected native command's
stderr to a **terminating** error, so `$LASTEXITCODE` was never read and the documented
`exit 2` ("error: the graph could not be resolved") was **unreachable** — exactly the
unreachable-refusal class G-315 names. Fixed by scoping the stop preference around the native
call and reading `$LASTEXITCODE` explicitly. **Verified reachable afterwards:** row 2's
`fredo = { path = "../.." }` mutation now produces the typed path —

```
CARGO TREE FAILED:
  error: cyclic package dependency: package `fredo v0.2.5 …` depends on itself. … which
  satisfies path dependency `telemetry-domain` … of package `fredo v0.2.5 …`
RESULT: ERROR (the graph could not be resolved)
EXITCODE=2
```

— a named cause and the documented exit code, from the real entry path.

## What this receipt does NOT prove

- **Instrument (i)** proves the resolved graph, not source references that never become an
  edge — `#[cfg(test)]` code is its blind spot; instrument (ii) covers it.
- **Instrument (ii)** proves the crate's text, not a transitively-resolved `path` dependency —
  row 4 is the executed proof it is blind there; instrument (i) covers it.
- Neither instrument proves the **platform-side direction** is correct beyond the assertion
  that the edge exists; §7's correctness argument rests on the imports themselves
  (`comm/adapter.rs`, `comm/adapters/internal.rs`), which are ST-7's landed work.
- Nothing here is a CI receipt. The workflow step is a **handover**
  (`.opencode/tmp/3201/validate-yml-patch.md`) — accepted and reviewed by a human, not applied
  by this capsule.

*Authored by Developer*
