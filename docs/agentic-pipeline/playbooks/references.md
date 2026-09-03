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
### G-092: on_the_go_improvement
- **activation_date:** 2026-09-02
- **observed:** #2788 round 6
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Tool-discipline guardrail (4th stall this spec): the round-6 tester stalled in an unbounded webview-polling loop (malformed arg re-sent dozens of times, never sanity-checked) polling for a UI condition instead of the bounded wait tool — the human stopped the round. The 4-rule tool-discipline block is durable text: (1) poll a running webview only with the timeout-bounded wait tool, never a loop of repeated evaluate calls; (2) never repeat an identical tool call more than 3 times — after 3 unexpected results, record expected-vs-actual as FAIL/UNVERIFIED-with-named-blocker and move to the next leg (an honest FAIL advances the pipeline, a stall does not); (3) sanity-check tool arguments before sending (a malformed argument is a parameter mix-up, not a transient failure); (4) time-box the round — post the verdict with completed legs plus explicit FAIL/UNVERIFIED lines for incomplete ones. Retained guidance that worked this spec: pre-brief environment failures as surface-dont-spelunk with the sanctioned purge named, and pin codebase exemplar file:lines for every copy-existing-pattern decision.
- **home:** docs/agentic-pipeline/playbooks/tester.md (Tool discipline — bounded polling only) + docs/agentic-pipeline/playbooks/developer.md (Tool discipline — bounded retries)
- **effectiveness:** Confirmed (2026-09-02, #2788 round 6 re-dispatch) — the fresh tester session held all four rules (3 bounded waits max, no repeated identical calls, one honest named-blocker sub-leg instead of a loop) and completed the round with a verdict in a single session; the pre-dispatch block also contained a mandated stop condition. One in-spec application; watch on the next testing-heavy spec.



### G-091: on_the_go_improvement
- **activation_date:** 2026-09-02
- **observed:** #2788 round 5
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Stale CI-claim fix: the playbook said GitHub CI was deactivated (merge guard on merge-state alone) but validate.yml is LIVE (repo public) and rust-validate runs cargo check/test --locked + clippy -D warnings — a 4-lint clippy failure reached merge-time on #2788 round 5 because no dev receipt ever ran clippy. Playbook now requires the full local CI-parity set (CONTRIBUTING.md flags) in dev receipts. Harness untouched.
- **home:** references.md (G-091)
- **effectiveness:** Confirmed (2026-09-02, #2788 round 6) — the round-6 developer receipts ran the full CI-parity set (check + test + clippy -D warnings) before push; rust-validate passed at the merge gate on the first post-fix CI run, closing the failure class that cost round 5.

### G-090: on_the_go_improvement
- **activation_date:** 2026-09-02
- **observed:** #2788 round 5
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Machine fix (state machine, SI domain). The Development Summary round stamp was one low on every rework round — the draft flushes at the implementation to testing transition BEFORE the destination testing phase.started append, so the stamp named the round that just ended instead of the round whose work the summary documents (observed on #2788 where the round 3, 4 and 5 summaries posted as rounds 2, 3 and 4). Development Summary now stamps the testing-entry count plus one (a fresh issue still stamps round 1) while Tests Runs and SI Summary keep the raw count because they document the round that is ending. Documented in the same pass at the stamp site and in retry_state. New harness test covers the fresh-issue and rework edges. Full harness green (95 passed).
- **home:** references.md (G-090)
- **effectiveness:** Confirmed (2026-09-02, #2788 round 6) — the round-6 Development Summary and Tests Runs both machine-stamped round 6 correctly on the rework round (previously every retry round stamped one low).






### G-089: on_the_go_improvement
- **activation_date:** 2026-08-31
- **observed:** #2773 round 1
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Docs/config-only specs must NOT gate verification on native builds: the Rust toolchain builds the vendored native inference dependency through CMake/Visual Studio discovery, which the developer sandbox's restricted shell cannot run, so a docs-only spec burned a round on build-environment diagnostics instead of spec work. Verification scope must match the diff surface - build hygiene applies to code changes only, and native-build legs belong only in plans whose diff touches code. Related lessons from the same run: settle git configuration questions with the origin-annotated config query command, never by reading config files (the effective value can come from a config origin invisible to file reads), and never glob, probe, or diagnose outside the repository in the sandbox.
- **home:** references.md (G-089)
- **effectiveness:** Confirmed (2026-08-31, #2773 rounds 1-2) — recorded mid-run and applied immediately: the QA plan was amended to docs-only validations (native-build legs removed, tester briefed to never run them) and the spec completed with zero further build-environment stalls.

### G-080: on_the_go_improvement
- **activation_date:** 2026-08-29
- **observed:** #2768 round 1
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Transition-side tests-commit silently swallowed per-feature failures (a missing QA-seeded suite vanished without a trace). The loop now surfaces a NOT-persisted note per failed feature so brief or QA gaps are visible at plan assembly instead of mid-testing round
- **home:** references.md (G-080)
- **effectiveness:** Pending





### G-072: on_the_go_improvement
- **activation_date:** 2026-08-28
- **observed:** #2762 round 7
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** The OTLP fixture injector burned rounds 3-7 on a manufactured success signature (architect diagnosis, G-072). Three tooling defects: the Resource field was under-nested one message level so tonic rejected every request BEFORE the receiver handler (no log pair, no insert), the export receipt hardcoded OK (grpc-status 0) because trailers-only rejections ride the response HEADERS which Node http2 never delivers as trailers, and span attributes were collapsed into one length-delimited record so session.id was destroyed. Fixed all three in inject-otlp-fixture.ts (commit 52c1670) and validated live: both exports persisted with the exact printed hexes plus two adjacent span_count 1 receiver-log pairs. Lesson: a receipt that prints a constant is not evidence — read the status from the wire, and validate hand-rolled wire encodings against a real decode before trusting them.
- **home:** references.md (G-072)
- **effectiveness:** **Confirmed** (2026-08-28, #2762 round 7) — the post-fix injection persisted both spans with the exact printed hexes, session ids derived from the resource attributes, and two adjacent single-span receiver-log pairs; the QA-6 two-row gate passed on the next leg and the orphan-canvas assertions completed.


### G-071: on_the_go_improvement
- **activation_date:** 2026-08-28
- **observed:** #2762 round 7
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** process-hygiene.ps1 orphan kill classified the LIVE Vite :5174 port owner as an orphan and killed it mid-round (#2762 round 7), severing the webview. A detached dev launcher exits immediately so the serving tree reads as a dead tree by ancestry, and Vite is a SIBLING of fredo.exe so the fredo-ancestor protection never covered it. Fixed by anchoring Test-Protected on pinned-port ownership (owner + ancestor + descendant trees are protected, stale port owners remain dev-env Down's job). Validated: test-scripts.ps1 93/93 plus live -List smoke (0 unprotected orphans, fredo tree protected).
- **home:** references.md (G-071)
- **effectiveness:** **Confirmed** (2026-08-28, #2762 round 7) — the same round's later opt-in kill pass reported 14 orphans found, 0 killed, 14 protected with the serving tree (fredo + Vite + their MCP children) fully intact through the rest of the round including a restart cycle; the pre-fix kill had severed the webview instantly.

### G-073: fixture_completion_judged_from_the_wrong_signal
- **activation_date:** 2026-08-28
- **observed:** #2762 rounds 6-7 — FIX-WIDE completed in the telemetry store twice (≈58s wall-clock, exact plan shape) while consecutive tester legs recorded it as stalled/never-completed
- **target_failure:** a live fixture's completion is gated on a surface signal (PTY completion marker, spinner absence, fixed wall-clock window) while the authoritative store already holds the completed inventory — rounds burn re-driving fixtures that succeeded, and "stall" blockers get recorded without checking the store
- **guardrail:** Gate live-fixture completion on the telemetry store (the session's idle record plus a completed session span with a non-null end), never on the PTY marker alone (the marker is printed by the root turn, which a queued second prompt keeps alive) and never on a bare newest-N log window (dense plugin flush traffic scrolls single-span pairs out within seconds — anchor receipt windows with BETWEEN at the event timestamp). Every "stall" claim must be paired with a store completion query before it is recorded as a blocker.
- **home:** playbooks/tester.md (fixture drive discipline) + references.md (G-073)
- **effectiveness:** Pending

### G-074: midflight_prompt_steering_contaminates_the_fixture_session
- **activation_date:** 2026-08-28
- **observed:** #2762 round 7 — a second fixture prompt submitted while the first turn was in flight queued INTO the same conversation (both prompts landed in one session), permanently contaminating that session for the isolation-sensitive assertion and swallowing the first fixture's completion marker; two legs burned
- **target_failure:** a Run CLI-style session accepts additional prompts while a turn is in flight, so a second fixture submitted before the first completes steers the SAME session — fixtures silently share a root identity and isolation-sensitive assertions (pure-internal vs mixed) become unassertable
- **guardrail:** One fixture per launch. Between fixtures, close the terminal and relaunch (verify the window is gone from the window list, then verify the relaunched terminal), and treat the new root's session identity as a hard gate — if the observed root matches a prior fixture's root, STOP before asserting. Assert DOM state only on COMPLETED sessions whose telemetry agrees at the same instant (a session whose first spans have not yet landed legitimately renders an empty graph — zero nodes plus zero landed spans is expected, zero nodes plus landed spans is a new signature).
- **home:** playbooks/tester.md (fixture drive discipline) + references.md (G-074)
- **effectiveness:** Pending

### G-075: fixture_recipe_prescribes_unreachable_observables
- **activation_date:** 2026-08-28
- **observed:** #2762 rounds 6-7 — the FIX-INTERNAL recipe asked a prompt to make the default tool-execution agent spawn internal child sessions; tool execution is in-session and the internal agent class cannot be commanded into existence by prompt text, so the fixture could never satisfy its own gate while legs kept driving it
- **target_failure:** a fixture recipe's mechanism is assumed possible without verifying the system's actual spawn/dispatch semantics — rounds burn driving a fixture whose observables are unreachable, when the plan's own recipe elsewhere already authorizes the achievable equivalent
- **guardrail:** Before any live fixture leg, verify the recipe's mechanism against the system's real semantics (what can a prompt actually cause here? does the driving agent have the capability the recipe assumes?) and check the plan for an already-authorized equivalent evidence path (e.g., a no-separate-run recipe note). If the mechanism is unreachable, stop prescribing its drive and use the authorized equivalent — recording the rationale on the timeline.
- **home:** playbooks/tester.md (fixture drive discipline) + references.md (G-075)
- **effectiveness:** Pending

### G-076: fixture_receipts_keyed_on_invented_labels
- **activation_date:** 2026-08-28
- **observed:** #2764 rounds 1-3 — the QA plan prescribed receipts matching sessions by a plan-invented label (a LIKE query on the label as the session id), but Run CLI drives real agent sessions whose ids are minted by the agent provider, so no session ever carries the label and every receipt returned zero rows; a later round also missed that a continued session is titled by its FIRST prompt, not by a marker typed into a later turn, so a successful dispatch was reported as never-happened
- **target_failure:** fixture receipts are keyed on an invented label that no real session can carry (or on a marker that cannot appear where the query looks) — every live receipt returns empty, all ACs go UNVERIFIED, and rounds burn re-driving fixtures that actually succeeded
- **guardrail:** Run CLI cannot name sessions. Every live fixture must embed a UNIQUE marker in the session's FIRST user prompt (the prompt persists verbatim as a span attribute AND titles the session in the history list), resolve the real session id by querying spans for that marker content, then run exact-match receipts on the resolved id. Markers NEVER propagate to child/subagent sessions — join parent to child via the parent's task-span child-session attribute and the child's parent-relationship attribute. A session continued with a later prompt is found by its first prompt only. A receipt query keyed on a label-as-id is a plan defect, not a product failure — diagnose it before the first re-drive.
- **home:** playbooks/tester.md (fixture drive discipline) + references.md (G-076)
- **effectiveness:** Pending

### G-077: synthetic_fixtures_routed_through_unsubscribed_transports
- **activation_date:** 2026-08-28
- **observed:** #2764 round 3 — a synthetic missing-details fixture was injected via the mock-event emitter, but the feature's event contracts subscribe to a single transport (OTLP gRPC only) and mock events ride the hook transport, so nothing reached the feature and the synthetic session never appeared; round 5 confirmed the fix: the same fixture injected through the REAL OTLP receiver (protobuf-encoded, posted to the HTTP receiver port) arrived tagged as the subscribed transport and rendered live
- **target_failure:** a synthetic test fixture is injected through a transport the feature does not subscribe to (or in an encoding that arrives tagged as a different transport) — the feature silently never sees it, the leg burns as UNVERIFIED, and the transport mismatch is misread as a product defect
- **guardrail:** Before injecting any synthetic fixture, verify the feature's declared transport subscription AND the transport tag the receiving pipeline stamps on each ingestion encoding — mock-event emitters feed one transport; wire encodings matter (a JSON post to the OTLP HTTP port arrives tagged as HTTP, only protobuf arrives tagged as gRPC). Inject through the subscribed transport with a conforming encoding, mark the row as synthetic-fixture evidence, and keep live receipts carried by the other rows. If the ingestion executor is outside the tester's sandbox, the orchestrator executes it as environment prep and the tester verifies the UI.
- **home:** playbooks/tester.md (fixture drive discipline) + references.md (G-077)
- **effectiveness:** **Confirmed** (2026-08-28, #2764 round 5) — the protobuf-encoded synthetic fixture posted through the real OTLP receiver rendered a live session in the feature, the absent-state AC passed on its visual evidence, and the receipt matched the injected spans exactly.

### G-078: pending_draft_flush_refused_without_author_footer
- **activation_date:** 2026-08-28
- **observed:** #2764 round 1 — the orchestrator's manual flush of the tester's verdict draft was refused by the anti-spoofing gate because the draft lacked its author footer; the gate is silent in the skill's action table, so the refusal read as a flow error until diagnosed. (A related slip: the orchestrator deleted the pending FAIL draft before realizing transitions auto-flush pending drafts onto the timeline, and had to restore it verbatim.)
- **target_failure:** a pending timeline draft without its author footer is refused at flush (or a draft is manually deleted when a transition would have consumed it), stalling the loop and risking a verdict missing from the record
- **guardrail:** Every draft destined for the timeline (verdicts, summaries, plans) must end with its author footer line — the flush gate refuses unattributed drafts. Orchestrators never delete pending drafts under the issue's tmp folder: transitions own their consumption and posting (with machine round stamps); flush pending verdict drafts manually only when a transition guard requires the comment to already exist, and hold aside other pending drafts during a manual flush so each posts through its intended channel.
- **home:** playbooks/self-improver.md (draft-flush discipline) + references.md (G-078)
- **effectiveness:** Confirmed — re-validated in #2770 round 6 (2026-08-31): the developer's dev-summary draft lacked its footer and was refused at BOTH flush attempts (the testing re-entry transition and the tester's manual flush) — an unattributed draft never reached the timeline. Residual friction (the draft stays stranded until the author fixes it) is playbook guidance for the developer, not a gate gap.

### G-079: fixture_session_zero_spans_incomplete_or_self_matched
- **activation_date:** 2026-08-28
- **observed:** #2766 round 1 — the Run CLI fixture session produced zero queryable telemetry spans and every live AC went UNVERIFIED, despite a cold-started instance and a correct serving commit. Two compounding causes: (a) the fixture session never established COMPLETION within the evidence window (the plugin flushes span data on session idle/completion events — an unfinished session has nothing queryable), and the prompt may have been typed into a not-yet-ready TUI; (b) the bare marker-content query matched the TESTER'S OWN session (the marker string appears in the driver's own tool arguments and session prompt), so the one receipt returned was a false positive. A related environment trap from the same round: the OTEL env vars that make Run CLI children emit telemetry are injected only on a cold start of the dev instance — a fast-path start warns but does not inject, and a stale-env instance emits nothing regardless of fixture discipline.
- **target_failure:** a fixture round whose marker receipts come back empty (or worse, resolve to the driver's own session) — burning a full tester round on an evidence-technique failure that looks like a product or environment defect.
- **guardrail:** For any marker-driven fixture round: (1) confirm the dev instance was COLD-started (a fast-path start that skipped env injection must be replaced by a full stop then start) before driving fixtures; (2) wait for the agent TUI's input prompt to be ready before submitting the prompt; (3) instruct the fixture agent to end with a literal completion marker and verify BOTH the marker appearing and the session's span-tree max-timestamp stabilizing across two polls at least a minute apart before querying receipts; (4) in every marker query, first resolve and EXCLUDE the driver's own session id, wall-clock bound the lookup, and require the discriminator that the matching session owns a prompt-bearing session span (a marker hit inside tool-argument attributes of an unrelated session is not a receipt). When a completed historical session exists that already exercises the AC, reconcile against it instead of re-driving a fresh fixture.
- **home:** playbooks/tester.md (fixture drive discipline) + playbooks/self-improver.md (environment prep) + references.md (G-079)
- **effectiveness:** **Confirmed** (2026-08-28, #2766 round 2) — the corrected procedure (cold restart, TUI-ready wait, completion-marker + span-stability verification, own-session exclusion, prompt-span discriminator) produced a fully receipted fresh fixture on the first attempt and the historical-reconciliation path cleared the remaining ACs in the same round; the round-1 blocker never reappeared.

### G-080: oversized_live_fixture_burns_provider_budget
- **activation_date:** 2026-08-29
- **observed:** #2768 verification — under provider-quota-window pressure, the SI designed a MEGA-fixture (10 sequential subagents x 100 echo tool calls each, ~25 min): every tool call costs an LLM turn (the subagent thinks before each call), so the fixture approached ~1,000 LLM turns to verify ACs (attribution, persistence, hydration) whose logic is volume-independent. The human saw the drive script and killed it mid-run (fixture processes terminated at the root). The #2762-fixed span injector — which produces realistic delegation-tree span shapes through the REAL OTLP receiver at ZERO token cost — was available and validated, but the SI chose live provider drives for every leg anyway.
- **target_failure:** verification fixtures that consume provider budget out of proportion to the evidence they produce — wasting money, exhausting quota windows, and (paradoxically) forcing even bigger single fixtures to "make the window count".
- **guardrail:** Fixtures are REAL Run CLI drives (the human explicitly rejected span injection: real end-to-end evidence through `apps/ui/src/features/run-cli/` only), MINIMAL viable volume: the smallest session tree that exercises the AC (parent + 1-2 subagents, 1-2 tool calls each). Select a FREE model in the Run CLI (Muse Spark 1.2 Free) so real drives cost ~nothing; never leave the default paid model selected. A fixture costing more than a handful of LLM turns per session requires explicit SI + human sign-off BEFORE driving. Quota pressure justifies SMALLER fixtures, never larger ones. The span injector is FALLBACK ONLY — for span shapes a live drive cannot produce (e.g. legacy-format regression checks), and never the primary evidence path.
- **home:** playbooks/tester.md (fixture cost ceiling) + references.md (G-080)
- **effectiveness:** **Confirmed** (2026-08-30, #2768 round 2) — the human-amended doctrine (real Run CLI drives only, Muse Spark 1.2 Free selected in the Run CLI UI, minimal trees, historical reconciliation FIRST) produced the full round-2 verdict on exactly 2 real drives (~13 LLM turns total, free model, zero provider cost) plus zero-fixture historical/retention legs. The pre-amendment mega-fixture plan (10 subagents x 100 echoes) was never re-attempted; the F4J debris tree was reconciled at zero drives instead of re-driven.

### G-081: orchestrator_detached_fixture_launch_fails_silently
- **activation_date:** 2026-08-30
- **observed:** #2768 testing — four consecutive orchestrator-owned detached fixture launches failed silently or misleadingly: F4 stalled mid-flight (glob subagent never dispatched), F4C and F4G exited instantly producing zero spans, zero output files, and no error trace (the claimed pid did not exist in the process inventory), and F4J ran wildly over budget before the human killed it — while the orchestrator dispatched the tester each time believing the launch had succeeded. The tester re-derived the absence forensics three separate times.
- **target_failure:** an orchestrator-owned background fixture launch that reports success (spawn returned, dispatch proceeded) while the fixture never started or died instantly — burning a full tester round on evidence-of-absence forensics.
- **guardrail:** An orchestrator-owned fixture launch is not RUNNING until a CONFIRM-STARTED gate passes: the process is visible in the process inventory AND the first marker span appears in the telemetry store (query echo excluded) AND a stdout/stderr redirect file was created at launch time with the driver's pid as its first line. Prefer eliminating the detached-launch class entirely by having the tester drive fixtures through the Run CLI UI (the amended fixture doctrine) — the class cannot recur for tester-driven drives.
- **home:** playbooks/self-improver.md (step 9 environment prep) + references.md (G-081)
- **effectiveness:** Pending — codified after #2768; round 2 eliminated the class by moving to tester-driven Run CLI drives (zero detached launches attempted).

### G-082: dev_env_fast_path_skips_telemetry_env_injection
- **activation_date:** 2026-08-30
- **observed:** #2768 round 2 — the dev-env Up fast-path exit does not inject the OPENCODE_* OTEL environment variables (they are guaranteed only on a COLD start), so a telemetry-dependent verification leg driven against a fast-path instance can emit zero spans; the round's early span-flow check consumed part of the drive-1 dance window.
- **target_failure:** a verification leg that depends on telemetry emission runs against a fast-path instance whose OTEL env injection was skipped, producing zero-span fixtures that read as emission-path defects.
- **guardrail:** Any verification leg that depends on telemetry emission must either cold-start the dev environment (Down, then Up) or assert the first fixture span flowed into the telemetry store BEFORE executing the timed portion of the dance; a zero-span result is environment-triaged first (env injection, plugin currency, receiver path) before any product conclusion.
- **home:** .opencode/skills/dev-environment/SKILL.md (env-injection prerequisite) + references.md (G-082)
- **effectiveness:** Pending — the span-flow liveness check was applied in #2768 round 2 and caught the precondition before evidence was burned.

### G-083: fixture_prompt_uses_posix_sleep_on_windows
- **activation_date:** 2026-08-30
- **observed:** #2768 round 2 drive 2 — the fixture prompt told a subagent to run `sleep 20` to space the timeline for a close-timed dance; PowerShell has no `sleep`, the command failed in 8 ms, and the whole tree completed in 19 seconds BEFORE the Mission Monitor close — the sixth consecutive unexercised closed-window leg.
- **target_failure:** a fixture prompt authored with POSIX assumptions on a Windows PowerShell host fails silently in milliseconds, collapsing spaced-out fixture timelines and voiding close-timed dance legs.
- **guardrail:** Fixture prompts executed on a Windows host must use the host-native wait form (PowerShell Start-Sleep with a Seconds parameter), placed INSIDE the subagent's tool call so the wall-clock spacing actually occurs between dispatches; verify the spacing took effect via the fixture's own output timestamps before executing a close-timed dance.
- **home:** .opencode/tests/event-persistence/exploratory.md (E-3, baked by the tester) + references.md (G-083)
- **effectiveness:** Pending — codified after #2768; the close-out technique is queued for the next pipeline-touching verification round.









### G-070: on_the_go_improvement
- **activation_date:** 2026-08-27
- **observed:** #2760 round 1
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** dev-env.ps1 was unrunnable under Windows PowerShell 5.1 on DBCS-locale machines: UTF-8 em-dash and box-drawing characters inside strings were misparsed as codepage byte pairs that swallowed quotes (parse errors), Get-Date -AsUTC is PS7-only, and native stderr redirects (git fetch with stderr redirected) became terminating NativeCommandErrors under ErrorActionPreference Stop. Fixed: ASCII-only string content, ToUniversalTime() ISO stamp, and an Invoke-NativeQuiet helper that runs native calls stderr-tolerant and surfaces only the exit code. Validated by test-scripts.ps1 91/91. This blocked the G-052 serving bring-up mid-flight and would have re-wedged every future round.
- **home:** references.md (G-070)
- **effectiveness:** **Confirmed** (2026-08-27, #2760 round 2) \u2014 the fix was applied mid-run and immediately unblocked the G-052 serving bring-up: the Up flow completed (dedicated serving worktree reset to spec tip, serving record written, both ports ready) and the round-2 tester ran against a conforming environment. Previously the harness could not even parse, so the serving leg was impossible.










### G-067: on_the_go_improvement
- **activation_date:** 2026-08-27
- **observed:** #2758 round 16
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** Recurring tauri-driver/MCP webview staleness (resolveRef is not a function) consumed the live evidence window in 7+ rounds of issue 2758 and became reproducible even after full Down-Up restarts, so recovery ladders and narrowed scope could not fix that layer. Orchestrators must count occurrences per round, stop at the third strike without partial captures, escalate as a tooling hard-blocker via block plus Status (not re-dispatch), and treat driver/bridge stability as human-owned infrastructure outside spec scope
- **ROOT CAUSE (found 2026-08-26 repair):** the MCP server injects the `window.__MCP__` helper namespace (including `resolveRef`) into the webview ONCE per driver session at init; a Vite HMR reload or app restart wipes it and it is never re-injected on the surviving session. The wedge is tooling session state, not app health — a clean driver-session stop/start re-injects it (verified live), and injecting into a still-bootstrapping Vite page gets wiped again. Full remediation ladder + preflight probe live in the dev-environment skill (MCP driver-session staleness section).
- **home:** references.md (G-067) + .opencode/skills/dev-environment/SKILL.md (MCP driver-session staleness) + playbooks/tester.md (preflight probe)
- **effectiveness:** Confirmed — clean session restart restored resolveRef on a healthy app (2026-08-26); re-validated in the #2758 repair aftermath (2026-08-27): probe-first discipline ran across rounds 17-26 of #2758 with only two transient occurrences, each recovered by exactly ONE driver stop/start, and no three-strike escalation ever recurred. Re-validated in #2762 round 7 (2026-08-28): the probe-before-ref-tools preflight passed on the first probe in most legs and recovered with exactly one driver restart where it did not; the new open-Mission-Monitor-before-fixtures ordering (ECE contracts register only at mount) was added to the tester playbook preflight and held for the rest of the round.


### G-066: on_the_go_improvement
- **activation_date:** 2026-08-26
- **observed:** #2758 round 2
- **target_failure:** (on-the-go pipeline improvement)
- **guardrail:** G-009 recurrence: orchestrator dispatch briefs pointed at out-of-repo paths (~/.config/opencode/plugins/fredo.js), causing a tester sandbox stall - briefs must reference skill recipes (dev-environment/telemetry-query), never raw out-of-repo paths
- **home:** references.md (G-066)
- **effectiveness:** Partial — the brief-author vector was fully suppressed in #2758's late cycle (roughly fifteen consecutive dispatch briefs referenced skill recipes by name only, zero out-of-repo mentions or stalls); marked Partial rather than Confirmed because the improvement window covers a single issue so far

### G-068: phantom_comparison_baseline_prescribed_without_materialization
- **activation_date:** 2026-08-27
- **observed:** #2758 rounds 9-24: the Chain-parity leg prescribed an offline pixel comparison against a "recorded baseline fixture image" for over ten consecutive rounds — but no such artifact had ever been materialized in the evidence store, every capture attempt failed before producing it, and roughly twelve rounds burned chasing a phantom before an orchestrator-level timeline investigation proved the fixture never existed
- **target_failure:** a Fix Plan (or QA plan) prescribes comparing live captures against a recorded fixture artifact without first verifying that artifact actually exists in the evidence inventory — rounds are then burned repeatedly trying to satisfy a comparison whose reference side can never resolve
- **guardrail:** Before authoring any Fix Scope leg whose verification compares against a recorded fixture/baseline/snapshot, the author MUST verify the referenced artifact exists in the evidence inventory (or create-and-commit it as an explicit capsule step in the same plan). When the comparison premise proves unsatisfiable, stop prescribing its capture and formally replace the observable with the strongest achievable equivalent — recording the substitution rationale on the timeline instead of silently re-issuing the same doomed leg
- **home:** playbooks/software-architect.md (Fix Plan authoring rules) + references.md (G-068)
- **effectiveness:** Pending

### G-069: round_brief_carries_superseded_fixture_wording
- **activation_date:** 2026-08-27
- **observed:** #2758 rounds 23-25: testing kept failing a visual leg because the plan-era wording demanded a cross-session fixture while the pipeline had long since adjudicated (during rounds 13-16 of the same issue) that the correct attribution model was per-exchange clusters within one session; each new round inherited the stale demand until the orchestrator quoted the adjudicated model verbatim and the leg passed immediately
- **target_failure:** retry-round briefs repeat an older wording of a requirement that has since been re-scoped/adjudicated on the same issue timeline, so testers honestly fail legs against definitions that are no longer operative
- **guardrail:** When authoring a retry-round brief, state every decision-bearing definition VERBATIM from its latest adjudication source and explicitly mark any earlier wording SUPERSEDED (naming where the adjudication lives). Never leave a decision-bearing term ambiguous when a prior round failed against a different reading of it
- **home:** playbooks/self-improver.md (retry-dispatch briefs) + playbooks/software-architect.md (Fix Plan definitions) + references.md (G-069)
- **effectiveness:** **Confirmed** (2026-08-28, #2762 round 7) — a harness model change (the serving worktree replaced by the repo root) left older posted plans carrying dead paths, a deleted workdir value, a removed flag, and a renamed settings table; multiple tester legs followed the stale wording (hygiene invocations against the dead path, wrong-table queries) until the orchestrator briefs translated every legacy path/flag explicitly and stated which posted-plan lines were superseded. Both failure modes confirmed live: un-marked stale wording misleads, verbatim translation fixes it immediately.























### G-052: stale_serving_worktree_defeats_frontend_verification
- **activation_date:** 2026-08-17
- **observed:** #2750 testing rounds 5-6: the SI left the main worktree on `spec/2750` at a STALE commit (pre-round-6-fix tip) after the G-032 sync, and `pnpm dev:tauri` serves the frontend from that worktree — so the Vite dev server served the round-1 frontend (with the anchorless-first-turn AC4 bug) for two consecutive tester rounds. Round-6's AC4 FAIL (0 subagentNodes) was a stale-build artifact, NOT a product failure: the round-6 fix (627f407) was never exercised live; only after re-syncing the serving worktree to `origin/spec/2750` and restarting dev-env did round 7 pass AC4. The tester's own builds (unit tests, `pnpm build`) were green the whole time — the wrong SERVED bundle was the wedge.
- **target_failure:** a frontend fix that is verified green by unit tests on the spec branch is never exercised live because the dev server's serving checkout lags the spec tip — producing false FAILs (or a false PASS that masks a regression) and burning tester rounds.
- **guardrail:** Build currency (G-047) applies to the SERVED frontend, not only the installed plugin. The repo root IS the serving checkout (simplified 2026-08-28 — the per-spec `.serve/<N>` worktree + `serving.json` were removed as over-engineering): during implementation/testing the root must sit on `spec/<N>` at the origin tip (G-032 form: `git checkout -B spec/<N> origin/spec/<N>`, then merge main's tip SHA and push). `dev-env.ps1 -Action Up -Spec <N>` verifies root branch + HEAD against the origin tip fail-closed before starting, and the machine's testing-entry guard re-verifies the same currency — a wrong-branch or stale root can never reach the tester. The tester's verdict Environment section must state the served commit; a round that does not is untrustworthy for frontend-only specs.
- **home:** playbooks/self-improver.md (step 9 — root currency before tester dispatch) + playbooks/tester.md (serving-currency preflight) + references.md (G-052)
- **effectiveness:** Confirmed — applied at every environment handoff in #2758's late cycle (2026-08-27): the serving drift was caught and re-drilled before each tester dispatch, and no stale-serving round occurred. Re-confirmed as a live failure mode in #2760 round 1 (2026-08-27): no serving checkout existed and a stale pre-change instance held the ports — the tester drove it and produced a false all-AC FAIL against code verified correct at the spec tip; the round-2 remediation eliminated the wedge and round 2 passed in one pass. The worktree-era known gap (guard gated the transition, not the tester's environment) is closed by the root model: the guard verifies the very checkout the app is served from. Root-currency enforcement landed on main 2026-08-28 (91/91 suite) after the human rejected the serving-worktree indirection as unnecessary complexity. Re-validated through #2762's entire round 7 (2026-08-28): the root-currency Up/Status guards ran at every environment handoff across ten-plus tester dispatches with zero stale-serving rounds — and the one serving-currency failure in the round was a self-inflicted hygiene kill, not currency drift. Re-validated across #2764's five testing entries (2026-08-28): the G-032 reset + main-tip merge + push + dev-env Up cycle ran before every tester dispatch (including after mid-run main movement from tests-commit transitions), every round's environment section stated the served commit, and zero stale-serving rounds occurred. Re-validated across #2766's two testing entries (2026-08-28): same cycle including after mid-run tests-commit main movement; every round's environment section stated the served commit and zero stale-serving rounds occurred (round 1's wedge was emission/completion discipline, not serving drift). Re-validated in #2768 round 2 (2026-08-30): the wake began with a root-currency check (dev-env Up fail-closed, serving `spec/2768` at the origin tip) and the verdict's caveats state the served commit plus a zero-product-code-delta proof when evidence-only commits advanced the tip mid-round.

### G-053: tester_unverified_round_without_named_blocker
- **activation_date:** 2026-08-17
- **observed:** #2750 testing rounds 1-4: four consecutive tester FAIL rounds returned AC rows marked UNVERIFIED with NO named blocker — the required live fixtures (subagent-dispatch session, mixed-outcome exchange) were simply never created, and the reports ended with generic "test execution gap" phrasing instead of an actionable diagnosis. Rounds 1-3 burned on this before round 5 finally produced number-backed findings. The recurring pattern cost the pipeline four rounds of near-empty evidence.
- **target_failure:** a tester round that returns FAIL with ACs UNVERIFIED and no named, actionable blocker (fixture not creatable, environment wedge, tool denied) — which cannot be routed to a fix and stalls the loop.
- **guardrail:** A tester verdict row marked UNVERIFIED must be paired with an explicit named reason for why the verification was not completed (specific blocker, tool failure, environment wedge, or data absence — with the exact command/query attempted). A FAIL round whose UNVERIFIED rows carry no named blocker is rejected by the SI at review and returned to the tester for a named diagnosis before any implementation loop. When the same fixture requirement is missed in consecutive rounds, change the EVIDENCE STRATEGY (e.g. reconcile persisted/telemetry sessions instead of requiring fresh live launches) rather than re-issuing the same brief.
- **home:** playbooks/tester.md (add named-blocker rule for UNVERIFIED rows) + playbooks/self-improver.md (loop review — add UNVERIFIED-without-blocker rejection) + references.md (G-053)
- **effectiveness:** Confirmed — every FAIL verdict in #2758's late cycle (rounds 16-25) carried named, actionable blockers and the evidence-strategy-shift doctrine was successfully applied twice (ingestion-delta reconciliation; deterministic capsule replacing a phantom baseline), each shift immediately converting starved legs into receipts. Re-validated in #2762 round 7 (2026-08-28): all nine FAIL drafts named their blockers, and the decisive pass came from an evidence-strategy shift (asserting the pre-authorized recipe equivalent on completed store sessions instead of re-driving a redundant fixture through a flaky lifecycle) — consistent with G-073/G-075. Re-validated across #2764 rounds 1-5 (2026-08-28): every FAIL round's UNVERIFIED rows carried named, actionable blockers, and four consecutive evidence-strategy shifts (marker-token session resolution → persisted-session interaction → real-transport synthetic ingestion → orchestrator-executed fixture) converted starved legs into receipts — the strategy-change doctrine was the sole driver of progress; zero product defects existed in any round. Re-validated in #2766 (2026-08-28): the round-1 FAIL named its blocker precisely (fixture completion never established; receipt false-positive), and the one-shot evidence-strategy shift to historical-session reconciliation (with fresh fixtures under a corrected completion-verification procedure as backup) converted every starved AC into a receipted PASS in round 2. Re-validated in #2768 round 2 (2026-08-30): both residual verdict rows (AC3 closed-window component, NFR-HOTP p95 depth) carry named, actionable blockers with a concrete close-out technique queued in the event-persistence suite, and the directive-mandated historical-reconciliation-first step (killed-run F4J) was executed at zero drives before any new fixture.

### G-054: tester_redispatch_without_transition_misstamps_round
- **activation_date:** 2026-08-17
- **observed:** #2750 round 5: after the round-4 FAIL, the SI re-dispatched the tester directly (no `testing → implementation → testing` transition), so the machine stamped the new comment "round 4" again — two round-4 comments on the timeline, and the round-aware verification guard could not distinguish them. The round advances ONLY via a re-entry into the testing phase.
- **target_failure:** a re-dispatched tester after a FAIL verdict posts under a stale round number because the orchestrator skipped the transition cycle — corrupting the round-stamped evidence record the audit gate parses.
- **guardrail:** After any FAIL tester verdict, the round advances only by transitioning `testing → implementation → testing` before re-dispatching the tester (the transition posts the next round's Fix Plan and re-enters testing). Never dispatch a tester "manually" while still in the prior testing entry; verify the machine's round stamp in the resulting `## Tests Runs (round N)` header matches the intended retry round. **The rule covers EVERY transition between implementing and testing agents, not only post-FAIL loops:** after a developer (or any implementing agent) pushes its capsule, the SI must run the outgoing transition (e.g. `implementation → testing`) IMMEDIATELY, BEFORE dispatching the next agent — a dispatch sent while the machine still records the prior phase produces a G-020 verdict block, a draft re-flush duplicate, and a mis-derived round.
- **home:** playbooks/self-improver.md (step 9/loop — add transition-before-redispatch rule) + references.md (G-054)
- **effectiveness:** Partial — re-validated across #2758/#2764/#2766/#2768 (zero mis-stamped rounds through transition cycles), but RECURRED in #2770 round 5 (2026-08-30): after the developer pushed FS-D1, the SI dispatched the round-5 tester WITHOUT running `implementation → testing` first — the tester's post-comments was G-020-refused (machine derived round 4), the still-on-disk fix-plan draft re-flushed as a duplicate machine-stamped Fix Plan comment, and the verdict held until the missed transition ran and a manual flush followed. Rule strengthened to cover all implementing→testing handoffs; secondary machine-hardening candidate (record phase entry BEFORE flushing verdict drafts in transition side-effects, so the round derives from the new phase count). #2792 (2026-09-02): the round-2 verdict was posted only after a proper `testing → implementation → testing` re-entry (the round-1 within-round amend attempt was G-020-refused — the guard catching the mismatch) and the `## Tests Runs (round 2)` header stamped correctly; mark Partial→Confirmed-track (still one recurrence on record).

### G-046: tester_all_live_unverified_is_environment_wedge
- **activation_date:** 2026-08-17
- **observed:** #2745 testing rounds 2-4: three consecutive tester FAILs where AC-1..AC-4 were ALL UNVERIFIED/FAIL while AC-5 (static build/unit/cleanup) PASSED and the console was clean — Mission Monitor failed to mount after clean DB + dev-env restart, and the native Run CLI stalled at "Starting OpenCode…". Dev-env logs showed `[MCP][WS_SERVER][ERROR] WebSocket connection error: Handshake not finished` — a wedged MCP bridge blocking both `install_plugin` (an MCP command) and Run CLI. Recovery: a full `dev-env.ps1 -Action Down` (kills the process tree holding :9223/:5174) → `-Action Up` restored the clean WS handshake; `clean-fredo-db.ps1 -Restart` alone did NOT clear it.
- **target_failure:** a tester FAIL whose live ACs are ALL UNVERIFIED (with static ACs PASS and no console errors) is misattributed to the spec and loops back to implementation, when the root cause is a wedged dev-environment MCP bridge.
- **guardrail:** When a tester round reports ALL live ACs UNVERIFIED/FAIL with the static ACs PASS and no frontend console errors, treat it as an environment wedge FIRST, not a spec defect: check `dev-env.ps1 -Action Logs` for `[MCP][WS_SERVER][ERROR]` / `Handshake not finished`; clear it with a full Down → Up (NOT just `clean-fredo-db.ps1 -Restart`), verify the clean handshake log line, then re-dispatch the tester. Do NOT loop back to implementation on an all-UNVERIFIED-with-AC5-PASS round. (Round 5 showed the same signature with zero `telemetry_spans` rows — an emission-path gap, also environment-triage first: verify the telemetry env var is set in the tester's own shell, then plugin currency, then the receiver→DB write path, before blaming the spec.)
- **home:** playbooks/self-improver.md (step 9 recovery + this record) + dev-environment skill (Down→Up recovery) + references.md (G-046)
- **effectiveness:** **Confirmed** (2026-08-28, #2766 round 1) — the all-live-UNVERIFIED + clean-console FAIL was triaged as an environment/evidence wedge FIRST (not looped to implementation as a suspected product defect); the dispatched diagnosis confirmed the environment class and the frontend fix was never blamed, and round 2 passed in one pass after environment remediation.

### G-047: installed_plugin_stale_defeats_live_verification
- **activation_date:** 2026-08-17
- **observed:** #2745 testing rounds 2-6: the INSTALLED `~/.config/opencode/plugins/fredo.js` repeatedly lagged the spec branch's plugin fixes — after the R-3 child-parent fix (`6c813cd`) was on the branch with 58/58 unit tests, the installed file still lacked `resolveParentSessionId`, so live runs produced NULL `child_*` attrs / zero `telemetry_spans` rows despite a clean environment and the telemetry env var enabled. The plugin is installed via the app's native path (SetupWizard / `install_plugin` MCP command — NOT a filesystem copy), and it must be REBUILT from the spec branch tip before installing; `Test-Path` proves presence, not currency.
- **target_failure:** a plugin fix verified green by unit tests on the spec branch is never exercised live because the installed plugin is a stale build, producing zero/NULL telemetry and false FAILs (or the reverse — a round that would pass on the fixed plugin failing on the stale one).
- **guardrail:** Before any live opencode run, verify the INSTALLED plugin carries the spec's fix, not just that the file exists: rebuild the plugin from the spec branch tip (`bun build src/index.ts --outdir dist --target bun` in `apps/opencode-plugin`) and install through the app's native path (SetupWizard / `install_plugin`), then verify the installed file carries the fix's defining symbol using the G-084 method (hash comparison against the built dist — byte-equality proves currency — or `Select-String -LiteralPath` with BUNDLE-FORM anchors; NEVER the Grep tool on the `~` plugin path). A clean environment with zero `telemetry_spans` rows and the env var confirmed set is the stale-plugin signature — check plugin currency before touching the spec or the ECE.
- **home:** dev-environment skill (plugin prerequisite section — currency step + G-084 method) + references.md (G-047)
- **effectiveness:** Partial — re-validated live in #2770 (2026-08-30): the stale-installed-plugin signature recurred (installed file lacked the round-4 guard signatures while dist had them), but the second-order failure was the CHECK ITSELF: agents Grep'd the `~` plugin path and stalled (see G-084). Rule strengthened to prescribe the hash/bundle-form verification method; currency receipts now recorded via `Get-FileHash` equality (SI: SHA256 `37CA35A6...` installed == dist, FIXB4 round) or bundle-form anchors.

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
- **guardrail:** Read the latest *verdict-carrying* `## Tests Runs` comment; verdict-line parsing is bold-tolerant. The #1499 semantic (newer FAIL beats older PASS) is preserved. **RESOLVED-BY-REMOVAL (2026-08-25):** the `## Evidence` comment alias was removed entirely (prefix refused for every agent) — the bug class can no longer occur; this record is retained for history.
- **home:** pipeline-state.rs `verification_status`
- **effectiveness:** Resolved (alias removed)

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
- **observed:** #2688, the Architect diagnosing double emission tried `Get-Content ~/.config/opencode/opencode.json` and to read the live DB file directly; the sandbox DENIES reads/writes outside the repo, so the agent stalled instead of proceeding. RECURRENCE #2758 round 2 — through a second vector: the ORCHESTRATOR's dispatch brief itself named the out-of-repo plugin path, so the tester dutifully attempted that read and stalled; the failure origin was the brief author, not the dispatched agent.
- **target_failure:** an agent attempts raw file access to an out-of-repo path (live `fredo.db`, `~/.config/opencode/*`, `%APPDATA%\com.fredo.app\*`), gets DENIED, and loops/stalls instead of using the documented in-repo source. Both vectors: (a) the agent spontaneously probes the filesystem, (b) the dispatch BRIEF names an out-of-repo path and sends the agent after it.
- **guardrail:** Never attempt raw reads/writes outside the repo - the sandbox denies them. Out-of-repo artifacts have documented in-repo sources: the live DB path + query recipes live in the `telemetry-query` skill; the opencode plugin install and DB reset (`clean-fredo-db.ps1`) live in the `dev-environment` skill. Load the relevant skill; if a needed out-of-repo value is not documented, report it to the orchestrator instead of probing the filesystem. **Brief-author variant (hard rule):** every dispatch brief MUST reference skill recipes by name — NEVER write a raw out-of-repo path anywhere in a brief; if an environment fact is needed, point at the skill that owns it.
- **home:** docs/agentic-pipeline/common-rules.md + both skills + self-improver playbook (brief-authoring rules)
- **effectiveness:** Partial — #2688 stopped spontaneous probing, but #2758 round 2 recurred via brief-authored paths; the brief-author hard rule closes that vector (verify on next live rounds).

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
- **effectiveness:** **Confirmed** (2026-08-27, #2760 triage) \u2014 the trap recurred exactly as documented: the Software Architect's glob over `.opencode/tests/**` concluded the persisted mission-monitor suites did not exist (D-1), and the orchestrator's convergence pass caught the false negative via directory listing, corrected the plan, and no round was burned (one correction edit). Recurred again (2026-08-28, #2766 round 1): the tester reported the existing durable suites "not present in the checkout" — caught in the SI's record check before it contaminated any verdict, and the round-2 brief's explicit "dot-directories are invisible to Glob" warning prevented recurrence. Recurred again (2026-09-03, #2791 triage): the QA Expert's glob over `.opencode/tests/mission-monitor/` concluded the feature domain "did not previously exist" and it overwrote the pre-existing suite — caught by the SI's directory-listing cross-check, and the consequence was promoted to its own guardrail (G-093, seed-extend-not-rewrite).

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
- **guardrail:** On retry rounds the tester MUST post the verdict by drafting `.opencode/tmp/<issue>/tests-runs.md` and flushing it with `post-comments` — the state machine stamps the `## Tests Runs (round N)` header; the `## Evidence` comment alias is untagged and fails the round guard. Never use `--prefix Evidence` for the round verdict. **RESOLVED-BY-REMOVAL (2026-08-25):** the `--prefix Evidence` path no longer exists — refused for every agent; the draft path is the only verdict channel.
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
- **target_failure:** a `## Tests Runs` verdict comment that does not carry the machine-parsed verdict line in the template format blocks (or, conversely, a malformed one could falsely clear) the testing exit gate.
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
- **effectiveness:** **Confirmed** (2026-08-30, #2768) — the `testing → audit` transition failed once with `mergeStateStatus: UNKNOWN` immediately after tests-commit pushed to main; `gh pr view` showed `MERGEABLE` and the immediate retry merged cleanly — one retry, zero escalation, exactly per the record. Re-validated (2026-09-02, #2792): the `testing → audit` merge failed once with `mergeStateStatus: UNKNOWN`; `gh pr view` showed `MERGEABLE`/`CLEAN` and the retry merged #2794 — one retry, per the record.

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
- **effectiveness:** **Confirmed** (2026-08-28, #2764) — main moved mid-run at every `testing → implementation` transition (tests-commit re-persisting the mission-monitor suites), and the spec branch was re-synced with main's tip (G-032 SHA form) before each of the five tester entries; suite guidance matched at every entry and no clobber occurred. Re-validated in #2766 (2026-08-28): the mid-run tests-commit main movement was again caught and the branch re-synced before re-entry; the sync hit two practical snags worth remembering — the repo root carried the tester's leftover UNCOMMITTED local suite edits (the merge refuses dirty files even when content is identical; resolve by committing the identical content first), and identical-content files still conflicted on line-ending differences (resolve with the merge's incoming/main version). No stale guidance reached any tester entry. Re-validated in #2791 (2026-09-03): the spec branch (`spec/2791` forked at `9bc4553`) carried the OLD mission-monitor suite while `main` advanced to `211b1ae` (the QA-seeded suite). Resolved benignly — the ROOT working tree carried the CURRENT suite, and `tests-commit` writes from the working tree, so no stale-overwrite; the PR merge base (`9bc4553` → `ab4dc9d`) meant main's suite wins on the merge. Note: the G-032 merge of main tip into the branch was attempted but the dirty working tree (the current-suite files) blocked it — the guards fired and the evidence was still sound, demonstrating the risk is real even when the outcome is benign.

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

### G-055: delayed_async_js_sampling_times_out_for_motion_evidence
- **activation_date:** 2026-08-21
- **observed:** #2752 round 1: the QA plan required AC2's glide/settle proof as frame-sampled node positions, and the tester's first attempt used a DELAYED async `tauri_webview_execute_js` sampling call (`setTimeout`-based) which TIMED OUT in the Tauri webview — leaving AC2 UNVERIFIED and forcing a second tester round. The round-2 change to SHORT SYNCHRONOUS samples (execute JS that reads current positions and returns immediately, ~150-300ms apart) captured t0/mid1/mid2/settled with a byte-identical settled window and passed. The product was defect-free the whole time; only the evidence technique was wrong.
- **target_failure:** a tester tries to prove animated motion (glide/settle/restart-seeding) with a delayed async JS sampling call inside the Tauri webview, the call times out, and a live-only AC lands UNVERIFIED — burning a round on an evidence-technique defect rather than a product defect.
- **guardrail:** For motion evidence (rAF-driven animation: glide, settle, freeze, restart-seeding), sample node positions with SHORT SYNCHRONOUS `tauri_webview_execute_js` calls that read current positions and return immediately — never a delayed/`setTimeout`-based async call (it times out in the Tauri webview). Capture t0 immediately after the triggering interaction, then 3-5 rapid samples ~150-300ms apart, then a settle sample; prove glide with ≥2 distinct intermediate positions and settle with byte-identical positions across a ≥500ms window on a QUIESCENT graph (a live-streaming graph restarts the sim on every structural change by design — settle must be observed with no new deliveries). If in-frame sampling stays unreliable, fall back to DOM-based position reads across samples or a screencast. (This is the concrete technique behind G-053's "change the EVIDENCE STRATEGY".)
- **home:** playbooks/tester.md (evidence-conventions section — add synchronous-sampling rule) + references.md (this record)
- **effectiveness:** Pending

### G-056: upload_evidence_base_required_for_single_issue_features
- **activation_date:** 2026-08-21
- **observed:** recurring across #2689/#2700/#2711/#2717/#2723/#2731/#2752: testers repeatedly hit `upload-evidence requires --body-file` and then `cannot resolve parent plan for #N; pass --base <spec-branch>`. The single-issue model (the feature issue IS the plan — no separate plan issue, no `Parent: Implementation Plan #N` body marker) means `parent_spec()` cannot resolve the spec branch, so `--base spec/<N>` is effectively MANDATORY for every feature issue — yet the pipeline-state skill documents it as optional `[--base <branch>]`, and the action deliberately refuses to guess (a safety design the harness enforces). Each miss cost the tester 2-4 failed invocations before the round's screenshots could be uploaded.
- **target_failure:** a tester runs `upload-evidence` without `--body-file` and/or without `--base spec/<N>` on a single-issue-model feature, the machine refuses (deliberately — never guess the branch), and the round's screenshot evidence never lands — an evidence-pipeline stall that costs retries every spec.
- **guardrail:** In the single-issue model the feature issue has no parent-plan marker, so `upload-evidence` MUST be invoked with BOTH `--body-file <existing .md>` (required and validated) and `--base spec/<N>` (the spec branch; the machine refuses to guess without it). Save screenshots under `.opencode/tmp/<issue>/e2e/` first, then upload each AC's screenshot with the full invocation and paste the printed raw URL into the AC row. The pipeline-state skill and tester playbook must state this as required, not optional, for feature issues.
- **home:** skill: pipeline-state (upload-evidence action row — mark `--base` required for single-issue features) + playbooks/tester.md (evidence-upload section) + references.md (this record)
- **effectiveness:** Pending

### G-057: reactflow_positions_not_readable_via_global_store_or_offset
- **activation_date:** 2026-08-21
- **observed:** #2754 round 1 (live): the tester sampled "ReactFlow store `node.position`" from the main window via SHORT SYNCHRONOUS `tauri_webview_execute_js` snippets and got `x=0,y=0` for EVERY node (10 nodes), reporting R-1/AC1 FAIL + R-4/AC4 FAIL ("byte-identical at zero — no glide") while the evidence screenshot showed the hybrid chat spine + companion nodes rendered. Two read-surface errors: (1) ReactFlow v11's store is a zustand instance created inside `ReactFlowProvider` (module-scoped, never attached to `window`), so a main-window snippet CANNOT read "store `node.position`" — there is no global store handle; (2) `.react-flow__node` elements are positioned via inline `style.transform: translate(xpx, ypx)` with `position: absolute` and NO `left`/`top` (confirmed in `@reactflow/core` wrapNode), so reading `offsetLeft`/`offsetTop` (or `getBoundingClientRect` without zoom-unscaling) always returns `0,0` regardless of the actual rendered position — the node's layout position lives ONLY in its `style.transform`. The product was defect-free: the new real-builder integration tests (useMissionMonitor.realbuilder.test.ts) drive the REAL d3-force sim through the hook and prove chat nodes land at `computeChatChainPositions` output on the ReactFlow store (both rAF and snapToSettled paths) while companions-only move.
- **target_failure:** a tester reads ReactFlow node positions from a non-existent global store handle or from `offsetLeft`/`offsetTop` on `.react-flow__node` elements and reports a false all-zero layout / no-glide FAIL, burning a round on a measurement-surface error while the product is correct.
- **guardrail:** ReactFlow v11 node positions are NOT readable from a main-window snippet via any global store handle (none exists) and NOT via `offsetLeft`/`offsetTop` (always 0 for transform-positioned nodes). The correct live read surface is the DOM node's inline `style.transform` — parse `translate(xpx, ypx)` from `document.querySelectorAll('.react-flow__node')` (each element carries `data-id` = the node id), which IS the layout position in the same coordinate space as the store's `node.position` (unscaled by zoom — the viewport transform lives on the parent `.react-flow__viewport`). For motion evidence, sample the parsed `translate()` values with SHORT SYNCHRONOUS snippets (G-055 cadence). If a precise store-level read is ever required, the app must expose a read-only positions getter (e.g. a `window` handle the feature populates); do not assume one exists.
- **home:** playbooks/tester.md (ReactFlow position sampling — use DOM `style.transform`, never offset/store globals) + references.md (this record)
- **effectiveness:** Pending

### G-058: run_cli_terminal_is_separate_window_driven_via_pty_ipc
- **activation_date:** 2026-08-21
- **observed:** #2754 testing rounds 1-4: the tester burned rounds searching the MAIN window's DOM for `run-cli-terminal` (never found — it is a separate native Tauri window), then reporting "no run-cli-terminal in DOM" and "Run CLI stuck on Starting OpenCode…" as a suspected product/environment defect. Root cause (confirmed by code): `open_run_cli` creates a dedicated Tauri window labeled `run-cli-terminal` (`features/terminal/commands.rs`), rendering the Ghostty web terminal (`RunCliTerminalWindow.tsx`) — a CANVAS, so terminal text never appears in any DOM snapshot. Additionally `tauri_ipc_execute_command` returned "Unsupported Tauri command" for `write_pty_input`/`get_pty_buffer` (MCP bridge exposes a subset of commands); the working path is `tauri_webview_execute_js` → `__TAURI__.core.invoke('write_pty_input', {data: "...\r"})` / `__TAURI__.core.invoke('get_pty_buffer', {})`. Once the window-first + PTY-IPC method was used, the launch path worked every round.
- **target_failure:** a tester searches the main window's DOM for the Run CLI terminal (which is a separate canvas-backed native window) and/or uses `tauri_ipc_execute_command` for PTY commands (not exposed), misreporting a healthy launch as a product/environment failure and burning rounds on a harness-method error.
- **guardrail:** The Run CLI terminal is a SEPARATE Tauri window (`run-cli-terminal`, window list via `tauri_manage_window action="list"`) rendering a Ghostty CANVAS — terminal text is invisible to DOM snapshots. Confirm it by window list + direct canvas/textarea inspection (`tauri_webview_dom_snapshot` / `execute_js` with `windowId='run-cli-terminal'`), never by searching the main DOM. Drive the PTY over IPC via `tauri_webview_execute_js` → `__TAURI__.core.invoke('write_pty_input', {data: "<cmd>\r"})` (trailing `\r` mandatory, G-037) and read output via `__TAURI__.core.invoke('get_pty_buffer', {})` — `tauri_ipc_execute_command` does not expose feature-specific commands ("Unsupported Tauri command" is expected, not a defect). Launch Run CLI from the maomaolabs desktop toolbar item (`button[aria-label="Run CLI"]`), not from inside another feature's view.
- **home:** playbooks/tester.md (Run CLI evidence conventions — separate window + PTY-over-IPC, added 2026-08-21) + dev-environment skill (MCP Bridge IPC Limitation) + references.md (this record)
- **effectiveness:** Pending

### G-059: reduced_motion_snap_vs_glide_discriminator
- **activation_date:** 2026-08-21
- **observed:** #2754 round 3: the tester reported R-4 (live glide) FAIL because synchronous t0/mid1/mid2/settled samples were byte-identical — but the developer proved the non-reduced rAF glide path is correct (real-builder integration test drives the real d3 sim and observes intermediate frames). The round-3 samples matched the `snapToSettled: prefersReducedMotion()` path firing in the automation webview (automation VMs commonly have animation effects disabled → reduce → snap, which is the CORRECT AC4 a11y exception per the plan's F-142), OR sampling after the ~3.8s glide completed. Without the reduced-motion readout the tester could not distinguish "no glide (defect)" from "snap is the correct reduced-motion behavior" and reported a false FAIL.
- **target_failure:** a motion AC (glide/settle) is judged FAIL from byte-identical samples when the automation webview has `prefers-reduced-motion: reduce` active (snap-to-settled is the CORRECT a11y behavior, not a defect) or the samples were taken after the glide finished — burning a round on a missing discriminator.
- **guardrail:** Before judging any animated-motion AC (glide/settle), read the webview's reduced-motion state FIRST (`window.matchMedia('(prefers-reduced-motion: reduce)').matches` via `tauri_webview_execute_js`) and record it in the evidence. If `reduce: true` → snap-to-settled is correct (verify chat pinned + companions within bounds + positions applied once; do NOT require intermediate frames). If `reduce: false` → sample t0 IMMEDIATELY after the triggering interaction (the glide lasts ~2-4s), then 3-5 short-synchronous samples ~150-300ms apart (G-055), then settled; require ≥2 intermediate positions differing from BOTH t0 and settled for ≥1 moving node. Byte-identical samples with `reduce: false` and t0-after-settle is a sampling-cadence error, not a product defect — re-run with t0-at-toggle.
- **home:** playbooks/tester.md (motion evidence — reduced-motion discriminator, added 2026-08-21) + references.md (this record)
- **effectiveness:** Pending

### G-060: live_fixture_must_generate_the_ac_node_set
- **activation_date:** 2026-08-21
- **observed:** #2754 round 2: the tester's "probes" were trivial chat messages ("say hi"), which produced a 1-node session — the H1 fixture (≥3 chat nodes + a ToolsNode exchange + an @-subagent dispatch, session SELECTED in the Mission Monitor list) was never generated, so R-1/R-2/R-4 were UNVERIFIED ("no companion set rendered"). The launch path and position recipe were both proven working; the failure was purely that the fixture did not contain the node types the ACs assert on. Round 3 fixed it by prompting for a tool call and an @-subagent dispatch and selecting the session — the fixture then produced 3 chat + 1 Tools + 1 Subagent and the ACs became measurable.
- **target_failure:** a live QA round probes with trivial messages that never produce the AC's required node set (companions, subagents, many nodes), leaving geometry/motion ACs UNVERIFIED and burning a round on a fixture-generation gap mislabeled as a product failure.
- **guardrail:** Before starting AC verification, GENERATE the full fixture the ACs require and CONFIRM it in the DOM: ≥3 chat nodes, a tool-calling exchange (embedded chat `── TOOLS (N) ──` section — since Spec #2764 no standalone ToolsNode exists), an @-subagent dispatch (SubagentNode) where the ACs reference companions — and SELECT the new session in the feature's session list so its graph populates. Verify the expected node set is present (DOM/telemetry) BEFORE running the AC assertions; adapt prompt phrasing to force the required tool/subagent behavior (the durable smoke suite has working phrasings from prior live rounds) and document what worked. A round whose fixture never produced the asserted node types is a fixture-recipe failure, not an AC verdict.
- **home:** playbooks/tester.md (fixture-generation — generate + confirm the AC node set before asserting, added 2026-08-21) + references.md (this record)
- **effectiveness:** Pending

### G-061: developer_edits_must_land_in_the_worktree
- **activation_date:** 2026-08-21
- **observed:** #2754 round 4: the developer's first batch of edits was applied to the MAIN checkout (`C:\Code\fredo\apps\…`) instead of its worktree (`C:\Code\fredo\.worktrees\2754-a\apps\…`); the tests initially ran against pristine worktree files (empty worktree diff). Detected via the empty worktree diff, re-applied byte-identical changes to the worktree, and restored the main checkout to clean — caught before anything was pushed, but only by the dev's own diff check.
- **target_failure:** a developer edits files in the main repo checkout instead of its assigned worktree, runs verification against unchanged worktree files (false green), and either pushes nothing or pushes from the wrong tree — or leaves the main checkout dirty, contaminating the serving worktree.
- **guardrail:** After editing, ALWAYS verify the changes are present in the WORKTREE before running tests (`git status`/`git diff` from inside `.worktrees/<N>-a`) — an empty worktree diff after editing means the edits landed in the main checkout. Never leave the main checkout (`C:\Code\fredo`) with uncommitted changes; the SI doc-sync and the serving frontend depend on it staying clean. If edits land in the main checkout, revert them there (restore clean) and re-apply in the worktree before verifying.
- **home:** playbooks/developer.md (worktree hygiene — verify edits are in the worktree before testing, added 2026-08-21) + references.md (this record)
- **effectiveness:** Pending

### G-062: orchestrator_authors_fix_scope_on_retry
- **activation_date:** 2026-08-25
- **observed:** #2756 rounds 2+: on each tester FAIL, the round's root-cause context and fix scope accumulated in the A2A file / Fix Plan authored by the Self-Improver (orchestrator) — deep code analysis (file:line hypotheses, fix directions) written by the agent whose own rule says it never researches code. The machine compounded this by deriving the posted `## Fix Plan (round N)` from the STALE plan draft, so no fresh root-cause analysis had a designated author at all.
- **target_failure:** the orchestrator designs the retry fix scope itself — violating the SI's no-code-research boundary — or nobody authors it (the machine can only compact pre-failure planning content), so retries run on stale or unowned diagnoses.
- **guardrail:** On any tester FAIL (or audit restart to implementation), the SI dispatches the Software Architect BEFORE re-entering implementation; the architect researches the root cause and drafts `.opencode/tmp/<issue>/fix-plan.md` (`## Failed ACs`, `## Root Cause (file:line)`, `## Fix Scope`, footer `*Authored by Software Architect*`). The machine posts the authored draft as `## Fix Plan (round N)` (falling back to derived compaction only when no draft exists). The SI never writes fix scope; design decisions belong to the Architect.
- **home:** playbooks/self-improver.md (Retry rounds section + step 16, added 2026-08-25) + playbooks/software-architect.md (Fix Plan authoring) + state-machine.md (retry-round plan compaction) + references.md (this record)
- **effectiveness:** Pending

### G-063: evidence_posted_as_dead_path_strings
- **activation_date:** 2026-08-25
- **observed:** #2756 round 2: the tester's `## Tests Runs (round 2)` verdict referenced every screenshot by bare filename (`Screenshot: ac1-force.jpeg`) and listed evidence under local scratch paths (`.opencode/tmp/2756/e2e/*.jpeg`) — never running `upload-evidence`. On GitHub these are dead strings: nothing renders, nothing is clickable, and the scratch files are gitignored so they are not even reachable in-repo. The machine auto-posted the draft because the only draft validations were the `Verdict:` line and round stamp.
- **target_failure:** a posted verdict whose evidence is unviewable — reviewers cannot see or open any screenshot, and the evidence trail silently depends on ephemeral gitignored files that cleanup deletes.
- **guardrail:** The state machine REFUSES a `tests-runs.md` draft containing any image reference without `https://` (bare filename or local path = dead evidence; draft kept for the tester to fix). Every screenshot must go through `upload-evidence` per AC and be embedded as the printed raw URL; backend-only ACs state `n/a — not visually observable`.
- **home:** pipeline-state.rs (`post_pending_comments` evidence-renderability guard, added 2026-08-25) + playbooks/tester.md step 6 + templates/Tests-runs-comment-template.md + references.md (this record)
- **effectiveness:** Pending

### G-064: evidence_comment_prefix_removed
- **activation_date:** 2026-08-25
- **observed:** the `Evidence` comment prefix was a legacy alias for the tester verdict while the canonical channel was already the `## Tests Runs` timeline draft. The dual path caused the recurring bug class G-006 (verdict-less receipts masking verdicts), G-020 (duplicate verdicts via per-upload Evidence posts) and G-029 (untagged Evidence failing the round-aware guard on retries), plus pages of playbook warnings teaching agents NOT to use it.
- **target_failure:** two channels for one artifact — every guard must defend against the alias, and every defense is a place the alias can still slip through.
- **guardrail:** One artifact, one channel. The `## Tests Runs` draft (machine round-stamped) is the only verdict path; `upload-evidence` is upload-only; the `comment` action refuses `--prefix Evidence` for EVERY agent (tester included). Valid prefixes are `Decision` (machine-only via `audit-record`), `Status` (blockers/escalations only — never routine progress), and nothing else. When a legacy alias and its replacement coexist, remove the alias rather than guarding it.
- **home:** pipeline-state.rs (`comment` action Evidence refusal + `latest_evidence_comment`/`count_verdict_comments_in_round` scan only `## Tests Runs`) + github.md comment conventions + templates/Evidence-comment-template.md deleted + references.md (this record)
- **effectiveness:** Pending

### G-065: qa_comment_prefixes_with_no_consumer
- **activation_date:** 2026-08-25
- **observed:** #2756 full-timeline audit: across 16 rounds and 2,826 comments, exactly ONE `## Question` and ONE free-form `## Decision` were posted — while `## Tests Runs`/`## Fix Plan` carried 15 each. Workers never read comment threads by design (LEAN briefs inline what they need; workers read the context block + targeted artifacts), so a Q/A channel on the timeline had no reader except the orchestrator, who already sees everything through its record review. Even the spec's one scope escalation went out as a `Status`, not a Question.
- **target_failure:** maintaining comment conventions that have no consumer — playbook text teaching agents to post into channels nobody reads, and guard complexity defending gates those channels don't feed.
- **guardrail:** A communication convention must name its READER. The agent-facing comment surface is `Status` only (blockers/escalations/PO amendments); ambiguity is a `block` action (`--reason`, label + SLA) resolved by the orchestrator and returned inlined in the re-dispatch brief; decisions reach the record through the machine (`audit-record --reason`) or PO amendments via `Status`. Before adding an agent-facing artifact or prefix, identify who reads it and when — if the answer is "the orchestrator, eventually," route it through the orchestrator's existing mechanisms instead.
- **home:** pipeline-state.rs (`comment` whitelist = Status; Question/Decision refused with pointers) + github.md comment conventions + principles.md (open-question rule) + playbooks (developer/tester/product-owner/self-improver) + references.md (this record)
- **effectiveness:** Pending

### G-084: grep_tool_stalls_on_installed_plugin_path
- **activation_date:** 2026-08-30
- **observed:** #2770 rounds 3-4: the Grep tool stalls indefinitely when pointed at the installed-plugin path `~\.config\opencode\plugins\fredo.js` — the `~` home-dir path is not usable by the Grep tool in this sandbox on Windows, so the agent waits forever (two tester rounds lost before the SI root-caused it). G-047's original wording ("grep the installed file for the fix's defining symbol") prescribed the wrong TOOL for that path.
- **target_failure:** an agent follows a playbook instruction to search a home-dir file with the Grep tool and stalls permanently, burning the round.
- **guardrail:** NEVER use the Grep tool (or any search tool) against `~\.config\opencode\plugins\fredo.js` or any `~` home-dir path. Verify plugin currency sandbox-safely: (1) `Get-FileHash` the installed file vs `apps/opencode-plugin/dist/index.js` — equal SHA256 proves byte-equality and currency; (2) `Select-String -LiteralPath` with BUNDLE-FORM anchors — bundling flattens source expressions (source `time.created` → bundle `createdAt`), so derive anchors from the built dist file, never from `src/*.ts`.
- **home:** dev-environment SKILL.md (plugin prerequisite block) + AGENTS.md SDD Pipeline Hygiene mirror (human-approved) + references.md (this record)
- **effectiveness:** Pending

### G-085: webview2_corrupt_http_cache_white_screen
- **activation_date:** 2026-08-30
- **observed:** #2770 rounds 2-5: WebView2 served a corrupt cached HTTP response for the Vite dev URL — the webview painted raw HTTP headers as the page document (white screen; app HTML never rendered). The entry survived app restarts and recurred on 4+ consecutive cold boots; a manual `/?cb=<ts>` cache-busting navigation recovered it every time. Misattributing it to a stale binary or the spec wasted diagnosis time.
- **target_failure:** a dev webview renders a stale/corrupt cached document (white screen or raw headers) and the wedge is blamed on the app, the spec, or the dev binary instead of the WebView2 HTTP cache.
- **guardrail:** Recognize the signature (raw HTTP headers painted as the page document, survives restarts, Vite dev URL): recover with a `/?cb=<ts>` cache-bust navigation FIRST. The durable fix is baked into dev-env.ps1 — every COLD `Up` clears the WebView2 HTTP cache (Cache, Code Cache, GPUCache only; localStorage/IndexedDB/Cookies preserved) before launching the app; do not disable or work around it, and do not clear the whole EBWebView profile (that destroys app dev state).
- **home:** .opencode/scripts/dev-env.ps1 (`Clear-WebView2HttpCache` on cold Up) + dev-environment skill + references.md (this record)
- **effectiveness:** Pending

### G-086: css_var_alpha_append_invalid_in_declaration_contexts
- **activation_date:** 2026-08-30
- **observed:** #2770 round 4: the R-2 nested-accent stripe never painted — the stripe's soft-shadow component alpha-appended hex digits onto a CSS custom property (`var(--border-color)33`); var() substitution splices tokens without re-lexing, so the appended digits stay a separate token and the browser drops the WHOLE declaration at computed-value time (box-shadow computed `none`). The repo docs themselves sanctioned the pattern for tints, so the defect class was doc-prescribed; a sibling site (`${accent}28` borders) failed identically. 25 live sites existed across features.
- **target_failure:** CSS emission code alpha-appends onto a `var()`/custom-property reference, the declaration is silently dropped by the browser, and the visual defect survives source review and jsdom tests because only computed-value behavior reveals it.
- **guardrail:** NEVER alpha-append hex digits onto a `var()` reference or custom property in any declaration (box-shadow, border, background, outline) — var() substitution splices tokens without re-lexing, and the browser drops the entire declaration. Derive var()-based tints with the shared `tint()` helper (`color-mix(in srgb, … %, transparent)`); alpha-append is valid ONLY on literal hex strings (8-digit hex formed in JS before CSS parses). Any doc that sanctions a CSS emission pattern must be validated against browser computed values (e.g. `getComputedStyle` on a live run), not just source syntax — jsdom pins emission strings only.
- **home:** AGENTS.md Chakra section (human-approved rewrite) + apps/ui/src/shared/utils/colorTint.ts + chakra-ui-refactor SKILL.md + playbooks/ui-ux-expert.md + references.md (this record)
- **effectiveness:** Pending

### G-087: reopen_leg_reuses_squash_merged_evidence_branch
- **activation_date:** 2026-08-31
- **observed:** #2770 round 6 (the first reopen): the `done → planning` reopen reused the kept evidence branch `spec/2770`, whose pre-reopen commits had been SQUASH-merged to main — the histories diverge, so the round-6 PR was born CONFLICTING and the testing → audit merge was blocked until the developer ran the G-032 sync (merge origin/main into the spec branch, resolve to "final tree = main + fix-round delta", push).
- **target_failure:** a reopened feature's spec PR conflicts with main at merge time because the branch carries pre-reopen commits whose content main already absorbed via the squash — blocking the audit merge after testing already passed.
- **guardrail:** On a `done → planning` reopen, treat the spec branch as STALE BY CONSTRUCTION (it is the kept evidence branch; its pre-reopen work is already on main via squash): immediately after the `planning → implementation` transition, run the G-032 branch sync BEFORE any testing dispatch — merge origin/main into `spec/<N>`, resolve every conflict to the invariant "final tree = origin/main + the fix-round delta only", re-verify the build/tests, and push (fast-forward). Never force-push and never re-create the branch (it carries the evidence trail); the merge commit is the record.
- **home:** playbooks/self-improver.md (reopen workflow step) + references.md (this record)
- **effectiveness:** Pending

### G-088: fixture_injected_evidence_closes_unmodeled_real_shapes
- **activation_date:** 2026-08-31
- **observed:** #2770 rounds 5-6: round 5's live drive validated depth-3 compact-card rendering entirely through FIXTURE-injected payloads (single cleanly-stamped composited copy per correlationId) — every depth-3 test passed while the real path failed, because real multi-hop re-key deliveries carry DOUBLE-stamped copies the fixtures never modeled. The reopen triage needed a real-corpus replay (the persisted real deliveries exported verbatim as a fixture) to reproduce and prove the fix.
- **target_failure:** a rendering/association behavior verified green by fixture-injected payloads ships broken because the real delivery path produces a shape the fixtures do not model (duplicate re-key copies, contested stamps, multi-hop compositing) — the mock-vs-real gap at fixture granularity.
- **guardrail:** A fixture may close a behavior class only when its injected payload shapes demonstrably model what the REAL delivery path emits for that class — for delegation depth ≥ 3, multi-hop re-keying, and composited-ownership behaviors this bar is NOT met by synthetic single-copy fixtures: require a live real-agent drive or a real-corpus replay (persisted deliveries exported verbatim and version-controlled) as the decisive evidence. When a defect survives a fixture-PASS round, replay the REAL persisted deliveries BEFORE redesigning any logic — the corpus reproduces the shape that fixtures hid.
- **home:** playbooks/tester.md (evidence-policy section) + playbooks/qa-expert.md (QA plan fixture boundary) + references.md (this record)
- **effectiveness:** Pending

### G-093: qa_suite_overwritten_because_glob_claimed_absent
- **activation_date:** 2026-09-03
- **observed:** #2791 triage: the QA Expert seeded the `mission-monitor` durable suite because its `glob` check returned no files — concluding the feature domain "did not previously exist." But the suite DID pre-exist (the files show as tracked-modified at the `spec/2791` fork base); `glob` excludes `.opencode/`, so the "absent" conclusion was a G-024 false negative. The QA Expert then OVERWROTE the existing suite rather than extending it. Because `tests-commit` persists the suite to `main`, this can destroy prior cross-spec regression coverage (the suite is a cumulative shared asset) — caught by the SI's directory-listing cross-check in the orchestration snapshot, no round burned.
- **target_failure:** a planner (QA Expert) rewrites an existing durable feature suite from scratch because a glob-based "absent" check misled it, losing prior cross-spec regression cases that the suite had accumulated.
- **guardrail:** When seeding/extending a durable feature suite, detect the existing suite via a **directory listing/read** (never `glob`), and if the folder already has files, EXTEND them — never regenerate the suite from scratch. A glob "no files found" does NOT prove the suite is absent (G-024); a shared regression asset must grow, not be replaced. The SI's convergence pass must directory-check the declared `**Feature tests:**` folders and flag any planners that report a pre-existing suite as absent.
- **home:** playbooks/qa-expert.md (seed/extend step — detect via listing, extend not rewrite) + playbooks/self-improver.md (G-024 guardrail) + references.md (this record)
- **effectiveness:** Pending


### G-094: escalating_verification_mode_adjustments
- **activation_date:** 2026-09-02
- **observed:** #2792 round 1: the tester FAILed solely because AR-3 (a failed tool call with NO captured error text → explicit absent-reason placeholder) was UNVERIFIED — its `success:false` + empty/absent-`error` observable could not be produced live (real opencode failures always emit a non-empty `tool.error`; the RTDB `toolError` merge rule is `LastNonZero`). The SI escalated a "PO scope decision required" `Status` and STOPPED the line. The human's proxy ruled this an **over-escalation**: it is an orchestration-level verification-mode decision (live↔static leg re-classification for an architecturally-unreachable defensive state) that changes NO requirement, NO acceptance criterion, and NO product code. The correct handling was QA case-work (the Software Architect's `scope` root-cause) + a PO amendment recorded as a Status comment + continue the line to done.
- **target_failure:** the SI treats a verification-mode gap (a test leg that cannot be executed live because the observable is architecturally unreachable) as a stop-the-line escalation, burning a human round and halting the pipeline for a decision that is the SI+QA's to make.
- **guardrail:** Verification-mode adjustments (live↔static leg re-classification) for unreachable/defensive states are handle by the SI + QA directly — record the amendment as a `Status` comment and continue the line. The SI's STOP triggers are ONLY: (1) scope changes, (2) changes to an AC's observable behavior, (3) product-code changes forced by new findings, (4) threats to a binding decision, (5) genuine BLOCKED guards. A test leg whose observable is architecturally unreachable does NOT stop the line — case-work it (QA root-cause + PO amendment) and proceed.
- **home:** playbooks/self-improver.md (escalation boundary discipline) + references.md (this record)
- **effectiveness:** Pending


### G-095: rework_fixplan_or_stale_draft_spuriously_posts_on_success_audit
- **activation_date:** 2026-09-02
- **observed:** #2792: after the round-1 FAIL (AR-3 UNVERIFIED) the Software Architect authored `fix-plan.md` (root cause `scope`). The PO then resolved it with a verification amendment and NO rework. Two machine frictions surfaced: (1) `post_pending_comments` sets `is_rework_reentry = (from == "testing")`, which is TRUE for BOTH `testing → implementation` (rework) AND `testing → audit` (success) — a pending `fix-plan.md` at a `testing → audit` transition SPURIOUSLY posts as `## Fix Plan (round N)` even when the PO resolved with no rework; and (2) `update-plan --section qa` requires the assembled `triage-plan.md` draft, which is CONSUMED after the `planning → implementation` posting, so mid-`testing` the QA plan can only be updated via the A2A source (`triage.md`) or a reconstructed-then-removed draft (a reconstructed draft would be re-posted or auto-removed at the transition).
- **target_failure:** an obsolete/stale pending draft (a superseded fix plan, or a re-posted plan draft) leaks onto the timeline at a transition that should NOT post it — e.g. a `## Fix Plan (round N)` appearing on a PASS→audit that had no rework — corrupting the human's record and contradicting a no-rework PO resolution.
- **guardrail:** Before a `testing → audit` transition, neutralize any pending draft that should NOT post (a fix-plan superseded by a PO no-rework resolution: remove its `*Authored by*` footer and/or its `Root cause class:` line so the flush refuses it; observe the anti-spoofing/root-cause guards). Do NOT reconstruct the consumed `triage-plan.md` mid-phase just to satisfy `update-plan` — update the A2A source `triage.md` instead (the durable plan record) and record the amendment in the `Status` comment. Candidate machine-hardening: make `is_rework_reentry` distinguish `testing → audit` (success) from `testing → implementation` (rework), and allow `update-plan` to fall back to the A2A source when the assembled draft is consumed.
- **home:** playbooks/self-improver.md (draft-flush discipline) + pipeline-state.rs (candidate hardening)
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
