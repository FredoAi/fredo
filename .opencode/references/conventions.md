# Project Conventions

> Shared conventions extracted from AGENTS.md and agent prompts. Referenced by all agents.

## Chakra UI v3

- Only v3 patterns: `disabled` not `isDisabled`, `loading` not `isLoading`, `colorPalette` not `colorScheme`
- Always use theme CSS variables — never hardcode hex/rgba colors
- Compound components: `<Tabs.Root>`, `<Dialog.Root>`, `<Field.Root>`, `<Card.Root>` + `<Card.Body>`
- Buttons: `colorPalette` + `variant`. Primary: `colorPalette="blue"`, Danger: `colorPalette="red"`, Neutral: `colorPalette="gray"`
- Surfaces: semantic tokens (`bg.surface`, `bg.canvas`, `fg.default`, `fg.muted`)

## Build Hygiene

- Frontend: `pnpm --filter @fredo/ui build` before committing
- Backend: `cargo check` before committing
- Never push code that doesn't compile
- After modifying any pipeline script: `powershell -File .opencode/scripts/test-scripts.ps1`

## GitHub Commands

- Always use `--body-file` for all `gh` commands that accept body content
- Never use heredoc/string interpolation for body content in `gh` commands

## Commit Messages

```
feat(ui): description
fix(settings): description
```

## Rust

- Always use `tauri::async_runtime::spawn` — never `tokio::spawn`
- No cross-feature imports — features never import from other features
- Register new commands in `lib.rs`
- Zero warnings — do not suppress with `#[allow(...)]`

## TypeScript

- All grid features extend `FredoFeatureClass`
- Never statically import `@tauri-apps/api` — only dynamic imports in `TauriAdapter.ts`
- Use `adapterBridge.invoke()` for Tauri commands from non-React code
- Use `crypto.randomUUID()` — no `uuid` package installed

## Agent Signatures

- All GitHub content signed with `*Authored by <Role>*` — never use model name, human name, or git config user
