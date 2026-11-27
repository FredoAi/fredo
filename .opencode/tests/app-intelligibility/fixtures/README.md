# app-intelligibility — fixtures & generator (Spec #3244)

> One **deterministic, Node-built-ins-only** generator produces every package and ladder rung this
> suite's live rows consume. It is deliberately a single file so it can be run, re-run and reviewed
> on its own.
>
> **Nothing here ships.** This directory and the packages it emits are test scaffolding. No product
> code under `apps/ui` or `apps/tauri` imports, reads or depends on anything here.

| Artifact | Purpose |
|---|---|
| `fixtures/build-intelligibility-fixtures.mjs` | the generator — three fixture families (below) |
| `fixtures/README.md` | this document — conventions, invocation, determinism |
| `fixtures/BEACON-INGRESS-CONTROLS.md` | the ING-1 negative-control plan (ids, typed reasons, the one unreachable control) |
| `scripts/scoped-source-sweep.mjs` | the committed AC-5 part (ii) / AC-2b source sweep (§7) |

The document shape follows `.opencode/tests/installable-apps/README.md` (read it once as the model);
the package format it consumes is fixed there, §2.

---

## 1. What the generator emits, and which row each family serves

| Family | ids | Serves |
|---|---|---|
| the **untaught** package | `qa3244-untaught` | **AC-2 / AC-3** (`functional.md` F-3, F-5) and **AC-2b** (F-4) |
| the **beacon control** package | `qa3244-beacon-control` | **ING-1** (the plan's beacon row); control plan in `BEACON-INGRESS-CONTROLS.md` |
| the **density ladder** | `qa3244-dense-08`, `-32`, `-72`, `-120`, `-160`, `-url11k` | **AC-4** (F-6) — the progressive dense-screen measurement |

### `qa3244-untaught` — AC-2 / AC-3 / AC-2b

An installable package that **declares a `description`** and renders a **mutable screen**, so both
halves of the claim are drivable:

- the declared description is rendered verbatim at `[data-qa3244-description]`, so the turn's
  receipt can be checked against a string the tester can read;
- the screen **changes**, so the freshness leg (AC-3: two turns separated by a visible change
  carry distinct digests) has something to change. Two levers, both the app's own:
  - **a native click / keyboard activation of `[data-qa3244-mutate]`** — a real user action on a
    real button; and
  - `[data-qa3244-live]`, a line that advances every 1000 ms, so a change is guaranteed between
    any two turns even with no input.

The changed step token (`QA3244-SCREEN step=<n> token=step-<n>-<hex>`) and the live stamp are
plain text inside the projected root, so the change is visible in the turn's **simplified-HTML
leg** — that is AC-3's witness. The token is a deterministic function of the step (no clock, no
randomness), so the first screen is reproducible and each advance is an assertable string.

**The id must appear NOWHERE under `apps/**`.** That absence *is* AC-2b's proof, and the committed
sweep artifact checks it (`.opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs`,
subject `qa3244-untaught`). Two shipped unit tests legitimately name the id as a fixture value —
`screenOutline.test.ts` and `companionDispatch.test.ts` — and the sweep reports those as `test`
hits, not as product special cases; see §5.

### `qa3244-beacon-control` — ING-1

Plays the **untrusted child**: it issues deliberately malformed screen-outline beacons at the host's
own scheme handler and mirrors every attempt as visible text. Three controls fire on mount
(oversize, missing nonce, unknown nonce); two are armed from the app's own visible buttons and need
one companion turn (timeout, replay-after-TTL).

**The observable is the host's typed ingress reason** — one `installed.beacon.ingress` span per
attempt in `telemetry_spans`. A beacon that merely does not crash is **not** a PASS. Full control
table, expected reasons, and the ONE control the fixture cannot produce (a genuinely expired nonce)
are in [`BEACON-INGRESS-CONTROLS.md`](BEACON-INGRESS-CONTROLS.md).

### `qa3244-dense-*` — AC-4

A **monotone ladder** of named-control counts (and accessible-name lengths), so a live run can find
the density at which the injected pair stops fitting, and record the number.

| rung | named controls | name chars | chrome | projected outline nodes | `truncated` |
|---|---|---|---|---|---|
| `qa3244-dense-08` | 8 | 24 | 2 | 10 | false |
| `qa3244-dense-32` | 32 | 32 | 2 | 34 | false |
| `qa3244-dense-72` | 72 | 40 | 2 | 74 | false |
| `qa3244-dense-120` | 120 | 40 | 2 | **120** | **true** |
| `qa3244-dense-160` | 160 | 40 | 2 | **120** | **true** |
| `qa3244-dense-url11k` | 120 | 36 | 2 | **120** | **true** |

`chrome` is the panel's own named elements (the `h1` + the header line), so the outline carries
`named controls + chrome`. The caps are `SCREEN_OUTLINE_MAX_NODES = 120` and
`SCREEN_OUTLINE_MAX_BYTES = 8192` in `apps/ui/src/shared/app-intelligibility/screenOutline.ts`.

> **The rung declares DENSITY only. The BYTES are the run's reading** (G-511). `qa3244-dense-url11k`
> is *shaped* to hand GATE-0 a ~11 KB payload (under the 16 KB beacon bound, so it must be
> ACCEPTED) — but no number in this file or the generator is a measurement. The recorded bytes /
> nodes / image tokens come from the run's `companion.injection` span, written into
> `measurement/ac4-screen-read-record.json` by `measurement/build-ac4-record.mjs`.

Each rung's header carries `distinctNames=<n>` — the fixture's own self-check that the
accessible-name generator really produced N distinct names (a collapse would make the rung
unreadable and is caught at build time; see §4).

---

## 2. Running the generator

From the repo root (`node` and `bun` are interchangeable here — the file is plain ESM):

```powershell
# build everything into the default output dir
node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs

# print the catalog (packages + the AC-4 ladder + the beacon controls) and exit
node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs --list

# print ONLY the summary table (id / kind / zip / bytes / sha256)
node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs --quiet

# build into a second directory, for the determinism comparison
node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs --out .opencode/tmp/3244/fixtures/intelligibility-b

node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs --help
```

| Flag | Effect |
|---|---|
| `--out <dir>` | output directory (default `.opencode/tmp/3244/fixtures/intelligibility`) |
| `--list` | print the catalog and exit; writes nothing |
| `--quiet` | print only the summary table |
| `--help` | usage text |

The generator uses **only** `node:crypto`, `node:fs`, `node:path` and `node:url`. No network, no npm
package, no toolchain, no shell-out. It runs on a bare checkout with nothing installed.

---

## 3. Output goes to a gitignored directory — never commit the archives

Default output: `.opencode/tmp/3244/fixtures/intelligibility/`. `.opencode/tmp/` is gitignored
(`.gitignore:225`), so the archives **cannot** be committed and are not meant to be: they are
reproducible byte-for-byte, so a committed copy would only be a second source of truth that can
drift from the generator.

Each build also writes `INTELLIGIBILITY-FIXTURES.json` next to the archives — a per-run summary
(ids, bytes, sha256, the AC-4 ladder, the beacon controls, the contract constants). **It is not an
expected-output manifest**: it is regenerated on every run and is self-describing only.

---

## 4. Determinism, and how it is proven

Running the generator twice produces **byte-identical** archives. The mechanism:

- zip entries are emitted in a **fixed order** (`fredo-app.json`, `index.html`, `main.js`);
- every entry carries the **fixed DOS timestamp 1980-01-01 00:00:00** (`dosTime 0x0000`,
  `dosDate 0x0021`), i.e. no wall-clock time;
- entries are **stored** (method 0, no deflate stream), so the payload bytes are a pure function of
  the input;
- nothing is generated from the clock or from randomness **at build time**. The per-run values a
  fixture needs (a live stamp, a mount id) are produced **inside the child document at mount time**,
  never here.

**How it is proven (and why there is no committed hash manifest):**

```powershell
node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs --quiet --out .opencode/tmp/3244/fixtures/a
node .opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs --quiet --out .opencode/tmp/3244/fixtures/b
# compare the two printed sha256 columns -- identical columns IS the determinism receipt
```

There is deliberately **no committed expected-output manifest** with hashes. The QA Expert holds no
shell (G-460), so it cannot derive hashes to commit, and a committed hash nobody re-derives is
decoration. **The comparison of two runs is the receipt.** Do not paste a hash into a row as an
"expected" value: the hashes change whenever a fixture body legitimately changes, and a stale
committed hash reads as a defect.

### Self-checks the generator runs on EVERY build (not opt-in)

Before writing anything it validates every manifest against the package rules (`manifestVersion
=== 1`, the `id` regex and 96-char cap, `displayName` 1–64, SemVer 2.0.0 with no `v` prefix, a
non-empty `engines.fredo` range, `entry` exactly `index.html` + `main.js`, and a **non-empty**
`description` of at most 280 chars — every fixture here exists to declare one).

After building each archive it re-opens it and asserts:

- the EOCD count, central-directory size and offset are consistent;
- every central-directory entry's name/size/CRC agrees with what was written (stored, method 0);
- the `fredo-app.json` inside the archive round-trips to the object it meant to write;
- `index.html` exists, is non-empty, is an HTML document, and duplicates **no** host-owned hook
  (`installed-app-loading`, `installed-app-failure`, `installed-app-failure-reason`,
  `installed-app-retry`) — a fixture that rendered its own copy would make the host's own
  failure/loading rows unreadable;
- `main.js` exports `mount`, carries its own fixture id, and has **no unsubstituted template
  placeholder** left in it;
- per family: the untaught hooks / the mutable-screen and live-line generators, the beacon path and
  **every** control id plus the reporter wrapper, and for each dense rung that it renders from its
  declared node count, carries accessible names, does not exceed the projector's 120-char name clip,
  and produces **exactly as many distinct names as controls** (see below).

Any failure aborts the build with a non-zero exit code. These run on the default path, not behind a
flag, because a generator whose gate has never run is not evidence.

> **Three defects were found in the parked generator and fixed surgically** (it was never rewritten):
>
> 1. **The dense names collapsed.** `labelFor` appended `'control <i>'` last and then sliced to
>    `nameChars`, so at `nameChars = 24` (rung `-08`) the slice cut the index off entirely and all
>    eight controls rendered the **same** accessible name — a rung that cannot discriminate which
>    projected outline entry came from which control. The index is now placed **first**, the header
>    carries `distinctNames=<n>` as a rendered self-check, and the build rejects any rung whose names
>    are not all distinct.
> 2. **`--quiet` was parsed and then ignored.** Both the header comment and `--help` promised "print
>    only the summary table", but `main()` never read the flag, so `--quiet` printed the full report.
>    It now emits exactly the summary table.
> 3. **The replay control advertised an unreachable expected value.** `D-REPLAY-AFTER-TTL` carried
>    `expect: 'expired | unknown-nonce'` and a mirrored line reading
>    `expect=expired-else-unknown-nonce`. The shipped code cannot make `expired` reachable from a
>    child (TTL == correlation timeout; the nonce is closed when the wait is served or abandoned), so
>    an `|`-alternation invited a run to accept either and proved nothing. It is now the ONE reachable
>    value, `unknown-nonce`; an `expired` reading is a finding, not a tolerated outcome.

---

## 5. The child-evidence transport fact — read this before planning any drive

**Every `installed-*` window is unreachable by `tauri_webview_*`.** `execute_js`, `dom_snapshot`,
`find_element`, `screenshot` and `console` all return **`Request timeout after 2000ms`** against an
`installed-<id>` windowId: `execute_js` *lands* (`window.eval` runs) but its result channel is
ACL-denied inside the child, which has neither `window.__TAURI__` (`withGlobalTauri: false`) nor a
grant for the bridge command that returns the result. That is not a bug to work around — it is the
installed tier's isolation property (#3147), reaffirmed here.

A fixture that waits to be driven therefore cannot be driven at all. So **each package drives
itself on mount** and **mirrors its results as rendered text**, and the tester reads that text with
a capability-independent instrument:

1. a **native accessibility (UIA) text read** of the installed window's own tree, and
2. a **native window capture**, uploaded with `upload-evidence` as a `user-attachments` URL.

The mutation and arming levers are the apps' **own visible affordances** (a native click on a
rendered `<button>`), never `execute_js`. For the turn-coupled beacon controls the authoritative
receipt is still the **host's own** `telemetry_spans` row, not the child's rendering.

**Never `tauri_webview_*` against an `installed-*` windowId.** Two limits the verdict must record:

1. a native/UIA read is **not** a live-evidence token for the pipeline's `testing → audit` matcher
   (`telemetry_spans` / `user-attachments` / `tauri_webview_*` / `getBoundingClientRect`), so the
   round must also carry one genuine `telemetry_spans` receipt (which every row here names) — the
   native capture is corroboration, never the primary;
2. a **host-side read/inject path** into an `installed-*` document is a **Toolsmith** item, not a
   fixture or a row. No row in this suite may be answered by an improvised one-off script.

### The mirror grammar (stable — rows cite these strings)

`qa3244-untaught`:

| Node | Text |
|---|---|
| `[data-qa3244-header]` | `QA3244-FIXTURE app=<id> version=<v> descriptionBytes=<n>` |
| `[data-qa3244-description]` | the declared description, **verbatim** |
| `[data-qa3244-screen]` | `QA3244-SCREEN step=<n> token=step-<n>-<hex>` |
| `[data-qa3244-live]` | `QA3244-LIVE t=<epoch-ms>` — advances every 1000 ms |
| `[data-qa3244-step]` | `QA3244-STEP <n>` (also mirrored on the root as `data-qa3244-step`) |
| `[data-qa3244-mutate]` | the button that advances the screen |
| `[data-qa3244-screen-log]` | one line per mutation, so **both** states stay readable at once |

`qa3244-beacon-control`: see `BEACON-INGRESS-CONTROLS.md` §3.

`qa3244-dense-*`:

| Node | Text |
|---|---|
| `[data-qa3244-dense-header]` | `QA3244-DENSE app=<id> controls=<n> nameChars=<n> distinctNames=<n> version=<v>` |
| `button[data-qa3244-dense-node="<i>"]` | the control, `aria-label` = its accessible name |

---

## 6. What is committed vs generated

| Path | Committed? | Notes |
|---|---|---|
| `fixtures/build-intelligibility-fixtures.mjs` | **yes** | the generator |
| `fixtures/README.md` | **yes** | this document |
| `fixtures/BEACON-INGRESS-CONTROLS.md` | **yes** | the ING-1 control plan |
| `scripts/scoped-source-sweep.mjs` | **yes** | the AC-5 part (ii) / AC-2b sweep artifact (§7) |
| `.opencode/tmp/3244/fixtures/**` | no (gitignored) | the generated archives + per-run summary |

---

## 7. The committed sweep artifact (`scripts/scoped-source-sweep.mjs`)

The AC-5 row's part (ii) and the AC-2b row both rest on one committed artifact. It is a `.mjs`, not
a `.ps1`, because the tester's sandbox allows `bun*` but **not** `powershell -File
.opencode/tests/**` — a PowerShell script here would be unrunnable for its consumer.

```powershell
bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs
bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs --self-check
bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs --strict
bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs --help
```

It sweeps **only** the description+pair path (the module list is declared and printed in its own
header and in `--help`), for the subjects `mission-monitor` (AC-5) and `qa3244-untaught` (AC-2b),
and prints `SWEEP RESULT: PASS|FAIL subjects=<n> modules=<n> hits=<n>` as the quotable last line.
Exit 0 only when no subject-id **code** hit remains; 1 on a graded hit; 2 on a usage/IO error (a
**missing scope path is an error, never a clean sweep**).

**One path module is deliberately out of scope:** `CompanionEntity.tsx` is the dispatch *site* (it
derives the turn facts at `:287` and passes the `injection` argument), but the plan's declared sweep
list does not name it. It was read by hand while authoring the artifact and contains zero subject-id
occurrences — recorded in the script header as an **observation, not a sweep result**. Widening the
scope is a plan amendment (add it to `SCOPE`), never an ad-hoc grep.

**The claim is scoped to the description+pair path, and that is not a loophole.** `mission-monitor`
legitimately carries a hand-written per-app **grounding registrar**
(`MissionMonitorPanel.tsx:881`) — selection metadata, **not** enablement. An unscoped repo-wide grep
would red on that legitimate file and prove nothing about the path under test. The sweep's scope is
declared in the file, with the reason. **Never widen it to make a run green.**

### Hit classes — and why the graded predicate is `product`

The plan's R-5b forbids a subject-id **special case** ("a `mission-monitor` branch/branch table in
the resolver, the projector, the capture seam, the transport"). A branch has to be *code*. The
sweep therefore classifies every hit and grades only one:

| class | where | graded? |
|---|---|---|
| `product` | the id in **code** (a literal compared/described/table-entried) | **YES — FAILS the run** |
| `comment` | the id inside a line or block **comment** | no — printed |
| `test` | the id in a `__tests__/` / `*.test.ts(x)` file, or inside a Rust `#[cfg(test)] mod` | no — printed |

**Nothing is concealed:** every hit in all three classes is printed with `file:line: text`, and the
`SWEEP RESULT` line is followed by a `not-graded <class> <file>:<line>` line for each mention the run
did not grade, so a reader sees exactly what the predicate excused.

> **Why this split is required, not a convenience.** The shipped tree legitimately names both
> subjects *inside this scope*: `shared/app-intelligibility/injection.ts:25` documents the MM
> confound in a doc comment — which the plan **requires** to be named — and the unit tests
> (`shared/app-intelligibility/__tests__/`, `injection.rs`, `beacon.rs` `#[cfg(test)] mod tests`)
> use `mission-monitor` / `qa3244-untaught` as fixture values. A literal any-mention rule is
> therefore **unsatisfiable on a correct tree**, and a criterion a correct product cannot satisfy is
> not a criterion. `--strict` keeps that literal reading available as a **diagnostic** (it is
> expected to red) and proves the matcher can see all three classes.
>
> **Actionable note for the Orchestrator (out of this suite's grant):** if the plan's "zero hits" is
> to be honoured literally, the one product-side mention that must change is the doc comment at
> `injection.ts:25` — it can name the confound without spelling the id ("a built-in app registers a
> per-app grounding registrar"). Rewriting product code is not a QA-expert edit; the sweep reports
> the fact either way.

`--self-check` proves the matcher is non-vacuous without depending on the tree staying clean: it
writes a fixture tree under the OS temp dir, asserts a planted product-code special case **is**
reported, a comment-only mention and a test-file mention are **not**, a `#[cfg(test)]`-enclosed Rust
mention is **not** while a mention **after** that module **is** and a mention after a
`#[cfg(test)]`-decorated **fn** **is** (the attribute also decorates non-module items), an absent id
is not reported, the verdict **fails** on the planted hit, and `--strict` counts strictly more than
the default — then cleans up and prints its own PASS line.

**Its stated limit:** this is a **literal** sweep. A PASS proves no in-scope module *spells* the
subject id in code; it cannot decide an id assembled at runtime (`'mission' + '-monitor'`). The
row's runtime half — `taught:false` / `perAppEntries:0` on the turn's own injection span — is the
other leg, and the criterion is satisfied only with **both**.

---

## 8. What these fixtures are NOT here to prove

Runtime ownership of the pair, the capsule contract, and the caps themselves belong to the product
suites (`.opencode/tests/companion-vision/`, `companion-embedded-engine/`) and the product's own unit
pins. These generators only produce the **data** the #3244 rows drive. They add no product import,
no per-app knowledge, and no host-owned DOM hook.
