/**
 * Spec #3120 (rework) ST-2 — the teleport-attached instruction composer.
 *
 * The ONE conversation surface: a compact card that opens adjacent to Fredo on
 * the teleport-in settle, auto-focuses its input, grounds the turn on the app it
 * is aimed at, and submits through the existing companion `ask` (the same
 * skill-aware dispatch funnel — never a second route). It is deliberately NOT a
 * chat panel: no transcript, no history, no persistence, and it adds NO
 * `aria-live` region and NO document-level key listener.
 *
 * Placement is the pure `computeComposerPlacement` decision (ranked
 * `above > right > left`, never `below`), so the card can never cover Fredo or
 * the visible SpeechBubble. The two bound QA hooks on the root
 * (`data-composer-placement`, `data-composer-clearance`) expose the measured
 * decision (F-166).
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box, Icon, Text, chakra } from '@chakra-ui/react';
import { LuArrowUp, LuX } from 'react-icons/lu';

import { getApplications } from '../../../applications/applicationRegistry';
import { resolveNamedAppMention } from '../../companion/composerTarget';
import type { CompanionTurnTarget } from '../../companion/composerTarget';
import type { ReplyAvatarRect, ReplyRect } from './replySurfaceLayout';
import {
  COMPOSER_H,
  COMPOSER_MAX_H,
  COMPOSER_W,
  REPLY_MARGIN,
  computeComposerPlacement,
  deriveAwayRegion,
} from './replySurfaceLayout';
import { AVATAR_SM } from '../fredo-avatar';

// ── Bound DOM / copy (Architect's names block — consumed verbatim) ───────────

export const COMPANION_COMPOSER_TESTID = 'fredo-companion-composer';
export const COMPANION_COMPOSER_INPUT_TESTID = 'fredo-companion-composer-input';
export const COMPANION_COMPOSER_SUBMIT_TESTID = 'fredo-companion-composer-submit';
export const COMPANION_COMPOSER_TARGET_TESTID = 'fredo-companion-composer-target';
export const COMPANION_COMPOSER_DISMISS_TESTID = 'fredo-companion-composer-dismiss';

export const COMPANION_COMPOSER_ARIA_LABEL = 'Tell Fredo what to change';
export const COMPANION_COMPOSER_INPUT_LABEL = 'Instruction for Fredo';
export const COMPANION_COMPOSER_PLACEHOLDER = 'Tell Fredo what to change…';
export const COMPANION_COMPOSER_SUBMIT_LABEL = 'Send instruction';
export const COMPANION_COMPOSER_DISMISS_LABEL = 'Close instruction box';
export const COMPANION_COMPOSER_TARGET_PREFIX = 'for ';
export const COMPANION_COMPOSER_NO_TARGET_COPY = 'No app in front of Fredo';

/** Inner padding on the composer card (the textarea takes the rest). */
const COMPOSER_PAD = 4;

export interface CompanionComposerProps {
  readonly surface: 'seat' | 'overlay';
  readonly avatarRect: ReplyAvatarRect | null;
  /** The visible SpeechBubble rect (viewport px), or `null`. */
  readonly avoidRect: ReplyRect | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly target: CompanionTurnTarget;
  readonly onSubmit: (text: string) => void;
  readonly onDismiss: () => void;
}

/**
 * A synthetic footprint used only until the entity's first avatar measurement
 * lands (one commit). It sits near the bottom-right so the first paint is
 * on-screen and clear of the (equally unmeasured) avatar.
 */
function fallbackAvatar(viewport: { readonly width: number; readonly height: number }): ReplyAvatarRect {
  const width = AVATAR_SM.width;
  const height = AVATAR_SM.height;
  const left = Math.max(REPLY_MARGIN, viewport.width - width - REPLY_MARGIN * 2);
  const top = Math.max(REPLY_MARGIN, viewport.height - height - REPLY_MARGIN * 2);
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function resolveTarget(target: CompanionTurnTarget, text: string): { appId: string | null; copy: string } {
  // A named app in the instruction overrides the default for the displayed chip
  // exactly as the submit path resolves it (both consume the ONE pure matcher).
  const apps = getApplications().map((application) => ({
    id: application.id,
    name: application.name,
    showable: application.showable,
  }));
  const namedId = resolveNamedAppMention(text, apps);
  const appId = namedId ?? target.appId;
  const appName = namedId
    ? (apps.find((application) => application.id === namedId)?.name ?? null)
    : target.appName;
  if (appId === null || appName === null || appName.trim() === '') {
    return { appId, copy: COMPANION_COMPOSER_NO_TARGET_COPY };
  }
  return { appId, copy: `${COMPANION_COMPOSER_TARGET_PREFIX}${appName}` };
}

/**
 * Return focus to the landing application when the element focused before the
 * composer opened is gone. NEVER `body`: the target app frame, then any app
 * root, then the document root (a focusable, non-body fallback).
 */
function focusLandingApp(appId: string | null): void {
  if (typeof document === 'undefined') return;
  const escaped = appId === null ? null : appId.replace(/"/g, '\\"');
  const target = escaped === null
    ? null
    : document.querySelector<HTMLElement>(`[data-fredo-app-id="${escaped}"]`);
  const root = target ?? document.querySelector<HTMLElement>('[data-fredo-app-id]');
  const element: HTMLElement = root ?? document.documentElement;
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus();
}

export function CompanionComposer(props: CompanionComposerProps): React.ReactElement {
  const { surface, avatarRect, avoidRect, viewport, target, onSubmit, onDismiss } = props;

  const [value, setValue] = useState('');
  // The textarea's content height (excludes the card padding). Resting 32 px so
  // the whole card is COMPOSER_H (40 px) before any input; capped so the card is
  // at most COMPOSER_MAX_H (96 px) and then scrolls (UIUX-D3).
  const [textHeight, setTextHeight] = useState(COMPOSER_H - COMPOSER_PAD * 2);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const preOpenFocusRef = useRef<HTMLElement | null>(null);

  // Capture the pre-open focus and open ⇒ focus in a LAYOUT effect (no click, no
  // rAF chain, no effect loop). The capture happens BEFORE the input is focused,
  // so Esc can return focus to the element the user was on.
  useLayoutEffect(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    preOpenFocusRef.current =
      active instanceof HTMLElement &&
      active !== inputRef.current &&
      active !== document.body &&
      active !== document.documentElement
        ? active
        : null;
    inputRef.current?.focus();
  }, []);

  // Auto-grow: measure the wrapped content height and apply the capped size.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const previous = el.style.height;
    el.style.height = 'auto';
    const natural = el.scrollHeight;
    el.style.height = previous;
    const next = Math.max(
      COMPOSER_H - COMPOSER_PAD * 2,
      Math.min(COMPOSER_MAX_H - COMPOSER_PAD * 2, natural),
    );
    setTextHeight((current) => (current === next ? current : next));
  }, [value]);

  const boxHeight = textHeight + COMPOSER_PAD * 2;
  const avatar = avatarRect ?? fallbackAvatar(viewport);
  const placement = computeComposerPlacement({
    avatar,
    region: deriveAwayRegion(null, viewport),
    viewport,
    size: { width: COMPOSER_W, height: boxHeight },
    avoid: avoidRect,
  });

  const submit = (): void => {
    const text = value.trim();
    if (text === '') {
      // Empty submit is a synchronous no-op — focus stays in the instruction box.
      inputRef.current?.focus();
      return;
    }
    onSubmit(text);
    setValue('');
    inputRef.current?.focus();
  };

  const resolvedTarget = resolveTarget(target, value);

  const dismiss = (): void => {
    const previous = preOpenFocusRef.current;
    if (
      previous !== null &&
      previous !== inputRef.current &&
      previous.isConnected &&
      typeof previous.focus === 'function'
    ) {
      previous.focus();
    } else {
      // The landing app frame / an app root / the document root — NEVER `body`.
      focusLandingApp(resolvedTarget.appId);
    }
    onDismiss();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const targetCopy = resolvedTarget.copy;

  return (
    <Box
      role="group"
      aria-label={COMPANION_COMPOSER_ARIA_LABEL}
      data-testid={COMPANION_COMPOSER_TESTID}
      data-composer-placement={placement.placement}
      data-composer-clearance={Math.round(placement.clearance)}
      data-composer-surface={surface}
      position="fixed"
      left={`${placement.left}px`}
      top={`${placement.top}px`}
      width={`${placement.width}px`}
      height={`${placement.height}px`}
      zIndex={surface === 'overlay' ? 103 : 120}
      display="flex"
      alignItems="flex-end"
      gap="1"
      padding={`${COMPOSER_PAD}px`}
      bg="bg.surface"
      border="1px solid"
      borderColor="accent.border"
      borderRadius="md"
      boxShadow="dialog"
    >
      <Text
        data-testid={COMPANION_COMPOSER_TARGET_TESTID}
        flexShrink={0}
        alignSelf="center"
        maxWidth="104px"
        px="2"
        py="2px"
        bg="bg.subtle"
        borderRadius="sm"
        color="fg.muted"
        fontSize="11px"
        lineHeight="16px"
        lineClamp={1}
        title={targetCopy}
      >
        {targetCopy}
      </Text>

      <chakra.textarea
        ref={inputRef}
        data-testid={COMPANION_COMPOSER_INPUT_TESTID}
        aria-label={COMPANION_COMPOSER_INPUT_LABEL}
        placeholder={COMPANION_COMPOSER_PLACEHOLDER}
        value={value}
        rows={1}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        flex="1"
        minWidth={0}
        height={`${textHeight}px`}
        resize="none"
        background="transparent"
        border="none"
        outline="none"
        overflowY={textHeight >= COMPOSER_MAX_H - COMPOSER_PAD * 2 ? 'auto' : 'hidden'}
        color="fg.default"
        fontSize="13px"
        lineHeight="18px"
        fontFamily="inherit"
        padding="6px 4px"
        _placeholder={{ color: 'fg.subtle' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
      />

      <chakra.button
        type="button"
        data-testid={COMPANION_COMPOSER_SUBMIT_TESTID}
        aria-label={COMPANION_COMPOSER_SUBMIT_LABEL}
        onClick={submit}
        flexShrink={0}
        alignSelf="center"
        display="flex"
        alignItems="center"
        justifyContent="center"
        width="28px"
        height="28px"
        borderRadius="sm"
        color="var(--accent-contrast)"
        bg="accent.default"
        cursor="pointer"
        _hover={{ bg: 'accent.strong' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
      >
        <Icon as={LuArrowUp} boxSize="16px" aria-hidden="true" />
      </chakra.button>

      <chakra.button
        type="button"
        data-testid={COMPANION_COMPOSER_DISMISS_TESTID}
        aria-label={COMPANION_COMPOSER_DISMISS_LABEL}
        onClick={dismiss}
        flexShrink={0}
        alignSelf="center"
        display="flex"
        alignItems="center"
        justifyContent="center"
        width="28px"
        height="28px"
        borderRadius="sm"
        color="fg.muted"
        bg="transparent"
        cursor="pointer"
        _hover={{ bg: 'bg.hover', color: 'fg.default' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.focusRing', outlineOffset: '2px' }}
      >
        <Icon as={LuX} boxSize="16px" aria-hidden="true" />
      </chakra.button>
    </Box>
  );
}
