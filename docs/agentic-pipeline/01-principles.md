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

The authoritative home for agent identity is each agent's `.opencode/agents/*.md` file — the catalog page (`02-agents.md`) is only a transitional reference and will be removed once those files are written. **The mechanics for writing a good agent definition — anatomy, length limits, structure, DeepSeek-specific rules, iteration — live in [08-agent-definition-guide.md](08-agent-definition-guide.md), not here.** This rule states the *why*; that guide is the *how*.

---

## 2. A State Machine Gives Each Agent Its Phase Context

Agents are contextual — the same developer behaves differently mid-implementation than during a PR retry. But agents cannot be trusted to figure out "where are we right now?" from raw issue text, and the pipeline needs one deterministic authority for state. That authority is a **state machine**: it determines where each work item is, validates that it is allowed to be there, and injects phase context into every agent that wakes up. An explicit state machine is more reliable than free-text prompting for this.

At the principle level, the state machine does seven things:

1. **It is the pipeline's single source of truth for "where are we?".** Every work item exists in exactly one phase, determined by **observable evidence** (what exists, what has been done, what was recorded) — never by what an agent *says* it did. No agent self-reports its way forward.

2. **Phases are gates, not lanes.** A phase's only purpose is its **Goals** (principle 3) — the definition of done. The machine enforces two gates per phase:
   - **Entry guard (Definition of Ready):** you may not enter until the previous phase *proved* its goals are met.
   - **Exit guard (Definition of Done):** you may not leave until this phase's goals are met.
   The whole pipeline is a chain of "prove it, then move."

3. **It is the pipeline's memory.** Every transition, and the evidence behind it, is recorded. This makes the pipeline auditable, debuggable, and restartable — and it is what makes the GitHub-backbone-and-log principle enforceable.

4. **It injects context, so agents never guess.** Every agent that wakes receives, from the machine: which phase it is in, that phase's Goals, the playbook for it, and what must exist to leave. The agent reads its assignment from state — it does not infer it.

5. **It is a guardrail, not a straitjacket.** The machine governs *boundaries between phases only*. Inside a phase, the agent has full autonomy. **Boundaries validated, freedom inside the loop** — the single most important design line.

6. **It is deterministic; judgment is recorded, not embedded.** The machine's decisions come from real signals. If an LLM judgment is needed ("is this actually blocked?"), the LLM runs as a queried step, writes its verdict to the record, and the machine reads the record. The machine never calls an LLM to decide a transition.

7. **Nothing is ever stranded.** Every phase has a legal exit: forward, rework (loop back, counted), or a terminal ending (done / canceled). "Blocked" is a *condition on a phase*, not a phase — nothing vanishes, nothing gets stuck forever.

### Delivery form: a minimal skill + a workhorse script

The state machine is delivered as two pieces, and the split is deliberate:

- **The script does all the work.** It reads the signals, computes the current phase, validates the guards, and prints the context block. All state logic lives in the script — nowhere else.
- **The skill is minimal.** It does not encode the state model, the phases, the guards, or the goals. It contains only what the agent needs to *invoke* the script and *read* its output: "run the script, here is how to read the context block, here is what to do with it." The skill is a thin loader, not a duplicate of the machine.

**Why:** exactly one source of truth for state logic (the script). If the skill also described phases and transitions, the two would drift — the skill would become stale prose that contradicts the code. The minimal skill keeps the principle of "judgment/state lives in one place" applied to our own tooling.

---

## 3. Every Phase Has Goals

Goals are the **definition of done for a phase** — the measurable outcome that must be achieved before the pipeline advances. They are not instructions ("how to do the work") and not activities ("do X"); they are outcomes ("the feature has a verified Implementation Plan satisfying all backlog requirements").

**Why goals matter (evidence-backed):** role + prime directive + acceptance criteria is the most-circulated high-performing agent pattern (the SNOWFLOW brief), and "define what counts as done and how the model should verify its work" is shared OpenAI/Anthropic guidance. A phase without a goal is a phase where agents work but nothing completes.

Rules:

- **Every phase declares its Goals.** Each phase in [03-pipeline.md](03-pipeline.md) lists its goals up front.
- **Goals are measurable, not aspirational.** "Create a backlog issue with confirmed requirements" — not "understand the feature".
- **Goals are the state machine's exit checks.** A phase's goals are the prior-phase-completeness validation for the next phase. No transition without them.
- **Agents report against goals.** An agent's final report states which goals it met, with evidence — not just what it did.

---

## 4. Agents Link to Their Playbook

Every agent has a **playbook** — a per-agent document in the playbook folder that defines how it works in this pipeline. Each agent profile in `.opencode/agents/*.md` links to its own playbook (and to the pipeline sections that govern it). The links are one-directional:

- **Agent → Playbook:** each agent `.md` links to its playbook in the playbook folder, which defines the agent's phases, artifacts, and conventions.
- **Agent identity** lives **only** in `.opencode/agents/*.md` — never duplicated in a catalog page (`02-agents.md` is a deprecated transitional reference).

This guarantees that when the pipeline changes, there is exactly one authoritative place to update (the playbook), and agents point at it rather than duplicating the rules inline. Agent identity updates happen in the agent's own file.

---

## 5. GitHub Is the Communication Backbone and the Log

All communication between agents happens through GitHub — issues, labels, comments, and sub-issues — never through a shared chat or an ad-hoc channel. GitHub is both our **communication system** and our **log**: everything an agent does or decides is recorded there.

This means:

- **Every artifact** is an issue body, a comment, or a file committed to a branch and referenced from one.
- **Every decision** is a comment prefixed `Decision`.
- **Every open question** is a comment prefixed `Question` (answered with a `Decision`).
- **Every status change** is a comment prefixed `Status`.
- **Every test result** is a comment prefixed `Evidence`.
- **Issues** carry the work; **labels** carry state; **comments** carry the history; **sub-issues** carry the breakdown.

The benefits are deliberate: full auditability, asynchronous handoffs, and a record that outlives any single agent run — GitHub is the pipeline's memory and its source of truth. See [05-github.md](05-github.md).

---

## 6. A Self-Improver Gate Audits Every Issue

Every issue ends with a **Self-Improver** audit, dispatched by the Scrum Master after the Tester's verdict. The Self-Improver decides whether the issue was completed successfully:

- **Success** → the issue is done. The pipeline ends.
- **Failure** → the Self-Improver chooses which phase the pipeline restarts from (Intake, Triage, Implementation, or Testing), **after improving** the thing that caused the failure. The Scrum Master then re-dispatches the pipeline from that phase.

The Self-Improver improves the pipeline itself, never the product. Its improvement toolkit:

- **Agent prompts** — edit the `.opencode/agents/*.md` that made the wrong decision.
- **Skills** — strengthen a skill recipe or add a new one.
- **Scripts** — fix or harden pipeline scripts.
- **References** — add, edit, or delete useful references in the playbook folder's `references.md` (the shared knowledge the playbooks point at), so lessons persist beyond one issue.
- **Observability** — add metrics, logs, or traces to give visibility into failures, so the next audit can see what happened rather than guess.
- **Pipeline documentation** — the SI owns the pipeline docs: the playbook folder, `references.md`, and the pipeline docs set. When the SI changes the pipeline, it documents the change in the same pass — an improvement that isn't documented is invisible.
- **Product documentation** — the SI is the documentation owner for the whole pipeline. At the audit gate, it runs a **doc-sync step**: classify the merged spec diff into doc categories (`ARCHITECTURE.md`, `CLI_GUIDE.md`, `SETUP.md`, `SECURITY.md`, `FAQ.md`), patch the affected docs, and commit. Product docs are only coherent against the full merged diff — which the SI, running last, is the only agent positioned to see.

Its restart decision is returned to the Scrum Master, who re-runs the pipeline from the chosen phase. The Self-Improver never edits product source code — but it does edit product *documentation*. Stale or missing product docs are a pipeline-quality failure the SI can flag: on audit, if the merged product state doesn't match the docs, that is a failure → restart to Implementation with "sync docs" in scope.

**Status: the Self-Improver agent will be designed and completed later.** This principle fixes its place in the flow, its responsibilities, and its improvement toolkit — audit, decide, improve (prompts/skills/scripts/references/observability/pipeline-docs), doc-sync (product docs), restart — so the rest of the pipeline is written against it now.

---

## 7. Roles Own One Question; Clusters Plan; Pools Execute

- Each agent owns exactly one fundamental question and stays in its lane (the personality rules in section 1 enforce this).
- **Planning is parallel:** the triage cluster plans together, each consultant from its own discipline, so the Implementation Plan is synthesized from three independent views.
- **Execution is pooled:** developers are interchangeable full-stack practitioners from a pool, staffed per feature by the Staffing Plan — not one bespoke developer per capsule.
- **Testing is single:** one Tester executes the consolidated QA Plan per feature, so there is a single accountable verdict.

---

## 8. Traceability Over Convenience

Every design decision, change, and test result is recorded where it happened — in the issue timeline. Nothing material lives only in an agent's ephemeral context. This is what makes the GitHub-backbone-and-log rule enforceable and what makes the Self-Improver's audit (principle 6) possible — it cannot judge an issue without the record.
