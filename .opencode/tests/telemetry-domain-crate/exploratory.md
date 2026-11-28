# telemetry-domain-crate — Exploratory Probes

> Unscripted edge/failure probes for the domain-crate boundary. A confirmed finding **promotes** to
> `functional.md` as a new `F-` row (keep the origin note). Probes are prompts, not pass/fail gates
> until promoted.
>
> **Do not probe by weakening a guard.** A probe that only passes because the AC1 guard was relaxed
> is evidence about the probe, not the product.
>
> **Persisted by the tester in round 1 (G-521).**

## The boundary itself

- [ ] **E-1** — Add a `dev-dependency` edge from the crate to the platform. Does the AC1 guard catch
  it? `cargo tree --edges normal,build` deliberately excludes `dev` edges — decide whether the
  boundary claim should cover dev edges and say which reading the guard implements.
- [ ] **E-2** — Add a `build-dependency` edge. `--edges normal,build` includes it — does the guard
  catch it, and does `build.rs`'s `command_manifest` include give any route in?
- [ ] **E-3** — Add a crate-local `pub use telemetry_domain as old_name;` inside the PLATFORM and
  leave one consumer on the old path. Does anything redden? (This is the compat-shim misreading in
  its most tempting form.)
- [ ] **E-4** — Add a transitive dep whose name merely CONTAINS a forbidden token (e.g. a helper named
  `not-tauri-utils`). Does the guard distinguish an exact node name from a substring? A substring
  match here is a false-positive guard.
- [ ] **E-5** — Make the crate's `[lib] name` differ from the package name (e.g. package
  `telemetry-domain`, lib `telemetrydomain`). Do the `-p` flag, the `use` paths and the guard all
  still agree? Where do they diverge?

## The port (read + write)

- [ ] **E-6** — Implement `RowSink::get_row` as `Ok(None)` unconditionally (a "compiles, does
  nothing" stub). Does anything redden — F-4's value equality, F-6(c)'s carried-forward message, or
  only a live read? An empty-read stub is the quiet version of dropping the reads.
- [ ] **E-7** — Make `RowSink::keys_for_session` return an empty vec. Does the re-key stop copying
  child rows under the parent while the reattribution guard still works, or do both degrade? Which
  row notices first?
- [ ] **E-8** — Widen the port with a method nobody calls. Does N-4's "no scope creep" reading catch
  an unused public surface, or is only F-15's widening pin load-bearing?
- [ ] **E-9** — Hold a cache-miss on `get_row` while a write-behind flush is in flight. Does the
  storage-authoritative reload return the row the classifier is about to merge into, or an older
  snapshot — and does the merge then drop a field?

## Merge / derivation edges the corpus may not reach

- [ ] **E-10** — Feed an OpenCode-shaped envelope (`service.name = "fredo-opencode-plugin"`) through
  the same equivalence harness. Is it in the committed corpus at all, or is the whole AC2 comparison
  copilot-only (a disclosed residual — check whether that is acceptable coverage)?
- [ ] **E-11** — Drive a multi-hop re-key (L1→L2→L3, depth ≥ 3) and compare the row overlay across
  the boundary. Can the corpus at `crates/telemetry-domain/tests/corpus/` express depth 3 at all?
  (G-088: a class the fixtures cannot model must be verified on the real path.)
- [ ] **E-12** — Two spans at the same `startedAtNs` for one key, in opposite orders. Does the
  first-wins stamp still hold after the move, and does `seq` still avoid a parallel row?
- [ ] **E-13** — Kill the app mid-write (unclean WAL) and restart. Does a re-derived row still find
  its predecessor through the moved read path, or does it start a parallel row?

## CI / lockfile

- [ ] **E-14** — Commit the workspace manifest change and the lock regeneration in two separate
  commits. Does the first commit's CI run redden on `--locked`, and would a reader attribute it to
  something else? (This is the exact failure F-10 exists to prevent.)
- [ ] **E-15** — Add a `[patch]` section to the workspace root. Does it change the resolved graph
  without changing any manifest under `crates/`? If so, the manifest-grep instrument is blind to it.
- [ ] **E-16** — Run the full suite with the `default` nextest profile instead of `live`. What does
  the summary print, and could a reader mistake it for the gate?

## Live leg

- [ ] **E-17** — Run the live turn on an instance whose OTLP port is already bound by another
  process. Does the turn produce `telemetry_spans` rows at all, and how does the tester distinguish
  "the classifier never ran" from "the receiver never bound"?
- [ ] **E-18** — Run the live turn with the companion engine unable to load a model. Does the agent
  turn still emit spans (spans are plugin-emitted, not engine-emitted), and is a named blocker owed
  or is the leg still drivable?

## Opened by round 1 (2026-11-28)

- [ ] **E-19 (from the AC2 gap)** — Does the crate ship ANY classifier-level test? Round 1 found
  **zero**: `cargo nextest run -p telemetry-domain` is 79 tests, all `attrs` / `merge` / `event` /
  `parent_prompt_cache` / `no_dead_code_suppression`; no test constructs an `IngestClassifier`.
  Consequence: the classifier's ~660 lines of `mod.rs` + 1,592 lines of `classifier/{agent,
  relationship,session,tool,turn}.rs` (**~2,250 lines**) have **no unit coverage at all** after the
  move, and `merge.rs`'s totality suite is the only proxy for the rules that run. Promote to a
  durable F-row if confirmed at the audit.
- [ ] **E-20 (from the AC2 `seq` finding)** — Land the pin at
  `.opencode/tmp/3201/ac2-derivation-equivalence.pin.md` and check whether `seq` is the ONLY field
  the fake-sink carrier changes. The pin's §1 argues it is; if a second field moves, the `seq`
  explanation is incomplete and the disclosure must say so.
