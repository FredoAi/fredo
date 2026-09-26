//! PLACEHOLDER — owned by **ST-3** (write-behind + LRU semantics validation).
//!
//! Declared as a `[[bin]]` by ST-1 so the crate layout is fixed and ST-3 only
//! replaces this one file (no `Cargo.toml`/`lib.rs` edit). ST-1 does not
//! implement this artifact; it exists so `cargo build --bins` is green.
//!
//! Shared code is available without any manifest edit:
//! `use postgres_migration_spike::harness;`

fn main() {
    eprintln!(
        "spike #2964: `write_behind` is not implemented by ST-1 — it is owned by ST-3 \
         (see the plan's Sub-issue Decomposition)."
    );
}
