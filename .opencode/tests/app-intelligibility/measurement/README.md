# app-intelligibility — the AC-4 screen-read measurement record (ST-6)

> **Verification policy: `live`.** AC-4 is a genuine runtime measurement: *"the amount of screen Fredo
> can act on is **measured**, not asserted — the small-model limit is a recorded number, not a hope."*
> The record here is filled by a LIVE run; it is **never** hand-authored (G-511).

## What is recorded

One record of how much screen a companion turn actually carried:

| Field | Meaning | Source |
|---|---|---|
| `runIdentity.commit` | the spec-branch tip the tested tree was served at | the run (git) |
| `runIdentity.capturedAt` | when the pair was captured | the run |
| `runIdentity.appId` | the target application of the measured turn | the injection span's `session_id` |
| `runIdentity.injectionSpanId` | the `telemetry_spans` row this was read from | the injection span's `span_id` |
| `outline.utf8Bytes` | UTF-8 bytes of the injected screen outline | the injection span's `simplifiedHtmlBytes` |
| `outline.nodeCount` | nodes the injected outline carries | the injection span's `simplifiedHtmlNodes` |
| `outline.truncated` | whether a cap bit | the outline's `truncated` |
| `screenshot.encodedImageTokens` | the screenshot leg's **encoded** visual-token count (**the AC-4 number**) | the injection span's `imageTokens` (the engine's `MediaPlan::image_tokens`) |
| `capsInForce.maxNodes` / `.maxBytes` | the caps the outline was produced under | `SCREEN_OUTLINE_MAX_NODES` / `SCREEN_OUTLINE_MAX_BYTES` (`apps/ui/src/shared/app-intelligibility/screenOutline.ts`) |

**This is NOT #3234's 1120 visual-token *budget*.** The budget is a ceiling; `encodedImageTokens` is
what the projector *actually encoded* for the run. Do not re-assert 1120 as this number.

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

1. Run **one** companion order turn against a real app (the shipped composer submit is the path). The
   turn emits a `companion.injection` span.
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

   The writer **refuses** a capture missing any measured value — a placeholder never becomes a record.
   Same capture in, same record out (deterministic).

4. Commit the filled `ac4-screen-read-record.json` with the rule's evidence.

`build-ac4-record.mjs --self-check` proves the writer's format and its refusal guard deterministically,
with no live app:

```powershell
node .opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs --self-check
```

## Reconciling the caps to the measured ceiling (ST-6 item 3)

`SCREEN_OUTLINE_MAX_NODES` (120) and `SCREEN_OUTLINE_MAX_BYTES` (8192) are **planning values**. If the
live measurement shows the **node cap truncates a real screen's meaningful nodes** (`outline.truncated`
is `true` while the model still had budget and the byte cap did not bite), adjust the node cap to the
measured ceiling and record **why** — never guess a number.

The `truncated` flag alone is not the trigger: `fitOutlineToBytes` also sets it when the *byte* cap
bites. The trigger is *nodes dropped by the node cap while bytes remained* — read it by comparing
`outline.nodeCount` to `capsInForce.maxNodes` at a screen whose `utf8Bytes` is well under
`capsInForce.maxBytes`.

> **Status of this reconciliation in ST-6 round 1: PENDING.** The developer sandbox cannot launch the
> isolated dev env, so no live run produced a measurement. The caps therefore stay at their planning
> values and the adjustment is owed to the tester's live leg — **no number was guessed** (G-511).
