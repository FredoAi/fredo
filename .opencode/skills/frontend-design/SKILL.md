---
name: frontend-design
description: Creates distinctive, production-grade Chakra UI v3 interfaces for Fredo that reject generic AI aesthetics through intentional design choices and theme-aware token usage. Loaded by the UI/UX Expert and Developer.
---

# Frontend Design — Fredo Edition

This skill guides creation of distinctive, production-grade frontend interfaces for Fredo's React + Chakra UI v3 stack. It prevents generic "AI slop" aesthetics by committing to a bold design direction before writing any component. Every design decision is grounded in Fredo's theme system and Chakra v3 patterns.

## Design Thinking

Before writing any Chakra component, understand the context and commit to a **BOLD aesthetic direction**:

- **Purpose**: What does this interface solve? Who uses it?
- **Tone**: Pick one extreme direction and commit. The architecture, spacing, colors, typography, and motion all derive from this choice.
- **Differentiation**: What makes this UNFORGETTABLE? What's the one detail someone will remember?

**Aesthetic directions with Fredo examples:**

| Direction | Signature traits | Fredo tokens to use |
|---|---|---|
| **Brutalist/raw** | Bold `fg.default` text, `border.default` visible borders, mono headings via `JetBrains Mono`, zero-radius, asymmetric `SimpleGrid`, no shadows | `fg.default`, `border.default`, `border.subtle`, `bg.canvas` |
| **Luxury/refined** | `bg.surface` cards with deep shadows, serif via `--font-primary`, generous spacing (gap: 6-8), staggered fade-ins, gold/amber accents via `accent.default` | `bg.surface`, `accent.default`, `accent.emphasized`, `status.success` (muted gold) |
| **Playful/toy-like** | Heavy `borderRadius`, `accent.default` pops, `LuIcon` emphasis, bouncy CSS transitions, colorful `status.*` tags, rounded pills | `accent.default`, `status.success`, `status.warning`, `status.error`, `status.info` |
| **Editorial/magazine** | `fg.muted` body, strong heading hierarchy (xl→lg→md), clean `SimpleGrid` layouts, minimal chrome, `--font-primary` for titles, generous whitespace | `fg.default`, `fg.muted`, `bg.canvas` |
| **Industrial/utilitarian** | Flat `bg.canvas`, `border.subtle` horizontal dividers via `<Separator />`, dense `Table` layouts, no decoration, tight spacing (gap: 2-3), data-first | `bg.canvas`, `bg.subtle`, `border.subtle`, `fg.muted` |
| **Organic/natural** | Soft `bg.subtle` backgrounds, green `status.success` hues, irregular spacing, no hard borders, rounded `bg.muted` hover states, nature-inspired icon choices | `bg.subtle`, `bg.muted`, `status.success`, `status.info` |
| **Retro-futuristic** | High-contrast `bg.canvas` + `accent.default`, `JetBrains Mono` for labels, neon-glow borders via box-shadow, angular `<Separator />` dividers, data display emphasis | `bg.canvas`, `accent.default`, `accent.emphasized`, `fg.default` |

**CRITICAL**: Pick ONE direction and execute it with precision. Refined minimalism and bold maximalism both work — what fails is indecision. The worst outcome is a generic Chakra default that could be from any project.

## Fredo Theme System

All visual values come from the theme, never hardcoded. Fredo bridges CSS custom properties into Chakra semantic tokens in `apps/ui/src/app/theme/system.ts`:

### Background tokens

| Token | Maps to | Use for |
|---|---|---|
| `bg.canvas` | `var(--body-bg)` | Page background |
| `bg.surface` | `var(--card-bg)` | Cards, dialogs, popovers |
| `bg.subtle` | `var(--header-bg)` | Headers, tabs, subtle sections |
| `bg.muted` | `var(--card-hover-bg)` | Hover states, selected items |

### Foreground tokens

| Token | Maps to | Use for |
|---|---|---|
| `fg.default` | `var(--text-primary)` | Body text, primary content |
| `fg.muted` | `var(--text-secondary)` | Captions, descriptions, placeholders |

### Accent tokens

| Token | Maps to | Use for |
|---|---|---|
| `accent.default` | `var(--accent-primary)` | Primary buttons, links, focus rings |
| `accent.emphasized` | `var(--accent-secondary)` | Hover/active states, highlights |

### Status tokens

| Token | Maps to |
|---|---|
| `status.success` | `var(--status-success)` |
| `status.warning` | `var(--status-warning)` |
| `status.error` | `var(--status-error)` |
| `status.info` | `var(--status-info)` |

### Font tokens

| Token | Value | Use for |
|---|---|---|
| `fonts.heading` | `var(--font-primary)` | Titles, headings, feature names |
| `fonts.body` | `var(--font-base)` | Body text, labels, inputs |
| `fonts.mono` | `'JetBrains Mono', 'Fira Mono', monospace` | Code, data, technical labels |

### Usage in components

```tsx
<Box bg="bg.canvas" color="fg.default">
  <Heading fontFamily="heading" size="xl">Title</Heading>
  <Text color="fg.muted">Description</Text>
  <Button colorPalette="green">  {/* status.success mapping */}
    Confirm
  </Button>
</Box>
```

Never use `bg="white"`, `bg="gray.100"`, `color="black"`, or any hex/rgba value. Always use semantic tokens.

### The Color Rule

All colors live in the theming feature. The flow is **token → CSS var → theme**:

```
Chakra semantic token (system.ts) → CSS var (ThemeProvider) → user theme (light/dark + accent)
bg.surface / accent.default / status.* → --card-bg / --accent-primary / --status-* → theming feature
```

- Components read a **token** (`bg="bg.surface"`) or its **var** (`bg="var(--card-bg)"`) — never a raw hex/rgba.
- **Tints/hover states append alpha to the var:** `bg="var(--accent-primary)22"`, `borderColor="var(--status-error)55"`. This derives from the user's chosen accent; `rgba(147,51,234,0.2)` does NOT (it is a frozen purple that ignores the accent setting). This is the sanctioned way to do translucent backgrounds/borders.
- **Token-first:** a color with no token does not exist yet. Add it to the theming feature FIRST — a semantic token in `apps/ui/src/app/theme/system.ts` mapped to a CSS var with **both light and dark values** in the theme — then use it. Never inline a one-off color in a component.
- Allowed raw literals: `transparent`, `inherit`, `currentColor`, `none`, and data/art palettes that are not UI chrome (terminal ANSI colors, 3D canvas particles). Migrate even those to theme vars where feasible.
- If a component needs a color that the theming feature does not expose (e.g. a graph node status palette), the requirement goes back to the theming feature — do not hardcode it in the component.

## Chakra v3 Distinctive Patterns

Go beyond Chakra defaults. Every component should feel intentional, not framework-generated.

### Card

```tsx
// DON'T — generic, could be any AI output
<Card.Root>
  <Card.Body>
    <Heading>Feature</Heading>
    <Text>Description</Text>
  </Card.Body>
</Card.Root>

// DO — intentional aesthetic (luxury example)
<Card.Root
  bg="bg.surface"
  borderRadius="xl"
  boxShadow="0 4px 24px rgba(0,0,0,0.08)"
  transition="transform 0.2s"
  _hover={{ transform: 'translateY(-2px)' }}
>
  <Card.Body gap="6" p="6">
    <Heading as="h3" fontFamily="heading" size="lg">Feature</Heading>
    <Text color="fg.muted" lineHeight="1.7">Description</Text>
    <Button colorPalette="green" variant="subtle">
      <LuIcon /> Explore
    </Button>
  </Card.Body>
</Card.Root>
```

### Buttons

Match aesthetic: luxury uses `variant="subtle"` with low opacity, industrial uses `variant="outline"`, playful uses `variant="solid"` with status colors.

```tsx
// Luxury: understated
<Button variant="subtle" colorPalette="green">Confirm</Button>

// Industrial: visible borders
<Button variant="outline" borderRadius="sm">Execute</Button>

// Playful: bold color pops
<Button variant="solid" colorPalette="green" borderRadius="full">
  <LaughIcon /> Let's go!
</Button>
```

### Spacing

Spacing conveys aesthetic as much as color does. Use Chakra's gap/spacing props purposefully:

| Aesthetic | Gap | Padding | Purpose |
|---|---|---|---|
| Industrial | 2-3 | 3-4 | Dense, information-first |
| Luxury | 6-8 | 6-8 | Breathing room, refinement |
| Brutalist | 4-5 | 4-6 | Deliberate, not cramped |
| Playful | 5-6 | 5-6 | Comfortable but energetic |

### Typography hierarchy

Every aesthetic needs a clear heading scale. Use Chakra's `size` prop on `Heading`:

```tsx
<Heading as="h2" fontFamily="heading" size="2xl">Hero</Heading>
<Heading as="h3" fontFamily="heading" size="xl">Section</Heading>
<Heading as="h4" fontFamily="heading" size="lg">Subsection</Heading>
```

## What to AVOID

These patterns scream "an AI wrote this." Fredo's UIs must never include:

**Layout crimes:**
- `<Stack>` + `<Heading>` + `<Text>` + `<Button>` — the "welcome to my app" starter template. Boring.
- Identical cards in a grid with no visual hierarchy — no hero card, no emphasis
- `gap="4"` on everything — spacing should be intentional per aesthetic
- Centered everything — asymmetry creates energy

**Color crimes:**
- Default Chakra gray backgrounds (`bg="gray.50"`, `bg="gray.100"`)
- Default Chakra blue colorPalette (`colorPalette="blue"`)
- Any hex or rgba value — use tokens or recipes

**Typography crimes:**
- Headings without `fontFamily="heading"` — uses fallback Inter
- All text at `size="md"` — create hierarchy
- Mono font for body text — use `fonts.body`

**Component crimes:**
- `Card.Root` with zero customization (no bg, no shadow, no border)
- `Button` without a `variant` — AI default is just `<Button>Click</Button>`
- `<Box>` everywhere instead of semantic components (`Flex`, `SimpleGrid`, `Card`)

## Motion

Use CSS transitions via Chakra's `_hover`, `_active`, and `transition` style props. No external animation library needed.

```tsx
// Subtle hover lift (luxury)
<Box
  transition="transform 0.2s ease, box-shadow 0.2s ease"
  _hover={{ transform: 'translateY(-2px)', boxShadow: 'lg' }}
>

// Fade-in entrance (any aesthetic)
<Box
  animation="fadeIn 0.5s ease forwards"
  sx={{
    '@keyframes fadeIn': {
      '0%': { opacity: 0, transform: 'translateY(8px)' },
      '100%': { opacity: 1, transform: 'translateY(0)' },
    },
  }}
>

// Staggered children
<Stack>
  {items.map((item, i) => (
    <Box key={item.id} animation={`fadeIn 0.4s ease ${i * 0.1}s forwards`}>
```

Motion principles:
- One entrance animation per page. Don't bounce everything.
- Stagger children, don't animate parent containers
- `0.15s–0.3s` for micro-interactions (hover, focus)
- `0.4s–0.6s` for entrances
- No spinning, pulsing, or rainbow effects — tasteful > flashy

## Perception & Response Time (Cognitive Load + Doherty Threshold)

Design for the user's working-memory budget (~3-5 chunks) and the interaction-loop deadline
(400 ms). Full research + sources live in `docs/agentic-pipeline/playbooks/ui-ux-expert.md`
("Design principles: Cognitive Load & the Doherty Threshold") and `references.md`. Rules that
apply when building any component:

- **Instant interactive feedback** — every hover/click/selection responds < 400 ms (aim < 100 ms,
  INP ≤ 200 ms) with synchronous local visual states (Chakra `_hover`, `_active`, `_selected`).
  Never disable feedback pending an IPC round-trip.
- **Optimistic UI** — for async actions (send, toggle, stop) show the new state immediately and
  reconcile when the backend confirms. A spinner is a last resort, never the default.
- **Skeletons over spinners** — async panels use Chakra `Skeleton`/`SkeletonText` (structure +
  progress) not an indefinite spinner. 1-9 s loads: looped indicator + descriptive text. ≥ 10 s:
  percent/step-count + text + a cancel affordance.
- **One panel = one question** — group data into single-purpose chunks; keep live feeds bounded;
  never repeat the same datum in two always-on places (redundancy effect).
- **Progressive disclosure ≤ 2 levels** — core info visible at a glance; detail (payloads, raw
  values) in a drawer/hover. Recognition over recall: system state is always visible.
- **Stable layout + animated change** — new content appears in place; animate state transitions
  150-300 ms using only `transform`/`opacity` (inside the 16.67 ms frame budget, GPU-cheap,
  respect `prefers-reduced-motion`). Silent re-renders are invisible (change blindness).
- **Never block the main thread** — synchronous work in ≤ 50 ms slices; defer/batch heavy work;
  keep interactive chrome responsive while streaming.

## Capsule Integration

This skill is loaded by the UI/UX Expert when designing capsules for UI features. The UI/UX Expert encodes the aesthetic direction into the capsule's `patterns` field:

```yaml
patterns:
  - Chakra v3: use <Card.Root> with shadow and generous padding
  - Aesthetic: luxury — serif headings via fonts.heading, gold accent via accent.default,
    generous spacing (gap: 6), staggered fade-in on mount
  - Tokens: bg.surface for cards, accent.default for primary actions,
    status.success for confirmations, fonts.heading for titles, fonts.body for text
  - Avoid: default gray backgrounds, zero-shadow cards, Inter font, gap: 4,
    centered <Stack> layouts
  - Motion: 0.4s fade-in entrance with stagger (0.1s per child), 0.2s hover lift on cards
```

The Developer receives this capsule and implements accordingly — no skill loading needed at Developer level. The Self-Improver (orchestrator) checks the PR against these aesthetic patterns alongside functional acceptance criteria.
