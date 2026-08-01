# Research Report: Agent File Formats — Conventions, Benchmarks, Best Practices

**Agent:** Research Analyst (format survey)
**Date:** 2026-07-31
**Scope:** Agent `.md`/`.mdc` definition formats across tools, how runtimes construct prompts, community best-agent collections, measured evals of prompt/agent-definition styles

---

## 1. Executive Summary (Top 10 Findings)

1. **The industry has converged on one format: Markdown with YAML frontmatter.** opencode (`.opencode/agents/*.md`), Claude Code (`.claude/agents/*.md`), Cursor (`.cursor/rules/*.mdc`), VS Code (`.instructions.md`), Cline/Claude skills (`SKILL.md`), and agent-framework prompts all use *frontmatter = machine-readable config, body = system prompt*.

2. **`description` is the single most consequential field.** It is the *routing contract*: the model uses it to decide when to delegate a task, and the UI uses it for `@`-mention autocomplete. opencode marks it "required"; Claude Code says "Claude uses each subagent's description to decide when to delegate"; Cline caps skill descriptions at 1024 chars for exactly this reason. Anthropic's production post-mortem found vague delegation descriptions cause subagents to duplicate each other's work.

3. **Tool access moved from prose to structured permissions.** The modern pattern is frontmatter `permission`/`tools` maps with `allow | ask | deny` and glob patterns (opencode `permission: {bash: {"git push": "ask"}}`; Claude Code `tools`/`disallowedTools`/`permissionMode`), not instructions like "only read files". Least-privilege is now declarative, not behavioral.

4. **The body is a pure system prompt; everything structural lives in frontmatter.** Claude Code: "The frontmatter defines the subagent's metadata and configuration. The body becomes the system prompt." A well-formed agent file keeps identity/behavior (body) and runtime config (frontmatter) cleanly separated.

5. **Context is the scarce resource and every format feature exists to conserve it.** Progressive skill loading (~100 tokens metadata only until triggered), subagents with their own context windows, `isolation: worktree`, repo maps, and `maxTurns` are all token-management mechanisms. Anthropic's measured analysis: token usage alone explains ~80% of variance on the BrowseComp browsing eval.

6. **The strongest measured evidence is that prompt/tool-definition engineering moves agent results by large margins** — not the model's "persona" but the interface definition. SWE-agent's custom prompt+tool interface raised SWE-bench pass@1 from ~4.8% to 12.5% over non-interactive prompting; Anthropic reports tool-description refinements alone produced SOTA SWE-bench Verified and a ~40% reduction in task completion time.

7. **"Persona/emotion" prompt research is real but contested and irrelevant to production agent files.** EmotionPrompt reported +8% (Instruction Induction) and +115% (BIG-Bench) relative gains; subsequent replications were mixed. The Prompt Report's meta-analysis shows role prompting yields *small, inconsistent* effects. Production agent files should optimize routing, scope, and verification — not add motivational personas.

8. **Best-shared community definitions converge on a compact skeleton:** specific description → one-line role identity → explicit in-scope/out-of-scope → concrete examples → verification/exit criteria → least-privilege permissions. High-star collections (awesome-cursorrules 40.5k★, awesome-opencode 9.3k★) are trending toward *anti-hallucination / anti-overengineering / anti-sycophancy* guardrails and verification-gated workflows.

9. **Conciseness is measured wisdom, not style preference.** Anthropic's official guidance: bloated `CLAUDE.md`/agent files cause the model to *ignore* rules; for each line ask "would removing this cause mistakes?" Cursor: keep rules under 500 lines; Cline: keep SKILL.md under 5k tokens. Long rule files correlate with reduced adherence — this is operational evidence, not benchmark data.

10. **There is no public benchmark that compares agent-definition *files* directly** (e.g., "subagent.md format A vs B" on SWE-bench). Evals compare *prompts + tool interfaces* as a unit (SWE-bench harness papers, aider leaderboards, Anthropic evals). Any "best agent file structure" claim is therefore grounded in measured adjacent evidence plus documented vendor practice, and should be validated with your own evals.

---

## 2. Agent File Format Comparison Table

| Tool | File location / format | Supported fields | What the format emphasizes |
|---|---|---|---|
| **opencode** | `.opencode/agents/*.md` (also JSON in `opencode.json`); `~/.config/opencode/agents/` | `description` (required), `mode` (primary/subagent/all), `model`, `temperature`, `steps`/`maxSteps`, `permission` (tool→allow/ask/deny, glob-supported), `tools` (deprecated), `hidden`, `color`, `top_p`, `task` (which subagents can be spawned) | Routing via description; declarative least-privilege permissions; per-agent model/temperature; primary-vs-subagent lifecycle; pass-through provider options |
| **Claude Code** | `.claude/agents/*.md`, `~/.claude/agents/`, plugin `agents/`, `--agents` JSON | `name` (required), `description` (required), `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills` (preload), `mcpServers`, `hooks`, `memory` (user/project/local), `background`, `effort`, `isolation` (worktree), `initialPrompt`, `color` | Context isolation (own window, background/worktree), tool allow/deny lists, model cost routing, persistent memory, skills preloading — richest schema of the group |
| **Cursor rules** | `.cursor/rules/*.mdc`; plus `AGENTS.md` (plain) | `description`, `globs`, `alwaysApply` (+ free-form body; can `@file` reference) | *When* a rule loads (always / by file-glob / by description relevance / manual) — the most developed application-triggering logic |
| **VS Code Copilot** | `.github/copilot-instructions.md`, `*.instructions.md`, `AGENTS.md`, `.claude/rules` | `name`, `description`, `applyTo` (glob) — plus scope tiers (user > repo > org) | Conditional file-scoped instruction application and instruction precedence |
| **Cline** | `.cline/agents/` (subagents), `.cline/skills/*/SKILL.md`, `.clinerules/` | Skills: `name` (must match dir), `description` (≤1024 chars, must be specific). Subagents: prompt + tool set, read-only by default | On-demand progressive loading (metadata→instructions→resources); read-only research subagents; description-driven auto-triggering |
| **Gemini (API/Gems)** | System instructions as a first-class API parameter; Gems = custom agents (instructions + optional knowledge files) | Behavior instructions; separate from conversation context; knowledge upload | Clean separation of "how to behave" (system) vs "what to know" (knowledge/RAG); no file-format convention, API-native |
| **OpenAI GPTs** | Builder GUI (no canonical file); exportable JSON | Name, description, conversation starters, instructions, knowledge (files), capabilities, actions (OpenAPI) | Behavior (instructions) vs knowledge (files) separation; positive "do X" instructions over prohibition lists; examples for classifications |
| **Aider** | No agent files — `CONVENTIONS.md` loaded via `/read` or `.aider.conf.yml` `read:`; chat modes | Convention rules as plain markdown (prefer lib X, use types) | Content over structure: a "best prompt for the task" repo of conventions; repo map for code context |

---

## 3. What the Best-Shared Agent Definitions Have in Common

Based on the documented built-ins (opencode build/plan/general/explore/scout; Claude Code Explore/Plan/general-purpose) and the highest-star community collections (awesome-cursorrules 40.5k★, awesome-opencode 9.3k★, awesome-llm-skills 1.4k★):

1. **A routing-ready description** — action verbs, when-to-use, and what the agent is for, written so the *model* (not a human) can match it to a task. Vague descriptions are the #1 failure mode called out by both Anthropic and Cline.
2. **A crisp role-identity opening line** — "You are a senior security engineer…", "You are a technical writer…" — one sentence, then behavior. Present in every official opencode/Claude Code example.
3. **Explicit scope: what to do AND what NOT to do** — community rules increasingly encode "anti-sycophancy", "anti-overengineering", "anti-hallucination" guardrails (e.g., "never invent APIs or signatures", "keep changes scoped to the request").
4. **Concrete examples over abstractions** — both Anthropic and Cursor guidance state the model responds better to examples (desired/avoided code pairs) than to rules.
5. **Verification / exit criteria** — the strongest convergence in current practice: "run the tests and report the output", "address the root cause, don't suppress the error", `/goal` conditions, Stop hooks. Anthropic calls giving the agent "a check it can run" the difference between a watched session and an autonomous one.
6. **Least-privilege tools declared in frontmatter, not prose** — read-only research agents (`explore`/`plan` deny edits), review agents deny bash, etc.
7. **Positive instructions over prohibition lists** — OpenAI's GPT guidance and VS Code both recommend "Do X" over long "Don't do Y" lists.
8. **Conciseness and front-loading** — Cursor: rules under 500 lines, split into composable rules; Cline: important info first because the file is read sequentially; Anthropic: prune to the point where "removing it would cause mistakes".
9. **References to canonical files, not copies** — `@file.ts`, `@docs/guidelines.md` instead of pasting file contents, which keeps definitions short and non-stale.
10. **Global vs project scoping** — best teams keep general-purpose definitions at user/global scope and codebase-specific ones in-repo, version-controlled.

---

## 4. Benchmarks & Evals of Agent Prompt / Definition Styles

| Source | What was measured | Result | Evidence tier |
|---|---|---|---|
| **SWE-bench** (arXiv 2310.06770, ICLR 2024) | 2,294 real GitHub issues; baseline for agentic coding. Best model (Claude 2) resolved 1.96% | Established the benchmark; showed naive prompting is insufficient for multi-file tasks | Measured (public benchmark) |
| **SWE-agent: Agent-Computer Interfaces** (arXiv 2405.15793) | Effect of custom prompt+tool interface (ACI) on the same base model | pass@1 **12.5%** SWE-bench, **87.7%** HumanEvalFix, "far exceeding the previous state-of-the-art" — the interface/prompt design, not model alone | Measured, peer-reviewed (ICLR 2025) |
| **Aider LLM Leaderboards** (aider.chat/docs/leaderboards) | 225+ polyglot tasks, fixed prompt, varying models/edit formats; repo-map variant measured | Repo map (symbol-level code context injected into prompt) measurably improves results vs. no map | Measured, self-run harness |
| **Anthropic multi-agent research system** (2025) | Multi-agent vs single-agent on internal research eval + BrowseComp | +90.2% relative vs single-agent; **token usage explains 80% of BrowseComp variance**; prompt engineering described as "our primary lever" — vague subagent task descriptions caused duplicated work | Measured (internal, vendor-reported) |
| **Anthropic — Writing effective tools for agents** (2025) | Tool descriptions/specs iterated via eval-driven loop | Tool-description refinements → Claude Sonnet 3.5 SOTA on SWE-bench Verified; tool-doc rewrite cut task completion time ~40%; response format (XML/JSON/MD) measurably affects performance | Measured (internal, vendor-reported) |
| **EmotionPrompt** (arXiv 2307.11760) | Emotional/persona stimuli added to prompts, 45 tasks | +8.00% relative (Instruction Induction), +115% (BIG-Bench); 10.9% avg human-study improvement | Measured but **contested** — multiple independent replications failed to reproduce |
| **The Prompt Report** (arXiv 2406.06608, TMLR 2025) | Meta-analysis of entire prefix-prompting literature incl. role prompting | Role/persona prompting has **small, inconsistent** effects; systematic taxonomy of 58 techniques | Systematic review |
| **Claude Code best practices** (Anthropic) | Operational guidance from internal usage | Context-window degradation is the dominant constraint; bloated instruction files → rules ignored; verification loops are the highest-leverage change | Anecdotal/operational (vendor-reported, no numbers) |
| **OpenAI — A Practical Guide to Building Agents** (2025) | Vendor best practices (PDF) | Concrete prompt guidance: keep prompts <~1,500 words, structure instructions, specify steps | Anecdotal/operational (vendor) |

**Honest gap assessment (flag):** No public benchmark compares "agent definition file structures" head-to-head (e.g., two subagent.md files differing only in structure, run on SWE-bench). What *is* measured is (a) the combined prompt+tool interface (SWE-agent), (b) token/context economy (Anthropic BrowseComp analysis), (c) tool-description wording (Anthropic tools post), and (d) persona/emotion effects in general NLP tasks (mixed). Recommendations in §5 therefore rest on measured adjacent evidence + consistent vendor practice, and you should A/B them on your own eval set.

---

## 5. Recommendations — Structure of a Good AI Agent `.md` Definition File

Numbered and specific. Frontmatter = config the runtime reads; body = system prompt the model reads. Keep them separate.

1. **Frontmatter: `name` (or match filename) + `description` — and write the description for a routing model, not a human.** Make it specific, action-verb-led, with trigger conditions: *"Reviews code for quality and best practices. Use after code changes."* (pattern from Claude Code docs). A vague description silently disables the agent.
2. **Declare `mode`/`permissionMode` and least-privilege tools in frontmatter, not in prose.** For a review/research agent: `permission: {edit: deny, bash: deny}` (opencode) or `tools: Read, Grep, Glob` (Claude Code). Reserve `allow`/`bypass` for build agents. If your tool supports per-command rules, allowlist the safe subset (`git status *`, `grep *`) rather than blanket-allowing bash.
3. **Open the body with a one-line role/identity statement, then a one-paragraph mission.** Mirror the canonical example: *"You are a senior security engineer. Review code for…"* Keep it to 2–3 sentences of identity before any detail.
4. **Add explicit "In scope / Out of scope" sections.** Every high-quality shared definition bounds the task. For a code reviewer: in-scope = logic bugs, edge cases, security; out-of-scope = style nits covered by a linter. This is the strongest antidote to scope-creep and to the "agent keeps working past done" failure.
5. **Add guardrails as positive, concrete rules (few), not prohibition walls.** Follow OpenAI's guidance — prefer "Do X" over "Don't do Y"; add 3–5 anti-hallucination/anti-sycophancy rules only where your agent has demonstrably failed (e.g., "Never invent function signatures; verify with grep before citing"). Guardrails without observed failures add noise that dilutes real rules.
6. **Include a verification / exit-criteria section** — the single highest-leverage addition per Anthropic. Example: *"After implementing, run `pnpm --filter @fredo/ui build` and `cargo check`; report the output. Do not report success without the command output."* Give the agent a check it can run and a definition of done.
7. **Keep the body short and front-loaded: target <300–500 lines, put the critical rules first.** Anthropic's rule of thumb: delete any line that, if removed, wouldn't cause mistakes; Cursor recommends splitting >500-line rules; Cline recommends <5k tokens per skill. Bloat measurably correlates with non-adherence.
8. **Use concrete examples over abstractions** — pairs of preferred/avoided patterns, exact commands, expected outputs. This is the difference between aider's conventions file actually changing behavior (it demonstrably did in aider's docs) and rules being ignored.
9. **Reference files instead of copying them** (`@docs/api-standards.md`, `@scripts/verify.sh`) so the definition stays canonical and non-stale; instruct the agent to lazy-load referenced files (opencode's documented pattern).
10. **Set `model`, `temperature`, `steps`/`maxTurns` deliberately per role.** Cheaper/faster model for exploration agents (plan/haiku), more capable for implementation; near-zero temperature for analysis/review; cap `steps` for anything unattended to bound cost (both opencode and Claude Code support this).
11. **Scope: global = personal/cross-project; project = commit and share.** Put codebase-specific agents under `.opencode/agents/` (or `.claude/agents/`) in the repo so the team versions and reviews them; keep machine/personal preferences in `~/.config`.
12. **Treat the file like code: version it, review it, and measure it.** Both opencode and Claude Code watch these directories live, so iterate fast. When a rule isn't working, prune/rewrite rather than adding; when you change a definition, verify with an eval/task run whether behavior actually shifted.

**Suggested skeleton:**

```markdown
---
description: <routing: does X. Use when Y.>
mode: subagent
permission:
  edit: deny
  bash:
    "*": deny
    "git diff*": allow
model: <provider/model>
temperature: 0.1
---
You are a <role>. <one-sentence mission>.

## In scope
- ...

## Out of scope
- ...

## Process
1. ...
2. ...

## Verification (definition of done)
- Run <check> and report the exact output.
- ...

## Guardrails
- Prefer positive, concrete rules; only what you've seen fail.
```

---

## 6. Source List

1. **opencode — Agents** (fields, markdown frontmatter format, permissions, modes, examples): https://opencode.ai/docs/agents/
2. **Claude Code — Create custom subagents** (frontmatter field table, body-as-system-prompt, scopes, memory, skills): https://code.claude.com/docs/en/sub-agents
3. **Anthropic — How we built our multi-agent research system** (90.2% multi-agent gain; token usage = 80% of BrowseComp variance; prompt-engineering-as-lever; delegation guidance): https://www.anthropic.com/engineering/built-multi-agent-research-system
4. **Cursor — Rules** (`.mdc` frontmatter: description/globs/alwaysApply; best practices; AGENTS.md): https://cursor.com/docs/context/rules
5. **Cline — Skills** (SKILL.md format, name/description, progressive loading, <5k tokens guidance): https://docs.cline.bot/customization/skills.md · **Cline — Subagents**: https://docs.cline.bot/features/subagents.md
6. **VS Code — Custom instructions** (`copilot-instructions.md`, `*.instructions.md`, `AGENTS.md`, `applyTo`, precedence, tips): https://code.visualstudio.com/docs/copilot/customization/custom-instructions
7. **Aider — Specifying coding conventions** (conventions files change behavior — worked example): https://aider.chat/docs/usage/conventions.html · **Aider — Chat modes**: https://aider.chat/docs/usage/modes.html · **Aider — Leaderboards**: https://aider.chat/docs/leaderboards/ · **Aider — Repo map**: https://aider.chat/docs/repomap.html
8. **opencode — Rules** (AGENTS.md precedence, custom instructions, lazy-loading references): https://opencode.ai/docs/rules/ · **opencode — Agent Skills** (SKILL.md frontmatter, name regex, description limits, tool-listing): https://opencode.ai/docs/skills/
9. **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering** (12.5% SWE-bench / 87.7% HumanEvalFix via interface+prompt design): https://arxiv.org/abs/2405.15793
10. **Anthropic — Writing effective tools for agents** (tool-description prompt engineering → SWE-bench Verified SOTA; ~40% completion-time reduction; response-format effects): https://www.anthropic.com/engineering/writing-tools-for-agents
11. **SWE-bench: Can Language Models Resolve Real-World GitHub Issues?** (ICLR 2024; Claude 2 at 1.96%): https://arxiv.org/abs/2310.06770
12. **The Prompt Report: A Systematic Survey of Prompt Engineering Techniques** (role-prompting meta-analysis; 58 techniques): https://arxiv.org/abs/2406.06608
13. **Large Language Models Understand and Can be Enhanced by Emotional Stimuli** (EmotionPrompt — +8% / +115% / 10.9%; contested): https://arxiv.org/abs/2307.11760
14. **PatrickJS/awesome-cursorrules** (40.5k★; community rule corpus; anti-hallucination/overengineering trends): https://github.com/PatrickJS/awesome-cursorrules
15. **awesome-opencode/awesome-opencode** (9.3k★; agents/skills/orchestrators for opencode): https://github.com/awesome-opencode/awesome-opencode
16. **Prat011/awesome-llm-skills** (1.4k★; cross-harness SKILL.md collections): https://github.com/Prat011/awesome-llm-skills
17. **OpenAI — Creating and editing GPTs** (instructions vs knowledge separation; positive-instruction guidance): https://help.openai.com/en/articles/8554397-creating-a-gpt
18. **Gemini — System instructions** (first-class behavior parameter, separate from context): https://ai.google.dev/gemini-api/docs/system-instructions · https://cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/system-instructions
19. **opencode repository** (primary opencode source; default branch `dev`, 191k★): https://github.com/anomalyco/opencode

**Evidence-tier legend:** *Measured* = public benchmark or vendor internal eval with numbers; *Operational* = documented vendor practice, no controlled numbers; *Contested* = published results that did not replicate.

**Key caveat (flag for the requester):** No controlled public benchmark isolates "agent-definition file structure" as a variable. The strongest transferable measurements are (1) SWE-agent's interface/prompt effect, (2) Anthropic's token-economy analysis, and (3) Anthropic's tool-description refinement results. Everything structural in §5 is best-practice synthesis from those + vendor docs, and should be validated with an A/B eval on your own agent corpus before being codified into your platform.
