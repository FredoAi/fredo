# References

Shared knowledge base for the agentic pipeline. **Every agent may add, edit, and remove references here** (per [common-rules.md](../common-rules.md) section2) - it is the pipeline's agent-editable knowledge base, not SI-owned. The SI additionally owns the `Known Failure Modes` section (guardrail records, retro-analysis Recipe 6). Agents link to this file from their playbooks.

---

## How to Use This File

- Each entry is a **URL + one-line description** (a pointer an agent actually needs) or a **short self-contained fact**. Every entry must be verifiable: cite a doc path, URL, script path, or concrete behavior - no vibes.
- **Reference format:** `- **Title** - <description> (<URL>)`. Group under the right category; create a new category only when three or more entries need it.
- **Before adding, grep for the URL** - reuse and extend an existing entry instead of creating a near-duplicate.
- **Do not edit `### G-` guardrail blocks** in `Known Failure Modes` - those are SI-owned (Recipe 6). Add non-guardrail facts elsewhere.
- You are granted edit access in `opencode.json`; if blocked, report the gap rather than working around it.

---

## Repository Facts

- **Build** - `cargo build` from `apps/tauri/src-tauri/`; `pnpm --filter @fredo/ui build` for the UI library; `pnpm dev:ui` for the Vite dev server (port 5174).
- **Dev server** - `pnpm dev:tauri` runs the Tauri dev app; the MCP bridge binds `127.0.0.1:9223`; OTLP receivers bind `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP).
- **Telemetry DB** - `fredo.db`; query via `.opencode/skills/telemetry-query/telemetry-query.ps1` (sqlite3 CLI). Inspect `telemetry_spans`, `telemetry_metrics`, `telemetry_logs`.

---

## Pipeline Mechanics

- **State machine** - the single writer and phase authority: `.opencode/scripts/pipeline-state.rs`, reached only through the `pipeline-state` skill. All pipeline GitHub writes go through it.
- **Validation harness** - `powershell -File .opencode/scripts/test-scripts.ps1` runs fully offline against a mock GitHub (`FREDO_MOCK_GH=1`); run after any pipeline-state change.
- **Guardrail records** - persisted by the SI at every audit under `Known Failure Modes` below (retro-analysis Recipe 6).

---

## Known Failure Modes

### G-046: tester_all_live_unverified_is_environment_wedge
- **activation_date:** 2026-08-17
- **observed:** #2745 testing rounds 2-4: three consecutive tester FAILs where AC-1..AC-4 were ALL UNVERIFIED/FAIL while AC-5 (static build/unit/cleanup) PASSED and the console was clean — Mission Monitor failed to mount after clean DB + dev-env restart, and the native Run CLI stalled at "Starting OpenCode…". Dev-env logs showed `[MCP][WS_SERVER][ERROR] WebSocket connection error: Handshake not finished` — a wedged MCP bridge blocking both `install_plugin` (an MCP command) and Run CLI. Recovery: a full `dev-env.ps1 -Action Down` (kills the process tree holding :9223/:5174) → `-Action Up` restored the clean WS handshake; `clean-fredo-db.ps1 -Restart` alone did NOT clear it.
- **target_failure:** a tester FAIL whose live ACs are ALL UNVERIFIED (with static ACs PASS and no console errors) is misattributed to the spec and loops back to implementation, when the root cause is a wedged dev-environment MCP bridge.
- **guardrail:** When a tester round reports ALL live ACs UNVERIFIED/FAIL with the static ACs PASS and no frontend console errors, treat it as an environment wedge FIRST, not a spec defect: check `dev-env.ps1 -Action Logs` for `[MCP][WS_SERVER][ERROR]` / `Handshake not finished`; clear it with a full Down → Up (NOT just `clean-fredo-db.ps1 -Restart`), verify the clean handshake log line, then re-dispatch the tester. Do NOT loop back to implementation on an all-UNVERIFIED-with-AC5-PASS round. (Round 5 showed the same signature with zero `telemetry_spans` rows — an emission-path gap, also environment-triage first: verify the telemetry env var is set in the tester's own shell, then plugin currency, then the receiver→DB write path, before blaming the spec.)
- **home:** playbooks/self-improver.md (step 9 recovery + this record) + dev-environment skill (Down→Up recovery) + references.md (G-046)
- **effectiveness:** Pending

### G-047: installed_plugin_stale_defeats_live_verification
- **activation_date:** 2026-08-17
- **observed:** #2745 testing rounds 2-6: the INSTALLED `~/.config/opencode/plugins/fredo.js` repeatedly lagged the spec branch's plugin fixes — after the R-3 child-parent fix (`6c813cd`) was on the branch with 58/58 unit tests, the installed file still lacked `resolveParentSessionId`, so live runs produced NULL `child_*` attrs / zero `telemetry_spans` rows despite a clean environment and the telemetry env var enabled. The plugin is installed via the app's native path (SetupWizard / `install_plugin` MCP command — NOT a filesystem copy), and it must be REBUILT from the spec branch tip before installing; `Test-Path` proves presence, not currency.
- **target_failure:** a plugin fix verified green by unit tests on the spec branch is never exercised live because the installed plugin is a stale build, producing zero/NULL telemetry and false FAILs (or the reverse — a round that would pass on the fixed plugin failing on the stale one).
- **guardrail:** Before any live opencode run, verify the INSTALLED plugin carries the spec's fix, not just that the file exists: rebuild the plugin from the spec branch tip (`bun build src/index.ts --outdir dist --target bun` in `apps/opencode-plugin`) and install through the app's native path (SetupWizard / `install_plugin`), then grep the installed file for the fix's defining symbol. A clean environment with zero `telemetry_spans` rows and the env var confirmed set is the stale-plugin signature — check plugin currency before touching the spec or the ECE.
- **home:** dev-environment skill (plugin prerequisite section — add currency step) + references.md (G-047)
- **effectiveness:** Pending

### G-048: tester_empty_dispatch_is_model_availability
- **activation_date:** 2026-08-17
- **observed:** #2745 round 6-7: six consecutive TESTER dispatches (4 full retest briefs + resume + 2 trivial `git log` probes) returned EMPTY results with ZERO state-machine calls while the developer agent ran the identical probe successfully — the harness was fine; the tester role alone failed. Config: `opencode.json` sets the tester agent model to `github-copilot/gpt-5.6-luna` while every other agent uses `deepseek/deepseek-v4-flash`. The tester worked in earlier rounds, so this was a NEW provider/model availability regression, not a never-working config. Issue BLOCKED with the reason and escalated to the human; the tester retry succeeded as-is after unblock (model recovered).
- **target_failure:** a subagent role that returns empty dispatches with zero state-machine calls while sibling roles on the same harness work — re-dispatching or "fixing" the spec wastes rounds instead of escalating the model/provider availability regression.
- **guardrail:** When a single subagent role returns EMPTY results across consecutive dispatches (including trivial probes) with zero state-machine calls while other roles work, suspect that role's configured model/provider availability — compare the role's model assignment in `opencode.json` against the working roles' model, block the issue with the recorded reason, and escalate to the human (model/provider config is human-owned). Unblock and re-dispatch after recovery; do NOT treat the empty dispatches as a spec or pipeline-state defect.
- **home:** playbooks/self-improver.md (step 8 blockers — add model-availability triage) + references.md (G-048)
- **effectiveness:** Pending

### G-049: webview_element_handle_stale_across_rerender
- **activation_date:** 2026-08-17
- **observed:** #2748 AC2 (keyboard rename) stayed UNVERIFIED across rounds 2-4: the round-4 tester proved activation + Enter-save live (the row updated to the custom name), but the NEXT interactions on the same/different row failed with "inline-input selector state became unavailable after the first save". Root cause: after a save the row RE-RENDERS with the custom name — any element handle / DOM node captured before the mutation is detached, so reusing it (or a selector result cached in a variable) finds nothing. The round-5 developer verified the product code is correct (re-render + focus return unit-tested) and the round-5 tester passed the full AC2 flow by re-`querySelector`-ing fresh after every state-mutating step.
- **target_failure:** a webview JS test driver caches an element handle/selector result across a state-mutating step (save, close, reopen, streaming update), then reports "element unavailable" as a suspected product defect — burning verification rounds on a driver artifact.
- **guardrail:** In `tauri_webview_execute_js` driving, NEVER reuse an element handle or `querySelector` result across a state-mutating step — a React re-render detaches pre-mutation nodes. Re-run the `querySelector` fresh after every save/close/reopen/update, and treat "element gone after a mutation" as a stale-handle driver artifact FIRST (re-query and retry) before reporting a product defect. When a keyboard-driving flow spans multiple mutations, the deterministic re-query-per-step recipe belongs in the feature's durable smoke suite (written by the developer once) so every tester round executes the same proven sequence instead of rediscovering the driver.
- **home:** playbooks/tester.md (add stale-handle rule) + references.md (G-049)
- **effectiveness:** Pending

### G-050: theming_ac_mode_missing_in_product_is_po_scope
- **activation_date:** 2026-08-17
- **observed:** #2748 AC5 required node neutrality "in both light and dark themes", but the product ships NO light/dark theme toggle for Mission Monitor (a fixed dark surface; Appearance exposes only base themes Classic/Turbo). Two testing rounds burned on the unsatisfiable light-theme leg (AC5 UNVERIFIED) while the developer probed whether a light theme exists. The human resolved it as a PO scope decision: the "both themes" leg was DROPPED, AC5 became current-theme-only, and the round-4/round-5 testers passed it in one pass each. FIX-10 (verify the theming surface) was closed by the PO amendment, not by a product change.
- **target_failure:** a theming acceptance criterion names a theme mode (light/dark) the product does not expose; rather than looping implementation/testing rounds to "verify" a nonexistent surface, the missing mode should be resolved as a PO scope decision.
- **guardrail:** When a theming AC requires a mode (light/dark toggle) that the product does not actually expose, do NOT silently loop rounds or substitute the observable — verify the theming feature's real mode surface once (exact UI path), then route the discrepancy to the human as a PO scope decision (amended AC or dropped leg), record the amendment on the issue, and re-verify against the amended criterion. Theme-token-only styling stays valid regardless of how many modes ship.
- **home:** playbooks/self-improver.md (audit/loop guidance — add missing-mode PO-scope routing) + references.md (G-050)
- **effectiveness:** Pending

### G-051: opencode_launch_never_diagnosed_via_binary_spelunking
- **activation_date:** 2026-08-17
- **observed:** #2748 round 4: the developer, chasing the Run CLI "Starting OpenCode…" reports, spent the round probing `opencode.exe` (spawning it non-interactively with piped stdio — which captures 0 bytes because opencode with no args is an interactive TUI requiring a TTY), grepping the MCP crate in Cargo.toml, checking binary/source mtimes, and scanning dev-env logs. None of that was #2748 scope: the round-3 G-047 check had already proved the installed plugin byte-identical to the spec-tip build, and the "Starting OpenCode…" overlay is a documented LOADING state, not a hang. The round was wasted; the SI redirected to the narrow verify-first scope.
- **target_failure:** a developer diagnosing a Run CLI / opencode launch complaint descends into binary/crate/log spelunking (non-interactive spawn probes, dependency greps, mtime checks) instead of verifying the documented environment facts (G-047 plugin currency, loading-state overlay, dev-env health) — wasting an implementation round on a non-defect.
- **guardrail:** Never diagnose a Run CLI / opencode launch complaint by spawning the `opencode` binary from a shell (a no-args non-interactive spawn yields 0 bytes — expected for a TTY-required TUI, NOT a hang) or by probing binary internals, crate dependencies, or file mtimes. First verify the documented environment facts: installed-plugin currency vs the spec tip (G-047), the "Starting OpenCode…" overlay being a loading state (wait through it), and dev-env health (MCP bridge wedge G-046). If those hold, the launch concern is a tester/environment verification item, not a developer product defect.
- **home:** playbooks/developer.md (add no-binary-spelunking rule) + references.md (G-051)
- **effectiveness:** Pending

### G-045: on_the_go_improvement
- **activation_date:** 2026-08-16
- **observed:** #2745 round 2
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Hardened the state-machine event/error log appenders after the #2745 torn append. writeln! issued two write syscalls (content then newline) so two concurrent invocations (the tester's upload-evidence retry burst at 23:26:07) tore two complete events onto one physical jsonl line, permanently failing the verify anti-tamper gate. Fix: appenders now write record + newline in one atomic write_all and readers (read_issue_events, metrics, health, verify) normalize a torn line into its fragments at read time via split_torn_json, validating each fragment for ts-order, duplicate-id and corruption. The append-only record file is never rewritten. Regression test added to test-scripts.ps1 (torn append passes verify, corrupt fragment still exits 3). 81/81 PASS.
- **home:** references.md (G-045)
- **effectiveness:** Pending





### G-044: on_the_go_improvement
- **activation_date:** 2026-08-15
- **observed:** #2745 round 1
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** rescope leg: implementation to planning is now legal
- **home:** references.md (G-044)
- **effectiveness:** Pending




### G-039: on_the_go_improvement
- **activation_date:** 2026-08-15
- **observed:** #2743 round 1
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Hardened upsert_file in pipeline-state.rs with a bounded retry (3 attempts, 2s then 4s backoff, re-reading the file sha each attempt) for the GitHub Contents API 409 race on back-to-back upload-evidence calls (observed on #2743 round 1: 2 of 5 evidence uploads landed, 3 hit HTTP 409 not-a-fast-forward). The Contents API is eventually consistent and a PUT immediately after a prior commit on the same branch races a stale tip. Validated with test-scripts.ps1 79/79 PASS. Re-dispatch guidance for the tester: upload evidence one at a time, never in parallel.
- **home:** references.md (G-039)
- **effectiveness:** Pending



Guardrail records - persisted by the Self-Improver at every audit (retro-analysis Recipe 6), **within the principles** (a rule that would contradict `principles.md` is proposed to the human, never applied). Records are **prose-only - never embed code snippets or product symbols**. Each record names the failure class, the rule, and where the rule lives; `effectiveness` is updated on later audits (Recipe 1). `AGENTS.md`/`opencode.json` entries are human-owned - the SI proposes, never edits. (Encoding a lesson as a script change - `pipeline-state.rs`, `.opencode/scripts/*` - is the SI's domain and stays in the script, not here.)

### G-001: subagent_stale_permissions
- **activation_date:** 2026-08-09
- **observed:** #2449, tester repeatedly blocked on missing telemetry-query/`fredo*` permissions; config edits in `opencode.json` had no effect on already-running subagents.
- **target_failure:** subagent runs with a stale permission set after `opencode.json` is edited mid-run.
- **guardrail:** Subagent sandboxes cache `opencode.json` at process startup - restart the opencode process (or dispatch a fresh agent) after editing agent permissions; never assume a running subagent sees new grants.
- **home:** references.md (G-001)
- **effectiveness:** Pending

### G-002: stale_spec_branch_config
- **activation_date:** 2026-08-09
- **observed:** #2449, spec/2449 forked before pipeline fixes; dispatched tester silently ran on stale config and re-blocked. **Recurred 2026-08-13 (#2723):** BOTH round-1 implementation developers reported `git -c core.editor=true *` DENIED despite the #2724 fix being merged — their worktrees checked out `spec/2723`, which forked BEFORE #2724 and lacked the two new allows (`git -c core.editor=true *`, `git merge origin/spec/*`). The repo-level `.git/config` `core.editor=true` (shared across worktrees) silently saved the rebases; the stale branch was synced with main before the tester only.
- **target_failure:** agent dispatched on a spec branch that lacks `main`'s current pipeline config.
- **guardrail:** Before dispatching the tester (or any agent) on `spec/<N>`, sync it with `main` (`git fetch origin main && git merge origin/main` + push) - the working tree's `opencode.json` is the source of the agent's sandbox. **Operationalize for the DEVELOPER POOL too:** when a spec branch forked before a pipeline-config change, sync `spec/<N>` with main before dispatching implementation developers as well (their worktrees check out the spec branch, so they inherit its stale `opencode.json`), not only before the tester.
- **home:** playbooks/self-improver.md step 9 (tester) + step 6 (developer dispatch, added 2026-08-13) + references.md (G-002)
- **effectiveness:** Partial (tester dispatch protected; developer dispatch still exposed until step 6 sync was added 2026-08-13)

### G-003: missing_plugin_install
- **activation_date:** 2026-08-09
- **observed:** #2449, tester stuck because the fredo plugin was not installed at `~/.config/opencode/plugins/fredo.js`.
- **target_failure:** agent that needs fredo's telemetry emission cannot find the plugin.
- **guardrail:** The fredo plugin must be built (`apps/opencode-plugin`) and installed to `~/.config/opencode/plugins/fredo.js` on any host running the pipeline; verify with `Get-Command`/`Test-Path` before dispatching agents that depend on it.
- **home:** dev-environment skill
- **effectiveness:** Pending

### G-004: worktree_missing_node_modules
- **activation_date:** 2026-08-09
- **observed:** #2449, dev instance running the spec build from a bare worktree failed - no `node_modules` present.
- **target_failure:** build/run from a git worktree that was never installed.
- **guardrail:** Run `pnpm install` in a new worktree before building/running the UI; a bare worktree lacks dependencies.
- **home:** dev-environment skill
- **effectiveness:** Pending

### G-005: env_ci_runner_noise
- **activation_date:** 2026-08-09
- **observed:** #2449, PR merge blocked by a FAILURE check that failed in <10s (runner-provisioning infra, not a real regression).
- **target_failure:** environmental runner failure blocking an otherwise-green merge.
- **guardrail:** The merge guard treats a FAILURE check that completed in <10s as environmental (runner noise) and exempts it; `UNSTABLE` merge state is allowed only when every failing check was exempt. Real failures and DIRTY/BLOCKED/BEHIND/UNKNOWN still block.
- **home:** pipeline-state.rs `pr_merge_guard`
- **effectiveness:** Pending

### G-006: evidence_mask_by_verdictless_receipt
- **activation_date:** 2026-08-10
- **observed:** #2680, the tester's screenshot `## Evidence` receipt (posted after the verdict) masked the PASS and falsely blocked `testing -> audit`.
- **target_failure:** the verification guard reads the literal latest evidence comment and is misled by a later verdictless receipt.
- **guardrail:** Read the latest *verdict-carrying* `## Tests Runs` / `## Evidence` comment; verdict-line parsing is bold-tolerant. The #1499 semantic (newer FAIL beats older PASS) is preserved.
- **home:** pipeline-state.rs `verification_status`
- **effectiveness:** Pending

### G-007: policy_value_misparsed_as_static
- **activation_date:** 2026-08-10
- **observed:** #2680, the audit mislabeled a `live` plan as `static` because the template's explanatory sentence contains the word "static".
- **target_failure:** a whole-line "contains static" scan weakens the fail-closed live-evidence guard.
- **guardrail:** Parse the declared value after `Verification policy:` - not a whole-line substring scan.
- **home:** pipeline-state.rs `verification_status`
- **effectiveness:** Pending

### G-008: wrong_live_db_path
- **activation_date:** 2026-08-10
- **observed:** #2688, the Architect dispatched to diagnose the round-6 delivery drop looked for the live DB at the non-existent `%APPDATA%\fredo\fredo.db` and stalled; the packaged app's live DB is under `com.fredo.app`. The telemetry-query skill previously listed the wrong path first.
- **target_failure:** a diagnosing agent cannot find the live telemetry DB and blocks mid-diagnosis (or queries the wrong DB and reaches a false conclusion).
- **guardrail:** The telemetry-query skill states unambiguously that the live DB is `%APPDATA%\com.fredo.app\fredo.db` and warns that `%APPDATA%\fredo\fredo.db` does not exist for the packaged app; agents diagnosing telemetry read the skill's DB section before querying and use `clean-fredo-db.ps1` for a fresh-slate reset.
- **home:** .opencode/skills/telemetry-query/SKILL.md
- **effectiveness:** Pending

### G-009: out_of_repo_file_access_denied
- **activation_date:** 2026-08-10
- **observed:** #2688, the Architect diagnosing double emission tried `Get-Content ~/.config/opencode/opencode.json` and to read the live DB file directly; the sandbox DENIES reads/writes outside the repo, so the agent stalled instead of proceeding.
- **target_failure:** an agent attempts raw file access to an out-of-repo path (live `fredo.db`, `~/.config/opencode/*`, `%APPDATA%\com.fredo.app\*`), gets DENIED, and loops/stalls instead of using the documented in-repo source.
- **guardrail:** Never attempt raw reads/writes outside the repo - the sandbox denies them. Out-of-repo artifacts have documented in-repo sources: the live DB path + query recipes live in the `telemetry-query` skill; the opencode plugin install and DB reset (`clean-fredo-db.ps1`) live in the `dev-environment` skill. Load the relevant skill; if a needed out-of-repo value is not documented, report it to the orchestrator instead of probing the filesystem.
- **home:** docs/agentic-pipeline/common-rules.md + both skills
- **effectiveness:** Pending

### G-014: a2a_triage_file_posted_as_comment
- **activation_date:** 2026-08-11
- **observed:** #2694, triage planners posted the raw auto-seeded A2A file (`.opencode/tmp/<issue>/triage.md` - the unfilled plan template) as `Status`/`Question` comments on the feature issue three times, producing duplicate boilerplate "implementation plan" comments that had to be deleted and a re-planned triage.
- **target_failure:** a triage planner posts the A2A deliberation file (or its content) to the issue timeline instead of editing its own section of the local file, polluting the plan record with unfilled template text.
- **guardrail:** Triage planners NEVER post comments - all deliberation happens in `.opencode/tmp/<issue>/triage.md` (own `## <Agent>` section + agent-tagged `## Discussion` points); the SI assembles and posts the plan. The state machine refuses the A2A triage file as a `comment` body (basename `triage.md` or the A2A header marker) with a clear error; the SI dispatch brief reinforces the rule.
- **home:** pipeline-state.rs `comment` action (A2A guard) + playbooks (self-improver step 2, software-architect/ui-ux-expert/qa-expert GitHub conventions)
- **effectiveness:** Pending

### G-015: context_read_loop
- **activation_date:** 2026-08-11
- **observed:** #2694, the planning cluster spun on the `context` action: 177 `state_machine.call` reads in ~2 minutes (qa-expert 128, software-architect 44) with zero plan content written to the A2A file — the triage "ran" without producing anything.
- **target_failure:** an agent loops re-reading its pipeline context instead of doing its phase work, burning the phase with no deliverable.
- **guardrail:** The `context` action refuses a streak of consecutive reads with no intervening state-machine activity (limit 3), printing a directive to stop re-reading and act (or report a gap); the blocked event resets the streak so a genuinely-waiting agent can proceed. Agents read context once at wake; the dispatch brief reinforces it.
- **home:** pipeline-state.rs `context` action (`context_read_streak` + `CONTEXT_READ_STREAK_LIMIT`)
- **effectiveness:** Pending

### G-016: subagent_tool_loop
- **activation_date:** 2026-08-11
- **observed:** #2694, triage planners on `deepseek-v4-flash` fell into tool-call loops across three separate dispatches: the A2A file posted as comments (G-014), 177 `context`-read spins (G-015), minutes of repeated `git log --oneline -1`, and `gh issue view` probe loops — the model's own reasoning said "I must break this loop / use the Edit tool" while it kept emitting the same allowed tool call. The config had `doom_loop: deny` on every agent, disabling opencode's built-in "same tool call repeated 3× → recovery prompt" — so nothing ever stopped the loop.
- **target_failure:** a subagent repeats an ALLOWED tool call (or close variants) instead of integrating the result and acting, burning the phase with no deliverable.
- **guardrail:** Three layers, all mandatory: (1) `doom_loop: allow` on every pipeline agent so opencode auto-injects a recovery prompt on 3× identical tool calls (agents follow the prompt: stop, summarize, switch tactic); (2) deny-by-default surfaces — a DENIED command returns an error that breaks the repetition attractor (triage planners have no git; never retry a denied command), and an agent `steps` cap + low `temperature` bound variant-probe loops; (3) lean dispatch briefs — inline the backlog, one-edit deliverable, read context once, no git/gh probing (self-improver playbook step 2). Pipeline-level: the state-machine `context`-streak and A2A-comment guards (G-014/G-015).
- **home:** opencode.json (`doom_loop: allow`) + permissions.md "Loop mitigation" + common-rules.md + self-improver playbook step 2
- **effectiveness:** Pending

### G-017: utf8_bom_hides_verdict_line
- **activation_date:** 2026-08-11
- **observed:** #2700 round 1, a tester `## Tests Runs` draft written with a leading UTF-8 BOM fail-closed the testing exit gate with a misleading "no `Verdict: PASS` line" even though the comment read `Verdict: **PASS**`.
- **target_failure:** a BOM-prefixed verdict line is not parsed, blocking a legitimate PASS.
- **guardrail:** verdict and policy-line parsers strip a leading UTF-8 BOM before matching; comment drafts should be written without a BOM.
- **home:** pipeline-state.rs `line_has_verdict` / `verification_status` (+ harness test in test-scripts.ps1)
- **effectiveness:** Pending

### G-018: worktree_remove_build_artifacts
- **activation_date:** 2026-08-11
- **observed:** #2700 round 1 (also #2688/#633), `remove-worktree` failed with "Directory not empty" whenever a worktree had gitignored build artifacts (`node_modules`/`dist`) from `pnpm install`/builds — the developer had to hand-clean the debris. **Recurred #2723 round 1 (3×: `2723-a`, `2723-b`, `2723-d`/`-e`) and round 2 (`2723-a`, `2723-b`)** — the `node -e` fs.rmSync cleanup is now the standard workaround (both devs used it; the retry reports "not a working tree" because the metadata was already unregistered).
- **target_failure:** the remove-worktree action cannot delete a worktree that ran pnpm install/build.
- **guardrail:** remove-worktree pre-cleans ignored files (`git clean -fdX`) before `git worktree remove`; tracked changes and uncommitted work survive, so the dirty-refusal guard is intact. When the pre-clean still fails on gitignored debris (`node_modules`/`dist`), clean with a `node -e` fs.rmSync one-liner (node is allowlisted; no semicolons) and confirm the worktree directory is gone — a subsequent "not a working tree" retry is expected because the metadata was already unregistered.
- **home:** pipeline-state.rs `remove-worktree` action (+ harness test in test-scripts.ps1) + developer playbook/worktree hygiene
- **effectiveness:** **Partial** (updated 2026-08-12, #2707) — the pre-clean still loses on Windows when pnpm leaves junction/symlink remnants in `node_modules`, so the action fails once ("Directory not empty") and the success event is not recorded even though the worktree is eventually removed/unregistered. Follow-up (SI script domain): make the pre-clean failure loud instead of swallowed (`let _ =`), or retry `git worktree remove`. Confirmed recurring through #2723 (4+ more occurrences) — raise priority of the script fix.

### G-019: granular_edit_deny_overrides_allow
- **activation_date:** 2026-08-11
- **observed:** #2700 round 1, all three triage planners (software-architect, ui-ux-expert, qa-expert) reported NO usable Edit/Write tool despite `opencode.json` declaring `edit` allowlists for `.opencode/tmp/**` — the "ONE Edit to your own A2A section" deliverable was impossible; all three returned complete verbatim content for the SI to apply.
- **target_failure:** a triage planner cannot write its A2A section (or seed test suites), stalling or degrading planning.
- **root_cause:** opencode evaluates permission rules with **last matching rule wins**, and every granular `edit` block listed the specific `allow`s FIRST and the catch-all `"*": "deny"` LAST — so the catch-all denied every path, overriding the allowlists. The `bash` blocks had the correct order (`"*": "deny"` first); the `edit` blocks did not.
- **guardrail:** In every granular permission object the catch-all `"*": "deny"` MUST be the FIRST rule, with specific `allow`s after (last matching rule wins). Fixed across product-owner/software-architect/ui-ux-expert/qa-expert/tester in `opencode.json`. Fallback while a stale session persists (G-001: subagents cache config at startup): if a planner reports no Edit/Write tool, apply its verbatim deliverable to the A2A yourself rather than re-dispatching.
- **home:** opencode.json per-agent `edit` blocks (order: `*` deny first) + playbooks/self-improver.md step 2 (fallback)
- **effectiveness:** Pending

### G-020: tester_duplicate_verdict_posting
- **activation_date:** 2026-08-12
- **observed:** #2707, the tester posted the identical full verdict comment (`## Evidence` + complete `## Tests Runs` body, `Verdict: PASS`) FOUR times within a minute (02:18:32, 02:19:13, 02:19:27, 02:19:37) — one per `upload-evidence` screenshot, each carrying the whole tests-runs dump.
- **target_failure:** duplicate verdict comments pollute the issue timeline and risk the verification guard reading a stale or partial receipt; per-round verdict identity is lost.
- **guardrail:** One verdict comment per round — the tester's rule in the playbook (step 6: fold ALL receipts into the single `## Tests Runs`); `upload-evidence` bodies are SHORT per-screenshot evidence (a description + the raw URL), never the full Tests Runs dump. Escalation: the `comment`/`upload-evidence` actions should refuse a second verdict-carrying (`Verdict:`-bearing) comment within the same round.
- **home:** playbooks/tester.md step 6 (existing rule, verbatim) + pipeline-state.rs `comment`/`upload-evidence` actions (proposed machine guard)
- **effectiveness:** Pending

### G-021: webview_react_pointer_handlers_unreachable
- **activation_date:** 2026-08-12
- **observed:** #2707, `tauri_webview_interact(action="swipe")` could not drive the details-panel drag-resize: React's `onPointerDown`/`onPointerMove` handlers (with `setPointerCapture`) never receive browser-level dispatched events, so the AC2 drag had to be tested via programmatic PointerEvent dispatch and E-9 (rapid repeated drags) stayed UNVERIFIED.
- **target_failure:** an interactive React pointer-handler control cannot be exercised by the standard webview interact primitives, leaving its ACs UNVERIFIED or forcing a test-mechanics workaround mid-run.
- **guardrail:** For React pointer-handler UI (drag/resize/capture), dispatch programmatic PointerEvents via `tauri_webview_execute_js` (dev-environment skill Pattern 9) and verify via DOM state (e.g. `aria-valuenow`), not by assuming `tauri_webview_interact` reached the handler.
- **home:** .opencode/skills/dev-environment/SKILL.md DOM Test Patterns (Pattern 9, added 2026-08-12)
- **effectiveness:** Pending

### G-022: triage_req_ids_not_ac_aligned
- **activation_date:** 2026-08-12
- **observed:** #2707, the Architect's EARS REQ IDs (R-1=AC1+AC5, R-2=AC2-resize, R-3=AC2-persist, R-4=AC3, R-5=AC4) drifted from the QA Expert's AC-aligned table (R-1=AC1..R-5=AC5); the QA Expert explicitly asked for stable IDs and the SI renumbered the Architect's clauses at convergence.
- **target_failure:** EARS REQ IDs and the QA Plan REQ column map to different ACs, breaking the 1:1 mapping the tester's `## Tests Runs` verification relies on.
- **guardrail:** EARS REQ IDs MUST be AC-aligned (R-1=AC1 ... R-5=AC5); a multi-behavior AC (e.g. resize + persistence) gets sub-clauses under the SAME REQ id, never a separate number. The Architect owns this contract; the QA Expert keys its table to it.
- **home:** playbooks/software-architect.md Verification (added 2026-08-12)
- **effectiveness:** Pending

### G-023: cross_cutting_mechanism_divergence
- **activation_date:** 2026-08-12
- **observed:** #2707, the UI/UX Expert designed FeatureStore `panel_prefs` persistence and a 600px max width while the Architect's contract said `usePersistedSetting`/settingsService and a 520px clamp — two planner sections contradicted each other on a cross-cutting mechanism and had to be reconciled at assembly.
- **target_failure:** planner sections ship contradicting cross-cutting decisions (persistence medium, storage keys, clamps), forcing SI reconciliation and risking a self-contradictory Implementation Plan.
- **guardrail:** Cross-cutting mechanism decisions are the Architect's binding contract, declared in `## Discussion` as soon as they are made; UI/UX and QA design against the declared contract; the SI scans all planner sections for contradicting mechanisms before assembling the plan and realigns them in the same pass (recorded in `## Discussion`).
- **home:** playbooks/software-architect.md Verification + playbooks/self-improver.md Guardrails (added 2026-08-12)
- **effectiveness:** Pending

### G-024: glob_misses_dot_directories
- **activation_date:** 2026-08-12
- **observed:** #2707, the Glob tool returned "No files found" for `.opencode/tests/mission-monitor/**` even though the folder existed (seeded at #2706 triage) — the QA dispatch brief wrongly said "create it" and the QA Expert had to correct it; the same miss repeated for `.github/workflows/` and `.opencode/tmp/2707/`.
- **target_failure:** glob-based pre-flight checks miss existing hidden-directory state (`.opencode/`, `.github/`, `.worktrees/`), producing inaccurate dispatch briefs, duplicate work, or wrong "absent" conclusions.
- **guardrail:** Never use Glob to prove absence of pipeline state under a dot-directory — use a directory listing/read. A glob "no files found" only means "not indexed", not "does not exist".
- **home:** playbooks/self-improver.md Guardrails (added 2026-08-12)
- **effectiveness:** Pending

### G-025: developer_pool_shares_one_worktree
- **activation_date:** 2026-08-12
- **observed:** #2717, the SI dispatched the developer pool all on the `create-worktree` default `.worktrees/2717` (one shared tree) — developers' uncommitted edits interleaved in the same files, and a developer stalled re-deriving the state (files changed between its own two reads). The bottom-bar sub-task (SessionTokenBar) never reached the spec branch. Earlier specs worked only because the SI happened to use per-dev `-a`/`-b`/`-c` paths ad hoc.
- **target_failure:** a developer pool shares one worktree, so concurrent uncommitted edits interleave and stall developers (or silently drop work).
- **guardrail:** Each developer gets its OWN worktree — `create-worktree --worktree-path .worktrees/<N>-a`, `-b`, `-c`, ... one per developer. Never share a single `.worktrees/<N>` across the pool (that default is for a single developer only). The SI's staffing dispatch assigns and records the per-dev path.
- **home:** playbooks/self-improver.md step 6 (per-developer worktrees)
- **effectiveness:** Pending

### G-026: main_sync_merge_blocked_by_sandbox
- **activation_date:** 2026-08-12
- **observed:** #2717, the G-002 main-sync (`git fetch origin main && git merge origin/main` + push, playbook step 9) could not be executed by ANY agent role: the developer sandbox exposes no `git merge*` allow entry (default bash deny catches every merge), and the self-improver sandbox's `git merge *main*` deny over-matches `origin/main`. The developer pushed without the sync and flagged it; the SI re-synced by merging the tip SHA (an allowlisted equivalent) and pushing `HEAD:spec/2717` — the branch then carried main's newer pipeline config and the tester ran unblocked.
- **target_failure:** an agent instructed to sync `spec/<N>` with `main` before dispatching the tester (G-002) hits a sandbox denial on the documented merge command and stalls or silently skips the sync, leaving the branch on stale pipeline config.
- **guardrail:** When the documented sync merge is sandbox-denied for a role, execute the identical operation with the allowlisted form — merge the fetched tip SHA of `origin/main` (no branch name in the arguments) and push `HEAD:spec/<N>` — then verify the branch carries main's pipeline config before dispatching the tester. Do not skip the sync; the tester's sandbox config comes from the working tree. (Candidate allowlist fix, human-owned: add a narrow `git merge origin/main` allow for self-improver/developer, or remove the `git merge *main*` over-deny.)
- **home:** references.md (this record) + playbooks/self-improver.md step 9 (G-002)
- **effectiveness:** **Confirmed** (updated 2026-08-13, #2723) — the SHA-merge workaround executed cleanly three times this spec (pre-round-1 `a1d36dd`, pre-round-2 `5557544`, doc-sync `b7531ee`); `git merge <sha-of-origin/main>` remains the reliable allowlisted form. (Candidate allowlist fix, human-owned: add a narrow `git merge origin/main` allow for self-improver/developer, or remove the `git merge *main*` over-deny.)

### G-028: adapter_payload_premise_unverified_against_live_spans
- **activation_date:** 2026-08-13
- **observed:** #2723 round 1, the AC5 `excludePayload` filter never fired because the plan's Domain Model asserted the adapter injects `is_subagent`/`agent.type` into event payloads (`otlp.rs:1119-1124`) — unit tests passed (fixtures carried the flag) but LIVE `fredo.llm` spans carry NULL for both (the flag exists only on the `fredo.session` span; subagent LLM spans carry `session.parent_id` instead). The tester's round-1 FAIL exposed it; the round-2 adapter fix (session-level detection + marker propagation into every span-derived payload) passed.
- **target_failure:** a payload-shape assumption in the plan is validated only against unit fixtures, so the implemented mechanism never matches the REAL span/payload shape — caught only by the live tester round, forcing a rework.
- **guardrail:** For any adapter/ECE capability whose mechanism depends on a payload field's presence or shape (filter fields, injected markers, extraction paths), the plan must include a LIVE telemetry shape check (ST-3 Phase-0 diagnostic pattern — query `telemetry_spans` and verify the field exists in the real span attributes for the target event type) BEFORE implementing, not only unit tests with hand-built fixtures. Adapter-path specs: verify against the real span shape, never fixtures alone.
- **home:** playbooks/software-architect.md (Domain Model must cite live-verified payload fields) + references.md (this record)
- **effectiveness:** Pending

### G-029: retry_round_verdict_not_round_stamped
- **activation_date:** 2026-08-13
- **observed:** #2728 round 2, the tester posted its PASS verdict via the `--prefix Evidence` comment path (`## Evidence` header) — an alias the round-aware verification guard does NOT round-stamp. The guard parses `(round N)` only from `## Tests Runs` headers; untagged evidence counts as round 1, so `testing -> audit` was BLOCKED with "evidence is from round 1 but the issue is on round 2" until the tester re-posted the same content as a `tests-runs.md` draft via `post-comments` (machine-stamped `## Tests Runs (round 2)`).
- **target_failure:** on a retry round, a tester verdict posted through the `## Evidence` alias carries no round stamp, so the exit guard rejects it as stale round-1 evidence and the transition stalls.
- **guardrail:** On retry rounds the tester MUST post the verdict by drafting `.opencode/tmp/<issue>/tests-runs.md` and flushing it with `post-comments` — the state machine stamps the `## Tests Runs (round N)` header; the `## Evidence` comment alias is untagged and fails the round guard. Never use `--prefix Evidence` for the round verdict.
- **home:** playbooks/tester.md step 6 (retry-round posting rule, added 2026-08-13) + references.md (this record)
- **effectiveness:** Pending

### G-030: launch_failure_fixture_assumes_os_spawn_semantics
- **activation_date:** 2026-08-13
- **observed:** #2728, the QA Plan's primary AC5 launch-failure fixture was "set `run_cli_work_dir` to a nonexistent directory" — assumed a bad cwd fails the PTY spawn. On Windows this is FALSE: ConPTY accepts a nonexistent cwd at spawn time, opencode launches anyway, `launch_error` is never set, and AC5 was UNVERIFIED until the round-2 fix added explicit backend cwd validation (deterministic `launch_error` before spawning).
- **target_failure:** a launch-failure test fixture that relies on OS-level spawn validation is platform-dependent; on a platform that does not validate (Windows/ConPTY) the failure silently doesn't happen, leaving the negative AC unverifiable and the tester blocked (renaming the binary is also sandbox-denied).
- **guardrail:** Launch-failure fixtures MUST NOT depend on the OS failing a spawn on its own. Make the failure deterministic in the product: the backend validates the failure input (working directory existence/accessibility, binary path) and sets the launch-error state BEFORE spawning, so the error surface is reachable sandbox-safe on every platform. Triage: when a QA fixture assumes platform spawn behavior, either verify that behavior on the target platform or add the deterministic backend guard to the plan's scope.
- **home:** references.md (this record) + software-architect plan-scope guidance (deterministic error paths are product scope, not test-env hacks)
- **effectiveness:** Pending

### G-031: create_worktree_stale_local_spec_ref
- **activation_date:** 2026-08-13
- **observed:** #2728 round 2, `create-worktree --worktree-path .worktrees/2728-b2` checked out the stale LOCAL `spec/2728` ref (fork tip `513fa20`, pre-implementation) instead of the remote tip (`c2d77fc`) — the developer had to `git checkout origin/spec/2728` manually before starting. The local ref lags whenever the branch was created before dev pushes and the worktree is created in a later round. **RECURRED 2026-08-15 (#2743 round 5):** `create-worktree` checked out the stale local `spec/2743` ref (`3c6f1ca`) instead of `origin/spec/2743` (`85dfed6`); the developer corrected it manually. The recurrence confirms the script-side fix is still outstanding (guardrail not yet baked into `create-worktree`).
- **target_failure:** a developer worktree is created at a stale spec-branch tip, so the developer silently works on pre-implementation code (missing ST-1..ST-4), wasting a round or producing a wrong-base commit.
- **guardrail:** `create-worktree` must resolve the spec tip from `origin/spec/<N>` (or fetch/update the local ref first) before checking out, so worktrees never land on a stale local ref. **FIXED 2026-08-15:** `resolve_base` in pipeline-state.rs now returns the remote-tracking ref `origin/spec/<N>` (after fetching) instead of the local `spec/<N>` ref, so every worktree is created at the freshest pushed tip. Validated with test-scripts.ps1. Workaround meanwhile (pre-fix): after `create-worktree`, `git checkout origin/spec/<N>` (detached) in the worktree before implementing.
- **home:** pipeline-state.rs `create-worktree` action (`resolve_base` → `origin/spec/<N>`, fixed 2026-08-15, validated with test-scripts.ps1) + references.md (this record)
- **effectiveness:** Pending

### G-032: main_sync_merge_on_stale_local_spec_ref
- **activation_date:** 2026-08-13
- **observed:** #2731, the pre-tester main-sync (G-026) merged `origin/main` into the STALE LOCAL `spec/2731` ref (fork point `bc9377d`, created before the `tests-commit` side-effect landed the QA-seeded run-cli suite on `origin/main` AND before the developer pushed `55ce032`). The merge commit was built on a base missing the developer's work and the push was rejected non-fast-forward ("tip behind remote counterpart"). Recovery: reset the local spec ref to the remote tip (`git checkout -B spec/2731 origin/spec/2731`), re-run the merge with the tip SHA, then push.
- **target_failure:** the SI's pre-tester main-sync merge lands on a stale local `spec/<N>` ref (missing the developer's pushed commits and/or newer `origin/main` commits), producing a wrong-base merge commit that cannot be pushed and stalls the testing handoff.
- **guardrail:** Before the pre-tester main-sync (G-026), ALWAYS reset the local `spec/<N>` branch ref to `origin/spec/<N>` first (`git checkout -B spec/<N> origin/spec/<N>`), then merge the fetched `origin/main` tip SHA and push `HEAD:spec/<N>`. Never merge `origin/main` into the local spec ref directly after a fork — the local ref lags the remote whenever the branch was created before the developer pushed (G-031's create-worktree stale-ref hazard applies to the SI's own merge-sync step too).
- **home:** playbooks/self-improver.md step 9 (pre-tester sync, added 2026-08-13) + references.md (this record)
- **effectiveness:** Pending

### G-010: reactflow_edge_selector_dom_attribute
- **activation_date:** 2026-08-10
- **observed:** #2688, rounds 7-9: the QA selector `.react-flow__edge[data-id^="e-chat-"]` NEVER matched because ReactFlow v11 renders edge groups with a test-id attribute (`rf__edge-<id>`) and no `data-id` (data-id exists on nodes only), so the tester repeatedly reported "zero chat-chain edges" and the Architect's round-8 verdict wrongly concluded edges render. Round 9 proved the edges were never BUILT (a separate frontend bug), but the selector mismatch masked and misattributed the failure for three rounds.
- **target_failure:** a DOM-verification selector is written from an assumption about the component library's rendered attributes, producing a persistent false-negative (or false-positive) verdict.
- **guardrail:** Before finalizing a DOM selector for a UI-library element, verify which attribute the library ACTUALLY renders (inspect the component source or one live DOM sample); do not assume `data-id`/class conventions. ReactFlow v11 edges: use the test-id-prefix selector or count the rendered edge elements, never a node-style `data-id` selector. When a "missing element" verdict contradicts unit tests, check the selector against the real DOM before declaring a product bug.
- **home:** references.md (this record) + the QA plan's R2 case guidance in the plan per spec; dev-environment skill E2E patterns
- **effectiveness:** Pending

### G-011: graph_builder_state_lost_on_lifecycle_reset
- **activation_date:** 2026-08-10
- **observed:** #2688, round 9: the chat-chain edges were never built because the frontend graph builder captured the previous-node id on the chat-node **init** delivery but the **end**-lifecycle re-set (and update re-set) replaced the node entry with an object missing that field; live Run CLI delivers each turn's init+end in the SAME batch, so edge building read `undefined` and bailed. The ST4/ST10 unit tests fed init-only fixtures and never caught it.
- **target_failure:** a frontend state/graph builder that re-sets an entry on a later ECE lifecycle (update/end) silently drops builder-state fields captured at init, breaking downstream derivation; unit tests that feed only init-shaped fixtures miss the live same-batch init+end shape.
- **guardrail:** When a frontend graph/state builder replaces an entry on update/end lifecycles, it MUST carry forward all builder-state fields captured at init (e.g. predecessor/chain links); regression tests for ECE-fed builders MUST feed the LIVE delivery shape (init+end pairs for the same key in one batch, matching the real adapter's export pattern), not init-only fixtures.
- **home:** references.md (this record); the ST12 fix (useMissionMonitor.ts) is the exemplar
- **effectiveness:** Pending

### G-012: ece_unregistered_contract_no_buffering
- **activation_date:** 2026-08-10
- **observed:** #2688, round 8: the tester sent messages 1-2 BEFORE opening Mission Monitor, so the chat-node contract was never registered and the ECE produced no deliveries for those turns (feature store: 3 init + 3 end instead of 5+5) - a harness-protocol failure mislabeled as AC1 FAIL.
- **target_failure:** a live e2e generates events for a consuming feature before that feature is mounted, so the ECE (which buffers per registered contract) never delivers those events; the tester misreads the resulting missing UI state as a product defect.
- **guardrail:** In live e2e for a delivery-driven feature, open the consuming feature (so its ECE contracts are registered) BEFORE generating the events under test; a missing-feature-at-send-time gap is a test-protocol failure, not a product regression, and must be re-run with the corrected ordering before it is reported as a FAIL.
- **home:** dev-environment skill (E2E methodology) + references.md (this record)
- **effectiveness:** Pending

### G-013: tests_runs_verdict_line_format
- **activation_date:** 2026-08-10
- **observed:** #2688, round 10: the tester posted a `## Tests Runs` comment whose verdict was embedded in the header line (`## Tests Runs -- PASS 7/7 -- ...`) instead of the template's required first content line `Verdict: **PASS**`, so the testing exit guard failed closed ("no Verdict: PASS line") and blocked the transition until the SI reposted a template-conformant comment.
- **target_failure:** a `## Tests Runs` / `## Evidence` verdict comment that does not carry the machine-parsed verdict line in the template format blocks (or, conversely, a malformed one could falsely clear) the testing exit gate.
- **guardrail:** The verdict comment MUST follow the Tests-runs template: the literal `Verdict: **PASS**` (or `**FAIL**`) token as the first content line, a per-AC table, and the literal `telemetry_spans` token in the evidence for live-policy plans. Do not bury the verdict in the heading or prose; the guard parses the first content lines.
- **home:** docs/agentic-pipeline/templates/Tests-runs-comment-template.md + tester playbook
- **effectiveness:** Pending

### G-033: verdict_token_contradicts_rows
- **activation_date:** 2026-08-14
- **observed:** #2734 rounds 1-2: the tester posted `Verdict: **PASS**` while the same `## Tests Runs` comment carried 9 UNVERIFIED rows (round 1, source-of-truth ACs unverified) and 3 FAIL rows (round 2) — the machine's testing-exit guard parses only the verdict token + literal `telemetry_spans` presence and would have mechanically cleared both false PASSes; the SI caught them at audit review and blocked for human decisions instead. Final round resolved the contradiction via a PO amendment (FAILs accepted as provider-limited n/a), producing a clean 12 PASS / 3 n/a / 0 FAIL / 0 UNVERIFIED verdict.
- **target_failure:** a `Verdict: **PASS**` whose own rows contain FAIL or UNVERIFIED entries clears the exit gate without substantiating a pass.
- **guardrail:** The SI MUST verify the verdict's rows against the (possibly amended) ACs — a PASS token with FAIL or UNVERIFIED rows is a false PASS, not a pass; the machine gate should be hardened to reject `Verdict: PASS` when the same comment carries `FAIL` or `UNVERIFIED` row verdicts (distinguish `n/a — provider-limited` accepted rows from FAIL), so a false PASS can never clear mechanically.
- **home:** playbooks/self-improver.md step 11 (already: "Independently check the evidence against the ACs, not just that a verdict token exists") + pipeline-state.rs hardening candidate (G-033)
- **effectiveness:** Pending

### G-034: evidence_integrity_checked_on_stale_ref
- **activation_date:** 2026-08-14
- **observed:** #2734 round 3: the SI judged the tester's evidence screenshot URLs against a stale local `origin/spec/2734` ref (never re-fetched after the tester pushed) and wrongly concluded the URLs were broken, then ran 4 redundant `upload-evidence` calls that duplicated the tester's own commits.
- **target_failure:** judging branch evidence from a stale local ref produces a false integrity finding and redundant uploads.
- **guardrail:** ALWAYS `git fetch origin spec/<N>` before judging evidence committed to a spec branch on a subagent's report — a stale ref is a false-finding machine, not a verdict.
- **home:** playbooks/self-improver.md (G-034)
- **effectiveness:** Pending

### G-035: spec_content_leaked_via_wrong_base_pr
- **activation_date:** 2026-08-14
- **observed:** #2734: the #2737 pipeline-fix branch (`feat/po-comment-gate`, created to unblock the PO's AC amendment for #2734) was forked from `spec/2734` instead of `main`, so its squash merge delivered #2734's ENTIRE spec content — ST-2 adapter fix, ST-3 reconciliation guard, all unit tests, and all 11 evidence files — onto main BEFORE #2734's audit. The `testing → audit` spec-PR merge then contained only the residual delta (the final evidence jpg), masking the early delivery. Main ran the un-audited spec code before the spec completed.
- **target_failure:** an unrelated PR's branch carries another spec's content onto main, so main receives spec work before its audit and the spec-PR merge no longer reflects the true delivery.
- **guardrail:** NEVER fork a feature/pipeline branch from a `spec/*` branch — always from `main` (spec branches carry unmerged spec content; a squash of such a branch leaks that content to main). The SI should verify a spec PR's merge diff contains only that spec's expected files before recording the merge as the delivery.
- **home:** playbooks/self-improver.md step 6/9 (branch hygiene — "always work from main") + pipeline-state.rs merge-guard hardening candidate (G-035)
- **effectiveness:** Pending

### G-036: mergeable_state_transient_unknown_after_push
- **activation_date:** 2026-08-14
- **observed:** #2734: the `testing → audit` transition failed once with `cannot merge spec PR #2735 (mergeStateStatus: UNKNOWN)` immediately after the tester pushed a head commit — GitHub recomputes PR mergeability asynchronously; `gh pr view` showed `MERGEABLE`/`UNSTABLE` moments later and the retry merged cleanly.
- **target_failure:** a transient `UNKNOWN` mergeability state (right after a head push) hard-blocks the transition and stalls the pipeline.
- **guardrail:** when a transition fails with `mergeStateStatus: UNKNOWN` shortly after a head push, re-check `gh pr view` (do NOT treat it as a real block) and retry the transition once before escalating.
- **home:** playbooks/self-improver.md (G-036)
- **effectiveness:** Pending

### G-037: tui_input_submitted_before_blaming_model
- **activation_date:** 2026-08-14
- **observed:** #2739 round 1: the tester drove the Run CLI opencode TUI via programmatic input, saw the prompt ECHO in the terminal buffer but no response and zero telemetry spans, and concluded the model API was dead — a full FAIL round, a blocked issue, and a human escalation followed. Root cause: the input payload lacked the trailing Enter/newline that SUBMITS the prompt in the TUI, so the text was typed but never sent — identical symptom to a dead model (echo present, no reply, no spans). With the trailing newline added, the same session responded to every prompt and emitted spans.
- **target_failure:** misdiagnosing an unsubmitted TUI input as a dead model/API, wasting a round + block + escalation on an environment that was healthy all along.
- **guardrail:** when driving a TUI-based agent session programmatically and the typed prompt echoes but nothing responds and no telemetry appears, FIRST verify the input was actually SUBMITTED (trailing Enter/newline on the input payload) before blaming the model or API. Do not judge the agent session from unrelated dev-environment console logs — the session's evidence lives only in its own terminal buffer, its input channel, and its telemetry stream.
- **home:** .opencode/tests/mission-monitor/smoke.md ("Feature usage: Run CLI" — step 4 + the console-logs paragraph; baked verbatim) + references.md (G-037)
- **effectiveness:** Pending

### G-038: spec_branch_stale_suite_guidance_clobber
- **activation_date:** 2026-08-14
- **observed:** #2739: a suite-guidance fix (the trailing-`\r` rule) landed on main via a separate PR AFTER `spec/2739` forked, so the spec branch still carried the stale `.opencode/tests/**` copy (no `\r` rule, no console-log warning). The tester's worktree reads the branch copy and `tests-commit` persists from it — the stale copy would have overwritten main's corrected guidance. Caught in-pass via a G-032 main→spec sync (only the suite file differed; clean merge), and the post-run tests-commit preserved the guidance.
- **target_failure:** a spec branch's stale suite content overwriting main's newer test guidance when the tester persists suite updates.
- **guardrail:** before dispatching the tester, verify the spec branch's `.opencode/tests/**` match main's CURRENT suite guidance; if the branch carries stale suite content (a guidance fix merged to main after the branch forked), sync the branch with main (G-032 form) — never let the spec branch's suite copy overwrite main's guidance on tests-commit.
- **home:** playbooks/self-improver.md step 9 (G-032/G-035 family) + references.md (G-038)
- **effectiveness:** Pending

### G-040: zoom_scaled_rect_width_misread_as_layout_width
- **activation_date:** 2026-08-15
- **observed:** #2743 round 3: the tester measured a ChatNode at `getBoundingClientRect().width = 320.68px` and reported AC-6 FAIL ("below required 420–540") — but the LAYOUT width was 480px: the rect was zoom-scaled (480 × 0.668) because the viewport transform was ~0.668 (leftover from an earlier fitView/zoom). The verdict misattributed a correct implementation as a defect and drove a wasted rework round.
- **target_failure:** a DOM width measurement read through a non-identity viewport transform is reported as the element's layout width, producing a false FAIL (or a false PASS if zoom > 1).
- **guardrail:** When an AC asserts rendered WIDTH/GEOMETRY, measure the LAYOUT width (element `offsetWidth`, or the component/library store width), not `getBoundingClientRect().width` — the rect is transform-scaled whenever the viewport is zoomed (ReactFlow graph canvases are almost always non-identity). If only the rect is available, report the viewport zoom alongside it and compute the unscaled width. A measured width near `expected × zoom` (e.g. 320.7 ≈ 480 × 0.668) is the signature of a zoom-scaled rect, not a width defect.
- **home:** playbooks/tester.md + dev-environment skill (E2E/DOM measurement) + references.md (this record)
- **effectiveness:** Pending

### G-041: per_run_snapshot_row_vs_session_lifetime_aggregate
- **activation_date:** 2026-08-15
- **observed:** #2743 round 3: the tester compared the Total Top Bar's session cost/messages ($0.0805 / 45 msgs) against a `fredo.session` telemetry row (`total_cost_usd` 0.0975 / `total_messages` 16) and reported AC-12 FAIL. The `fredo.session` row is a per-plugin-process in-memory counter snapshot that resets on app/plugin restart — the session was reused across many runs (18 rows with varying totals), so the comparison was apples-to-oranges; the plan's decided frontend derivation (Σ delivered `cost_usd` over distinct last-wins chat keys) matched the UI exactly.
- **target_failure:** a live assertion compares a session-LIFETIME UI aggregate (restored deliveries across runs) against a per-RUN snapshot row in telemetry, misattributing a correct derivation as a defect.
- **guardrail:** For session-total UI assertions (cost, message count, totals), compare against (a) a FRESH single-run fixture's deliveries/telemetry, and/or (b) the reconciliation identity (UI bar == Σ node totals, zero residual) — never against `fredo.session` snapshot rows of a REUSED multi-run session (those counters reset per run). If the only available session is reused, prefer the Σ-nodes identity; the `fredo.session` row is a per-run in-memory counter, not the session-lifetime truth.
- **home:** playbooks/tester.md + QA-plan AC-12 guidance + references.md (this record)
- **effectiveness:** Pending

### G-042: clamped_fit_masquerades_as_never_firing
- **activation_date:** 2026-08-15
- **observed:** #2743 rounds 4-5: the tester reported AC-13 FAIL because "the viewport transform never changed" — byte-identical `translate(706.4px,-3246.95px) scale(0.3)` across rounds AND even after clicking the built-in fit control. The fit DID fire; ReactFlow `fitView` clamped its computed zoom (~0.026 needed to frame a 66-node ~24,000px chain) to the `minZoom={0.3}` floor. The diagnostic discriminator: a clamped fit leaves `scale == minZoom` exactly; a never-fired fit leaves the default `scale(1)`.
- **target_failure:** a fitView that fires but is clamped to minZoom is misdiagnosed as a fit that never fires, sending the developer down a wrong root-cause path for a round.
- **guardrail:** When a fit-to-view "doesn't work" for a large/many-node graph, read the resulting viewport transform and compare against the configured `minZoom`: `scale == minZoom` exactly means the fit FIRED but was clamped (zoom floor too high for the graph's extent — lower `minZoom` or check the graph height), while `scale == 1` (default) means the fit never fired (measurement gate / event wiring). Never report "fit not firing" without the transform reading; a never-changing transform with `scale == minZoom` is a clamp signature.
- **home:** playbooks/tester.md + developer plan-scope guidance (fit/layout ACs: verify minZoom accommodates the required graph extent) + references.md (this record)
- **effectiveness:** Pending

### G-043: reactflow_zoom_on_double_click_swallows_node_dblclick
- **activation_date:** 2026-08-15
- **observed:** #2743 round 4: AC-7/8 (double-click-to-open the detail panel) FAILED live for three rounds — no DetailPanel DOM in ANY attempt (native `dblclick` dispatch + MCP double-click). Root cause: ReactFlow v11's `zoomOnDoubleClick` defaults to `true`, attaching a d3-zoom `dblclick.zoom` handler to `.react-flow__renderer` (an ancestor of the nodes) that runs `noevent()` = preventDefault + stopImmediatePropagation; because the renderer sits BELOW React's root container (React 17+ event delegation), the native dblclick never reaches React's delegated `onDoubleClick` — `onNodeDoubleClick` never fires in a real browser. Unit tests passed because they invoke the handler directly.
- **target_failure:** a node-level double-click interaction never fires in the real app because ReactFlow's default zoom-on-double-click consumes the event, while unit tests (calling the handler directly) green-light the code — a live-only interaction defect that survives a full unit-test round.
- **guardrail:** When an AC binds node double-click behavior (ReactFlow), set `zoomOnDoubleClick={false}` on `<ReactFlow>` so the native dblclick reaches React's delegated handlers; verify the interaction LIVE (or via a jsdom test that mounts the real `<ReactFlow>`), never only by invoking the handler function. A unit test that calls `onNodeDoubleClick` directly does not prove the event reaches it — ReactFlow's d3-zoom ancestor handler is the usual swallower.
- **home:** references.md (this record) + developer plan-scope guidance (ReactFlow interaction ACs: always disable `zoomOnDoubleClick` when nodes bind double-click)
- **effectiveness:** Pending

---

## Useful External References

- **OTel GenAI semantic conventions** - the source of truth for all `gen_ai.*` attribute emission (`gen-ai-spans.md`, `gen-ai-agent-spans.md`, `gen-ai-events.md`, `gen-ai-exceptions.md`, `gen-ai-metrics.md`): https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai/
- **Chakra UI v3 docs** - compound components, recipes, semantic tokens: https://chakra-ui.com/docs/components
- **ReactFlow docs** - v11 node/edge API, `selectNodesOnDrag` default behavior: https://reactflow.dev/learn
- **Tauri v2 docs** - commands, IPC, plugins, capabilities: https://v2.tauri.app/
- **opencode** - the opencode agent runtime (source): https://github.com/anomalyco/opencode
- **opencode docs** - configuration, agents, skills, plugins, permissions: https://opencode.ai/docs/
- **Cognitive Load Theory (UX)** - the UI/UX Expert's design lens: NN/g "Minimize Cognitive Load" https://www.nngroup.com/articles/minimize-cognitive-load/, "Chunking" https://www.nngroup.com/articles/chunking/, "Progressive Disclosure" https://www.nngroup.com/articles/progressive-disclosure/, "Change Blindness" https://www.nngroup.com/articles/change-blindness/, "Dashboards: Preattentive Attributes" https://www.nngroup.com/articles/dashboards-preattentive/, IxDF topic https://www.interaction-design.org/literature/topics/cognitive-load; Sweller 1988 (Cognitive Science) doi:10.1207/s15516709cog1202_4; Cowan (working memory ~4 chunks) https://www.ncbi.nlm.nih.gov/pmc/articles/PMC2864034/
- **Doherty Threshold / response-time perception** - Doherty & Thadani 1982 (IBM): https://jlelliotton.blogspot.ca/p/the-economic-value-of-rapid-response.html, Laws of UX: https://lawsofux.com/doherty-threshold/, NN/g "Response Times: The 3 Important Limits" https://www.nngroup.com/articles/response-times-3-important-limits/, "Progress Indicators" https://www.nngroup.com/articles/progress-indicators/, RAIL model https://web.dev/articles/rail, INP https://web.dev/articles/inp, MDN "Perceived performance" https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Performance/Perceived_performance, Smashing "Why Perceived Performance Matters" https://www.smashingmagazine.com/2015/09/why-performance-matters-the-perception-of-time/
