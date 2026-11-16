/**
 * Settings → Installed applications (Spec #3147, ST-6; UI/UX §3.1).
 *
 * The settings half of the two entry points the acceptance criteria describe:
 * choose a package and read the named refusal. This pane is deliberately a
 * **registry view, not an open surface** — installed applications are opened from
 * the launcher (§3.2), so there is exactly one open path and therefore exactly
 * one place that renders an open failure. That is why no row carries an Open,
 * Remove or toggle control.
 *
 * # Anatomy, in DOM order (§3.1)
 *
 * 1. Header + the one-line trust-tier statement (these are not Fredo's own, and
 *    they are separate).
 * 2. The install action row — the pane's ONLY tab stop.
 * 3. The unsigned-package note, immediately under the button (the moment it
 *    matters is immediately before the file choice).
 * 4. The verdict slot — install success (`role="status"` polite) or a refusal
 *    (`role="alert"` + `data-refusal-code`); exactly one has content at a time.
 *    A failed LIST fetch renders here too, as `io_error` — never a blank pane
 *    and never the empty state.
 * 5. The list (`role="list"`), or the empty state; the list is NOT rendered when
 *    empty (the shipped absence rule — an empty `<ul>` beside an empty message
 *    would be two empty things to explain).
 * 6. The v1 limitations block — always visible, never dismissible, not a tab
 *    stop.
 *
 * # States
 *
 * `loading` (three Skeleton rows), `empty`, `populated`, `refusal`, `success`,
 * `list-load-failed`. A refusal never leaves the install button disabled or
 * spinning (R-3.5) — `finally` clears the in-flight flag whichever way the call
 * went.
 *
 * # The absent-key rule at the render boundary (G-413)
 *
 * `description` arrives as an ABSENT KEY when the manifest omitted one, so the
 * `description` line renders only when the key is present — a `null`/`undefined`
 * never reaches the DOM.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Heading, HStack, Icon, Skeleton, Text, VStack } from '@chakra-ui/react';
import { LuCircleCheck, LuPackageOpen, LuPackagePlus } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import { installPackage, installedAppErrorFrom } from '../../../shared/installed-apps/client';
import { InstalledAppRefusal } from '../../../shared/installed-apps/RefusalBlocks';
import { recordInstalledApp, refreshInstalledApps } from '../../../shared/installed-apps/store';
import { useInstalledAppsStatus } from '../../../shared/installed-apps/useInstalledApps';
import type { InstalledAppEntry, InstalledAppError } from '../../../shared/installed-apps/types';

/** The install button's visible label — the accessible name, verbatim (three ASCII dots). */
export const INSTALL_BUTTON_LABEL = 'Install application package...';

/** The unsigned-package note (UI/UX §8(i)) — verbatim, always visible. */
export const UNSIGNED_PACKAGE_NOTE =
  "Fredo doesn't verify who built a package. Install only packages you trust.";

/** The empty state's headline (UI/UX §5). */
export const EMPTY_HEADLINE = 'No applications installed yet.';

/** The empty state's next-action line — the pane is never a dead end. */
export const EMPTY_NEXT_ACTION = 'Install a package (a .zip file) to add one.';

/** The v1 limitations heading (UI/UX §8(ii)). */
export const LIMITATIONS_HEADING = 'Not yet supported for installed applications';

/** The v1 limitations sentence (UI/UX §8(ii)) — verbatim. */
export const LIMITATIONS_SENTENCE =
  "They open in their own window and can't be placed as in-window panels. They don't take part in Fredo's keyboard navigation, so they have no shortcuts of their own.";

/** The success strip's sentence — it names the destination, because this pane is not an open surface. */
export function installSuccessSentence(displayName: string): string {
  return `${displayName} is installed. Open it from the launcher, under Installed apps.`;
}

type Verdict =
  | { readonly kind: 'success'; readonly entry: InstalledAppEntry }
  | { readonly kind: 'refusal'; readonly error: InstalledAppError }
  | null;

/** One read-only row: identity, version and the declared Fredo range. */
const InstalledAppRow: React.FC<{ entry: InstalledAppEntry }> = ({ entry }) => (
  <HStack
    role="listitem"
    data-testid="installed-apps-entry"
    data-app-id={entry.id}
    px={5}
    py={3}
    gap={3}
    align="flex-start"
    borderBottom="1px solid"
    borderColor="border.subtle"
  >
    <Icon
      as={LuPackageOpen}
      boxSize="18px"
      color="fg.muted"
      aria-hidden="true"
      flexShrink={0}
      mt="0.5"
    />
    <Box minW={0} flex="1">
      {/* The ONE ellipsizing child (the shipped AppRow convention). */}
      <Text fontWeight={600} color="fg.default" lineClamp={1}>
        {entry.displayName}
      </Text>
      <Text fontFamily="mono" fontSize="xs" color="fg.muted" lineClamp={1}>
        {entry.id} @ {entry.version}
        {entry.enginesFredo ? ` · Fredo ${entry.enginesFredo}` : ''}
      </Text>
      {/* Present-key only: an absent description never becomes a DOM value. */}
      {entry.description !== undefined ? (
        <Text fontSize="xs" color="fg.muted" lineClamp={2} mt={0.5}>
          {entry.description}
        </Text>
      ) : null}
    </Box>
  </HStack>
);

export const InstalledAppsSettings: React.FC = () => {
  const status = useInstalledAppsStatus();
  const [installing, setInstalling] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>(null);

  // The panel asks for the list when it mounts — nothing reads the registry at
  // startup (R-5.5). A plain `[]` dependency: the store notifies subscribers on
  // its own, so a store update never re-runs this effect (the #523 loop class).
  useEffect(() => {
    void refreshInstalledApps();
  }, []);

  const handleInstall = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    // The picker opens only after the button has acknowledged the click; the
    // verdict slot is emptied so the next attempt's result is the only verdict.
    setVerdict(null);
    try {
      const entry = await installPackage();
      recordInstalledApp(entry);
      setVerdict({ kind: 'success', entry });
    } catch (rejection) {
      setVerdict({ kind: 'refusal', error: installedAppErrorFrom(rejection) });
    } finally {
      // R-3.5: a refusal is data on screen, never a wedged install surface.
      setInstalling(false);
    }
  }, [installing]);

  // A local refusal/success wins over a list-read failure: the user's last action
  // is the more specific fact. A list failure is a verdict of its own otherwise.
  const refusal: InstalledAppError | null =
    verdict?.kind === 'refusal' ? verdict.error : status.error;

  const showSkeletons = status.loading && !status.settled;
  const showEmpty = !showSkeletons && status.error === null && status.entries.length === 0;
  const showList = !showSkeletons && status.entries.length > 0;

  return (
    <VStack data-testid="installed-apps-pane" align="stretch" gap={0}>
      {/* 1 — header + the trust-tier statement */}
      <VStack align="stretch" gap={1} px={5} pt={5} pb={3}>
        <Heading as="h2" size="md" fontFamily="heading" color="fg.default">
          Installed applications
        </Heading>
        <Text fontSize="sm" color="fg.muted">
          Applications you added yourself. Each opens in its own window, separate from Fredo.
        </Text>
      </VStack>

      {/* 2 + 3 — the install action and the note that belongs beside it */}
      <VStack align="stretch" gap={1.5} px={5} pb={3}>
        <HStack>
          <Button
            data-testid="installed-apps-install-button"
            size="sm"
            loading={installing}
            disabled={installing}
            onClick={() => void handleInstall()}
            background="var(--accent-primary)"
            color="var(--accent-contrast)"
            _hover={{ opacity: 0.9 }}
          >
            <Icon as={LuPackagePlus} aria-hidden="true" boxSize="4" />
            {INSTALL_BUTTON_LABEL}
          </Button>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          {UNSIGNED_PACKAGE_NOTE}
        </Text>
      </VStack>

      {/* 4 — the verdict slot. BOTH containers are always in the DOM region and
          exactly ONE has content at a time, so the region never reflows the list
          (UI/UX §3.1). The refusal slot also carries the `list-load-failed`
          verdict — a failed list read is a verdict, never emptiness.
          The wrappers are plain boxes on purpose: the only hooks are the two the
          names block fixes (`installed-apps-refusal` / `installed-apps-install-success`). */}
      <Box px={5} pb={2}>
        <Box>
          {refusal ? (
            <InstalledAppRefusal code={refusal.code} detail={refusal.detail} field={refusal.field} />
          ) : null}
        </Box>
        <Box>
          {refusal === null && verdict?.kind === 'success' ? (
            <HStack
              data-testid="installed-apps-install-success"
              role="status"
              aria-live="polite"
              gap={2}
              px={3}
              py={2.5}
              bg={tint('var(--status-success)', 10)}
              borderWidth="1px"
              borderStyle="solid"
              borderColor="border.default"
              borderRadius="md"
            >
              <Icon as={LuCircleCheck} boxSize="4" color="var(--status-success)" aria-hidden="true" />
              <Text fontSize="sm" color="fg.default">
                {installSuccessSentence(verdict.entry.displayName)}
              </Text>
            </HStack>
          ) : null}
        </Box>
      </Box>

      {/* 5 — loading / list / empty */}
      {showSkeletons ? (
        <VStack data-testid="installed-apps-loading" align="stretch" gap={0}>
          {[0, 1, 2].map((row) => (
            <HStack
              key={row}
              px={5}
              py={3}
              gap={4}
              borderBottom="1px solid"
              borderColor="border.subtle"
            >
              <Skeleton boxSize="18px" borderRadius="full" />
              <Skeleton height="14px" width="160px" />
              <Skeleton height="12px" width="200px" ml="auto" />
            </HStack>
          ))}
        </VStack>
      ) : showList ? (
        <VStack role="list" data-testid="installed-apps-list" align="stretch" gap={0}>
          {status.entries.map((entry) => (
            <InstalledAppRow key={entry.id} entry={entry} />
          ))}
        </VStack>
      ) : showEmpty ? (
        <Box
          data-testid="installed-apps-empty"
          role="status"
          px={5}
          py={8}
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap={2}
        >
          <Icon as={LuPackageOpen} boxSize="28px" color="var(--text-secondary)" aria-hidden="true" />
          <Text fontSize="13px" color="fg.muted">
            {EMPTY_HEADLINE}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {EMPTY_NEXT_ACTION}
          </Text>
        </Box>
      ) : null}

      {/* 6 — the v1 limitations. Always visible, never dismissible, not focusable. */}
      <Box
        data-testid="installed-apps-limitations"
        mx={5}
        my={4}
        px={3}
        py={2.5}
        bg="bg.subtle"
        borderWidth="1px"
        borderStyle="solid"
        borderColor="border.subtle"
        borderRadius="md"
      >
        <Text fontSize="xs" fontWeight={600} color="fg.default">
          {LIMITATIONS_HEADING}
        </Text>
        <Text fontSize="xs" color="fg.muted" mt={1}>
          {LIMITATIONS_SENTENCE}
        </Text>
      </Box>
    </VStack>
  );
};
