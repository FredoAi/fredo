/**
 * #2871 ST-1r (REQ-6) — companion reply failure copy.
 *
 * The `llm-error` channel / a non-`still loading` `llm_chat` invoke rejection
 * carries a RAW backend/IPC string (round-1 live evidence: the verbatim
 * `failed to start C:\…\bad-llama-server.exe: spawn …`). That string must NEVER
 * be the primary sentence in the reply bubble — `companionReplyErrorCopy` maps it
 * to one of exactly two curated sentences.
 *
 * Static/product-unit pin (the error path is exercised live by the tester's leg).
 */

import { describe, it, expect } from 'vitest';

import {
  companionReplyErrorCopy,
  COMPANION_REPLY_EMPTY_COPY,
  COMPANION_REPLY_GENERIC_COPY,
  COMPANION_REPLY_NOT_READY_COPY,
} from '@/shared/components/companion/companionReadiness';

describe('#2871 companionReplyErrorCopy — readable reply-failure copy', () => {
  it('pins the exact two curated sentences', () => {
    expect(COMPANION_REPLY_NOT_READY_COPY).toBe(
      "Fredo's model isn't ready yet — open Companion setup to finish loading it.",
    );
    expect(COMPANION_REPLY_GENERIC_COPY).toBe(
      "Fredo couldn't reply just now. Try again in a moment.",
    );
  });

  it('maps a not-ready / still-loading raw string to the not-ready copy', () => {
    expect(companionReplyErrorCopy('model still loading')).toBe(COMPANION_REPLY_NOT_READY_COPY);
    expect(companionReplyErrorCopy('the model is not ready yet')).toBe(
      COMPANION_REPLY_NOT_READY_COPY,
    );
    expect(companionReplyErrorCopy("model isn't ready")).toBe(COMPANION_REPLY_NOT_READY_COPY);
    expect(companionReplyErrorCopy('loading the model, please wait')).toBe(
      COMPANION_REPLY_NOT_READY_COPY,
    );
    expect(companionReplyErrorCopy("the model isn't loaded")).toBe(
      COMPANION_REPLY_NOT_READY_COPY,
    );
  });

  it('maps a spawn/start failure to the generic copy with no raw backend detail', () => {
    const raw =
      'failed to start C:\\Code\\fredo\\.opencode\\tmp\\2871\\bad-llama-server.exe: spawn C:\\Code\\fredo\\.opencode\\tmp\\2871\\bad-llama-server.exe';
    const copy = companionReplyErrorCopy(raw);
    expect(copy).toBe(COMPANION_REPLY_GENERIC_COPY);
    expect(copy).not.toContain('failed to start');
    expect(copy).not.toContain('bad-llama-server');
    expect(copy).not.toBe(raw);
  });

  // #3233 ST-8 (AC-2, Adjudications #2/#3) — an EmptyReply (starvation) detail
  // is a DISTINCT condition and must NOT borrow the transport-failure sentence
  // ("Try again in a moment." is a false retry promise — G-505). The wire
  // carries no code, so the branch matches a substring; this must quote ST-5's
  // `EMPTY_REPLY_DETAIL` byte-for-byte (G-419/G-466) — a reworded literal here
  // would make the case vacuous.
  it('pins the curated empty-reply sentence', () => {
    expect(COMPANION_REPLY_EMPTY_COPY).toBe("Fredo didn't answer that one.");
    expect(COMPANION_REPLY_EMPTY_COPY).not.toContain('Try again');
  });

  it('maps the ST-5 empty-reply detail to the curated empty copy, NOT the generic', () => {
    // Byte-for-byte the landed `EMPTY_REPLY_DETAIL` in
    // apps/tauri/src-tauri/src/applications/llm_server/skills.rs (ST-5 @ 2798b00).
    const st5EmptyReplyDetail =
      'the companion produced no visible reply for this turn; the model may have spent its whole budget reasoning.';
    expect(st5EmptyReplyDetail).toContain('no visible reply');
    const copy = companionReplyErrorCopy(st5EmptyReplyDetail);
    expect(copy).toBe(COMPANION_REPLY_EMPTY_COPY);
    expect(copy).not.toBe(COMPANION_REPLY_GENERIC_COPY);
    expect(copy).not.toContain('Try again');
  });

  it('discriminator control: an empty-ish detail without the phrase still falls to generic', () => {
    // G-509 non-vacuity control — the branch is anchored to ST-5's exact phrase.
    expect(companionReplyErrorCopy('the reply was empty')).toBe(
      COMPANION_REPLY_GENERIC_COPY,
    );
  });

  it('falls back to the generic copy for an empty/unknown raw string', () => {
    expect(companionReplyErrorCopy('')).toBe(COMPANION_REPLY_GENERIC_COPY);
    expect(companionReplyErrorCopy('boom')).toBe(COMPANION_REPLY_GENERIC_COPY);
  });
});
