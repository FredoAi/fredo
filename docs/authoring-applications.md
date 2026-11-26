# Building a Fredo application

This guide is for a developer who wants to build an application that installs into Fredo and runs in
its own window. It states what your application may rely on, what it may not, what each capability
grants, how to declare your own data, and what an installed application cannot do.

It describes the **authoring kit**: two generated packages — a theme package and an authoring
surface — plus this document. The kit is made of committed, generated files you can copy and run.
There is no registry: nothing here is installed from a package registry, and no command in this
guide downloads anything. <!-- claim:C-01 -->

You need Node.js to run the kit's two commands. They use only Node's built-in modules, so no other
toolchain and no dependency install is needed. <!-- claim:C-02 -->

> **Where the kit lives.** The kit is three items **in the Fredo repository**,
> `https://github.com/FredoAi/fredo`: the `packages/fredo-theme/` package directory, the
> `packages/fredo-authoring/` package directory, and this guide, `docs/authoring-applications.md`.
> There is no registry, so obtaining the kit means taking those three items from that repository —
> clone it, or download its archive
> (`https://github.com/FredoAi/fredo/archive/refs/heads/main.tar.gz`) and extract them — and putting
> them in one folder, which is `<kit>` for every command below. Acquiring the kit is a one-time copy:
> it is not running a step against a checkout, and the six steps below still need none.
> <!-- claim:C-59 -->

---

## Build and load your first application

The six steps below are the whole documented path. Every command names a file under `<kit>` or a
path inside your own working folder; no step needs a Fredo source checkout. <!-- claim:C-03 -->

### S1-help — confirm the kit runs with no install

```
node <kit>/fredo-authoring/bin/fredo-app.mjs --help
```

Expected: exit code `0`, with usage that lists exactly two verbs, `check` and `pack`. There is no
`init`, `new` or `scaffold` verb: the kit validates and packs, it never writes an application for
you. <!-- claim:C-04 -->

### S2-author — write your application, then vendor the theme

Create three files in `my-app/`; a minimal pair is below. Then copy the published theme into your
application so that it becomes part of the package:

```
node --eval "require('node:fs').cpSync('<kit>/fredo-theme/dist', 'my-app/vendor/fredo-theme', { recursive: true })"
```

Copy the **contents** of `fredo-theme/dist/` into `my-app/vendor/fredo-theme/`, and import the theme
only by that relative path:

```js
// my-app/main.js
import { cssVar } from './vendor/fredo-theme/index.mjs';

export function mount(ctx) {
  const panel = document.createElement('section');
  panel.style.background = cssVar('bg.surface');
  panel.style.color = cssVar('fg.default');
  panel.style.border = '1px solid ' + cssVar('border.default');
  panel.textContent = 'Hello from ' + ctx.appId;
  ctx.root.appendChild(panel);
}
```

```html
<!-- my-app/index.html -->
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>My application</title></head>
  <body></body>
</html>
```

```json
{
  "manifestVersion": 1,
  "id": "com-example-my-app",
  "displayName": "My application",
  "version": "1.0.0",
  "engines": { "fredo": ">=0.1.0" },
  "entry": { "document": "index.html", "module": "main.js" }
}
```

**Why vendoring, and not a package import.** A published file becomes reachable at runtime only by
being **part of the installed package**: the host's `fredoapp` handler serves a file only when the
install record pins it, so a file outside your package has no URL. A bare package specifier has no
meaning in the child document — there is no bundler, no import map and no registry resolution, and the
document's own script policy admits only same-origin files. `vendor/` is the only shape that works,
and `pack` archives it like any other file. <!-- claim:C-05 -->

### S3-check — validate before you package

```
node <kit>/fredo-authoring/bin/fredo-app.mjs check my-app --fredo <your Fredo version> --json
```

Expected: exit code `0` and a JSON document whose `violations` array is empty. On a violation the
command prints one record per problem — `{ "code", "field"?, "detail" }` — using the same refusal
codes the product uses, and exits non-zero. `field` is the exact dotted path of the manifest value
that broke a rule. <!-- claim:C-06 -->

The document carries `valid` (a boolean), `violations` (the refusal records) and `notChecked` (the
rules this run could not perform). <!-- claim:C-63 -->

Without `--fredo`, the `engines.fredo` range is **not** checked — the command says so in
`notChecked`; a package whose range excludes your Fredo therefore passes `check` unless you pass the
flag. <!-- claim:C-64 -->

### S4-pack — produce the package, twice

```
node <kit>/fredo-authoring/bin/fredo-app.mjs pack my-app --out out/my-app.zip
node <kit>/fredo-authoring/bin/fredo-app.mjs pack my-app --out out/my-app-b.zip
```

`pack` validates first, so a package the product would refuse is never emitted. The archive is
deterministic: the same input produces byte-identical bytes, so the two packs must report the same
SHA-256 digest. Use a **second path** for the second pack; re-writing `out/my-app.zip` after you have
measured it replaces the artifact you measured. <!-- claim:C-07 -->

### S5-install — install through the normal path

S5 assumes a **running Fredo** — the build you targeted with `engines.fredo`. There is no
command-line install; the install path exists only inside the app. <!-- claim:C-65 -->

Open **Settings → Installed applications**, choose **Install application package…**, and pick
`out/my-app.zip`. A valid package shows the success strip, appears on the launcher's **Installed
apps** shelf, and opens in its own window with your UI painted inside it. This is the same install
path any user takes; there is no author-only install. <!-- claim:C-08 -->

### S6-specifiers — confirm the package is self-contained

Every `import` and `export … from` in your application must be a **relative** path that resolves to
a file inside the package — including `./vendor/fredo-theme/index.mjs`. Relative imports of files
you ship are fine; imports of host-internal modules and bare package names are not, and a package
that uses them fails to load. <!-- claim:C-09 -->

Run the check:

```
node <kit>/fredo-authoring/bin/fredo-app.mjs check my-app --specifiers --json
```

Expected: exit code `0` and a JSON document whose `specifiers` object is
`{ "ok": true, "imports": [ … ], "problems": [] }`. On a problem it exits `1`, and each entry in
`specifiers.problems` names a `file`, a `specifier`, and one of three kinds —
`specifier_not_relative` (a bare package name or host-internal alias), `specifier_unresolved` (a
relative path with no file behind it), or `specifier_host_internal` (the source names a
host-internal shape). <!-- claim:C-66 -->

---

## 1. What your application may rely on

The published surface is small by design. These are the things that will not change under you while
the major version is `1`. <!-- claim:C-61 -->

### 1.1 The package artifact

A package is a **zip** with `fredo-app.json` at the archive root. `entry.document` and `entry.module`
are relative POSIX paths naming files the zip carries. The path segment `__fredo/` is reserved for
the host and may not appear in your archive. <!-- claim:C-10 -->

`fredo-app.json` has exactly eight top-level keys: `manifestVersion`, `id`, `displayName`,
`version`, `engines`, `entry`, `description`, `capabilities`. Any other key is refused. An optional
value you do not use is an **absent key**, never `null`. <!-- claim:C-11 -->

| Key | Rule |
|---|---|
| `manifestVersion` | the number `1` |
| `id` | lowercase letters, digits and hyphens — **no dots**; at most 96 characters; the id becomes part of your window's label; not one of Fredo's built-in application ids |
| `displayName` | 1–64 characters |
| `version` | SemVer 2.0.0, with no `v` prefix |
| `engines.fredo` | a SemVer **range** string such as `">=0.1.0"`; `"*"` and an empty string are refused |
| `entry.document` | relative POSIX path ending `.html` |
| `entry.module` | relative POSIX path ending `.js` |
| `description` | optional string, at most 280 characters |
| `capabilities` | optional; see section 3 |

These eight ids belong to Fredo and are refused as `id_reserved`: `wireframe`, `terminal`,
`mission-monitor`, `database-client`, `theming`, `setup`, `settings`, `dev-mode`. <!-- claim:C-67 -->

### 1.2 The child document and the mount contract

The host serves your `entry.document`, injects its own bootstrap and its theme stylesheet, writes the
theme's CSS custom properties onto `document.documentElement`, creates the root element
`[data-testid="installed-app-root"]`, loads `entry.module` with a dynamic `import()`, and calls its
exported `mount(ctx)`. There is no `unmount`: closing the window destroys the document, and that
destruction is how your application stops. <!-- claim:C-12 -->

`ctx` has four fields: `appId`, `version`, `theme`, and `root` (the root element). `mount` may
return a promise; the host keeps the loading panel visible until it settles. <!-- claim:C-13 -->

### 1.3 The one call route

`window.__FREDO_INSTALLED__` carries `appId`, `version`, `theme` and an `invoke(action, args)`
function. `invoke` is the only way your application reaches the backend, and its first argument is an
**action name**, never a command name. The host decides the call against your package's declared
capabilities; you cannot name a command directly. <!-- claim:C-14 -->

The dispatchable actions, in the order the host lists them, are:

```
application_data_read      application_data_write     application_data_delete
application_data_declare   db_query_execute           db_result_page
pg_database_reset          spawn_terminal_session
```

The list is closed. Anything not in it is refused as `action_not_grantable`, and an action whose
capability your package did not declare is refused as `action_not_declared`. <!-- claim:C-15 -->

A refused call rejects with a typed refusal carrying one of six codes: `action_not_declared`,
`action_not_grantable`, `consent_required`, `scope_denied`, `caller_unknown`, `app_not_installed`.
The `capability` field is present only when the refusal concerns a capability. <!-- claim:C-16 -->

### 1.4 Colour: names, never values

Every colour your application paints is a CSS custom property that the host writes onto your
document's root, before your code runs. Your application writes the **name**; the host supplies the
**value**. Light and dark appearances are different values of the same names, so an application that
writes names once follows both. <!-- claim:C-17 -->

A theme change updates those properties in an open window without reloading it. `ctx.theme` is a
**mount-time snapshot**; the live colour state is the CSS variables. Do not paint from `ctx.theme`. <!-- claim:C-18 -->

The kit's `cssVar(name)` returns the CSS `var()` expression for a token name, or the published
`color-mix()` expression for the five name-only aliases. `theme.css` is a convenience stylesheet of
the same references; including it is optional, because the values are already on your document.
<!-- claim:C-19 -->

The published token names, their CSS variables or expressions, and their classes (see section 5 for
the table and the class legend) are the whole colour contract. Names may be **added** within major
`1`; none is renamed, removed or re-pointed. <!-- claim:C-20 -->

### 1.5 Which Fredo your package targets

`engines.fredo` is a SemVer range checked against the running Fredo's version — the crate version the
build stamps, which is the same string a packaged release carries. Declare the range you have tested
against. <!-- claim:C-21 -->

---

## 2. What your application may not rely on

Fredo's internal modules are not part of the contract. This list is a promise: none of these is
published, and none will be kept stable for a package. An application that imports one does not load.
<!-- claim:C-22 -->

| Not published | What it is | What happens if you import it |
|---|---|---|
| `FredoApplicationClass` and its field names | the base class Fredo's own in-window applications extend | the module is not served, so the import rejects and the host renders its failure panel instead of your UI |
| `registerApplication()` | the seam that registers a built-in application with the host | same: not served, the import rejects, no application UI |
| `@/shared/*` imports (the row store and stream internals) | Fredo's frontend module aliases | same: the alias does not resolve in your package, the import rejects |
| the ingest classifier's row shapes | the internal typed rows Fredo derives from agent telemetry | not a package surface; nothing in the installed-application tier exposes it |
| the `application_data_*` command signatures and the caller-supplied `applicationId` | the internal command surface | you do not call commands at all; you call the actions in section 1.3 and the host derives your identity from your window |
| the keyboard and navigation surface | the host window's own interaction surface | an installed application cannot join it (section 6) |

These are enforced by the load path, not by a warning: each of the three import shapes above is a
package that fails to load. <!-- claim:C-23 -->

---

## 3. Capabilities — what you can declare, and what each grants

An installed application declares **capabilities**, never backend commands. Capabilities live in the
optional `capabilities` object of `fredo-app.json`: <!-- claim:C-62 -->

```json
{
  "capabilities": {
    "version": 1,
    "data": {
      "tables": [
        { "name": "notes", "primaryKey": ["id"],
          "columns": [
            { "name": "id", "type": "TEXT", "nullable": false, "owner": "application" },
            { "name": "body", "type": "TEXT", "nullable": true, "owner": "application" }
          ] }
      ]
    },
    "highRisk": []
  }
}
```

`capabilities.version` is the capability-contract major; this Fredo implements `1`. A different
major is refused at install rather than ignored, because a declaration this build does not understand
must never look accepted. <!-- claim:C-24 -->

**Absent means zero reach.** If your manifest has no `capabilities` key, your application reaches
nothing — there is no permissive default. <!-- claim:C-25 -->

| Capability id | What it grants, in user terms | Consent |
|---|---|---|
| `data.tables` | read, write, delete and declare the application's **own declared tables** — declared by including a `data` object with your table declarations | no separate consent: installing the package is the review |
| `high-risk.database-query` | run SQL against the user's own configured database connections, through the database actions | required, per application |
| `high-risk.database-reset` | re-initialise Fredo's database — a destructive reset | required, per application |
| `high-risk.process-spawn` | start a terminal session on the user's machine | required, per application |

<!-- claim:C-26 -->

A high-risk capability that is declared but not consented to is refused at call time as
`consent_required`; the grant is per application and re-read on every call. A grant to one
application never enables another. <!-- claim:C-27 -->

Your package can never add an action. There is no capability that installs a package, opens a window,
grants consent, changes settings or creates a window — those are the user's actions, not an
application's. <!-- claim:C-28 -->

---

## 4. Your own data

Declare your tables once, in the manifest. The host materialises them idempotently and persists them;
they are yours, and another application cannot read or write them. <!-- claim:C-29 -->

Each table declaration has:

- `name` — the logical table name;
- `primaryKey` — one or more declared column names;
- `columns` — every column, with `name`, `type`, `nullable`, and `owner`;
- `retention` — optional bounds (`maxRows`, `ttlDays`).

Column `type` is one of `TEXT`, `INTEGER`, `REAL`, `BOOLEAN`, `JSON`. Column `owner` is
`application` for columns you write, or `backend` for columns the host maintains. Column and table
names must be valid identifiers (letters, digits and underscores, not starting with a digit).
`_row_version` and `_updated_at` are backend-managed and may not be declared. <!-- claim:C-30 -->

Declared data is **additive within major `1`**: capability ids and their meanings are not renamed or
re-pointed within the major, so a package built against an earlier minor keeps working.
<!-- claim:C-31 -->

**`source` is refused.** A table declaration may not carry a `source` key. A source projection reads
Fredo's canonical tables — the user's own sessions and tool activity — and an installed application
may never declare one. The refusal names the exact path, for example
`capabilities.data.tables[0].source`. <!-- claim:C-32 -->

Writes are scoped to your own tables and cannot see backend-managed columns; a call that names
another application's table, an undeclared table, or a canonical table is refused as `scope_denied`.
<!-- claim:C-33 -->

---

## 5. The published colour contract

**Class legend.** `A` = authored by a theme record (a preset value). `D` = derived by the host
engine and written as its own CSS variable. `N` = **name-only alias**: no variable of its own;
published as the `color-mix()` expression shown, and `cssVar(name)` returns that expression.
<!-- claim:C-34 -->

The 38 names below are the whole contract. The table is generated from the published package, not
hand-typed; the package's `tokens.json` carries exactly these names. <!-- claim:C-35 -->

| Token name | CSS variable or published expression | Class |
|---|---|---|
| `bg.canvas` | `--body-bg` | A |
| `bg.surface` | `--card-bg` | A |
| `bg.subtle` | `--header-bg` | A |
| `bg.muted` | `--card-hover-bg` | A |
| `bg.hover` | `--hover-bg` | D |
| `fg.default` | `--text-primary` | A |
| `fg.muted` | `--text-secondary` | A |
| `fg.subtle` | `--text-subtle` | D |
| `fg.onAccent` | `--accent-contrast` | D |
| `border.default` | `--border-strong` | D |
| `border.subtle` | `--border-color` | A |
| `overlay.scrim` | `--overlay-bg` | A |
| `accent.default` | `--accent-primary` | A |
| `accent.solid` | `--accent-primary` | A |
| `accent.fg` | `--accent-primary` | A |
| `accent.emphasized` | `--accent-secondary` | A |
| `accent.strong` | `--accent-strong` | D |
| `accent.focusRing` | `--accent-strong` | D |
| `accent.border` | `--accent-strong` | D |
| `accent.contrast` | `--accent-contrast` | D |
| `accent.subtle` | `color-mix(in srgb, var(--accent-primary) 8%, transparent)` | N |
| `accent.muted` | `color-mix(in srgb, var(--accent-primary) 15%, transparent)` | N |
| `accent.tint` | `color-mix(in srgb, var(--accent-primary) 10%, var(--body-bg) 90%)` | N |
| `accent.subagent` | `--accent-subagent` | A |
| `accent.nestedSubagent` | `--accent-nested-subagent` | A |
| `status.success` | `--status-success` | A |
| `status.warning` | `--status-warning` | A |
| `status.error` | `--status-error` | A |
| `status.info` | `--status-info` | A |
| `status.onSolids` | `--status-on-solids` | D |
| `status.errorTint` | `color-mix(in srgb, var(--status-error) 15%, var(--body-bg) 85%)` | N |
| `status.errorStrong` | `color-mix(in srgb, var(--status-error) 50%, var(--text-primary) 50%)` | N |
| `avatar.interior` | `--fredo-avatar-interior` | D |
| `scrollbar.thumb` | `--scrollbar-thumb` | D |
| `scrollbar.thumbHover` | `--scrollbar-thumb-hover` | D |
| `life.neutral` | `--life-neutral` | D |
| `life.cell` | `--life-cell` | D |
| `life.dim` | `--life-dim` | D |

Thirty-three of those names carry their own CSS variable (mapping onto twenty-eight distinct
properties, because three share the primary accent, three share the strengthened accent and two share
the contrast label); the remaining five are the name-only aliases. <!-- claim:C-36 -->

### 5.1 The zero-colour panel

This recipe uses names only. It is the shape the host's own enumerated surface/state pairs describe:
a default label and border, a hover fill with the deepened accent boundary, a selected fill with the
contrast label, a focus ring, and a disabled label with the soft boundary. An application that stays
on these pairs inherits the host's contrast floors; an application that invents a pairing does not.
<!-- claim:C-37 -->

```css
html, body { background: var(--body-bg); color: var(--text-primary); }
.panel { background: var(--card-bg); border: 1px solid var(--border-strong); }
.panel :focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.panel .row:hover { background: var(--hover-bg); border-color: var(--accent-strong); }
.panel .row[aria-selected="true"] { background: var(--accent-strong); color: var(--accent-contrast); }
.panel button:disabled { color: var(--text-subtle); border-color: var(--border-color); }
```

`--card-bg` may carry transparency in some presets, so paint `--body-bg` on your document's body and
put the panel on top of it. A panel over a backdrop of your own choosing is not the same composite
the host's own surfaces use. <!-- claim:C-38 -->

### 5.2 Seven forbidden shapes, and what each breaks

1. **A hand-written colour value instead of a token** — a hex value, a functional colour notation, or
   a colour keyword used to "match" Fredo. It looks right in the preset you were looking at and wrong
   in the next one; the contract has a name for every surface you need. <!-- claim:C-39 -->
2. **An alpha suffix appended to a variable reference** — for example `var(--accent-primary)22`.
   This is invalid CSS: the substitution splices tokens without re-lexing, so the suffix stays a
   separate token and the **whole declaration is dropped**. The symptom is not "slightly off" — the
   border or fill **disappears** and the inherited or initial value takes over. Nothing in a child
   document warns you. The valid forms are a `color-mix()` over variables, or the published
   `accent.subtle` / `accent.muted` names. <!-- claim:C-40 -->
3. **Mixing a derived variable** — for example mixing the strengthened accent in a further
   `color-mix()`. It is legal CSS, but the result is outside every enumerated pair, so its contrast is
   not checked, and mixing toward a luminance extreme is a darken/lighten rather than a tint. Tints
   compose from an **authored** variable plus `transparent` or `--body-bg`; the five alias names are
   the pre-made tints. <!-- claim:C-41 -->
4. **Redefining a published variable on your root or body.** Your document is yours, so it appears to
   work — but the push carries the host's resolved values, so a derived value may arrive already
   substituted: redefining the primary accent will not re-derive the strengthened accent, and the app
   half-follows the theme. Application-private custom properties are welcome under your own prefix;
   the published names are read-only. <!-- claim:C-42 -->
5. **A raw colour for chrome** — a scrim, a label, an icon drawn with a hand-written value to "match"
   Fredo. Use `overlay.scrim`, `fg.onAccent` and the `status.*` names instead. <!-- claim:C-43 -->
6. **Branching your palette on `colorScheme`** (or a media query) and picking colours from it. The
   variables already carry the values; the branch duplicates the host's decision and drifts on a
   preset that is neither. `colorScheme` exists for native widget and scrollbar rendering, and the
   host already sets `color-scheme` on your document, so do not re-declare it. <!-- claim:C-44 -->
7. **Painting from `ctx.theme` at paint time.** It is the mount-time snapshot; the live state is the
   CSS variables. Reading it for colour is how an application stops following a theme change.
   <!-- claim:C-45 -->

### 5.3 Not part of the contract

The host's document also declares properties that are **readable but unpromised** — they are not
contract tokens and no guarantee attaches to them: `--footer-bg`, `--gradient-text`,
`--gradient-button`, `--node-bg`, `--node-box-shadow`, `--edge-gradient`, `--shadow-dialog` and
`--font-family`. One sharper case: `--font-mono` is never written by the host at all (the host's own
panel stylesheet reads it with a fallback), so treating it as a token would be false at every theme.
None of these is part of the contract; do not paint from them.
<!-- claim:C-46 -->

---

## 6. Accepted limitations

These are deliberate limits of an installed application. They are not defects, and they will not be
removed within major `1`. <!-- claim:C-47 -->

- **Own window only.** An installed application opens in its own native window and never inside the
  main window. <!-- claim:C-48 -->
- **Cold start on first open.** Closing the window destroys the document; re-opening fetches and
  evaluates your module again, so the first-open cost is paid on every open. <!-- claim:C-49 -->
- **The module is never unloaded while the window is open.** There is no `unmount`; destroying the
  window is the stop. <!-- claim:C-50 -->
- **No keyboard or navigation participation.** The installed document is a separate document in its
  own window; nothing your application does reaches the host window's keyboard handling. The host's
  keyboard surface is documented in `docs/ARCHITECTURE.md` (the limitation row: an installed app
  cannot join the keyboard/navigation dispatch tree). <!-- claim:C-51 -->
- **No backend action of its own.** Your application can invoke only the eight dispatchable actions,
  and only those its package's capabilities cover. It cannot add a command, add a capability, or
  declare one it was not granted. <!-- claim:C-52 -->
- **No colour values of its own.** Every painted colour comes from a published token name
  (section 5). <!-- claim:C-53 -->
- **Packages are unsigned.** There is no signature and no registry; trust in a package is the user's
  judgement at install time. The per-file SHA-256 record detects **post-install tampering**, which is
  a different guarantee from proving who authored the bytes. <!-- claim:C-54 -->
- **No updates.** There is no update path in this slice: installing a package does not replace an
  existing one with the same id. <!-- claim:C-55 -->
- **No cross-application data.** Your tables are yours; another application cannot read or write
  them, and you cannot read another application's. <!-- claim:C-56 -->

---

## 7. When Fredo refuses

The product and the kit share one refusal vocabulary. `check` prints these codes before you package;
the Settings pane prints the same code when the user installs. Each refusal carries a human detail,
and a `field` naming the exact dotted manifest path when one field is at fault. <!-- claim:C-57 -->

| Code | Field it names | What to change |
|---|---|---|
| `not_a_zip` | — | the package must be a zip file |
| `no_manifest` | — | put `fredo-app.json` at the archive root, not in a subfolder |
| `manifest_malformed` | — | make `fredo-app.json` valid JSON whose top level is an object |
| `manifest_unknown_field` | the unknown key's dotted path | remove it, or use one of the eight top-level keys |
| `manifest_invalid_field` | the failing field's dotted path | follow the rule for that field (type, length, table declaration shape, or an absent optional instead of `null`) |
| `unsupported_manifest_version` | `manifestVersion` | use `manifestVersion: 1` |
| `id_invalid` | `id` | use lowercase letters, digits and hyphens — no dots — at most 96 characters |
| `id_reserved` | `id` | choose an id outside Fredo's eight built-in application ids (section 1.1) |
| `version_invalid` | `version` | use SemVer 2.0.0 with no `v` prefix |
| `engines_range_invalid` | `engines.fredo` | write a SemVer range such as `">=0.1.0"`; `"*"` and an empty string are refused |
| `host_incompatible` | `engines.fredo` | widen the range so it includes the running Fredo version (the detail names both the declared range and the running version) |
| `entry_missing` | `entry.document` or `entry.module` | ship the file the entry names, at the exact relative path |
| `entry_invalid` | `entry.document` or `entry.module` | make it a relative POSIX path ending `.html` or `.js`, with no `..` |
| `unsafe_path` | — | remove the archive entry: names may not be absolute, carry a drive or UNC prefix, use backslashes, contain `..`, or be links |
| `reserved_path` | — | rename the path segment that claims `__fredo/` |
| `archive_too_large` | — | reduce the entry count or the size (the budget is 4,096 entries, 256 MiB total, 64 MiB per file) |
| `already_installed` | `id` | an application with that id is already installed; nothing was changed |
| `io_error` | — | retry; the install did not finish |
| `integrity_mismatch` | — | the files changed after install; reinstall from a package you trust |
| `integrity_record_corrupt` | — | the install record is unreadable; reinstall |
| `id_not_installed` | — | the application is not installed any more; install it again |
| `id_is_installed_app` | — | that id belongs to an application Fredo ships with |

Two of these are deliberately distinct: `engines_range_invalid` means the range cannot be read, while
`host_incompatible` means it is a well-formed range that excludes the running Fredo. Collapsing them
would tell you your range is malformed when it is simply too narrow.
<!-- claim:C-58 -->

---

## Where to go next

- `docs/ARCHITECTURE.md` — the installed-application tier: the `fredoapp` origin, the install path,
  the window, and what an installed application does not do.
- `docs/SECURITY.md` — the four containment mechanisms and their limits.
- The kit's `fredo-theme/tokens.json` and `fredo-authoring/schema/fredo-app.schema.json` — the
  generated artifacts behind this document. <!-- claim:C-60 -->
