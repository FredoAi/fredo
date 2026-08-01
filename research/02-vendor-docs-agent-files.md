# Research Report: Vendor Documentation on Agent Definition Files

**Agent:** Research Analyst (vendor docs)
**Date:** 2026-07-31
**Scope:** Anthropic, OpenAI, Google/DeepMind, OpenCode official docs and engineering blogs

---

## 1. Executive Summary — Top 10 Findings

1. **Agents are simple under the hood; complexity is the enemy.** Anthropic: the most successful implementations use "simple, composable patterns rather than complex frameworks," and an agent is "typically just LLMs using tools based on environmental feedback in a loop" (anthropic.com/research/building-effective-agents). OpenAI: "start with a single agent and evolve to multi-agent systems only when needed" (A Practical Guide to Building Agents, p.32).

2. **Every vendor separates "workflows" (predefined code paths) from "agents" (model-directed loops).** Anthropic draws this distinction explicitly. Google calls it an "autonomy continuum." OpenAI: "Applications that integrate LLMs but don't use them to control workflow execution... are not agents" (Practical Guide, p.4). The takeaway for definition files: be explicit about *when* the model decides vs. *when* the harness enforces.

3. **A system prompt has a canonical anatomy, and vendors agree on it.** OpenAI's recommended `developer` message order: **Identity → Instructions → Examples → Context** (platform.openai.com/docs/guides/prompt-engineering). Anthropic's context-engineering post recommends the same via sections: `<background_information>`, `<instructions>`, `## Tool guidance`, `## Output description` (anthropic.com/engineering/effective-context-engineering-for-ai-agents). Claude Code subagents and OpenCode agents both encode this as **YAML frontmatter (metadata/capabilities) + Markdown body (system prompt)**.

4. **Second-person imperative tone, "You are…", is the universal convention.** Anthropic: "Give Claude a role... even a single sentence makes a difference" (`You are a helpful coding assistant specializing in Python.`). Every Claude Code subagent, OpenCode agent example, and OpenAI sample starts the body with "You are…". ⚠️ *Vendors disagree on intensity* (see §6).

5. **Brevity is a top-10 finding at Anthropic specifically.** CLAUDE.md guidance: for each line ask *"Would removing this cause Claude to make mistakes? If not, cut it."* — "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!" (anthropic.com/engineering/claude-code-best-practices). Anthropic 2026 blog: "Longer, more complex prompts are NOT always better." OpenAI's practical guide and Google's strategies do **not** push brevity this hard — Google even says "We recommend to always include few-shot examples."

6. **Tools and permissions are as important as the prompt — treat tools as part of the prompt.** Anthropic's SWE-bench team "spent more time optimizing our tools than the overall prompt" (Building effective agents, Appendix 2). Google: "If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better" (Context engineering). Tool definitions should be written "like a great docstring for a junior developer" — include example usage, edge cases, and clear boundaries from similar tools.

7. **Scope control is layered and deterministic, not prompt-asky.** All four vendors ship a permission system orthogonal to the system prompt: OpenCode `permission` keys (`read/edit/bash/task/skill/external_directory`, allow/ask/deny, glob patterns, last-match-wins); Claude Code permission modes + hooks + sandboxing; OpenAI guardrails (input/output/tool, tripwires, human-review checkpoints); Google managed-agent sandboxes with network allowlists and least-privilege credentials. Anthropic's key insight: **instructions are advisory, hooks are deterministic** — put rules that must always hold in enforced layers, not prose.

8. **Verification loops beat autonomous faith.** Anthropic's #1 Claude Code practice: "Give Claude a check it can run: tests, a build, a screenshot." OpenAI: "define what counts as done and how the model should verify its work." Google: "Always verify outputs... before deploying them." Best agent definitions bake in a *termination/verification condition* rather than "keep working."

9. **Evaluation and iteration are expected, not optional.** OpenAI's classic six strategies end with "test changes systematically" and its 2026 docs say "building tests and evaluation suites that measure prompt behavior" (pinning model snapshots). Anthropic's prompt-engineering overview says start from (1) success criteria, (2) empirical tests, (3) a draft prompt. Google's strategies page: "Prompt engineering is iterative. Experiment and refine." OpenCode is the outlier: it documents the *mechanics* of agents but has no published evaluation methodology.

10. **Context is a finite budget; design for it explicitly.** Anthropic's context-engineering post (Sep 2025) reframes the field: find "the smallest possible set of high-signal tokens." Practical consequences: put persistent rules in a file loaded up front (CLAUDE.md/AGENTS.md), load long reference material on demand (skills), keep per-agent prompts short, and make tools return token-efficient results. OpenAI and Google echo this (progressive disclosure; context-first/long-form-data-at-top with queries at the end, which Anthropic measured at up to +30% quality).

---

## 2. Vendor-by-Vendor Breakdown

### 2.1 Anthropic

Sources fetched:
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents) (Dec 2024)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Sep 2025)
- [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [Prompt engineering overview](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview)
- [Prompting best practices](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices) (living reference)
- [Best practices for prompt engineering for 2026](https://claude.com/blog/best-practices-for-prompt-engineering) (Nov 2025)
- *(The URL `anthropic.com/engineering/writing-effective-prompts` 404s — that guidance now lives in the "Prompting best practices" docs page above.)*

**Core recommendations**

*Workflows vs agents.* Workflows = LLMs+tools in predefined code paths (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer). Agents = the model dynamically directs its own process. Start with single LLM calls + retrieval; add agentic complexity "only when it demonstrably improves outcomes." Three principles: **simplicity, transparency (show planning steps), and a well-crafted agent-computer interface (ACI)**.

*System prompt construction (context engineering).* Set the "right altitude": neither hardcoded brittle if-else logic nor vague guidance that "falsely assumes shared context." Structure the prompt into distinct tagged sections. "Minimal does not necessarily mean short." Start with a minimal prompt on the best model, then add instructions/examples only to fix observed failure modes.

*Length and format.* Explicitly: "think of Claude as a brilliant but new employee." Be direct, provide the *why* (motivation improves compliance), use 3–5 well-crafted `<example>`/`<examples>`-wrapped examples, use XML tags for structure, put longform context at the top and the query at the end (measured up to +30%). Tell the model *what to do*, not what not to do.

*Autonomy vs. guardrails.* Give explicit balancing prompts for risky actions (deleting files, force-pushing, posting externally → "ask the user before proceeding"). Provide a "default_to_action" vs "conservative action" knob in the system prompt. Newer models over-trigger tools, so "dial back any aggressive language" (don't write "CRITICAL: you MUST…").

*Tools = ACI.* Poka-yoke tools (e.g., require absolute filepaths to prevent relative-path bugs). Keep formats close to natural text (diffs are hard for models; full-file rewrites are easier). Test how the model uses each tool and iterate — tool work can dominate prompt work.

*Agent definition files (Claude Code subagents).* Markdown file with YAML frontmatter (`name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation`, `color`, `initialPrompt`); the **body is the system prompt** and is the *only* system prompt the subagent gets (plus minimal env info — not the full Claude Code system prompt). The `description` is what the orchestrator uses to decide when to delegate. Context-saving pattern: subagents return condensed summaries (1,000–2,000 tokens).

*Iteration.* "Treat CLAUDE.md like code: review it when things go wrong, prune it regularly, and test changes by observing whether Claude's behavior actually shifts." If you've corrected the model twice on the same issue, `/clear` and write a better initial prompt.

### 2.2 OpenAI

Sources fetched:
- [Prompt engineering guide](https://platform.openai.com/docs/guides/prompt-engineering) (living; classic six-strategy version historically lived here)
- [Agents SDK guide](https://platform.openai.com/docs/guides/agents)
- [Reasoning models guide](https://developers.openai.com/api/docs/guides/reasoning)
- [A practical guide to building agents (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) — 34 pages, fully extracted

**Core recommendations**

*The classic six strategies* (from the prompt-engineering guide; still the framing OpenAI taught the field): (1) write clear instructions, (2) provide reference text, (3) split complex tasks into simpler subtasks, (4) give the model time to "think" (CoT), (5) use tools, (6) test changes systematically.

*System prompt anatomy (explicit and prescriptive).* A `developer` message (higher authority than `user`; think "function definition, user messages are the arguments") should contain, in order: **Identity** (purpose, communication style, goals), **Instructions** (do/don't rules, incl. tool-calling guidance), **Examples**, **Context** (data, positioned last). Use Markdown headers + XML tags for logical boundaries; XML attributes can carry metadata.

*Model-tier prompting differences.* Reasoning models (o-series / GPT-5 family) = "senior co-worker": give a goal, constraints, and an output contract **without prescribing every intermediate step**; treat `reasoning.effort` as a tuning knob; "define what counts as done and how the model should verify its work." GPT models = "junior coworker": benefit from very precise instructions. Pin model snapshots and build eval suites because behavior shifts across snapshots.

*Agent-specific prompting (GPT-5 agentic).* Instruct the model to "keep going until the user's query is completely resolved" and reflect after each tool call; require a preamble before notable tool calls ("Before you call a tool explain why you are calling it"); use a TODO tool to track progress. For function-calling loops, preserve reasoning items across calls.

*The practical guide's instruction best-practices* (p.11): derive agent routines from existing operating procedures/policy documents; **break tasks into smaller, clearer steps**; **define clear actions** (every step maps to a concrete action or output — even the wording of a user-facing message); **capture edge cases** (incomplete input, unexpected questions, conditional branches). You can use a capable model to convert a policy document into a numbered-list instruction set.

*Orchestration.* Single-agent-first. Split into multiple agents when: (a) prompts accumulate many if-then-else branches, or (b) **tool overload from similarity/overlap**, not count — "some implementations successfully manage more than 15 well-defined, distinct tools while others struggle with fewer than 10 overlapping tools." Multi-agent patterns: **Manager** (agents as tools) and **Decentralized** (handoffs). Use prompt templates with policy variables instead of a proliferation of near-identical prompts.

*Guardrails & human review.* Layer guardrails (relevance classifier, safety classifier/jailbreak detection, PII filter, moderation, tool-risk ratings, rules-based regex, output validation). Escalate to a human on failure thresholds or high-risk/irreversible actions. "Think of guardrails as a layered defense mechanism" — a single one is insufficient.

*Tools.* Three types: Data, Action, Orchestration (agents as tools). Standardize tool definitions for many-to-many reuse.

### 2.3 Google / DeepMind

Sources fetched:
- [Prompt engineering strategies](https://ai.google.dev/gemini/docs/prompting-strategies)
- [System instructions / Text generation](https://ai.google.dev/gemini-api/docs/system-instructions)
- [Gemini API — Agents overview (managed agents)](https://ai.google.dev/gemini-api/docs/agents)
- (The [Agents whitepaper](https://www.kaggle.com/whitepaper-agents) — "Agents" by Julia Wiesinger, Patrick Marlow, Vladimir Vuskovic — is JS-rendered at Kaggle and its storage PDF URL is no longer resolvable; the Gemini docs above are used as the verified Google sources. The DeepMind blog URL `deepmind.google/discover/blog/agents/` also 404s as of this research.)

**Core recommendations**

*Prompt anatomy & strategy.* Prompts have **Instructions, Input, Context, Constraints**. Explicitly recommend: few-shot examples ("always include few-shot examples in your prompts... you can remove instructions if examples are clear enough"), consistent formatting across examples (identical XML tags, whitespace, splitters), and watch for overfitting with too many examples. Break complex prompts into components; chain prompts sequentially; aggregate parallel results.

*Gemini 3 prompting rules* (most current guidance): be **precise and direct**; use **consistent structure — "XML-style tags (e.g., `<context>`, `<task>`) or Markdown headings are effective. Choose one format and use it consistently"**; define parameters explicitly; control verbosity explicitly; **prioritize critical instructions** (persona, behavioral constraints, output format) in the System Instruction or the very top of the user prompt; **structure for long contexts** — supply all context first, put instructions/questions at the very end, and "anchor" with a transition ("Based on the information above…").

*System instructions.* Pass role/persona via `system_instruction` ("You are a cat. Your name is Neko."). Keep model parameters (temperature/topP/topK) at defaults for Gemini 3.x — a notable contrast to OpenCode's per-agent temperature controls.

*Reasoning.* Gemini 2.5/3 think internally; "generally not necessary to have the model outline, plan, or detail reasoning steps in the returned response." For hard problems, a simple "Think very hard before answering" improves performance at the cost of tokens.

*Agents (managed agent harness).* A configurable agent = a Linux sandbox where the agent reasons, executes code, manages files, browses the web; you configure the model and "extend it with your own **instructions, skills, and data**." Security posture: OS-level sandbox isolation, outbound-network **allowlist**, use only trusted tools with least-privilege credentials, "only provide credentials whose full scope you are willing to grant," **human oversight / verify outputs**, and expect 100k–3M tokens per task.

*Iteration.* "Prompt engineering is iterative. These guidelines and templates are starting points. Experiment and refine." Concrete iteration levers: rephrase, switch to an analogous task, reorder prompt content (examples/context/input permutations).

### 2.4 OpenCode

Sources fetched:
- [Agents docs](https://opencode.ai/docs/agents/)
- [Intro / AGENTS.md](https://opencode.ai/docs/)
- [Agent Skills docs](https://opencode.ai/docs/skills/)
- [Permissions docs](https://opencode.ai/docs/permissions/)
- (OpenCode is the project this repo builds on; its docs are the authoritative spec for `.opencode/` definitions.)

**Core recommendations**

*Agent types.* **Primary agents** (you interact with directly; `Tab` to switch) vs **subagents** (invoked automatically by the primary via the `task` tool based on their descriptions, or manually via `@mention`). Built-ins illustrate the intended design: **Build** (all tools, edit+write+patch+bash), **Plan** (read-only; edit/bash set to `ask`), **Explore** (read-only search), **General** (full minus todo), **Scout** (external docs research), plus hidden system agents (compaction, title, summary).

*Definition format.* Markdown file whose **filename becomes the agent name**, in `~/.config/opencode/agents/` (global) or `.opencode/agents/` (per-project). YAML frontmatter + prompt body. `description` is **required** — it drives automatic delegation.

*Fields.* `description`, `mode` (`primary`/`subagent`/`all`, default `all`), `model` (`provider/model-id`), `temperature`, `top_p`, `steps` (max agentic iterations; forces a text summary when exhausted), `prompt` (inline string or `{file:./path}`), `permission`, `tools` (deprecated → permission), `disable`, `hidden`, `task` permissions (glob control over which subagents an agent may spawn), `color`, plus **pass-through of arbitrary provider options** (e.g., `reasoningEffort`, `textVerbosity`).

*Permissions = scope control.* Keys: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite`, `webfetch`, `websearch`, `lsp`, `skill`, `question`, `doom_loop`. Values: `allow`/`ask`/`deny` (shorthand) **or object maps** (granular glob → action; **last matching rule wins**, so put `"*"` first, specifics after; `"git *": "ask"` etc.). Wildcard patterns work against tool names, so `mcp_server_*` gates an entire MCP server. Defaults are permissive; `.env` reads denied; `external_directory`/`doom_loop` default to `ask`.

*Skills.* `.opencode/skills/<name>/SKILL.md` (also `.claude/skills/`, `.agents/skills/`). Frontmatter: `name` (required, `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars, must match dir name), `description` (required, 1–1024 chars — "specific enough for the agent to choose correctly"), optional `license`, `compatibility`, `metadata`. Skills are **discovered by description and loaded on demand** via the native `skill` tool — the pattern for keeping context small. Skills can be permission-gated per agent.

*How agents/skills/rules link.* Skills are listed in the `skill` tool's description as `<available_skills>` entries (name + description only — full content loads on `skill({name})` call). Rules (AGENTS.md) load at session start; skills load on demand; agents bind a prompt + model + permissions; agents can restrict which subagents (`permission.task`) and skills (`permission.skill`) they may invoke. This is the "progressive disclosure" architecture Anthropic recommends.

---

## 3. OpenCode Agent File Format — Concrete Specification

**Location:** `.opencode/agents/<name>.md` (project) or `~/.config/opencode/agents/<name>.md` (global). Filename ⇒ agent name. (Agents can also be declared in `opencode.json` under `"agent": {...}`.)

**Structure:**

```markdown
---
description: Reviews code for quality and best practices      # REQUIRED — drives auto-delegation
mode: subagent                                                # primary | subagent | all (default all)
model: anthropic/claude-sonnet-4-20250514                     # provider/model-id
temperature: 0.1                                              # 0.0–1.0 (defaults: 0, or 0.55 Qwen)
steps: 20                                                     # max agentic iterations (renamed from maxSteps)
permission:                                                   # allow | ask | deny | glob-object
  edit: deny
  bash: "*": ask
  "git diff": allow
  task: "*": deny                                             # gate which subagents this agent may spawn
  skill: "internal-*": allow                                  # gate which skills may load
hidden: true                                                  # hide from @ menu (subagents only)
color: "#ff6b6b"                                              # UI accent
reasoningEffort: high                                         # any extra key passes through to provider
---

You are a code reviewer. Focus on:
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations

Provide constructive feedback without making direct changes.
```

Key mechanics:
- The body is the **system prompt**; there is no additional prompt-assembly system on top of it for a single agent.
- `description` and model/tool metadata are what the runtime exposes to the orchestrating agent — write the description for *selection* ("when X, use this"), not just as a label.
- Permission keys match tool names with globs; last matching rule wins; `deny` on a subagent's `task` entry removes it from the tool description entirely so the model never attempts it.
- `hidden: true` hides from the user `@` menu but still allows programmatic invocation via the task tool — the mechanism for internal helper agents.
- Skills link via `permission.skill` and are loaded only when the `skill` tool is called; `permission: {skill: deny}` removes the `<available_skills>` block entirely.
- The `prompt` field accepts `{file:./path}` to keep long prompts in separate files (relative to the config file).

---

## 4. Actionable Recommendations for Writing an Agent `.md` Definition File

Synthesized from all four vendors; applies directly to `.opencode/agents/*.md`, `.claude/agents/*.md`, and similar formats.

1. **Start the frontmatter with a selection-grade `description`, not a title.** The description is how the orchestrator finds and chooses the agent (Anthropic: "Claude uses each subagent's description to decide when to delegate"; OpenCode: "This is a required config option"). Format: *"Does X. Use when [trigger scenario]."* — and follow OpenCode's length discipline (1–1024 chars, specific enough to choose correctly).

2. **Open the body with one second-person identity sentence.** `You are a <senior/security/code-review> <role> specializing in <domain>.` This single line is the highest-leverage instruction (Anthropic: "even a single sentence makes a difference"). Keep the role grounded — OpenAI's model spec and Anthropic's 2026 blog both warn against grandiose persona inflation ("You are a world-renowned expert who never makes mistakes" hurts).

3. **Follow the canonical section order: Identity → Responsibilities → Rules/Guardrails → Workflow → Output/Verification.** This mirrors OpenAI's `Identity → Instructions → Examples → Context` and Anthropic's tagged-section guidance. Use Markdown headings (or consistent XML tags) to delimit sections — Google: "Choose one format and use it consistently."

4. **State responsibilities as concrete actions with explicit do/do-not, and give the *why*.** Anthropic: "Your response will be read aloud by a TTS engine, so never use ellipses" outperforms "NEVER use ellipses." OpenAI practical guide: every step should map to a specific action or output — even the wording of a user-facing message.

5. **Write the guardrails section as a reversible-action policy, not a prohibition dump.** "Ask before actions that are hard to reverse, affect shared systems, or are destructive (deletes, force-push, posting externally); act freely on local, reversible actions" (Anthropic's autonomy-vs-safety prompt, near-verbatim). Prefer positive formulations ("confirm before" over "NEVER do").

6. **Express autonomy in degrees, not absolutes.** Pick one stance for the agent: default-to-action ("by default implement, infer intent, discover via tools rather than guessing") vs. conservative ("when ambiguous, provide information and recommendations; only act when explicitly asked"). Anthropic supplies both canned prompts — copy the pattern.

7. **Give every step a verification condition.** Anthropic's single most-repeated practice: give the agent a check it can run (test, build, screenshot, lint) and instruct it to iterate until the check passes; require *evidence* (test output, command results) rather than self-reporting success. OpenAI: "define what counts as done and how the model should verify its work." End the workflow with "verify, then summarize what you changed."

8. **Prefer a small, well-documented tool/permission surface over prose warnings.** Enforce scope in `permission:` (allow/ask/deny, glob patterns, `task`/`skill` gates) rather than pleading in the prompt. Anthropic's rule of thumb: "If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better" → give each agent the minimal tool set, with distinct, unambiguous names and parameter docs. Use `external_directory`/`ask` for anything outside the workspace.

9. **Ship knowledge as skills, not as prompt length.** Keep the agent file short (Anthropic's "would removing this cause mistakes?" prune test; skills docs: "keep the body concise — every line is a recurring token cost"). Put domain reference material in a SKILL.md that loads on demand, and gate it with `permission.skill`. If the agent file runs long, extract procedures to skills and reference them.

10. **Put stable identity/rules first and volatile context last.** Anthropic's long-context findings: longform data at top, the actual query/instruction at the end; "Queries at the end can improve response quality by up to 30 percent." In a definition file, ordering is fixed, so: identity + immutable rules at top; task-specific context bottom.

11. **Use 3–5 diverse, relevant examples instead of exhaustive edge-case lists.** Anthropic: examples are "the pictures worth a thousand words"; a laundry list of edge cases is discouraged. Google: examples should be *consistently formatted* (matching XML tags, whitespace) and can sometimes replace explicit instructions. Show the *desired output format* in the examples.

12. **Don't prescribe the model's internal reasoning.** For capable models, give goal + constraints + output contract and let it plan (OpenAI reasoning guidance; Google: models reason internally — don't force them to emit their plan; Anthropic: "Prefer general instructions over prescriptive steps. A prompt like 'think thoroughly' often produces better reasoning than a hand-written step-by-step plan"). Reserve step-by-step lists for *external* workflow sequencing that the agent must follow.

13. **Give the model permission to be uncertain.** "If the data is insufficient, say so rather than speculating" — an explicit, cheap reliability instruction (Anthropic 2026 blog).

14. **Write prompts at the "right altitude."** Neither brittle hardcoded logic nor vague guidance that assumes shared context (Anthropic context engineering). If a rule needs to be enforced without exception, move it out of prose into a deterministic layer (hooks/policies), because instructions are advisory.

15. **Iterate empirically, and treat the file like code.** Establish success criteria before drafting (Anthropic overview). Run evals; pin models; when behavior doesn't shift after editing, prune or rewrite rather than adding more lines. When in doubt, the best prompt "is the one that achieves your goals reliably with the minimum necessary structure."

---

## 5. Where Vendors Disagree (flags)

| Topic | Anthropic | OpenAI | Google | OpenCode |
|---|---|---|---|---|
| **XML tags** | Docs recommend them; 2026 blog: "less necessary with modern models" — headings/whitespace may suffice | Recommends Markdown + XML tags for boundaries | Recommends "XML-style tags or Markdown headings… choose one and be consistent" | No guidance (Markdown body) |
| **Role prompting** | "Give Claude a role" (docs) vs. "heavy-handed role prompting often unnecessary" (2026 blog) | Defines role as part of Identity | Persona belongs in system instruction | All examples use "You are…" |
| **Step-by-step instructions** | "Think thoroughly" beats hand-written step plans; prescriptive steps are brittle | GPT models need explicit steps; reasoning models do NOT | Models reason internally; don't force outline-of-plan output | N/A |
| **Length/brevity** | Strongest brevity push (CLAUDE.md prune test) | Prefers precise instructions; no brevity doctrine | "Always include few-shot examples" (length-positive) | Description length capped (1–1024) |
| **Temperature/params** | Not emphasized | `reasoning.effort` is the tuning knob | Keep temperature/topP/topK at defaults for Gemini 3.x | First-class per-agent `temperature`/`top_p` |
| **Autonomy vs. workflow** | Workflows vs. agents; add complexity only when proven | Single-agent first; split on logic-complexity or tool-overlap | Autonomy continuum (whitepaper); managed sandboxes | Enforced via `steps` cap + permission modes |
| **Guardrails** | Permissions/hooks/sandboxing; instructions are advisory | Guardrails as first-class runtime objects (input/output/tool tripwires) + human review | OS-level sandbox + network allowlist + least-privilege creds | `permission` allow/ask/deny + `ask`-mode UI |
| **Chain-of-thought prompting** | Prefer native thinking; manual CoT is a fallback | Reasoning models don't need CoT prompts | "Think very hard before answering" works; don't make it emit reasoning | N/A |

---

## 6. Source List

**Anthropic**
1. https://www.anthropic.com/research/building-effective-agents
2. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
3. https://www.anthropic.com/engineering/claude-code-best-practices
4. https://code.claude.com/docs/en/how-claude-code-works
5. https://code.claude.com/docs/en/sub-agents
6. https://code.claude.com/docs/en/skills
7. https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview
8. https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices
9. https://claude.com/blog/best-practices-for-prompt-engineering

**OpenAI**
10. https://platform.openai.com/docs/guides/prompt-engineering
11. https://platform.openai.com/docs/guides/agents
12. https://developers.openai.com/api/docs/guides/reasoning
13. https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf

**Google / DeepMind**
14. https://ai.google.dev/gemini/docs/prompting-strategies
15. https://ai.google.dev/gemini-api/docs/system-instructions
16. https://ai.google.dev/gemini-api/docs/agents
17. https://www.kaggle.com/whitepaper-agents (Agents whitepaper — not machine-readable; listed for reference, content not independently verified here)

**OpenCode**
18. https://opencode.ai/docs/
19. https://opencode.ai/docs/agents/
20. https://opencode.ai/docs/skills/
21. https://opencode.ai/docs/permissions/

*Note: `anthropic.com/engineering/writing-effective-prompts`, the Simon Willison Claude Code system-prompt teardown URL, and `deepmind.google/discover/blog/agents/` all returned 404 during this research; the equivalent guidance was captured from the Anthropic docs/blog URLs above.*
