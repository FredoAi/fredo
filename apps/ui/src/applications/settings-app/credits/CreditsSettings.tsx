/**
 * Settings → Credits (Spec #3206, ST-3; UI/UX §1–§6).
 *
 * One static, scrollable legal-reference document: the third-party components
 * Fredo bundles or depends on (§1–§4), Fredo's own dual licence with both texts
 * readable in-app, the CC BY 4.0 design reference (§7), and the DOOM trademark /
 * non-affiliation notice — in the canonical doc's own reading order, so a
 * reviewer can diff the pane against `docs/THIRD_PARTY_NOTICES.md` line by line.
 *
 * # One content authority
 *
 * Every name, licence identifier, field value, licence body and URL is rendered
 * from the generated artifact (`credits.generated.ts`). This file carries ONLY
 * authored chrome (the copy constants below) and layout; it never retypes a
 * datum. A hand-copied notice literal here would be the dual-system pattern the
 * plan forbids.
 *
 * # States: there is only the default one
 *
 * `credits.generated.ts` is a static ES import — no fetch, no store, no effect,
 * no promise. The pane renders its final content on the first paint, so there is
 * deliberately no loading state (a skeleton would be theatre), no empty state
 * (a missing entry is a generator/test failure, not a runtime state) and no
 * read-error state (there is no read). The one exception is the link refusal:
 * activating an entry's upstream button can be refused by the backend, and that
 * refusal renders inline under the button that was clicked.
 *
 * # The link is a BUTTON, never an `<a href>`
 *
 * `default-src 'self'` does not restrict top-level navigation, so a same-tab
 * `<a href>` would navigate the Settings document away, and `target="_blank"` is
 * cancelled by wry (no opener plugin, no `on_new_window` handler). The control
 * is therefore a `Button` calling `openExternalLink`, and a test proves the
 * subtree contains zero `[href]` / `[target]` nodes.
 *
 * # Tokens only
 *
 * Every paint derives from a Chakra semantic token (→ CSS var) or the shared
 * `tint()` helper. No hex, no rgba/hsl, no `var(--x)NN` alpha-append. This file
 * is in `AUDITED_FILES` (`SettingsSurface.theming.test.tsx`), so a drive-by
 * literal fails the suite.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  Accordion,
  Box,
  Button,
  Card,
  Heading,
  HStack,
  Icon,
  Separator,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LuCircleAlert, LuExternalLink } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import {
  CREDIT_ENTRIES,
  CREDITS_SOURCE,
  DOOM_TRADEMARK,
  FREDO_LICENCE,
  type CreditEntry,
  type CreditField,
  type LicenceBody,
} from './credits.generated';
import { openExternalLink } from './externalLink';

// ── Authored chrome (UI/UX §2 copy table, C-1…C-13) ──────────────────────────
//
// Exported so tests assert the authored strings without duplicating them (the
// shipped `InstalledAppsSettings.tsx` convention). Doc-derived strings are
// NEVER exported from here — they come from the generated artifact.

/** C-1 — the pane heading. Must equal the nav label (binding). */
export const CREDITS_TITLE = 'Credits';

/** C-2 — the pane subtitle: a pre-scroll table of contents for a long document. */
export const CREDITS_SUBTITLE =
  "Third-party licences, Fredo's own licence, design-reference credits and trademark notices.";

/** C-3 — group A heading (the doc's own word for all four obligation classes). */
export const GROUP_THIRD_PARTY = 'Third-party components';

/** C-4 — group A intro. Deliberately states no count: the doc can gain a row. */
export const GROUP_THIRD_PARTY_INTRO =
  'Components Fredo bundles or depends on, and the licence each one is used under.';

/** C-5 — group B heading. */
export const GROUP_FREDO_LICENCE = "Fredo's own licence";

/** C-6 — group C heading (doc §7's own title). */
export const GROUP_DESIGN_REFERENCES = 'Design references';

/** C-7 — group C intro (doc §7's own claim; states no redistribution fact). */
export const GROUP_DESIGN_REFERENCES_INTRO =
  "Visual references used while designing the companion avatar's Doom mode.";

/** C-8 — group D heading. */
export const GROUP_TRADEMARKS = 'Trademarks';

/**
 * C-9 — the muted suffix inside every licence trigger. NEVER "Full text": two of
 * the nine panels (`id Software shareware` and `CC BY 4.0`) are the doc's own
 * prose, not a licence body, so "full text" would be a false claim there.
 */
export const LICENCE_TRIGGER_SUFFIX = 'licence text';

/** C-10 — the link button's visible label. A SUBSTRING of {@link linkAccessibleName} (WCAG 2.5.3). */
export function linkVisibleLabel(name: string): string {
  return `${name} upstream page`;
}

/** C-10 — the link button's accessible name (frozen). */
export function linkAccessibleName(name: string): string {
  return `Open ${name} upstream page in your browser`;
}

/**
 * C-11 — the refusal sentence. Names the entry and points at the address that is
 * already on screen in the `Upstream` / `Source` field row above the button, so a
 * dead click always has a stated way out.
 */
export function linkRefusalSentence(name: string): string {
  return `Fredo couldn't open the ${name} upstream page in your browser. The address is listed above, if you want to open it yourself.`;
}

/** C-13 — the canonical-source footer. */
export function canonicalSourceLine(docPath: string): string {
  return `Canonical source: ${docPath} — this list is generated from that file.`;
}

// ── Field / refusal helpers ───────────────────────────────────────────────────

/** The doc field label → the frozen `credits-field-<id>-<fieldSlug>` segment. */
export function fieldSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Licence and distribution-form values are the obligation facts — emphasised. */
function isEmphasisedField(label: string): boolean {
  return /^licen[cs]e(\s*\/\s*terms)?$/i.test(label) || label === 'Distribution form';
}

/**
 * An address-bearing value is information, not an affordance: it renders as
 * plain muted mono text. Derived from the value, never from a label list, so a
 * doc label rename cannot silently drop the treatment.
 */
function isAddressValue(field: CreditField): boolean {
  return field.value.trim().startsWith('https://');
}

/**
 * The refusal's `data-refusal-code`: the code the backend pinned, parsed out of
 * the wire string. The `failed:` family is reported as `failed` — the OS hand-off
 * was attempted and reported an error, which is a different fact from a refusal.
 */
export function refusalCodeFrom(message: string): string {
  const refusedPrefix = 'external link refused: ';
  const trimmed = message.trim();
  if (trimmed.startsWith(refusedPrefix)) {
    const code = trimmed.slice(refusedPrefix.length).trim();
    return code.length > 0 ? code : 'malformed';
  }
  return 'failed';
}

/** Any caught value → a renderable string (a raw wire string or an `Error`). */
function messageOf(rejection: unknown): string {
  if (typeof rejection === 'string') return rejection;
  if (rejection instanceof Error) return rejection.message;
  return String(rejection);
}

interface LinkRefusal {
  readonly entryId: string;
  readonly raw: string;
  /** Monotonic per attempt, so a repeated identical failure remounts and re-announces. */
  readonly attempt: number;
}

// ── The licence-body accordion (the shipped Chakra v3 compound family) ────────

interface LicenceBodiesProps {
  /** The testid id segment: an entry id (`llama-cpp`) or `fredo` for the dual-licence block. */
  readonly idPrefix: string;
  /** Accordion value prefix — unique per pane so a second root can never collide. */
  readonly valuePrefix: string;
  readonly bodies: readonly LicenceBody[];
}

/**
 * One `Accordion.Root` per card, `multiple` (independent expansion — a reader
 * comparing MIT with Apache-2.0 must not have the first collapse under them),
 * `variant="plain"`, UNCONTROLLED with `defaultValue={[]}`: every body is
 * collapsed on every mount, and re-entering the section remounts the pane.
 *
 * The trigger's accessible name is its natural text (`MIT licence text`) — the
 * doc's identifier plus the muted suffix — so the trigger carries NO `aria-label`
 * (it would mask `aria-expanded`'s subject).
 */
const LicenceBodies: React.FC<LicenceBodiesProps> = ({ idPrefix, valuePrefix, bodies }) => (
  <Accordion.Root multiple defaultValue={[]} variant="plain">
    {bodies.map((body) => (
      <Accordion.Item
        key={body.id}
        value={`${valuePrefix}:${body.id}`}
        borderTop="1px solid"
        borderColor="border.subtle"
        _first={{ borderTop: 'none' }}
      >
        <Accordion.ItemTrigger
          data-testid={`credits-body-${idPrefix}-${body.id}`}
          gap={2}
          py={2}
          cursor="pointer"
        >
          <Accordion.ItemIndicator color="fg.muted" />
          <Text
            as="span"
            flex="1"
            minW={0}
            fontWeight={600}
            fontSize="sm"
            color="fg.default"
            textAlign="left"
          >
            {body.label}{' '}
            <Text as="span" fontWeight={400} fontSize="xs" color="fg.muted">
              {LICENCE_TRIGGER_SUFFIX}
            </Text>
          </Text>
        </Accordion.ItemTrigger>
        <Accordion.ItemContent>
          <Accordion.ItemBody pt={2} pb={2}>
            {/* Reproduced text, never markdown and never linkified: the Apache
                body carries an `http://` address and §4 an `ftp://` reference,
                neither of which may become activatable. `m={0}` resets the UA
                `<pre>` margin so the inset block keeps the card's rhythm. */}
            <Box
              as="pre"
              data-testid={`credits-text-${idPrefix}-${body.id}`}
              m={0}
              p={3}
              borderRadius="md"
              bg="bg.canvas"
              border="1px solid"
              borderColor="border.subtle"
              fontFamily="mono"
              fontSize="xs"
              lineHeight="1.6"
              color="fg.default"
              whiteSpace="pre-wrap"
              overflowWrap="anywhere"
              wordBreak="normal"
              userSelect="text"
            >
              {body.text}
            </Box>
          </Accordion.ItemBody>
        </Accordion.ItemContent>
      </Accordion.Item>
    ))}
  </Accordion.Root>
);

// ── The field list (a definition list, not label/value text pairs) ────────────

const CreditFieldList: React.FC<{ readonly entryId: string; readonly fields: readonly CreditField[] }> = ({
  entryId,
  fields,
}) => (
  <Box
    as="dl"
    display="grid"
    gridTemplateColumns={{ base: '1fr', md: '160px 1fr' }}
    rowGap={2}
    columnGap={4}
    m={0}
  >
    {fields.map((field) => (
      <React.Fragment key={field.label}>
        <Box
          as="dt"
          data-testid={`credits-field-${entryId}-${fieldSlug(field.label)}`}
          fontSize="sm"
          color="fg.muted"
        >
          {field.label}
        </Box>
        <Box
          as="dd"
          m={0}
          fontSize="sm"
          color={isAddressValue(field) ? 'fg.muted' : 'fg.default'}
          fontWeight={isEmphasisedField(field.label) ? 600 : 400}
          fontFamily={isAddressValue(field) ? 'mono' : undefined}
          overflowWrap="anywhere"
        >
          {field.value}
        </Box>
      </React.Fragment>
    ))}
  </Box>
);

// ── The refusal block (inline, under the clicked button, exactly one) ─────────

const LinkRefusalBlock: React.FC<{ readonly entryName: string; readonly refusal: LinkRefusal }> = ({
  entryName,
  refusal,
}) => (
  // `key` lives on the mount site (the attempt counter); the code is the parsed
  // pinned refusal, never a paraphrase of the backend string.
  <Box
    data-testid="credits-link-error"
    data-refusal-code={refusalCodeFrom(refusal.raw)}
    role="alert"
    bg={tint('var(--status-error)', 10)}
    borderWidth="1px"
    borderStyle="solid"
    borderColor="status.error"
    borderRadius="md"
    px={3}
    py={2.5}
  >
    <HStack align="flex-start" gap={2}>
      {/* Shape carries the verdict; the colour only reinforces it. */}
      <Icon as={LuCircleAlert} boxSize="4" color="status.errorStrong" aria-hidden="true" flexShrink={0} mt="0.5" />
      <Box minW={0} flex="1">
        <Text fontSize="sm" color="fg.default" lineHeight="short">
          {linkRefusalSentence(entryName)}
        </Text>
        <Text fontSize="xs" color="fg.muted" fontFamily="mono" mt={1} wordBreak="break-word">
          {refusal.raw}
        </Text>
      </Box>
    </HStack>
  </Box>
);

// ── One entry card ───────────────────────────────────────────────────────────

interface CreditEntryCardProps {
  readonly entry: CreditEntry;
  readonly refusal: LinkRefusal | null;
  readonly onOpen: (entry: CreditEntry) => void;
}

const CreditEntryCard: React.FC<CreditEntryCardProps> = ({ entry, refusal, onOpen }) => (
  <Card.Root
    data-testid={`credits-entry-${entry.id}`}
    bg="bg.surface"
    border="1px solid"
    borderColor="border.subtle"
    borderRadius="lg"
    w="100%"
  >
    <Card.Body display="flex" flexDirection="column" gap={3} p={4}>
      <Text
        as="h4"
        data-testid={`credits-entry-name-${entry.id}`}
        fontFamily="heading"
        fontWeight={600}
        color="fg.default"
      >
        {entry.name}
      </Text>

      <CreditFieldList entryId={entry.id} fields={entry.fields} />

      {/* The ONE activatable control for this entry. Underlined + external glyph
          = "this is an address, and it leaves Fredo". Never disabled (a retry is
          legitimate) and never a spinner (the round-trip is far below budget). */}
      <Box>
        <Button
          variant="plain"
          data-testid={`credits-link-${entry.id}`}
          aria-label={linkAccessibleName(entry.name)}
          onClick={() => onOpen(entry)}
          cursor="pointer"
          height="auto"
          px={2}
          py={1}
          gap={1.5}
          fontWeight={500}
          fontSize="sm"
          color="fg.default"
          textDecoration="underline"
          textDecorationThickness="1px"
          textUnderlineOffset="2px"
          _hover={{ bg: 'bg.hover' }}
          _active={{ bg: 'bg.muted' }}
        >
          <Icon as={LuExternalLink} aria-hidden="true" boxSize="3.5" flexShrink={0} />
          {linkVisibleLabel(entry.name)}
        </Button>
      </Box>

      {/* A refusal is inline, under THIS entry's button (the state carries the
          entry id), and remounts per attempt so a repeat failure re-announces. */}
      {refusal ? (
        <LinkRefusalBlock key={refusal.attempt} entryName={entry.name} refusal={refusal} />
      ) : null}

      <LicenceBodies idPrefix={entry.id} valuePrefix={entry.id} bodies={entry.licenceBodies} />
    </Card.Body>
  </Card.Root>
);

// ── The pane ─────────────────────────────────────────────────────────────────

export const CreditsSettings: React.FC = () => {
  const [refusal, setRefusal] = useState<LinkRefusal | null>(null);
  // A per-entry in-flight guard (a logic guard, NOT `disabled`: a disabled button
  // loses focus). It stops a double click from opening two browser tabs.
  const inFlight = useRef<Set<string>>(new Set());
  const attemptCounter = useRef(0);

  const handleOpen = useCallback(async (entry: CreditEntry) => {
    if (inFlight.current.has(entry.id)) return;
    inFlight.current.add(entry.id);
    // The next activation clears the previous verdict, so at most one block is
    // ever in the DOM and it always belongs to the entry just tried.
    setRefusal(null);
    try {
      await openExternalLink(entry.upstreamUrl);
      // No success feedback: the browser window is the feedback channel, and
      // Fredo cannot know whether it actually raised.
    } catch (rejection) {
      attemptCounter.current += 1;
      setRefusal({
        entryId: entry.id,
        raw: messageOf(rejection),
        attempt: attemptCounter.current,
      });
    } finally {
      inFlight.current.delete(entry.id);
    }
  }, []);

  const thirdPartyEntries = CREDIT_ENTRIES.filter((entry) => entry.section <= 4);
  const designEntries = CREDIT_ENTRIES.filter((entry) => entry.section === 7);

  return (
    <VStack data-testid="credits-settings" align="stretch" gap={0}>
      {/* Header — the pane's own h2 (the sidebar's "Settings" h2 is a separate
          region, the shape every shipped pane already has). */}
      <Box pb={4}>
        <Heading as="h2" size="md" fontFamily="heading" color="fg.default">
          {CREDITS_TITLE}
        </Heading>
        <Text fontSize="sm" color="fg.muted" mt={1}>
          {CREDITS_SUBTITLE}
        </Text>
      </Box>

      {/* ── Group A — the bundled/depended components (§1–§4). FIVE cards for
             FOUR obligation classes, because §2 contributes two (Vulkan, ggml):
             membership is filtered from the artifact, never a hardcoded count. ── */}
      <Box>
        <Heading as="h3" size="sm" fontFamily="heading" color="fg.default">
          {GROUP_THIRD_PARTY}
        </Heading>
        <Text fontSize="sm" color="fg.muted" mt={1} pb={3}>
          {GROUP_THIRD_PARTY_INTRO}
        </Text>
        <VStack align="stretch" gap={3}>
          {thirdPartyEntries.map((entry) => (
            <CreditEntryCard
              key={entry.id}
              entry={entry}
              refusal={refusal?.entryId === entry.id ? refusal : null}
              onOpen={handleOpen}
            />
          ))}
        </VStack>
      </Box>

      <Separator my={6} borderColor="border.subtle" />

      {/* ── Group B — Fredo's own dual licence. No h4: the group h3 is the
             heading, and the statement is body text, so the heading tree never
             claims a "Fredo" entry that does not exist in the doc. ── */}
      <Box>
        <Heading as="h3" size="sm" fontFamily="heading" color="fg.default" pb={3}>
          {GROUP_FREDO_LICENCE}
        </Heading>
        <Card.Root
          data-testid="credits-fredo-licence"
          bg="bg.surface"
          border="1px solid"
          borderColor="border.subtle"
          borderRadius="lg"
          w="100%"
        >
          <Card.Body display="flex" flexDirection="column" gap={3} p={4}>
            <Text fontSize="sm" color="fg.default">
              {FREDO_LICENCE.statement}
            </Text>
            <LicenceBodies
              idPrefix="fredo"
              valuePrefix="fredo"
              bodies={FREDO_LICENCE.licenceBodies}
            />
          </Card.Body>
        </Card.Root>
      </Box>

      <Separator my={6} borderColor="border.subtle" />

      {/* ── Group C — the design reference(s) (§7). ── */}
      <Box>
        <Heading as="h3" size="sm" fontFamily="heading" color="fg.default">
          {GROUP_DESIGN_REFERENCES}
        </Heading>
        <Text fontSize="sm" color="fg.muted" mt={1} pb={3}>
          {GROUP_DESIGN_REFERENCES_INTRO}
        </Text>
        <VStack align="stretch" gap={3}>
          {designEntries.map((entry) => (
            <CreditEntryCard
              key={entry.id}
              entry={entry}
              refusal={refusal?.entryId === entry.id ? refusal : null}
              onOpen={handleOpen}
            />
          ))}
        </VStack>
      </Box>

      <Separator my={6} borderColor="border.subtle" />

      {/* ── Group D — the trademark notice, ALWAYS visible: a legal disclaimer
             behind an accordion is not a disclaimer. ── */}
      <Box>
        <Heading as="h3" size="sm" fontFamily="heading" color="fg.default" pb={3}>
          {GROUP_TRADEMARKS}
        </Heading>
        <Box
          data-testid="credits-doom-trademark"
          bg="bg.subtle"
          border="1px solid"
          borderColor="border.subtle"
          borderRadius="md"
          p={4}
        >
          <Text fontSize="sm" color="fg.default" lineHeight="short">
            {DOOM_TRADEMARK.text}
          </Text>
        </Box>
      </Box>

      <Text fontSize="xs" color="fg.muted" pt={6}>
        {canonicalSourceLine(CREDITS_SOURCE.docPath)}
      </Text>
    </VStack>
  );
};
