# companion-command-removal — Functional

Durable functional suite for the **removal of the companion's Rust command-surface registry and
the dead application-command relay** (Issue #3152, slice 2 of 3 of the NavigationEngine removal
programme; S1 = #3151, S3 = #3153). Rows map 1:1 to the QA Plan in `.opencode/tmp/3152/triage.md`
`## QA Expert` (`Q-1` … `Q-22`), keyed to the Software Architect's EARS ids `R-1a`…`R-4b`.

Names bind **verbatim** to the Architect's `### BINDING NAMES BLOCK` — do not invent alternative
guard paths, roots, exit codes, testids or test titles.

> **This file spells banned tokens on purpose.** It quotes the guard invocation, the retired module
> path and the relay names so a tester can recognise them. That is exactly why the guard's evidence
> allowlist carries `.opencode/tests/companion-command-removal/` — the suite is the documented
> exception, and it sits **outside** both scanned roots (`apps/tauri/src-tauri`, `apps/ui/src`) by
> construction. **Never** assert a repo-wide literal zero: the guard's own token table and this
> ledger spell the tokens (G-431).

> **Verification policy: live plan, mixed per row.** Rows tagged `static` (Q-1…Q-10, Q-16…Q-21) are
> absence/compile checks over committed artifacts and are proved by `run-exitcode.ps1` + `Read`/test
> binaries — never by driving the app. Rows tagged `live` (Q-11…Q-15, Q-21) are proved from a
> running webview. The testing exit gate and the audit fail closed unless the `## Tests Runs`
> comment carries at least one live receipt the gate recognises
> (`tauri_webview_*` result, `tauri_manage_window` result, a `user-attachments` URL, or a
> `telemetry_spans` query). **A static-only PASS is a false PASS.**

> **Gate wrappers.** Every command exit code is asserted through
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"` — the sandbox forbids
> chaining, so `$LASTEXITCODE` is otherwise unreachable. The printed `EXITCODE=<n>` line is the
> receipt. `run-exitcode.ps1:34-39`.

> **No screenshot-upload dependency.** `gh image` / `upload-evidence` (`user-attachments`) was
> broken (`uploadToken not found`) for the whole S1 run. No row here needs it. Live evidence is a
> `tauri_webview_*` DOM/tool receipt plus `tauri_manage_window(action="list")`.

> **Pre-authorised named blockers (record, never FAIL, never silently skip).**
> - `E-MODEL — NAMED BLOCKER: companion model files absent` → the R-3 rows (Q-11…Q-15) and Q-21.
> - `E-SPAN — NAMED BLOCKER: companion turn emits no span of its own; no PG port in this isolated
>   env` → the plan's evidence-completeness row. This feature emits **no** OTLP span; the CLI
>   `fredo emit` path writes RTDB rows and zero spans and is **not** a substitute (G-256).

## Harness

- **Env S (static, no app):** no environment needed. `cargo`, `cargo-nextest`, PowerShell.
- **Env L (live, AC3):**
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3152 -EnvId qa3152-a -EnvSlot 1 -RequireIsolation`.
  `Restart` is **forbidden** for an isolated env (drops `-EnvSlot`, G-328) — recover with
  `-Action Down -EnvId qa3152-a` then `-Action Up -Spec 3152 -EnvId qa3152-a -EnvSlot 1`.
- **Driver:** `tauri_driver_session start appIdentifier="16001"` (slot 1 MCP port = `16001`,
  `dev-environment/SKILL.md:32,36`), then `tauri_webview_*` / `tauri_read_logs` /
  `tauri_manage_window`. Hand-rolling an MCP client is forbidden (G-110).
- **App id used by the AC3 rows:** `mission-monitor` / display name `Mission Monitor`
  (`MissionMonitorFeature.tsx:9-10`; retained registry feature,
  `__tests__/retainedApplicationSet.test.ts:22-31`; `showable: true`, `isMultiWindow: false`).
- **Receipt:** the **posted** `## Tests Runs` comment (G-415). Never
  `.opencode/tmp/3152/tests-runs.md`, `dev-summary.md`, `triage-plan.md` or `fix-plan.md` — the
  transition posts and consumes those.

## AC1 / R-1 — the removal is complete and scoped

- [ ] **Q-1 (R-1a, static, Env S).** Run the committed guard's plain pass:
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-companion-commands-retired.ps1"`.
  **Expected:** `EXITCODE=0`; `Scanned files: N` with **N > 0**; `Hits by class:` A/B/C all `0`;
  the allowlist line reports **exactly 1 entry**.
  **Edge:** a zero-file scan must exit `2`, never `0` (a scan matching nothing is the vacuous pass
  the AC forbids). A file under `docs/` carrying a banned token must NOT change the exit code (it
  is outside both roots — the G-431 proof). Run twice for determinism. **Do not** assert a
  repo-wide literal zero.

- [ ] **Q-2 (R-1a, static, Env S).** Self-test:
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-companion-commands-retired.ps1 -SelfTest"`.
  **Expected:** `EXITCODE=0` AND the output shows **all six controls** PASS:
  (1) positive-per-token with `legs executed == tokens declared` = **22**;
  (2) negative (a comment-only mention flags nothing; for the code-only classes a quoted string
  literal flags nothing either);
  (3) seeded-root probe flagged at the exact `path:line`;
  (4) out-of-root probe **not** scanned;
  (6) ignored-path non-scan — a probe inside a gitignored build-output dir is **not** scanned
  (the ignore filter is engaged, not inert);
  (5) self-reference (plain run clean while the token table spells all 22).
  **Edge:** record the six per-control lines, never only the exit code — an exit `0` without a
  control line is a **suite defect** (G-430). **Probe cleanup:** assert `Test-Path` is `False` on
  the probe paths **the guard itself prints** — do not pin an invented seeded-root filename (its
  name is the guard's to choose). The out-of-root probe *is* pinned by the names block at
  `apps/tauri/__companion_absence_probe_outside__.ts` (`-SelfTest` control 4). A leftover probe is
  a FAIL even at exit `0`. Control 4 writes its probe as a **sibling of the scanned root** — a probe
  written *inside* the root would make control 4 vacuous. Control 3 is the mirrored assertion for
  the ignore filter: its probe is untracked and **not** ignored, so the filter must leave it
  visible — a filter that hid it would be vacuity, not scoping.

- [ ] **Q-3 (R-1a, static, Env S).** Read the guard header + allowlist block of
  `.opencode/scripts/check-companion-commands-retired.ps1`.
  **Expected:** exactly **two** scanned roots (`apps/tauri/src-tauri`, `apps/ui/src`); the skip-dir
  list (`target`, `gen`, `node_modules`, `dist`, `.git`); the text-extension list
  (`.rs .toml .json .ts .tsx .js .jsx .mjs .cjs .css`); 22 tokens in 4 classes with the
  **per-class text mode** (class A + relay raw = comment-stripped raw substring; class B + relay
  symbols = code-only with identifier boundaries); an evidence allowlist containing **exactly one**
  entry normalising to `.opencode/tests/companion-command-removal/`.
  `Test-Path .opencode/tests/companion-command-removal` is `True`. **No** `apps/**` path is in the
  allowlist; the guard exits `2` if one is.
  **Also expected — the ignore filter:** paths `.gitignore` marks as untracked-and-ignored are **not
  scanned** (the plain run prints the excluded count, `Ignore filter: N path(s) excluded (git
  check-ignore)`). This is the authoritative scoping mechanism; the skip-dir list is only a
  fast-path walk prune. If the ignore query cannot be applied the guard exits `2` — it never falls
  back to the unfiltered walk.
  **Edge:** a maintainer widening a root to `.opencode/tests` makes this entry *live* rather than
  inert — assert the entry **resolves**, not that it is unnecessary.

- [ ] **Q-4 (R-1b, static, Env S).** Dead-relay classification proof.
  `Test-Path apps/tauri/src-tauri/src/infrastructure/app_command.rs`;
  read `apps/tauri/src-tauri/src/infrastructure/mod.rs`; read the guard output for relay tokens
  17…22 (`app_command_intent`, `app-command-intent`, `AppCommandIntentState`, `AppCommandIntent`,
  `AppCommandIntentResult`, `AppCommandOutcome`).
  **Expected:** the relay module path is **absent** (`False`) — deleted, not merely unreferenced;
  `infrastructure/mod.rs` carries **no** `pub mod app_command;` line; guard reports **0** hits for
  all six relay tokens; `runtime/command_manifest.rs` contains none of `app_command_intent`,
  `app_command_intent_take`, `app_command_intent_result` (the entries at `:128-130` are gone);
  `permissions/app/default.toml` carries none of the relay grants (`:99-101` pre-change);
  `applications/wireframe/mod.rs` no longer claims the relay is live (`:7-9` pre-change).
  **Edge:** an unused relay left in place is a **FAIL** of the AC, not a warning — the AC names
  "deleted (reason recorded) **or** kept (live caller named)", and no live caller exists (zero
  `apps/ui/**` consumers; no Rust caller outside the module). A half-move (manifest entry removed
  but the permission grant left, or vice versa) is a FAIL.

- [ ] **Q-5 (R-1c, static, Env S).** Frontend absence over `apps/ui/src` for the removed Rust
  symbols **and the two IPC command names**.
  **Expected:** guard reports `0` hits under its `apps/ui/src` root for every class-A/B token,
  **including** `register_app_command_surfaces` and `app_command_surfaces`.
  **Edge — positive controls that must stay green:** `shared/companion/composerTarget.ts` is live
  grounding (`CompanionEntity.tsx:1532,1544`, `CompanionComposer.tsx:93`) and is **not** a banned
  token — it must not be flagged and must not be deleted. The bare string `listActions`
  (`wireframeActions.ts:602`, a surviving Wireframe id) must **not** be flagged: the guard bans the
  **constant name** `COMPANION_LIST_ACTIONS_ID`, never the string value. A row that flags the
  string is a suite defect.

- [ ] **Q-6 (R-1d, static, Env S, WHILE clause).** Exact-path read of
  `apps/tauri/src-tauri/src/lib.rs` and
  `apps/tauri/src-tauri/src/infrastructure/companion/mod.rs`; plus the retirement ledger.
  **Expected:** `lib.rs` contains **no** `AppCommandSurfaceRegistry`, `surface_registry`,
  `app_command`, `register_app_command_surfaces`, `app_command_surfaces`,
  `build_companion_skill_registry`, `surface_skill` (`:859`, `:1074-1076`, `:1080-1081` pre-change);
  `infrastructure/companion/mod.rs` has **no** `pub mod surface_registry;` (`:19` pre-change).
  **Positive controls in the same read:** `lib.rs` still carries
  `pub use applications::llm_server::skills::render_tools as render_companion_tools;`
  (`:58-64` — the seam the new integration target consumes; deleting it is a FAIL), and its comment
  no longer names the deleted `tests/companion_manifest.rs`.
  **Ledger leg (after ST-2 Work 2b authors `RETIRED.md`):** one row per deleted path with issue
  `#3152` and a factual reason — the two deleted modules, `tests/companion_manifest.rs`, the
  **36 deleted test functions** (17 in `surface_registry.rs`, 9 in `companion_manifest.rs`, 8 in
  `app_command.rs`, 2 in `skills.rs`) plus the **1 replaced** in `status.rs`, and the one
  re-pointed target (`voice_invariants.rs`, title kept).
  **Edge:** a path gone but unlisted is a FAIL; a listed path that still exists is a FAIL. Before
  ST-2 lands, record the ledger leg as `PENDING — ST-2 Work 2b` and still require the read leg.

## AC2 / R-2 — the offer is the three static skills and nothing generated

- [ ] **Q-7 (R-2a, static, Env S).** The turn path's own accessor, asserted by its unit test
  `the_turn_offer_is_exactly_the_three_static_skills` (replaces `status.rs:1482-1622`):
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -E 'test(the_turn_offer_is_exactly_the_three_static_skills)'"`.
  **Expected:** `EXITCODE=0`; **1 test run, 1 passed, 0 failed**. The test calls
  `companion_skill_registry()` and asserts the names are **exactly** `["open_app", "close_app",
  "doom_mode"]` **in that order**, `len() == 3`, and **no** application-named skill.
  **Edge:** this MUST be a unit test — the accessor is `pub(crate)` and an integration target is a
  separate crate that cannot call it. Naming the integration target for this row makes it
  undrivable. A 4th skill, a wrong order, or an app-named skill = FAIL.

- [ ] **Q-8 (R-2b, static, Env S, WHILE clause).** The same test's structural leg (ST-1 Work 1d).
  **Expected:** the accessor is `pub(crate) fn companion_skill_registry() -> SkillRegistry` —
  **zero parameters, no `AppHandle`**; its body contains no `.try_state`, no `surfaces`, no
  managed-state read; it is `SkillRegistry::with_app_control_and_doom()`; a second read returns the
  same three names.
  **Edge:** a parameter, an `AppHandle`, or any `try_state`/`state::<…>` read is a **FAIL** —
  "no publisher, no crash" must be *structural*, not a defensive `unwrap_or_default`. Live
  corroboration is Q-15 in Env L; this row never waits on a model (G-440 split).

- [ ] **Q-9 (R-2c, static, Env S).** The rendered offer, by the new integration target
  `the_rendered_offer_carries_only_the_three_static_skills` in
  `apps/tauri/src-tauri/tests/companion_offer_static_only.rs`, built from
  `SkillRegistry::with_app_control_and_doom()` and rendered through `render_companion_tools`:
  `run-exitcode.ps1 -Command "cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -E 'test(the_rendered_offer_carries_only_the_three_static_skills)'"`.
  **Expected:** `EXITCODE=0`; the rendered `tools` array has **exactly three** elements; each is
  `{type:"function", function:{name, description, parameters}}`; the names are `open_app`,
  `close_app`, `doom_mode` in order; `open_app`/`close_app` declare required `{app: string}` and
  `doom_mode` required `{action: string}`; **no** function is application-named.
  **Edge:** the integration target can only reach the **public** builder, not the `pub(crate)`
  accessor — that is why Q-7 and Q-9 are two rows with two executors. A `wireframe`/app-named
  function or a missing `parameters` key = FAIL.

- [ ] **Q-10 (R-2c, static, Env S).** The baseline pin
  `static_skills_are_byte_identical_to_the_pre_change_baseline`, relocated **verbatim** from
  `tests/companion_manifest.rs:218` into the new target, its literals unchanged
  (`companion_manifest.rs:176-215`):
  `run-exitcode.ps1 -Command "cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -E 'test(static_skills_are_byte_identical_to_the_pre_change_baseline)'"`.
  **Expected:** `EXITCODE=0`; the 3 baseline entries deep-equal the first three rendered tools
  (name + description + parameters, in order) — byte-identical, none reworded.
  **Edge:** a changed description or a dropped parameter = FAIL (the out-of-scope invariant). The
  pin must be **pure** — if it returns early on a missing asset it asserts nothing (G-435); state
  that it always executes.

## AC3 / R-3 — a companion turn is unharmed (Env L, requires the model)

- [ ] **Q-11 (R-3a, live, Env L).** Open the composer, then a plain conversational turn.
  **The composer mounts ONLY on the `overlay` surface** (`CompanionEntity.tsx:1833`:
  `surface === 'overlay' && composerOpen`), and the home **seat** never renders it — so a click on
  `.fredo-companion-avatar` at the seat fires the shipped joke and CANNOT open the composer. The
  shipped pointer path from the seat is the **Ctrl+right-click teleport** (`FredoCompanion.tsx:192-215`:
  `e.button === 2 && e.ctrlKey` -> `entity.requestTeleport(...)`; the destination overlay settles the
  open, `CompanionEntity.tsx:767-774`). Recipe:
  (1) Ctrl+right-click the companion to teleport it into an overlay; (2) wait until
  `[data-testid="fredo-companion-composer"]` has count **1** (an immediate re-read finds 0 composers
  and is a **FALSE FAIL**); (3) type a greeting into
  `[data-testid="fredo-companion-composer-input"]`; (4) click
  `[data-testid="fredo-companion-composer-submit"]`.
  **Expected:** `[data-testid="fredo-reply-surface"]` (`SpeechBubble.tsx:102`) renders **non-empty**
  assistant text; `.fredo-companion-avatar` `data-state` is **not** `error` at settle
  (`CompanionEntity.tsx:1858`; `companion.css:120`); console
  (`tauri_read_logs(source="console")`) shows `[companion] llm-done received` **exactly once** for
  the turn (`CompanionEntity.tsx:1162`) with no error settle.
  **Edge:** empty submit is a synchronous no-op (focus retained) — not a failed turn. A turn stuck
  on the `⏳ Loading model...` placeholder that never resolves is a FAIL (record it; do not treat
  the placeholder as a content answer). Reduced motion must not change the outcome. Model absent →
  `E-MODEL` named blocker.

- [ ] **Q-12 (R-3b, live, Env L).** `open_app` turn. With no application frame open, submit a turn
  naming the application, e.g. `open Mission Monitor`.
  **Expected:** the reply surface text is **exactly** `Opening Mission Monitor`
  (`appOpenSuccessReply`, `appOpenReply.ts:32-34` — deterministic copy, never freeform prose).
  After the ~800 ms beat (`APP_OPEN_REPLY_BEAT_MS = 800`, `useAppOpenRequests.ts:50`)
  `[data-testid="window-frame-mission-monitor"]` exists (`WindowFrame.tsx:340`;
  `data-fredo-app-id="mission-monitor"`, `:341`). `tauri_manage_window(action="list")` shows **no**
  extra OS window.
  **Edge:** **presentation.** The default per-app presentation is `same-window`
  (`appPresentationStore.ts:46`), so the app lands as an in-webview `WindowFrame` — **not** an OS
  window. Under a persisted `new-window` preference the frame is absent and a native host
  `app-mission-monitor` appears instead (`appWindows.ts:36-38,69-81`); record which host the env
  produced and assert **that** one — the AC is "the application opens". A failed-open reply
  `I couldn't open …` (`appOpenReply.ts:56`) = FAIL. An unknown name must reply exactly
  `I couldn't find "…"` (`:37-39`) and open **zero** frames.

- [ ] **Q-13 (R-3b, live, Env L).** `close_app` turn. With the application from Q-12 still open,
  submit `close Mission Monitor`.
  **Expected:** reply text is **exactly** `Closing Mission Monitor` (`appCloseSuccessReply`,
  `appOpenReply.ts:65-67`; dispatched by `useAppOpenRequests.ts:201-227`);
  `[data-testid="window-frame-mission-monitor"]` **disappears** from the DOM;
  `tauri_manage_window(action="list")` shows no orphaned host.
  **Edge:** closing a **not-open** app must reply exactly `Mission Monitor isn't open`
  (`appCloseNotOpenReply`, `:80-82`) and close nothing — a false "Closing" claim is a FAIL (the
  honesty contract; there is deliberately no `appCloseFailedReply`, `:75-78`). Re-close is a no-op
  with the truthful copy, never a crash.

- [ ] **Q-14 (R-3c, live, Env L — ONE end-to-end aggregate case, G-424).** In **one** session, in
  order: converse → open → close (Q-11 → Q-12 → Q-13 verbs), sampling the reply surface and the
  avatar state after each.
  **Expected:** across **all three** turns — no reply surface ever shows a failure copy
  (`I couldn't open …`, `I couldn't find …`, or `… isn't open` on a leg that succeeded);
  `.fredo-companion-avatar` `data-state` is **never** `error` at any settle;
  `[data-testid="fredo-companion-live-region"]` (`CompanionEntity.tsx:1813`) announces each settled
  reply **once** (not per token); and no turn exceeds the shipped bounded waits (CLI child ≤10 s,
  confirm ≤5 s, `useAppOpenRequests.ts:30-31`).
  **Edge:** ONE aggregate case, not a per-leg matrix — the AC's literal claim is aggregate. A single
  `error` at any of the three settles FAILs the row. A turn settling on prose that claims an action
  it did not take is a FAIL (the `skillPending` deferral contract,
  `CompanionEntity.tsx:1154-1159`).

- [ ] **Q-15 (R-2b, live, Env L).** **No publisher, no crash.** On a freshly booted env, **before
  any application has ever been opened**, drive one plain conversational turn from the composer —
  same opener as Q-11 (the composer mounts only on the `overlay` surface, so reach it from the home
  seat with the Ctrl+right-click teleport gesture, `FredoCompanion.tsx:192-215`).
  **Expected:** the turn produces a normal reply (as Q-11) with no error settle, and
  `document.querySelectorAll('[data-testid^="window-frame-"]').length === 0` **before** the turn.
  **Edge:** drive the trigger from the pre-feature state (G-265) — opening an app first and then
  asserting is a row defect. This corroborates Q-8; it does not replace it. Requires the model
  (`E-MODEL` otherwise).

## AC4 / R-4 — the app still builds clean (Env S)

- [ ] **Q-16 (R-4a, static, Env S).** From `apps/tauri/src-tauri/`:
  `run-exitcode.ps1 -Command "cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked"`.
  **Expected:** `EXITCODE=0`; the literal count of `warning:` lines is **0**; a `Finished` line is
  present.
  **Edge:** a warning is a FAIL — `#[allow(...)]` suppression is not a fix. A stale `target` is not
  the receipt; the run itself is.

- [ ] **Q-17 (R-4b, static, Env S).** CI-parity clippy, verbatim from
  `.github/workflows/validate.yml:405`:
  `run-exitcode.ps1 -Command "cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings"`.
  **Expected:** `EXITCODE=0`; zero `warning:`/`error:` lines. The invocation carries **no**
  `--all-targets`.
  **Edge:** **record the base fact** in the same evidence — `--all-targets` is **red at base** and
  MUST NOT be reported as this spec's defect. `permissions/app/default.toml` and
  `runtime/command_manifest.rs` must move together (`build.rs:136-142` generates a permission per
  entry), so a red clippy here attributable to a half-landed pair IS a real signal — do not dismiss
  it.

- [ ] **Q-18 (R-4b, static, Env S — mandatory test-target leg).** clippy without `--all-targets`
  never compiles `tests/**` or `#[cfg(test)]`, so:
  `run-exitcode.ps1 -Command "cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked"`.
  **Expected:** `EXITCODE=0`; summary shows **0 failed**; the new target
  `companion_offer_static_only` appears in the run; the re-pointed
  `voice_invariants::the_model_audio_path_obtains_its_offer_from_the_one_shared_registry` passes.
  **Edge:** the default nextest profile **skips executing** the two GGUF modules
  (`apps/tauri/src-tauri/.config/nextest.toml:36`) but still **compiles** them — state this in the
  evidence so a `skipped` line is not misread as this row's failure. A compile error in `tests/**`
  is exactly the S1 audit-restart cause and is a FAIL. `--all-targets` is never used.

- [ ] **Q-19 (AC4 + R-1a, static, Env S — adopted seam, G-406).**
  **Expected:** `render_companion_tools` still exists at `lib.rs:58-64` and the new target renders
  through it; `tests/voice_invariants.rs:651-736` keeps its title **verbatim**
  (`the_model_audio_path_obtains_its_offer_from_the_one_shared_registry`, `:652`) and passes under
  Q-18, with its assertions reading the post-change facts (accessor contains
  `SkillRegistry::with_app_control_and_doom()`; no `.try_state`; no `surfaces`; no
  `app: &AppHandle`; its `allowed` list (`:706-710` pre-change) no longer names the deleted
  registry file).
  **Edge:** the seam's green-run proof **is** Q-18's nextest leg — say so in the evidence; do not
  claim a first-green that was never run. A re-pointed test whose **title** changed is a FAIL
  (titles are the durable index).

## NFR — contract + a11y

- [ ] **Q-20 (NFR contract, static, Env S).** Read the event/skill consumers and the dependency
  blocks.
  **Expected:** `useAppOpenRequests.ts:272-277` still subscribes to `llm-skill-call`;
  `shared/doom-mode/useDoomModeSkill.ts:100` still subscribes to `llm-skill-call`; the composer
  submit still funnels through `ask()` → the skill-aware `llmChatWithStatus`
  (`CompanionEntity.tsx:1567-1573`, `:1446-1482`); `render_tools`/`skill_turn`
  (`skills.rs:52`, `:75`) are unchanged; the `command_manifest` entry count **shrinks by exactly
  5**, never grows; no new dependency in either `Cargo.toml`.
  **Edge:** a channel rename, a new IPC round-trip on the turn path, or a new dependency is a FAIL
  (explicit non-goal). A deleted `doom_mode` consumer is a FAIL even though R-2 only names three
  skills.

- [ ] **Q-21 (NFR a11y, live, Env L).** After a settled turn:
  `[data-testid="fredo-companion-live-region"]` carries the settled reply text **once**, and the
  composer's controls keep their accessible names — root `role="group"` + aria-label
  (`CompanionComposer.tsx:224-227`), input `aria-label="Instruction for Fredo"` (`:267`), submit
  `Send instruction` (`:293`), dismiss `Close instruction box` (`:315`).
  **Edge:** a per-token announcement is a FAIL (the #2871 a11y contract). Assert the names from the
  DOM, not from source (G-423). **Lockstep:** if the composer copy is ever amended, these two
  literals move with it in the same pass — a copy change without the amendment is a FAIL, and an
  amendment without the copy change is a defect.

- [ ] **Q-23 (R-2c live corroboration, **live**, Env L).** **Nothing generated is ever *called*.**
  Before the turns, install a recorder with `tauri_webview_execute_js`:
  `(() => { window.__qaSkillCalls = []; window.__TAURI__.event.listen('llm-skill-call', (e) => window.__qaSkillCalls.push(e.payload)); return true; })()`.
  Then drive Q-11 → Q-12 → Q-13 and read `window.__qaSkillCalls` after each settle.
  **Expected:** every recorded payload's `skill` is in `{open_app, close_app, doom_mode}`
  (`useAppOpenRequests.ts:53-55`, `useDoomModeSkill.ts:4`); exactly one `open_app` (Q-12) and one
  `close_app` (Q-13); **no** payload names an application id or a generated skill.
  **Edge:** an empty recording on a leg that visibly acted is a recorder-install failure — re-install
  and repeat, never a PASS. `tauri_ipc_get_captured filter=llm-skill-call` is an optional second
  read (not a gate-recognised live receipt). A generated/app-named skill payload = FAIL (the
  deletion is incomplete on the wire).

## Evidence completeness

- [ ] **Q-22 (record).** The `## Tests Runs` comment carries **at least one** live
  `tauri_webview_*` or `tauri_manage_window` tool result (Q-11…Q-15 / Q-21 / Q-23) **or** a genuine
  `telemetry_spans` query; if no span is reachable, the literal line
  `E-SPAN — NAMED BLOCKER: companion turn emits no span of its own; no PG port in this isolated env`
  appears. **No** row cites an `upload-evidence` / `user-attachments` URL as required evidence.
  **Edge:** a static-only PASS is a **false PASS** and the testing exit gate fails closed. The
  record is the **posted** comment (G-415), never a consumed `.opencode/tmp/3152/` draft.
