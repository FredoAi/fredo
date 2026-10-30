/**
 * Spec #3118 (P4), ST-3 — `NavigationMap`: the full catalogue of the SAME declaration.
 *
 * Answers one question: "what exists?" — every place in tree order with its place path, its
 * verbs (title, key hint, availability, risk word) and its keys, the current place marked, the
 * application-level direct aliases in their own section, and the two globals (`?` Map / `/` Ask)
 * with their display glyphs and declared bindings. A search field filters the rendered rows,
 * never a second list: every row comes from the ONE `NavigationMapModel` produced by the ST-1
 * projection layer (R-2.1 … R-2.6 / R-6.1).
 *
 * Keyboard (R-2.3 … R-2.5): `ArrowDown`/`ArrowUp` move focus among the verb rows (wrapping at
 * the ends), `Enter` runs the focused ENABLED verb exactly once and closes, `Escape` closes,
 * and `Tab`/`Shift+Tab` wrap inside the dialog. Every handler is scoped to the dialog content —
 * this module adds NO document-level keydown listener.
 *
 * Focus integrity (R-2.4): the element focused before `open` flipped true is captured once, the
 * dialog's own restore is disabled (`restoreFocus={false}`), and close explicitly returns focus
 * there through the shipped `restoreTransientFocus` primitive — never to `body`.
 *
 * Motion (R-5.1): opacity/transform only, `NAV_MOTION_MS`-based, gated by the `reducedMotion`
 * prop (or `useNavReducedMotion()`). Colour is theme tokens only (R-5.2).
 *
 * Non-goals: no prose/docs content, no second row list, no `aria-live`, no application mount.
 */

import React from 'react';
import { Box, chakra, Dialog, Icon, Text } from '@chakra-ui/react';
import { LuCircleSlash, LuExternalLink, LuSearch, LuTriangleAlert } from 'react-icons/lu';
import type { IconType } from 'react-icons';

import type { Platform } from '../../hotkeys/types';
import {
  getFocusableElements,
  restoreTransientFocus,
  scrollIntoViewIfNeeded,
} from '../../hotkeys/traversal';
import {
  NAV_AVAILABILITY_ATTR,
  NAV_CURRENT_ATTR,
  NAV_MAP_ALIASES_HEADING,
  NAV_MAP_ALIAS_TESTID,
  NAV_MAP_ARIA_LABEL,
  NAV_MAP_CURRENT_LABEL,
  NAV_MAP_EMPTY_COPY,
  NAV_MAP_EMPTY_TESTID,
  NAV_MAP_GLOBAL_TESTID,
  NAV_MAP_GLOBALS_HEADING,
  NAV_MAP_HINT_COPY,
  NAV_MAP_KEY_TESTID,
  NAV_MAP_PLACE_TESTID,
  NAV_MAP_ROW_TESTID,
  NAV_MAP_SEARCH_LABEL,
  NAV_MAP_SEARCH_TESTID,
  NAV_MAP_TESTID,
  NAV_MOTION_MS,
  NAV_PLACE_ID_ATTR,
  NAV_RISK_ATTR,
  NAV_SURFACE_ATTR,
  NAV_VERB_ID_ATTR,
} from './constants';
import { NavKeycap } from './Keycap';
import type {
  NavigationMapKey,
  NavigationMapModel,
  NavigationMapPlace,
  NavigationMapVerb,
} from './types';
import { useNavReducedMotion } from './useReducedMotion';

export interface NavigationMapProps {
  /** The ONE view-model (built by `buildNavigationMapModel`). No key table, no verb list. */
  readonly model: NavigationMapModel;
  /** `false` renders nothing at all (no DOM, no focus move). */
  readonly open: boolean;
  /** Close request — the owner flips `open` to false (focus restore runs in this component). */
  readonly onClose: () => void;
  /** Run one ENABLED verb (never called for an unavailable row). */
  readonly onRunVerb: (verbId: string) => void;
  /** Layout override so keycap display is deterministic in tests. */
  readonly platform?: Platform;
  /** Test override for `prefers-reduced-motion` (falls back to the media query). */
  readonly reducedMotion?: boolean;
}

/* ───────────────────────────── motion ───────────────────────────── */

const MAP_KEYFRAMES = `@keyframes navigation-map-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes navigation-map-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}`;

const MAP_CONTENT_MOTION: React.CSSProperties = {
  animation: `navigation-map-in ${NAV_MOTION_MS}ms ease`,
};
const MAP_BACKDROP_MOTION: React.CSSProperties = {
  animation: `navigation-map-backdrop-in ${NAV_MOTION_MS}ms ease`,
};
const MAP_NO_MOTION: React.CSSProperties = { animation: 'none', transition: 'none' };

/** The inset focus ring token pair (never `outline: none`). */
const ROW_FOCUS_STYLE = {
  outline: '2px solid var(--accent-strong)',
  outlineOffset: '-2px',
} as const;

/* ───────────────────────────── search filter (R-2.6) ───────────────────────────── */

/** The seeded query: `more…` opens the map filtered to that place's `pathLabel`. */
function seedSearch(model: NavigationMapModel): string {
  const target = model.filteredTo;
  if (target === null) return '';
  const place = model.places.find((candidate) => candidate.placeId === target);
  // An unknown `filteredTo` seeds the raw id, which matches nothing → the empty-result state.
  return place === undefined ? target : place.pathLabel;
}

/** Case-insensitive substring test over ONE haystack. */
function contains(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query);
}

interface FilteredPlace {
  readonly place: NavigationMapPlace;
  readonly verbs: readonly NavigationMapVerb[];
  readonly keys: readonly NavigationMapKey[];
}

/** Filter ONE place block from the model (never a new data source). */
function filterPlace(place: NavigationMapPlace, query: string): FilteredPlace | null {
  if (query === '') return { place, verbs: place.verbs, keys: place.keys };

  const placeMatch = contains(place.pathLabel, query);
  const verbs = placeMatch
    ? place.verbs
    : place.verbs.filter(
        (verb) => contains(verb.title, query) || contains(verb.keyHint, query),
      );
  const keys = placeMatch
    ? place.keys
    : place.keys.filter(
        (key) => contains(key.stroke, query) || contains(key.targetLabel, query),
      );

  if (!placeMatch && verbs.length === 0 && keys.length === 0) return null;
  return { place, verbs, keys };
}

/** Filter one key/alias/global row by stroke + target label (the design's contract). */
function filterKeyRow(row: NavigationMapKey, query: string): boolean {
  if (query === '') return true;
  return contains(row.stroke, query) || contains(row.targetLabel, query);
}

/* ───────────────────────────── risk cue ───────────────────────────── */

/** The decorative risk icon (the WORD carries the meaning — R-7.2). */
function riskIcon(risk: NavigationMapVerb['risk']): IconType {
  return risk === 'external' ? LuExternalLink : LuTriangleAlert;
}

/** Status token for the decorative risk icon; `safe` never renders a cue. */
function riskColor(risk: NavigationMapVerb['risk']): string {
  if (risk === 'mutating') return 'status.warning';
  if (risk === 'destructive') return 'status.error';
  if (risk === 'external') return 'status.info';
  return 'fg.subtle';
}

/* ───────────────────────────── rows ───────────────────────────── */

/** One verb row — a focusable button (aria-disabled, never native `disabled`). */
function MapVerbRow({
  verb,
  platform,
  onRun,
}: {
  readonly verb: NavigationMapVerb;
  readonly platform?: Platform;
  readonly onRun: (verb: NavigationMapVerb) => void;
}): React.ReactElement {
  const titleColor = verb.available ? 'fg.default' : 'fg.subtle';
  return (
    <chakra.li role="listitem" display="block" minWidth="0">
      <chakra.button
        type="button"
        data-testid={NAV_MAP_ROW_TESTID}
        {...{ [NAV_VERB_ID_ATTR]: verb.verbId }}
        {...{ [NAV_AVAILABILITY_ATTR]: verb.available ? 'available' : 'disabled' }}
        {...{ [NAV_RISK_ATTR]: verb.risk }}
        aria-label={verb.tooltip}
        aria-disabled={verb.available ? undefined : 'true'}
        title={verb.tooltip}
        onClick={() => onRun(verb)}
        display="flex"
        minWidth="0"
        alignItems="center"
        gap="1.5"
        width="100%"
        height="28px"
        px="2"
        borderRadius="sm"
        borderWidth="0"
        bg="transparent"
        color={titleColor}
        textAlign="left"
        cursor={verb.available ? 'pointer' : 'not-allowed'}
        overflow="hidden"
        _hover={verb.available ? { bg: 'bg.hover' } : undefined}
        _focus={{ bg: 'bg.muted' }}
        _focusVisible={ROW_FOCUS_STYLE}
      >
        {verb.available ? null : (
          <Icon as={LuCircleSlash} boxSize="3" color="fg.subtle" aria-hidden="true" flexShrink={0} />
        )}
        <NavKeycap keys={verb.keys} platform={platform} />
        <Text
          flex="1 1 auto"
          minWidth="0"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          fontSize="sm"
          color={titleColor}
        >
          {verb.title}
        </Text>
        {verb.riskLabel === null ? null : (
          <Box
            display="inline-flex"
            alignItems="center"
            gap="1"
            flexShrink={0}
            color={titleColor}
          >
            <Icon
              as={riskIcon(verb.risk)}
              boxSize="3"
              color={riskColor(verb.risk)}
              aria-hidden="true"
            />
            <Text fontSize="2xs" fontWeight="medium" whiteSpace="nowrap">
              {verb.riskLabel}
            </Text>
          </Box>
        )}
      </chakra.button>
    </chakra.li>
  );
}

/** One non-interactive key row (place key, alias or global) — no tab stop (R-2.2). */
function MapKeyRow({
  row,
  testId,
  platform,
}: {
  readonly row: NavigationMapKey;
  readonly testId: string;
  readonly platform?: Platform;
}): React.ReactElement {
  if (testId === NAV_MAP_GLOBAL_TESTID) {
    return (
      <chakra.li
        role="listitem"
        data-testid={testId}
        display="flex"
        alignItems="center"
        gap="2"
        minWidth="0"
        px="2"
        py="0.5"
        fontSize="xs"
        color="fg.default"
      >
        <NavKeycap keys={[]} glyph={row.glyph} platform={platform} />
        <chakra.span>{row.targetLabel}</chakra.span>
        <chakra.span color="fg.muted">({row.stroke})</chakra.span>
      </chakra.li>
    );
  }

  return (
    <chakra.li
      role="listitem"
      data-testid={testId}
      display="flex"
      alignItems="center"
      gap="2"
      minWidth="0"
      px="2"
      py="0.5"
      fontSize="xs"
      color="fg.muted"
    >
      <NavKeycap keys={[row.stroke]} platform={platform} />
      <chakra.span aria-hidden="true">→</chakra.span>
      <chakra.span overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {row.targetLabel}
      </chakra.span>
    </chakra.li>
  );
}

/** One place block: heading + current chip + its verb rows + its place-key rows. */
function MapPlaceBlock({
  place,
  verbs,
  keys,
  platform,
  onRun,
}: FilteredPlace & {
  readonly platform?: Platform;
  readonly onRun: (verb: NavigationMapVerb) => void;
}): React.ReactElement {
  const headingId = React.useId();
  return (
    <chakra.section
      data-testid={NAV_MAP_PLACE_TESTID}
      {...{ [NAV_PLACE_ID_ATTR]: place.placeId }}
      {...(place.current ? { [NAV_CURRENT_ATTR]: 'true' } : {})}
      aria-labelledby={headingId}
      borderTopWidth="1px"
      borderColor="border.subtle"
      py="2"
      style={{ paddingLeft: `${place.depth * 12}px` }}
    >
      <Box display="flex" alignItems="baseline" gap="2" minWidth="0">
        <chakra.h3
          id={headingId}
          aria-current={place.current ? 'true' : undefined}
          m="0"
          minWidth="0"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          fontSize="sm"
          fontWeight="600"
          color="fg.default"
        >
          {place.pathLabel}
        </chakra.h3>
        {place.current ? (
          <Box
            flexShrink={0}
            px="2"
            py="0.5"
            bg="bg.subtle"
            borderWidth="1px"
            borderColor="accent.border"
            borderRadius="sm"
            fontSize="2xs"
            color="fg.default"
          >
            {NAV_MAP_CURRENT_LABEL}
          </Box>
        ) : null}
      </Box>

      {verbs.length === 0 ? null : (
        <chakra.ul
          role="list"
          display="flex"
          flexDirection="column"
          gap="0.5"
          m="0"
          mt="1"
          p="0"
          listStyleType="none"
        >
          {verbs.map((verb) => (
            <MapVerbRow key={verb.verbId} verb={verb} platform={platform} onRun={onRun} />
          ))}
        </chakra.ul>
      )}

      {keys.length === 0 ? null : (
        <chakra.ul
          role="list"
          display="flex"
          flexDirection="column"
          gap="0.5"
          m="0"
          p="0"
          listStyleType="none"
        >
          {keys.map((key) => (
            <MapKeyRow
              key={`${key.stroke}:${key.targetId}`}
              row={key}
              testId={NAV_MAP_KEY_TESTID}
              platform={platform}
            />
          ))}
        </chakra.ul>
      )}
    </chakra.section>
  );
}

/** A titled section for the alias / global key rows (own list, distinct from place keys). */
function MapKeySection({
  title,
  rows,
  testId,
  platform,
}: {
  readonly title: string;
  readonly rows: readonly NavigationMapKey[];
  readonly testId: string;
  readonly platform?: Platform;
}): React.ReactElement | null {
  const headingId = React.useId();
  if (rows.length === 0) return null;
  return (
    <chakra.section
      aria-labelledby={headingId}
      borderTopWidth="1px"
      borderColor="border.subtle"
      py="2"
    >
      <chakra.h3 id={headingId} m="0" mb="1" fontSize="xs" fontWeight="600" color="fg.muted">
        {title}
      </chakra.h3>
      <chakra.ul
        role="list"
        display="flex"
        flexDirection="column"
        gap="0.5"
        m="0"
        p="0"
        listStyleType="none"
      >
        {rows.map((row) => (
          <MapKeyRow
            key={`${row.stroke}:${row.targetId}`}
            row={row}
            testId={testId}
            platform={platform}
          />
        ))}
      </chakra.ul>
    </chakra.section>
  );
}

/* ───────────────────────────── the dialog body ───────────────────────────── */

type DialogProps = Omit<NavigationMapProps, 'open'>;

/**
 * The open dialog. Mounted ONLY while `open` is true, so the search state seeds fresh on every
 * open (no reset effect, no ref) and the invoker is captured before any focus can move (#523).
 */
function NavigationMapDialog({
  model,
  onClose,
  onRunVerb,
  platform,
  reducedMotion,
}: DialogProps): React.ReactElement {
  const queryReduced = useNavReducedMotion();
  const motionReduced = reducedMotion ?? queryReduced;

  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const closedRef = React.useRef(false);

  // The element focused before the open flip — captured in the first render, before Ark focuses.
  const [invoker] = React.useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });

  const [search, setSearch] = React.useState<string>(() => seedSearch(model));

  /** Return focus to the invoker; fall back to a still-rendered control OUTSIDE this dialog. */
  const restoreFocus = React.useCallback((): void => {
    if (restoreTransientFocus(invoker) !== null) return;
    const root = contentRef.current;
    const candidates = getFocusableElements(document.body).filter(
      (element) => root === null || !root.contains(element),
    );
    candidates[0]?.focus();
  }, [invoker]);

  /** Close exactly once (Escape / backdrop / close trigger / ran verb share this path). */
  const close = React.useCallback((): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
    restoreFocus();
  }, [onClose, restoreFocus]);

  // Initial focus → the search field (the dialog's own initial-focus wiring is belt-and-braces).
  React.useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // A `more…` seed brings the filtered block into view instantly (never a smooth scroll — the
  // only animated properties on this surface stay opacity/transform).
  React.useEffect(() => {
    if (model.filteredTo === null) return;
    const block = contentRef.current?.querySelector(
      `[${NAV_PLACE_ID_ATTR}="${model.filteredTo}"]`,
    );
    if (block instanceof HTMLElement) scrollIntoViewIfNeeded(block);
  }, [model.filteredTo]);

  // Belt: an external `open` flip (frame close) must still restore focus, never `body`.
  React.useEffect(() => restoreFocus, [restoreFocus]);

  /** Run one verb (guarded on availability) and close per the design. */
  const runVerb = React.useCallback(
    (verb: NavigationMapVerb): void => {
      if (!verb.available) return;
      onRunVerb(verb.verbId);
      close();
    },
    [close, onRunVerb],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const root = contentRef.current;
      if (root === null) return;
      const active = document.activeElement;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }

      if (event.key === 'Tab') {
        const focusables = getFocusableElements(root);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (first === undefined || last === undefined) return;
        // The walk position comes from the EVENT TARGET: the library trap may already have
        // moved focus to the content container by the time this handler runs.
        const origin = event.target instanceof HTMLElement ? event.target : active;
        const outside = !(origin instanceof HTMLElement) || !root.contains(origin);
        if (event.shiftKey) {
          if (origin === first || outside) {
            event.preventDefault();
            event.stopPropagation();
            last.focus();
          }
          return;
        }
        if (origin === last || outside) {
          event.preventDefault();
          event.stopPropagation();
          first.focus();
        }
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const rows = Array.from(
          root.querySelectorAll<HTMLElement>(`[${NAV_VERB_ID_ATTR}]`),
        );
        if (rows.length === 0) return;
        const index = active instanceof HTMLElement ? rows.indexOf(active) : -1;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next =
          index === -1
            ? delta > 0
              ? 0
              : rows.length - 1
            : (index + delta + rows.length) % rows.length;
        event.preventDefault();
        rows[next]?.focus();
        return;
      }

      if (event.key === 'Enter') {
        if (!(active instanceof HTMLElement) || !active.hasAttribute(NAV_VERB_ID_ATTR)) return;
        // Own the activation so the native keydown → click path cannot dispatch twice.
        event.preventDefault();
        if (active.getAttribute(NAV_AVAILABILITY_ATTR) !== 'available') return;
        const verbId = active.getAttribute(NAV_VERB_ID_ATTR);
        if (verbId === null) return;
        onRunVerb(verbId);
        close();
      }
    },
    [close, onRunVerb],
  );

  const query = search.trim().toLowerCase();

  const filteredPlaces: FilteredPlace[] = [];
  for (const place of model.places) {
    const filtered = filterPlace(place, query);
    if (filtered !== null) filteredPlaces.push(filtered);
  }
  const filteredAliases = model.aliases.filter((row) => filterKeyRow(row, query));
  const filteredGlobals = model.globals.filter((row) => filterKeyRow(row, query));
  const empty =
    filteredPlaces.length === 0 &&
    filteredAliases.length === 0 &&
    filteredGlobals.length === 0;

  return (
    <Dialog.Root
      open
      closeOnEscape={false}
      restoreFocus={false}
      trapFocus
      initialFocusEl={() => searchRef.current}
      onOpenChange={(details) => {
        if (!details.open) close();
      }}
    >
      <Dialog.Backdrop
        bg="overlay.scrim"
        onClick={close}
        style={motionReduced ? MAP_NO_MOTION : MAP_BACKDROP_MOTION}
      />
      <Dialog.Positioner>
        <Dialog.Content
          ref={contentRef}
          data-testid={NAV_MAP_TESTID}
          {...{ [NAV_SURFACE_ATTR]: 'map' }}
          role="dialog"
          aria-modal="true"
          aria-label={NAV_MAP_ARIA_LABEL}
          onKeyDown={handleKeyDown}
          display="flex"
          flexDirection="column"
          width="min(92vw, 720px)"
          maxHeight="80vh"
          overflow="hidden"
          bg="bg.surface"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          boxShadow="shadow.dialog"
          style={motionReduced ? MAP_NO_MOTION : MAP_CONTENT_MOTION}
        >
          <style>{MAP_KEYFRAMES}</style>

          <Dialog.Header
            display="flex"
            alignItems="center"
            gap="2"
            px="3"
            py="2"
            borderBottomWidth="1px"
            borderColor="border.subtle"
          >
            <Dialog.Title
              flex="1 1 auto"
              minWidth="0"
              m="0"
              fontSize="md"
              fontWeight="600"
              color="fg.default"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {NAV_MAP_ARIA_LABEL}
            </Dialog.Title>
            <Dialog.CloseTrigger aria-label="Close" onClick={close} />
          </Dialog.Header>

          <Box px="3" py="2" flexShrink={0}>
            <Box position="relative" minWidth="0">
              <Icon
                as={LuSearch}
                aria-hidden="true"
                position="absolute"
                left="2"
                top="50%"
                transform="translateY(-50%)"
                boxSize="3.5"
                color="fg.subtle"
                pointerEvents="none"
              />
              <chakra.input
                ref={searchRef}
                type="text"
                data-testid={NAV_MAP_SEARCH_TESTID}
                aria-label={NAV_MAP_SEARCH_LABEL}
                placeholder={NAV_MAP_SEARCH_LABEL}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                width="100%"
                height="32px"
                pl="8"
                pr="2"
                bg="bg.subtle"
                borderWidth="1px"
                borderColor="border.default"
                borderRadius="sm"
                color="fg.default"
                fontSize="sm"
                _placeholder={{ color: 'fg.subtle' }}
                _hover={{ borderColor: 'accent.border' }}
                _focusVisible={ROW_FOCUS_STYLE}
              />
            </Box>
          </Box>

          <Box flex="1 1 auto" minHeight="0" overflowY="auto" px="3" pb="2">
            {filteredPlaces.map((filtered) => (
              <MapPlaceBlock
                key={filtered.place.placeId}
                place={filtered.place}
                verbs={filtered.verbs}
                keys={filtered.keys}
                platform={platform}
                onRun={runVerb}
              />
            ))}

            <MapKeySection
              title={NAV_MAP_ALIASES_HEADING}
              rows={filteredAliases}
              testId={NAV_MAP_ALIAS_TESTID}
              platform={platform}
            />
            <MapKeySection
              title={NAV_MAP_GLOBALS_HEADING}
              rows={filteredGlobals}
              testId={NAV_MAP_GLOBAL_TESTID}
              platform={platform}
            />

            {empty ? (
              <Box
                data-testid={NAV_MAP_EMPTY_TESTID}
                py="8"
                textAlign="center"
                fontSize="sm"
                color="fg.muted"
              >
                {NAV_MAP_EMPTY_COPY}
              </Box>
            ) : null}
          </Box>

          <Box
            flexShrink={0}
            px="3"
            py="2"
            borderTopWidth="1px"
            borderColor="border.subtle"
            fontSize="2xs"
            color="fg.muted"
          >
            {NAV_MAP_HINT_COPY}
          </Box>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

/* ───────────────────────────── the surface ───────────────────────────── */

/** R-2.1 … R-2.6 — the map. `open={false}` renders nothing at all. */
export function NavigationMap(props: NavigationMapProps): React.ReactElement | null {
  if (!props.open) return null;
  return <NavigationMapDialog {...props} />;
}
