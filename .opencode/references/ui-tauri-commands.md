# Calling Tauri Commands from UI

## Pattern

```typescript
import { adapterBridge } from '../../../shared/utils/adapterBridge';

// In a hook or component (NOT in FredoFeatureClass methods)
const result = await adapterBridge.invoke<ReturnType>('command_name', { arg: value });
```

## Key Rules

- NEVER import `@tauri-apps/api` directly anywhere in `apps/ui`
- The only place `@tauri-apps/api` is allowed is `TauriAdapter.ts` using a dynamic import
- Always use `adapterBridge.invoke()` for Tauri commands
- Type the return value with a generic parameter