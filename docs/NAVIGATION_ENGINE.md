# NavigationEngine — Normative Contract

## Table of contents

1. Glossary & object model
2. Place model
3. Verb model
4. Key resolution
5. Dispatch contract
6. Journal contract
7. Context protocol
8. Surface derivations
9. Policy & risk
10. Surface validation
11. Metrics
12. Migration & adapters
13. Testing strategy

**Normative keywords.** `MUST`, `MUST NOT` and `SHOULD` state binding requirements; `MAY` states an option. A clause without a keyword is descriptive and is never an acceptance target, and a later `MAY` never softens an earlier `MUST NOT`.

**Scope.** This contract defines one navigation model for every Fredo application: the nouns (§1), places (§2), verbs (§3), key resolution (§4) and the single dispatch entry point (§5). It specifies models and behaviour only. Layout, components, colour and motion belong to the design phase, and this document MUST NOT prescribe them. Every type and field name used here is a binding identifier; renaming one is a breaking change.

## 1. Glossary & object model

The glossary is closed. Every normative clause in §2–§13 MUST use only the nouns defined here, and a capability that needs a new noun MUST amend this section before it may be specified elsewhere.

### 1.1 The object nouns

| Noun | Definition | MAY contain | Selection semantics |
|---|---|---|---|
| **document** | the single editable artifact an application instance owns | pages | document-scoped verbs apply to it as a whole; a document MUST NOT be a selection member |
| **page** | one bounded surface inside a document | elements, groups | a page MAY be a placement target; it MUST NOT be a selection member |
| **element** | one drawable object on a page — a shape, text or image | nothing (leaf) | elements MUST be the only objects a selection contains |
| **group** | an element that owns other elements | elements, groups | selecting a group MUST select its members as one unit; entering the group MAY select members individually |
| **selection** | the ordered set of elements the current verb applies to | element ids | at most one selection exists per place, and it MAY be empty |
| **view** | the camera state of the page surface — zoom, pan, fit | nothing | a view MUST NOT be selectable, and view verbs MUST NOT require a selection |

**Generic object-type shape.** Every object type an application declares MUST carry the same properties: an `id`, a `label`, a containment `parent`, and its selection semantics:

```ts
interface ObjectType {
  id: string;                 // stable slug, e.g. 'element', 'rectangle', 'group'
  label: string;              // one-word human noun used by every derived surface
  parent: ObjectType | null;  // containment; null only for a type that owns the tree
  selectable: boolean;        // MAY a selection contain this type
  multi: boolean;             // MAY more than one instance be selected at once
}
```

### 1.2 Forbidden synonyms

Vocabulary drift is a contract defect, not a style preference. The following terms MUST NOT appear in a normative clause, in a verb `appliesTo`, or in a derived surface label:

| Forbidden term | MUST NOT name | Use instead |
|---|---|---|
| `widget`, `control`, `item` | an object type | `element` (or the specific object noun from §1.1) |
| `action` | a capability | `verb` |
| `shortcut`, `accelerator` | a key | `key` — one stroke or a stroke sequence |
| `mode` | an interaction state | `place` |

A verb's `appliesTo` refers to these nouns — **objects and places — and MUST NEVER name a widget**. A capability phrased against a toolbar, a panel or a button MUST be re-expressed as a verb applying to a selection or to a place.

## 2. Place model

A **place** is a bounded interaction state of one application. Places form a tree, a stroke resolves inside the current place, and entering or leaving a place is a first-class, observable event — never an implicit mode switch.

### 2.1 Tree shape

```ts
interface PlaceNode {
  id: string;                        // '<appId>.<slug>', e.g. 'wireframe.canvas'
  label: string;                     // one-word badge/rail label
  parent: string | null;             // null ONLY for the single root
  transient: boolean;                // true ⇒ auto-exit after ONE completing verb (§2.2)
  sticky: boolean;                   // true ⇒ verbs do NOT auto-exit (§2.2)
  cursor: string | null;             // opaque to the engine; the application applies it
  operator: string | null;           // opaque pointer-operator id; the engine never interprets it
  keys: Record<string, KeyBinding>;  // full serialized stroke sequence ('c', 'w n') → binding
  entryHooks: string[];              // named, side-effect-free hook ids
  exitHooks: string[];               // same contract
}

type KeyBinding =
  | { kind: 'verb'; verbId: string }
  | { kind: 'place'; placeId: string };

interface PlaceTree {
  appId: string;
  root: string;                              // exactly one
  places: PlaceNode[];
  directAliases: Record<string, string>;     // single stroke → verbId, application-wide
}
```

The shape encodes the following binding invariants:

- An application MUST declare **exactly one root** (`parent: null`); every other place MUST have a parent, and its parent chain MUST terminate at that root (`V-02`–`V-04`, §10).
- A non-root place MUST set exactly one of `transient` and `sticky`; the root MUST set neither.
- `keys` MUST be **place-local**: a stroke declared in `wireframe.create` MUST NOT dispatch while the cursor is in `wireframe.edit`.
- `directAliases` MUST be **application-level** and MUST be consulted only when the current place yields neither an exact binding nor a pending prefix (§4.1).
- A place MUST expose only the verbs its own `keys` or an alias bind; entering a place carries no implicit capability.

### 2.2 Transience, stickiness and Escape — the converged rule

> `transient: true` ⇒ the place auto-exits after ONE completing verb; `sticky: true` ⇒ verbs do NOT auto-exit and the place persists until `Escape`; **in BOTH cases `Escape` pops exactly one level (a sticky place is never an Escape exemption, and there is no exemption to declare).**

- **Entering is observable.** Entering a place MUST write exactly one `navigation` journal entry whose `verbId` is the entering verb (`place.create`, …) or the `place.*` id of a `{kind:'place'}` binding. A silent place switch is a contract violation.
- **Exiting is always possible.** Every child place MUST be exitable with a single `Escape`; no place, hook or open overlay MAY trap the cursor.
- **Transient auto-exit.** When a verb completes in a `transient` place, the engine MUST pop exactly one level to that place's parent and MUST record `exitedBy:'verb'` on that verb's journal entry instead of writing a second `navigation` entry.
- **Sticky base.** When a verb completes in a `sticky` place, the place MUST remain current; only `Escape` leaves it.
- **Root.** `Escape` at the root MUST dispatch nothing and MUST close the innermost open overlay.

The shape matches the shipped command surface — `transient` defaults to true and `sticky` to false at `apps/ui/src/shared/hotkeys/commandSurface.ts:121-124`, and the engine's Escape stack rule is described at `apps/ui/src/shared/hotkeys/sequence.ts:24-26`. This section makes both normative.

### 2.3 Cursor, operator, hooks and aliases

- **Cursor.** `cursor` MUST be opaque to the engine: the engine MAY compare it for equality but MUST NOT interpret, mutate or persist it, and the application applies it when the place becomes current.
- **Operator.** `operator` MUST be opaque in the same way; it names a pointer operator the application MAY arm, never engine state.
- **Entry and exit hooks.** `entryHooks` and `exitHooks` MUST name side-effect-free hook ids. The observable hook id `'observable'` MUST be present on every place, so entry and exit are journaled without application cooperation.
- **Binding form.** A place entry MAY be declared as `{kind:'place'}` or as a verb whose effect is the entry. Wireframe MUST use the verb form (`place.create`, `place.edit`, …), so every entry journals with one uniform shape and a direct alias can never silently enter a place.

## 3. Verb model

A **verb** is the single unit of capability. A place key, a direct alias, a rail row, a palette row, a companion command, a launcher phrase and an agent intent MUST all resolve to a verb id; there is no second capability type.

### 3.1 `VerbDescriptor`

```ts
type Risk = 'safe' | 'mutating' | 'destructive' | 'external';

interface VerbDescriptor {
  id: string;                                         // stable public id (§3.3)
  title: string;                                      // ≤ 24 chars — bar/palette/rail row
  description: string;                                // model-facing sentence; manifest's ONLY source
  appliesTo: { objects: string[]; places: string[] }; // nouns from §1 and §2 — never widgets
  args: VerbArg[];
  available: (ctx: ContextSnapshot) => boolean;       // typed, side-effect free; MUST be pure
  risk: Risk;                                         // REQUIRED — V-09
  aliases: string[];                                  // natural-language aliases for the launcher
  run: (intent: Intent, ctx: ContextSnapshot) => Promise<VerbEffect> | VerbEffect;
  undo?: (entry: JournalEntry) => Promise<VerbEffect> | VerbEffect;  // absent ⇒ undoable:false
  consequence?: string;                               // REQUIRED for destructive/external — V-10
  publish: boolean;                                   // true ⇒ appears in the companion manifest
}

interface VerbArg {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  validate?: (value: string) => boolean;   // TS-only guard, never serialized
}
```

Each field carries a binding obligation:

| Field | Obligation |
|---|---|
| `id` | MUST be a stable, public identifier (§3.3); a rename is a breaking change |
| `title` | MUST be ≤ 24 characters and MUST be a noun phrase a human can scan |
| `description` | MUST be a model-facing sentence and MUST be the companion manifest's only source |
| `appliesTo` | MUST list the object nouns (§1.1) and place ids (§2) the verb acts on |
| `args` | MUST declare every accepted argument; an undeclared argument is `invalid-args` (§5) |
| `available` | MUST be typed and side-effect free; it MUST NOT mutate context or perform I/O |
| `risk` | MUST be one of the four classes; a missing class is `V-09` (§10) |
| `aliases` | MAY carry natural-language phrases for the launcher; they MUST NOT be key bindings |
| `run` | MUST be reachable only through `dispatch` (§5) |
| `undo` | MAY be absent; absence means not undoable, and a destructive or external verb MUST then declare `consequence` |
| `publish` | MUST be `true` only for verbs the companion may offer |

### 3.2 Arguments

An argument MUST be declared with `name`, `type` and `required`, and MAY add a `validate` guard. A `validate` guard MUST be a TS-only predicate: it is never serialized, never reaches the companion manifest, and its failure maps to `invalid-args` (§5). Argument values MUST be flat strings at the dispatch boundary (`Intent.args`), so every channel passes the same wire shape.

### 3.3 Stable ids and namespaces

```text
verbId := <namespace> ".*"
namespace ∈ { place, app, window, journal, companion, <applicationId> }
```

`place.*` MUST be engine-owned and application-agnostic: the same id means the same thing in every application that declares the matching objects. An application-specific capability MUST use its own namespace (`wireframe.document.new`). **Verb ids are stable public identifiers referenced by the companion manifest and the journal.** Renaming one MUST be treated as a breaking change to `describeContext.version` (§7), and an id MUST NOT be reused for a different capability.

The descriptor is a strict superset of the shipped command spec (`id`/`title`/`description`/`prompt`/`args`/`run` at `apps/ui/src/shared/hotkeys/commandSurface.ts:81-101`), which carries no `risk`, no `appliesTo` and no `undo`. This section adds exactly those three obligations.

## 4. Key resolution

Key resolution turns a stroke sequence into at most one intent. The resolver MUST be deterministic: the same surface declaration, the same place and the same strokes MUST always produce the same outcome, and every rejection MUST name a code.

### 4.1 Precedence, in this exact order

For every stroke the resolver MUST evaluate these four tiers **in this exact order**, and it MUST dispatch **exactly one intent** — or reject with a named code:

1. **Current place `keys`** — an exact binding on the current place's `keys` map wins.
2. **Application `directAliases`** — an application-level single-stroke alias, tried only when tier 1 produced neither an exact binding nor a pending prefix.
3. **Pending / which-key prefix continuation** — while a prefix is armed (see `PENDING_TIMEOUT_MS`), the next stroke MUST be offered to the continuation set of the pending sequence before any other tier may complete.
4. **Quiet hint** — when no tier yields a binding, the engine MUST surface a hint derived from the current place (§8) and MUST dispatch nothing.

A fifth tier — a global hotkey registry, a legacy element listing, a browser or OS shortcut — MUST NOT be consulted. §4 has exactly these four tiers.

**Stroke → intent.** A stroke MUST be normalized to a single key token, and a sequence MUST be serialized by joining tokens with one space (`'c'`, `'w n'`); `keys` is keyed by that full serialized sequence. A first stroke MUST arm a pending prefix only when no binding is exactly that stroke, and a prefix MUST NOT dispatch on its own.

**Pending-prefix timeout.** The constant is `PENDING_TIMEOUT_MS` and its value MUST be **250** ms. On timeout the resolver MUST cancel the pending prefix, dispatch nothing, write no journal entry and clear the which-key hint. A timeout MUST NOT fall back to the prefix's single-stroke binding.

**`pass-through`.** While the focus is a text-entry control, the focus is a terminal session, or a modal layer owns the keyboard, every unmodified stroke MUST be passed through to that consumer, and the resolver MUST dispatch no place key and no direct alias. The qualifier "unmodified" explains which strokes are guaranteed as consumer input; it MUST NOT be read as opening the resolver, because while a consumer owns the keyboard no stroke — modified or unmodified — dispatches a place key or a direct alias, and every unmodified stroke MUST still reach the consumer.

**Ambiguity.** Two *distinct* intents matching one stroke at the same precedence tier MUST return `{status:'rejected', code:'ambiguous-key'}` and MUST dispatch nothing. A declaration-order, first-match or last-wins fallback is PROHIBITED. Two bindings of the *same* verb id are not ambiguous — see the collision rule below.

**Transient auto-exit.** When a verb completes in a `transient` place, the resolver MUST pop exactly one level and MUST record `exitedBy:'verb'` on that verb's journal entry instead of emitting a second `navigation` entry (§2.2).

**Escape.** Inside a child place, `Escape` MUST dispatch `place.exit` and pop exactly one level. At the root, `Escape` MUST dispatch nothing and close the innermost open overlay. The §2 converged rule applies without exception: `transient: true` ⇒ the place auto-exits after ONE completing verb; `sticky: true` ⇒ verbs do NOT auto-exit and the place persists until `Escape`; **in BOTH cases `Escape` pops exactly one level (a sticky place is never an Escape exemption, and there is no exemption to declare).**

**Alias/place-key collisions.** When an application `directAliases` entry and a place key bind the same stroke to the **same verb id**, the resolver MUST dispatch that verb from the higher tier (tier 1) and MUST NOT raise `ambiguous-key`. When they bind **different verb ids**, the surface MUST be rejected at validation with `V-08` / `NAV-E008` (§10), and that case MUST never reach the resolver.

### 4.2 The published key map

```text
wireframe.canvas.keys   = c→place.create  i→place.edit  a→place.arrange  s→place.style
                          v→place.view    f→place.file   m→app.map       k→app.ask
                          p→app.palette   'w n'→window.focusNext  'w p'→window.focusPrevious
wireframe.create.keys   = r→place.rect  e→place.ellipse  t→place.text  b→place.button
wireframe.edit.keys     = a→place.selectAll  d→place.duplicate  x→place.delete  l→place.toggleLock
wireframe.arrange.keys  = l→place.alignLeft  c→place.alignCenter  z→place.alignRight
                          d→place.distribute  g→place.group  n→place.ungroup
                          f→place.bringForward  b→place.sendBackward
wireframe.style.keys    = f→place.setFill  c→place.copyStyle  x→place.resetStyle
wireframe.view.keys     = i→place.zoomIn  o→place.zoomOut  n→place.fitPage  h→place.togglePan
wireframe.file.keys     = s→place.save  a→place.saveAs  o→place.open  x→place.exportPng
                          n→wireframe.document.new
directAliases           = r→place.rect  e→place.ellipse  u→journal.undo  y→journal.redo
```

The tree these bindings hang from: `wireframe.canvas` is the root; `wireframe.create` is `transient`; `wireframe.edit`, `wireframe.arrange`, `wireframe.style`, `wireframe.view` and `wireframe.file` are `sticky`. `w` is deliberately not a binding, which is what makes the `w n` prefix reachable and keeps `V-11` (no complete binding shadows a longer sequence) satisfiable.

### 4.3 Worked traces

Every trace starts at the root place `wireframe.canvas` with an empty selection.

| stroke | tier that matched | resolved intent (verb id or place id) | args | journal effect | resulting place path |
|---|---|---|---|---|---|
| `c` | (1) current place `keys` — `wireframe.canvas` | verb `place.create` | `{}` | one `navigation` entry: `verbId:'place.create'`, `placePath:['wireframe.canvas']`, `exitedBy:'none'` | `[wireframe.canvas, wireframe.create]` |
| `c r` | stroke 1: (1) `wireframe.canvas` `keys`; stroke 2: (1) `wireframe.create` `keys` | verb `place.create`, then verb `place.rect` | `{}` then `{}` | `navigation` entry for `place.create`; then one `mutation` entry for `place.rect` with `placePath:['wireframe.canvas','wireframe.create']` and `exitedBy:'verb'` (no second navigation entry) | `[wireframe.canvas, wireframe.create]` |
| `r` | (2) application `directAliases` — from `wireframe.canvas` | verb `place.rect` | `{}` | one `mutation` entry: `verbId:'place.rect'`, `placePath:['wireframe.canvas']`, `exitedBy:'none'` | `[wireframe.canvas]` |

**`c r` is two resolutions, not one binding.** The first stroke resolves in the canvas place and enters `wireframe.create`; the second stroke resolves in the create place and runs `place.rect`, whose completing verb auto-exits the transient place with `exitedBy:'verb'`.

**The point of the pair.** Both the `c r` and the `r` row dispatch the SAME verb id `place.rect` with the same args `{}` and the same journal effect — one `mutation` entry carrying the rect insert and its inverse. Only the journal `placePath` differs: `c r` records the create place, `r` records the canvas place.

### 4.4 Grammar decision: `?` and `/` are display glyphs

Bindable keys MUST be stroke sequences over `[a-z0-9]`, plus the three engine-reserved strokes `Escape`, `Enter` and `Tab`. **`?` and `/` are NOT bindable**: neither shipped grammar can express them (`apps/ui/src/shared/hotkeys/hotkeyGrammar.ts:25`, `apps/ui/src/shared/hotkeys/commandSurface.ts:143`), so the contract binds the map to `m` and ask to `k`. `?` and `/` MAY appear only as *display glyphs* in copy (the map and ask affordances); they MUST NOT appear as binding values or as tooltip keys. This closes research limitation 1 (`docs/UX_FLUENCY_RESEARCH.md:630-636`) without changing either grammar, and it is a section decision — not an eighth ADR, because the ADR set is fixed at seven.

## 5. Dispatch contract

### 5.1 One entry point

**All six channels** — `keyboard`, `pointer`, `launcher`, `voice`, `agent` and `system` — MUST call one function, `dispatch(intent)`. **No channel may call a verb's `run` directly**; a direct `run` call is a contract violation. The funnel mirrors the shipped single `executeCommand` (`apps/ui/src/shared/hotkeys/commandSurfaceStore.ts:437`) and its `performed|noop|rejected|failed` outcome vocabulary (`:91-95`).

```ts
type Channel = 'keyboard' | 'pointer' | 'launcher' | 'voice' | 'agent' | 'system';
type Actor   = 'human' | 'companion' | 'system';

interface Intent {
  verbId: string;
  args: Record<string, string>;   // flat string map
  channel: Channel;
  actor: Actor;                   // host-asserted for companion/agent — see §9
  actorRef?: string;              // session/turn id for attribution
}
```

### 5.2 Validation order

`dispatch` MUST validate in this exact order and MUST stop at the first failure:

1. **Existence** — an unknown `verbId` MUST return `unknown-verb`.
2. **Availability** — `available(ctx)` returning false MUST return `unavailable`.
3. **Arguments** — an undeclared key, a missing required argument, a non-string value, a blank value or a failed `validate` guard MUST return `invalid-args`.
4. **Risk policy** — a `destructive` or `external` verb MUST obtain confirmation per §9, and a dismissal MUST return `canceled-confirmation`.

Only after all four steps pass MAY `dispatch` call `run`; exactly one `VerbEffect` MUST then be applied and journaled per §6.

### 5.3 Result taxonomy

| Status | Code | Meaning |
|---|---|---|
| `performed` | — | effect applied; one journal entry written |
| `noop` | `did-nothing` | the verb ran and changed nothing; no journal entry |
| `rejected` | `unknown-verb`, `unavailable`, `invalid-args`, `canceled-confirmation` | validation refused the intent; nothing ran |
| `failed` | `failed-run` | `run` threw; no partial claim |
| `partial` | `undo-failed` | a multi-step undo stopped after `applied` inverses (§6) |

The `rejected` set additionally carries `actor-spoof`, owned by §9 and raised before validation step 1 when a companion intent's host-asserted actor is not `companion`.
