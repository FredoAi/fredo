# Adding a Feature (UI)

## Step by Step

1. Create `features/<name>/<Name>Feature.tsx` extending `FredoFeatureClass`
2. Create `features/<name>/index.ts` that calls `registerFeature(instance)`
3. Add `import './<name>'` to `features/allFeatures.ts`
4. Put state/side-effects in `features/<name>/hooks/use<Name>.ts`
5. Put UI in `features/<name>/components/<Name>Panel.tsx`

## Required Members

| Member | Required | Rule |
|--------|----------|------|
| `id` | Yes | Stable kebab-case string, unique across all features |
| `name` | Yes | Display name shown in launcher and window title |
| `icon` | Yes | `IconType` from `react-icons/lu` |
| `eventFilters` | Yes | At least `[]` — defines which stream events reach this feature |
| `processEvent()` | Yes | Route event to component state — no side-effects, no API calls |
| `render()` | Yes | Return a single component — no logic, no hooks here |

## Key Rules

- Never put state or hooks inside `render()` — delegate to a component
- Never call `adapterBridge.invoke()` inside `processEvent()` — it's a pure state router
- `Home.tsx` discovers features automatically via `getFeatures()` — don't edit it