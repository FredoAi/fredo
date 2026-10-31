# NavigationEngine — Normative Contract

## Table of contents

1. Glossary & object model
2. Place model
3. Verb model
4. Key resolution
5. Dispatch contract
6. Journal contract
7. Context protocol
8. Discovery derivations
9. Policy
10. Validation contract
11. Metrics
12. Migration strategy
13. Testing strategy
P4 surfaces (Spec #3118 — appended §11)
P6 launcher + agent bridge (Spec #3120 — appended)
Open questions

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

For every stroke the resolver MUST evaluate these four tiers **in this exact order**, except while a prefix is armed: then the next stroke MUST first be resolved by tier 3 alone, and tiers 1 and 2 MUST NOT be consulted for that stroke. It MUST dispatch **exactly one intent** — or reject with a named code:

1. **Current place `keys`** — an exact binding on the current place's `keys` map wins.
2. **Application `directAliases`** — an application-level single-stroke alias, tried only when tier 1 produced neither an exact binding nor a pending prefix.
3. **Pending / which-key prefix continuation** — while a prefix is armed (see `PENDING_TIMEOUT_MS`), the next stroke MUST be offered to that prefix's continuation set FIRST, and a single-stroke place key (tier 1) or a direct alias (tier 2) MUST NOT be consulted for that stroke. A stroke that matches no continuation of the armed sequence MUST cancel the prefix and MUST be re-resolved from tier 1.
4. **Quiet hint** — when no tier yields a binding, the engine MUST surface a hint derived from the current place (§8) and MUST dispatch nothing.

A fifth tier — a global hotkey registry, a legacy element listing, a browser or OS shortcut — MUST NOT be consulted. §4 has exactly these four tiers.

**Stroke → intent.** A stroke MUST be normalized to a single key token, and a sequence MUST be serialized by joining tokens with one space (`'c'`, `'w n'`); `keys` is keyed by that full serialized sequence. A first stroke MUST arm a pending prefix only when no binding is exactly that stroke, and a prefix MUST NOT dispatch on its own. A pending prefix MUST exist only where that first stroke has a non-empty continuation set in the current place; a stroke with no continuation MUST fall through to tier 2 (application `directAliases`) immediately rather than arming an empty prefix.

**Pending-prefix timeout.** The constant is `PENDING_TIMEOUT_MS` and its value MUST be **250** ms. On timeout the resolver MUST cancel the pending prefix, dispatch nothing, write no journal entry and clear the which-key hint. A timeout MUST NOT fall back to the prefix's single-stroke binding.

**`pass-through`.** While the focus is a text-entry control, the focus is a terminal session, or a modal layer owns the keyboard, every unmodified stroke MUST be passed through to that consumer, and the resolver MUST dispatch no place key and no direct alias. The qualifier "unmodified" explains which strokes are guaranteed as consumer input; it MUST NOT be read as opening the resolver, because while a consumer owns the keyboard no stroke — modified or unmodified — dispatches a place key or a direct alias, and every unmodified stroke MUST still reach the consumer.

**Ambiguity.** Two *distinct* intents matching one stroke at the same precedence tier MUST return `{status:'rejected', code:'ambiguous-key'}` and MUST dispatch nothing. A declaration-order, first-match or last-wins fallback is PROHIBITED. Two bindings of the *same* verb id are not ambiguous — see the collision rule below.

**Transient auto-exit.** When a verb completes in a `transient` place, the resolver MUST pop exactly one level and MUST record `exitedBy:'verb'` on that verb's journal entry instead of emitting a second `navigation` entry (§2.2).

**Escape.** Inside a child place, `Escape` MUST dispatch `place.exit` and pop exactly one level. At the root, `Escape` MUST dispatch nothing and close the innermost open overlay. The §2 converged rule applies without exception: `transient: true` ⇒ the place auto-exits after ONE completing verb; `sticky: true` ⇒ verbs do NOT auto-exit and the place persists until `Escape`; **in BOTH cases `Escape` pops exactly one level (a sticky place is never an Escape exemption, and there is no exemption to declare).**

**Alias/place-key collisions.** When an application `directAliases` entry and the **root place's** key bind the same stroke to the **same verb id**, the resolver MUST dispatch that verb from the higher tier (tier 1) and MUST NOT raise `ambiguous-key`. When they bind **different verb ids** at the root, the surface MUST be rejected at validation with `V-08` / `NAV-E008` (§10), and that case MUST never reach the resolver. A collision with a **child** place's own key is not a V-08 violation: a direct alias is tier 2 and is reached only where tier 1 missed, so a child place's key is never shadowed by an alias.

### 4.2 The published key map

The P5 home surface is the Wireframe declaration (Spec #3119). Entry keys at the root are
`{kind:'place'}` bindings; every other key is a verb binding. The six entry place ids are
also declared as verbs so the host can run the entry effect.

```text
wireframe.canvas.keys   = c→place wireframe.create   e→place wireframe.edit
                          a→place wireframe.arrange  s→place wireframe.style
                          v→place wireframe.view     f→place wireframe.file
                          m→app.map                  k→app.ask
                          ArrowLeft→wireframe.selection.previous   ArrowUp→wireframe.selection.previous
                          ArrowRight→wireframe.selection.next      ArrowDown→wireframe.selection.next
wireframe.create.keys   = r→wireframe.create.rect  e→wireframe.create.ellipse
                          t→wireframe.add.text  b→wireframe.add.button  i→wireframe.add.input
                          m→wireframe.add.image  k→wireframe.add.card  s→wireframe.add.section
                          l→wireframe.add.line
wireframe.edit.keys     = d→wireframe.element.duplicate  x→wireframe.element.delete
                          l→wireframe.element.toggleLock  h→wireframe.element.toggleVisible
                          r→wireframe.element.rename
wireframe.arrange.keys  = g→wireframe.arrange.group  u→wireframe.arrange.ungroup
                          ArrowLeft→wireframe.arrange.alignLeft   ArrowRight→wireframe.arrange.alignRight
                          d→wireframe.arrange.distribute  f→wireframe.arrange.bringForward
                          b→wireframe.arrange.sendBackward  s→wireframe.arrange.toggleSnap
wireframe.style.keys    = f→wireframe.style.fill  o→wireframe.style.border
                          p→wireframe.style.appearance  z→wireframe.style.radius
                          t→wireframe.style.textStyle
wireframe.view.keys     = +→wireframe.zoom.in  -→wireframe.zoom.out  f→wireframe.view.fitPage
                          0→wireframe.view.resetView  p→wireframe.view.togglePan
wireframe.file.keys     = n→wireframe.document.new  o→place.open
                          w→place.saveAs  x→place.exportPng
directAliases           = r→wireframe.create.rect  u→journal.undo  y→journal.redo
```

The tree these bindings hang from: `wireframe.canvas` is the root; `wireframe.create` is
`transient` with the create-shape operator and the crosshair cursor; `wireframe.edit`,
`wireframe.arrange`, `wireframe.style`, `wireframe.view` and `wireframe.file` are `sticky`.
Root entry keys (`c e a s v f`) are **place** bindings, not aliases — only `r`, `u` and `y`
are application-level direct aliases (tier 2). `wireframe.arrange.alignCenter`,
`wireframe.arrange.toggleGroupLock` and `wireframe.view.panBy` are declared but unbound, so
they are reachable through the map/palette only. The same stroke may bind different verbs in
sibling places (`f` = bring-forward in Arrange, fill in Style, fit-page in View; `s` =
section in Create, toggle-snap in Arrange); place locality is what makes this legal.

### 4.3 Worked traces

Every trace starts at the root place `wireframe.canvas` with an empty selection.

| stroke | tier that matched | resolved intent (verb id or place id) | args | journal effect | journal `placePath` (dispatch-time, §6.1) | cursor after the dispatch |
|---|---|---|---|---|---|---|
| `c` | (1) current place `keys` — `wireframe.canvas` (place binding) | verb `wireframe.create` | `{}` | one `navigation` entry: `verbId:'wireframe.create'`, `placePath:['wireframe.canvas']`, `exitedBy:'none'` | `['wireframe.canvas']` | `[wireframe.canvas, wireframe.create]` |
| `c r` | stroke 1: (1) `wireframe.canvas` `keys`; stroke 2: (1) `wireframe.create` `keys` | verb `wireframe.create`, then verb `wireframe.create.rect` | `{}` then `{}` | `navigation` entry for `wireframe.create`; then one `mutation` entry for `wireframe.create.rect` with `placePath:['wireframe.canvas','wireframe.create']` and `exitedBy:'verb'` (no second navigation entry) | `['wireframe.canvas','wireframe.create']` | `[wireframe.canvas]` |
| `r` | (2) application `directAliases` — from `wireframe.canvas` | verb `wireframe.create.rect` | `{}` | one `mutation` entry: `verbId:'wireframe.create.rect'`, `placePath:['wireframe.canvas']`, `exitedBy:'none'` | `['wireframe.canvas']` | `[wireframe.canvas]` |

**`c r` is two resolutions, not one binding.** The first stroke resolves in the canvas place
and enters `wireframe.create`; the second stroke resolves in the create place and runs
`wireframe.create.rect`, whose completing verb auto-exits the transient place with
`exitedBy:'verb'`. The `wireframe.create.rect` entry is written at DISPATCH time, so its
`placePath` still records the create place; the pop happens on completion, so the cursor after
the dispatch is back at `[wireframe.canvas]`.

**The point of the pair.** Both the `c r` and the `r` row dispatch the SAME verb id
`wireframe.create.rect` with the same args `{}` and the same journal effect — one `mutation`
entry carrying the rect insert and its inverse. The two rows differ only in the two derived
facts the last two columns separate: the journal `placePath`, which is the dispatch-time path
(create vs canvas), and the cursor after the dispatch, which differs because the transient
create place pops on completion (§2.2, `exitedBy:'verb'`). That difference is a property of
the strokes, and it is never a licence for the two authors to disagree.

### 4.4 Grammar decision: reserved strokes and the two display glyphs

Bindable keys MUST be stroke sequences over `[a-z0-9]`, plus the nine engine-reserved strokes
`Escape`, `Enter`, `Tab`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `+` and `-`.
Reserved tokens are matched case-insensitively and canonicalise to their declared casing;
`+` and `-` are single characters and pass through verbatim. The P5 surface uses the arrows
for selection (root) and alignment (Arrange) and `+`/`-` for zoom (View).

**`?` and `/` are NOT bindable**: neither shipped grammar can express them
(`apps/ui/src/shared/hotkeys/hotkeyGrammar.ts:25`, `apps/ui/src/shared/hotkeys/commandSurface.ts:143`),
so the contract binds the map to `m` and ask to `k`. `?` and `/` MAY appear only as *display
glyphs* in copy (the map and ask affordances); they MUST NOT appear as binding values or as
tooltip keys. A surface adapter MAY dispatch `?` straight to the declared `app.map` verb
without synthesising `m` (so `m` stays place-scoped), and `/` stays inert until the launcher
lands (P6). This closes research limitation 1 (`docs/UX_FLUENCY_RESEARCH.md:630-636`) without
changing either grammar, and it is a section decision — not an eighth ADR, because the ADR set
is fixed at seven.

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

## 6. Journal contract

The **journal** is the application session's append-only, totally ordered record. Every dispatch that changes state MUST write exactly one `JournalEntry` — or join one existing entry under the coalescing rule (§6.3). The journal is the only attribution record and the only source for §11 metrics and for undo.

### 6.1 Entry shape

```ts
interface JournalEntry {
  seq: number;                  // monotonic per application session, starts at 1
  ts: string;                   // ISO-8601 UTC, millisecond precision
  verbId: string;               // the dispatched verb (§3.3)
  actor: Actor;                 // 'human' | 'companion' | 'system' — host-asserted (§9.2)
  channel: Channel;             // the dispatching channel (§5.1)
  label: string;                // human sentence, ≤ 120 chars
  effect: 'mutation' | 'navigation';
  placePath: string[];          // place ids, root → current at dispatch, length ≥ 1
  target: Array<{ type: string; id: string; label: string }>;  // ≤ 32 object refs
  patch: { before: JsonPatch; after: JsonPatch } | null;       // null for navigation
  inverse: JsonPatch | null;    // non-null ⇔ undoable
  undoable: boolean;
  external: boolean;            // true ⇒ the effect reached outside the document
  consequence: string | null;   // REQUIRED sentence when undoable === false
  exitedBy: 'verb' | 'escape' | 'none';  // how a transient place was left (§2.2)
  coalesceKey: string | null;
  groupId: string | null;       // the first entry's seq once coalescing merged ≥ 2
}
```

- **`effect`** MUST be `mutation` for a state change and `navigation` for a place entry, exit or any other state-free transition; a `navigation` entry MUST carry `patch: null` and `inverse: null`.
- **`actor`** MUST be exactly one of `human`, `companion` or `system` and MUST be host-asserted, never model-supplied (§9.2).
- **`target`** MUST list the objects the verb acted on and MUST carry at most 32 refs.
- **`undoable`** MUST be `true` if and only if `inverse` is non-null. `external: true` MUST imply `undoable: false` and `inverse: null`.
- **`consequence`** MUST be a non-empty sentence whenever `undoable` is `false`; `V-10` (§10) makes a verb without one un-shippable.
- **`exitedBy`** MUST be `verb` when a transient place auto-exited on the verb, `escape` when `place.exit` popped it, and `none` otherwise.

### 6.2 Undo and redo

`journal.undo` MUST resolve a `JournalQuery` (§6.4), order the matches by `seq` DESC, and apply the `inverse` of the newest entry first (LIFO). `journal.redo` MUST re-apply the `patch.after` of redoable entries in ASC `seq` order, oldest first. Any new `mutation` MUST clear the redo stack: a redo is available only until the next mutation. Each applied inverse MUST itself be journaled as a new `mutation` entry, so the journal remains append-only. An entry's `inverse` MUST revert only the state/fields that entry changed; applying an older inverse MUST NOT revert a later entry's independent change, and a redo MUST re-apply only its own entry's change.

### 6.3 Coalescing and the non-undoable list

Entries MUST coalesce into one entry when, and only when, they share an equal `coalesceKey`, an equal `actor`, a `seq` gap of at most 1, and a `ts` gap of at most 400 ms. A coalesced entry MUST keep the later `seq`/`ts`, concatenate the patches, and set `groupId` to the first entry's `seq`. Undo of a coalesced entry MUST revert the whole group. `navigation` entries MUST NEVER coalesce.

These verbs MUST be declared non-undoable, and each MUST carry its own `consequence` and render its undo affordance disabled with reason `not-undoable` — never a generic "cannot undo": `place.save`, `place.saveAs`, `place.open`, `place.exportPng`, `wireframe.document.new`.

The copy template is `"<label> — saved to, or acted on, something Fredo cannot reopen. <consequence>"`. For `place.exportPng` the declared consequence is `"the file is outside Fredo's document history. Re-export to change it."`, so the rendered copy reads `"Exported the page as a PNG — the file is outside Fredo's document history. Re-export to change it."`

### 6.4 Journal queries

```ts
interface JournalQuery {
  actor?: Actor;                        // exact match
  since?: string;                       // ISO-8601 ts, INCLUSIVE lower bound
  count?: number;                       // default 1, clamped to 1..100
  verbId?: string;                      // exact match
  channel?: Channel;                    // exact match
  effect?: 'mutation' | 'navigation';   // DEFAULT 'mutation'
}
```

- **Matching.** Every provided field MUST be AND-ed; an omitted field MUST match everything.
- **Ordering.** Candidates MUST be ordered by `seq` DESC for undo and ASC for redo.
- **Defaults.** `effect` MUST default to `mutation`; `count` MUST default to 1 and MUST clamp to the range 1..100.
- **Empty result.** A query matching nothing MUST return `{status:'noop', reason:'no-matches'}`, MUST write no journal entry, and the product MUST state **"Nothing to undo."** exactly once — no error surface and no second message.
- **Many.** For `count > 1` the engine MUST apply inverses newest-first and stop on the first failure, returning `{status:'partial', applied:n, failedSeq, code:'undo-failed'}` with `n` already-applied inverses preserved as separate requester-attributed entries (see **Undo attribution** below).
- **Undo attribution.** Each applied inverse MUST be journaled as its own `mutation` entry attributed to the REQUESTER: `actor` is the dispatching intent's `actor`, except that a companion-channel request journals `human` (the human asked the companion, or the launcher acted for them); `channel` is the dispatching intent's channel. A `system` requester keeps `system`. The reversal therefore reads `You` in the trail (§6.1). This replaces the pre-P6 hard-coded `system` attribution.

The two canonical queries are defined verbatim:

- ***"undo the companion's last change"*** ≡ `journal.undo` with `{actor:'companion', count:'1'}` — the newest `mutation` entry whose `actor` is `companion`, whatever its `verbId`.
- ***"undo the last N changes by actor X"*** ≡ `journal.undo` with `{count:'N', actor:'X'}` — the newest `N` `mutation` entries by that actor, newest inverse first.

## 7. Context protocol

`describeContext(appId)` MUST return one `ContextEnvelope` and MUST NOT read an application store to produce it. The envelope is the read model the launcher and the companion consume.

### 7.1 Envelope v1

```ts
interface ContextEnvelope {
  version: 1;                          // integer; a breaking change bumps it to 2
  appId: string;                       // the application id
  placePath: PlaceRef[];               // root → current, length 1..maxPathDepth
  selection: {
    count: number;                     // 0 when nothing is selected
    kinds: string[];                   // object kinds present, deduped, ≤ 8
    label: string | null;              // e.g. 'Rectangle 3', or null
    ids: string[];                     // ≤ maxSelectionIds
  };
  verbs: VerbSummary[];                // ≤ maxVerbs, declaration order
  journal: {
    last: JournalSummary[];            // newest first, ≤ maxJournalEntries
    undoableCount: number;             // entries whose undoable === true
  };
  dirty: boolean;                      // unsaved document mutations since the last save
  limits: CapabilityLimits;
}

interface PlaceRef       { id: string; label: string; transient: boolean; sticky: boolean }
interface VerbSummary    { id: string; title: string; risk: Risk; keys: string[];
                           available: boolean; unavailableReason: string | null }
interface JournalSummary { seq: number; ts: string; verbId: string; actor: Actor;
                           label: string; undoable: boolean }
interface CapabilityLimits {
  maxVerbs: 64; maxJournalEntries: 10; maxSelectionIds: 32;
  maxLabelChars: 120; maxPathDepth: 8; maxContextBytes: 16384;
}
```

| Field | Meaning and obligation |
|---|---|
| `version` | MUST be the integer `1`; it MUST bump whenever the envelope shape or any verb id changes breakingly |
| `appId` | MUST be the application id whose places §2 declared |
| `placePath` | MUST list `PlaceRef` records root → current; each MUST carry the place's `id`, `label`, `transient` and `sticky` |
| `selection` | MUST summarise the selection: `count`, the deduped object `kinds`, a display `label` or `null`, and `ids` (≤ `maxSelectionIds`) |
| `verbs` | MUST list `VerbSummary` rows in declaration order, each with `risk`, bound `keys` (`[]` when unbound) and an `available`/`unavailableReason` pair |
| `journal` | MUST carry `last` (newest-first `JournalSummary` rows, ≤ `maxJournalEntries`) and `undoableCount` |
| `dirty` | MUST be `true` when the document has unsaved mutations |
| `limits` | MUST publish the numeric `CapabilityLimits` above; they are the declared ceilings of every field |

The envelope is the **only** read model. The launcher and the companion **MAY read no other application state**: they MUST NOT read an application store, the command surface, any `data-hotkey` listing, or the journal directly — every value they need MUST arrive in the envelope. `version` MUST bump on any breaking change to the envelope or to a verb id (§3.3).

## 8. Discovery derivations

Every discoverable surface MUST be derived from the single declaration — §2 `PlaceTree` plus §3 `VerbDescriptor` plus the current `ContextSnapshot`. Derivation is the only mechanism.

### 8.1 The eight derivations

| Surface | Input declaration | Deterministic output |
|---|---|---|
| Rail | `PlaceTree` + `available(ctx)` + selection | ordered verb rows for the current place: `{verbId, title, risk, keys, enabled, reason}`; 4–8 rows, overflow to the palette |
| Map (`app.map`) | `PlaceTree` + every verb's `appliesTo` | the whole tree as rows `{placePath, verbs[], keys[]}` in tree order — root first, declaration order within a place |
| Palette (`app.palette`, launcher `>`) | `PlaceTree` + `VerbDescriptor[]` + journal recents | flat rows `{verbId, title, placePath, key, risk, section}` grouped by place in tree order; recents first, capped |
| Hint / next-step | pending prefix + `PlaceTree` + `available(ctx)` | which-key rows 250 ms after arming; after a verb, the place's next 3 available verbs; empty when a hint would duplicate the rail |
| Onboarding | `PlaceTree` shape (root keys, place count, direct aliases) | the fixed tour steps (root → each place), each step naming that place's `keys`; no hand-written step list |
| Tooltips | `VerbDescriptor.title` + bound `keys` + `risk` | one string per surface: `"<title> (<binding keys joined by ', '>)"`, plus `" — <risk>"` when risk ≠ safe |
| Companion manifest | `VerbDescriptor` where `publish === true`, declaration order | `CompanionManifest` — `appId/appName/skillName/description/commands[{id,label,description,risk,args,aliases}]` in declaration order, then the engine-owned `journal.undo` command (`risk: mutating`; optional `actor`/`count` args; aliases `undo`/`revert`), plus the reserved `listActions` entry. The published manifest projects a registered navigation surface ahead of a legacy `commandSurface` for the same `appId` (P6, §P6.7) |
| Docs index | `PlaceTree` + `VerbDescriptor.id` | `docs/README.md` rows anchored per place; `app.docs` deep-links to `#<place-slug>` |

### 8.2 Derivation is the only mechanism

A surface MUST be reproducible from the declaration alone, and any difference between the derived output and the declaration MUST be treated as a defect. A hand-maintained second list for any of the eight surfaces is a **contract violation** and MUST NOT be introduced; the declaration is the single source of truth (ADR-6).

**Tooltip wording.** A tooltip MUST emit the **binding keys joined by `', '`** in parentheses after the title — `"Map (m)"`, `"Ask (k)"` — and MUST NEVER print the display glyph. The glyphs `?` and `/` MAY appear only in rail, map and onboarding prose strings; they MUST NOT appear in a tooltip that names a key, because the resolver does not accept them (§4.4).

## 9. Policy

### 9.1 Risk table

| Risk | Auto-apply | Confirmation | Confirmation MUST carry |
|---|---|---|---|
| `safe` | yes | none | — (one journal entry is still written) |
| `mutating` | yes | none | — (one journal entry and the undo affordance are the safety net) |
| `destructive` | no | required | `verb` (id + title), `target` (≤ 5 labels + `+N more`), `consequence`, `undoAvailability` (`undoable`, or `not-undoable` + reason) |
| `external` | no | required | the same four fields, plus the external party/artifact (file path, endpoint or shell); `undoAvailability` is ALWAYS `not-undoable` |

`safe` and `mutating` MUST apply without confirmation and MUST still write exactly ONE journal entry (§6.1). `destructive` and `external` MUST run nothing until the confirmation is accepted.

**Dismissal.** A dismissed confirmation MUST return `{status:'rejected', code:'canceled-confirmation'}`, MUST mutate nothing and MUST write no journal entry.

### 9.2 Actor identity

`actor` and `channel` MUST be asserted by the host dispatcher and MUST NOT be supplied by a model. An intent arriving on the companion or agent path whose `actor` is anything other than `companion` MUST be rejected with `actor-spoof` **before** validation step 1 (§5.2). `actorRef` MAY carry the session/turn id.

## 10. Validation contract

`validateSurface(surface)` MUST return `{valid, diagnostics[]}`. It MUST be **total and pure**: it MUST never throw and MUST never mutate its input. It MUST evaluate the rules in the order `V-01` → `V-12` and MUST append diagnostics in declaration order without sorting. Each diagnostic MUST carry the stable code and the author-facing message class below.

### 10.1 The twelve rules

| Rule | Assertion | Code | Author-facing message class |
|---|---|---|---|
| V-01 | verb ids are unique across the surface | `NAV-E001` | `duplicate verb id "<id>"` |
| V-02 | exactly one place has `parent === null` | `NAV-E002` | `surface must declare exactly one root place; found <n>` |
| V-03 | every non-null `parent` resolves to a declared place | `NAV-E003` | `place "<id>" declares parent "<p>", which is not a declared place` |
| V-04 | every parent chain reaches the root (no cycle, no dangling) | `NAV-E004` | `place "<id>" parent chain does not terminate at the root place` |
| V-05 | every `keys` binding targets a declared verb or a declared child place | `NAV-E005` | `place "<id>" key "<stroke>" targets unknown verb or place "<target>"` |
| V-06 | every referenced verb is available in that place (`appliesTo.places` covers it) | `NAV-E006` | `verb "<id>" is bound in place "<p>" but does not apply to it` |
| V-07 | no duplicate stroke within one place | `NAV-E007` | `duplicate key "<stroke>" in place "<id>"` |
| V-08 | a `directAlias` never shadows the **root place's** key bound to a *different* verb (a child place's own key is tier 1 and is never reached by an alias, so it is not a shadow) | `NAV-E008` | `direct alias "<stroke>" → "<verb>" shadows place "<p>" key → "<other verb>"` |
| V-09 | every verb declares a `risk` | `NAV-E009` | `verb "<id>" declares no risk class` |
| V-10 | every `destructive`/`external` verb has `undo` or a declared `consequence` | `NAV-E010` | `verb "<id>" is <risk> with no undo and no declared consequence` |
| V-11 | no complete binding is a strict prefix of another binding in the same place | `NAV-E011` | `key "<short>" shadows the longer sequence "<long>" in place "<id>"` |
| V-12 | every verb has non-empty `title`, `description` and `appliesTo` | `NAV-E012` | `verb "<id>" is incomplete (missing <field>)` |

V-01…V-10 cover the nine §10 obligations (the parent rule splits into V-03 and V-04); V-11 and V-12 are additive and equally binding. V-11 MUST enforce the same strict-prefix shadowing rule the shipped element registry applies (`apps/ui/src/shared/hotkeys/hotkeyElements.ts:220-232`), so a surface that violates it MUST be rejected before dispatch. `valid` MUST be `true` only when `diagnostics` is empty.

## 11. Metrics

The journal (§6) MUST be the ONLY source of every UX metric in this section. No metric MAY require a new telemetry backend, a new OTel signal or a new table; each MUST be computed from journal entry fields by replay.

| Metric | Definition (journal-derived) |
|---|---|
| Place entries / exits | count of `effect:'navigation'` entries by `verbId` (place entry) and by `exitedBy`, grouped by `placePath` |
| Alias vs place-key usage | for one verb, the share of its entries whose `placePath` ends outside the place the verb declares in `appliesTo.places` (alias resolution) versus inside it (place-key resolution) |
| Palette / launcher share | share of entries with `channel:'launcher'` or `channel:'pointer'` against `channel:'keyboard'` |
| Undo rate by actor | count of `verbId:'journal.undo'` entries grouped by the dispatching `actor`, divided by that actor's `effect:'mutation'` count |
| Abandoned prefixes | share of `navigation` place entries followed by an `exitedBy:'escape'` exit with no intervening `mutation` |
| Verb usage frequency | count of entries per `verbId`, grouped by `actor`, in DESC order |

No metric MAY be reported as an absolute or measured UX improvement: P1 ran no sessions (`docs/UX_FLUENCY_RESEARCH.md` §8.3), so a measured claim would be false. Metrics MUST be reported as counts and shares only.

## 12. Migration strategy

Legacy surfaces MUST be replaced by declared verbs, not wrapped indefinitely (§6, ADR-2 and ADR-7). During migration an adapter is the only sanctioned bridge between a legacy surface and the declaration.

### 12.1 Adapter rules and application order

An adapter **MAY** expose its legacy surface as declared verbs and **MAY** translate legacy arguments into `Intent.args`. An adapter **MUST NOT** own state and **MUST NOT** duplicate validation: the `validateSurface()` result (§10) is authoritative, and an adapter MUST NOT carry a second copy of it.

Applications MUST migrate in this fixed order: Wireframe → terminal passthrough + window traversal → diagram → mission-monitor → optimizely → my-work-items → dev-mode.

### 12.2 Adapter deletion deadlines

Every adapter MUST be deleted by its `deleteBy` phase; a phase is a hard deadline, not a target, and a `deleteBy` value MUST be one of `P5`, `P6`, `P7` or `P8`.

| Adapter id | Legacy surface it wraps | Target | `deleteBy` |
|---|---|---|---|
| `ADP-01-wireframe-actions` | `WIREFRAME_ACTIONS` (`wireframeActions.ts:365-645`) | P5 | **P5** |
| `ADP-02-wireframe-command-surface` | command-surface declaration (`wireframeCommandSurface.ts:438-444`) | P5 | **P5** |
| `ADP-03-wireframe-toolbar-list` | hand-listed toolbar groups (`WireframeToolbar.tsx`) | P5 | **P5** |
| `ADP-04-wireframe-hotkey-carrier` | two-step `data-hotkey` carrier (`WireframeHotkeyCarrier.tsx:73`) | P5 | **P5** |
| `ADP-05-data-hotkey-discovery` | element listing (`hotkeyElements.ts:47-62`, `:399-421`) | P7 | **P7** |
| `ADP-06-terminal-passthrough` | implicit terminal passthrough (`terminalMode.ts`) | P7 | **P7** |
| `ADP-07-window-traversal` | `KEPT_GLOBAL_BINDINGS` (`defaults.ts:38-57`) + `DEFAULT_FREDO_ACTION_DEFS` (`engine.ts:91-120`) | P7 | **P7** |
| `ADP-08-diagram-key` | `data-hotkey="d"` (`ArchitectureDiagram.tsx:680`) | P7 | **P7** |
| `ADP-09-mission-monitor-key` | `data-hotkey` in the history drawer | P7 | **P7** |
| `ADP-10-optimizely-keys` | `data-hotkey` `f/e/c/q` (`OptimizelyFlagsPanel.tsx:461,491,506,533`) | P7 | **P7** |
| `ADP-11-my-workitems-keys` | `data-hotkey` (`MyWorkItemsContainer.tsx:155`) | P7 | **P7** |
| `ADP-12-dev-mode-keys` | `data-hotkey` `v` (`DevMode.tsx:609`) | P7 | **P7** |
| `ADP-13-hotkey-registry` | the third declaration (`registry.ts:59-77`, `:139-166`) | P7 | **P8** |
| `ADP-14-launcher-palette` | `launcherActionPalette.ts:40-52` fed by `listHotkeyActions()` | P6 | **P8** |
| `ADP-15-companion-manifest` | `manifest.ts:73-119` + `publisher.ts:55-80` projection | P6 | **P8** |

The **P8 exit criterion** is a checkable predicate: a single grep for every `ADP-` id over `apps/ui/src/` MUST return ZERO matches. Any match at P8 MUST be treated as an unfinished migration, not as deferred cleanup.

## 13. Testing strategy

The contract MUST be testable from its own rules. P3 owns the test code; this section fixes what MUST be proven.

### 13.1 The five strategies

| Strategy | What MUST hold |
|---|---|
| Property-based key-sequence resolution | for generated surfaces and stroke sequences the resolver MUST be deterministic and MUST return exactly one intent or a named rejection; no sequence MAY produce two side effects |
| Reachability | every declared verb MUST be reachable from the root through keyboard or palette, proven by walking the `PlaceTree` |
| Journal undo invariants | for every `safe` and `mutating` verb, `undo ∘ run` MUST equal identity over `patch.before`, and a redo MUST restore `patch.after` |
| Manifest projection equality | the derived `CompanionManifest` MUST equal the projection of every `publish === true` `VerbDescriptor` — no extra row and no missing row |
| Cross-channel parity | the same verb dispatched via `keyboard`, `pointer`, `launcher` or `agent` MUST yield the same state transition and the same journal effect |

### 13.4 Cold-read check

The cold-read check MUST be executable from this document's own normative text. It measures whether that rule text ALONE determines the trace: a reader with no prior context MUST reach the same seven columns.

1. Start at the root place `wireframe.canvas` with an empty selection. Every rule the trace needs is in this document's own normative model — §1–§6 (objects, places, verbs, key resolution, dispatch, journal) — and the reading MUST NOT be widened to external material: implementation code, plans, notes, ADR files, research documents, prior traces or another reader's answers.
2. **Before consulting §4.3**, for each of the three strokes `c`, `c r` and `r`, fill one seven-column row — *stroke → tier that matched → resolved intent (verb id or place id) → args → journal effect → journal `placePath` (dispatch-time, §6.1) → cursor after the dispatch* — recording the `placePath` the completing verb's journal entry carries (§6.1: the path root → current at dispatch) and, separately, where the cursor sits once that entry's effect has been applied (§2.2 transient pop).
3. The architect's trace and the developer's trace MATCH if and only if they agree on every row **for the same stroke**: the tier that matched, the resolved intent, the args, the journal effect, the recorded `placePath` and the cursor after the dispatch. A difference on the same stroke between the two authors is a mismatch.
4. The only value that legitimately differs **between the `c r` row and the `r` row** is the journal `placePath` (`c r` = `[wireframe.canvas, wireframe.create]`, `r` = `[wireframe.canvas]`). The cursor after the dispatch is `[wireframe.canvas]` for both rows — for `c r` because the transient place pops on completion, for `r` because it never left the root. Those differences are properties of the strokes and are never a licence for the two authors to disagree.
5. Evidence MUST be the two filled seven-column tables (`.opencode/tmp/3116/cold-read-architect.md` and `.opencode/tmp/3116/cold-read-developer.md`) plus a one-sentence match statement naming any row that differed.
6. §4.3 is the published answer key: it must contain the three traces by design, so the check is never blind. A reader MUST write their own table from §4.1–§4.2 FIRST and only then compare it against §4.3 — the check measures rule sufficiency, not memory of the examples.

## Open questions

Non-normative; never counted among the thirteen sections and never cited by §2–§13.

- **Journal persistence across application restarts** (does undo survive a reload, or is the journal session-scoped only?) — owner: Software Architect, phase: P3.
- **Redo-stack retention bound** (maximum depth and memory ceiling) — owner: Software Architect, phase: P3.

## 11. P4 surfaces — the perceivable layer (Spec #3118)

> **Numbering note.** This appended phase section is bound as **§11 "P4 surfaces"** by the
> #3118 plan and QA rows; it is the contract of record for the P4 surface layer and sits
> after the phase-independent contract above (whose own §11 is Metrics). Its subsections are
> §11.1, §11.2, §11.3 and §11.5. **§11.4 is owned by ST-6** — the recorded manual
> screen-reader pass — and is appended separately; it is not written here.

The P4 layer makes the headless model perceivable: a **`CommandRail`** (where am I / what can
I do next), a **`NavigationMap`** (the whole place tree), an **`ActivityTrail`** (what just
happened) and one polite announcement layer. Every surface is a projection of the SAME
declaration — no surface carries a key table, a `VerbDescriptor[]` or a second binding
derivation.

### 11.1 The one projection layer

The view-model layer lives in `apps/ui/src/shared/navigation/ui/` (a subdirectory of the
headless module; it is never re-exported by `shared/navigation/index.ts`, so the P3
eleven-module purity scan is untouched).

| Module | Binding contract |
|---|---|
| `ui/constants.ts` | Test ids, data attributes, accessible names, copy, glyph↔verb map, motion and bounds (§11.2). |
| `ui/types.ts` | `NavPlaceRef`, `NavRiskCue`, `CommandRailRow`, `NavAffordance`, `CommandRailModel`, `NavigationMapVerb`, `NavigationMapKey`, `NavigationMapPlace`, `NavigationMapModel`, `ActivityTrailEntry`, `ActivityTrailModel`. |
| `ui/format.ts` | `formatKeyHint`, `formatPlacePathLabel`, `formatTrailTime`, `riskLabel`, `navTooltip`. |
| `ui/models.ts` | `buildCommandRailModel`, `buildNavigationMapModel`, `buildActivityTrailModel`. |
| `ui/useReducedMotion.ts` | `useNavReducedMotion()`. |
| `ui/usePlaceTransitionFocus.ts` | `usePlaceTransitionFocus(model)` — place-transition focus retention for the rail (§11.5); no prop, no document listener. |

Each builder is total and pure over the declaration plus the injected read model:

- **Rail** — `buildCommandRailModel(surface, snapshot)` composes the shipped
  `deriveRail` over a declaration whose `app.map` / `app.ask` verbs have been filtered out
  **before** the projection runs, so the two globals can neither occupy a row nor inflate
  `overflow`/`actionCount` (§3.1: V-05 forces both to be declared verbs, so `deriveRail`
  would otherwise return them as ordinary rows for any place that binds `m`/`k`). The
  breadcrumb/current place come from `buildContextEnvelope(...).placePath` (declaration
  labels), falling back to the declared root. `actionCount = rows.length + overflow`.
  `more` appears only when `overflow > 0` and opens the map filtered to the current place.
  The two affordances are always present: `/ Ask` is ENABLED — activation opens the launcher (§P6.3); `? Map` is enabled. Neither tooltip ever contains a glyph (a tooltip names `m`/`k`).
- **Place rows** — `CommandRailModel.placeRows` lists the current place's **child places** in
  declaration order (`registry.childrenByParent`), each `{placeId, label, key, keys, keyHint,
  transient, tooltip}`. An entry stroke is a `{kind:'place'}` binding or a verb whose id is the
  child place id. Place rows render ABOVE the verb rows and are **not** part of `rows`,
  `overflow` or `actionCount` (those count the current place's bound verbs only). A leaf place
  has `placeRows: []`; the root lists its six children. Clicking a place row runs the place id
  (a place-entry verb's id equals the place id, so the host enters it).
- **Map** — `buildNavigationMapModel(surface, snapshot, { filteredTo })` composes the shipped
  `deriveMap` tree order with `createRegistry(...).verbsById`, each verb's
  `available(snapshot)` and the shipped `formatTooltip` (through `navTooltip`); it never
  re-derives bindings. Per block it exposes `pathLabel`, depth, transient/sticky, the place's
  verbs and the place's **keys** (bound strokes). Three distinct regions: place keys (inside
  blocks), application-level **aliases** (declaration order, rendered after all blocks), and
  the two **globals** with their display glyphs. A stroke bound to `app.map`/`app.ask` is
  rendered ONLY in the globals region (never duplicated inside a block); a global row is
  emitted only when the declaration actually binds that verb. `filteredTo` is a seeded filter,
  never a second list — the map always renders the full model, filtered client-side.
- **Trail** — `buildActivityTrailModel(surface, entries)` reads the append-only
  **`JournalEntry[]`** (not the thinner `JournalSummary`, because only the entry carries
  `placePath` and `consequence`), sorts `seq` DESC (newest first), caps at the declared
  `CAPABILITY_LIMITS.maxJournalEntries` (10) and resolves the place path through the
  declaration (the declaration is the only label source). Undo is gated by the ENTRY
  (`isUndoable(entry) === (entry.inverse !== null)`), never by `undoAffordance(verbId).disabled`
  (verb-keyed and `disabled: false` for unknown verbs); `undoAffordance` is consulted only for
  the non-undoable explanation text, which prefers the entry's authored consequence. A
  historical entry's `label` is the label authored at dispatch and is never re-derived.
- **Formatters** — `formatKeyHint` shows the FIRST binding only, tokens joined by `' then '`
  (`['w n']` → `'W then N'`, `[]` → `''`); `formatPlacePathLabel` joins with `' › '`;
  `formatTrailTime` formats a supplied ISO timestamp with
  `Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`
  (the cycle is PINNED, so midnight is `00:00` on every host); `riskLabel` is `null` for
  `safe`; `navTooltip = formatTooltip(title, keys, risk)` plus `' — <reason>'` iff a reason is
  supplied.
- **Reduced motion** — `useNavReducedMotion()` reads
  `(prefers-reduced-motion: reduce)` and subscribes to changes; it fails safe to `false` when
  `matchMedia` is absent (jsdom / SSR). It carries a single `useEffect` with an empty
  dependency array — no `.length`/fresh-array dependency, no state write that could retrigger.

Purity: the layer reads no clock (`ts`/`now` are supplied), no DOM, no storage; it adds no
dependency and no theme token.

**P6 consumers (Spec #3120).** The launcher consumes the same layer and adds its own
presentational modules under `applications/home/components/launcher/`:
`launcherNavigationPalette.ts` (the grouped Place → Verb projection, row actions and the pure
client-side filter), `launcherUndoQuery.ts` (undo-by-description), `launcherRoute.ts` (the pure
Enter precedence), `LauncherNavigationList.tsx`, `LauncherConfirmation.tsx` and the
`LauncherShell` integration (context header, secondary actions, response line, ONE announcer).
The launcher reads the host through `ui/hostRegistry.ts` (`getNavigationHost` /
`describeContext`) and runs every palette/secondary row through `NavigationHost.runIntent` —
never `runHotkeyAction`. A performed navigation result keeps the launcher open and announces the
new place; a performed mutation, external action or `journal.undo` closes it so the change and
its trail entry are visible; `canceled-confirmation` stays silently; `noop` / `rejected` /
`failed` stay with the ONE response line. The legacy `>` hotkey-action list remains only for an
application with no declared surface.

### 11.2 The bound names block (`ui/constants.ts`)

Every test id, data attribute, accessible name, copy string and bound below is BINDING; a
surface renders the constant, never an invented literal (G-324/G-419).

- **DOM hooks** — `navigation-rail*`, `navigation-map*`, `navigation-trail*`,
  `navigation-keycap*`, `navigation-announcer` (one test id per named element).
- **Data attributes** — `data-nav-surface` (`rail`|`map`|`trail`), `data-nav-keycap`,
  `data-nav-place-id`, `data-nav-verb-id`, `data-nav-actor`, `data-nav-current`,
  `data-nav-availability`, `data-nav-risk`, `data-nav-compact`.
- **Accessible names** — `Command rail`, `Navigation map`, `Activity trail`,
  `Navigation announcements`.
- **Copy** — `more…`; the empty trail `Nothing yet — your actions will appear here`; the
  generic disabled reason `Not available for the current selection`; the transient suffix
  `one action`; risk words `Safe`/`Changes`/`Destructive`/`External`; actor words
  `You`/`Companion`/`System`;
  and the G-324 bundle `Search places, actions and keys`, `No matching places, actions or
  keys`, `Direct aliases`, `Global keys`, `Current place`, `No actions in this place`,
  `↑ ↓ move · Enter run · Esc close`, plus `NAV_RAIL_MIN_WIDTH_PX = 180` (design intent — the
  measured no-scroll proof is live, not a jsdom width read). The P4 launcher reason
  `Ask arrives with the launcher in the next phase` is RETIRED — no constant, no rendered node.
- **Globals** — `app.map` is bound to `m` and displays the glyph `?`; `app.ask` is bound to
  `k` and displays `/`; accessible glyph names are `Question mark` / `Slash`. A glyph is never
  a binding value.
- **`/ Ask` (P6)** — the rail affordance is ENABLED: `enabled: true`, `reason: null`,
  `aria-disabled` absent, visible label `Ask`, tooltip `Ask (k)`; activation calls
  `requestLauncherOpen({source:'rail-ask', focus:true})`, and the declared `app.ask` verb is
  `available: always` and opens the same seam with `source:'ask-verb'` (§P6.3).
- **P6 launcher names** — the launcher's DOM hooks, `data-*` attributes, accessible names and
  copy are a separate binding block in
  `applications/home/components/launcher/launcherConstants.ts` (§P6.4). They rename no P4
  name above and are the only source the launcher renders.
- **Motion / bounds** — `NAV_MOTION_MS = 150` (opacity/transform only),
  `NAV_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'`, `NAV_RAIL_MAX_ROWS = 8`
  (mirrors `discover.RAIL_MAX_ROWS`; the rail never pads to `RAIL_MIN_ROWS`).
- **Root-export boundary** — no dev-route literal lives here. `'view'` / `'navigation-preview'`
  are inlined in `Router.tsx`'s DEV branch and `NAV_PREVIEW_GLYPH_KEYS` is module-local to the
  dev preview, so the production bundle cannot contain a dev-route marker by construction.

### 11.3 The three AC phrase resolutions (`## Discussion` of #3118)

These three clauses of the backlog cannot be honoured literally against the shipped shape.
Each is resolved here explicitly — none is a silent substitution, and each is proven by a
named row.

1. **AC1 "unavailable verbs … not hidden — unless the place declares them hidden" — INERT.**
   `PlaceNode` has no `hidden` field. P4 hides nothing: every bound verb renders in
   declaration order, disabled with the bound generic reason when `available(ctx) === false`.
   No field is added in this slice; a per-place/verb hiding field would be a P3 declaration
   change (a named follow-up, not a UI change). No verb is hidden in any state.
2. **AC2 "opens on `?`" and the rail's `/ Ask` / `? Map` — DISPLAY GLYPHS, not bindings.**
   This contract (§4) is normative: the bindable declarations are `m` (map) and `k` (ask).
   P4 renders glyph-labelled controls (`? Map`, `/ Ask`) and always names the bindable stroke
   in every tooltip and across the API (`NavAffordance.binding`); the DEV prototype route may
   also accept the literal `?`/`/` characters in its own element-scoped handler, but no
   document-level listener is added and no binding value or tooltip ever contains a glyph.
3. **AC6 "rail, map and trail all reflect it" — one AGGREGATE proof plus two invariants.**
   `projectionMutation.test.ts` applies, on ONE cloned declaration with no other edit,
   (a) add a place, (b) rename a verb title, (c) add a direct alias — then resolves and
   dispatches a stroke FROM the mutated place and asserts that the rail (breadcrumb/current
   place + renamed row title), the map (new block + renamed verb + alias row) and the trail
   (new entry's label + place path/pathLabel) all reflect the mutation. Two residuals are
   pinned as **invariants** so the aggregate cannot be "passed" by re-deriving history:
   (i) a verb-title rename never rewrites a historical entry's label (the label is authored at
   dispatch); (ii) a direct alias adds no rail row and changes no `keyHint` (the rail reads
   place bindings only; aliases are tier 2). The four-cell per-mutation matrix is
   supplementary coverage, and the trail's newest-10 rendering is a declared bound
   (`CAPABILITY_LIMITS.maxJournalEntries`), not a defect.

### 11.4 Recorded manual screen-reader pass (P4)

- **Screen reader:** Windows Narrator — the reader bundled with Windows 10 22H2 (build 19045).
- **OS:** Microsoft Windows 10 Pro 22H2, build `10.0.19045` (WebView2 host).
- **Route:** `/?view=navigation-preview` (DEV-only; `import.meta.env.DEV` + the lazy branch in
  `app/routes/Router.tsx`).
- **Instrument disclosure:** the log below is the application's REAL live-region /
  accessibility-tree text — the single polite region
  (`role="status" aria-live="polite" data-testid="navigation-announcer"`) — captured by driving
  the real `NavigationAnnouncer` and `NavigationHost` through each event, i.e. the same text a
  screen reader announces. It is **not** captured audio; no microphone or acoustic capture was
  used, and no string below was invented — every line is the output of its bound `nav*Message`
  composer (`announcementLog` pin in `ui/__tests__/a11y.test.tsx`).
- **Ordered announcement log (the eight exercised classes):**
  1. **place enter** — `Arrange — 9 actions`
  2. **place exit** — `Left Arrange — Canvas — 6 actions`
  3. **prefix armed** — `w… View, Style`
  4. **unresolvable key** — `z isn't available here`
  5. **ambiguous key** — `x matches more than one action`
  6. **undo** — `Undid Rectangle`
  7. **nothing-to-undo** — `Nothing to undo.`
  8. **undo failed** — `Couldn't undo Rectangle`
- **Attester:** Developer (agentic pipeline, ST-6), 2026-10-30.

The per-component focus/name legs live in the ST-2/ST-3/ST-4 suites; this record is the
manual-pass artifact and the cross-surface composite is `ui/__tests__/a11y.test.tsx`.

### 11.5 P4 surface rules

- **Theme:** theme tokens and the shared `tint()` helper only — zero hex/rgb/hsl literals and
  zero `var(--x)NN` alpha-appends in `shared/navigation/ui/**`. No new theme token and no
  `CONTRACT_PAIRS` row. The binding AC5 proof is the mirrored scoped `scanRawColors` sweep
  (`navTheme.test.ts`); widening the shipped `defaultScanTargets()` to `shared/` is a named
  follow-up (G-406), and `contrast:gate` still runs over its existing target set.
- **Motion:** transitions/animations animate `opacity`/`transform` only, at `NAV_MOTION_MS`,
  and are disabled when `prefers-reduced-motion` is set (the `reducedMotion` prop /
  `useNavReducedMotion()`).
- **One live region:** the P4 navigation surfaces declare no `aria-live`; the navigation announcement layer owns the single `navigation-announcer` polite region. P6 adds exactly ONE launcher region — `launcher-palette-announcer` (`role="status"`, `aria-live="polite"`, `aria-label="Launcher announcements"`) — mounted only while the launcher is open over a registered navigation host; the launcher's response line is NOT a live region, and the shipped command bar's own voice/queue regions are pre-existing and unchanged. A migrated application therefore has one navigation region plus (while the launcher is open) one launcher region — never two competing regions inside the same surface.
- **Bounded DOM:** rail verb rows ≤ 8 (never padded) and no more than the place's bound verbs;
  child-place rows (`placeRows`) are a separate, tree-bounded section and never count against
  that cap; trail entries ≤ 10 (newest first); map rows = the declared tree. No polling: the
  only timer is the host's one-shot `PENDING_TIMEOUT_MS` (250 ms) prefix clear.
- **No persisted presentation state:** map open/filter/search and the pending prefix live in
  host/component state only — no storage, no settings key.
- **No second source of truth:** no prop carries a key table or a `VerbDescriptor[]`; every
  surface renders the model built here, and the a11y invariants (role/name, risk as text,
  keycap accessible names, focus trap/restore) are owned by the surface components.
- **Place-transition focus retention (`#3119` retry, R-9/AC9):** place rows are the current
  place's children, so entering a place unmounts the row a keyboard user is standing on and
  the browser falls back to `document.body` — which also silences the shell's one
  element-scoped key adapter. `CommandRail` therefore re-homes focus it dropped (the same
  control when it renders again, else the always-rendered `navigation-rail-place` heading,
  `tabIndex={-1}`) and returns to the triggering row when the place is exited (`Escape`). It
  acts only when the tracked in-rail control is disconnected AND `document.activeElement` is
  `body`/null; focus the user moved elsewhere (canvas, details view, map dialog, another
  control) is never touched. No prop, no `document`/`window` listener, no timer, no state
  write — `ui/usePlaceTransitionFocus.ts`.

## P6 launcher + agent bridge (Spec #3120)

> **Numbering note.** This is a phase section appended after the thirteen numbered contract
> sections. Its subsections are `§P6.1`–`§P6.9` and never renumber §1–§13 or the appended P4
> §11. It records the behaviour shipped by Spec #3120. Nothing in §1–§13 is rewritten: only
> the affected clauses are amended in place — §6.4 (undo attribution), §8.1 (manifest
> projection), §11.1 (consumers), §11.2 (`/ Ask` copy) and §11.5 (live-region scope).

P6 takes the headless model out of the Wireframe window: the **launcher** becomes the second
consumer of the same declaration and the same `dispatch()` funnel, so conversation, keyboard,
palette and the agent bridge are one system. No new noun, no second dispatch path and no
transcript are introduced.

### P6.1 The host registry and the fresh context seam

The ONE stateful seam is still `NavigationHost`. P6 makes it reachable synchronously from the
launcher through a module-scoped registry (`shared/navigation/ui/hostRegistry.ts`):

```ts
interface NavigationHostRegistration {
  readonly appId: string;
  readonly surface: Surface;
  readonly host: NavigationHost;
}
function registerNavigationHost(reg: NavigationHostRegistration): () => void; // idempotent
function getNavigationHost(appId: string): NavigationHost | null;
function getRegisteredSurface(appId: string): Surface | null;
function listRegisteredSurfaces(): readonly Surface[];
function describeContext(appId: string): ContextEnvelope | null; // null ⇒ AC1 fallback
function subscribeNavigationHosts(listener: () => void): () => void;
```

- **Registration is the provider's mount effect.** `registerNavigationHost` replaces the entry
  for its `appId` (a StrictMode remount is safe) and its disposer removes only the entry it
  created — a stale disposer never removes a newer registration. The registry holds no
  state beyond the live registrations: no persistence, no clock, no I/O.
- **`describeContext` is FRESH.** `hostRegistry.describeContext(appId)` calls the host's own
  `describeContext()`, which is `buildContextEnvelope(surface, currentContext(),
  journal.entries())` on every read — never a cached snapshot. A missing registration is the
  AC1 fallback (`null`), and the launcher then renders the shipped resting/engaged surface
  byte-identically.
- **`refreshContext` publishes context changes (never mutations).** The owning application's
  provider subscribes to its own store and calls `NavigationHost.refreshContext()` when the
  injected context changed. The decision is a **value** fingerprint over exactly the fields
  `buildContextEnvelope` consumes (`appId`, `placePath`, `selection.count`/`ids`/`kinds`/`label`,
  `dirty`) — never reference identity, because the getter allocates a fresh object per call. A
  real change advances `epoch` by exactly 1 through an empty `commit()` (no announcement, no
  journal entry, no snapshot-shape change); a value-equal refresh is a strict no-op (the same
  `getSnapshot()` reference and the same epoch). `describeContext()` stays a pure read and never
  advances the epoch.
- **`runIntent` is the only runner.** `NavigationHost.runIntent(intent)` carries the full
  `Intent` (`verbId`, `args`, `channel`, `actor`, `actorRef`) into the ONE `dispatch()` funnel,
  so the launcher and the agent bridge can express `channel:'launcher' | 'voice' | 'agent'`
  with `actor:'human' | 'companion'` instead of the channel-derived `run()`. The §5.2
  validation order (existence → availability → arguments → risk) is unchanged.
- **The confirmation seam is async, additively.** `EngineDeps.confirm(request, intent)` returns
  `boolean | Promise<boolean>`. A promise is awaited at risk step 4; a falsy sync decision is
  the shipped `canceled-confirmation` before the verb runs. The Wireframe provider gates only
  `launcher`/`voice`/`agent` channels through the launcher confirmation store; a
  `keyboard`/`pointer` human intent keeps the shipped no-confirm behaviour.

The launcher derives its `activeAppId` from the focused, non-minimized window, memoizes
`navContext` on the host identity + the host snapshot `epoch` (never an effect + `setState`,
never a poll), and re-derives on every host notification. The `epoch` advances on a host
mutation **or an injected-context change**: the application's provider publishes its store's
selection/dirty changes through `NavigationHost.refreshContext()`, so a store-only selection
change (including at the root place, with no dispatch) re-derives the header and the grounding
envelope without a remount or reload — as does a dispatch that changes the place. The host
snapshot subscription uses `useSyncExternalStore`, so neither path remounts or reloads the
launcher.

### P6.2 One box, three routes

The shell's existing Enter handler is extended (no second `document` keydown listener). While
`navContext !== null`, `resolveLauncherRoute({ query, entries, textOrigin, companionActive,
captureLive, paletteActive })` decides in this fixed precedence:

1. `captureLive` → the shipped `none/listening` verdict (nothing dispatches);
2. first non-whitespace `>` → the grouped Place → Verb palette;
3. an undo rule → `journal.undo` with the matched args;
4. `no-match-undo` → a clarify response (`UNDO_NO_MATCH_COPY`);
5. `ambiguous` → a clarify response (`UNDO_AMBIGUOUS_COPY`);
6. otherwise → the shipped `resolveEnterAction` verdict, unchanged.

The route module is consulted ONLY when a host is registered; an app with no surface takes the
shipped Enter path verbatim, so a `>` query still renders the legacy `LauncherActionList` and
`runHotkeyAction(id,'palette')`, and an undo-shaped phrase takes the ordinary send path.

**The palette projection** (`launcherNavigationPalette.ts`) consumes the shipped P3
`derivePalette` directly, so row order can never drift from the declared derivation: recents
first (newest-first, deduped, stale ids dropped, capped at `PALETTE_MAX_RECENTS = 5`), then
every verb grouped by place in tree order. Each row carries the full place path
(`formatPlacePathLabel`, `' › '` join), the row place's first key + `formatKeyHint`, the risk
and — only for a non-`safe` row — a risk label, plus `available`/`reason`
(`NAV_UNAVAILABLE_REASON`). `filterLauncherPaletteModel` is a pure case-insensitive substring
over `title + pathLabel + keyHint`; empty groups are dropped and `rows` is re-flattened so the
selection index stays stable. `buildLauncherRowActions` is the ONE level-2 source: `run`, then
`undo` only when that verb has an undoable journal entry (label names the entry; dispatch verb
is `journal.undo`), then `map` (the `NavigationMap` dialog, never a third launcher level).

The launcher is a **runner, not a second handler**: Enter on a palette row calls
`host.runIntent({ verbId, args: {}, channel: 'launcher', actor: 'human' })`; Enter on a
secondary action does the same with the action's dispatch verb (a row-targeted undo adds
`{ verbId }`). An unavailable row stays selectable, announces its reason, and dispatches
nothing. The close/stay matrix is fixed:

| Result | Launcher |
|---|---|
| `performed` + `navigation` (not undo, not external) | stays open, announces the new place (`navPlaceEnterMessage`) |
| `performed` + mutation / external / `journal.undo` | closes, focus restored, so the change and its trail entry are visible |
| `rejected` + `canceled-confirmation` | stays open, silent (the user chose it) |
| `noop` / other `rejected` / `failed` | stays open with the ONE response line |

`Cmd`/`Ctrl+K` opens/toggles the focused row's secondary actions; `Esc` pops exactly one
nested level and, at the top level, closes the launcher and restores the pre-open focus. Both
are branches of the EXISTING shell handler.

### P6.3 `/ Ask` and the launcher-open bridge

`app.ask` is a real affordance: it is declared `available: always`, performs a `navigation`
effect, and calls `requestLauncherOpen({ source: 'ask-verb', focus: true })`. The rail's
`/ Ask` control calls the same bridge with `source: 'rail-ask'`, and the bridge also accepts
`source: 'keyboard'`. The shell subscribes once:

```ts
interface LauncherOpenRequest {
  readonly source: 'ask-verb' | 'rail-ask' | 'keyboard';
  readonly prefill?: string;
  readonly focus: true;
}
```

On a request the shell raises the launcher through the shipped `openOverlay()` (which captures
the pre-open element), writes any prefill through the ONE controlled-query route, and focuses
the command input on the next frame. Closing therefore restores focus to the element that
asked — the rail button, or whatever had focus before `Ctrl+Space`. The P4 disabled reason
`Ask arrives with the launcher in the next phase` is retired: `NAV_ASK_DISABLED_REASON` no
longer exists, the affordance carries no reason node, and the tooltip is `Ask (k)`.

### P6.4 Launcher names, hooks and copy (binding)

The launcher's names block is `applications/home/components/launcher/launcherConstants.ts`;
every launcher surface renders these constants (no invented literal). It is additive to the P4
`ui/constants.ts` block and renames nothing there.

- **DOM hooks** — `launcher-context`, `launcher-context-path`, `launcher-context-selection`,
  `launcher-context-verbs`, `launcher-context-verb`, `launcher-palette-list`,
  `launcher-palette-group`, `launcher-palette-group-path`, `launcher-palette-row`,
  `launcher-palette-row-key`, `launcher-palette-row-risk`, `launcher-palette-secondary`,
  `launcher-palette-secondary-item`, `launcher-confirmation`, `launcher-confirmation-verb`,
  `launcher-confirmation-target`, `launcher-confirmation-consequence`,
  `launcher-confirmation-undo`, `launcher-confirmation-accept`,
  `launcher-confirmation-cancel`, `launcher-palette-announcer`, and the response line
  `launcher-response`.
- **Data attributes** — `data-launcher-response`
  (`clarify`|`rejected`|`undo-nothing`|`undo-failed`), `data-launcher-code` (the
  `DispatchResult.code` on a rejected/failed line), `data-launcher-section`
  (`recent`|`place` on a row) and `data-launcher-action-kind` (`run`|`undo`|`map` on a
  secondary item). Row selection/availability reuse the P4 `data-nav-*` hooks.
- **Accessible names** — `Current context` (context group), `Selection`, `Actions`, `Recent`,
  `Places and actions` (palette listbox), `Row actions` (secondary listbox), `Action` /
  `Target` / `Consequence` (confirmation fields), `Launcher announcements` (the ONE polite
  region), and the row announcement `Title — Canvas › Edit — Destructive — X`.
- **Copy** — `No context`, `No places or actions match`,
  `That action couldn't run. Nothing changed.`, `Run <title>?`, `Apply <title>`, `Cancel`,
  `Undo available`, `Not undoable`, `Outside Fredo: <party>`, and the two clarify sentences
  (below). A safe row carries NO risk word.
- **Bounds** — the palette is one listbox with one group per place and an internal scroll bound
  (`maxHeight: min(52vh, 420px)`); the context header shows at most 3 available verbs plus
  `+{n-3}`; the secondary level is at most one level deep.

### P6.5 Risk policy end to end, and the confirmation contract

§9.1 is enforced by the one funnel for every launcher/voice/agent intent:

- **`safe` and `mutating` auto-apply**, write exactly one journal entry, and never render a
  confirmation.
- **`destructive` and `external` render a launcher confirmation and apply nothing until it is
  accepted.** The dialog is an `alertdialog` named `Run <title>?` with `Cancel` focused; it
  names the verb, the target, a non-empty consequence, the undo availability, and — for an
  `external` verb — `Outside Fredo: <party>`. Accept resolves `true`; `Cancel`, `Esc` and a
  backdrop click resolve `false`. The store is single-pending: a second request supersedes
  the first, a double resolve is guarded, and the LAST launcher unsubscribe cancels a pending
  request.
- **Dismissal is not an error.** A cancelled confirmation returns
  `{status:'rejected', code:'canceled-confirmation'}`, mutates nothing, writes NO journal entry
  and shows no error line. A request made with no launcher mounted resolves `false`
  immediately.
- **Keyboard/pointer keeps the shipped behaviour.** Only `launcher`/`voice`/`agent` channels
  are gated; a human `keyboard`/`pointer` dispatch still applies without a prompt (the journal
  is the undo).
- **The external risk class ships in the pilot declaration.** `wireframeSurface.ts`
  reclassifies `place.exportPng` (`Export PNG`) from `mutating` to `risk:'external'`, authors a
  consequence (`"Writes a PNG file outside Fredo's document history. It cannot be undone from
  the trail."`) and `externalParty:'your file system'`; the shared `VerbDescriptor` gained the
  optional `externalParty` and the funnel prefers it over the derived party. The verb remains
  non-undoable (§6.3) and its rail/shell action is unchanged. The other three file verbs stay
  `mutating` this round.

### P6.6 Undo attribution and undo by description

Undo is journaled to the REQUESTER (§6.4): `dispatchUndo` writes
`actor = intent.actor === 'companion' ? 'human' : intent.actor` and
`channel = intent.channel`, so a companion-channel undo is a human's reversal and reads `You`
in the trail; a `system` requester keeps `system`. `host.undoEntry(seq, options?)` accepts
`{ actor?, channel? }` and defaults to `{actor:'human', channel:'pointer'}` for the trail
button. The trail renders the entry's own actor and label — no new visual language.

The launcher's undo-by-description matcher (`launcherUndoQuery.ts`) is one pure phrase table
over case/punctuation-normalised text:

| Phrase shape | Result |
|---|---|
| companion + last | `journal.undo` `{actor:'companion', count:'1'}` |
| companion + N | `journal.undo` `{actor:'companion', count:'N'}` |
| last / bare undo | `journal.undo` `{count:'1'}` |
| `undo that` / `undo it` | ambiguous → `Tell me whose change to undo — yours or the companion's. Nothing changed.` |
| undo-shaped, no rule | `I couldn't tell which change to undo. Nothing changed.` |
| anything else | an ordinary query (routes to the companion) |

Counts may be digits or number words and are bounded 1..100; a leading `revert` is the
manifest undo alias. A clarify result renders ONE response line and dispatches nothing; the
two miss variants are never conflated (a non-undo query is never captured). The undo intent is
still `journal.undo` through `host.runIntent`, so the typed and spoken origins share the
funnel.

### P6.7 The unified companion manifest and the engine `journal.undo` row

The published manifest is now ONE projection with two possible sources
(`shared/companion/manifest.ts`): a registered navigation `Surface` projected through
`shared/navigation/manifest.ts`, or the legacy `feature.commandSurface` projection (the P7
migration path). **Navigation wins per `appId`** — a registered navigation surface suppresses
the legacy projection for that app, so an application never publishes two competing capability
sets; legacy applications keep publishing exactly as before. A navigation command always
carries all six fields (`id`, `label`, `description`, `risk`, `args`, `aliases`) read from the
projection, never re-derived from the source verb.

`journal.undo` has no `VerbDescriptor` (it is an engine verb), so it is appended explicitly by
`buildCompanionManifest(surface)` after the published verbs and BEFORE the reserved
`listActions` id, guarded so a hand-published duplicate is never added twice:

```ts
ENGINE_COMPANION_UNDO_COMMAND = {
  id: 'journal.undo',
  label: 'Undo',
  description: 'Undo the newest change; optionally filter by actor (human, companion or system) and count (1..100).',
  risk: 'mutating',
  args: [{ name: 'actor', required: false }, { name: 'count', required: false }],
  aliases: ['undo', 'revert'],
}
```

For the shipped Wireframe declaration: 55 verbs, of which the 6 place-entry verbs are
`publish:false` → 49 published verbs, plus `journal.undo` → 50 commands and 51 `actionIds`
including `listActions`. The Rust wire type gained additive `risk: Option<String>` and
`aliases: Vec<String>` with absent-key semantics: `risk` is absent for a legacy
command-surface command and `aliases` is absent when empty — never `null`. The publisher also
subscribes to host-registry changes, so an application that mounts after boot republishes its
navigated capability set.

App-side execution stays on the same relay contract: `useAppCommandIntent` resolves the
registered host and, when one exists, runs
`host.runIntent({ verbId: action, args, channel: 'agent', actor: 'companion' })`; otherwise it
falls back to `executeCommand`. A rejection (`unknown-verb` / `unavailable` / `invalid-args`)
applies nothing and is reported as the typed code.

### P6.8 The voice-parity boundary (routed-intent seam; no transcript)

Voice parity is proven at the **routed-intent seam**, not at the audio layer: the same
`verbId` and `args` arriving from the typed launcher and from the voice/agent origin produce
the same `dispatch()` outcome, the same resulting state and the same journal effect. The
`channel` value (`launcher` vs `agent`) and the accompanying `actor` (`human` vs `companion`)
MAY differ because the two paths genuinely differ; that pair is the only allowed difference.
The scripted routed intent for QA is the real `app_command_intent` relay — the same channel a
voice turn's skill call produces — which is why no audio fixture or transcript is required.

The audio → intent interpretation is model-mediated and human-gated: there is **no transcript**
anywhere on this path. The captured clip is the turn's `input_audio` content part, the
companion receives at most ONE `ContextEnvelope` per turn (serialized as
`JSON.stringify(context)`, bounded by `CAPABILITY_LIMITS.maxContextBytes = 16384`, prepended as
one `system` message before the persona + user turn), and no history or message array is added.
An over-cap envelope is dropped rather than truncated (a truncated serialization is not valid
JSON).

### P6.9 The human pilot-exit gate (not recorded here)

The machine-deliverable half of the gate is the committed, non-consumed evaluation template
at [`docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md`](agentic-pipeline/evaluations/3120-pilot-exit-review-template.md).
It carries the per-participant and per-task columns, the six verbatim gate lines
(`GO-1`…`GO-4`, `PRE-1`, `PRE-2`), the cohort quotas and the three research-question rows with
empty quote slots — but **no participant data and no verdict**. The sessions, the data and the
`Verdict: GO|NO-GO` are human-produced (Gate H handoff:
`spikes/3115-navigation-engine/session-kit/gate-h-input-template.md` →
`.opencode/tmp/3115/sessions/participant-notes.md`), and
`spikes/3115-navigation-engine/session-protocol.md` is reused verbatim and is not edited by
this spec.

**This document records no pilot verdict and no session result.** The P1 comparator is the
documented qualitative baseline in `docs/UX_FLUENCY_RESEARCH.md:544,550-552,614` (P1 ran no
sessions); a measured improvement claim would be false and is never made here.
