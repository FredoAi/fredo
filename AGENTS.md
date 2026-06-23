# Fredo

Desktop tool for Agents built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend).

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

- `cargo build` — build from `apps/tauri/src-tauri/`
- `pnpm dev:tauri` — run dev server (Vite on port 5174)
- `pnpm --filter @fredo/ui build` — build UI library, verify TypeScript
- `pnpm dev:ui` — start Vite dev server

## Universal Rules

### Backend (Rust/Tauri)
- No cross-feature imports — features never import from other features
- Always use `tauri::async_runtime::spawn` — never `tokio::spawn` (panics with "no reactor")
- Register new commands in `lib.rs` → `AppRuntime`
- Zero warnings — do not suppress with `#[allow(...)]`

### Frontend (React/TypeScript)
- All grid features extend `FredoFeatureClass`
- Never statically import `@tauri-apps/api` — only dynamic imports in `TauriAdapter.ts`
- Use `adapterBridge.invoke()` for Tauri commands from non-React code
- Use `crypto.randomUUID()` — no `uuid` package installed
- Register features via `registerFeature()` in `index.ts`
- Never edit `Home.tsx` to add features — it calls `getFeatures()` automatically
- All public API consumed by `apps/tauri` must be exported from `src/index.ts`

### Chakra UI v3
- v3 only — use `disabled` not `isDisabled`, `loading` not `isLoading`, `colorPalette` not `colorScheme`
- Always use theme CSS variables — never hardcode hex/rgba colors
- Compound components: `<Tabs.Root>`, `<Dialog.Root>`, `<Field.Root>`

## Build Hygiene

- Run `pnpm --filter @fredo/ui build` after UI changes — fix all TypeScript errors
- Run `cargo check` after Rust changes — zero warnings
- Run `pnpm dev:ui` from repo root for Vite dev server

## SDD Pipeline Hygiene

- **Always work from `main`** — never start a new spec from a spec branch. After a spec completes or is abandoned, check out `main` and clean stale branches.
- Run `powershell -File .opencode/scripts/clean-stale-branches.ps1 -DryRun` periodically to find orphaned branches.
- Before creating a new spec, verify: `git branch --show-current` returns `main`. If not, check out main first.
- Pipeline state is tracked in `.opencode/metrics.json` and `.opencode/IMPROVEMENTS.md`. Read both before starting new work to avoid repeating past failures.
- **After modifying any pipeline script, run `powershell -File .opencode/scripts/test-scripts.ps1`** — all tests must pass (count varies; the script reports total/passed/failed/skipped). This catches broken `gh` CLI flags, syntax errors, and API contract changes.
- **Pipeline scripts auto-log failures** to `.opencode/state/script-errors.jsonl` via `.opencode/scripts/_Common.ps1`. Agents never call the logger directly — every nonzero exit from a wrapped script writes a JSONL entry automatically. `retro-append.ps1` surfaces spec-scoped error counts during retrospective.