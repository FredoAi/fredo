# Design Principles

The non-negotiable rules that shape every agent, artifact, and phase in this pipeline. If a design decision conflicts with a rule here, the rule wins.

---

## 1. Agents Are People, Not Functions

Every agent is written as a **person with a professional identity** — not a job description, not a checklist, and not a personality dump. The opening line is the single highest-leverage instruction in the file: a concrete, specialized role reliably changes *how* the agent reasons and sets the standard of work it holds itself to.

> "You are an expert software architect specialized in Rust and React. You have deep experience with event-driven architectures, Tauri desktop apps, and real-time data pipelines. You've been burned enough by assumptions that you always trace the real data flow before you design."

That identity statement carries four things:

- **Who you are** — the professional: role + specialization ("expert software architect specialized in Rust and React").
- **Why you're good** — the depth: the domains and the stack you know cold.
- **How you think** — the temperament: judgment, values, working style.
- **What you've learned** — the scars: the hard-won instincts that shape your decisions.

**Why this matters (evidence-backed):** roles change reasoning, not just tone (Kong et al., NAACL 2024) — but personality does **not** buy accuracy (Zheng et al., EMNLP 2024), and personality flavor actively hurts code (Anthropic measured a ~3% eval regression from a tone/verbosity line). **Verdict: personality is *scope and standard*, not *voice*.** Write the person who does the job well; don't audition a character.

The test of a well-defined agent: reading its profile, a human could predict how it would react to a new situation they haven't explicitly scripted — because its standards and instincts are clear, not because its tone is memorable.

The authoritative home for agent identity is each agent's `.opencode/agents/*.md` file. **The mechanics for writing a good agent definition — anatomy, length limits, structure, DeepSeek-specific rules, iteration — live in [agent-definition-guide.md](agent-definition-guide.md), not here.** This rule states the *why*; that guide is the *how*.

---

## 2. A State Machine Gives Each Agent Its Phase Context

Agents are contextual — the same developer behaves differently mid-implementation than during a PR retry. But agents cannot be trusted to figure out "where are we right now?" from raw issue text, and the pipeline needs one deterministic authority for state. That authority is a **state machine**: it determines where each work item is, validates that it is allowed to be there, and injects phase context into every agent that wakes up. An explicit state machine is more reliable than free-text prompting for this.

At the principle level, the state machine does nine things:

1. **It is the pipeline's single source of truth for "where are we?".** Every work item exists in exactly one phase, determined by **observable evidence** (what exists, what has been done, what was recorded) — never by what an agent *says* it did. No agent self-reports its way forward.

2. **Phases are gates, not lanes.** A phase's only purpose is its **Goals** (principle 3) — the definition of done. The machine enforces two gates per phase:
   - **Entry guard (Definition of Ready):** you may not enter until the previous phase *proved* its goals are met.
   - **Exit guard (Definition of Done):** you may not leave until this phase's goals are met.
   The whole pipeline is a chain of "prove it, then move."

3. **It is the pipeline's memory.** Every transition, and the evidence behind it, is recorded. Because every agent calls the state machine, each call is also a **telemetry event** — the state machine is the pipeline's passive metrics collector, and the metrics are the memory made measurable. This makes the pipeline auditable, debuggable, and restartable — and it is what makes the GitHub-backbone-and-log principle and the Self-Improver's audit (principle 6) enforceable. The metrics contract lives in [state-machine.md](state-machine.md#metrics-the-pipelines-memory).

4. **It injects context, so agents never guess.** Every agent that wakes receives, from the machine: which phase it is in, that phase's Goals, the playbook for it, and what must exist to leave. The agent reads its assignment from state — it does not infer it.

5. **It is a guardrail, not a straitjacket.** The machine governs *boundaries between phases only*. Inside a phase, the agent has full autonomy. **Boundaries validated, freedom inside the loop** — the single most important design line.

6. **It is deterministic; judgment is recorded, not embedded.** The machine's decisions come from real signals. If an LLM judgment is needed ("is this actually blocked?"), the LLM runs as a queried step, writes its verdict to the record, and the machine reads the record. The machine never calls an LLM to decide a transition.

7. **Nothing is ever stranded.** Every phase has a legal exit: forward, rework (loop back, counted), or a terminal ending (done / canceled). "Blocked" is a *condition on a phase*, not a phase — nothing vanishes, nothing gets stuck forever.

8. **It is the single writer to GitHub.** The state machine owns **all pipeline GitHub writes** — creating issues (backlog, Implementation Plan), setting and transitioning labels, posting comments, creating branches/worktrees, merging PRs, and closing issues. Agents **never** call `gh`/`git` for pipeline operations; they *draft* content and *request* an action, and the state machine validates the request against the guards, executes it, and records the metric event. This closes the loop: the same authority that decides state is the only thing allowed to mutate state. Agents may read GitHub directly (viewing issues, comments, branches); they may not write it.

9. **It owns the mechanics; agents keep the judgment.** Every *deterministic* step belongs in the state machine, never in an agent's checklist. The `transition` action is the orchestration point: entering a phase triggers that phase's deterministic side-effects automatically. **The mechanical orchestration is machine side-effects, not agent steps** — the `intake → triage` transition seeds the A2A working file, and the `triage → implementation` transition assembles the Implementation Plan (creates the seeded plan and fills every section from the A2A file) and persists the QA-seeded test suites — rather than any agent running them by hand. Entering `implementation` also creates the spec integration branch; entering `testing` opens the spec PR; `testing → audit` merges it. The timeline and the telemetry record maintain themselves. What remains for agents is exactly the part that cannot be reduced to a rule: **content** (backlog and plan drafts, comments, evidence screenshots) and **judgment** (triage design, staffing, test classification, the audit verdict). The test of this principle: if a step is deterministic and still lives in an agent's playbook, it has not yet been moved into the machine — move it. This is the flip side of point 5: the machine governs *boundaries* and *mechanics*; the agent owns *freedom inside the loop* and *judgment at the edges*.

### Delivery form: a minimal skill + a workhorse script

The state machine is delivered as two pieces, and the split is deliberate:

- **The script does all the work.** It reads the signals, computes the current phase, validates the guards, **executes the GitHub writes agents request**, appends the metric event, and prints the context block. All state logic lives in the script — nowhere else.
- **The skill is minimal.** It does not encode the state model, the phases, the guards, or the goals. It contains only what the agent needs to *invoke* the script and *read* its output: "run the script, here is how to read the context block, here is how to request a GitHub action, here is what to do with the result." The skill is a thin loader, not a duplicate of the machine.

**Why:** exactly one source of truth for state logic (the script). If the skill also described phases and transitions, the two would drift — the skill would become stale prose that contradicts the code. The minimal skill keeps the principle of "judgment/state lives in one place" applied to our own tooling. The same argument makes the script the **only** GitHub writer: one authoritative place for both deciding state and mutating state.

---

## 3. Every Phase Has Goals

Goals are the **definition of done for a phase** — the measurable outcome that must be achieved before the pipeline advances. They are not instructions ("how to do the work") and not activities ("do X"); they are outcomes ("the feature has a verified Implementation Plan satisfying all backlog requirements").

**Why goals matter (evidence-backed):** role + prime directive + acceptance criteria is the most-circulated high-performing agent pattern (the SNOWFLOW brief), and "define what counts as done and how the model should verify its work" is shared OpenAI/Anthropic guidance. A phase without a goal is a phase where agents work but nothing completes.

Rules:

- **Every phase declares its Goals.** Each phase in [pipeline.md](pipeline.md) lists its goals up front.
- **Goals are measurable, not aspirational.** "Create a backlog issue with confirmed requirements" — not "understand the feature".
- **Goals are the state machine's exit checks.** A phase's goals are the prior-phase-completeness validation for the next phase. No transition without them.
- **Agents report against goals.** An agent's final report states which goals it met, with evidence — not just what it did.

---

## 4. Agents Link to Their Playbook

Every agent has a **playbook** — a per-agent document in the playbook folder that defines how it works in this pipeline. Each agent profile in `.opencode/agents/*.md` links to its own playbook (and to the pipeline sections that govern it). The links are one-directional:

- **Agent → Playbook:** each agent `.md` links to its playbook in the playbook folder, which defines the agent's phases, artifacts, and conventions.
- **Agent identity** lives **only** in `.opencode/agents/*.md` — never duplicated anywhere else.

**The agent is step-agnostic until its turn comes.** The agent file holds *who the agent is* — an identity (a judgment standard) plus the state-call directive: get your work from the state machine and the ticket. It does **not** hold the pipeline steps (process, workflow, verification, definition of done), nor the scope boundaries, guardrails, or mechanics. All of those live in the playbook, which the state machine's context block points to at runtime, and the agent reads its playbook when it is dispatched to do its phase. This keeps the agent file stable across pipeline changes — a step change updates one playbook, not the agent.

This guarantees that when the pipeline changes, there is exactly one authoritative place to update (the playbook), and agents point at it rather than duplicating the rules inline. Agent identity updates happen in the agent's own file.

---

## 5. GitHub Is the Communication Backbone and the Log

All communication between agents happens through GitHub — issues, labels, and comments — never through a shared chat or an ad-hoc channel. GitHub is both our **communication system** and our **log**: everything an agent does or decides is recorded there.

This means:

- **Every artifact** is an issue body, a comment, or a file committed to a branch and referenced from one.
 - **Every decision** reaches the record through the machine — the audit verdict via `audit-record`, or a PO amendment via `Status`. Free-form decision prose has no channel.
 - **Every open question** blocks work until answered — ambiguity is recorded via the `block` action (`--reason`), resolved by the orchestrator, and re-dispatched with the answer inlined in the brief; decisions reach the record through the machine (`audit-record`) or a PO amendment via `Status`.
- **Every status change** is a comment prefixed `Status`.
- **Every test result** is a comment prefixed `Evidence`.
- **Issues** carry the work; **labels** carry state; **comments** carry the history; the Implementation Plan's checklist carries the work breakdown.

The benefits are deliberate: full auditability, asynchronous handoffs, and a record that outlives any single agent run — GitHub is the pipeline's memory and its source of truth. See [github.md](github.md).

---

## 6. A Self-Improver Gate Audits Every Issue

Every issue ends with a **Self-Improver** audit, performed by the same agent that orchestrated the pipeline, after the Tester's verdict. The Self-Improver decides whether the issue was completed successfully:

- **Success** → the issue is done. The pipeline ends.
- **Failure** → the Self-Improver chooses which phase the pipeline restarts from (Intake, Triage, Implementation, or Testing), **after improving** the thing that caused the failure. The Self-Improver then re-dispatches the pipeline from that phase — the orchestrator owns the whole flow, including restarts.

The Self-Improver improves the pipeline itself, never the product. Its improvement toolkit:

- **Agent prompts** — edit the `.opencode/agents/*.md` that made the wrong decision.
- **Skills** — strengthen a skill recipe or add a new one.
- **Scripts** — fix or harden pipeline scripts.
- **References** — add, edit, or delete useful references in the playbook folder's `references.md` (the shared knowledge the playbooks point at), so lessons persist beyond one issue.
- **Pipeline documentation** — the SI owns the implementation docs: the playbook folder, `references.md`, and the pipeline docs set. **Exception: this principles document (`principles.md`) is above the SI** — the SI follows it and never edits it. Where an improvement would require changing a principle, the SI proposes it to the human and applies it only on approval. When the SI changes the pipeline, it documents the change in the same pass — an improvement that isn't documented is invisible.
- **Product documentation** — the SI is the documentation owner for the whole pipeline. At the audit gate, it runs a **doc-sync step**: classify the merged spec diff into doc categories (`ARCHITECTURE.md`, `CLI_GUIDE.md`, `SETUP.md`, `SECURITY.md`, `FAQ.md`), patch the affected docs, and commit. Product docs are only coherent against the full merged diff — which the SI, running last, is the only agent positioned to see.

**The SI never researches code and carries no telemetry/observability scope.** Code research (reading source, tracing data flows, inspecting spans/telemetry, profiling) and code-level improvements (adding metrics/logs/traces to the product for observability) belong to the **Software Architect** — routed through a triage → implementation cycle, never fixed directly by the SI. The SI's improvement toolkit covers pipeline *mechanics* (prompts, skills, scripts, references, pipeline docs) — not product code.

#### The state machine: owned as an asset, authoritative at runtime

The state machine (the `pipeline-state` script, `pipeline.json`, `state-machine.md`, and the `pipeline-state` skill) is both the pipeline's referee and a pipeline asset. Two distinct relationships, kept separate:

- **Runtime authority is non-negotiable.** During a run, the state machine is the single writer and phase authority (principle 2 point 8), and that authority applies to the Self-Improver exactly like every other agent. The SI never bypasses it — no direct `gh`/`git` pipeline writes, no improvised transitions, no hand-editing the state. The single-writer rule has no owner exemption.
- **Maintenance is the SI's.** The state machine is a pipeline script, and scripts are the SI's improvement toolkit. The SI owns its code: it fixes, hardens, and extends `pipeline-state.rs`, `pipeline.json`, `state-machine.md`, and the `pipeline-state` skill. It is the *only* agent that edits the state machine's logic.

This document — **the principles themselves — are above the SI**. The SI *follows* these principles; it does not own them. Its maintenance authority covers the *implementation* of the principles (scripts, skills, playbooks, implementation docs) — never the principles as the binding contract. The SI may flag a principle-level problem (a rule that caused a failure) to the human, but it cannot rewrite the rules to make a failure pass. Where an improvement would require changing a principle, the SI proposes it to the human and applies it only on approval.

Three gates make that maintenance ownership safe:

1. **The referee must stay honest.** Every state-machine edit must pass `test-scripts.ps1` before it counts — a change that breaks the guards or the metrics is itself a pipeline failure, not an improvement.
2. **Documented in the same pass.** The SI documents the change in the pipeline docs in the same pass as the code (rule: an improvement that isn't documented is invisible).
3. **Anti-tamper line.** The SI edits the state machine's *logic* — guards, transitions, metrics, validation — **never the record**. The event log (`.opencode/state/issues/*.jsonl`), audit verdicts, and error log are append-only and must never be rewritten, edited, or backdated. The record is the evidence the SI judges on; hand-editing it destroys the audit.

**Why the split:** the state machine's *authority* is what makes the pipeline deterministic and its *record* is what makes it auditable — both are structural, not personal. The SI can improve how the machine decides; it can never rewrite what the machine has already recorded.

Its restart decision re-runs the pipeline from the chosen phase — the Self-Improver, as orchestrator, executes the restart itself (it dispatches the triage cluster, the developer pool, and the tester at every phase). The Self-Improver never edits product source code — but it does edit product *documentation*. Stale or missing product docs are a pipeline-quality failure the SI can flag: on audit, if the merged product state doesn't match the docs, that is a failure → restart to Implementation with "sync docs" in scope.

**Status: implemented.** The Self-Improver agent is `.opencode/agents/self-improver.md`, with its steps in `playbooks/self-improver.md`. It orchestrates the whole pipeline (triage → implementation → testing → audit) and then audits: audit → decide → improve (prompts/skills/scripts/references/pipeline-docs) → doc-sync (product docs) → restart, and records its verdict through the state machine's `audit-record` action. The SI never researches code or telemetry — that scope belongs to the Software Architect.

---

## 7. Roles Own One Question; Clusters Plan; Pools Execute

- Each agent owns exactly one fundamental question and stays in its lane (the personality rules in section 1 enforce this).
- **Planning is parallel:** the triage cluster plans together, each consultant from its own discipline, so the Implementation Plan is synthesized from three independent views.
- **Execution is pooled:** developers are interchangeable full-stack practitioners from a pool, staffed per feature by the Staffing Plan — not one bespoke developer per capsule.
- **Testing is single:** one Tester executes the consolidated QA Plan per feature, so there is a single accountable verdict.

---

## 8. Traceability Over Convenience

Every design decision, change, and test result is recorded where it happened — in the issue timeline. Nothing material lives only in an agent's ephemeral context. This is what makes the GitHub-backbone-and-log rule enforceable and what makes the Self-Improver's audit (principle 6) possible — it cannot judge an issue without the record.

---

## 9. Scripts Are Called Through Skills

Every pipeline script (`.opencode/scripts/*.ps1` and the `pipeline-state.rs` state machine) is **invoked through a skill**, and the skill is where the script's usage lives. Agents never run a pipeline script directly from raw knowledge of its name — they **load the skill that documents it and read the skill's instructions first**, then run the exact command the skill specifies.

This means:

- **Every script is documented in a skill.** A script with no skill documenting it is unreachable — it exists only to be wrapped. If a new script is needed, it ships with a skill (or is added to the skill that owns its domain) in the same change.
- **The skill is the interface, not the script.** The skill carries the *why* (when to use it, what it validates, what can go wrong) and the *exact invocation* (flags, argument order, expected output). The agent reads that before running anything.
- **No ad-hoc script usage.** If an agent needs an operation, it does not improvise a `gh`/`git`/PowerShell one-liner that bypasses the documented path — it finds the skill that covers the operation and follows it.
- **The state machine is itself a script, so it follows this rule too:** agents reach it through the `pipeline-state` skill (principle 2 delivery form). Where the harness supports it, this is **enforced at the config level**: opencode's `permission.skill` key can restrict which skills an agent may load, so the load-the-skill step is a hard gate rather than a request.

**Why:** the skill is the anti-drift layer — it keeps the *how* of every script in one place, readable by any agent, so scripts are used correctly and consistently. An agent that calls a script without reading its skill will miss the guards, the required inputs, and the failure modes the skill exists to communicate. This is the same "one source of truth" argument as the minimal-skill/workhorse-script split (principle 2): the skill holds the operational knowledge, the script holds the logic, and the agent consults the skill before touching the script.
