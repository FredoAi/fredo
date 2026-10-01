# Model-Audio Feasibility on the Managed `llama-server` — ST-0 Spike Record

> **Issue:** #2897 — *Choose how speech is handled: local transcription vs. model audio*.
> **Sub-task:** ST-0 of the #2897 Implementation Plan (`## Triage Plan`), the **gating** spike.
> **Status:** **RECEIPT PENDING — GATE OPEN.** This note records the pinned facts, the exact
> repeatable probe recipe, the decision rule, and the developer-sandbox attempt. It does **not**
> claim a feasible/infeasible verdict (QA F-110 owns the live receipt). Until F-110 records the
> receipts below, ST-3's `input_audio` transport and ST-6's `stt_audio_capability` are UNPROVEN
> and **F-105/F-106 must not be scored** (a delivery PASS on an unrecorded/negative ST-0 is a
> false PASS → round FAIL).
> **Citation convention:** every in-repo claim carries `path:line`; the pinned revision/bytes are
> read from `infrastructure/companion/models.rs`.

---

## 1. The question

Does the **pinned** companion model set —
`unsloth/gemma-4-E2B-it-qat-GGUF` @ revision `66a399f68ddd113b06dff02fca9523e55465d11d`
(`apps/tauri/src-tauri/src/infrastructure/companion/models.rs:43`, `:124-162`) — carry an **audio
encoder** in its multimodal projector, and does the **installed `llama-server` build** accept an
OpenAI-style `input_audio` content part on `POST /v1/chat/completions`?

Sub-questions to record with the receipt: the exact content-part shape, the accepted `format`
values, the **measured per-input ceiling** (the value ST-5's `MAX_AUDIO_CLIP_MS` is set from), and
the observed model behavior (answers directly vs. transcribes internally — REQ-3's no-transcript
rule holds either way).

## 2. Pinned facts (in-repo, no live server required)

| Fact | Value | Source |
|---|---|---|
| Model repo | `unsloth/gemma-4-E2B-it-qat-GGUF` | `infrastructure/companion/models.rs:132`, `:143`, `:154` |
| Revision | `66a399f68ddd113b06dff02fca9523e55465d11d` | `models.rs:43` |
| Layout subdir | `gemma-4-e2b-it-qat` | `models.rs:40` |
| Main model | `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf`, 2 620 370 976 B, sha `e5310072…` | `models.rs:128-138` |
| Multimodal projector | `mmproj-BF16.gguf`, **986 833 728 B**, sha `38b33846f56426cd650e0e574d78de125abdfcedf35c0d7f6929f6ffe26efe02` | `models.rs:139-149` |
| Projector registration | manifest id **`vision`** (not `audio`) | `models.rs:140` |
| Projector launch wiring | attached unconditionally as `--mmproj` | `features/llm_server/config.rs:172`; resolved from manifest id `vision` at `features/llm_server/commands.rs:306-312` |
| Renderer today | `render_messages` emits only `{role,content}` strings and (with an image) `[{type:text},{type:image_url}]` | `features/llm_server/chat.rs:237-264` |
| Audio flag / audio projector in `apps/` | **none** (grep-verified by the Architect) | plan `## Software Architect` §Domain Model 4 |
| `/v1/models` live evidence already recorded | `Gemma-4-E2B`, "completion+multimodal", HTTP 200 — **vision**, no audio claim | `.opencode/tests/llama-setup/functional.md:668` |

**Variant-mismatch guard.** The backlog cited `unsloth/gemma-4-E2B-it-GGUF`; Fredo pins the
**`-qat-`** set. A different model/projector file is a **manifest change = PO amendment**, never a
triage substitution. ST-0 records its receipts against the pinned `-qat-` revision only.

## 3. In-repo prior (what exists today)

- The managed server is launched from the single argv builder
  (`features/llm_server/config.rs:155-193`) with the projector attached as `--mmproj`
  (`config.rs:172`).
- The only multimodal path proven live today is **vision**: `capture_screen_region` +
  `llm_chat_with_image` (`.opencode/tests/companion/functional.md:116-118`).
- No `input_audio` part, no `--audio*` flag, and no audio probe exist anywhere in `apps/`.
- ST-6 (not ST-0) owns the `stt_audio_capability` command; ST-3 owns the
  `llm_chat_with_audio` transport. ST-0's product change is **zero** — it only records receipts.

## 4. Repeatable probe recipe (how F-110 obtains the live receipt)

All steps are local/loopback and read-only except the final POST, which asks the model to interpret
a synthetic in-repo clip; no recorded-media asset is used (G-172/G-009).

### 4.0 Prerequisites

1. App served at the `spec/2897` tip:
   `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2897`.
2. The pinned model set installed and the **managed** `llama-server` running (Companion setup).
   It binds loopback only. Resolve the bound port in this order (same rule as the app,
   `features/llm_server/mod.rs:34-37`, `probe.rs:369-378`):
   `llama_server_active_port` → `llama_server_port` → default **8080**.
   Throughout, `FREDO_LLAMA_BASE` = `http://127.0.0.1:<port>`.
3. Generate the deterministic clip (no recorded speech; synthetic 16 kHz mono 16-bit PCM):
   `node .opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs`
   → `.opencode/tests/voice-dictation/fixtures/dictation-phrase-16k-mono.wav` (1.6 s).
   The over-limit ceiling leg needs ST-9's duration variant (`--seconds 31`).

### 4.1 Read `/props` and `/v1/models`

```powershell
curl.exe -s http://127.0.0.1:8080/props
curl.exe -s http://127.0.0.1:8080/v1/models
```

Record both bodies **verbatim**. `/props` is scanned for any key whose name mentions `mmproj`,
`projector`, or `audio` (the ST-0 seam records whichever the build reports; it never asserts a key
a different build may lack — see §6).

### 4.2 Live `input_audio` request (the authoritative receipt)

Exact content-part shape (architect contract, `## API Contracts & Data Models`):

```json
{
  "type": "input_audio",
  "input_audio": { "data": "<base64 wav>", "format": "wav" }
}
```

Exact request body (system turn + ONE user turn whose content IS the audio part array; **no
transcript text accompanies model audio — REQ-3**):

```json
{
  "messages": [
    { "role": "system", "content": "You are Fredo, a desktop companion. Respond to the user's message." },
    {
      "role": "user",
      "content": [
        { "type": "input_audio", "input_audio": { "data": "<base64 wav>", "format": "wav" } }
      ]
    }
  ],
  "stream": true,
  "max_tokens": 1024
}
```

A copy-pasteable receiver (scratch; regenerate per run — this is **not** committed):

```js
// .opencode/tmp/2897/st0-receipt.mjs
import { readFileSync, writeFileSync } from 'node:fs'
const base = process.env.FREDO_LLAMA_BASE ?? 'http://127.0.0.1:8080'
const wav = readFileSync('.opencode/tests/voice-dictation/fixtures/dictation-phrase-16k-mono.wav')
const propsRes = await fetch(base + '/props')
const props = await propsRes.text()
const modelsRes = await fetch(base + '/v1/models')
const models = await modelsRes.text()
const audioRes = await fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: "You are Fredo, a desktop companion. Respond to the user's message." },
      { role: 'user', content: [ { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } } ] },
    ],
    stream: true,
    max_tokens: 1024,
  }),
})
const audioBody = await audioRes.text()
const receipt = {
  url: base,
  propsStatus: propsRes.status,
  props,
  modelsStatus: modelsRes.status,
  models,
  audioStatus: audioRes.status,
  audioSse: audioBody,
}
writeFileSync('.opencode/tmp/2897/st0-receipt.json', JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt, null, 2))
```

Try each candidate `format` in turn (`wav` first, then `mp3`) until one is accepted, and record
**which** value the server accepted. If every candidate is rejected with HTTP 4xx, that is the
negative receipt (see §5).

### 4.3 Measured per-input ceiling (the `MAX_AUDIO_CLIP_MS` source)

Once ST-9's parameterized generator ships, send progressively longer clips (e.g. 5 s, 15 s, 25 s,
30 s, 31 s, 60 s) and record the **largest duration the server 2xx-accepts and answers**. The
smallest duration that is rejected (or truncated) bounds the ceiling. Record duration, byte
size, base64 length, HTTP status, and the reply for each step. ST-5 sets `MAX_AUDIO_CLIP_MS` from
**this** number — no constant is claimed here.

### 4.4 Model-behavior observation

From the accepted reply, record whether the model **answered directly** in the companion chat
stream (expected: `llm-token` … `llm-done`) or emitted a transcription of the audio. The synthetic
fixture is **not speech** (`generate-dictation-phrase.mjs` header), so the reply content alone
cannot settle "transcribes vs. answers" semantically — record the raw reply verbatim and note the
limitation; a real-speech confirmation is out of scope for this repo (no recorded asset exists).

## 5. Decision rule

| Receipt | Verdict | Action |
|---|---|---|
| Audio POST returns **HTTP 2xx** and the stream begins a completion (`data:` deltas, `[DONE]` or `finish_reason`) | **(a) FEASIBLE** | Set `MAX_AUDIO_CLIP_MS` from §4.3; ST-3/ST-6 proceed |
| Audio POST returns **HTTP 4xx** for every candidate `format`, or the server/build demonstrably has no audio path | **(b) INFEASIBLE** | **STOP**: do not fabricate transport; loop to Phase 2 / PO amendment with these receipts; F-105/F-106 are **BLOCKED** (not FAIL, not PASS); score F-107 (degradation) instead |
| Server unreachable / HTTP 5xx / ambiguous body | **UNRESOLVED** | Not a verdict — re-run §4 when the managed server is up |

`/props` and `/v1/models` are **supporting** evidence only. A model id or a projector file name is
**never** proof of audio support (QA F-110: `stt_audio_capability` must not infer capability from a
model name). The live POST is the only authoritative signal.

## 6. What ST-0 ships in the repo (no product behavior)

`apps/tauri/src-tauri/src/features/llm_server/probe.rs` gains an **additive, test-gated** seam
(`#[cfg(test)] mod audio_feasibility`) that:

- shapes the exact `input_audio` content part and probe body
  (`input_audio_content_part`, `build_audio_probe_body`);
- validates the shaped body, including the REQ-3 no-transcript invariant
  (`validate_audio_probe_body`);
- lists the candidate `format` attempt order (`PROBE_INPUT_AUDIO_FORMATS` — `wav`, `mp3`);
- parses `/v1/models` (`models_from_v1_models`) and scans `/props` for projector/audio markers
  without asserting build-specific keys (`props_audio_markers`);
- classifies the live response and applies the §5 decision rule
  (`classify_audio_probe_response`, `audio_feasibility`).

It is **not registered** as a command and changes no runtime behavior (ST-0 non-goal). `cargo test`
pins the shape so the receipt is interpreted consistently; the live invocation is §4.

**Layer confinement.** The probe lives in `features/llm_server/` (which already owns `reqwest`);
nothing network- or process-related enters `infrastructure/voice/`
(`voice_invariants.rs:38-46`, `:216-227`).

**Do NOT alter** the pinned manifest (`models.rs`) or the launch args (`config.rs`) — a different
projector/model file is a PO amendment.

## 7. Receipts log

| # | Receipt | How | Recorded value |
|---|---|---|---|
| R1 | `/props` body (verbatim) | §4.1 | **PENDING (F-110)** |
| R2 | `/v1/models` body (verbatim) | §4.1 | **PENDING (F-110)** |
| R3 | Live `input_audio` POST — HTTP status + SSE + accepted `format` | §4.2 | **PENDING (F-110)** |
| R4 | Measured per-input ceiling (duration / bytes / status) | §4.3 | **PENDING (F-110 + ST-9 generator)** |
| R5 | Observed model behavior (raw reply) | §4.4 | **PENDING (F-110)** |

### Developer-sandbox attempt (this dispatch)

The developer sandbox can run `node` but cannot start the app/webview or the **managed**
`llama-server` (`dev-env.ps1` is not allowlisted; `tauri_*` is denied; starting `llama-server`
ad-hoc is forbidden by `AGENTS.md`). A bounded, read-only loopback attempt was made against the
default managed port:

```
node .opencode/tmp/2897/probe-managed-server.mjs
→ GET http://127.0.0.1:8080/props      : TypeError: fetch failed (cause: ECONNREFUSED)
→ GET http://127.0.0.1:8080/v1/models  : TypeError: fetch failed (cause: ECONNREFUSED)
```

**No managed server was listening**, so no live receipt could be produced in the developer sandbox.
The live receipt is therefore **assigned to the Tester's F-110**, which drives the recipe in §4
against the app-served managed server. The missing sandbox tool is the dev-environment launcher
(`.opencode/scripts/dev-env.ps1 -Action Up`, tester-side only).

## 8. Consequences / handoff

- **ST-3** (`llm_chat_with_audio` + `input_audio` renderer) and **ST-6** (`stt_audio_capability`)
  must not be scored PASS until F-110 records R1–R5.
- **ST-5** sets `MAX_AUDIO_CLIP_MS` from R4; the plan's provisional `30_000` is a placeholder, not
  a measured value.
- If R3 is a 4xx rejection, the spec **loops back to Phase 2 / PO amendment**; the recorded
  receipts are the reason. No silent substitution of the pinned model/projector.
- The model variant cited by the backlog (`unsloth/gemma-4-E2B-it-GGUF`) differs from the pinned
  `-qat-` set; a switch is a PO amendment, never a triage/implementation change.
