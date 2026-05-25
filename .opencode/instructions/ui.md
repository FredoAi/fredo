---
description: Fredo Shared UI Library (@fredo/ui) - Vite, React, Chakra UI, HostAdapter pattern
applyTo: 'apps/ui/**'
---

## Feature Class — Required for Every Grid Feature

All features that render in the Home grid MUST extend `FredoFeatureClass`. Required members: `id`, `name`, `icon`, `eventFilters`, `processEvent()`, `render()`. Optional: `showable`, `isMultiWindow`, `hasSettings`, `onMount()`, `onUnmount()`.

Never put state or hooks inside `render()`. Never call `adapterBridge.invoke()` inside `processEvent()`. Register via `registerFeature()` in `index.ts`, import in `allFeatures.ts`.

## Chakra UI v3

| v2 (forbidden) | v3 (correct) |
|---|---|
| `isLoading` | `loading` |
| `isDisabled` | `disabled` |
| `colorScheme="blue"` | `background="var(--accent-primary)"` |
| `leftIcon={<Icon />}` | `<Icon /> text` as children |
| `<Tabs>` flat API | `<Tabs.Root><Tabs.List><Tabs.Trigger>` |

Always use CSS theme variables — never hardcode hex/rgba colors.

## HostAdapter Pattern

Never import `@tauri-apps/api` directly. Use `adapterBridge.invoke()` for Tauri commands. The only exception is `TauriAdapter.ts` using dynamic import.

## IDs

Use `crypto.randomUUID()` — no `uuid` package installed.

## Exports

All public API consumed by `apps/tauri` must be exported from `src/index.ts`.

## Build

- `pnpm --filter @fredo/ui build` — build and verify TypeScript
- `pnpm dev:ui` — start Vite dev server

## References

- Adding a feature: `.opencode/references/ui-feature-guide.md`
- Stream events: `.opencode/references/ui-stream-events.md`
- Tauri commands: `.opencode/references/ui-tauri-commands.md`
- Feature class template: `.opencode/references/feature-class-template.md`
- Lucide icons: `.opencode/references/lucide-icons.md`