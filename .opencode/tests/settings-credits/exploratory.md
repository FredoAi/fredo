# settings-credits — Exploratory

> Unscripted edge/failure probes for **Settings → Credits** (Spec #3206). Not a verdict on the
> ACs — every probe records what it observed, and a confirmed defect **promotes** to
> `functional.md` as a new `F-` row (keep the origin note). A probe that cannot run is recorded
> as `NOT RUN` with the reason; never invent a substitute.

## E-1 — Shell-metacharacter payloads: refused at the validator (security claim) + the accept-path framing (happy path)

> **Re-derived against the shipped validator.** The earlier form of this probe called
> `https://example.com/a&b?c=%PATH%&d=$(whoami)` "a **valid** https URL … it must be ACCEPTED".
> That premise is false for this product: `is_permitted_url_char` (`credits.rs:181-203`) admits
> only the RFC 3986 unreserved marks, the structural delimiters and `=`/`+`/`,`/`;` — every
> shell-significant ASCII character (`&`, `%`, `^`, `|`, `<`, `>`, `"`, `` ` ``, `(`, `)`, `!`,
> `$`, `*`, `\`) is excluded **by omission** and lands in the `malformed` refusal
> (`credits.rs:443-450` pins `&`, `%`, backtick, quote, `\` and an out-of-range port as
> `Malformed`). So the security claim is proven on the REFUSAL side; the accept-path framing is a
> separate, narrower probe (E-1b).

### E-1a — SECURITY CLAIM: shell-metacharacter payloads are REFUSED, nothing launches

- [ ] **E-1a.** Through the DEV debug bridge, invoke the seam per payload, catching the rejection
      so the value comes back as a string:
      `window.__TAURI__.core.invoke('open_external_link', {url: '<u>'}).then(r=>'ACCEPTED', e=>String(e))`
  - **Payloads and their pinned code (each is a literal cell of the shipped unit matrix, so the
    live value and the unit value are comparable):**

    | `<u>` | expected string |
    |---|---|
    | `https://example.com/a&b?c=%PATH%&d=$(whoami)` | `external link refused: malformed` |
    | `https://example.com/?a=1&b=2` | `external link refused: malformed` |
    | `https://example.com/%PATH%` | `external link refused: malformed` |
    | `` https://example.com/`calc` `` | `external link refused: malformed` |
    | `https://example.com/"calc"` | `external link refused: malformed` |
    | `https://example.com/x\..\y` | `external link refused: malformed` |
    | `https://example.com:99999/x` | `external link refused: malformed` |
    | `https://exa mple.com/x` | `external link refused: malformed` |

  - **Precondition (same as F-13):** the instance must be the DEV build — `withGlobalTauri` is
    true only under `tauri.dev.conf.json`. If `window.__TAURI__` is undefined, use
    `window.__TAURI_INTERNALS__.invoke` and record which seam was used; if neither handle exists
    (the round booted `dev:release`), the row is `UNVERIFIED` with that named blocker — never a
    PASS and never a product FAIL.
  - **Observe:** the returned string (must equal the table), `Get-Process` before/after (no new
    process, no console window), the `tauri_manage_window action="list"` set, and the console.
  - **Expected:** every payload returns exactly its pinned refusal string; **zero** new processes
    and **zero** console windows; the window list and `credits-settings` are unchanged; no
    `credits-link-error` appears (the pane was not driving). This is the claim the AC cares
    about — the refusal is decided BEFORE any OS hand-off, so a shell-significant byte can never
    reach a command line.
  - **Promote if:** any payload resolves `ACCEPTED`, returns a different code, starts a process,
    or the refusal is not decided before the hand-off.

### E-1b — HAPPY PATH: an accepted URL carrying only permitted delimiters is handed over ONCE, byte-for-byte

- [ ] **E-1b (control — without it E-1a's zero is a reading from an unproven instrument).**
      Same seam, `https://example.com/a,b;c~d?e=1+2#frag` — every byte is in the permitted set
      (`,` `;` `~` `?` `=` `+` `#`, plus letters), so the validator ACCEPTS it.
  - **Observe:** the returned value (`ACCEPTED`), the window list, `credits-settings` presence,
    and whether one OS handler was invoked.
  - **Why:** the accept path is where a quoting defect in the `open` crate's Windows
    implementation would surface (if it routes through `cmd /c start`, the delimiters are what
    get re-lexed). F-12b proves there is exactly one call site and no command construction; this
    leg proves the accepted string reaches it intact.
  - **Expected:** `ACCEPTED`; Credits is still shown; the window list is unchanged; exactly one
    OS hand-off. A browser process appearing is corroboration only, never a gate (the default
    browser commonly reuses a running instance — same rule as F-11c, G-470).
  - **Promote if:** the accepted URL is truncated at a delimiter, a second/zero hand-off occurs,
    or any shell interpolation is observed.

## E-2 — Licence bodies are readable in the ways users actually read them

- [ ] **E-2.** On Credits: open the Apache body — `credits-body-fredo-apache-2-0` — using the
      focus-then-click recipe in `functional.md`'s header (a bare bridge `.click()` leaves
      `aria-expanded` at `"false"` on a working pane; that is a failed drive, not a defect).
      Then select the Apache body's text with a programmatic selection
      (`document.createRange` over `credits-text-fredo-apache-2-0`), read
      `window.getSelection().toString().length`, scroll the Settings content scroller to the end
      and back, and resize the window (900×600 → 1400×900) with the accordion open.
  - **Observe:** is the selection length equal to the body length? Does the body survive a scroll
    round trip (no re-collapse, no unmount)? Does the open body reflow rather than clip? Is the
    body a Tab stop (it must not be — no `tabIndex`, no `overflow`, no `maxHeight`, per UI/UX
    §5.3)?
  - **Expected:** selection covers the whole body; the accordion stays open across scroll and
    resize; no horizontal scrollbar on the pane; Tab skips the body entirely.

## E-3 — Layout under the worst realistic value

- [ ] **E-3.** Inspect the longest single token in the artifact (a long URL or a long unbroken
      word inside a `Distribution form` value). Then, at the 900 px minimum width, measure the
      entry's `scrollWidth` vs `clientWidth`.
  - **Observe:** does an unbreakable token force a horizontal overflow of the content scroller?
  - **Expected:** the value wraps (`overflow-wrap: anywhere` / `word-break` at the value cell);
    no horizontal scrollbar appears on the Settings content area.
  - **Promote if:** the token escapes the pane and adds a horizontal scroller (R-1.3 says no
    truncation and no second scroller; an overflow is the mirror defect).

## E-4 — Repeated activation

- [ ] **E-4.** Click `credits-link-llama-cpp` twice within the same tick (before the invoke
      settles), then once more after 5 s.
  - **Observe:** the recorder in the unit test / the bridge traffic on the live instance — how
    many invokes fired? window list, `credits-settings` presence, `credits-link-error`, console.
  - **Expected:** the double click fires **one** invoke (the per-entry in-flight guard drops the
    second — UI/UX U-4) and one OS handoff; the later click fires a second, legitimate one.
    The button is never `disabled` and never shows a spinner. The webview never navigates and no
    Fredo window is created.
  - **Promote if:** a double click invokes twice, or the button disables/blurs, or the webview
    navigates.

## E-5 — Leaving and returning

- [ ] **E-5.** Open Credits, expand MIT (use the `functional.md` header recipe), click `Companion`,
      then click `Credits` again.
  - **Observe:** is the accordion state reset (expected — the section remounts via the shell's
    `key={activeSection}` on the Save provider) or preserved? Is any error banner left over from
    a previous refusal?
  - **Expected:** a clean remount; `credits-link-error` does not persist across a section change
    (a stale error would misreport the current state).

## E-6 — Theme and accent re-tint (no hardcoded paint) — RETARGETED to the addressable control

> **Why this probe changed.** As first written it asked the executor to "switch to a non-default
> accent" by activating the Appearance **swatches**, and that leg is **not drivable**: the accent
> controls are `div`/`Box` swatches wrapping an opacity-`0` `input[type="color"]`
> (`ThemingSettings.tsx:136-162`), so neither a synthetic click chain-walk (the visible box is not
> a button, and clicking the underlying colour input opens a native OS dialog) nor the text
> strategy activates them. The addressable theming control the suite already depends on is the
> preset select — a preset carries `accentPrimary` **and** the background/text tokens
> (`app/types/theme.ts:296-345`: `solarized` = a light base, `cyberpunk` = `#ff2bc2` accent), so
> both halves of this probe — light theme and different accent — are reachable through it.

- [ ] **E-6.** Open Appearance and record the applied variables
      (`document.documentElement` → `--accent-primary`, `--body-bg`, `--card-bg`,
      `--text-primary`) plus the current value of
      `select[aria-label="Theme presets"]` (ThemingSettings.tsx:80-92 — a real `chakra.select`,
      i.e. a native `<select>`). Then drive it, restoring the original value at the end:
      ```js
      const s = document.querySelector('select[aria-label="Theme presets"]');
      s.value = 'solarized';                                   // light base
      s.dispatchEvent(new Event('change', { bubbles: true })); // React onChange fires
      ```
      Repeat with `cyberpunk` (a different accent). Re-read the four variables after each change,
      then open Credits and read four surfaces: the active `settings-nav-credits` highlight
      background, a `credits-link-<id>`'s computed `color`, a `credits-field-*` `dt`'s computed
      `color`, and `credits-doom-trademark`'s emphasis colour.
  - **Observe:** does every one of those four surfaces move with the preset (token-driven), or does
    one stay at the previous preset's value (a literal)?
  - **Expected:** all four computed paints change on both preset changes, no surface keeps a
    previous preset's value, and every one of them resolves through a `var(--…)` / semantic token
    rather than a literal.
  - **Named blocker (the un-drivable half, kept explicit):** the per-swatch accent editing in
    Appearance cannot be driven from the bridge (see the note above). The standing proof for that
    half is **F-16's literal-colour audit** — the committed `AUDITED_FILES` list in
    `SettingsSurface.theming.test.tsx` (which names
    `src/applications/settings-app/credits/CreditsSettings.tsx`) plus its hex/rgba/`var(--x)NN`
    pattern scan. A probe that cannot be driven is recorded `NOT RUN — not drivable`, never passed.

## E-7 — Generator failure MODE (message quality, no partial artifact)

- [ ] **E-7.** Using the generator's committed negative legs (F-7c) as the *mechanism*, inspect
      the failure output for one contract violation (the simplest: temporarily break the doc's
      §2 `Distribution form` column in a **copy** under `.opencode/tmp/3206/drift/` if the
      generator accepts a root, else read the committed negative-test output).
  - **Observe:** does the failure name the offending section/field, and does it exit non-zero
    **without** writing a partial artifact?
  - **Expected:** a named failure and no artifact write (a generator that writes a truncated
    artifact before throwing would leave a stale-looking file that the equality gate then
    reports as drift — the wrong message for the operator).
  - **NOT RUN acceptable:** if the generator exposes no root override, record
    `NOT RUN — covered by the committed unit matrix` and do not hand-edit the real doc here.

## E-8 — Focus order and announcement

- [ ] **E-8.** Tab through the whole Credits pane from the sidebar and record the focus order and
      each focused element's accessible name.
  - **Observe:** are all six links and both Fredo triggers reachable exactly once each? Is the
      refusal banner (`role="alert"`) announced when it appears (mounted after a refusal)?
  - **Expected:** no unreachable control, no focus trap inside the pane, and the alert is a live
      region.

## E-9 — Credits with a feature application registered

- [ ] **E-9.** On the normal shipped app (≥1 feature exposes settings, so the `Applications`
      group header renders), confirm the Credits item is still the last item of the STATIC group
      and sits **above** the `Applications` header.
  - **Observe:** DOM order of the nav items.
  - **Expected:** Credits last among the static items, above the group header. A Credits item
      that lands after the header (i.e. inside the feature group) is a FAIL of R-1.2 — promote.

_Probe convention: record the command/probe, the observed value, and a disposition
(`no defect` / `promoted to F-n` / `out of scope — reason`)._
