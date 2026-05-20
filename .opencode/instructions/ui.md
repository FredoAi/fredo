---
description: Atlas Shared UI Library (@atlas/ui) - Vite, React, Chakra UI, HostAdapter pattern
applyTo: 'apps/ui/**'
---

## Feature Class — Required for Every Grid Feature

All features that render in the Home grid **must** extend `AtlasFeatureClass`. Enforce these when adding or editing any feature:

| Member | Required | Rule |
|---|---|---|
| `id` | ✅ | Stable kebab-case string, unique across all features |
| `name` | ✅ | Display name shown in launcher and window title |
| `icon` | ✅ | `IconType` from `react-icons/lu` |
| `eventFilters` | ✅ | At least `[]` — defines which stream events reach this feature |
| `processEvent()` | ✅ | Route event to component state — no side-effects, no API calls |
| `render()` | ✅ | Return a single component — no logic, no hooks here |
| `showable` | opt | `true` to appear in app launcher |
| `isMultiWindow` | opt | `true` to spawn a new instance per triggering event |
| `hasSettings` | opt | `true` requires implementing `renderSettings()` |
| `onMount()` | opt | Invoke Tauri commands on window open |
| `onUnmount()` | opt | Cleanup on window close |

**Never** put state or hooks inside `render()` — delegate to a component.  
**Never** call `adapterBridge.invoke()` inside `processEvent()` — it's a pure state router; trigger side-effects from hooks or `onMount`.  
**Register** every new feature by calling `registerFeature(instance)` in the feature's `index.ts`, then adding `import './<name>'` to `allFeatures.ts`. Do **not** edit `Home.tsx` to add features — it calls `getFeatures()` automatically.

## Adding a Feature — Step by Step

1. Create `features/<name>/<Name>Feature.tsx` extending `AtlasFeatureClass`
2. Create `features/<name>/index.ts` that calls `registerFeature(new <Name>Feature())`
3. Add `import './<name>'` (side-effect only) to `features/allFeatures.ts`
4. Put state/side-effects in `features/<name>/hooks/use<Name>.ts`
5. Put UI in `features/<name>/components/<Name>Panel.tsx`

`Home.tsx` discovers features automatically via `import '../../allFeatures'` + `getFeatures()`. No manual wiring in `Home.tsx` needed.

## Lucide Icons (`react-icons/lu`) — Naming Rules

Lucide v0.400+ follows a strict **`<Shape><Modifier>`** convention. Many old names are gone — importing them throws a runtime `SyntaxError`.

### Naming pattern
- Shape first, modifier second: `CircleAlert` not `AlertCircle`, `TriangleAlert` not `AlertTriangle`
- Always verify the export exists in the installed version before using a new icon

### Common renames (old → new)
| ❌ Old name (broken) | ✅ New name |
|---|---|
| `LuAlertCircle` | `LuCircleAlert` |
| `LuAlertTriangle` | `LuTriangleAlert` |
| `LuAlertOctagon` | `LuOctagonAlert` |
| `LuCheckCircle` | `LuCircleCheck` |
| `LuCheckCircle2` | `LuCircleCheckBig` |
| `LuXCircle` | `LuCircleX` |
| `LuMinusCircle` | `LuCircleMinus` |
| `LuPlusCircle` | `LuCirclePlus` |
| `LuInfoCircle` | `LuCircleInfo` |
| `LuArrowRightCircle` | `LuCircleArrowRight` |
| `LuSlash` | `LuCircleSlash` |

When in doubt, search the [Lucide icon list](https://lucide.dev/icons/) for the current name.

---

## Calling Tauri Commands

Use `adapterBridge` — the singleton that decouples UI from the host environment:

```typescript
import { adapterBridge } from '../../../shared/utils/adapterBridge';

// In a hook or component (NOT in AtlasFeatureClass methods)
const result = await adapterBridge.invoke<ReturnType>('command_name', { arg: value });
```

**Never** import `@tauri-apps/api` directly anywhere in `apps/ui` — it breaks dev/non-Tauri builds.  
The only place it's allowed is `TauriAdapter.ts` using a dynamic import.

## Consuming Stream Events in Components

Use `useStream()` from `StreamContext` to read events reactively:

```typescript
import { useStream } from '../../../shared/contexts/StreamContext';

const { events } = useStream();
const mine = events.filter(e => e.toolName === 'my_tool' && e.correlationId === currentId);
```

Always filter by both `toolName` and `correlationId` to avoid processing unrelated events.

## Chakra UI v3 Rules

This project uses **Chakra UI v3** — these v2 props do not exist and will silently fail or error:

| ❌ v2 (forbidden) | ✅ v3 (correct) |
|---|---|
| `isLoading` | `loading` |
| `isDisabled` | `disabled` |
| `colorScheme="blue"` | `background="var(--accent-primary)"` |
| `leftIcon={<Icon />}` | `<Icon /> text` as children |
| `<Tabs>` flat API | `<Tabs.Root><Tabs.List><Tabs.Trigger>` |

Always use CSS theme variables for colors — never hardcode hex/rgba:
```tsx
// ✅
<Box background="var(--card-bg)" color="var(--text-primary)" borderColor="var(--border-color)" />

// ❌
<Box background="#1e1e32" color="#fff" borderColor="purple" />
```

## IDs — No uuid Package

Use the built-in browser API:
```typescript
// ✅
const id = crypto.randomUUID();

// ❌ — uuid is not installed in apps/ui
import { v4 as uuidv4 } from 'uuid';
```

## Build Hygiene

- Run `pnpm --filter @atlas/ui build` after changes — fix all TypeScript errors before finishing
- Run from repo root: `pnpm dev:ui` (Vite on port 5174)
- All public API consumed by `apps/tauri` must be exported from `src/index.ts`


## Commands
- `pnpm dev:ui` - Start the Vite dev server (run from repo root)
- `pnpm build` - Build the library for production

## HostAdapter Pattern (CRITICAL — READ BEFORE WRITING ANY CODE)

`apps/ui` is a **host-environment-agnostic** React application. It must NEVER import or call any
browser extension API (`chrome.*`, `browser.*`), VS Code API (`vscode.*`), or any other
environment-specific API directly.

All host-environment integration goes through the **HostAdapter interface**:

```typescript
// src/app/adapters/HostAdapter.ts
export interface HostAdapter {
  /** Subscribe to messages from the host. Returns an unsubscribe fn. */
  onMessage(handler: (msg: any) => void): () => void;
}
```

### Implementations
| Adapter | Location | Environment |
|---------|----------|-----------|
| `DevAdapter` | `src/app/adapters/DevAdapter.ts` | Vite dev server — in-memory event emitter |
| `TauriAdapter` | `src/app/adapters/TauriAdapter.ts` | Tauri desktop app — listens for `atlas-stream-event` via `@tauri-apps/api/event` |

### How AppProvider Consumes the Adapter
```tsx
// AppProvider accepts the adapter as a prop — it never constructs one itself
<AppProvider adapter={new DevAdapter()}>
  <Router />
</AppProvider>
```

### DevAdapter Reference Implementation
```typescript
export class DevAdapter implements HostAdapter {
  private handlers: ((msg: any) => void)[] = [];

  constructor() {
    // Expose on window for quick manual testing in dev
    if (typeof window !== 'undefined') {
      (window as any).__devAdapter = this;
    }
  }

  onMessage(handler: (msg: any) => void): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter(h => h !== handler); };
  }

  /** Manually emit any message — useful for dev-time testing */
  emit(msg: any): void {
    this.handlers.forEach(h => h(msg));
  }
}
```

**Dev testing** (browser console):
```js
window.__devAdapter.emit({ type: 'ATLAS_HANDSHAKE', data: { connectionId: 'test-123' } })
```

### TauriAdapter Reference Implementation
```typescript
export class TauriAdapter implements HostAdapter {
  onMessage(handler: (msg: any) => void): () => void {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // Dynamic import avoids breaking non-Tauri build contexts
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<unknown>('atlas-stream-event', (event) => handler(event.payload)))
      .then((fn) => { cancelled ? fn() : (unlisten = fn); })
      .catch((err) => console.error('[TauriAdapter] Failed to subscribe:', err));

    return () => { cancelled = true; unlisten?.(); };
  }
}
```

### Rules for HostAdapter
```typescript
// ✅ CORRECT — interact with the host via the adapter
onMessage(handler) { ... }   // the only method on HostAdapter

// ❌ WRONG — directly accessing host environment APIs in apps/ui
import { listen } from '@tauri-apps/api/event';   // Tauri API forbidden directly in apps/ui
```

---

## Theme System (CRITICAL)
**ALWAYS use theme CSS variables for colors** - Never hardcode RGB/hex colors in components.

### Available Theme Variables
```css
/* Backgrounds */
--body-bg          /* Main background */
--header-bg        /* Header/toolbar background */
--footer-bg        /* Footer background */
--card-bg          /* Card/panel background */
--card-hover-bg    /* Card hover state */

/* Text */
--text-primary     /* Primary text color */
--text-secondary   /* Secondary/muted text */

/* Accents & Borders */
--border-color     /* Borders and dividers */
--accent-primary   /* Primary brand color (purple) */
--accent-secondary /* Secondary accent color */

/* Status Colors */
--status-success   /* Success states */
--status-warning   /* Warning states */
--status-error     /* Error states */
--status-info      /* Info states */

/* Special */
--gradient-text    /* Text gradients */
--gradient-button  /* Button gradients */
--node-bg          /* ReactFlow node background */
--node-box-shadow  /* Node shadows */
--edge-gradient    /* ReactFlow edge colors */

/* Typography */
--font-family      /* Primary font stack */
--font-primary     /* Primary font */
--font-secondary   /* Secondary font */
--font-base        /* Base font size */
```

### Usage Examples
```tsx
// ✅ CORRECT - Uses theme variables
<Box background="var(--card-bg)" color="var(--text-primary)">
<Button background="var(--accent-primary)" />
<div style={{ borderColor: 'var(--border-color)' }} />

// ❌ WRONG - Hardcoded colors
<Box background="rgba(30, 30, 50, 0.7)" color="#ffffff">
<Button background="#9333ea" />
<div style={{ borderColor: 'purple' }} />
```

---

## Feature Class Architecture (CRITICAL — MUST USE FOR NEW FEATURES)

**ALL new grid-based features MUST extend AtlasFeatureClass**

### When to Use Feature Class
✅ **MUST USE** for:
- Features that render in the Home grid
- Features that process stream events
- Features with lifecycle needs (mount/unmount)
- Features that can be closed/maximized by users

❌ **DO NOT USE** for:
- Fixed-position UI components
- Modal/overlay components (Settings dialogs)
- Fallback/empty states (Dashboard)

### Feature Class Template
```typescript
import React from 'react';
import { AtlasFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { LuIcon } from 'react-icons/lu';

export class MyFeature extends AtlasFeatureClass {
  readonly name = 'My Feature Name';
  readonly icon = LuIcon;

  readonly eventFilters: EventFilter[] = [
    { toolNames: ['tool_name'] }
  ];

  processEvent(event: StreamEvent): void {
    // Handle incoming stream events
  }

  render() {
    return <MyComponent />;
  }

  onMount() {}
  onUnmount() {}
}

export const myFeature = new MyFeature();
```

### Event Filtering
```typescript
readonly eventFilters: EventFilter[] = [
  { toolNames: ['infrastructure_stream', 'k8s_diagram'] },
  { states: ['init', 'response'] },
  { custom: (event) => event.toolName.includes('query') }
];
```

### Feature File Structure
```
features/
└── my-feature/
    ├── MyFeature.tsx          # Feature class (REQUIRED)
    ├── components/
    │   └── MyComponent.tsx
    ├── hooks/
    ├── types/
    └── index.ts               # Re-export feature class
```

---

## Exports (CRITICAL)
All public API must be exported from `src/index.ts`. If you create a new component, hook,
context, or adapter that consumers (`apps/tauri`) need to import, add it to `src/index.ts`.

```typescript
// ✅ CORRECT
import { AppProvider, Router } from '@atlas/ui';

// ❌ WRONG — deep-path imports bypass the public API contract
import { AppProvider } from '@atlas/ui/src/app/providers/AppProvider';
```

---

## File Structure
```
apps/ui/
├── src/
│   ├── index.ts                          # Barrel export — all public API
│   ├── main.tsx                          # Dev entry (DevAdapter, not exported)
│   ├── style.css                         # Global styles + CSS variables
│   ├── app/
│   │   ├── adapters/
│   │   │   ├── HostAdapter.ts            # Interface — THE portability contract
│   │   │   └── DevAdapter.ts             # Dev adapter (localStorage + mock emitter)
│   │   ├── providers/
│   │   │   ├── AppProvider.tsx           # SSE state root, accepts adapter prop
│   │   │   ├── ThemeProvider.tsx         # localStorage-based theme
│   │   │   └── ExtensionProvider.tsx     # Shim re-export for legacy imports
│   │   ├── routes/
│   │   │   └── Router.tsx
│   │   └── types/
│   ├── features/                         # 12 feature modules
│   │   ├── alerts/
│   │   ├── azdo-create-workitem/         # AtlasFeatureClass
│   │   ├── dashboard/
│   │   ├── dev-mode/
│   │   ├── diagram/                      # AtlasFeatureClass
│   │   ├── home/
│   │   ├── jira-create-issue/
│   │   ├── my-workitems/
│   │   ├── profile-settings/
│   │   ├── query-viewer/                 # AtlasFeatureClass
│   │   └── settings/
│   └── shared/
│       ├── classes/
│       │   └── AtlasFeatureClass.ts     # Base class for all grid features
│       ├── components/
│       │   └── animations/               # Cubes, Hyperspeed, MagnetLines
│       ├── constants/
│       ├── contexts/
│       │   ├── StreamContext.tsx         # SSE event handling
│       │   └── ThemeContext.tsx
│       ├── hooks/
│       │   └── useStreamService.ts
│       ├── stores/                       # Zustand stores
│       └── utils/
│           └── apiAuth.ts               # auth utilities (no-op stubs — no auth required)
├── package.json
├── tsconfig.json
└── vite.config.ts
```
