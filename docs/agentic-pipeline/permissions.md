# Agent Permissions & Tool Access

Every pipeline agent runs under a **deny-by-default sandbox** (`opencode.json` per-agent
`agents.<role>.permissions` ordered rule arrays): only the allowlisted actions/resources work;
everything else is **DENIED**. Each agent's array starts with a catch-all
`{ "action": "*", "resource": "*", "effect": "deny" }`, so an unlisted tool is denied rather
than left at V2's default `ask`. If you attempt something outside your allowlist the sandbox
blocks it and you stall. **Do not retry a denied command** - read this page (and your playbook),
use what you have, and report the gap to the orchestrator in your final report (see the required
`Issues & tool-access gaps` section below).

The `opencode.json` per-agent `permissions` arrays are the authoritative source; this page is the
readable summary. If you find a mismatch, report it - do not work around the sandbox.

## Shared baseline (all agents)

- **edit:** `.opencode/tmp/**` + `docs/agentic-pipeline/playbooks/references.md` (the
  agent-editable knowledge base).
- **shell:** deny-by-default. Everyone gets read-only `gh` (`gh issue view/list`, `gh pr view/list/checks`)
  + `rust-script .opencode/scripts/pipeline-state.rs*` (your state-machine reads).
  **Read-only `git` (`git log/status/diff/branch/show/fetch/remote`) exists ONLY for
  `developer`/`tester`/`orchestrator`** — the three triage planners (`software-architect`,
  `ui-ux-expert`, `qa-expert`) have **no git commands at all** (deny-by-default breaks tool-loops,
  see [Loop mitigation](#loop-mitigation)). A planner never needs git — it edits its A2A section and
  reads repo files.
- **Command chaining is DENIED for everyone** - `&&`, `;`, `|` never work. Run one command
  per line. **Known machine residual (#3098, Machinist-flagged, V2 shape):** `set-permission`
  appends a new rule at the END of `agents.<role>.permissions`, and V2 evaluates rules
  last-match-wins, so an appended `shell` allow prefix (`git rm*`, `git clone*`, `git apply*`,
  `Test-Path*`, `git worktree add*` / `git worktree remove*`) is matched after the chain-deny
  rules and can re-allow a compound command. The action does not re-append or reorder the chain
  denies; the durable fix is script logic in the state machine (see `playbooks/references.md` §
  Pipeline Mechanics). Until then the chain rule is belt-and-braces — still issue one command
  per call.
- **Denied for all:** `gh issue create/edit/close`, `gh pr create/edit/merge/close`,
  force-push, `git push` to `main`/`master`, and edits outside your edit allowlist.
  No agent ever calls `gh`/`git` to write (single-writer rule) - draft content and request
  the state-machine action instead.
- **Out-of-repo access is DENY-by-default (`external_directory`).** V2 now ALLOWS
  `external_directory` by default, so each agent's ordered rules must carry an explicit
  `{ "action": "external_directory", "resource": "*", "effect": "deny" }` and then re-allow
  ONLY the sanctioned paths (last-match-wins). The sanctioned out-of-repo paths are the
  **app-data directory** (`%APPDATA%\com.fredo.app`, or `%LOCALAPPDATA%` on non-roaming installs —
  it holds the embedded PostgreSQL cluster), the **installed-plugin path**
  (`~/.config/opencode/plugins/`), and — for `software-architect`, `developer`, and `tester` only —
  the **local Cargo registry source tree** (`~/.cargo/registry/src/**`) so an agent can read a
  pinned dependency's actual source during research/implementation; everything else must be
  denied. **An explicit deny for one path is not repo-scoping** (G-009 default-deny variant): the
  rule set must deny by default and re-allow only those documented paths. The Machinist owns this
  via `set-permission --tool external_directory`. `external_directory` is the lever that scopes
  reads to the repo; in V2 a `read` rule is
  `{ "action": "read", "resource": "*", "effect": ... }`. **`external_directory` has no read/write
  split** — a path rule re-allows the whole path, not one verb — so the Cargo entry is a
  *path*-scoped re-allow (the registry source tree only), not a verb-scoped read-only exception.
  Keep it that narrow: never widen it to `~/.cargo/**`, and grant it to no role outside the three
  named here.

## Editing agent permissions (the Machinist owns this)

An agent that hits a missing allowlist verb (a denied deletion, a new prerequisite command)
does **not** route the change to the human. The **Machinist applies it itself**, through
the state machine's `set-permission` action:

```
rust-script .opencode/scripts/pipeline-state.rs --agent machinist --action set-permission \
  --role <agent> --tool <action> [--pattern "<resource>"] --decision allow|ask|deny|remove
```

- Scope is the **`agents.<role>.permissions` array only** — the action refuses anything else,
  refuses a role that does not exist, and refuses a V1-shaped config. It is text-surgical and
  order-preserving, because V2 evaluates permission rules **last-match-wins**; a new rule is
  appended (so an `allow` beats the preceding catch-all `deny`), and the document is re-validated
  before write.
- `--tool` is the V2 **action** name (`shell`, `edit`, `read`, `skill`, `subagent`,
  `external_directory`, an MCP action such as `chakra_ui_*`, ...). V1 aliases `bash` → `shell`,
  `task` → `subagent`, `write`/`patch` → `edit`, and `chakra-ui_*` → `chakra_ui_*` are accepted.
  `doom_loop` is refused — V2 has no such action.
- `--pattern` is the V2 **resource**. With it, the exact `(action, resource)` rule is set or
  removed; **without it, a set uses resource `*`** and `remove` deletes every rule for that
  action (the V1 "remove the whole category" behaviour).
- The rest of `opencode.json` (models, MCP servers, tool wiring, top-level settings) and
  `AGENTS.md` remain **human-owned**. A change there is proposed to the human, not applied.
- Runtime note: `opencode.json` is read at startup, so a permission change takes effect on the
  next opencode restart. Record that in the `Status` note when you apply one.

## Loop mitigation (deny-by-default + pipeline guards)

Subagents (especially `deepseek-v4-flash` planners) can fall into **tool-call loops**: emitting the
same tool call (or close variants) repeatedly instead of integrating the result and acting — the
#2694 triage spun 177 state-machine context reads and minutes of repeated `git log` with no plan
written. These layers stop a loop; keep them enabled:

1. **Runtime loop detection (verify on V2).** V2 has no `doom_loop` permission action, so the V1
   `doom_loop: allow` knob no longer exists. If the V2 runtime still injects its recovery prompt
   when a tool call repeats with identical input, follow it: **STOP repeating the tool call** and
   switch to a text summary + a different action (see common-rules). If V2 does not, layers 2–4 are
   the whole guard — add a plugin-side repeat detector if this regresses.
2. **Deny-by-default breaks the attractor.** An ALLOWED command returns identical output every run,
   giving a looping model nothing novel — the loop can run forever. A DENIED command returns an
   error (a novel signal), which breaks the repetition and forces a tactic change. That is why the
   triage planners have no git commands, and why you must **never retry a denied command**: the
   denial is the signal to change approach, not to retry (common-rules: *Know and respect your
   sandbox*).
3. **`steps` cap (recommended config).** V2 supports an agent `steps` cap: it forces a text
   summary after N agentic iterations, bounding a loop that runtime detection misses (e.g. variant
   probes with different inputs). Set it on the triage planners in `opencode.json`. Sampling
   options such as `temperature` belong on a model variant, not the agent entry, in V2.
4. **Pipeline-level guards (state machine).** The `context` action refuses a streak of ≥ 8
   consecutive context reads with no intervening action; the `comment` action refuses the A2A
   triage file as a body. Documented in `state-machine.md`.


## Per-agent

| Agent | edit | extra shell (beyond baseline) | gotchas / what is DENIED |
|-------|------|-----------------------------|--------------------------|
| `product-owner` | tmp + refs | (baseline only) | GitHub output: `create-issue` + `Status` comments (PO amendments, #2734); never gate artifacts. |
| `software-architect` | tmp + refs | `telemetry-query.ps1` (read-only PostgreSQL telemetry) | Research/planning only - no code edits, no gh/git writes. `external_directory` denies opencode's runtime dir and re-allows `~/.cargo/registry/src/**` (pinned dependency sources, path-scoped) - no other path is granted. |
| `ui-ux-expert` | tmp + refs | (baseline only) | Design assets only - no code edits. |
| `qa-expert` | tmp + refs + `.opencode/tests/**` | `telemetry-query.ps1` (read-only PostgreSQL telemetry) | Writes only under `.opencode/tests/`; sole test-suite author. |
| `developer` | **allow (all files)** | `git checkout/switch/add/commit/rebase/stash`, `git worktree add*/remove*` (#3098), `git push origin HEAD:spec/<N>` (never main/master/force), `cargo/pnpm/npm/npx/node/rustc`, `copilot*` (Copilot CLI live-capture leg, spec #2933), `Remove-Item .opencode/*`, `run-exitcode.ps1`, `check-navigation-prose-retired.ps1` (#3153), `gate-release-artifact.ps1` + `gate-artifact-window.ps1` (#3181, `-File` and `-NoProfile -File` forms) | NO `gh pr create/edit`, NO `git push` to main/master/force, NO `git merge main/master`, NO `git commit --no-verify`. **Read-only wrappers only** — the two `powershell -File` entries are a thin exit-code printer (`run-exitcode.ps1`, 39 lines: `Invoke-Expression` + `EXITCODE=<n>`) and a file-scanner absence guard that reads its roots and writes transient probes under its own roots **and deletes them**; neither performs a product write. They are granted per-script, never as a `.opencode/scripts/*` wildcard. **NO `git pull`** — deliberately not granted (#3098): sync with `git fetch` then `git rebase origin/spec/<N>`, since a bare pull can merge main outside the SHA-pinned form. `external_directory` denies opencode's runtime dir and re-allows `~/.cargo/registry/src/**` (pinned dependency sources, path-scoped) - no other path is granted. |
| `tester` | tmp + refs + `.opencode/tests/**` | `dev-env.ps1`, `test-scripts.ps1`, `telemetry-query.ps1`, `git checkout/add/commit`, `git worktree add*/remove*` (#3098), `git push origin HEAD:spec/<N>`, `bun/npm/pnpm`, `cargo check/clippy/test` (CI-parity re-run of the Rust gates), `copilot*` (Copilot CLI live-capture leg, spec #2933), `Test-Path`, `fredo`, `Copy-Item/New-Item/Remove-Item/Set-Content .opencode/*`, `$env:OPENCODE_ENABLE_TELEMETRY=...`, `gate-release-artifact.ps1` + `gate-artifact-window.ps1` (#3181, both invocation forms), `gh release download*` (#3181 — fetches the historical `app-v0.2.4` installer for the AC5 fail-closed demonstration) | NO raw `Remove-Item` outside `.opencode/*` - the store is reset via `dev-env.ps1 -Action Clean`, NOT a direct path (sandbox denies it, G-009). **NO `git pull`** (same decision as the developer: fetch + rebase). NO gh writes, NO command chains. NO direct `opencode` CLI invocation — live opencode sessions are launched ONLY through Fredo's Terminal feature (write_pty_input, never `opencode run`). `external_directory` **denies by default** — the app-data directory, the installed-plugin path, and `~/.cargo/registry/src/**` (pinned dependency sources, path-scoped) are the only re-allowed paths (G-009), so no other out-of-repo read/write is reachable. |
| `orchestrator` | **allow** | `dev-env.ps1`, `test-scripts.ps1`, `git add/commit/push`, `git merge` (never main/master), `git checkout`, `git push origin HEAD:spec/<N>`, `bun/npm/pnpm/cargo`, `.opencode/*` file ops, `$env:OPENCODE_ENABLE_TELEMETRY=...` | NO `git push origin main` (denied — the post-audit gate opens + force-merges (`--admin`) the single `maint/<N>` SPEC MAINT PR through the machine's `maint-pr` action instead), NO force-push, NO merge of main/master, NO gh writes. NO direct `opencode` CLI invocation — live opencode sessions run only via Fredo's Terminal feature. |
| `auditor` | tmp only | (baseline only) | Read-only verification gate — no code/plan/test/record edits; its only output is the `audit-record` verdict. No gh/git writes. |
| `curator` | tmp + `docs/agentic-pipeline/**` (`principles.md` denied) | (baseline only) | Durable lessons only — edits playbooks/`references.md`/pipeline docs; never product source. No gh/git writes. |
| `toolsmith` | tmp + `.opencode/skills/**` + `.opencode/scripts/**` (`pipeline-state.rs` denied) + `.opencode/tests/**` | `test-scripts.ps1` | Reusable capability only — every script ships with its skill + a test. No gh/git writes. |
| `machinist` | tmp + `.opencode/scripts/pipeline-state.rs` + `.opencode/pipeline.json` + `.opencode/skills/pipeline-state/**` + `docs/agentic-pipeline/state-machine.md` | `test-scripts.ps1` | The state machine, permissions/sandbox, and measurement. Every state-machine edit passes `test-scripts.ps1`. No gh/git writes. |

### Per-agent notes

**Guard-evidence access (#3153).** An agent expected to **evidence** a committed absence
guard must be able to **execute** it. `developer` (authoring role) carries
`check-navigation-prose-retired.ps1` **and** `run-exitcode.ps1` so it can both run the guard
and capture the numeric `EXITCODE=`/`HITS:` receipt; `tester` (verifying role) drives the
same guard through its existing `run-exitcode.ps1 -Command "..."` route, which is how its
rows are written (G-399) — no extra direct grant is needed. The `auditor` is **deliberately
not** widened: it judges the record the tester produced, not the tree (auditor playbook,
"Never research code or telemetry"; its sandbox's baseline read set is the record). Any
future guard that a role must evidence gets the same per-script treatment via
`set-permission` — never a general `.opencode/scripts/*` glob. Pinned by the harness
assertion `Guard-evidence roles can run the retirement/prose guards they must prove (#3153)`.

**Release-gate execution (#3181).** A role that must RUN the release gate must be able to
execute its two committed scripts. `developer` (authors the harness, runs
`gate-release-artifact.ps1 -SelfTest`) and `tester` (real gate runs plus the negative
legs) each carry **per-script** grants for `gate-release-artifact.ps1` and
`gate-artifact-window.ps1` — the latter is the in-window CDP hook that
`launch-artifact-probe.ps1 -CdpProbe` invokes, so it is granted alongside the harness
rather than only on its own. Both the `powershell -File` and
`powershell -NoProfile -File` invocation forms are granted, because CI-shaped and
interactive runs spell the command differently and an exact script-path glob does not
cover a prefix it was not given. The `tester` additionally carries `gh release download*`
— its ONLY release-asset route — so the AC5 fail-closed demonstration can fetch the
historical known-broken `app-v0.2.4` installer and prove the gate names the broken
property. As with every script grant, this stays per-script: never a general
`.opencode/scripts/*` glob.

## Final-report issues section (required)

Every agent's **final report** back to the Orchestrator MUST end with an
`## Issues & tool-access gaps` section listing:

1. **problems** you hit (blockers, stalls, confusing behavior),
2. **tools/commands you could NOT use** (and why - permission denied? not installed? wrong path?),
3. **tools you would like to have** (and what you would use them for),
4. **recurring ad-hoc scripts** — any launcher, port probe, config inspector, or receipt script you improvised under `.opencode/tmp/<issue>/`, with its path and how many runs/rounds it recurred (a one-off dump stays ad-hoc; a script run more than once is a promotion candidate the Orchestrator routes to the Toolsmith; the motivating case is #3077).

This is the channel by which the Orchestrator learns about subagent pain points. If you had no issues,
state that explicitly ("none"). The Orchestrator reads this section and routes/tracks the gaps.
