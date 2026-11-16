# Companion Audio Skill Parity — Exploratory

> Unscripted probes for the Tester. **Verification policy: live.** Nothing here is an AC — findings are
> observations, and any error/failure state probed MUST name an in-repo induction lever or be marked non-AC
> (G-300). No filesystem hunts for out-of-repo assets (G-275/G-223/G-009).

## Probes

- [ ] Does the audio request body actually carry `tools` on the wire? Capture the outbound request and compare
      its `tools` array byte-for-byte with the typed body's — is the ONLY difference the last message's
      `input_audio` part (`chat.rs:293-307`)?

- [ ] What happens when the model selects `wireframe` on an audio turn but the arguments are malformed? The
      fail-closed skill validator (`infrastructure/companion/skills.rs:304`) should refuse. **Non-AC** unless a
      lever is named.

- [ ] Drive `llm_chat_with_audio` with an EMPTY `audioBase64` — the suppression refusal
      (`commands.rs:827-834` / `status.rs:828-833`) should fire unchanged. Record the exact error.

- [ ] Drive the SHIPPED dictation gesture with the L2 feed and a preceding typed wireframe request in the SAME
      session — does the audio turn inherit the four-skill offer (it should, via `llm_chat_with_status`)?

- [ ] Does `llm_chat_with_skills` (`skills.rs:433`, no production caller) still behave identically after ST-2
      collapses its constructor? Drive it via the bridge and compare the offer to the typed path.

- [ ] Probe the `stt_start` / `stt_stop` lifecycle during a fed turn for any `llm-status` leak on the legacy
      command (the legacy path should emit none).

- [ ] What is the observable difference, if any, between the legacy command's reply bubble and the shipped
      dictation reply bubble for the same L3 request? (Both should settle with one `llm-done`.)

## Recording

Record each probe's raw observation (IPC receipt, event stream, DOM/screenshot link) and label any probe that
has no in-repo induction lever as **non-AC** rather than scoring it.
