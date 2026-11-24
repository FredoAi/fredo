//! Launch-mode resolution and the no-window launch contract (Spec #3193 ST-1).
//!
//! Fredo has exactly TWO launch shapes:
//!
//! * **Foreground** — the historical path. `run()` shows the `main` window once
//!   Tauri reports `RunEvent::Ready`.
//! * **Background** — a login launch (`<exe> --background`): the process starts
//!   resident and ingests telemetry with **no window at all**; the tray `Open`
//!   item (or a later foreground launch) reveals the same window later, in the
//!   same process.
//!
//! **The flag is recognised ONLY as the sole argument** (exact, case-sensitive,
//! `argv.len() == 2`). It is deliberately NOT registered with clap: every other
//! argv — `--help`, `--version`, `emit …`, and even `["--background", "emit"]` —
//! keeps the pre-existing CLI path byte-for-byte, and `--background` alongside
//! any other token stays a clap parse error (exit 1 via
//! [`exit_code_for_parse_error`], never `2`). `main.rs` therefore resolves the
//! mode BEFORE its `args.len() > 1` clap branch and only enters the background
//! path for the single-argument case.
//!
//! **The window is declarative and hidden by config.** `tauri.conf.json` sets
//! `app.windows[0].visible = false` (asserted by the drift guard in
//! [`app_lifecycle`](crate::infrastructure::app_lifecycle) against
//! `MAIN_WINDOW_VISIBLE_BY_CONFIG`), so a background launch never paints a frame
//! — the window is hidden from birth, not hidden after a visible flash. The
//! show point is `RunEvent::Ready`, never `setup`: `lib.rs`'s own note records
//! that the config window may not be materialised during `setup`, while `Ready`
//! is the point at which it is guaranteed.
//!
//! [`exit_code_for_parse_error`]: crate::infrastructure::cli::exit_code_for_parse_error

use tauri::{AppHandle, Manager};

/// The ONE argument that selects a background (no-window) launch.
///
/// Matched exactly — case-sensitively, as the sole argument — so no clap
/// subcommand, flag or value can collide with it.
pub const BACKGROUND_FLAG: &str = "--background";

/// How this process was launched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchMode {
    /// The historical launch: the `main` window is shown once the app is ready.
    Foreground,
    /// A login launch: resident and ingesting, with no window shown.
    Background,
}

/// Resolve the launch mode from a raw argument vector (`argv[0]` = executable,
/// ignored).
///
/// `Background` is returned for EXACTLY `["<exe>", "--background"]`. Every other
/// vector — no argument, `--help`, a subcommand, `--background` with anything
/// else, or any other spelling/casing of the flag — is `Foreground`, i.e. the
/// pre-existing path.
pub fn resolve_launch_mode(args: &[String]) -> LaunchMode {
    if args.len() == 2 && args[1] == BACKGROUND_FLAG {
        LaunchMode::Background
    } else {
        LaunchMode::Foreground
    }
}

/// Apply the launch mode at `RunEvent::Ready` — the point at which the config
/// window is guaranteed to be materialised (`setup` is not).
///
/// * `Foreground` — show the `main` window. It is declared `visible: false` in
///   `tauri.conf.json` (so a background launch never flashes), which means the
///   foreground launch must show it explicitly.
/// * `Background` — show nothing and move no focus: the process stays resident
///   with no window until the tray `Open` item (or a second, foreground launch)
///   asks for it. Nothing is hidden here either — the window was never shown.
pub fn apply_launch_mode(app: &AppHandle, launch: LaunchMode) {
    match launch {
        LaunchMode::Foreground => {
            match app.get_webview_window(crate::infrastructure::app_lifecycle::MAIN_WINDOW_LABEL) {
                Some(window) => {
                    if let Err(error) = window.show() {
                        tracing::warn!(
                            target: "fredo::launch",
                            error = %error,
                            "could not show the main window on a foreground launch; the tray \
                             Open item retries the same primitive"
                        );
                    }
                }
                // Not materialised by `Ready`: the tray `Open` item (and a second
                // launch) build it on demand through `ensure_main_window`, so the
                // user still reaches exactly one window.
                None => tracing::warn!(
                    target: "fredo::launch",
                    "the main window was not materialised by RunEvent::Ready; the tray Open \
                     item builds it on demand"
                ),
            }
        }
        LaunchMode::Background => {
            tracing::info!(
                target: "fredo::launch",
                "starting in background mode: no main window will be shown; the tray Open item \
                 shows it"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use clap::Parser;

    use crate::infrastructure::cli::{exit_code_for_parse_error, Cli, Commands};

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    /// The ONE argv that selects a background launch.
    #[test]
    fn the_sole_background_flag_selects_background() {
        assert_eq!(
            resolve_launch_mode(&argv(&["fredo", BACKGROUND_FLAG])),
            LaunchMode::Background
        );
        // The executable token is `argv[0]` and is never inspected — a different
        // binary name (a renamed install) does not change the decision.
        assert_eq!(
            resolve_launch_mode(&argv(&[r"C:\Program Files\Fredo\fredo.exe", "--background"])),
            LaunchMode::Background
        );
        // The pinned flag literal is part of the contract (`R-5a`).
        assert_eq!(BACKGROUND_FLAG, "--background");
    }

    /// Every other argv — including the flag with anything else, a different
    /// casing, or a different prefix — is the pre-existing foreground path.
    #[test]
    fn every_other_argv_selects_foreground() {
        let cases: &[&[&str]] = &[
            &["fredo"],
            &["fredo", "--help"],
            &["fredo", "--version"],
            &["fredo", "emit"],
            &["fredo", "ingest"],
            &["fredo", "open-terminal", "--cli", "opencode"],
            // Not the sole argument ⇒ NOT the launch flag (it stays a clap error).
            &["fredo", "--background", "emit"],
            &["fredo", "emit", "--background"],
            &["fredo", "--background", "--background"],
            // Exact and case-sensitive only.
            &["fredo", "--Background"],
            &["fredo", "-background"],
            &["fredo", "background"],
            &["fredo", "--background=true"],
            &["fredo", "--background "],
        ];

        for case in cases {
            assert_eq!(
                resolve_launch_mode(&argv(case)),
                LaunchMode::Foreground,
                "argv {case:?} must keep the pre-existing foreground/CLI path"
            );
        }
    }

    /// `--background` is NOT a clap argument: the single-argument form is a clap
    /// parse error, which is exactly why `main.rs` must resolve it first. The
    /// exit code stays `1` (never clap's default `2`, which is reserved for
    /// app-not-running).
    #[test]
    fn the_background_flag_is_not_registered_with_clap() {
        let error = Cli::try_parse_from(argv(&["fredo", BACKGROUND_FLAG]))
            .expect_err("a sole --background must not parse as a CLI invocation");
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::UnknownArgument,
            "the launch flag must stay outside the clap surface, got {:?}",
            error.kind()
        );
        assert_eq!(
            exit_code_for_parse_error(error.kind()),
            1,
            "an invalid invocation keeps the pre-existing exit code"
        );

        // Non-vacuity: the rendered help is really inspected, and it carries no
        // launch flag — the shipped CLI surface is unchanged.
        use clap::CommandFactory;
        let help = Cli::command().render_help().to_string();
        assert!(
            !help.contains(BACKGROUND_FLAG),
            "--background must not appear in the CLI help:\n{help}"
        );
        assert!(
            help.contains("Usage:"),
            "the help text must be the real rendered help:\n{help}"
        );
    }

    /// The flag with a subcommand stays a parse error on the pre-existing path —
    /// `--background emit` is an invalid invocation, not a background launch.
    #[test]
    fn the_background_flag_with_a_subcommand_stays_a_parse_error() {
        let args = argv(&["fredo", BACKGROUND_FLAG, "emit"]);
        assert_eq!(resolve_launch_mode(&args), LaunchMode::Foreground);
        let error = Cli::try_parse_from(args).expect_err("--background emit must not parse");
        assert_eq!(
            exit_code_for_parse_error(error.kind()),
            1,
            "--background emit must exit 1, got {:?}",
            error.kind()
        );
    }

    /// Every pre-existing invocation keeps its parse result and exit code.
    #[test]
    fn the_existing_cli_surface_is_unchanged() {
        // `--help` / `--version` still exit 0.
        for flag in ["--help", "--version"] {
            let error = Cli::try_parse_from(argv(&["fredo", flag]))
                .expect_err("help/version are rendered through a clap error");
            assert_eq!(
                exit_code_for_parse_error(error.kind()),
                0,
                "`fredo {flag}` must keep exiting 0, got {:?}",
                error.kind()
            );
        }

        // A real subcommand still parses to the same command.
        let parsed = Cli::try_parse_from(argv(&["fredo", "emit", "--event-type", "tool_use"]))
            .expect("`fredo emit --event-type tool_use` must keep parsing");
        assert!(
            matches!(parsed.command, Commands::Emit(_)),
            "`fredo emit` must still dispatch to the emit command"
        );

        // The retained subcommands still resolve, including the daemon whose
        // reference docs #3194 owns.
        for subcommand in ["ingest", "open-terminal", "open-app", "setup", "doom"] {
            let error = Cli::try_parse_from(argv(&["fredo", subcommand, "--help"]))
                .expect_err("`--help` is rendered through a clap error");
            assert_eq!(
                exit_code_for_parse_error(error.kind()),
                0,
                "`fredo {subcommand} --help` must keep exiting 0, got {:?}",
                error.kind()
            );
        }
    }

    /// Spec #3193 ST-1 (R-5a) — the STATIC dispatch-order pin. `main.rs` must
    /// resolve the launch mode BEFORE its `args.len() > 1` clap branch, so a
    /// `--background` login launch never reaches clap, and the clap branch must
    /// still be the pre-existing `Cli::try_parse()` path.
    ///
    /// Read from the real source (`include_str!`), never a transcription — the
    /// pin fails if the order is inverted even though both statements still
    /// exist.
    #[test]
    fn main_resolves_the_launch_mode_before_the_cli_branch() {
        let source = include_str!("../main.rs");
        assert!(
            source.contains("fn main()"),
            "the pin must be reading the real binary entry point"
        );

        let resolve = source
            .find("resolve_launch_mode(&args)")
            .expect("main.rs must resolve the launch mode from argv");
        let background_branch = source
            .find("if launch == LaunchMode::Background")
            .expect("main.rs must branch on the resolved launch mode");
        let cli_branch = source
            .find("} else if args.len() > 1 {")
            .expect("main.rs must keep its pre-existing clap branch");
        let run_foreground = source
            .rfind("fredo_lib::run(launch);")
            .expect("main.rs must start the app with the resolved mode");

        assert!(
            resolve < background_branch,
            "the mode must be resolved before it is branched on"
        );
        assert!(
            background_branch < cli_branch,
            "the background branch must precede the clap branch (otherwise a login launch \
             reaches clap)"
        );
        assert!(
            cli_branch < run_foreground,
            "the no-argument foreground launch must follow the clap branch, unchanged"
        );
        assert!(
            source.contains("Cli::try_parse()"),
            "the CLI branch must remain the pre-existing clap parse path"
        );
    }
}
