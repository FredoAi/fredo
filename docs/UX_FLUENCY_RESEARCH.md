> **Status:** STAGE 1 — method + model; results pending Gate H.

# Fredo Navigation Fluency Research (Issue #3115)

## 1. Executive Summary

This is a **research spike**, not a product change. Its question is whether Fredo should
fund a place-based navigation model (a declared place tree with object-first verbs, a command
rail, a `?` map, launcher-centred conversation and attributed auto-apply) instead of shipping
another flat hotkey layer. The deliverable is **evidence**, and the decision instrument is a
numeric go/no-go gate — not a feature.

Four workstreams, in order:

| # | Workstream | Output |
|---|---|---|
| A | Principle synthesis | §2 of this report — each principle with an external source and a Fredo-specific rule |
| B | Current-state teardown + heuristic evaluation | §3 and §4 — a reproducible matrix over nine shipped surfaces, then repo-anchored findings |
| C | Clickable prototype | §5 + a throwaway static prototype under `spikes/3115-navigation-engine/prototype/` |
| D | Moderated sessions + baseline metrics | §6–§10 — protocol, task set, metrics, RQ answers, per-participant evidence |

**The gate is the deliverable.** A **NO-GO** (or REDESIGN) verdict is a successful outcome: it
names the failed threshold, what participants actually did instead, and one concrete redesign
hypothesis, so the owner can make a funded decision *not* to build. No retry is scheduled to
"get a GO". P2 (the framework spec) does not start without the recorded human decision.

**No results exist yet.** This document is Stage 1: the principle set, the teardown and the
heuristic evaluation are complete; the prototype, protocol, metrics, research-question answers,
verdict and per-participant appendix are *methods awaiting data*. The human-only session stage
(Gate H) has not produced data, so every results section carries an explicit pending-gate marker
that Stage 2 replaces with transcribed human data. No participant, rating, quote or "typical
finding" in this document is real; fabricating one would corrupt the funding decision the spike
exists to inform.

**Explicit limitation, stated up front.** The sessions run on the prototype only — the issue
forbids driving the shipped app — so this design **cannot** measure a controlled improvement over
the shipped flat-key Wireframe. The teardown in §3 is the qualitative comparator; no measured
"improvement over the shipped UI" is claimed anywhere. See §11.1.

## 2. Design Principles and Fredo Rules

### 2.1 Principle Set

Each row is a design constraint the navigation framework must satisfy, an external source for
it, what it means for Fredo specifically, and the observable §4.1 scores. Sources are the issue's
cited prior art; no study numbers are invented here.

| ID | Principle | Source | Fredo rule / implication | Observable scored in §4.1 |
|---|---|---|---|---|
| P-01 | **Modes are only helpful when visible and escapable.** A mode the user cannot see is indistinguishable from a bug; a mode the user cannot leave is a trap. | https://www.nngroup.com/articles/modes/ | Every input state must have a visible indicator naming it and a single, predictable exit (Escape pops one layer). A hidden *set* of modes — showing only the active label — is a violation of the principle even when each mode individually works. | Mode visibility (does the UI reveal which states exist?) and escapability (does one Escape return to the prior state?) |
| P-02 | **Prefer non-modal UI; reserve modality for decisions that must be resolved.** Modal layers interrupt and steal the keyboard; they are appropriate for a bounded decision, not for navigation. | https://www.nngroup.com/articles/modal-nonmodal-dialog | Navigation layers (place rail, `?` map, launcher, palette) must be non-modal and stack predictably: one open layer at a time, Escape pops exactly one. Only a destructive, irreversible command may demand a confirmation. | Layer model: how many layers can be open, which one owns Escape, whether Esc is ambiguous |
| P-03 | **Progressive disclosure: show the few controls needed now, defer the rest behind a deliberate, visible step.** | https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-progressive-disclosure-controls | A place rail should hold 4–8 object-first verbs; the complete set lives in the dedicated place, the `?` map or the palette. Deferred actions must be *findable* by a visible route, never by memory of a key. | Choices per level (4–9), whether the deferred set has a visible route, whether anything is recall-only |
| P-04 | **Commanding basics: group related commands, make the primary action obvious, place controls consistently.** | https://learn.microsoft.com/en-us/windows/apps/design/basics/commanding-basics | Fredo's CommandBar equivalent is the place rail: a stable rail position, one object-first verb order, and grouping by intent rather than by implementation. A capability declared in several places must read identically everywhere. | Grouping, ordering stability, and whether the same capability reads the same at every site |
| P-05 | **The command palette is a teacher, not just a launcher.** Grouped results, visible paths, inline keys, recents and nested views taught by the list itself. | https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/ | Palette rows must carry a place path, the place-scoped key and the risk level; results group by place in tree order; Escape pops one nesting level. A flat, unlabelled list teaches nothing. | Palette row information: path, key, risk, grouping, Escape behaviour |
| P-06 | **Enablement is an explicit condition, not a disappearance.** When a command does not apply, say why it is unavailable rather than removing it. | https://code.visualstudio.com/api/references/when-clause-contexts | Selection-dependent verbs stay rendered when unavailable, with `aria-disabled` and a reason (`needs a selection`, `needs two or more`). The condition that enables a verb must be derivable from what the user can see (the selection badge). | Whether disabled verbs remain visible, and whether the enabling condition is stated |
| P-07 | **Mixed-initiative interaction: either party may take initiative, and correction is cheap.** The agent proposes or acts; the human can inspect, take over, and undo. | https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/ | Auto-apply must never be silent: a companion change is announced with what changed, and an attributed undo restores exactly that property. The human keeps the last word without leaving the work. | Whether a change is announced, attributed, and reversible in one step |
| P-08 | **Human-AI guidelines: make clear what the system can do, why it did something, and how to correct it.** | https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/ | The launcher states its scope (the active place), answers within that scope, and names the target + property it changed. Failure copy states the boundary instead of guessing. | Scope disclosure, reply specificity (target + property), boundary/error copy |
| P-09 | **Agent-native design: the agent is a first-class actor with explicit intent, scope and inspectable actions.** | https://www.agent-native.com/docs/what-is-agent-native/ | Conversation is place-scoped and shares the same action layer as the UI — not a separate universe. A launcher that acts through a different capability table than the rail fails this principle. | Whether conversation and manual actions resolve to the same action set and state |
| P-10 | **Object-first (OOUX): name the object, then surface the verbs that apply to it.** | https://www.thile.design/ooux | The primary navigation structure is the object/place tree (`Canvas → Create / Edit / Arrange / Style / View / File`); verbs are contextual to the active place and selection, not a flat verb list the user must scan. | Whether navigation is organised by object/place, and whether verbs change with place/selection |
| P-11 | **Command-palette pattern: searchable, grouped, pointer-and-keyboard reachable, with consequences visible.** | https://uxpatterns.dev/patterns/advanced/command-palette | The palette must be reachable pointer-only (`Browse all actions`), show consequence/risk per row, and require a second activation for high-risk verbs. Keyboard-only access is an enhancement, not the only path. | Pointer-only reachability, risk disclosure, confirmation for high-risk rows |
| P-12 | **Recognition over recall, with bounded choice.** Keep per-level choice within working-memory limits (roughly 4–9), chunk it, and keep spatial position stable between visits. | https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-progressive-disclosure-controls | The rail's 4–8 verbs, the tree's fixed order and stable rail geometry must let a user recognise the next action instead of recalling a key. A legend that only lists the *active* mode's keys turns recognition back into recall. | Rows/choices per level, chunking, spatial stability, and whether the full binding set is ever visible |

## 3. Current-State Teardown Matrix

### 3.1 Counting Method

Definitions reproduce the plan's counting contract exactly. The QA Expert and tester re-derive
every number with this recipe — never from memory, and never from a number copied out of this
table without re-reading the cited lines.

- **Binding** = one dispatchable key declaration, of exactly one of three kinds:
  (a) a grammar-valid `data-hotkey` attribute value on a mounted element (one `a+b` value is ONE
  binding) — grammar `/^[a-z0-9](?:\+[a-z0-9])?$/`
  (`apps/ui/src/shared/hotkeys/hotkeyGrammar.ts:25`);
  (b) one `keymap` stroke→command entry of an `ApplicationCommandMode` of an opted-in application
  (a stroke counts ONCE even if `keymapOrder` repeats it) —
  `apps/ui/src/shared/hotkeys/commandSurface.ts:104-129`;
  (c) one `KEPT_GLOBAL_BINDINGS` entry — `apps/ui/src/shared/hotkeys/defaults.ts:38-57`.
- **Rendered bindings ≠ declaration sites** for the hidden carrier: ONE
  `data-hotkey={binding.hotkey}` site (`WireframeHotkeyCarrier.tsx:70-78`) renders an array of 12
  elements derived from the table (`:40-50`). Count the array length, not the attribute
  occurrence.
- **Simultaneous bindings** = bindings dispatchable in the surface's default/root state, all
  kinds summed.
- **Listed bindings** = rows the always-on bar actually renders for that surface
  (`apps/ui/src/shared/hotkeys/hotkeyBarModel.ts:245-258`): element rows when no mode is active,
  else the active mode's keymap rows — the kept globals are never rows.
- **Mode** = a declared `ApplicationCommandMode` (parent/keymap), or an **implicit** input state
  the engine derives from focus and that the user cannot select (`terminal`, `text-entry`,
  `modal`, no-surface) — see `apps/ui/src/shared/hotkeys/sequence.ts:9-32`.
- **Toolbar control** = one `WIREFRAME_ACTIONS` row with `toolbar: true`; a split insert control
  renders one button + one chevron and counts once.
- **Conversation exposure** = a UI path where typed natural language reaches the companion.
  Non-test dispatch sites of `askActiveCompanion` are **only**
  `apps/ui/src/applications/home/components/launcher/LauncherShell.tsx:1138` and `:1283`
  (definition `apps/ui/src/shared/components/companion/CompanionEntity.tsx:162`).

Counting recipe (`Grep`/`Read` only — no scripts):

| Quantity | Recipe | Verified today |
|---|---|---|
| Wireframe root mode keys | Read `wireframeCommandSurface.ts:216-256` (deriver + `SELECT_KEYMAP_ORDER`) | **24** |
| Wireframe two-step element bindings | Read `WireframeHotkeyCarrier.tsx:40-50` (array of `+`-containing rows) | **12** |
| Wireframe declared bindings, simultaneous | 24 mode keys + 12 carrier bindings | **36** |
| Wireframe toolbar controls | Grep `toolbar: true` in `wireframeActions.ts` and cross-check `WireframeToolbar.tsx:94-201` (9+3+10+2+5+4) | **33** |
| Wireframe modes | Grep `parent:` in `wireframeCommandSurface.ts` (1 root + 3 children) | **4** |
| Wireframe listed rows (root / draw) | `hotkeyBarModel.ts:180-212` + `:255-258` | **24 / 4** |
| Kept globals | `defaults.ts:38-57` | **3** |
| Other apps' element bindings | Grep `data-hotkey` in `apps/ui/src/applications`, excluding `__tests__` and the Wireframe carrier | MM 1, diagram 1, my-workitems 4, optimizely 4, dev-mode 4, terminal 0, launcher 0 |
| Global first-step union | SUM the app element first steps + Wireframe's prefix-only `g` | **15 of 36** |

### 3.2 Surface Inventory

Every row below is derived from the tree; `n/a` means the surface genuinely lacks that concern,
not that it was not checked. "Simultaneous" counts bindings dispatchable in the default/root
state; conditional bindings are called out in the detail bullet.

| Surface | Simultaneous bindings | Modes (visible / escapable) | Discovery | Selection → actions | Conversation exposure | Duplicate declarations |
|---|---|---|---|---|---|---|
| Wireframe | **36** (24 mode keys + 12 carrier) | **4** declared; only the active label visible; Escape pops; Pan sticky | bar lists active mode keymap only (24 root / 4 draw); 12 `g+*` + 3 globals never listed | **partly**: toolbar disabled/pressed state is selection-derived; keymap never changes | none in-app; 39 published companion commands, no place scope or undo | toolbar hand-listed twice; 5 derived sites converge on one executor |
| Terminal | **0** | 1 implicit passthrough (not user-selectable); exit only by focus change | bar greys out; one announcement on entry | n/a | none (PTY) | none |
| Diagram | **1** (`d`) | 0 | one bar element row | no selection model | none | none |
| Mission Monitor | **1** (`s`) | 0 | bar row only while the drawer is mounted | selection changes detail content, not the action set | none | none |
| Optimizely | **4** (`f e c q`) | 0 | 4 bar rows | expansion does not change actions | none | none |
| My Work Items | **4** (`r a z j`) | 0 | 4 bar rows | filters change content, not actions | none | none |
| Dev Mode | **4** sites; **2–4** simultaneous | 0 | bar rows, but window is not launcher-reachable (easter egg only) | no | none | none |
| Window traversal | **3** kept globals | 0 declared; 4 implicit focus contexts (not selectable) | **none** — never rendered as rows | n/a | none | same 3 chords declared twice |
| Launcher | **0** `data-hotkey` | 2 implicit UI states (tiles vs `>` palette) | `>` prefix advertised nowhere; palette rows carry no place path/risk | yes — Enter's meaning depends on match state | **the only** conversation surface | palette built from the hotkey registry only |

**Wireframe** (`wireframe`; the only application that opts into a command surface —
`apps/ui/src/applications/wireframe/WireframeFeature.tsx:29`)
- Bindings: 24 root mode keys (`wireframeCommandSurface.ts:216-256`) + 12 two-step `g+*` element
  bindings on a hidden, non-focusable carrier (`WireframeHotkeyCarrier.tsx:40-50`, `:70-78`) =
  **36 simultaneous**; **33** toolbar controls (`wireframeActions.ts:365-645` toolbar rows;
  `WireframeToolbar.tsx:94-201`). The table holds 35 rows: 32 hotkey-bearing, 1 toolbar-only
  (`wireframe.document.new`, `wireframeActions.ts:626-634`), 2 companion-only (`:635-644`).
- Modes: **4 declared** — root `wireframe.select`, transient `wireframe.draw.rect`,
  `wireframe.draw.ellipse`, sticky `wireframe.pan` (`wireframeCommandSurface.ts:274-312`, `:438-444`;
  `transient` default true / `sticky` default false at `commandSurface.ts:121-124`). Visible ONLY
  as the leading badge carrying the ACTIVE mode's single label (`HotkeyBar.tsx:208-244`) plus the
  body hook `data-fredo-active-mode` (`docs/ARCHITECTURE.md:585`); the SET of modes is nowhere
  visible. Escapable: Escape pops one layer; Pan is stickily retained
  (`wireframeCommandSurface.ts:304-312`).
- Discovery: the bar lists the ACTIVE mode's keymap only; inherited keys still dispatch but are
  NOT listed, and the 12 `g+*` bindings are never listed (`hotkeyBarModel.ts:180-212`;
  documented at `docs/ARCHITECTURE.md:588`). Toolbar controls carry **no** `data-hotkey`
  (`WireframeToolbar.tsx:16-21`).
- Selection changes available actions: **partly** — the toolbar's `disabled`/`pressed` state is
  selection-derived (`WireframeToolbar.tsx:304-366`) and the property panel switches between
  Page / element / multi / group (`WireframePropertyPanel.tsx:195-209`); the KEYMAP never changes
  with selection (`wireframeCommandSurface.ts:216-228`).
- Conversation: no in-app conversation surface. The published companion surface exposes **39
  commands + `listActions`** (`shared/companion/manifest.ts:73-119`; golden fixture
  `shared/companion/fixtures/wireframe.companion.golden.json:68-328` lists the 39 ids), including
  `wireframe.element.create`, `wireframe.element.editFill`, add-element and arrange verbs
  (`wireframeCommandSurface.ts:344-435`) — not only `draftApp`.
- Duplicate capability declarations: the 33 toolbar controls are hand-listed a SECOND time as
  `{id,label,icon}` arrays (`WireframeToolbar.tsx:94-201`) alongside the table rows that already
  carry `id`/`title` (`wireframeActions.ts:365-645`); each capability is then reachable through
  three more derived sites (root keymap, carrier, command spec) — all converging on ONE
  `executeCommand` (`commandSurfaceStore.ts:437-459`).

**Terminal** (`terminal`)
- Bindings: **0** `data-hotkey`; while the terminal owns focus every keystroke passes through
  (`terminalMode.ts:1-27`, `:100-112`; `sequence.ts:192-197`), root
  `data-fredo-terminal-root="true"` (`SessionTerminal.tsx:344`).
- Modes: **1 implicit** (passthrough) — not user-selectable, visible as greyed bar rows +
  body hook `data-fredo-passthrough` (`HotkeyBar.tsx:176-180`; `terminalMode.ts:19-27`, `:56-66`),
  escapable only by focus change. The old exit chord is removed (`terminalMode.ts:5-8`).
- Discovery: none specific (the bar greys out, `HotkeyBar.tsx:176-180`). Selection: n/a.
  Conversation: none (PTY). Duplicates: none.

**Diagram** (`diagram`)
- Bindings: **1** (`d`, `ArchitectureDiagram.tsx:677-684`). Modes: 0. Discovery: one bar element
  row (document order, `hotkeyElements.ts:5-15`). Selection: no selection model in the app
  (grep `selectedNode` → no hits), so selection never changes actions. Conversation: none.
  Duplicates: none. Reachability: `showable = false` (`DiagramFeature.tsx:23`), so no launcher
  tile — the surface is registered (`diagram/index.ts:8`) but not discoverable from the launcher.

**Mission Monitor** (`mission-monitor`)
- Bindings: **1 declared** (`s`, `SessionHistoryDrawer.tsx:294-301`) that exists only while the
  drawer is mounted. Modes: 0. Discovery: bar row only while mounted (same observer,
  `hotkeyElements.ts:5-15`). Selection changes the detail panel content
  (`MissionMonitorPanel.tsx:1077-1119`) but not the action set. Conversation: none. Duplicates:
  none.

**Optimizely / feature flags** (`optimizely`)
- Bindings: **4** (`f` refresh `:461`, `e` expand `:491`, `c` collapse `:506`, `q` search `:533`
  in `OptimizelyFlagsPanel.tsx`). Modes: 0. Discovery: 4 bar rows. Expansion does not change
  actions. Conversation: none. Duplicates: none. Reachability: `showable = false`
  (`OptimizelyFeature.tsx:10`).

**My Work Items** (`my-workitems`)
- Bindings: **4** (`r` refresh `MyWorkItemsContainer.tsx:133`; `a`/`z`/`j` source tabs
  `:155-157`). Modes: 0. Discovery: 4 bar rows. Filters change content, not actions.
  Conversation: none. Duplicates: none. Reachability: `showable = false`
  (`MyWorkItemsFeature.tsx:19`), but the surface IS opened by the Home event handler
  (`Home.tsx:191-196`) — hidden from the launcher, not unreachable.

**Dev Mode** (`dev-mode`)
- Bindings: **4** (`i` filter `DevMode.tsx:643-647`; `v` view toggle `:606-609`; `x` clear
  `:589-596` only while events exist; `b` show-all `:710-731` only while some state is filtered) →
  **2–4 simultaneous** at runtime. Modes: 0. Discovery: bar rows. `showable = false`
  (`DevModeFeature.tsx:11`) → not launcher-reachable, but the window IS user-openable via the
  Konami easter egg (`Home.tsx:69-77`). Conversation: none. Duplicates: none.

**Window traversal** (no application with this name — the capability is
`apps/ui/src/shared/hotkeys/traversal.ts` + the kept globals)
- Bindings: **3 kept globals** (`primary+space`, `primary+tab`, `primary+shift+tab`;
  `defaults.ts:38-57`), registered `engine.ts:91-120` and resolved `engine.ts:137-151`, plus a
  non-dispatch Tab-boundary handler (`traversal.ts:268-308`).
- Modes: **0 declared**; the focus classifier's four contexts are implicit and not user-selectable
  (`sequence.ts:9-16`; `docs/ARCHITECTURE.md:591`).
- Discovery: **none** — kept globals are not element rows and not mode rows, so the bar can never
  list them (`hotkeyBarModel.ts:223-258`). Selection: n/a. Conversation: none.
- Duplicate declarations: the same three chords are declared once in `defaults.ts:38-57` and once
  in `engine.ts:91-120` (`DEFAULT_FREDO_ACTION_DEFS`); the two lists must stay in sync manually.

**Launcher** (`home` / `home/components/launcher/`)
- Bindings: **0** `data-hotkey`; internal key behaviour is Enter commit
  (`LauncherShell.tsx:1425-1516`), ArrowUp/Down palette roving, Escape (`:1349-1379`),
  Shift+Enter newline, hold-Space dictation (`launcherSpaceHold.ts`), plus the global
  `primary+space` toggle.
- Modes: **2 implicit UI states** — app-tile mode vs `>` action-palette mode
  (`launcherActionPalette.ts:63-84`), plus live dictation states.
- Discovery: the `>` prefix is not advertised anywhere in the product chrome; palette rows carry
  `title`, `description`, `featureId`, `bindings`, `bindingDisplay`, `tier`
  (`launcherActionPalette.ts:40-52`) — **no place path, no grouping, no risk**.
- Selection changes actions: yes — Enter's meaning depends on match / no-match / companion active;
  palette rows are a separate roving selection.
- Conversation: the ONLY conversation surface in the product (`Home.tsx:314` mounts
  `LauncherShell`; dispatch at `LauncherShell.tsx:1138`). A standalone app window renders
  `feature.render()` only (`StandaloneAppWindow.tsx:134-147`) — no launcher, hence no
  conversation there.
- Duplicate capability declarations: the palette is built from `listHotkeyActions()`
  (`LauncherShell.tsx:871-885`) — the registry. Element hotkeys are explicitly NOT registry
  declarations (`engine.ts:158-173`), and command-surface commands are a third list, so in
  production the palette offers only the 4 engine defaults (`engine.ts:91-120`) and **none** of
  the 36 Wireframe bindings nor any app's element hotkeys.

### 3.3 Duplicate Capability Analysis

Where the same capability is declared more than once, and what that costs:

1. **Wireframe toolbar labels — hand-listed twice.** `WIREFRAME_ACTIONS` carries `id` + `title`
   (`wireframeActions.ts:365-645`), while `WireframeToolbar.tsx:94-201` re-declares the same
   capabilities as five `{id, description, icon}` arrays plus `INSERT_GROUPS`. A label change in
   one place silently diverges from the table's `title`. Both are required to compile against
   `string` ids, so a renamed id is a runtime no-op rather than a type error.
2. **One capability, five derived sites.** A single table row fans out to: the root keymap
   (`wireframeCommandSurface.ts:216-228`), the hidden carrier
   (`WireframeHotkeyCarrier.tsx:40-50`), the `TABLE_COMMANDS` spec
   (`wireframeCommandSurface.ts:328-342`), the companion manifest
   (`shared/companion/manifest.ts:73-119`) and the toolbar control. All five converge on ONE
   `executeCommand` (`commandSurfaceStore.ts:437-459`) — the redundancy is in *declaration*,
   not in *dispatch*, which bounds the damage but still multiplies the edit surface.
3. **Kept globals declared twice.** `KEPT_GLOBAL_BINDINGS` (`defaults.ts:38-57`) and
   `DEFAULT_FREDO_ACTION_DEFS` (`engine.ts:91-120`) declare the same three chords. They must be
   kept in sync by hand; nothing type-checks that the sequences agree.
4. **Three unrelated action vocabularies.** Element hotkeys (not registry declarations —
   `engine.ts:158-173`), command-surface commands (`wireframeCommandSurface.ts:328-342`) and
   registered hotkey actions (`engine.ts:91-120`). The launcher palette reads only the third
   (`LauncherShell.tsx:871-885`), so what the palette teaches and what the app can do are
   different sets — a user who learns the palette will not learn the 36 Wireframe bindings.
5. **Navigation vocabulary declared in the prototype, not the product.** The proposed `place.*`
   and `ask.*`/`map.*` verbs have no declaration site in the shipped tree; the grammar
   (`hotkeyGrammar.ts:25`) cannot express `?` or `/` at all. That is a *gap*, not a duplicate —
   recorded in §11.1.

### 3.4 Claimed → Verified Corrections

The issue is authoritative for SCOPE, never for internals. Corrections are recorded here; no
product code was changed to make a claim true.

| Claim | Verified in the tree | Correction / consequence |
|---|---|---|
| "flat 24-key list" | 24 root strokes = 20 single-step table hotkeys + `r e v c` (`wireframeCommandSurface.ts:216-256`); PLUS 12 `g+*` carrier bindings (`WireframeHotkeyCarrier.tsx:40-50`) | Correct for the ROOT keymap; the surface has **36** dispatchable bindings and the bar never lists the 12 |
| "four interactive modes appear only as a badge" | 4 declared modes (`:274-312`); badge carries the ACTIVE label only (`HotkeyBar.tsx:208-244`) | Correct in count; the badge does not reveal the mode SET, and `Select` (root) also shows as a badge |
| "33-control toolbar" | 33 `toolbar: true` rows; 33 rendered controls (9+3+10+2+5+4) | Verified exactly |
| "always-on `HotkeyBar` lists every mounted key in document order" | In an opting app with an active mode the bar lists ONLY the active mode's keymap (`hotkeyBarModel.ts:245-258`); kept globals are never rows | **False for Wireframe and for globals**: 24 rows at root, 4 in a draw mode, 12 `g+*` never listed, 3 globals never listed |
| "the companion's only Wireframe entry point is a whole-document `draftApp`" | 39 published commands + `listActions` (fixture `:68-328`), incl. create/editFill/arrange | **False as stated**: `draftApp` is the only whole-document generator. What is genuinely missing is a place/selection-scoped conversational entry point and any attributed undo |
| "Dev Mode" is a surface; plan adds it is "not launcher-reachable, so the bar only lists it in a dev surface the user cannot open" | Exists, `showable = false` (`DevModeFeature.tsx:11`), **but** the Konami handler opens the window (`Home.tsx:69-77`) | **Partly false**: not launcher-reachable, but user-openable via the easter egg, so its bar rows ARE reachable by a user who triggers it. Teardown scores it and states that caveat |
| Only Dev Mode is hidden from the launcher | `showable = false` also on Diagram (`DiagramFeature.tsx:23`), Optimizely (`OptimizelyFeature.tsx:10`), My Work Items (`MyWorkItemsFeature.tsx:19`) | **New correction**: four application surfaces are non-showable. My Work Items is still opened by `Home.tsx:191-196`; Diagram and Optimizely have no launcher route in the tree |
| `wireframeActions.ts:27-28` cites `infrastructure/companion/wireframe_catalog.rs` | No such file (`infrastructure/companion/` has `skills.rs`, `surface_registry.rs`, …) | Stale comment (G-299); the Rust offer is generated from the published manifest (`manifest.ts:73-119`) |
| `spikes/README.md:3` says spikes are "one flat file" | `spikes/2968-doom-runtime/`, `spikes/2969-doom-agent/`, `spikes/2972-doom-resume/` are directories | ST-1 amends the prose so a spike MAY be a directory when it ships artifacts (this report's spike is the directory form) |
| `?` map / `/` ask keys | Grammar is `[a-z0-9](+[a-z0-9])?` (`hotkeyGrammar.ts:25`) | `?` and `/` are **not expressible today**; the prototype may bind them directly, but P2 needs a grammar extension or alternate keys (recorded in §11.1) |

## 4. Heuristic Evaluation

### 4.1 Scoring Rubric

Each of the nine surfaces is scored on every principle ID from §2.1, from the tree as it actually
is (never as intended). Scores are only valid with a `file:line` anchor; a finding with no path is
not a finding. A surface that does not exist in the tree is described, not scored.

| Score | Meaning | Evidence bar |
|---|---|---|
| **0 — Violated** | The principle's observable is absent or contradicted by the implementation. | At least one `file:line` showing the absence/contradiction. |
| **1 — Partial** | An affordance exists but is hidden, incomplete, inconsistent or misleading. | A path for the affordance **and** a path showing the gap. |
| **2 — Meets** | The principle's observable is satisfied through one direct path, with no duplicated mental model required. | One path per observable claim. |
| **3 — Exemplary** | Meets, plus a redundant discovery path or explicit teaching that does not depend on recall. | Two paths (the mechanism + the teaching surface). |

Rules: (a) score the DEFAULT/root state unless a state is named; (b) mode-count and binding-count
scores are secondary to *visibility* — a mode the user cannot see cannot score above 1 on P-01
regardless of how well it dispatches; (c) a hidden-but-working dispatch path (e.g. a `g+*` carrier)
does not improve discovery scores; (d) every finding names the principle and the score it
supports; (e) `n/a` concerns are stated, not silently omitted.

### 4.2 Per-Surface Findings

**Wireframe**
- **F-WF-1 (P-01, score 1)** — Four declared modes exist, but the UI reveals only the active
  mode's label badge; the mode *set* is nowhere visible, so a user cannot learn that Rectangle,
  Ellipse and Pan states exist. Evidence: `apps/ui/src/applications/wireframe/wireframeCommandSurface.ts:274-312`,
  `apps/ui/src/shared/hotkeys/HotkeyBar.tsx:208-244`.
- **F-WF-2 (P-12, score 1)** — The bar lists only the active mode's 24-key keymap (4 in a draw
  mode); the 12 `g+*` bindings and the 3 kept globals are never rendered as rows, so the visible
  legend understates the dispatchable set by 15 bindings. Evidence:
  `apps/ui/src/shared/hotkeys/hotkeyBarModel.ts:180-212`, `:245-258`,
  `docs/ARCHITECTURE.md:588`.
- **F-WF-3 (P-06, score 1)** — The keymap is static: it never changes with the selection, even
  though the toolbar's `disabled`/`pressed` state does, so the keyboard and pointer surfaces
  disagree about what is available. Evidence:
  `apps/ui/src/applications/wireframe/wireframeCommandSurface.ts:216-228`,
  `apps/ui/src/applications/wireframe/components/WireframeToolbar.tsx:304-366`.
- **F-WF-4 (P-04, score 2)** — The toolbar groups commands consistently (insert / element / edit /
  view / file / arrange) and the rail-equivalent geometry is stable, but the grouping is
  hand-listed a second time in the component rather than derived from the table.
  Evidence: `apps/ui/src/applications/wireframe/components/WireframeToolbar.tsx:94-201`,
  `apps/ui/src/applications/wireframe/actions/wireframeActions.ts:365-645`.
- **F-WF-5 (P-07/P-09, score 1)** — Conversation reaches Wireframe through 39 fine-grained
  commands, but there is no place/selection-scoped entry point and no attributed undo, so a
  companion change cannot be inspected or reversed from the surface it changed. Evidence:
  `apps/ui/src/shared/companion/manifest.ts:73-119`,
  `apps/ui/src/applications/wireframe/wireframeCommandSurface.ts:344-435`.
- **F-WF-6 (P-03, score 1)** — The root rail does not exist yet; the comparable affordance is a
  33-control toolbar, well above the 4–9 bounded-choice target, with no progressive disclosure
  of the arrange/view/file sets beyond visual chunking. Evidence:
  `apps/ui/src/applications/wireframe/components/WireframeToolbar.tsx:94-201`.

**Terminal**
- **F-TR-1 (P-01, score 1)** — Passthrough is an implicit mode: it is not user-selectable, has no
  visible state beyond greyed bar rows and one announcement, and is escapable only by focusing
  something else. Evidence: `apps/ui/src/shared/hotkeys/terminalMode.ts:19-27`,
  `:100-112`, `apps/ui/src/shared/hotkeys/HotkeyBar.tsx:176-180`.
- **F-TR-2 (P-04, score 1)** — The surface has zero declared bindings, so there is no command
  affordance to group or keep consistent; all actions belong to the shell, not to Fredo.
  Evidence: `apps/ui/src/applications/terminal/TerminalFeature.tsx:13`,
  `apps/ui/src/shared/hotkeys/terminalMode.ts:1-13`.

**Diagram**
- **F-DG-1 (P-12, score 1)** — One binding (`d`) is discoverable only as a bar row in document
  order; there is no place or grouping, and the app is `showable = false`, so the launcher can
  never reveal the surface at all. Evidence:
  `apps/ui/src/applications/diagram/components/ArchitectureDiagram.tsx:677-684`,
  `apps/ui/src/applications/diagram/DiagramFeature.tsx:23`.
- **F-DG-2 (P-06, score 0)** — There is no selection model in the app, so the principle's
  observable (enablement conditioned on selection) does not exist; the single search binding is
  always available and always the same. Evidence:
  `apps/ui/src/applications/diagram/components/ArchitectureDiagram.tsx:677-684`.

**Mission Monitor**
- **F-MM-1 (P-12, score 1)** — The only binding exists only while the history drawer is mounted,
  so the dispatchable set changes with UI state without a visible explanation of why the row
  appeared or disappeared. Evidence:
  `apps/ui/src/applications/mission-monitor/components/SessionHistoryDrawer.tsx:294-301`,
  `apps/ui/src/shared/hotkeys/hotkeyElements.ts:5-15`.
- **F-MM-2 (P-06, score 1)** — Selecting a session changes the detail panel's *content* but not
  the available action set, so the selection does not teach what else became possible.
  Evidence:
  `apps/ui/src/applications/mission-monitor/components/MissionMonitorPanel.tsx:1077-1119`.

**Optimizely**
- **F-OP-1 (P-06, score 0)** — The four bindings are static and unconditional; expanding or
  filtering flags never changes the available actions, and the enablement of each row is not
  derived from the view state. Evidence:
  `apps/ui/src/applications/optimizely/components/OptimizelyFlagsPanel.tsx:461`,
  `:491`, `:506`, `:533`.
- **F-OP-2 (P-04/P-12, score 1)** — `q` is bound to the search `<input>` itself; while that input
  has focus the text-entry branch suppresses all bare-key dispatch, so the shortcut cannot fire
  exactly when the user is in the control. A key bound to a text field is a collision the model
  cannot see. Evidence:
  `apps/ui/src/applications/optimizely/components/OptimizelyFlagsPanel.tsx:530-546`,
  `apps/ui/src/shared/hotkeys/hotkeyBarModel.ts:162-168`.
- **F-OP-3 (P-03, score 1)** — The window is `showable = false`, so none of the four bindings is
  reachable through the launcher; discovery depends entirely on the bar being visible while the
  hidden window is already open. Evidence:
  `apps/ui/src/applications/optimizely/OptimizelyFeature.tsx:10`.

**My Work Items**
- **F-MW-1 (P-06, score 0)** — The four bindings are static; changing the source filter changes
  content only and never enables or disables a verb, so there is nothing selection-derived to
  learn. Evidence: `apps/ui/src/applications/my-workitems/components/MyWorkItemsContainer.tsx:133`,
  `:152-157`.
- **F-MW-2 (P-04, score 1)** — Each key is a 1:1 duplicate of a visible button (`r` = Refresh,
  `a/z/j` = source tabs), so the keyboard adds speed but no new capability or teaching; the
  surface is also hidden from the launcher (`showable = false`) and reachable only through an
  event-driven open. Evidence:
  `apps/ui/src/applications/my-workitems/MyWorkItemsFeature.tsx:19`,
  `apps/ui/src/applications/home/components/Home.tsx:191-196`.

**Dev Mode**
- **F-DM-1 (P-01, score 1)** — The window is not launcher-reachable (`showable = false`) yet is
  user-openable via the Konami easter egg, so the surface participates in the keyboard model
  without being discoverable through any navigation surface. Evidence:
  `apps/ui/src/applications/dev-mode/DevModeFeature.tsx:11`,
  `apps/ui/src/applications/home/components/Home.tsx:69-77`.
- **F-DM-2 (P-06, score 1)** — Two of the four bindings appear only conditionally (`x` clear only
  while events exist, `b` show-all only while some state is filtered), and the bar row simply
  disappears; nothing states the enabling condition. Evidence:
  `apps/ui/src/applications/dev-mode/components/DevMode.tsx:589-596`, `:710-731`.
- **F-DM-3 (P-12, score 1)** — Four rows are listed only when the hidden window is already open;
  a user who never discovers the easter egg never sees the legend at all. Evidence:
  `apps/ui/src/applications/dev-mode/components/DevMode.tsx:606-609`,
  `:643-647`.

**Window traversal**
- **F-WT-1 (P-12, score 0)** — The three kept globals are dispatcher-only: they are neither
  element rows nor mode rows, so the always-on bar can never teach them; there is no discovery
  path at all. Evidence: `apps/ui/src/shared/hotkeys/hotkeyBarModel.ts:223-258`,
  `apps/ui/src/shared/hotkeys/defaults.ts:38-57`.
- **F-WT-2 (P-04, score 1)** — The same three chords are declared twice (`defaults.ts` and
  `DEFAULT_FREDO_ACTION_DEFS`), so consistency depends on manual sync rather than one source.
  Evidence: `apps/ui/src/shared/hotkeys/defaults.ts:38-57`,
  `apps/ui/src/shared/hotkeys/engine.ts:91-120`.
- **F-WT-3 (P-02, score 1)** — Two different Tab behaviours coexist: the native boundary hop
  (`traversal.ts:268-308`) and `primary+tab`/`primary+shift+tab`; neither is explained in the
  product chrome, so the layer/owner of Escape and Tab is ambiguous to a user. Evidence:
  `apps/ui/src/shared/hotkeys/traversal.ts:268-308`,
  `apps/ui/src/shared/hotkeys/defaults.ts:45-56`.

**Launcher**
- **F-LN-1 (P-05, score 1)** — Palette rows carry title/description/tier/bindings but **no place
  path, no grouping and no risk**, so the palette cannot teach where an action lives or what it
  costs. Evidence:
  `apps/ui/src/applications/home/components/launcher/launcherActionPalette.ts:40-52`.
- **F-LN-2 (P-09, score 1)** — The palette is built from the hotkey registry only, and element /
  command-surface bindings are not registry declarations, so the conversation-adjacent palette
  and the wireframe action layer are different sets. Evidence:
  `apps/ui/src/applications/home/components/launcher/LauncherShell.tsx:871-885`,
  `apps/ui/src/shared/hotkeys/engine.ts:158-173`.
- **F-LN-3 (P-11, score 1)** — The `>` palette mode is not advertised anywhere in the product
  chrome; a pointer-only user has no visible route into it (only the unlabelled prefix grammar).
  Evidence:
  `apps/ui/src/applications/home/components/launcher/launcherActionPalette.ts:63-84`.
- **F-LN-4 (P-08, score 1)** — Conversation exists only in the launcher; a standalone app window
  renders `feature.render()` with no launcher, so a user working in that window has no
  conversational surface and no scope statement. Evidence:
  `apps/ui/src/applications/app-window/StandaloneAppWindow.tsx:134-147`,
  `apps/ui/src/applications/home/components/Home.tsx:314`.

## 5. Prototype

### 5.1 Prototype Overview

> STATUS: PENDING GATE H — NO DATA

### 5.2 Task-to-Affordance Coverage

> STATUS: PENDING GATE H — NO DATA

### 5.3 Throwaway Boundary

> STATUS: PENDING GATE H — NO DATA

## 6. Method and Session Protocol

### 6.1 Protocol Reference

> STATUS: PENDING GATE H — NO DATA

### 6.2 Participant Mix and Recruitment

> STATUS: PENDING GATE H — NO DATA

### 6.3 Consent, Anonymisation and Moderator Rules

> STATUS: PENDING GATE H — NO DATA

## 7. Metrics

### 7.1 Metric Definitions

> STATUS: PENDING GATE H — NO DATA

### 7.2 Aggregated Results

> STATUS: PENDING GATE H — NO DATA

### 7.3 Per-Participant Raw Data

> STATUS: PENDING GATE H — NO DATA

## 8. Research Question Answers

### 8.1 RQ1 — Does the place tree improve felt flow?

> STATUS: PENDING GATE H — NO DATA

### 8.2 RQ2 — Does launcher-only conversation feel connected?

> STATUS: PENDING GATE H — NO DATA

### 8.3 RQ3 — Does auto-apply with visible undo build trust?

> STATUS: PENDING GATE H — NO DATA

## 9. Go/No-Go Verdict

### 9.1 Gate Lines

> STATUS: PENDING GATE H — NO DATA

### 9.2 Verdict

> STATUS: PENDING GATE H — NO DATA

### 9.3 Human Decision

> STATUS: PENDING GATE H — NO DATA

## 10. Appendix — Per-Participant Evidence

### 10.1 Per-Participant Notes

> STATUS: PENDING GATE H — NO DATA

### 10.2 Quote Index

> STATUS: PENDING GATE H — NO DATA

### 10.3 Session Deviations

> STATUS: PENDING GATE H — NO DATA

## 11. Limitations and Threats to Validity

### 11.1 Known Limitations

1. **The `?` / `/` grammar gap.** The shipped hotkey grammar is
   `/^[a-z0-9](?:\+[a-z0-9])?$/` (`apps/ui/src/shared/hotkeys/hotkeyGrammar.ts:25`), and the
   mode-key grammar is a single `[a-z0-9]` stroke
   (`apps/ui/src/shared/hotkeys/commandSurface.ts:143`). Neither can express `?` or `/`. The
   prototype binds them directly (permitted for a throwaway artifact), but this is **not** a
   shippable answer: P2 needs a grammar extension or alternate keys. The study therefore tests
   the *model* with affordances the product cannot yet bind — a real threat to external validity.

2. **Small n, no statistical claims.** The design calls for 5–8 completed sessions with a fixed
   quota mix. Results are reported as raw counts with explicit denominators, per cohort. No
   significance test, confidence interval or effect size is computed, and no result generalises
   beyond these participants.

3. **No controlled shipped-app baseline was measured.** The issue forbids driving the shipped
   app; every session runs on the prototype. Consequently **no measured "improvement over the
   shipped flat-key UI" may be claimed** anywhere in this report. RQ1 (§8.1) reports what
   participants actually did and rated on the place model, with the §3 teardown's documented
   flat-key surface (36 simultaneous bindings, hidden mode set) as a *qualitative* comparator
   only.

4. **Anonymisation and consent.** Participants are referenced only as `P1`–`P8`; no name, email,
   handle or organisation is committed. Consent is recorded per participant, no recording is
   retained without explicit consent, and a participant without recorded consent contributes no
   row. A single-session, non-recording default limits what can be re-analysed later.

5. **Prototype bias.** The greybox model is deliberately cleaner and more coherent than a real
   build (no persistence, no real canvas engine, two scripted companion intents). The study
   measures the *model*, not a production build; P6's pilot exit review must re-measure the same
   tasks against the real pilot before the model is treated as proven.

6. **Facilitator and observation bias.** `discovery_source` is a moderator observation, not
   instrumented telemetry (the prototype emits none by design). Think-aloud protocols and a
   moderator who knows the model can leak cues; the verbatim protocol and the no-teaching rule
   are the mitigations, not a guarantee.

7. **Stage-1 scope, stated plainly.** This revision contains the method and model only. Sections
   §5–§10 intentionally carry no data. Treating a Stage-1 document as a result — or filling its
   results sections from inference — would be fabrication, and is prohibited.
