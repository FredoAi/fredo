/**
 * CompanionListeningBubble — Spec #2877 ST-6 (DR-8 / DR-10 / DR-11).
 *
 * The companion-origin listening affordance: the AC5 "visible capture" surface
 * for PO case 1. A companion-origin session is started by the launcher window's
 * context-dependent Ctrl+Space cascade while Fredo may be rendered by ANY window
 * (the home seat in the launcher window, or the away overlay in the terminal
 * window). Without a surface that renders wherever Fredo renders, the capture
 * would be headless (AC5 / R-5.3).
 *
 * `CompanionEntity` is the shared body for BOTH surfaces, so it renders this
 * bubble and the listening state is visible wherever Fredo is. The bubble
 * subscribes through the shared ST-3 `useVoiceDictation` client (never raw Tauri
 * events) and shows itself ONLY for a `companion`-origin session — the launcher
 * bar cue is the `launcher`-origin indicator (R-5.3: exactly ONE indicator per
 * session, routed by `stt:state.origin`; never both).
 *
 * Surface content (DR-8 / UI/UX C6):
 *   • a STATIC (non-animated) 6px accent dot + `Listening…`;
 *   • a clamped transcript preview (last ~2 visual lines, `var(--text-subtle)`);
 *   • the hearing-nothing hint after `HEARING_NOTHING_MS` of silence;
 *   • a `Stop` control (`aria-label="Stop listening"`) that invokes `stt_stop`
 *     through the shared client (backend-authoritative and idempotent — the
 *     resulting `listening:false` state clears every window's indicator);
 *   • a `role="alert"` curated error state for a companion-origin start/engine
 *     failure (the raw backend detail is never the primary sentence — DR-11).
 *
 * The visible preview is ordinary DOM text (never `aria-live`) so it cannot
 * double-announce; the transcript announcer lives on the launcher bar (ST-5).
 *
 * Token/size contract (DR-12 / G-146): colors are theme CSS vars / Chakra tokens
 * only, every alpha uses the shared `tint()` helper (never an alpha-append onto
 * a var() reference), and all geometry is stated as CSS unit strings.
 */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Box, Text } from '@chakra-ui/react';

import { tint } from '../../utils/colorTint';
import { useVoiceDictation } from '../../hooks/useVoiceDictation';
import type { VoiceErrorCode } from '../../hooks/useVoiceDictation';
import { AVATAR_SM } from '../fredo-avatar';

/** DR-11 — the "we haven't heard anything yet" hint, after this silent stretch.
 *  Mirrors the launcher bar (`LauncherCommandBar.HEARING_NOTHING_MS`); kept local
 *  so this shared surface never imports a feature module (layering + cycle). */
export const HEARING_NOTHING_MS = 6000;
export const HEARING_NOTHING_COPY =
  "Listening… we haven't heard anything yet — check that your microphone isn't muted.";

/** DR-11 — curated, actionable copy for a failed companion-origin start.
 *  The typed `SttErrorCode` is the only primary key; a raw IPC detail is never
 *  the primary sentence. Mirrors the launcher's copy (`voiceStartErrorCopy`) —
 *  duplicated locally to keep this shared surface free of a shared→feature
 *  import (which would also close an import cycle through `CompanionEntity`). */
export function companionVoiceErrorCopy(code: VoiceErrorCode | null): string | null {
  switch (code) {
    case 'permissionDenied':
      return 'Microphone access is blocked — allow it in Windows Settings → Privacy → Microphone, then try again.';
    case 'noDevice':
      return 'No microphone found. Connect a microphone, then try again.';
    case 'modelMissing':
    case 'modelCorrupt':
      return "Voice input model isn't ready — open Companion settings to install it.";
    case 'engineStartFailed':
      return "Voice input couldn't start. Try again; if it persists, re-check the model in Companion settings.";
    case 'disabled':
      return 'Voice input is off. Turn it on in Companion settings.';
    case 'alreadyListening':
      return 'Voice input is already listening.';
    case 'internal':
      return 'Voice input hit an unexpected problem. Try again.';
    default:
      return null;
  }
}

/** Approximate tail kept for the preview — roughly two 12px lines in 260px. */
const PREVIEW_TAIL_CHARS = 160;

/** Keep the NEWEST text visible (the live partial grows at the end). */
function tailPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_TAIL_CHARS) return trimmed;
  return `…${trimmed.slice(trimmed.length - PREVIEW_TAIL_CHARS).trimStart()}`;
}

/** Filled square Stop glyph (currentColor) — mirrors the launcher Stop control. */
function StopGlyph() {
  return (
    <Box
      as="span"
      width="10px"
      height="10px"
      borderRadius="2px"
      bg="currentColor"
      aria-hidden="true"
    />
  );
}

export interface CompanionListeningBubbleProps {
  /** Which seat the bubble is anchored to (the entity knows its surface). */
  surface: 'seat' | 'overlay';
  /** `overlay` anchor: the avatar's top-left viewport position (ignored by seat). */
  x?: number;
  y?: number;
  /** `overlay` anchor: the avatar's rendered width, used to centre the bubble. */
  anchorWidth?: number;
}

export function CompanionListeningBubble({
  surface,
  x = 0,
  y = 0,
  anchorWidth = AVATAR_SM.width,
}: CompanionListeningBubbleProps) {
  const { listening, origin, errorCode, liveText, stop } = useVoiceDictation();

  // R-5.3 — a companion-origin session (or its failure) is the ONLY state this
  // bubble owns; a launcher-origin session is the bar cue's (never both).
  const isCompanionSession = origin === 'companion';
  const errorMessage = isCompanionSession ? companionVoiceErrorCopy(errorCode) : null;
  const showError = !listening && errorMessage !== null;
  const visible = isCompanionSession && (listening || showError);

  const previewText = listening ? tailPreview(liveText) : '';

  // DR-11 — the hearing-nothing hint (polite, non-blocking, never auto-stops):
  // shown only after `HEARING_NOTHING_MS` of a live session with no text yet; it
  // clears the moment any partial arrives.
  const [hearingNothing, setHearingNothing] = useState(false);
  useEffect(() => {
    if (!listening || previewText !== '') {
      setHearingNothing(false);
      return;
    }
    const timer = setTimeout(() => setHearingNothing(true), HEARING_NOTHING_MS);
    return () => clearTimeout(timer);
  }, [listening, previewText]);

  if (!visible) return null;

  // Seat: absolutely anchored above the (position: relative) seat slot — no
  // layout participation (mirrors the entity's SpeechBubble anchor). Overlay:
  // viewport-fixed above the avatar at the host-supplied destination.
  const anchor: CSSProperties =
    surface === 'seat'
      ? {
          position: 'absolute',
          bottom: 'calc(100% + 10px)',
          left: '50%',
          transform: 'translateX(-50%)',
        }
      : {
          position: 'fixed',
          left: x + anchorWidth / 2,
          top: y - 10,
          transform: 'translate(-50%, -100%)',
        };

  return (
    <Box
      data-testid="companion-listening-bubble"
      style={anchor}
      bg="var(--card-bg)"
      border="1px solid"
      borderColor={tint('var(--accent-primary)', 30)}
      borderRadius="lg"
      p="10px"
      maxWidth="260px"
      boxShadow={`0 4px 24px ${tint('var(--border-color)', 45)}`}
      zIndex={101}
      pointerEvents="auto"
    >
      {showError ? (
        <Box>
          <Text fontSize="xs" fontWeight="600" color="var(--text-primary)" lineHeight="16px">
            Voice input didn&apos;t start
          </Text>
          <Text
            data-testid="companion-listening-error"
            role="alert"
            mt="4px"
            fontSize="xs"
            color="var(--status-error)"
            lineHeight="16px"
          >
            {errorMessage}
          </Text>
        </Box>
      ) : (
        <>
          <Box display="flex" alignItems="center" gap="6px">
            {/* FROZEN static accent dot — no pulse/loop (reduced-motion safe). */}
            <Box
              as="span"
              data-testid="companion-listening-dot"
              width="6px"
              height="6px"
              borderRadius="full"
              bg="accent.default"
              flexShrink={0}
            />
            <Text fontSize="xs" fontWeight="600" color="var(--text-primary)" lineHeight="16px">
              Listening…
            </Text>
          </Box>
          {previewText && (
            // Ordinary DOM text (NEVER aria-live) — the transcript announcer lives
            // on the launcher bar, so the visible preview cannot double-announce.
            <Text
              data-testid="companion-listening-preview"
              mt="4px"
              fontSize="xs"
              color="var(--text-subtle)"
              lineHeight="16px"
              css={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {previewText}
            </Text>
          )}
          {hearingNothing && (
            <Text
              data-testid="companion-listening-status"
              mt="4px"
              fontSize="xs"
              color="var(--text-subtle)"
              lineHeight="16px"
            >
              {HEARING_NOTHING_COPY}
            </Text>
          )}
          <Box display="flex" justifyContent="flex-end" mt="6px">
            <Box
              as="button"
              data-testid="companion-listening-stop"
              aria-label="Stop listening"
              onClick={() => {
                void stop();
              }}
              onMouseDown={(e) => e.preventDefault()}
              display="flex"
              alignItems="center"
              justifyContent="center"
              height="24px"
              width="24px"
              borderRadius="4px"
              color="var(--text-secondary)"
              cursor="pointer"
              _hover={{ color: 'accent.default' }}
              css={{
                '&:focus-visible': {
                  outline: '2px solid var(--accent-primary)',
                  outlineOffset: '2px',
                },
              }}
            >
              <StopGlyph />
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
}
