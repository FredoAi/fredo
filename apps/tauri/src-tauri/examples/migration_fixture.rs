//! Committed deterministic `fredo.db` fixture generator (Spec #2977, ST-7 / CU-D).
//!
//! Writes a SQLite fixture containing every physical table the one-shot
//! SQLite → PostgreSQL migration must carry, for serving to the app through the
//! **G-275** `FREDO_DATA_DIR` override. Fully deterministic (index-derived
//! values; no RNG, no clock) and it NEVER reads the live
//! `%APPDATA%\com.fredo.app\fredo.db` (G-264).
//!
//! ```text
//! cargo run --example migration_fixture -- --out .opencode/tmp/2977/fixture/fredo.db
//! cargo run --example migration_fixture -- --large --out .opencode/tmp/2977/fixture-large/fredo.db
//! ```

#[path = "../tests/support/migration_fixture.rs"]
mod migration_fixture;

use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let mut out: PathBuf = PathBuf::from(".opencode/tmp/2977/fixture/fredo.db");
    let mut large = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => {
                out = PathBuf::from(args.next().expect("--out requires a path"));
            }
            "--large" => large = true,
            other => {
                eprintln!("unknown argument: {other}");
            }
        }
    }
    let scale = if large {
        migration_fixture::FixtureScale::LARGE
    } else {
        migration_fixture::FixtureScale::SMALL
    };
    migration_fixture::build_fixture(&out, &scale)?;
    println!(
        "wrote {} (largest table = {} rows; total rows = {}; dynamic table {})",
        out.display(),
        scale.largest_table_rows(),
        scale.total_rows(),
        migration_fixture::DYNAMIC_FEATURE_TABLE
    );
    Ok(())
}
