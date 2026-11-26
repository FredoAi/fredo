# Authoring claims — the allowlist behind `docs/authoring-applications.md`

Every **normative** statement in `docs/authoring-applications.md` carries a claim marker of the form
`<!-- claim:C-nn -->`. This ledger has exactly one row per marker.

- **What the document asserts** quotes the load-bearing sentence(s) the marker covers.
- **Satisfied by** names the shipped `file:line` or a named mechanism that proves it. A citation here
  must resolve at the served head; a citation that resolves but does not support the row is a defect.
- **REQ** is the requirement the statement serves (`docs/agentic-pipeline` numbering from the
  `#3145` plan: R-1.1…R-1.3, R-2.1, R-2.2, R-4, R-5.1, R-5.2, NFR-1…NFR-6).

No row states a value the product derives (a resolved colour, a runtime version, a measured count) in
place of the mechanism; where a count or a constant is part of the published contract it is named as
the contract's own constant.

> **Kit artefact paths.** `packages/fredo-theme/**` and `packages/fredo-authoring/**` are the
> published kit (sub-tasks ST-1 and ST-2 of `#3145`). They land in the same spec branch as this
> ledger; the tester resolves them at the served head. Every citation to a kit path is additionally
> backed by a shipped product mechanism in the same row, so the product claim never rests on the kit
> alone.

## Build and load your first application

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-01 | The kit is two generated package directories plus this guide; every file is committed and copyable; there is no registry step and no command that downloads anything. | `packages/fredo-theme/` and `packages/fredo-authoring/` (generated `dist/**`, `schema/**`, `bin/**`); no registry client in either package (`package.json` has no runtime dependencies) — F-8.6(b) | R-1.1, NFR-3 |
| C-02 | Node.js is the only toolchain the kit needs; its commands use Node built-in modules only. | `packages/fredo-authoring/bin/fredo-app.mjs` (imports only `node:*`); `packages/fredo-theme/scripts/build-theme.mjs` (same); the suite's own precedent `.opencode/tests/installable-apps/README.md:49-51` | R-1.1, NFR-3 |
| C-03 | The six documented steps are the whole path; every command names a kit file or a path in the author's own folder; no step needs a Fredo source checkout. | `docs/authoring-applications.md` § "Build and load your first application" (steps S1–S6) as executed by `.opencode/tests/installable-apps/authoring-exam.mjs` (`DOCUMENTED-PATH`); F-8.2 | R-1.1 |
| C-04 | `fredo-app --help` exits `0` and lists exactly `check` and `pack` — no `init`, `new` or `scaffold`. | `packages/fredo-authoring/bin/fredo-app.mjs` verb table; F-8.6(c) | R-1.1, NFR-3 |
| C-05 | A published file is reachable at runtime only by being part of the installed package (the install record is the serve whitelist); a bare specifier never resolves in the child; `vendor/` is the correct shape and `pack` archives it like any other file. | `apps/tauri/src-tauri/src/applications/installed_apps/scheme.rs` serve path (record-pinned files only) and `docs/ARCHITECTURE.md:1089` ("An unrecorded file has no route (the record is the whitelist)"); `pack`'s recursive walk (`packages/fredo-authoring/bin/fredo-app.mjs`) | R-1.3, NFR-5 |
| C-06 | `check` exits `0` with an empty `violations` array on a valid package, and otherwise prints `{ code, field?, detail }` per violation and exits non-zero; `field` is the exact dotted manifest path. | `packages/fredo-authoring/bin/fredo-app.mjs`; the error shape is `apps/tauri/src-tauri/src/applications/installed_apps/mod.rs:264-277` (`InstalledAppError { code, detail, field? }`); the dotted paths are threaded in `manifest.rs:445-466,553-557,581-605,787,800-810,856-883`; F-8.20 | R-5.2 |
| C-07 | `pack` validates before emitting; the archive is deterministic (fixed entry order, stored entries, a fixed timestamp), so two packs of the same input are byte-identical; use a second output path so a measured artifact is never re-written. | `packages/fredo-authoring/bin/fredo-app.mjs` (deterministic writer — NFR-3); the determinism rule is proved by the suite's generators (`README.md:53-68`) and driven by F-8.5 | NFR-3 |
| C-08 | Install is the normal Settings → Installed applications path (the same command the button calls); a valid package shows the success strip, appears on the launcher shelf, and opens in its own window with the app's UI painted. | `apps/tauri/src-tauri/src/applications/installed_apps/commands_install.rs:107` (`installed_app_install`); `apps/ui/src/applications/settings-app/components/InstalledAppsSettings.tsx:84,322,355` (label + testids); `apps/tauri/src-tauri/src/applications/installed_apps/window.rs` (per-app window); F-8.4 | R-1.2 |
| C-09 | Every `import`/`from` in the package must be a relative path resolving to a file the package carries; host-internal modules and bare package names are not served and the app fails to load. | `scheme.rs` route rule (a file resolves only inside `<id>/files/`; the record is the whitelist) and the child policy `script-src 'self'` (`docs/ARCHITECTURE.md:1089,1091`); the three negative loads are F-8.14 | R-1.3, NFR-5 |

## §1 What your application may rely on

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-10 | A package is a zip with `fredo-app.json` at the archive root; entry paths are relative POSIX paths naming files in the zip; `__fredo/` is reserved. | `apps/tauri/src-tauri/src/applications/installed_apps/mod.rs:94` (`RESERVED_PATH_SEGMENT`); `manifest.rs:308-335` (`validate_entry_path`); `archive.rs:86-129` (entry-name safety) | R-1.1 |
| C-11 | The manifest has exactly eight top-level keys; any other key is refused; an unused optional is an absent key, never `null`. | `manifest.rs:91-100` (`MANIFEST_TOP_LEVEL_KEYS`); `manifest.rs:445-466` (unknown-key refusal); `manifest.rs:402-422,616-626` and `mod.rs:264-277` (absent-not-null) | R-5.2 |
| C-12 | The host serves the entry document, injects its bootstrap and theme style, writes the token custom properties, creates the root element, dynamically imports the module and calls `mount(ctx)`; there is no `unmount`. | `apps/tauri/src-tauri/src/applications/installed_apps/bootstrap.js:440-500` (import → mount), `:140-158` (token write), `:452-475` (root + context); `scheme.rs:356-377` (`theme_style_block`); `docs/ARCHITECTURE.md:1092` | R-4 |
| C-13 | `ctx` carries `appId`, `version`, `theme`, `root`; `mount` may return a promise and the loading panel stays until it settles. | `bootstrap.js:469-475` (`context`), `:477-479` (`finishMount` after the promise) | R-4 |
| C-14 | `window.__FREDO_INSTALLED__` carries `appId`, `version`, `theme` and `invoke(action, args)`; `action` is an action name, never a command name; the host decides the call against declared capabilities. | `bootstrap.js:201-215` (`invokeAction` → `installed_app_invoke`), `:517-524` (the one assignment); `dispatch.rs:63-73` (the request is `{ action, args }`) | R-4, NFR-2 |
| C-15 | The eight dispatchable actions are a closed, ordered set; other actions are `action_not_grantable`, and an undeclared capability's action is `action_not_declared`. | `dispatch.rs:87-96` (`DISPATCH_TABLE`), `:176-196` (the two refusals) | R-4, NFR-2 |
| C-16 | A refused call rejects with one of six codes; `capability` is present only when the refusal concerns a capability. | `authority.rs:170-209` (`CapabilityRefusalCode` + `ALL`), `:218-236` (`CapabilityRefusal`, `skip_serializing_if`) | R-5.2 |
| C-17 | Every painted colour is a CSS custom property written onto the child root before the app's code runs; light and dark are different values of the same names. | `scheme.rs:350-377` (the inlined `:root` block); `bootstrap.js:140-158`; `apps/ui/src/shared/installed-apps/themeCapture.ts:126-142` (the same names, captured from the host document) | R-2.1, NFR-5 |
| C-18 | A theme change updates the variables in an open window without a reload; `ctx.theme` is a mount-time snapshot and the variables are the live state. | `bootstrap.js:172-189` (`__FREDO_APPLY_THEME__` replaces the global's `theme`), `:469-474` (mount receives a snapshot); `theme_push.rs` (eval into every live window); F-8.10 | R-2.1 |
| C-19 | `cssVar(name)` returns the `var()` expression or the published `color-mix()` expression for an alias; `theme.css` is optional because the values are already on the document. | `packages/fredo-theme/dist/index.mjs` (`cssVar`), `dist/theme.css`; the derivation and the alias set are the contract's (`apps/ui/src/app/theme/contract/tokens.ts:151-210`; `apps/ui/src/app/theme/system.ts:42-64`); F-8.23 | R-2.1 |
| C-20 | The published token names are the whole colour contract; names may be added within major `1`, none renamed, removed or re-pointed. | `apps/ui/src/app/theme/contract/tokens.ts:70-325` (`SEMANTIC_TOKENS`) + `packages/fredo-theme/dist/tokens.json`; additive rule: `mod.rs:96-108`, `authority.rs:97-102` | NFR-1, NFR-5 |
| C-21 | `engines.fredo` is a SemVer range checked against the running Fredo's crate version. | `manifest.rs:899-942` (`check_engines_range` against `HOST_FREDO_VERSION`); `mod.rs:124-129` (`CARGO_PKG_VERSION`); `docs/release-process.md:380` | R-5.1 |

## §2 What your application may not rely on

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-22 | Fredo's internal modules are not published: the application base class and its fields, `registerApplication()`, `@/shared/*`, the ingest classifier's row shapes, the `application_data_*` command signatures and caller-supplied id, and the host keyboard/navigation surface. | `docs/ARCHITECTURE.md:1124-1126` (an installed app is never a registered application; `getApplications()` cannot observe it); `authority.rs:19-26` (identity is derived, not caller-supplied); `dispatch.rs:82-86` (the legacy store surface is deliberately absent) | R-4 |
| C-23 | Importing a host-internal shape does not load: the module is not served, the import rejects, and the host renders its failure panel instead of the application's UI. | `scheme.rs` route rule (only record-pinned files under `<id>/files/` are served) + the child policy (`docs/ARCHITECTURE.md:1089,1091`); the three negative loads are F-8.14 | R-1.3, R-4 |

## §3 Capabilities

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-24 | Capabilities live in the optional `capabilities` object; `capabilities.version` names the contract major; this Fredo implements `1`; another major is refused at install. | `manifest.rs:107-137` (`MANIFEST_CAPABILITIES_KEYS`, `InstalledAppCapabilities`); `manifest.rs:660-710` (version refusal); `mod.rs:99-108` (`CAPABILITY_MANIFEST_VERSION`) | NFR-1, R-4 |
| C-25 | Absent `capabilities` means zero reach — there is no permissive default. | `manifest.rs:610-626` (absent/`null` ⇒ `None`); `authority.rs` grants path + `dispatch.rs:186-196` (a call whose capability is not declared is refused) | R-4 |
| C-26 | The four capability ids and what each grants in user terms; `data.tables` is not separately consent-gated; the three `high-risk.*` ids are. | `authority.rs:80-93` (the closed vocabulary + doc comments), `:119-129` (`is_high_risk`); `dispatch.rs:87-96` (action → capability) | R-4 |
| C-27 | A declared but unconsented high-risk capability is refused as `consent_required`; the grant is per application and re-read per call. | `dispatch.rs:197-205` (consent refusal); `authority.rs:119-129`; `mod.rs:110-121` (the host-owned consent file) | R-4 |
| C-28 | No capability adds an action: an installed app cannot install, open a window, grant consent, change settings or create a window. | `dispatch.rs:82-86` (deliberately absent `installed_app_*`, window commands) and `:87-96` (the complete table); `docs/ARCHITECTURE.md:1073` (installed windows reach exactly one command) | R-4, NFR-2 |

## §4 Your own data

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-29 | Declared tables are materialised idempotently, persisted, and reachable only by the declaring application. | `apps/tauri/src-tauri/src/infrastructure/application_data/declaration.rs` (`ApplicationDataDeclaration` + `validate`); `authority.rs` scope decision (`scope_denied` for another app's table) | R-4, R-2.2 |
| C-30 | A table declaration carries `name`, `primaryKey`, `columns` (`name`, `type`, `nullable`, `owner`) and optional `retention`; types are `TEXT`/`INTEGER`/`REAL`/`BOOLEAN`/`JSON`; names are SQL identifiers; `_row_version`/`_updated_at` may not be declared. | `declaration.rs:51-62` (types), `:100-129` (columns), `:222-245` (table + retention), `:24` (`RESERVED_COLUMNS`), `:513-522` (`is_identifier`) | R-4 |
| C-31 | The declared-data contract is additive within major `1`. | `mod.rs:99-108` (additive rule stated for the capability contract); `authority.rs:97-102` (ordered closed set) | NFR-1 |
| C-32 | A table declaration may not carry `source`; the refusal names the exact dotted path. | `manifest.rs:113-119` (the key set excludes `source`, with the reason) and `:797-810` (the named refusal, `capabilities.data.tables[i].source`) | R-5.2 |
| C-33 | Writes are scoped to the app's own tables and cannot see backend-managed columns; another app's table, an undeclared table or a canonical table is `scope_denied`. | `dispatch.rs:143-150` (`scope_refusal`), `:185-196`; `declaration.rs:24` (backend-managed columns) | R-4 |

## §5 The published colour contract

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-34 | The class legend: `A` authored, `D` derived with its own variable, `N` name-only alias published as an expression. | `apps/ui/src/app/theme/contract/tokens.ts:42-61` (`authored` + `derivation`), `:151-210` (the aliases); `apps/ui/src/app/theme/system.ts:38-64` (the expression builder) | R-2.1 |
| C-35 | The 38 names are the whole contract and the table is generated from the published package, whose `tokens.json` carries exactly those names. | `packages/fredo-theme/dist/tokens.json` (generated from `contract/tokens.ts:70-325`); F-8.26's two-way set equality | R-2.1, NFR-5 |
| C-36 | 33 names carry their own variable (mapping onto 28 distinct properties: three share the primary accent, three the strengthened accent, two the contrast label); 5 are name-only aliases. | `contract/tokens.ts:70-325` (`varName` per token: 28 distinct values across 38 names) and `system.ts:42-64`/`:27-30` (`AUTHORED_VARS` — the five aliases have no own var) | R-2.1 |
| C-37 | The zero-colour panel recipe's states are the contract's enumerated surface/state pairs; staying on them inherits the host's contrast floors, inventing a pair does not. | `apps/ui/src/app/theme/contract/surfaces.ts:145-215` (`addSurface` pairs: default label/muted/border, hover fill+border, active fill+border, focus ring, selected indicator+label, disabled label); `:113-121` (the closed state ids) | R-2.2 |
| C-38 | `--card-bg` may be translucent, so paint `--body-bg` on the document body and put the panel on top; a different backdrop is not the same composite. | `apps/ui/src/app/types/theme.ts:114` (the dark preset's translucent card value — cited as the reason, not as a contract value); the backdrop stipulation in F-8.7…F-8.9 | R-2.1, R-2.2 |
| C-39 | A hand-written colour value instead of a token breaks in the next preset. | The token contract is the only published colour surface (`contract/tokens.ts`); the prohibition is scanned by F-8.11 across the authored app, the kit, the fixture and this document | NFR-5, R-2.2 |
| C-40 | An alpha suffix appended to a `var()` reference (`var(--accent-primary)22`) is invalid CSS: the whole declaration is dropped and the border/fill disappears; the valid forms are a `color-mix()` over variables or the published alias names. | `apps/tauri/src-tauri/src/applications/installed_apps/scheme.rs:379-383` (the host-authored panel stylesheet header states exactly this rule); the pre-made aliases are `contract/tokens.ts:151-210` | NFR-5, R-2.2 |
| C-41 | Mixing a derived variable is legal but leaves the enumerated pairs, so its contrast is unchecked; tints compose from an authored variable plus `transparent` or `--body-bg`. | `contract/surfaces.ts:145-215` (the enumerated pairs) and `contract/tokens.ts:151-210` (tint derivations use an authored var); `system.ts:42-64` | R-2.2, NFR-5 |
| C-42 | Redefining a published variable appears to work but half-follows a theme switch, because the push carries resolved values; app-private properties must use their own prefix. | `apps/ui/src/shared/installed-apps/themeCapture.ts:126-142,154-165` (the capture reads computed values, so derived values may arrive substituted); `bootstrap.js:140-158` (the push writes the tokens it receives) | R-2.1, NFR-5 |
| C-43 | A raw colour for chrome must be replaced by `overlay.scrim`, `fg.onAccent` and the `status.*` names. | `contract/tokens.ts:128,101-105,226-272` (those tokens exist and are published) | NFR-5 |
| C-44 | Do not branch a palette on `colorScheme` or a media query; `colorScheme` is for native widget/scrollbar rendering and the host already sets `color-scheme` on the document. | `themeCapture.ts:104-116` (the scheme is derived from `--body-bg` for native rendering); `bootstrap.js:155-157` (the host sets `color-scheme` on the child root) | R-2.1 |
| C-45 | Do not paint from `ctx.theme`: it is the mount-time snapshot, and reading it is how an app stops following a theme change. | `bootstrap.js:469-474` vs `:172-189`; UI/UX's finding adopted in the plan's decision record | R-2.1 |
| C-46 | `--footer-bg`, `--gradient-text`, `--gradient-button`, `--node-bg`, `--node-box-shadow`, `--edge-gradient`, `--shadow-dialog` and `--font-family` are readable but unpromised; `--font-mono` is never written by the host at all. | `themeCapture.ts:154-165` (the capture forwards every declaration the host document carries) contrasted with `contract/tokens.ts` (none of them is a contract token); `scheme.rs:420` (the only reader of `--font-mono`, with a fallback) | NFR-5, R-4 |

## §6 Accepted limitations

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-47 | The limitations are deliberate and will not be removed within major `1`. | `docs/ARCHITECTURE.md:1110-1120` (the limitation rows, including the corrected capability row); `docs/SECURITY.md:204-209` (the security limitations) | R-4 |
| C-48 | An installed application opens in its own native window, never inside the main window. | `apps/tauri/src-tauri/src/applications/installed_apps/window.rs:277` (`open_installed_app_window`, `WebviewUrl::External`); `docs/ARCHITECTURE.md:1106,1118` | R-4 |
| C-49 | Closing destroys the document and re-opening fetches and evaluates the module again, so the first-open cost is paid on every open. | `window.rs` (close destroys; no module cache); `docs/ARCHITECTURE.md:1119`; `scheme.rs` responses carry no-store | R-4 |
| C-50 | The module is never unloaded while the window is open; there is no `unmount`. | `bootstrap.js:440-500` (only `mount`); `.opencode/tests/installable-apps/README.md:140-142` (no `unmount`); `docs/ARCHITECTURE.md:1106` | R-4 |
| C-51 | An installed app cannot join the keyboard/navigation dispatch tree. | `docs/ARCHITECTURE.md:1116` (the limitation row — the AC-named anchor) | R-4 |
| C-52 | An installed app can invoke only the eight dispatchable actions its capabilities cover; it cannot add a command or a capability. | `dispatch.rs:87-96` (the closed table) and `:82-86` (`installed_app_*` absent); `docs/ARCHITECTURE.md:1073` | R-4, NFR-2 |
| C-53 | No colour values of the app's own: every painted colour is a published token name. | The published contract (`contract/tokens.ts`); the prohibition is scanned by F-8.11 | NFR-5, R-2.2 |
| C-54 | Packages are unsigned; the SHA-256 record detects post-install tampering but does not prove authorship. | `docs/ARCHITECTURE.md:1120`; `docs/SECURITY.md:206`; `store.rs` (`record.json` pins) | R-4 |
| C-55 | There is no update path: installing does not replace an existing app with the same id. | `store.rs:482-489` (`already_installed` refusal, "nothing was changed"); `docs/ARCHITECTURE.md:1120` | R-4 |
| C-56 | No cross-application data: another application cannot read or write your tables, and you cannot read theirs. | `dispatch.rs:143-150` (`scope_denied`); `docs/SECURITY.md:208` (the declared surface is the ceiling) | R-4 |

## §7 When Fredo refuses

| Claim | What the document asserts | Satisfied by | REQ |
|---|---|---|---|
| C-57 | The product and the kit share one refusal vocabulary; each refusal carries a detail and, when one field is at fault, a `field` naming the exact dotted path. | `apps/tauri/src-tauri/src/applications/installed_apps/mod.rs:149-256` (the 22 codes and their order), `:264-277` (`InstalledAppError { code, detail, field? }`); `packages/fredo-authoring/bin/fredo-app.mjs` (`check` prints the same shape) | R-5.2 |
| C-58 | The code → field → remedy table, and the deliberate `engines_range_invalid` vs `host_incompatible` distinction. | `mod.rs:202-227` (wire strings) plus the field paths in `manifest.rs:445-466,553-557,581-605,660-710,787,800-810,856-883,899-942`; the two families are split at `manifest.rs:889-898` and `:929-939` (the detail names both the declared range and the running version); the Settings surface renders the code + detail + chip from `apps/ui/src/shared/installed-apps/refusals.ts:100-150` | R-5.1, R-5.2 |

*Authored by Developer*
