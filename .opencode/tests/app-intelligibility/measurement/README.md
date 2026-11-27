# app-intelligibility — the AC-4 screen-read measurement record (ST-6)

> **Verification policy: `live`.** AC-4 is a genuine runtime measurement: *"the amount of screen Fredo
> can act on is **measured**, not asserted — the small-model limit is a recorded number, not a hope."*
> The record here is filled by a LIVE run; it is **never** hand-authored (G-511).

## What is recorded — and what the AC-4 NUMBER is (schema v2)

The **AC-4 number is `outline.utf8Bytes`** — the outline leg's measured size, which is a real quantity
that **varies with the screen**. It is carried with the node count, the truncation flag, and two
**derived** fields (`bytesHeadroom`, `bindingCap`), so the pair's screen-read limit re-reads as *"N bytes
/ M nodes of an 8192-byte / 120-node budget, and this cap bound first"*.

| Field | Meaning | Source |
|---|---|---|
| `runIdentity.commit` | the spec-branch tip the tested tree was served at | the run (git) |
| `runIdentity.capturedAt` | when the pair was captured | the run |
| `runIdentity.appId` | the target application / ladder rung of the measured turn | the injection span's `session_id` |
| `runIdentity.injectionSpanId` | the `telemetry_spans` row this was read from | the injection span's `span_id` |
| **`outline.utf8Bytes`** | **THE AC-4 NUMBER** — UTF-8 bytes of the outline the turn carried | the injection span's `simplifiedHtmlBytes` |
| `outline.nodeCount` | nodes the injected outline carries | the injection span's `simplifiedHtmlNodes` |
| `outline.truncated` | whether a cap bit the outline | the injection span's **`simplifiedHtmlTruncated`** (a required boolean on the span) |
| `outline.bytesHeadroom` | **DERIVED** — bytes left under the byte cap (clamped at 0) | `capsInForce.maxBytes − outline.utf8Bytes` |
| `outline.bindingCap` | **DERIVED** — which cap bound first: `bytes` \| `nodes` \| `none` | the one rule below |
| `screenshot.encodedImageTokens` | the screenshot leg's encoded visual-token count — **RIG CONTEXT for NFR-1, NOT the AC-4 number** | the injection span's `imageTokens` (the engine's `MediaPlan::image_tokens`) |
| `capsInForce.maxNodes` / `.maxBytes` | the caps the outline was produced under | `SCREEN_OUTLINE_MAX_NODES` / `SCREEN_OUTLINE_MAX_BYTES` (`apps/ui/src/shared/app-intelligibility/screenOutline.ts`) |

### The `bindingCap` rule (stated once, in `measurement.ts`)

`none` when `!truncated`; `nodes` when `truncated && nodeCount >= capsInForce.maxNodes`; otherwise
`bytes`. The `bytes` case is the meaningful one: `fitOutlineToBytes` trimmed nodes below the node cap, so
the byte fitter was the last binder — and it is the cap that limited what crossed. The product module
(`deriveBindingCap`) is the single authority; the writer restates the same rule and its `--self-check`
pins all three branches.

### Why `encodedImageTokens` is NOT the number (the v1 premise, retired)

`image_tokens` is the sum of the multimodal **image chunks'** token counts for one **fixed-size window
capture**, so it is a constant of *(projector, image dimensions)* — **density-invariant by construction**.
A live round observed `840` on **every** turn regardless of screen (11 outline nodes and 68 alike), so it
cannot express a screen-read limit even with a perfectly working uplink. It is **retained** (deleting it
would remove the only recorded bound on the image leg) and **demoted** to rig-cost context for NFR-1.

**The 1120 projector ceiling** (`multimodal.rs`) is not copied into the record — a second authority for
one number is a drift waiting to happen (G-466). It is stated here, in prose, as context only.

**The v1 shape is REFUSED.** `parseScreenReadRecord` throws on `schemaVersion !== 2`, so the retired
premise cannot be re-blessed by a stale committed file.

## The path

```
.opencode/tests/app-intelligibility/measurement/ac4-screen-read-record.json   <- the record (committed)
.opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs          <- the writer
.opencode/tests/app-intelligibility/measurement/capture.template.json         <- the capture's shape
```

`ac4-screen-read-record.json` ships as a **slot** with `"status": "awaiting-live-run"` and `null`
numbers — a placeholder is not a measurement, so the parser
(`parseScreenReadRecord`, `apps/ui/src/shared/app-intelligibility/measurement.ts`) **refuses** it until
a real run fills it.

## The deterministic invocation (the tester's AC-4 live leg)

1. Run **one** companion order turn against a real app / ladder rung (the shipped composer submit is the
   path). The turn emits a `companion.injection` span.
2. Read the turn's injection record back:

   ```sql
   SELECT span_id, session_id, attributes_json
     FROM telemetry_spans
    WHERE span_name = 'companion.injection'
    ORDER BY start_time_ns DESC
    LIMIT 1;
   ```

3. Assemble a **capture** in the shape of `capture.template.json` (the span's fields + the run
   identity + the caps in force at `commit`), then write the record:

   ```powershell
   node .opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs --capture <capture.json>
   ```

   The writer **refuses** a capture missing any measured value (the image-token count, the truncation
   flag, or any run-identity field) and refuses a capture whose outline claims to exceed a cap — a
   placeholder, or a claim an over-cap outline crossed, never becomes a record. Same capture in, same
   record out (deterministic).

4. Commit the filled `ac4-screen-read-record.json` with the rule's evidence.

**Which run fills it:** the **densest rung the run drives** (its `appId` is the rung id, e.g.
`qa3244-dense-160`), captured in the same round that drives the ladder. If no rung makes a cap bite, the
record still carries the densest rung's measured number with `bindingCap: "none"` and the suite records
that finding — a measured amount that never reached a cap is a finding, not a placeholder. **Do not**
average rungs and **do not** record a pseudo-limit the run did not observe.

`build-ac4-record.mjs --self-check` proves the writer's format, its derivations and its refusal guards
deterministically, with no live app:

```powershell
node .opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs --self-check
```

The self-check covers: a capture with **no** `outline.truncated` is refused; a capture with no engine
image-token count is refused; an over-cap capture is refused; all three `bindingCap` branches; and **the
discriminator** — two captures with an **identical** `encodedImageTokens` and different `utf8Bytes`
produce different AC-4 numbers.

> **What the self-check does NOT prove.** It is deterministic and honest, but it makes a fake **visible**,
> not **impossible** (G-511). The guarantee that the committed number came from a real run is the run's
> own span table, quoted in the verdict.

## Reconciling the caps to the measured ceiling (ST-6 item 3)

`SCREEN_OUTLINE_MAX_NODES` (120) and `SCREEN_OUTLINE_MAX_BYTES` (8192) are **planning values**. If the
live measurement shows the **node cap truncates a real screen's meaningful nodes**, adjust the node cap to
the measured ceiling and record **why** — never guess a number.

The rule is now **readable** rather than inferred: `bindingCap` **is** the trigger signal.
`bindingCap: "nodes"` with a large `bytesHeadroom` means the node cap bound while bytes remained, which is
the case worth revisiting. The default (no change to 120/8192) stands unless a run shows exactly that.

> **Status of this reconciliation so far: PENDING.** No live run has yet produced a measurement (the
> density ladder is installed-only and the uplink could not correlate until this rework). The caps
> therefore stay at their planning values and the adjustment is owed to the tester's live leg — **no
> number was guessed** (G-511).
