//! R-4.2 (wiring) — `lib.rs` installs the canonical-upsert observer once,
//! unconditionally, directly in the Tauri `setup` closure body, and the installed
//! composite feeds BOTH the canonical watch registry and the declared-row
//! projection engine.
//!
//! Since Spec #2979 CU-2 the data plane is PostgreSQL-only, so the previous
//! runtime proof that composed a temp SQLite store was removed with the
//! SQLite data plane. The structural wiring proof below is engine-independent and
//! is retained; the live projection proof is owned by the mission-monitor E2E
//! suite.

// ── Static-source helpers ───────────────────────────────────────────────────

/// `apps/tauri/src-tauri/src/lib.rs` — the crate's composition root.
fn lib_rs_source() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("lib.rs");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// Blank every comment and string literal, preserving byte offsets, so the
/// structural scans match CODE only.
fn mask(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = vec![b' '; bytes.len()];
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len()
                    && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            b'"' => {
                index += 1;
                while index < bytes.len() {
                    match bytes[index] {
                        b'\\' => index += 2,
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
            }
            byte => {
                out[index] = byte;
                index += 1;
            }
        }
    }
    String::from_utf8(out).expect("masked source stays valid UTF-8")
}

/// The body of the Tauri `.setup(|app| { ... })` closure (masked source).
fn setup_body(masked: &str) -> &str {
    let marker = ".setup(|app|";
    let setup = masked
        .find(marker)
        .unwrap_or_else(|| panic!("lib.rs must open the app with `{marker}`"));
    let open = setup
        + masked[setup..]
            .find('{')
            .expect("the setup closure must have a body");
    let close = matching_brace(masked, open);
    &masked[open + 1..close]
}

/// The item whose signature contains `signature`, delimited by brace matching.
fn item_span<'a>(masked: &'a str, signature: &str) -> &'a str {
    let start = masked
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` not found in masked lib.rs"));
    let open = start
        + masked[start..]
            .find('{')
            .unwrap_or_else(|| panic!("`{signature}` has no body"));
    let close = matching_brace(masked, open);
    &masked[start..=close]
}

/// The index of the `}` closing the `{` at `open`.
fn matching_brace(masked: &str, open: usize) -> usize {
    let bytes = masked.as_bytes();
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return index;
                }
            }
            _ => {}
        }
        index += 1;
    }
    panic!("unbalanced braces while scanning from byte {open}");
}

/// Brace nesting depth at `needle`, relative to the start of `body` (0 = a
/// direct statement of the body — no enclosing block).
fn relative_depth(body: &str, needle: usize) -> i32 {
    let mut depth = 0i32;
    for (index, byte) in body.bytes().enumerate() {
        if index >= needle {
            break;
        }
        match byte {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
    }
    depth
}

#[test]
fn observer_is_registered_unconditionally_in_lib_rs() {
    let source = lib_rs_source();
    let masked = mask(&source);

    // Exactly ONE install call (the `use` import has a comma, not a call).
    assert_eq!(
        masked.matches("install_row_upsert_observer(").count(),
        1,
        "lib.rs must install exactly one canonical-upsert observer"
    );

    let body = setup_body(&masked);
    let call = body
        .find("install_row_upsert_observer(")
        .expect("the observer install must sit in the Tauri setup closure");
    assert_eq!(
        relative_depth(body, call),
        0,
        "the observer install must be a direct statement of the setup closure body — \
         no `if`/`match`/loop (no subscription or UI gate) may enclose it (R-4.2)"
    );

    // Positive control: the depth meter DOES see nesting (the tracing block).
    let logging = body
        .find("LogBridgeLayer::new()")
        .expect("the tracing-init marker must be present");
    assert!(
        relative_depth(body, logging) > 0,
        "the depth meter must detect an enclosed call (tracing init)"
    );

    // The install composes the composite, not the bare engine.
    assert!(
        body.contains("install_row_upsert_observer(Arc::new(ApplicationDataUpsertObserver {"),
        "lib.rs must install the composite observer (canonical watches + projection engine)"
    );

    // The composite feeds BOTH the canonical watch registry and the engine.
    let composite = item_span(&masked, "impl RowUpsertObserver for ApplicationDataUpsertObserver");
    assert!(
        composite.contains("self.watches.on_canonical_row("),
        "the observer must feed canonical-table watches"
    );
    assert!(
        composite.contains("self.engine.on_row_upsert("),
        "the observer must feed the declared-row projection engine"
    );
}
