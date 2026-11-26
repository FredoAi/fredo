/**
 * The two refusal surfaces (Spec #3147, ST-6) — one treatment table, two hosts.
 *
 * # One refusal component, one owner (UI/UX §2)
 *
 * `F1–F6` (the install-time families) render through `<InstalledAppRefusal>`
 * inside the settings pane. `F7–F8` (the load-time families) render through
 * `<InstalledAppOpenRefusal>` in the launcher, because those refusals create
 * **no window** — so there is no child document for the failure to live in. Both
 * share ONE `RefusalBlock` body and read the SAME family → treatment table in
 * `refusals.ts`; there is deliberately no per-code bespoke block and no third
 * copy table. The body lives here (beside the treatment table it renders) rather
 * than in either host file so the two hosts cannot drift.
 *
 * # Severity is never colour alone
 *
 * Every block carries (i) the copy sentence from `INSTALL_REFUSAL_COPY`,
 * (ii) a glyph whose SHAPE differs per family, and (iii) the backend's `detail`
 * as a muted specifics line (`field` as a mono chip when present). The tint
 * (`tint(var, 10)`) and the border are reinforcement only — nothing legible
 * depends on the coloured boundary, so this design declares no new contrast
 * floor (UI/UX §7).
 *
 * # Colours
 *
 * Theme tokens and `tint()` only: `status.errorStrong` / `border.default` for
 * the boundary and `tint('var(--status-…)', 10)` for the fill. No hex, no rgba,
 * and no alpha-append onto a `var()` (invalid CSS — #2770 round 5).
 */

import React from 'react';
import { Box, chakra, HStack, Icon, Text } from '@chakra-ui/react';
import {
  LuCircleAlert,
  LuFileWarning,
  LuFileX,
  LuPackageCheck,
  LuPackageX,
  LuShieldAlert,
} from 'react-icons/lu';

import { tint } from '../utils/colorTint';
import { refusalCopy, refusalStyle, type RefusalFamilyStyle } from './refusals';
import type { InstalledAppRefusalCode } from './types';

/** The glyph SHAPE per family — the non-colour carrier of the verdict. */
const FAMILY_GLYPH: Record<RefusalFamilyStyle['glyph'], React.ElementType> = {
  'file-warning': LuFileWarning,
  'file-x': LuFileX,
  'package-x': LuPackageX,
  'shield-alert': LuShieldAlert,
  'package-check': LuPackageCheck,
  'circle-alert': LuCircleAlert,
};

interface RefusalBlockProps {
  code: InstalledAppRefusalCode;
  /** The backend's specifics (which field, which path, which version). */
  detail?: string;
  /** Present iff the refusal concerns one manifest field. */
  field?: string;
  /** The surface's `data-testid` (the ONLY difference between the two hosts). */
  testId: string;
  /** The reason sentence's `data-testid`, when the host exposes one. */
  reasonTestId?: string;
  /**
   * Override the reason sentence (default: `refusalCopy(code)`).
   *
   * A host that reuses a frozen code in a DIFFERENT context may need an honest
   * sentence without changing the frozen install/open copy — e.g. the settings
   * pane's management-action refusal reuses `io_error`/`id_not_installed`, whose
   * install/open sentences are false about an installed application (#3144, the
   * copy-honesty ruling; `refusals.ts` is NO CHANGE). The override never changes
   * the CATEGORY vocabulary: `code` still flows to `data-refusal-code` and still
   * selects the family treatment.
   */
  reasonText?: string;
}

function RefusalBlock({ code, detail, field, testId, reasonTestId, reasonText }: RefusalBlockProps) {
  const style = refusalStyle(code);
  const Glyph = FAMILY_GLYPH[style.glyph];
  const iconColor = style.severity === 'error' ? 'status.errorStrong' : 'var(--status-warning)';

  return (
    <Box
      data-testid={testId}
      data-refusal-code={code}
      role="alert"
      bg={tint(style.tintVar, 10)}
      borderWidth="1px"
      borderStyle="solid"
      borderColor={style.borderColor}
      borderRadius="md"
      px={3}
      py={2.5}
    >
      <HStack align="flex-start" gap={2}>
        {/* The shape carries the family; the colour only reinforces it. */}
        <Icon as={Glyph} boxSize="4" color={iconColor} aria-hidden="true" flexShrink={0} mt="0.5" />
        <Box minW={0} flex="1">
          <Text data-testid={reasonTestId} fontSize="sm" color="fg.default" lineHeight="short">
            {reasonText ?? refusalCopy(code)}
          </Text>
          {detail ? (
            <Text fontSize="xs" color="fg.muted" mt={1} wordBreak="break-word">
              {detail}
              {field ? (
                <chakra.span fontFamily="mono" fontSize="xs" color="fg.muted" ml={1.5}>
                  {field}
                </chakra.span>
              ) : null}
            </Text>
          ) : null}
        </Box>
      </HStack>
    </Box>
  );
}

export interface InstalledAppRefusalProps {
  code: InstalledAppRefusalCode;
  detail?: string;
  field?: string;
  /**
   * The surface's `data-testid`. Defaults to the pane's install-verdict hook; the
   * settings consent section passes its own hook (Spec #3146) so the two verdict
   * slots stay distinguishable without a second block body.
   */
  testId?: string;
  /** The reason sentence's `data-testid`, when the host exposes one. */
  reasonTestId?: string;
  /** An honest reason sentence for this context (see [`RefusalBlockProps.reasonText`]). */
  reasonText?: string;
}

/**
 * The settings pane's install-refusal verdict (F1–F6), and the pane's
 * `list-load-failed` verdict (`io_error`, F6) — one block, one sentence, one
 * severity, whichever install-time failure produced it.
 */
export function InstalledAppRefusal({
  code,
  detail,
  field,
  testId = 'installed-apps-refusal',
  reasonTestId = 'installed-apps-refusal-reason',
  reasonText,
}: InstalledAppRefusalProps) {
  return (
    <RefusalBlock
      code={code}
      detail={detail}
      field={field}
      testId={testId}
      reasonTestId={reasonTestId}
      reasonText={reasonText}
    />
  );
}

export interface InstalledAppOpenRefusalProps {
  code: InstalledAppRefusalCode;
  detail?: string;
}

/**
 * The launcher's open-refusal verdict (F7–F8): an open was refused before any
 * window existed, so the launcher — the surface the user clicked from — reports
 * it. Not sticky; the section clears it on the next activation attempt.
 */
export function InstalledAppOpenRefusal({ code, detail }: InstalledAppOpenRefusalProps) {
  return <RefusalBlock code={code} detail={detail} testId="launcher-installed-app-error" />;
}
