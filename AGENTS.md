# Fredo

AI-powered desktop assistant built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend).

## Project Structure

```
apps/
├── tauri/src-tauri/src/     # Rust backend
│   ├── main.rs              # dual-mode entry (GUI vs CLI dispatch)
│   ├── lib.rs               # AppRuntime composition root
│   ├── features/            # autonomous feature modules (no cross-feature imports)
│   ├── infrastructure/      # shared platform services (events, storage, IPC, CLI)
│   ├── runtime/             # AppRuntime + capability traits
│   └── utils/               # stateless helpers
└── ui/src/                  # React frontend
    ├── app/                 # adapters, providers, routes, theme
    ├── features/            # grid-based features (FredoFeatureClass)
    └── shared/              # classes, contexts, hooks, stores, utils
```

## Key Commands

### Tauri (Rust backend)
- `cargo build` — build from `apps/tauri/src-tauri/`
- `pnpm dev:tauri` — run dev server from repo root (Vite on port 5174)

### UI (React frontend)
- `pnpm --filter @fredo/ui build` — build UI library, verify TypeScript
- `pnpm dev:ui` — start Vite dev server from repo root

## Universal Rules

### Backend (Rust/Tauri)
- **No cross-feature imports** — features never import from other features
- **Shared code goes in `infrastructure/`** — no business logic there, only platform services
- **Always use `tauri::async_runtime::spawn`** — never `tokio::spawn` (panics with "no reactor")
- **Register new commands in `lib.rs` → `AppRuntime`**
- **Emit Init + Response event pairs** sharing a `correlationId`
- **Import events from `crate::infrastructure::events`** — `crate::domain::events` no longer exists
- **Zero warnings** — do not suppress with `#[allow(...)]`

### Frontend (React/TypeScript)
- **All grid features extend `FredoFeatureClass`** — see `instructions/ui.md` for full contract
- **Never statically import `@tauri-apps/api`** — only dynamic imports in `TauriAdapter.ts`
- **Use `adapterBridge.invoke()`** for Tauri commands from non-React code
- **Use `crypto.randomUUID()`** — no `uuid` package installed
- **Register features via `registerFeature()` in `index.ts`** — add side-effect import to `allFeatures.ts`
- **Never edit `Home.tsx` to add features** — it calls `getFeatures()` automatically

### Chakra UI v3
- **v3 only** — no `isLoading`, `isDisabled`, `colorScheme`, `leftIcon`
- Use `loading`, `disabled`, `colorPalette`, icons as children
- **Always use theme CSS variables** — never hardcode hex/rgba
- Compound components: `<Tabs.Root>`, `<Dialog.Root>`, `<Field.Root>`

### HostAdapter Pattern
- `apps/ui` is **host-environment-agnostic** — never import browser extension, VS Code, or Tauri APIs directly
- All host integration goes through `HostAdapter` interface (`TauriAdapter`, `DevAdapter`)
- `AppProvider` accepts adapter as prop — never constructs one

## Documentation

- **Tauri patterns**: see `.opencode/instructions/tauri.md`
- **UI patterns**: see `.opencode/instructions/ui.md`
- **Architecture**: see `docs/ARCHITECTURE.md`
- **Coding guidelines**: see `docs/CODING_GUIDELINES.md`
