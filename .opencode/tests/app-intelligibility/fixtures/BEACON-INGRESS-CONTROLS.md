# BEACON-INGRESS-CONTROLS — the ING-1 negative-control plan (Spec #3244)

> The control plan the generator's comments point at. The fixture is
> `fixtures/build-intelligibility-fixtures.mjs` → package **`qa3244-beacon-control`**.
> The suite rows that consume it are `functional.md`'s beacon legs; the plan's row is **ING-1**.
>
> **The typed reason IS the observable.** A beacon that merely *does not crash*, a fixture that
> renders its panel, and a host that keeps serving are **not** a PASS. A control passes only when
> `telemetry_spans` carries **one `installed.beacon.ingress` span** for the attempt whose
> `reason` (and `accepted`) is the value this table names. A missing span is a FAIL with the same
> weight as a wrong reason: *no receipt* means the attempt never reached the ingress.

---

## 1. What the host actually records

Read the shipped code before trusting this table: `apps/tauri/src-tauri/src/applications/
installed_apps/beacon.rs`.

| Fact | Shipped value | Where |
|---|---|---|
| ingress route | `/__fredo/beacon` (`BEACON_PATH`) | `beacon.rs:70` |
| span name | `installed.beacon.ingress` (`BEACON_INGRESS_SPAN_NAME`) | `beacon.rs:107` |
| decoded-payload bound | `BEACON_MAX_BYTES = 16 * 1024` | `beacon.rs:82` |
| raw-query bound (checked before any decode) | `raw.len() > BEACON_MAX_BYTES * 2` | `beacon.rs:339` |
| correlation timeout | `BEACON_TIMEOUT_MS = 2_000` | `beacon.rs:86` |
| nonce TTL | `BEACON_NONCE_TTL_MS = BEACON_TIMEOUT_MS` (**equal on purpose**) | `beacon.rs:91` |
| outstanding-nonce cap | `BEACON_NONCE_STORE_CAP = 64`, oldest-first eviction | `beacon.rs:95`, `:237` |
| outline node cap carried to the child | `BEACON_MAX_NODES = 120` | `beacon.rs:104` |
| span attributes | `reason`, `accepted`, `payloadBytes`, `nonceAgeMs`, optional `appId` | `beacon.rs:436-450` |

**The full reason vocabulary** (`BeaconOutcome::reason` / `BeaconFailure::reason`,
`beacon.rs:159-199`):

`accepted` · `oversize` · `missing-nonce` · `unknown-nonce` · `expired` · `malformed` ·
`chunk-incomplete` · `timeout` · `not-open` · `invalid-app` · `eval-failed`

**Every attempt records a span**, accepted or not: `serve_beacon` calls `record_ingress` on the
way out (`beacon.rs:535-547`), and the abandon-the-wait path records its own `timeout` fact
(`beacon.rs:602-614`). So "no span" is never a legitimate outcome of a control that really fired.

**Two properties of the receipt the tester must read correctly:**

1. `session_id` / `appId` is **empty/absent for a raw ingress request**. The scheme handler does not
   know which app loaded the image (the request carries only query parameters), so `outcome_facts`
   sets `app_id: None` (`beacon.rs:512-525`). Only the `timeout` receipt — recorded by
   `request_outline`, which was *told* the app id — carries one.
   **Consequence:** do not try to attribute a child-issued control by `appId`. Attribute it by
   `reason`, `payloadBytes` and ordering (see §3), corroborated by the fixture's own rendered log.
2. `telemetry_logs` is **NOT** an accepted receipt (gate gap **M9**). Query `telemetry_spans`.

### The query (deterministic)

```sql
SELECT span_id,
       session_id,
       status_message                                   AS reason,
       attributes_json
  FROM telemetry_spans
 WHERE span_name = 'installed.beacon.ingress'
 ORDER BY start_time_ns DESC
 LIMIT 20;
```

`status_message` mirrors `reason` for every rejected attempt (`beacon.rs:471-476`) and is `NULL`
for an accepted one; `accepted` in `attributes_json` is the authoritative boolean.

---

## 2. The controls

One row per control. **`producible`** is how the beacon is produced: `child` = the fixture issues
it on `mount` with no host turn; `turn` = the fixture **self-arms the lever off the report-call
index** and the tester drives **one companion turn** targeting `qa3244-beacon-control` (no post-mount
gesture — see §6).

| id | producible | how it is produced | expected typed reason | the step that drives it |
|---|---|---|---|---|
| **A-OVERSIZE** | `child` | On `mount` the module builds a raw query longer than `2 × BEACON_MAX_BYTES` and loads it: `nonce=qa3244-control-oversize&d=<≈32 KB of 'A'>`. There is no base64 decode, no JSON — the raw length alone trips the pre-decode bound. | **`oversize`**, `accepted=false`, `payloadBytes > 16384` | Open the fixture. Nothing else. `serve_beacon` refuses before buffering. |
| **B-MISSING-NONCE** | `child` | On `mount` it loads a **well-formed** payload with **no `nonce` parameter at all**: `d=<base64 of a valid ScreenOutline>`. | **`missing-nonce`**, `accepted=false` | Open the fixture. The payload is valid, so only the nonce gate can reject it — that is what makes the leg discriminating. |
| **C-UNKNOWN-NONCE** | `child` | On `mount` it loads a well-formed payload under a nonce the host could never have minted: `nonce=qa3244-control-never-issued&d=…`. | **`unknown-nonce`**, `accepted=false` | Open the fixture. |
| **E-TIMEOUT** | `turn` | The module **wraps** the host-authored reporter `window.__FREDO_REPORT_OUTLINE__`. On the **second** report call (companion **turn 2**) the wrapper returns **without issuing the image load**. The host `eval`s the requested reporter, waits `BEACON_TIMEOUT_MS`, and abandons. | **`timeout`**, `accepted=false`, `appId = qa3244-beacon-control` — **and zero `unknown-nonce` / `accepted` spans for that turn** (see §2.1: a bare `timeout` span is NOT a PASS) | Drive **companion turn 2** targeting `qa3244-beacon-control`. No gesture is needed — the lever is armed off the report-call index. Read the span. |
| **D-REPLAY-AFTER-TTL** | `turn` | On the **first** report call (companion **turn 1**) the wrapper forwards normally and then re-issues the **same minted** nonce `BEACON_TIMEOUT_MS + 250 ms` later. The turn's own beacon is delivered normally, and `request_outline` **closes that nonce** as soon as it takes the outline (`close_nonce`, `beacon.rs:598-600`), so the late replay meets a nonce that no longer exists. | **`unknown-nonce`** (see §4 — `expired` is the unit-pinned path, unreachable here) | Drive **companion turn 1**, wait for the replay span to land (≈2.25 s after the turn's own report), then read the spans. **This leg yields TWO ingress spans:** the turn's own beacon is **`accepted`** (inside the 2 s window), and the replay lands ≈2.25 s later as **`unknown-nonce`**. Both belong to that one turn — the `accepted` row is the turn working, the `unknown-nonce` row is the control. |

### 2.1 `E-TIMEOUT` needs TWO halves — the confound this row must not repeat

`request_outline` records `reason=timeout` on **any** abandoned wait (`beacon.rs:602-614`), and a
**nonce-rejected** beacon also never fills the entry, so an ordinary turn with a broken nonce carrier
*also* emits a `timeout` span. **A bare `timeout` span therefore does not discriminate a suppressed
reporter from a rejected nonce**, and a row that accepts one is passable by the very defect it is
meant to catch.

The discriminating fact is structural: **a suppressed turn issues no image load at all**, so it
produces **no `unknown-nonce` ingress span for that turn**, while a nonce-broken turn produces one and
*then* times out. `E-TIMEOUT` therefore PASSES only on **both** halves, attributed to the same turn:

1. a `reason=timeout`, `accepted=false` span with `appId=qa3244-beacon-control`, **and**
2. **zero** `reason=unknown-nonce` (and zero `reason=accepted`) spans for that turn.

**Attribution is order-sensitive and must be recorded, not inferred** (`BEACON_TIMEOUT_MS = 2000`, so
the window is tight). The concrete collision to anticipate: **turn 1's replay fires ~2.25 s after
turn 1's report — after turn 1's own 2.0 s wait has ended — which is inside, or just before, turn 2's
window.** So the tester MUST wait for turn 1's replay span to land and record it against turn 1
**before** starting turn 2, and quote the observed timeline. Without that, turn 2's "zero
`unknown-nonce` spans" clause is reddened by turn **1**'s replay and the discriminator is itself
confounded.


### Why wrapping the host reporter is legitimate

The child is untrusted by construction (that is the whole point of ING-1). Wrapping an injected
reporter and holding a host-issued nonce is *exactly* the hostile behaviour the ingress must
survive, and it is the only way a child can present a nonce that is (a) real and (b) no longer
valid. The controls therefore test the hardened ingress, not a fixture trick.

---

## 3. Reading the three mount-time controls apart

All three fire within the same tick. Attribute them by **discriminating inspection of each span**,
never by guessing:

| Check | A-OVERSIZE | B-MISSING-NONCE | C-UNKNOWN-NONCE |
|---|---|---|---|
| `reason` | `oversize` | `missing-nonce` | `unknown-nonce` |
| `accepted` | `false` | `false` | `false` |
| `payloadBytes` | `> 16384` (the raw query length) | `0` (never decoded) | `0` (never decoded) |
| `nonceAgeMs` | `-1` (the control's nonce was never minted) | `-1` (no nonce) | `-1` (unknown nonce) |

The `reason` is the discriminator; `payloadBytes` is the corroborator (only the oversize leg
carries one, because only it gets past the nonce gate to the size check). `nonceAgeMs` is `-1` on
all three — no control here uses a *host-issued* nonce, so an age of `-1` is expected, not a defect.

Three spans with three **distinct** reasons is the expected shape. Two spans with the same reason,
or fewer than three spans, is a **FAIL** — report it as an ingress or fixture defect rather than
re-reading until the numbers look right.

Corroboration (never a substitute): the fixture mirrors every attempt as rendered text —
`<p data-beacon-control="A-OVERSIZE">SENT A-OVERSIZE expect=oversize queryChars=…</p>` and the
`[data-qa3244-beacon-log]` block. The mirrored text is corroboration only; the **authoritative
receipt is the host's own `telemetry_spans` row** (see §6). Never read an installed-`*` window with
`tauri_webview_*`.

---

## 4. The control the fixture CANNOT produce — and why

> **There is no fixture-reachable `expired`.**

A genuinely expired nonce requires a nonce that is **still in the store** and **past its TTL**. The
shipped code makes that state unreachable from a child:

- `BEACON_NONCE_TTL_MS == BEACON_TIMEOUT_MS` (`beacon.rs:91`) — the TTL is not longer than the
  correlation window; it is the same 2 000 ms.
- When the window is served, `request_outline` **closes the nonce** as soon as it takes the
  delivered outline (`close_nonce`, `beacon.rs:598-600`), and on an abandoned wait it closes it too
  (`beacon.rs:602-603`) — the entry is removed, not left to age.
- Therefore a late replay finds **no entry at all** and takes the `UnknownNonce` branch
  (`beacon.rs:370-372`), never the `Expired` branch (`beacon.rs:377-379`).
- `open_nonce_at` also purges expired entries on every mint (`beacon.rs:236`), so an aged entry
  does not survive to be observed either.

The `expired` path is real and covered — by the **unit pin**
`an_expired_nonce_is_dropped` (`beacon.rs:758`, which drives `ingest` with an explicit clock past
`BEACON_NONCE_TTL_MS + 1`). It is **unit-pinned, not fixture-reachable**, and this document states
that rather than letting a control quietly substitute `unknown-nonce` for `expired` and claim the
`expired` leg.

**Consequence for D-REPLAY-AFTER-TTL:** the leg's expectation is **`unknown-nonce`**, and it is the
ONE value the generator catalog and the fixture's mirrored line declare (`expect=unknown-nonce`) —
not an `expired | unknown-nonce` alternation, so a run cannot accept either reading and call it a
pass. The plan's ING-1 wording names "(d) a beacon with an expired nonce"; the observation this
fixture can make is the *replay* half. If a run ever reads `expired`, that is a **finding worth
reporting** — the store would have had to keep a closed nonce past its TTL — not a tolerated
alternative.

### The same honesty, for the other declared-but-unreached reason

`chunk-incomplete` is in the reason vocabulary (`beacon.rs:168`) but **no ingress code path emits
it**: `serve_beacon → ingest` can return only `missing-nonce` / `malformed` / `oversize` /
`unknown-nonce` / `expired` / `accepted`. `BEACON_CHUNK_MAX_BYTES` (`beacon.rs:99`) is declared as
a seam for the GATE-0 outcome ("does the ~11 KB payload need chunking?"). So the plan's ING-1 case
**(e)** — a chunked/partial beacon that never completes — is **not producible by this fixture**
either, and a `chunk-incomplete` receipt cannot be forged by one. If GATE-0 concludes no chunking
is needed, the case is discharged by the single ~11 KB accepted load (`qa3244-dense-url11k` plus
`A-OVERSIZE`'s boundary), and the verdict should say so in those words.

Two further vocabulary members are **producible but not armed** by the fixture, kept here so a later
round can add them without guessing:

- `malformed` — a client can load `?nonce=<open>&d=not-base64` (needs a live nonce → `turn`).
- `accepted` at the boundary — a payload of exactly `BEACON_MAX_BYTES` decoded bytes. Today
  `qa3244-dense-url11k` is *shaped* for ~11 KB (well under 16 KB) and must be ACCEPTED; it is the
  GATE-0 receipt, not a boundary pin.

---

## 5. Pass / fail, stated as one sentence each

- **PASS** — every armed control produced **exactly one** `installed.beacon.ingress` span carrying
  the reason in §2, with `accepted=false` for every rejection, and the mount-time trio is
  distinguishable by the §3 table. `E-TIMEOUT` additionally requires §2.1's **second half**
  (zero `unknown-nonce` / `accepted` spans for that turn): a bare `timeout` span is **not** a PASS.
  `D-REPLAY-AFTER-TTL` requires the pair (`accepted` then `unknown-nonce`) on one turn.
- **FAIL** — a control produced no span; a span carries a different reason; a rejected beacon
  produced a turn input (the thing the ingress exists to prevent); or an over-cap payload is
  buffered and accepted.

A beacon that "did not crash" and a panel that rendered correctly are **observations of nothing**.
Do not record them as the control's outcome.

---

## 6. How the fixture is read (the transport fact)

Every `installed-*` window is **unreachable by `tauri_webview_*`**. `execute_js`, `dom_snapshot`,
`find_element`, `screenshot` and `console` all return `Request timeout after 2000ms` against an
`installed-<id>` windowId — the result channel is ACL-denied inside the child (the #3147 isolation
property, reaffirmed by #3244). That is not a bug to work around.

So this fixture **drives itself on mount** and **mirrors every attempt as rendered text**. The
authoritative receipt for every control is the **host's own `telemetry_spans` row**, never the child's
rendering; the mirrored text is corroboration a human can eyeball, not a gate.

The two turn-coupled controls are armed **by the fixture itself**: a companion turn evaluates the
reporter exactly once, so the wrapper counts report calls and arms the legs on **turn 1 (replay)** and
**turn 2 (suppress)**. **No post-mount gesture is needed, and none is available** — no role holds a
native-input instrument, so a click-armed lever could not be driven at all. The two buttons remain a
**manual override** for a human with native input; the generator's always-on self-check aborts the
build if the schedule vars disappear, so a later edit cannot silently reintroduce a gesture-required
lever.

Read `[data-qa3244-beacon-arms]` to confirm which turn you are on: its first field is
`schedule=replayOnTurn1,suppressOnTurn2 reports=<n>`, and `reports` is the turn counter.

**Never use `tauri_webview_*` to drive or read an `installed-*` window.** The host's `telemetry_spans`
rows are the receipt, and they are what the verdict quotes.

---

## 7. Determinism of the fixture

`fixtures/build-intelligibility-fixtures.mjs` builds `qa3244-beacon-control` from a fixed catalog:
stored zip entries, the 1980-01-01 DOS timestamp, no build-time clock, no randomness. Run it twice
and compare the printed `sha256` column — that comparison is the determinism receipt. There is
deliberately **no committed hash manifest** (the QA Expert holds no shell to derive one, G-460);
see `fixtures/README.md` §4.
