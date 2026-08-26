# Agent Permissions & Tool Access

Every pipeline agent runs under a **deny-by-default sandbox** (`opencode.json` per-agent
`permission` blocks): only the allowlisted commands and edit paths work; everything else is
**DENIED**. If you attempt something outside your allowlist the sandbox blocks it and you
stall. **Do not retry a denied command** - read this page (and your playbook), use what you
have, and report the gap to the orchestrator in your final report (see the required
`Issues & tool-access gaps` section below).

The `opencode.json` per-agent blocks are the authoritative source; this page is the readable
summary. If you find a mismatch, report it - do not work around the sandbox.

## Shared baseline (all agents)

- **edit:** `.opencode/tmp/**` + `docs/agentic-pipeline/playbooks/references.md` (the
  agent-editable knowledge base).
- **bash:** deny-by-default. Everyone gets read-only `gh` (`gh issue view/list`, `gh pr view/list/checks`)
  + `rust-script .opencode/scripts/pipeline-state.rs*` (your state-machine reads).
  **Read-only `git` (`git log/status/diff/branch/show/fetch/remote`) exists ONLY for
  `developer`/`tester`/`self-improver`** — the three triage planners (`software-architect`,
  `ui-ux-expert`, `qa-expert`) have **no git commands at all** (deny-by-default breaks tool-loops,
  see [Loop mitigation](#loop-mitigation)). A planner never needs git — it edits its A2A section and
  reads repo files.
- **Command chaining is DENIED for everyone** - `&&`, `;`, `|` never work. Run one command
  per line.
- **Denied for all:** `gh issue create/edit/close`, `gh pr create/edit/merge/close`,
  force-push, `git push` to `main`/`master`, and edits outside your edit allowlist.
  No agent ever calls `gh`/`git` to write (single-writer rule) - draft content and request
  the state-machine action instead.

## Loop mitigation (why deny-by-default + opencode's `doom_loop`)

Subagents (especially `deepseek-v4-flash` planners) can fall into **tool-call loops**: emitting the
same tool call (or close variants) repeatedly instead of integrating the result and acting — the
#2694 triage spun 177 state-machine context reads and minutes of repeated `git log` with no plan
written. Four layers stop a loop; keep all four enabled:

1. **opencode `doom_loop` (built-in — MUST be `allow`, never `deny`).** opencode detects "the same
   tool call repeats 3 times with identical input" and injects a **recovery prompt** telling the
   agent it is stuck. The Fredo config had `doom_loop: deny` on every agent, which **disabled this
   recovery entirely** — nothing ever told a looping agent to stop. Pipeline agents run
   `doom_loop: allow` so the recovery prompt auto-injects. **When you see that prompt, STOP repeating
   the tool call and follow it** (switch to a text summary + a different action) — see common-rules.
2. **Deny-by-default breaks the attractor.** An ALLOWED command returns identical output every run,
   giving a looping model nothing novel — the loop can run forever. A DENIED command returns an
   error (a novel signal), which breaks the repetition and forces a tactic change. That is why the
   triage planners have no git commands, and why you must **never retry a denied command**: the
   denial is the signal to change approach, not to retry (common-rules: *Know and respect your
   sandbox*).
3. **`steps` cap + low `temperature` (recommended config).** An agent `steps` cap forces a text
   summary after N agentic iterations (bounds any loop that doom_loop misses — e.g. variant probes
   with different inputs); `temperature` ≈ 0.1–0.3 keeps planning deterministic. Set both on the
   triage planners in `opencode.json`.
4. **Pipeline-level guards (state machine).** The `context` action refuses a streak of ≥ 3
   consecutive context reads with no intervening action; the `comment` action refuses the A2A
   triage file as a body. Documented in `state-machine.md`.


## Per-agent

| Agent | edit | extra bash (beyond baseline) | gotchas / what is DENIED |
|-------|------|-----------------------------|--------------------------|
| `product-owner` | tmp + refs | (baseline only) | GitHub output: `create-issue` + `Status` comments (PO amendments, #2734); never gate artifacts. |
| `software-architect` | tmp + refs | `sqlite3*` (read-only telemetry) | Research/planning only - no code edits, no gh/git writes. |
| `ui-ux-expert` | tmp + refs | (baseline only) | Design assets only - no code edits. |
| `qa-expert` | tmp + refs + `.opencode/tests/**` | `sqlite3*` | Writes only under `.opencode/tests/`; sole test-suite author. |
| `developer` | **allow (all files)** | `git checkout/switch/add/commit/rebase/stash`, `git push origin HEAD:spec/<N>` (never main/master/force), `cargo/pnpm/npm/npx/node/rustc`, `Remove-Item .opencode/*` | NO `gh pr create/edit`, NO `git push` to main/master/force, NO `git merge main/master`, NO `git commit --no-verify`. |
| `tester` | tmp + refs + `.opencode/tests/**` | `dev-env.ps1`, `clean-fredo-db.ps1`, `test-scripts.ps1`, `telemetry-query.ps1`, `git checkout/add/commit`, `git push origin HEAD:spec/<N>`, `bun/npm/pnpm`, `Test-Path`, `fredo`, `Copy-Item/New-Item/Remove-Item/Set-Content .opencode/*`, `$env:OPENCODE_ENABLE_TELEMETRY=...` | NO raw `Remove-Item` outside `.opencode/*` - the live DB is deleted via `clean-fredo-db.ps1`, NOT a direct path (sandbox denies it, G-009). NO gh writes, NO command chains. NO direct `opencode` CLI invocation — live opencode sessions are launched ONLY through Fredo's Run CLI feature (write_pty_input, never `opencode run`). |
| `self-improver` | **allow** | `sqlite3`, `dev-env.ps1`, `clean-fredo-db.ps1`, `test-scripts.ps1`, `git add/commit/push`, `git push origin main` (doc-sync ONLY), `git merge` (never main/master), `git checkout`, `git push origin HEAD:spec/<N>`, `bun/npm/pnpm/cargo`, `.opencode/*` file ops, `$env:OPENCODE_ENABLE_TELEMETRY=...` | NO force-push, NO `git push origin main` except the doc-sync, NO merge of main/master, NO gh writes. NO direct `opencode` CLI invocation — live opencode sessions run only via Fredo's Run CLI. |

## Final-report issues section (required)

Every agent's **final report** back to the orchestrator (the Self-Improver) MUST end with an
`## Issues & tool-access gaps` section listing:

1. **problems** you hit (blockers, stalls, confusing behavior),
2. **tools/commands you could NOT use** (and why - permission denied? not installed? wrong path?),
3. **tools you would like to have** (and what you would use them for).

This is the channel by which the SI learns about subagent pain points. If you had no issues,
state that explicitly ("none"). The SI reads this section and routes/tracks the gaps.
