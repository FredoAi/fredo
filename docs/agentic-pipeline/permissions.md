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
- **bash:** deny-by-default. Only: read-only `gh` (`gh issue view/list`, `gh pr view/list/checks`)
  and read-only `git` (`git log/status/diff/branch/show/fetch/remote`) +
  `rust-script .opencode/scripts/pipeline-state.rs*` (your state-machine reads).
- **Command chaining is DENIED for everyone** - `&&`, `;`, `|` never work. Run one command
  per line.
- **Denied for all:** `gh issue create/edit/close`, `gh pr create/edit/merge/close`,
  force-push, `git push` to `main`/`master`, and edits outside your edit allowlist.
  No agent ever calls `gh`/`git` to write (single-writer rule) - draft content and request
  the state-machine action instead.

## Per-agent

| Agent | edit | extra bash (beyond baseline) | gotchas / what is DENIED |
|-------|------|-----------------------------|--------------------------|
| `product-owner` | tmp + refs | (baseline only) | All GitHub output is `create-issue`; never post a comment. |
| `software-architect` | tmp + refs | `sqlite3*` (read-only telemetry) | Research/planning only - no code edits, no gh/git writes. |
| `ui-ux-expert` | tmp + refs | (baseline only) | Design assets only - no code edits. |
| `qa-expert` | tmp + refs + `.opencode/tests/**` | `sqlite3*` | Writes only under `.opencode/tests/`; sole test-suite author. |
| `developer` | **allow (all files)** | `git checkout/switch/add/commit/rebase/stash`, `git push origin HEAD:spec/<N>` (never main/master/force), `cargo/pnpm/npm/npx/node/rustc`, `Remove-Item .opencode/*` | NO `gh pr create/edit`, NO `git push` to main/master/force, NO `git merge main/master`, NO `git commit --no-verify`. |
| `tester` | tmp + refs + `.opencode/tests/**` | `dev-env.ps1`, `clean-fredo-db.ps1`, `test-scripts.ps1`, `telemetry-query.ps1`, `git checkout/add/commit`, `git push origin HEAD:spec/<N>`, `bun/npm/pnpm`, `opencode run/serve/auth`, `Test-Path`, `fredo`, `Copy-Item/New-Item/Remove-Item/Set-Content .opencode/*`, `$env:OPENCODE_ENABLE_TELEMETRY=...` | NO raw `Remove-Item` outside `.opencode/*` - the live DB is deleted via `clean-fredo-db.ps1`, NOT a direct path (sandbox denies it, G-009). NO gh writes, NO command chains. |
| `self-improver` | **allow** | `sqlite3`, `dev-env.ps1`, `clean-fredo-db.ps1`, `test-scripts.ps1`, `git add/commit/push`, `git push origin main` (doc-sync ONLY), `git merge` (never main/master), `git checkout`, `git push origin HEAD:spec/<N>`, `bun/npm/pnpm/cargo`, `opencode run/serve/auth`, `.opencode/*` file ops, `$env:OPENCODE_ENABLE_TELEMETRY=...` | NO force-push, NO `git push origin main` except the doc-sync, NO merge of main/master, NO gh writes. |

## Final-report issues section (required)

Every agent's **final report** back to the orchestrator (the Self-Improver) MUST end with an
`## Issues & tool-access gaps` section listing:

1. **problems** you hit (blockers, stalls, confusing behavior),
2. **tools/commands you could NOT use** (and why - permission denied? not installed? wrong path?),
3. **tools you would like to have** (and what you would use them for).

This is the channel by which the SI learns about subagent pain points. If you had no issues,
state that explicitly ("none"). The SI reads this section and routes/tracks the gaps.
