//! Spec #3206 ST-4 — Settings → Credits: the ONE outbound link hand-off.
//!
//! The Credits pane renders licence and upstream-notice content and offers one
//! activatable control per entry. Activating it must hand that URL to the OS
//! default browser and leave the Fredo window exactly where it was (AC-5 /
//! R-5.1), and a URL that is not an acceptable `https` address must be REFUSED
//! with a typed, pinned code and must launch nothing (AC-5 / R-5.2).
//!
//! ## Why this is a command and not an `<a href>`
//!
//! `default-src 'self'` in `tauri.conf.json` does not restrict top-level
//! navigation, and this webview has no opener plugin and no `on_new_window`
//! handler, so `target="_blank"` is cancelled by wry while a same-tab `<a href>`
//! would navigate the Settings document away. See `docs/SECURITY.md` (the
//! shell-plugin paragraph) — `shell:allow-open` is deliberately absent, and this
//! module is the only webview-reachable OS-launch path.
//!
//! ## The refusal is PURE — it happens before any I/O
//!
//! [`validate_external_url`] is a pure function over the request string. It
//! performs no I/O, spawns no process, opens no window and mutates no state, so
//! a refused URL physically cannot launch anything. The launch sits behind the
//! injected [`dispatch_open`] seam, which calls the opener ONLY after validation
//! succeeds — the unit tests use a recorder to prove "refused ⇒ zero launches"
//! and "accepted ⇒ exactly one launch, carrying the exact request string".
//!
//! ## The closed refusal-code set (do not grow it silently)
//!
//! [`ExternalLinkRefusal`] has exactly five codes, and they are the ones the
//! frontend parses out of the wire string (`data-refusal-code`):
//!
//! | code | meaning |
//! |---|---|
//! | `not-https` | the string is not an `https://` URL at all (`http:`, `file:`, `javascript:`, `data:`, `ftp:`, a custom scheme, a protocol-relative `//host`) |
//! | `malformed` | empty, whitespace-only, over [`MAX_EXTERNAL_URL_LEN`], a character the hand-off does not admit, or a string `Url::parse` rejects |
//! | `no-host` | the authority/host is empty (`https://`, `https:///x`) |
//! | `userinfo` | credentials are present (`https://user:pw@host/`) |
//! | `loopback-host` | `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `::`, an IPv4-mapped loopback, or a DNS-absolute (trailing-dot) host |
//!
//! The checks run in a BINDING order and the FIRST match wins:
//! empty → whitespace-only → length → `https://` prefix → permitted characters
//! → authority empty → authority `@` → `Url::parse` → scheme → parsed userinfo →
//! host (empty → loopback). [`validate_external_url`] documents each step.
//!
//! ## Why a permitted-character set, when the plan only named whitespace
//!
//! The URL is handed to the `open` crate (5.3.4, already in the workspace graph
//! as a dependency of `tauri-plugin-shell`). On Windows that crate declares no
//! Win32 binding at all — `Cargo.lock`'s `open` entry depends only on `dunce`,
//! `is-wsl`, `libc` and `pathdiff`, so it cannot be calling `ShellExecuteW`; its
//! only remaining mechanism is to hand the target to the shell through
//! `std::process::Command`. That crate's own source cannot be read from this
//! sandbox, so this module does NOT rely on its argument framing: it admits only
//! characters that carry no meaning to `cmd` — no `&`, `%`, `^`, `|`, `<`, `>`,
//! `"`, `` ` ``, `(`, `)`, `!`, `$`, `*`, `\`, no whitespace and no control
//! character. `=` (query pairs), `:`, `/`, `?`, `#`, `[`, `]`, `@` and the
//! RFC 3986 unreserved marks stay available, non-ASCII characters are inert to
//! the shell and pass, and every upstream URL in `docs/THIRD_PARTY_NOTICES.md`
//! §1–§4/§7 is accepted by this set. This is a deliberate narrowening of the
//! plan's "no whitespace / no control character" clause in the safe direction:
//! the hand-off can only ever receive a string the shell cannot re-parse.
//!
//! ## Non-goals (binding)
//!
//! No second opener (no `tauri-plugin-opener`, no shell-plugin `open`, no
//! `tauri-plugin-shell` Rust API), no `std::process::Command` here, no shell
//! string building, no client-supplied command/flags, no capability file, no
//! CSP edit, no arbitrary target — only a validated `https` URL ever reaches the
//! opener.

use tauri::Url;

/// The maximum accepted request length, in bytes.
///
/// Chosen so a request stays a plain page address rather than a document: every
/// upstream URL the Credits pane renders is far below it. A longer string is
/// refused as [`ExternalLinkRefusal::Malformed`] before parsing.
pub const MAX_EXTERNAL_URL_LEN: usize = 2048;

/// The literal scheme prefix the request must carry (matched ASCII
/// case-insensitively). A URL without it is [`ExternalLinkRefusal::NotHttps`] —
/// `Url::parse` is never asked to interpret a non-`https` scheme.
const HTTPS_PREFIX: &str = "https://";

/// The CLOSED set of refusal codes (AC-5 / R-5.2).
///
/// The wire form is `external link refused: <code>`; the frontend parses
/// `<code>` into `data-refusal-code`. There is no "other" variant and no
/// catch-all string: a new refusal reason must be one of these five or it does
/// not exist (see the module docs for the meaning of each).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalLinkRefusal {
    /// Not an `https://` URL: another scheme, a custom scheme, or a
    /// protocol-relative `//host`.
    NotHttps,
    /// Empty, whitespace-only, over [`MAX_EXTERNAL_URL_LEN`], carrying a
    /// character the hand-off does not admit, or unparseable.
    Malformed,
    /// The authority/host is empty (`https://`, `https:///x`).
    NoHost,
    /// Credentials are present (`https://user:pw@host/`).
    Userinfo,
    /// `localhost`, a loopback/unspecified address, or a trailing-dot host.
    LoopbackHost,
}

impl ExternalLinkRefusal {
    /// The pinned wire code (never localised, never reworded).
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotHttps => "not-https",
            Self::Malformed => "malformed",
            Self::NoHost => "no-host",
            Self::Userinfo => "userinfo",
            Self::LoopbackHost => "loopback-host",
        }
    }

    /// Every refusal code, in the documented precedence order.
    ///
    /// Exists so the closed set is a CODE fact (asserted by the unit tests)
    /// rather than a comment: a new variant must be added here too. Test-only by
    /// design — the command never enumerates refusals, it reports the one it hit.
    #[cfg(test)]
    pub const fn all() -> [Self; 5] {
        [
            Self::NotHttps,
            Self::Malformed,
            Self::NoHost,
            Self::Userinfo,
            Self::LoopbackHost,
        ]
    }
}

/// The outcome of a dispatch attempt: a pure refusal, or an OS-hand-off failure.
///
/// The two families carry distinct pinned prefixes — `external link refused: `
/// (nothing was launched) and `external link failed: ` (the OS hand-off was
/// attempted and reported an error). The frontend renders the exact string it
/// receives; it never paraphrases it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalLinkError {
    /// The URL was refused BEFORE any I/O; nothing was launched.
    Refused(ExternalLinkRefusal),
    /// The URL was accepted and the OS hand-off reported this error.
    Failed(String),
}

impl ExternalLinkError {
    /// The exact string that crosses IPC (`Result<(), String>`'s `Err`).
    pub fn message(&self) -> String {
        match self {
            Self::Refused(refusal) => format!("external link refused: {}", refusal.code()),
            Self::Failed(error) => format!("external link failed: {error}"),
        }
    }
}

impl std::fmt::Display for ExternalLinkError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for ExternalLinkError {}

/// True when `raw` starts with `https://`, ASCII case-insensitively.
fn has_https_prefix(raw: &str) -> bool {
    raw.get(..HTTPS_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(HTTPS_PREFIX))
}

/// The characters an accepted request may contain.
///
/// ASCII is restricted to the RFC 3986 unreserved marks, the structural
/// delimiters and the `=`/`+`/`,`/`;` sub-delimiters — every ASCII character
/// with meaning to the Windows shell (`&`, `%`, `^`, `|`, `<`, `>`, `"`, `` ` ``,
/// `(`, `)`, `!`, `$`, `*`, `\`), plus whitespace and control characters, is
/// excluded by omission. Non-ASCII characters are inert to the shell and pass.
fn is_permitted_url_char(character: char) -> bool {
    if !character.is_ascii() {
        return true;
    }
    character.is_ascii_alphanumeric()
        || matches!(
            character,
            '-' | '.'
                | '_'
                | '~'
                | ':'
                | '/'
                | '?'
                | '#'
                | '['
                | ']'
                | '@'
                | '='
                | '+'
                | ','
                | ';'
        )
}

/// The raw authority of an `https://` request: everything after the prefix up to
/// the first path, query or fragment delimiter.
///
/// Only called once [`has_https_prefix`] passed, so the prefix length is a char
/// boundary; `get` keeps it panic-free regardless.
fn raw_authority(raw: &str) -> &str {
    let after_prefix = raw.get(HTTPS_PREFIX.len()..).unwrap_or_default();
    match after_prefix.find(['/', '?', '#']) {
        Some(index) => &after_prefix[..index],
        None => after_prefix,
    }
}

/// True when the host is `localhost`, a loopback/unspecified IP literal, or an
/// IPv4-mapped loopback.
///
/// `host_str()` returns the parser-normalised host (WHATWG normalises IPv4
/// shorthand such as `127.1` and IPv4-mapped IPv6 to a canonical form), so the
/// `IpAddr` parse here sees the address the request really resolves to.
fn is_loopback_host(host: &str) -> bool {
    let lowered = host.to_ascii_lowercase();
    if lowered == "localhost" {
        return true;
    }
    // `host_str()` renders an IPv6 literal with its brackets.
    let bare = lowered
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(&lowered);
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(address)) => address.is_loopback() || address.is_unspecified(),
        Ok(std::net::IpAddr::V6(address)) => {
            address.is_loopback()
                || address.is_unspecified()
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.is_loopback() || mapped.is_unspecified())
        }
        Err(_) => false,
    }
}

/// Validate an external-link request, PURELY (no I/O, no process, no window).
///
/// Returns the parsed [`Url`] on acceptance, or the typed refusal. The checks run
/// in this BINDING order and the FIRST match wins:
///
/// 1. empty → [`ExternalLinkRefusal::Malformed`];
/// 2. whitespace-only → [`ExternalLinkRefusal::Malformed`];
/// 3. longer than [`MAX_EXTERNAL_URL_LEN`] → [`ExternalLinkRefusal::Malformed`];
/// 4. no `https://` prefix (ASCII case-insensitive) → [`ExternalLinkRefusal::NotHttps`];
/// 5. a character outside [`is_permitted_url_char`] (whitespace, control, a
///    shell-significant ASCII character) → [`ExternalLinkRefusal::Malformed`];
/// 6. an empty raw authority → [`ExternalLinkRefusal::NoHost`];
/// 7. an `@` in the raw authority → [`ExternalLinkRefusal::Userinfo`];
/// 8. `Url::parse` rejects the string → [`ExternalLinkRefusal::Malformed`];
/// 9. a parsed scheme other than `https` → [`ExternalLinkRefusal::NotHttps`]
///    (defensive: step 4 already guarantees it);
/// 10. parsed username/password non-empty → [`ExternalLinkRefusal::Userinfo`];
/// 11. an empty host → [`ExternalLinkRefusal::NoHost`];
/// 12. a trailing-dot (DNS-absolute) host, `localhost`, or a loopback/unspecified
///     address → [`ExternalLinkRefusal::LoopbackHost`].
///
/// A trailing dot is refused because `localhost.` is a DNS-absolute spelling of
/// the same loopback name; refusing every trailing-dot host keeps the loopback
/// predicate impossible to spell around.
pub fn validate_external_url(raw: &str) -> Result<Url, ExternalLinkRefusal> {
    if raw.is_empty() {
        return Err(ExternalLinkRefusal::Malformed);
    }
    if raw.chars().all(char::is_whitespace) {
        return Err(ExternalLinkRefusal::Malformed);
    }
    if raw.len() > MAX_EXTERNAL_URL_LEN {
        return Err(ExternalLinkRefusal::Malformed);
    }
    if !has_https_prefix(raw) {
        return Err(ExternalLinkRefusal::NotHttps);
    }
    if !raw.chars().all(is_permitted_url_char) {
        return Err(ExternalLinkRefusal::Malformed);
    }
    let authority = raw_authority(raw);
    if authority.is_empty() {
        return Err(ExternalLinkRefusal::NoHost);
    }
    if authority.contains('@') {
        return Err(ExternalLinkRefusal::Userinfo);
    }
    let url = Url::parse(raw).map_err(|_| ExternalLinkRefusal::Malformed)?;
    if url.scheme() != "https" {
        return Err(ExternalLinkRefusal::NotHttps);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ExternalLinkRefusal::Userinfo);
    }
    let host = url.host_str().ok_or(ExternalLinkRefusal::NoHost)?;
    if host.is_empty() {
        return Err(ExternalLinkRefusal::NoHost);
    }
    if host.ends_with('.') || is_loopback_host(host) {
        return Err(ExternalLinkRefusal::LoopbackHost);
    }
    Ok(url)
}

/// The default opener: the `open` crate's detached OS hand-off.
///
/// `that_detached` spawns the handler and returns without waiting for it, so the
/// IPC round-trip does not block on a browser cold start. This is the ONLY
/// launch site in the module (`open::` appears exactly once in product code),
/// and it is never reached by a refused request.
pub fn default_opener(url: &str) -> std::io::Result<()> {
    open::that_detached(url)
}

/// Validate, then hand the ACCEPTED request string to `opener` — the injected
/// seam.
///
/// Refusal happens BEFORE the opener is called, so a refused request launches
/// nothing. On acceptance the opener receives the EXACT request string (no
/// normalisation, no re-serialisation): the address the user's browser opens is
/// byte-for-byte the validated one.
pub fn dispatch_open(
    raw: &str,
    opener: &dyn Fn(&str) -> std::io::Result<()>,
) -> Result<(), ExternalLinkError> {
    validate_external_url(raw).map_err(ExternalLinkError::Refused)?;
    opener(raw).map_err(|error| ExternalLinkError::Failed(error.to_string()))
}

/// Hand a validated external URL to the OS default browser.
///
/// # Errors
///
/// `Err("external link refused: <code>")` — the request was refused before any
/// I/O (see [`ExternalLinkRefusal`]); `Err("external link failed: <os error>")` —
/// the request was accepted and the OS hand-off reported an error. Either way
/// nothing navigates, no Fredo window opens, and no shell command is built from
/// user-supplied text.
#[tauri::command]
pub async fn open_external_link(url: String) -> Result<(), String> {
    // The refusal is pure and cheap, so it runs on the caller's task BEFORE the
    // blocking hand-off is even scheduled — a refused request never occupies a
    // blocking worker.
    validate_external_url(&url).map_err(|refusal| ExternalLinkError::Refused(refusal).message())?;
    // The OS hand-off is blocking; it runs off the async worker and carries the
    // validated string by value. `dispatch_open` re-validates (the same pure
    // function), so the seam itself keeps its "refused ⇒ zero launches"
    // precondition even if a future caller reaches it directly.
    tauri::async_runtime::spawn_blocking(move || {
        dispatch_open(&url, &default_opener).map_err(|error| error.message())
    })
    .await
    .map_err(|error| {
        ExternalLinkError::Failed(format!("opener task failed: {error}")).message()
    })?
}

#[cfg(test)]
mod tests {
    use super::{
        dispatch_open, validate_external_url, ExternalLinkError, ExternalLinkRefusal,
        MAX_EXTERNAL_URL_LEN,
    };
    use std::cell::RefCell;

    /// A recorder opener: records every request it is asked to open.
    fn recorder<'a>(calls: &'a RefCell<Vec<String>>) -> impl Fn(&str) -> std::io::Result<()> + 'a {
        move |url| {
            calls.borrow_mut().push(url.to_string());
            Ok(())
        }
    }

    /// The closed set, exactly as the frontend parses it. A new variant that is
    /// not added here fails this assertion.
    #[test]
    fn refusal_codes_are_the_closed_five() {
        let codes: Vec<&str> = ExternalLinkRefusal::all()
            .iter()
            .map(|refusal| refusal.code())
            .collect();
        assert_eq!(
            codes,
            vec![
                "not-https",
                "malformed",
                "no-host",
                "userinfo",
                "loopback-host"
            ],
            "the refusal-code set is CLOSED: exactly these five, in precedence order"
        );
    }

    /// The wire messages are pinned verbatim: the family prefix and the code.
    #[test]
    fn wire_messages_are_pinned() {
        for refusal in ExternalLinkRefusal::all() {
            assert_eq!(
                ExternalLinkError::Refused(refusal).message(),
                format!("external link refused: {}", refusal.code())
            );
        }
        assert_eq!(
            ExternalLinkError::Failed("the system cannot find the file".to_string()).message(),
            "external link failed: the system cannot find the file"
        );
    }

    /// THE refusal matrix: every refused input prints its pinned code and its
    /// launch count, and the recorder proves the count is ZERO. `--nocapture`
    /// makes this the row's own receipt.
    ///
    /// The accept legs live in the next test — they are the RECORDER'S CONTROL:
    /// without a `launches=1` line, a zero from this matrix would be a reading
    /// from an unproven instrument.
    #[test]
    fn refusal_matrix_prints_every_input_and_launches_nothing() {
        let over_long = format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_LEN));
        let matrix: Vec<(&str, ExternalLinkRefusal)> = vec![
            // empty / whitespace-only
            ("", ExternalLinkRefusal::Malformed),
            ("   ", ExternalLinkRefusal::Malformed),
            ("\u{9}\u{a}", ExternalLinkRefusal::Malformed),
            // length bound
            (over_long.as_str(), ExternalLinkRefusal::Malformed),
            // not https: schemes, custom schemes, protocol-relative
            ("http://example.com/x", ExternalLinkRefusal::NotHttps),
            ("HTTP://example.com/x", ExternalLinkRefusal::NotHttps),
            ("file:///C:/Windows/System32/calc.exe", ExternalLinkRefusal::NotHttps),
            ("javascript:alert(1)", ExternalLinkRefusal::NotHttps),
            ("data:text/html,<script>alert(1)</script>", ExternalLinkRefusal::NotHttps),
            ("//evil.example/x", ExternalLinkRefusal::NotHttps),
            ("ftp://example.com/x", ExternalLinkRefusal::NotHttps),
            ("fredo-credits://open?url=x", ExternalLinkRefusal::NotHttps),
            // malformed: characters the hand-off does not admit
            ("https://exa mple.com/x", ExternalLinkRefusal::Malformed),
            ("https://example.com/\u{7f}", ExternalLinkRefusal::Malformed),
            ("https://example.com/?a=1&b=2", ExternalLinkRefusal::Malformed),
            ("https://example.com/%PATH%", ExternalLinkRefusal::Malformed),
            ("https://example.com/`calc`", ExternalLinkRefusal::Malformed),
            ("https://example.com/\"calc\"", ExternalLinkRefusal::Malformed),
            ("https://example.com/x\\..\\y", ExternalLinkRefusal::Malformed),
            ("https://example.com:99999/x", ExternalLinkRefusal::Malformed),
            // no host
            ("https://", ExternalLinkRefusal::NoHost),
            ("https:///x", ExternalLinkRefusal::NoHost),
            // credentials
            ("https://user:pw@example.com/x", ExternalLinkRefusal::Userinfo),
            ("https://@example.com/x", ExternalLinkRefusal::Userinfo),
            // loopback / unspecified / DNS-absolute
            ("https://localhost/x", ExternalLinkRefusal::LoopbackHost),
            ("https://LOCALHOST./x", ExternalLinkRefusal::LoopbackHost),
            ("https://localhost:8443/x", ExternalLinkRefusal::LoopbackHost),
            ("https://127.0.0.1/x", ExternalLinkRefusal::LoopbackHost),
            ("https://127.10.20.30/x", ExternalLinkRefusal::LoopbackHost),
            ("https://[::1]/x", ExternalLinkRefusal::LoopbackHost),
            ("https://[::ffff:127.0.0.1]/x", ExternalLinkRefusal::LoopbackHost),
            ("https://0.0.0.0/x", ExternalLinkRefusal::LoopbackHost),
            ("https://[::]/x", ExternalLinkRefusal::LoopbackHost),
            ("https://example.com./x", ExternalLinkRefusal::LoopbackHost),
        ];

        let mut refused_lines = 0usize;
        for (input, expected) in matrix {
            let calls: RefCell<Vec<String>> = RefCell::new(Vec::new());
            let error = dispatch_open(input, &recorder(&calls))
                .expect_err(&format!("{input:?} must be refused"));
            let observed = calls.borrow();
            println!(
                "REFUSED {input:?} code={} launches={}",
                error_code(&error),
                observed.len()
            );
            assert_eq!(
                error,
                ExternalLinkError::Refused(expected),
                "wrong refusal for {input:?}"
            );
            assert!(
                observed.is_empty(),
                "{input:?} was refused but the opener was called {} time(s)",
                observed.len()
            );
            // The pure validator must agree with the dispatch path.
            assert_eq!(
                validate_external_url(input).err(),
                Some(expected),
                "the pure validator must return the same refusal for {input:?}"
            );
            refused_lines += 1;
        }
        println!("refusal matrix: {refused_lines} inputs, every launch count 0");
        assert_eq!(refused_lines, 34, "the matrix grew or shrank unannounced");
    }

    /// The accept legs — the recorder's CONTROL. Exactly one launch, carrying the
    /// exact request string (no normalisation).
    #[test]
    fn accepted_urls_launch_exactly_once_with_the_exact_string() {
        let accepted = [
            "https://github.com/ggml-org/llama.cpp",
            "https://www.doomworld.com/idgames/?id=7043",
            // Upper-case scheme + host: accepted (the scheme compare is ASCII
            // case-insensitive) and handed over byte-for-byte.
            "HTTPS://GitHub.com/ggml-org/ggml",
            // A non-ASCII path character is inert to the shell and passes.
            "https://example.com/caf\u{e9}",
        ];
        for url in accepted {
            let calls: RefCell<Vec<String>> = RefCell::new(Vec::new());
            dispatch_open(url, &recorder(&calls))
                .unwrap_or_else(|error| panic!("{url} must be accepted: {error}"));
            let observed = calls.into_inner();
            println!("ACCEPTED {url} launches={}", observed.len());
            assert_eq!(
                observed,
                vec![url.to_string()],
                "{url} must launch exactly once with the exact request string"
            );
        }
    }

    /// The length bound is inclusive at [`MAX_EXTERNAL_URL_LEN`] and exclusive
    /// above it — a boundary, not an approximate budget.
    #[test]
    fn the_length_bound_is_inclusive_at_the_maximum() {
        let prefix = "https://example.com/";
        let at_max = format!("{prefix}{}", "a".repeat(MAX_EXTERNAL_URL_LEN - prefix.len()));
        assert_eq!(at_max.len(), MAX_EXTERNAL_URL_LEN);
        let calls: RefCell<Vec<String>> = RefCell::new(Vec::new());
        dispatch_open(&at_max, &recorder(&calls)).expect("a URL at the bound is accepted");
        assert_eq!(calls.into_inner().len(), 1);

        let over_max = format!("{at_max}a");
        assert_eq!(
            validate_external_url(&over_max),
            Err(ExternalLinkRefusal::Malformed)
        );
    }

    /// An accepted request whose hand-off fails maps to the `failed:` family —
    /// and was still attempted exactly once (it is not a refusal in disguise).
    #[test]
    fn an_opener_failure_is_the_failed_family_after_one_attempt() {
        let calls: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let failing = |url: &str| {
            calls.borrow_mut().push(url.to_string());
            Err(std::io::Error::other("no handler registered"))
        };
        let error = dispatch_open("https://example.com/x", &failing)
            .expect_err("a failing opener must surface as an error");
        println!("FAILED https://example.com/x error={} launches=1", error.message());
        assert_eq!(
            error,
            ExternalLinkError::Failed("no handler registered".to_string())
        );
        assert_eq!(
            error.message(),
            "external link failed: no handler registered",
            "the failure family is pinned"
        );
        assert_eq!(
            calls.into_inner(),
            vec!["https://example.com/x".to_string()],
            "the hand-off was attempted exactly once with the exact string"
        );
    }

    /// A static purity guard: this module spawns NO process of its own.
    ///
    /// The launch is delegated to the `open` crate through exactly ONE call site
    /// (`default_opener`), so a defect cannot appear as a second, unguarded spawn.
    /// The scanner ignores comment lines (a symbolic purity ban, not an
    /// AC-literal scan), and it is proven non-vacuous below: it sees a seeded
    /// token, and it still sees the real `open::` call after stripping.
    #[test]
    fn the_module_spawns_no_process_of_its_own() {
        const SOURCE: &str = include_str!("credits.rs");
        let code = code_only(SOURCE);

        // Constructed, never written literally, so the guard cannot count itself.
        let process_command = ["std::process", "::Command"].concat();
        let command_new = ["Command", "::new("].concat();
        let process_module = ["std::", "process::"].concat();
        for banned in [&process_command, &command_new, &process_module] {
            assert!(
                !code.contains(banned.as_str()),
                "credits.rs must not spawn a process directly (found {banned})"
            );
        }

        let opener_call = ["open::", "that_detached("].concat();
        assert_eq!(
            code.matches(opener_call.as_str()).count(),
            1,
            "the OS hand-off must have exactly ONE call site"
        );

        // Non-vacuity: the same scanner sees a seeded token, and it does not
        // empty a source that carries a real one.
        let seeded = format!("fn probe() {{ {command_new}x); }}");
        assert!(
            code_only(&seeded).contains(command_new.as_str()),
            "the comment stripper must not hide a real token"
        );
    }

    /// Strip comment lines, so the purity guard scans CODE only.
    fn code_only(source: &str) -> String {
        source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The refusal's wire code, for the matrix printout.
    fn error_code(error: &ExternalLinkError) -> &'static str {
        match error {
            ExternalLinkError::Refused(refusal) => refusal.code(),
            ExternalLinkError::Failed(_) => "failed",
        }
    }
}
