# settings-credits — Exploratory

> Unscripted edge/failure probes for **Settings → Credits** (Spec #3206). Not a verdict on the
> ACs — every probe records what it observed, and a confirmed defect **promotes** to
> `functional.md` as a new `F-` row (keep the origin note). A probe that cannot run is recorded
> as `NOT RUN` with the reason; never invent a substitute.

## E-1 — Accepted URL containing shell metacharacters (security probe)

- [ ] **E-1.** Through the DEV debug bridge, invoke
      `open_external_link` with `https://example.com/a&b?c=%PATH%&d=$(whoami)` (a **valid**
      https URL: non-empty host, no userinfo, no whitespace — it must be ACCEPTED by the
      validator).
  - **Observe:** does the invoke resolve Ok? Does any secondary process start (a `$(whoami)`
    shell substitution executing, a console window flashing, a second browser tab for a
    truncated URL)? Check `Get-Process` before/after and the window list.
  - **Why:** the ACCEPT path hands the URL to the OS handler. If the `open` crate's Windows
    implementation routes through `cmd /c start`, a quoting defect would turn the query string
    into a command line. F-12b proves the refusal path is I/O-free; this probe is the only look
    at the accept path's framing. Record the observed mechanism (F-12b's note says whether the
    crate shells out).
  - **Expected:** exactly one handler launch with the identical URL string; zero secondary
    processes; no console window.
  - **Promote if:** any substitution executes, or the URL the browser receives is truncated at
    `&`.

## E-2 — Licence bodies are readable in the ways users actually read them

- [ ] **E-2.** On Credits: select the Apache body's text with a programmatic selection
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

- [ ] **E-5.** Open Credits, expand MIT, click `Companion`, then click `Credits` again.
  - **Observe:** is the accordion state reset (expected — the section remounts via the shell's
    `key={activeSection}` on the Save provider) or preserved? Is any error banner left over from
    a previous refusal?
  - **Expected:** a clean remount; `credits-link-error` does not persist across a section change
    (a stale error would misreport the current state).

## E-6 — Theme and accent re-tint (no hardcoded paint)

- [ ] **E-6.** Switch to the light theme, then to a non-default accent, and inspect the Credits
      pane's nav highlight, link colour, field labels and the trademark notice's emphasis.
  - **Observe:** does every paint change with the accent/theme (token-driven), or is some border/
    stripe unchanged (a literal)?
  - **Expected:** every surface re-tints; the pane is legible in both themes. A paint that does
      not move with the accent is a literal-colour defect — F-16's audit should already have
      caught it; if the audit is green and the paint does not move, the audit's file list is
      incomplete.

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
