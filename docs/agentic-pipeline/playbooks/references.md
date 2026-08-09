# References

Shared knowledge base for the agentic pipeline. **Every agent may add, edit, and remove references here** (per [common-rules.md](../common-rules.md) §2) — it is the pipeline's agent-editable knowledge base, not SI-owned. The SI additionally owns the `Known Failure Modes` section (guardrail records, retro-analysis Recipe 6). Agents link to this file from their playbooks.

---

## How to Use This File

- Each entry is a **URL + one-line description** (a pointer an agent actually needs) or a **short self-contained fact**. Every entry must be verifiable: cite a doc path, URL, script path, or concrete behavior — no vibes.
- **Reference format:** `- **Title** — <description> (<URL>)`. Group under the right category; create a new category only when three or more entries need it.
- **Before adding, grep for the URL** — reuse and extend an existing entry instead of creating a near-duplicate.
- **Do not edit `### G-` guardrail blocks** in `Known Failure Modes` — those are SI-owned (Recipe 6). Add non-guardrail facts elsewhere.
- You are granted edit access in `opencode.json`; if blocked, report the gap rather than working around it.

---

## Repository Facts

- **Build** — `cargo build` from `apps/tauri/src-tauri/`; `pnpm --filter @fredo/ui build` for the UI library; `pnpm dev:ui` for the Vite dev server (port 5174).
- **Dev server** — `pnpm dev:tauri` runs the Tauri dev app; the MCP bridge binds `127.0.0.1:9223`; OTLP receivers bind `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP).
- **Telemetry DB** — `fredo.db`; query via `.opencode/skills/telemetry-query/telemetry-query.ps1` (sqlite3 CLI). Inspect `telemetry_spans`, `telemetry_metrics`, `telemetry_logs`.

---

## Pipeline Mechanics

- **State machine** — the single writer and phase authority: `.opencode/scripts/pipeline-state.rs`, reached only through the `pipeline-state` skill. All pipeline GitHub writes go through it.
- **Validation harness** — `powershell -File .opencode/scripts/test-scripts.ps1` runs fully offline against a mock GitHub (`FREDO_MOCK_GH=1`); run after any pipeline-state change.
- **Guardrail records** — persisted by the SI at every audit under `Known Failure Modes` below (retro-analysis Recipe 6).

---

## Known Failure Modes

Guardrail records — persisted by the Self-Improver at every audit (retro-analysis Recipe 6), **within the principles** (a rule that would contradict `principles.md` is proposed to the human, never applied). Records are **prose-only — never embed code snippets or product symbols**. Each record names the failure class, the rule, and where the rule lives; `effectiveness` is updated on later audits (Recipe 1). `AGENTS.md`/`opencode.json` entries are human-owned — the SI proposes, never edits. (Encoding a lesson as a script change — `pipeline-state.rs`, `.opencode/scripts/*` — is the SI's domain and stays in the script, not here.)

### G-001: subagent_stale_permissions
- **activation_date:** 2026-08-09
- **observed:** #2449, tester repeatedly blocked on missing telemetry-query/`fredo*` permissions; config edits in `opencode.json` had no effect on already-running subagents.
- **target_failure:** subagent runs with a stale permission set after `opencode.json` is edited mid-run.
- **guardrail:** Subagent sandboxes cache `opencode.json` at process startup — restart the opencode process (or dispatch a fresh agent) after editing agent permissions; never assume a running subagent sees new grants.
- **home:** references.md (G-001)
- **effectiveness:** Pending

### G-002: stale_spec_branch_config
- **activation_date:** 2026-08-09
- **observed:** #2449, spec/2449 forked before pipeline fixes; dispatched tester silently ran on stale config and re-blocked.
- **target_failure:** agent dispatched on a spec branch that lacks `main`'s current pipeline config.
- **guardrail:** Before dispatching the tester (or any agent) on `spec/<N>`, sync it with `main` (`git fetch origin main && git merge origin/main` + push) — the working tree's `opencode.json` is the source of the agent's sandbox.
- **home:** playbooks/self-improver.md step 9
- **effectiveness:** Pending

### G-003: missing_plugin_install
- **activation_date:** 2026-08-09
- **observed:** #2449, tester stuck because the fredo plugin was not installed at `~/.config/opencode/plugins/fredo.js`.
- **target_failure:** agent that needs fredo's telemetry emission cannot find the plugin.
- **guardrail:** The fredo plugin must be built (`apps/opencode-plugin`) and installed to `~/.config/opencode/plugins/fredo.js` on any host running the pipeline; verify with `Get-Command`/`Test-Path` before dispatching agents that depend on it.
- **home:** dev-environment skill
- **effectiveness:** Pending

### G-004: worktree_missing_node_modules
- **activation_date:** 2026-08-09
- **observed:** #2449, dev instance running the spec build from a bare worktree failed — no `node_modules` present.
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

---

## Useful External References

- **OTel GenAI semantic conventions** — the source of truth for all `gen_ai.*` attribute emission (`gen-ai-spans.md`, `gen-ai-agent-spans.md`, `gen-ai-events.md`, `gen-ai-exceptions.md`, `gen-ai-metrics.md`): https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai/
- **Chakra UI v3 docs** — compound components, recipes, semantic tokens: https://chakra-ui.com/docs/components
- **ReactFlow docs** — v11 node/edge API, `selectNodesOnDrag` default behavior: https://reactflow.dev/learn
- **Tauri v2 docs** — commands, IPC, plugins, capabilities: https://v2.tauri.app/
