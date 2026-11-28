# telemetry-domain-crate — Functional

Durable functional suite for the **Agent Telemetry domain crate** boundary: the classifier, the
extract rules (`attrs`), the row model (`rows`), the merge tables (`merge`) and the wire vocabulary
(`event`) live in `crates/telemetry-domain`, a compilation unit that **cannot reach the Tauri
platform** — with the derivation proved identical across the extraction boundary.

Seeded at issue **#3201**. Inherits on overlapping surfaces:
`.opencode/tests/rtdb-provider-attribution/` (R-1, R-3, R-5 — merge totality, one shared extract
rule, the classifier's other canonical projections), `.opencode/tests/realtime-data/` (R-1, R-2 —
row pipeline + merge semantics), `.opencode/tests/otlp-genai/` (R-2, R-13, R-18 — extraction
priorities, `EventState` alignment), `.opencode/tests/copilot-capture/` (R-2/F-4 — the turn-split
merge contract this suite's F-6 reuses), `.opencode/tests/mission-monitor/` (the consumer).

> **Verification policy: LIVE.** AC3 is a genuine runtime behaviour (a `telemetry_spans` row and the
> chat row delivered to a running webview) and cannot be satisfied statically. The static absence
> proofs (F-1…F-12, F-14…F-16) are receipts for **their own** ACs; they are never a substitute for
> F-13's live leg, and a `## Tests Runs` verdict with a static-only PASS for F-13 is a FALSE PASS
> rejected by the testing exit gate.
>
> **The two routed Product Owner items do NOT gate any row here.** (i) AC2's named `realCorpus.ts`
> cannot reach the classifier — F-4/F-5 compare **pre-change vs post-change on a classifier-input
> corpus**, so whichever corpus the PO confirms, only the corpus SOURCE changes, never the
> comparator. (ii) The read-inclusive port (F-6) is coverage **added** to AC6's proof, not an edit of
> it — if the PO declines the read surface, F-6's (a)/(b) fail while AC6's own observable is still
> proven by F-7.

> **Executor split.** A developer holds every build/graph/timing/DB-read instrument (F-1…F-12,
> F-14…F-16, N-1…N-4). Only the tester holds the live app + webview (F-13). No row claims
> QA-self-execution.
>
> **Persisted by the tester in round 1 (G-521).** `planning → implementation` did not persist this
> folder (it did not exist), so the round-1 tester authored the durable suite and ran
> `tests-commit`. The parked draft at `.opencode/tmp/3201/suite/` is superseded by this folder.

---

## Required test data

- **Crate manifest under test:** `apps/tauri/src-tauri/crates/telemetry-domain/Cargo.toml`
  (`[package] name = "telemetry-domain"`, `[lib] name = "telemetry_domain"`).
- **Workspace root:** `apps/tauri/src-tauri` (`[workspace] members = [".", "crates/telemetry-domain"]`).
- **Classifier-input corpus (the AC2 input):**
  `apps/tauri/src-tauri/src/infrastructure/rtdb/fixtures/copilot_cli/{content-on,content-off,session-only,tool-failure,turn-split}.json`
  — 5 committed OTLP/JSON envelopes, `Resource.service.name = "copilot-cli"`, fed through
  `IngestClassifier::ingest_otlp(Transport::OtlpHttp, raw)` exactly as
  `apps/tauri/src-tauri/tests/copilot_capture_pg.rs:149-155` does. **The suite must copy them into
  `crates/telemetry-domain/tests/corpus/`** (the crate cannot read the platform's tree).
- **Equivalence fixture (produced by a run, never hand-written — G-511):**
  `crates/telemetry-domain/tests/fixtures/row_upserts_before.json` — the emitted
  `Vec<(RowUpsert, changed_fields)>` captured from the **pre-extraction** tree at the merge-base
  commit, committed as the comparison baseline.
- **AC1 instruments:** `.opencode/scripts/verify-domain-boundary.ps1` (the resolved-**graph** check,
  ST-8) and `.opencode/scripts/guard-universe.ps1` (the committed **text**-scan, reused as-is — never
  forked). Token file: `boundary-tokens.txt` in this folder.
- **Live instruments (F-13):** `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3201 -EnvId spec3201 -EnvSlot 1 -RequireIsolation`;
  `.opencode/skills/telemetry-query/telemetry-query.ps1 -Format md -Manifest <env>/manifest.json -Query "<SELECT …>"`;
  the Run CLI (a real agent turn) and `tauri_ipc_monitor`/`tauri_ipc_get_captured` for the delivery.
- **Deterministic OTLP producer (`bun`, for the F-6 merge leg):**
  `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-turn-split.fixture.json --port 4318`
  — one user turn split across TWO `chat` spans (call #1 carries the user text + a `tool_call`, call
  #2 carries only the assistant text). Its documented expectation is the **carried-forward user
  message** on the continuation row (see `copilot-capture/functional.md` F-4).
- **`--locked` gate:** `cargo check --locked` / `cargo clippy --locked -- -D warnings` /
  `cargo nextest run --locked --profile live`, matching `.github/workflows/validate.yml:225,464,465`.

---

## Cases

### F-1 — AC1: the resolved graph carries no forbidden package, and the control reddens (developer)

- [ ] Run, **from the workspace root `apps/tauri/src-tauri`**:
  `powershell -NoProfile -File .opencode/scripts/verify-domain-boundary.ps1` (which runs
  `cargo tree -p telemetry-domain --edges normal,build` and token-scans the **resolved node names**),
  then paste the raw `cargo tree` output too.
  - EXPECTED: exit **0**; the printed node set contains **none** of `tauri`, `tauri-build`,
    `tauri-runtime`, `tauri-runtime-wry`, `tauri-plugin-shell`, `tauri-plugin-mcp-bridge`,
    **`fredo`**, **`fredo_lib`**. A non-zero exit names the offending edge and package.
  - **MUTATION that must redden it:** add `tauri = "2"` to the crate's `Cargo.toml` → guard exits
    non-zero naming `tauri`; remove it → exit 0. Also `fredo = { path = "../.." }` → non-zero
    naming `fredo` (the `path` dep that re-exposes the platform with no "tauri" word in the
    manifest).
  - **Second mutation (instrument integrity):** replace the graph instrument with a `grep` over the
    crate manifest → the `fredo = { path = "../.." }` control still reddens but F-3's transitive
    case goes falsely green, so the F-3 leg is what proves the instrument choice.
  - Edge: the tree resolves an unrelated crate whose NAME merely contains `tauri` (e.g. a
    `-tauri-` prefixed helper) — that is a token-scan false positive to disposition against the
    exact node-name list, not a product FAIL.
  - **Evidence:** the guard's exit code + printed `SCANNED`/`TOKEN`/`HITS` lines + the raw tree, in
    the posted `## Tests Runs` comment.

### F-2 — R-1d/N-2: the platform→crate edge is EXPECTED and asserted (developer)

- [ ] Run `cargo tree -p fredo --depth 1` from the workspace root; read the two importers
  `apps/tauri/src-tauri/src/infrastructure/comm/adapter.rs:8` and
  `.../comm/adapters/internal.rs:10`.
  - EXPECTED: the `fredo` tree **contains** `telemetry-domain`; both importers obtain
    `EventProvider`/`FredoEvent`/`Transport` **from the crate**; and the AC1 guard of F-1 still
    exits **0** on this tree.
  - **MUTATION that must redden it:** add a guard clause forbidding the platform→crate edge (the
    *false guard on correct code*) → the guard exits non-zero on a correct tree → FAIL. Second
    mutation: keep a private copy of the vocabulary in the platform so the crate is not a
    dependency → `cargo tree -p fredo` no longer lists `telemetry-domain` → FAIL.
  - Edge: a platform module reaching the crate through a deep path import still counts as the
    expected direction; a crate→platform edge is F-1's failure, never this row's.
  - **Evidence:** both tree outputs + the F-1 guard exit code, posted.

### F-3 — R-1c: a transitive `path` dependency reddens the guard (developer)

- [ ] With F-1 green, add to the crate's `Cargo.toml` a `path` dependency on a **platform helper
  crate/module that itself depends on `tauri`** (the grep-invisible case), re-run the F-1 guard,
  then restore.
  - EXPECTED: guard exits **non-zero** and names the **transitively reached** package (not the path
    crate); after restore, exit **0** and the node set is byte-identical to F-1's baseline.
  - **MUTATION that must redden it:** implement the check as a manifest text grep → the transitive
    case exits **0** → FAIL. This is the leg that justifies "resolved graph, not manifest grep".
  - Edge: if the repo has no available helper crate to make the edge, create a throwaway
    `crates/__probe/Cargo.toml` with `tauri = { path = <the vendored tauri> }` (or
    `tauri = "2"`) and a path dep from the crate to it, then delete it — record both the creation
    and the deletion.
  - **Evidence:** the three guard runs (baseline / mutated / restored) with exit codes + the node
    list diff, posted.

### F-4 — AC2/R-2: emitted `RowUpsert` VALUES are identical across the boundary (developer)

- [ ] Feed **all five** `fixtures/copilot_cli/*.json` envelopes (copied into
  `crates/telemetry-domain/tests/corpus/`) through the classifier on the spec branch and compare the
  emitted `Vec<(RowUpsert, changed_fields)>` against the committed pre-change fixture
  `crates/telemetry-domain/tests/fixtures/row_upserts_before.json`.
  `cargo nextest run --locked --profile live derivation_equivalence`
  - EXPECTED: byte-for-byte equality of the **serialized values** — every row's full field set
    (including `userMessage`, `agentReply`, `promptTokens`, `completionTokens`,
    `cacheReadTokens`, `model`, `provider`, the parent/composited stamps, `rawJson`) **and** the
    `changed_fields` list, in emission order. A comparison of row COUNT, of the struct TYPE, or of
    a carrier's shape is **not** the assertion and does not pass.
  - **MUTATION that must redden it:** flip one merge rule (`MergeRule::KeepFirst` →
    `LastNonZero` on `userMessage`), or drop one entry from `CHAT_FIELDS`/`TOOL_USE_FIELDS`, or
    change the per-turn token delta baseline — any of those changes a VALUE and must differ. The
    G-520 carrier mutation (compare only the row type) is caught by F-5.
  - **`seq` is the SINK's field, not the crate's** (round 1 source finding). Every fixture record
    carries `seq: 1`, stamped by `Rtdb::ingest_row_upsert` (`rtdb/commands.rs:341-346`) *inside*
    the sink, after the crate hands the row over. The crate's own constructors initialise
    `seq: 0` and every crate patch carries `seq: None`. A fake-sink harness must therefore
    **implement** the per-key counter (from 1) — a recorder that does not model it diffs one
    field per record on a correct product (the G-509 over-strict-instrument class). This does
    **not** license normalising `seq`: only `updatedAt` is normalised.
  - **What this corpus CAN prove:** the span→row **projection and merge** — field extraction,
    per-turn token deltas, the provider token, the first-wins re-key stamps, the no-op gate — since
    the envelopes are real OTLP span input to `ingest_otlp`.
  - **What it CANNOT prove:** `realCorpus.ts` (projected `ContractDelivery` rows, **not** OTLP
    spans) is never exercised here, and no frontend delivery/projection path is covered — that is
    F-13's live leg and the mission-monitor suite. OpenCode-shape-only branches are a disclosed
    residual: all five envelopes carry `Resource.service.name = "copilot-cli"`.
  - Edge: the fixture must be regenerated **only** from the same merge-base commit (record the
    commit in the fixture's `_comment`); a fixture regenerated from a later tree invalidates the
    comparison and is a FAILED leg, not a PASS.
  - **Evidence:** the committed fixture path + the committed test file + the nextest summary line,
    posted.

### F-5 — AC2 falsifiability control: the comparator can fail (developer)

- [ ] Two legs on F-4's harness: (i) print the fixture's row count and its per-kind counts
  (`Chat` / `ToolUse` / `AgentSession`); (ii) change **one** value in a **copy** of the baseline
  fixture (e.g. one `userMessage` character) and re-run the comparison.
  - EXPECTED: (i) row count **> 0** and **≥1** row of each kind — an empty or single-kind fixture is
    a vacuous comparison and is reported as an INSTRUMENT failure, never a PASS (the
    two-empty-readings-equal defect); (ii) the comparison **FAILS** and names the differing field
    and key.
  - **MUTATION that must redden it:** make the comparator narrower (compare counts, or normalize
    through a lossy carrier) → leg (ii) goes **green** on the corrupted copy → FAIL. This is the
    G-520/G-509 control that stops "assert_eq!(a, a)".
  - Edge: the corrupted copy is a scratch file, never the committed baseline; restore it afterwards
    and confirm the committed fixture's hash is unchanged.
  - **Evidence:** both legs' printed counts + the corruption diff + the FAIL message, posted.

### F-6 — AC6 + §4: the port carries the READS, and dropping them reddens (developer)

The classifier **reads existing rows** before it writes (`ingest.rs`: 7 read sites, then 3
writes). Those reads enforce the three invariants this spec protects. A write-only port cannot
express them.

- [ ] (a) The crate's `src/lib.rs` declares `RowSink` with the write **and** the read accessors, by
  name: `ingest_row_upsert`, `get_row`, `keys_for_session`. It is used only as `Arc<dyn RowSink>`
  and is object-safe.
- [ ] (b) A search over `crates/telemetry-domain/src/**` finds **zero** `self.rtdb`, zero `Rtdb`,
  zero `cache()` references, and **≥1** call of each of `get_row` and `keys_for_session` on the sink.
- [ ] (c) **Behavioural leg — the merge-then-ingest read.** Inject the committed turn-split exchange
  (`bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/scripts/copilot-turn-split.fixture.json --port <the env's otlpHttp>`)
  into the REAL HTTP receiver, then read
  `SELECT session_id, correlation_id, user_message, agent_reply, seq FROM chat_rows WHERE session_id = 'e2e-copilotsplit2933' ORDER BY seq`.
  - EXPECTED: the **continuation** row (call #2) carries the **carried-forward user message** from
    call #1 (a non-empty `user_message`), and the dispatcher row (call #1) keeps its own; repeat the
    identical injection and assert **no new seq** and no second delivery (the no-op gate needs the
    read too).
  - **MUTATION that must redden it — the whole point of this row:** implement the backlog's
    write-only sketch, or "fix" the compile error by dropping the read
    (`let mut row = empty_chat_row(&session, &corr);`). The crate then compiles, but the continuation
    row's `user_message` is **NULL** (the patch overwrote the row from an empty base), and the second
    identical injection bumps `seq`. Either reading is a FAIL. The reattribution guard likewise
    degrades from "skip" to "create a row" — prove it by re-running `reattribute_provider` against a
    key with no row and asserting a row is **not** created (`Unchanged`, not a write).
  - **AC6's proof is unchanged** (F-7 still asserts the sink is the only outward dependency); this
    row is coverage **added** for the read surface, never an edit of the AC (G-411).
  - Edge: a cache miss reloading from storage (the read is cache-first, storage-authoritative) —
    exercise one leg after a restart so the read must reach storage; a patch that carries no content
    must not clear the existing value (`LastNonZero`/`KeepFirst`).
  - **Evidence:** (a)/(b) the crate source lines + search output; (c) the two injection runs' printed
    `EXPORT … -> OK` lines + both `chat_rows` reads, in the posted `## Tests Runs` comment.

### F-7 — AC6/R-6: no platform token in the crate, and no path back (developer)

- [ ] (i) `powershell -NoProfile -File .opencode/scripts/guard-universe.ps1 -Root apps/tauri/src-tauri/crates/telemetry-domain -Tokens .opencode/tests/telemetry-domain-crate/boundary-tokens.txt -PristineRoot <the same tree at the pre-change commit>`.
  (ii) read `crates/telemetry-domain/Cargo.toml` for every `path =` entry.
  - EXPECTED: (i) exit **0**, `HITS 0`, `SCANNED` **> 0** (the exact printed number recorded — a
    zero-file scan is a vacuous pass and is reported as an INSTRUMENT failure), and
    `EQUALITY: MATCH`; no token from `tauri::`, `tauri_`, `fredo_lib`, `Rtdb`, `SettingsStore`,
    `crate::infrastructure`, `crate::applications` present. (ii) zero `path =` entries pointing
    above `crates/`.
  - **The token file's `Rtdb` tokens are TYPE POSITIONS, and that narrowing is deliberate.**
    Bare `Rtdb` hits **7 files** on the clean tree, every one a doc comment correctly stating the
    crate never names it (round 1 executed both files: the parked bare-`Rtdb` set prints
    `HITS: 7`; the committed set prints `HITS: 0`, `SCANNED: 20`). Shipped tokens are `Rtdb::`,
    `&Rtdb`, `: Rtdb`, `Arc<Rtdb>`. This narrows the TOKEN, never the predicate — a leak in
    another position falls to the graph instrument (F-1/F-3), which is why the two are bound.
  - **MUTATION that must redden it:** add `use crate::infrastructure::rtdb::commands::Rtdb;` (or a
    `tauri::` call) to any crate file → `HITS` > 0 → FAIL. Add
    `fredo = { path = "../.." }` → (ii) FAILS naming the escaping path (and F-1's graph leg also
    reddens).
  - **Disclosed limit (G-431/G-511), stated where it lives:** this is a **text** scan and cannot see
    a transitively-resolved `path` dependency — F-3 is the instrument that closes that hole, and
    neither alone satisfies AC1. The scan root is the crate only, so this suite's own prose is never
    a token hit.
  - Edge: a token appearing only in a doc comment still counts as a hit (the scan is textual) —
    disposition it as a documentation fix, not a pass.
  - **Evidence:** the guard's full output (both counts + equality line) + the manifest's `path`
    entries, posted.

### F-8 — N-1/NFR-6: exactly ONE `EventState` definition, and it lives in the crate (developer)

- [ ] Search the workspace for `enum EventState` (the crate, `apps/tauri/src-tauri/src`, and any
  `tests/`), and read `apps/tauri/src-tauri/src/infrastructure/rtdb/backfill.rs`'s import block.
  - EXPECTED: exactly **one** hit, in `crates/telemetry-domain/src/event.rs`; `backfill.rs` contains
    **zero** `crate::infrastructure::rtdb::attrs` / `comm::event` imports for the moved names and
    **≥1** `telemetry_domain::` import (the NFR-6 leg: the canonical backfill consumes the crate's
    rules, so live and backfill cannot drift).
  - **MUTATION that must redden it:** reintroduce the rejected **form (c)** — a crate-owned
    `EventState` **plus** an edge converter, i.e. a second `enum EventState` in the platform → 2
    hits → FAIL. A converter layer is a NFR-6 regression, not a cleanup.
  - Edge: a test-only helper enum with a different name is not a hit; a `pub use` re-export of the
    crate's `EventState` is a re-point, not a definition, and is allowed.
  - **Evidence:** each search's exact command + hit count + the file:line, posted.

### F-9 — N-4: row shapes, field tables, merge totality and caps are untouched (developer)

- [ ] `cargo nextest run --locked --profile live merge` plus a diff-aware count of the moved test
  modules, and the column assertions.
  - EXPECTED: `CHAT_FIELDS` = 18, `TOOL_USE_FIELDS` = 16, `AGENT_SESSION_FIELDS` = 13, with
    `provider` **LAST** on each (the `store.rs` column asserts read 18/16/13); `MAP_CAPACITY` =
    10_000; every merge totality test green; **no** test deleted and **no** `#[ignore]` added
    (baseline: 26 `#[test]` in the moved merge module, 26 or more must run); `query/schema.rs`'s
    table-vs-const pins green.
  - **MUTATION that must redden it:** drop one field from a `*_FIELDS` table (breaks the column
    count assert), add a field with no merge rule (breaks totality), lower `MAP_CAPACITY`, or
    `#[ignore]` a totality test → FAIL.
  - Edge: a test moved to a new module path is a re-point, not a deletion — count by body, not by
    path; a test count that DROPS is a FAIL even when the remaining suite is green.
  - **Evidence:** the nextest summary + the four printed constants + the test-count diff, posted.

### F-10 — N-5 + `--locked`: the lockfile is regenerated in the crate-creating capsule (developer)

- [ ] `cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml` (the exact
  `.github/workflows/validate.yml:225` form), then diff `apps/tauri/src-tauri/Cargo.lock`.
  - EXPECTED: exit **0**, with no "the lock file needs to be updated" / "`--locked` was passed but
    the lock file needs updating" message. The lock delta is exactly **one** new `[[package]]`
    block for `telemetry-domain` and **zero** new external package names (`serde`, `serde_json`,
    `anyhow`, `chrono`, `async-trait` were already in the graph — `async-trait` is used at
    `comm/adapter.rs:6,14`).
  - **MUTATION that must redden it:** add the crate manifest + the workspace member **without**
    updating `Cargo.lock` → `cargo check --locked` exits non-zero naming the lock mismatch. That is
    the defect this row exists for: it reddens on the first CI run and looks unrelated to the work.
  - **MUTATION 2:** add an external dependency to the crate (e.g. `tokio`) → a new external package
    name appears in the lock → FAIL on N-5.
  - Edge: the lock delta must be **committed in the same capsule as the manifest change** (ST-1); a
    lock regenerated in a later commit still reddens the CI run of the earlier commit.
  - **Evidence:** the `--locked` command + exit 0 + the lock diff hunk, posted.

### F-11 — AC4/R-4: the build cost is measured, both numbers, same machine and profile (developer)

- [ ] Two timed `cargo build --release` runs, each from a **clean** target directory, same machine,
  same profile: (i) the **pre-change** tree (the merge-base commit, in a scratch checkout or
  measured before ST-1 lands) and (ii) the post-change tree. Record the exact command, the profile,
  the commit per run, whether the target dir was clean, and both wall-clock numbers.
  - EXPECTED: **both** numbers present with their commits and a computed delta; the baseline's commit
    is the pre-change tree (a "baseline" measured after the change is not a baseline); both runs
    state the target dir was clean. Both numbers are produced by a run, never hand-written (G-511).
  - **MUTATION that must redden it:** record a delta without a baseline reading, or a baseline taken
    on a warm target dir / a different profile / a different machine → FAIL. **No threshold is
    bound** — the numbers are the deliverable, and "stop after the pilot" stays legitimate.
  - **A NEGATIVE delta is a legitimate result and must not be read as a speed-up.** Round 1's
    measured pair is `13m 18s` (`3f940ad`) → `11m 17s` (`b2aa45a`), delta **−121 s (−15.2 %)**,
    with the runs **overlapping** (no process-kill grant) and one small crate being a rounding
    error against an 11–13 min native build. The developer stated plainly it *cannot measure the
    extraction's build cost*. Record both numbers and that limit; never "the extraction made the
    build faster".
  - Edge: if the pre-change tree is no longer buildable in the round, record a **named blocker**
    (never a fabricated number) and leave the row UNVERIFIED — not PASS. A clean-target baseline
    costs a full rebuild on this machine (expect tens of minutes); bound the run and record the
    elapsed time.
  - **Evidence:** the posted `## Tests Runs` comment carries both numbers + commands + commits.
    `.opencode/tmp/3201/build-cost.md` is the **authoring channel only** — it is a consumed draft,
    never the record (G-415).

### F-12 — AC5/R-5: zero warnings, clippy clean, live-profile suite green, no NEW suppression (developer)

- [ ] Three runs, matching CI: `cargo check --locked` · `cargo clippy --locked -- -D warnings` ·
  `cargo nextest run --locked --profile live`. Then diff every added `#[allow(...)]`.
  - EXPECTED: `cargo check` reports **zero** warnings; clippy exits **0** (`-D warnings`, no
    `--all-targets` — the CI form); the nextest run uses **`--profile live`** and its summary shows
    no `tests skipped via profile.default.default-filter` line; and the spec-branch diff adds **zero**
    new `#[allow(...)]` attributes.
  - **The `dead_code` zero is now pinned by TWO layers, and the second is load-bearing.**
    `#![deny(dead_code)]` (`crates/telemetry-domain/src/lib.rs:36`) makes an orphan a build
    failure, but it **cannot see a suppression parked on an item that is not dead yet** — no lint
    fires, the deny never triggers, `cargo check` exits 0 while the suppression waits.
    `tests/no_dead_code_suppression.rs` is the layer that sees it (round 1 read the body and
    observed all four tests pass; the developer's receipt shows both layers red on their mutations).
    Do **not** read the `deny` as sufficient on its own.
  - **MUTATION that must redden it:** run a bare `cargo nextest run` (the `default` profile filters
    the model modules at `.config/nextest.toml:36`) → the summary prints the skip line → FAIL, even
    though it reports green. Add `#[allow(dead_code)]` instead of fixing an unused re-point → FAIL
    on the diff leg.
  - **Pre-change control (why the literal is diff-scoped):** the shipped tree already carries 8
    `#[allow(...)]` sites (`utils/error.rs:2`, `runtime/capability.rs:5,12`, `infrastructure/ipc.rs:35`,
    `applications/{terminal,setup,telemetry,settings}/mod.rs`). AC5's "no `#[allow]` suppression" read
    as a zero-in-tree count is **unsatisfiable against the shipped tree**; the bound form is "no new
    suppression introduced by this diff". The 8 pre-existing sites are listed in the receipt as the
    control.
  - Edge: a warning that only appears in a test target (check/clippy do not compile test targets) —
    the nextest run must cover it; do not disable the lint in `Cargo.toml`.
  - **Evidence:** all three commands + exit codes + the warnings count + the skip-line absence + the
    `#[allow]` diff, posted.

### F-13 — AC3/R-3: LIVE — a real `telemetry_spans` row AND the chat row delivered (TESTER)

- [ ] (1) Bring up THIS issue's isolated env (`dev-env.ps1 -Action Up -Spec 3201 -EnvId spec3201
  -EnvSlot 1 -RequireIsolation`); confirm the app is serving and the OTLP ports are the manifest's.
  (2) Take a pre-snapshot: `SELECT count(*) AS n, max(ingested_at) AS newest FROM telemetry_spans`.
  (3) Execute **one real agent turn** (Terminal feature → `spawn_terminal_session{cli:'opencode'}`
  → `write_pty_input` with a trailing `\r`) that produces OTLP spans through the running app.
  (4) Read back the turn's span row(s), and capture the corresponding **chat row delivery** in the
  webview (`useEventRows('chat', { sessionId })` via `tauri_ipc_monitor`/`tauri_ipc_get_captured`,
  or Mission Monitor rendering that session's chat node).
  - EXPECTED: the turn produces **≥1** `telemetry_spans` row with `end_time_ns IS NOT NULL`, a fresh
    `span_id`, and `ingested_at` **strictly newer** than the pre-snapshot's `newest`; `n` advanced by
    at least the number of new spans; AND the webview receives the chat row delivery for that
    session, whose `userMessage` is **non-empty and equal to the prompt actually sent in the turn**.
  - **MUTATION that must redden it:** stub or bypass the classifier's sink so classification never
    runs (or drop the F-6 reads) → no row lands, or the delivered chat row's `userMessage` is empty.
    Replayed history cannot pass: the `ingested_at` freshness gate rejects a pre-existing row.
  - **Static-only evidence is a FAIL.** A code read, a unit test, or a green `cargo test` is **not**
    this row's receipt. If the environment cannot produce a turn (no reachable model/provider, port
    conflict, unservable webview), record a **named blocker** and leave the row UNVERIFIED — never a
    PASS by substitution. `fredo emit` is **not** a span producer (G-256) and cannot stand in.
  - Edge: a fresh cluster (`n=0`, `newest=NULL` — accept any non-empty `ingested_at`); the G-375
    keychain credential gap (disclose the app-pool read substitution in the receipt); a `span_id`
    primary-key collision (run a fresh turn, do not reuse).
  - **Evidence:** the posted `## Tests Runs` comment carries the two snapshots, the span row, and the
    delivery capture (a `user-attachments` screenshot URL or the live DOM/IPC capture result).
    `.opencode/tmp/3201/live-receipt.md` is the authoring channel only (G-415).

### F-14 — N-3: the importer census is complete under BOTH path forms, and no compat shim (developer)

- [ ] Run **both** searches over `apps/tauri/src-tauri/src` and paste every hit:
  (A) the **absolute** form `comm::event::` (and `rtdb::attrs::`, `rtdb::rows::`, `rtdb::merge::`,
  `rtdb::ingest::`); (B) the **relative** form `use super::event::` / `use super::super::event::`
  (and the same relative forms for `rows`/`merge`/`attrs`/`ingest`). Then search for a compatibility
  re-export.
  - EXPECTED: every hit outside the deleted files is re-pointed to `telemetry_domain::…` or deleted;
    the union of (A) and (B) is reconciled against the ~19-file inventory and any **difference is
    reported as a finding**, not silently absorbed. **Search (B) is mandatory and decisive:**
    `comm/adapter.rs:8` uses `use super::event::…`, which search (A) cannot see;
    `comm/adapters/internal.rs:10` uses `super::super::event::…`. And **zero** compatibility shims:
    no `pub use telemetry_domain::…` in `comm/mod.rs`/`rtdb/mod.rs` kept alive so a consumer can
    continue to say `comm::event::` or `rtdb::attrs::`.
  - **MUTATION that must redden it:** add `pub use telemetry_domain::event::*;` to `comm/mod.rs`
    and leave one consumer on `comm::event::` (the compatibility-re-export misreading, which
    reintroduces exactly the coupling the spec removes) → FAIL. Second mutation: re-point only via
    search (A) and skip (B) → `adapter.rs`'s import still names the old path → FAIL on this row even
    though the compiler is the only other detector.
  - Edge: a hit inside a comment or a test is dispositioned, not failed — but the count must be
    printed; a *re-export* of a moved name that the platform itself needs is a re-point to the crate,
    not a shim, and must be distinguished from the forbidden shim in the receipt.
  - **Evidence:** both searches' exact commands + full hit lists + the reconciliation table, posted.

### F-15 — N-3: the visibility widening is exactly the needed set, by NAME (developer)

- [ ] In `crates/telemetry-domain/src/attrs.rs`, list every item declared `pub` (not `pub(crate)`),
  and independently derive the set of `attrs` items that a **staying platform** file imports
  (`store.rs`, `merge.rs`, `session_rollup.rs`, `backfill.rs`).
  - EXPECTED: the two lists are **identical**, asserted **by name**, and the receipt prints both plus
    an EMPTY diff. The derived set from the shipped imports is
    `PROVIDER_UNKNOWN`, `resolve_op_name`, `ATTR_CONVERSATION_ID`, `CC_ATTR_SESSION_ID`,
    `OP_CHAT_CANON`, `OP_SESSION`, `OP_TOOL_PREFIX`. Everything else stays `pub(crate)`.
  - **MUTATION that must redden it:** widen any item not imported by a staying platform file (e.g.
    `MAP_CAPACITY`, `PROVIDER_COPILOT_CLI`, or `resolve_provider_token`) to `pub` "for
    convenience" → the names differ / the count grows → FAIL.
  - **Why this row exists at all:** AC1 cannot catch it — widening `pub(crate)` → `pub` changes **no**
    dependency edge, so the graph instrument is blind to an over-wide public surface. This is the
    only pin on that property.
  - Edge: an item consumed only by code that MOVES into the crate (e.g. `MAP_CAPACITY`,
    `PROVIDER_COPILOT_CLI`, called from the classifier) must stay `pub(crate)` — widening it is the
    over-widening this row forbids. **Note for the architect:** the plan's ST-3 lists
    `resolve_provider_token` as one of the items needing `pub` "per `backfill.rs:84-87`", but that
    import block does not import it and no staying platform file calls it (only doc comments
    mention it). This row is anchored on the DERIVED set, so it stays satisfiable; see `##
    Discussion`.
  - **Evidence:** both lists + the empty diff + the crate's `grep` of `^pub ` over `attrs.rs`, posted.

### F-16 — N-6/G-398: the product docs land in THIS merged diff (developer)

- [ ] Read `docs/ARCHITECTURE.md` at `:364-369` (the `infrastructure/` "Does NOT contain" column) and
  `:281-293` (the module map) on the spec branch, and diff them against `origin/main`.
  - EXPECTED: the table no longer claims `infrastructure/` does not contain business logic while
    naming the classifier/row rules there — the classifier and row rules are stated as the crate's;
    the module map names `crates/telemetry-domain/src/{event,attrs,rows,merge,classifier}`; the
    direction invariant (platform → crate is the correct edge) is stated; and the changed lines are
    **in the spec-branch diff**, not deferred to the post-audit doc-sync.
  - **MUTATION that must redden it:** defer the `ARCHITECTURE.md` change to the gate doc-sync → the
    spec diff carries no ARCHITECTURE change → FAIL. Revert one stale classifier path reference →
    that reference still points at a deleted file → FAIL.
  - Edge: `AGENTS.md` and `opencode.json` are human-owned and must **not** be edited — a diff touching
    either is a FAIL of this row's non-goal. **Read the non-goal precisely (round 1 finding):**
    `ENGINEERING_RULES.md` says only the per-agent `agents.<role>.permissions` arrays of
    `opencode.json` are machine-editable (via `set-permission`), and everything else is the human's.
    The spec diff does touch `opencode.json` — **12 added lines, all `permissions` array entries**
    (four script grants: `guard-universe`, `product-subtree-diff`, `ledger-audit`,
    `check-plan-drivability`, both `-File` spellings) — which is the sanctioned machine-editable
    region, not an edit of a human-owned key. `AGENTS.md` is untouched. Verify both claims on the
    diff rather than assuming either way.
  - **Evidence:** the `git diff origin/main <spec-branch> -- docs/ARCHITECTURE.md` hunk, posted.

---

## Non-functional

- [ ] **N-1 (boundedness / teardown, G-263).** Every command in this plan is bounded: `cargo tree`,
  `cargo check`, `clippy`, `nextest`, and the two release builds have no unbounded wait; the live leg
  runs only through `dev-env.ps1` and is torn down with `-Action Down` then `-Action Clean`. After
  teardown no `fredo`/`postgres` process and no listener under the env root remains. **Mutation that
  must redden it:** leave an unrecorded child process or an unbounded wait → FAIL. Evidence: the
  teardown command + a stopped census/`Status` reading, posted.
- [ ] **N-2 (isolation, G-449/G-452/G-470).** F-13's env is this issue's own: `-EnvId spec3201
  -EnvSlot 1 -RequireIsolation`, `verify-env-isolation.ps1` exits **0**, every derived path is
  inside the env root, and no write reaches the shared `%APPDATA%` cluster. **Mutation that must
  redden it:** run against the legacy/shared instance → the isolation check refuses (exit 3) or the
  isolation line no longer matches this env's slot → FAIL, and any telemetry written to the human's
  shared cluster is an environment defect to report. Evidence: the isolation line + the refused/ok
  exit code, posted.
- [ ] **N-3 (real CI parity).** The spec PR's CI run on its final head SHA is green for
  `cargo check --locked` (`.github/workflows/validate.yml:225`),
  `cargo nextest run --locked --profile live` (`:464`) and
  `cargo clippy --locked -- -D warnings` (`:465`). **Mutation that must redden it:** a lockfile left
  un-regenerated (F-10) reddens `--locked` on the runner; a new `#[allow]` reddens clippy. This row's
  receipt is the real run, not a local equivalent. Evidence: the run id + job ids + the three step
  results, posted.
- [ ] **N-4 (no scope creep, G-271).** The diff introduces no wrapper, adapter, facade or
  compatibility re-export layer; no new external crate; no new repository trait, domain event or
  aggregate-invariant API; and the crate's public surface is exactly the plan's binding-names set.
  **Mutation that must redden it:** add a `TelemetryRepository` trait or a compat shim → FAIL (F-14
  catches the shim; this row catches the abstraction programme). Evidence: the crate's `pub` item
  inventory + the dependency list, posted.

---

## Suite-level pass/fail

PASS = F-1…F-16 green **and** N-1…N-4 hold, **including** F-13's live receipt (a genuine
`telemetry_spans` row + the delivered chat row) and the falsification controls (F-3, F-5, F-13's
mutation leg) actually **observed**, not asserted.

FAIL = any forbidden package in the crate's resolved graph; a guard that cannot redden; a write-only
or read-dropped port; a second `EventState` definition; a widened item outside the derived set; a
stale lockfile; a compat re-export shim; an `ARCHITECTURE.md` update deferred out of the diff; or a
static-only PASS for F-13.

Every UNVERIFIED row carries a named, actionable blocker. A pre-change control that the shipped tree
already violates (the 8 pre-existing `#[allow]` sites) is bound as a diff-scoped form, never as an
unsatisfiable literal.
