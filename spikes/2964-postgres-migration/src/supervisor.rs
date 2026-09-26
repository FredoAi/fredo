//! PLACEHOLDER — owned by **ST-5** (lifecycle supervisor PoC: bounded start/stop,
//! guaranteed teardown, PID-reuse-guarded orphan sweep).
//!
//! Declared as a `[[bin]]` by ST-1 so the crate layout is fixed and ST-5 only
//! replaces this one file (no `Cargo.toml`/`lib.rs` edit). ST-1 does not
//! implement this artifact; it exists so `cargo build --bins` is green.
//!
//! Shared code is available without any manifest edit:
//! `use postgres_migration_spike::harness;`

fn main() {
    eprintln!(
        "spike #2964: `supervisor` is not implemented by ST-1 — it is owned by ST-5 \
         (see the plan's Sub-issue Decomposition)."
    );
}
