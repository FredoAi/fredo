---
description: Creates distinctive, production-grade Chakra UI v3 interfaces for Fredo that reject generic AI aesthetics through intentional design choices and theme-aware token usage.
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

## Capsule Integration

This skill is loaded by the Architect when designing capsules for UI features. The architect encodes the aesthetic direction into the capsule's `patterns` field:

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

The Coder receives this capsule and implements accordingly — no skill loading needed at Coder level. The Reviewer checks the PR against these aesthetic patterns alongside functional acceptance criteria.
