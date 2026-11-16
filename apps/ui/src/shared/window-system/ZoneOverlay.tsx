/**
 * ZoneOverlay — the chord-drag zone drop layer (Spec #2980 ST-4).
 *
 * The demonstrating surface for AC3/R-3.1: while a zone-drag gesture is live
 * (`dragActive`), this layer renders one `zone-target-<zoneId>` per zone of the
 * active layout, positioned at its `resolveZoneRect` px rect, plus the SINGLE
 * `zone-announcer` live region (G-266 — exactly one per workspace; the retired
 * `workspace-announcer` is gone).
 *
 * Ownership (ST-4 sole owner, G-266): `zone-overlay`, every `zone-target-*`,
 * and the one `zone-announcer`. `WindowManager` renders it as a sibling of the
 * tiling layer, only while `dragActive`.
 *
 * Presentation is non-colour-only (G-235): the hovered target carries a 2px
 * `accent.default` border, a `tint()` background, a shadow AND a grid glyph +
 * "Zone k" label, so hover reads with hue off. Every colour is a theme CSS var
 * (`var(--accent-primary)`), a Chakra semantic token (`accent.default`,
 * `border.default`, `fg.default`), or a `tint()` color-mix — no hex/rgba and no
 * `var(--x)NN` alpha-append (#2770).
 *
 * Pure/props-driven: the overlay never reads store or DOM geometry itself; the
 * measured workspace arrives as a `WorkspaceSize` prop (the renderer's state),
 * so `resolveZoneRect` stays the single geometry rule (ST-1, NFR-6).
 */

import { Box } from '@chakra-ui/react';
import { LuLayoutGrid } from 'react-icons/lu';

import { tint } from '../utils/colorTint';
import { resolveZoneRect, type WorkspaceSize, type Zone } from './zoneLayout';

export interface ZoneOverlayProps {
  /** The active layout's zones (empty ⇒ nothing to drop onto). */
  zones: Zone[];
  /** The measured workspace size (`null` ⇒ `resolveZoneRect` fallback). */
  workspace: WorkspaceSize | null;
  /** The configured px gap between zones. */
  gap: number;
  /** The zone under the pointer, or `null` (gap / outside). */
  hoveredZoneId: string | null;
}

/** 1-based human label for a zone ("Zone 1"), used by the hover cue + announcer. */
function zoneLabel(index: number): string {
  return `Zone ${index + 1}`;
}

export function ZoneOverlay({ zones, workspace, gap, hoveredZoneId }: ZoneOverlayProps) {
  const hoveredIndex = zones.findIndex((zone) => zone.id === hoveredZoneId);
  const announcement =
    hoveredIndex >= 0
      ? `Over target: ${zoneLabel(hoveredIndex)}.`
      : `Zone overlay active. ${zones.length} zone${zones.length === 1 ? '' : 's'}.`;

  return (
    <Box data-testid="zone-overlay" position="absolute" inset="0" pointerEvents="none">
      {zones.map((zone, index) => {
        const rect = resolveZoneRect(workspace, zone, gap);
        const hovered = zone.id === hoveredZoneId;
        return (
          <Box
            key={zone.id}
            data-testid={`zone-target-${zone.id}`}
            data-zone-id={zone.id}
            data-hovered={hovered ? 'true' : 'false'}
            position="absolute"
            display="flex"
            alignItems="center"
            justifyContent="center"
            gap="1.5"
            borderWidth={hovered ? '2px' : '1px'}
            borderStyle="solid"
            borderColor={hovered ? 'accent.default' : 'border.default'}
            borderRadius="6px"
            bg={tint('var(--accent-primary)', hovered ? 16 : 6)}
            boxShadow={hovered ? '0 0 0 1px var(--accent-primary)' : 'none'}
            color="fg.default"
            fontFamily="var(--font-primary)"
            fontSize="12px"
            fontWeight="600"
            transition="background 120ms ease, border-color 120ms ease, box-shadow 120ms ease"
            css={{ '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}
            style={{
              top: rect.y,
              left: rect.x,
              width: rect.width,
              height: rect.height,
            }}
          >
            {/* Non-colour hover cue — grid glyph + label (G-235). Rendered only
                while hovered so idle zones stay an unobtrusive tint. */}
            {hovered && (
              <Box display="inline-flex" alignItems="center" gap="1.5">
                <LuLayoutGrid aria-hidden="true" />
                {zoneLabel(index)}
              </Box>
            )}
          </Box>
        );
      })}

      {/* The ONE `zone-announcer` — visually hidden live region (clipPath). */}
      <Box
        data-testid="zone-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        position="absolute"
        width="1px"
        height="1px"
        overflow="hidden"
        style={{ clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}
      >
        {announcement}
      </Box>
    </Box>
  );
}
