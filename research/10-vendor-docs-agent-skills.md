# Research Report: Vendor Docs on Agent Skills

**Agent:** Research Analyst (vendor docs)
**Date:** 2026-08-01
**Scope:** OpenCode, Anthropic/Claude Code, OpenAI Codex/API, Cline, Roo Code, Gemini CLI, agentskills.io open standard

---

## Executive Summary — Top 10 Findings

1. **There is a de facto open standard.** Anthropic's **Agent Skills** format (a folder + `SKILL.md` with YAML frontmatter) is an open standard at [agentskills.io](https://agentskills.io), adopted by OpenCode, OpenAI Codex, Gemini CLI, Cline, Roo Code, Cursor, GitHub Copilot, VS Code, and 40+ tools. Every vendor documents the same core file: `SKILL.md` with required `name` + `description` frontmatter and a Markdown body.

2. **Progressive disclosure is the load-bearing design principle.** Three levels: (1) Metadata (`name` + `description`, ~100 tokens) loaded at startup for all skills; (2) Instructions (SKILL.md body) load only on activation; (3) Resources (scripts/references/assets) load only when read/executed. Anthropic: "the amount of context that can be bundled into a skill is effectively unbounded."

3. **The `description` is the single most important field.** It is the *only* signal the model sees before activation. All vendors converge: state *what* the skill does **and** *when* to use it, include trigger keywords users would naturally type, front-load the key use case (descriptions get truncated under budget pressure), write in **third person**.

4. **Length guidance converges tightly:** keep `SKILL.md` **under 500 lines / ~5k tokens**, split detail into `references/`, keep file references **one level deep**, add a table of contents to reference files longer than ~100 lines.

5. **Skills vs. rules vs. subagents is a well-defined split.** Skills = on-demand procedural knowledge. Rules (AGENTS.md/CLAUDE.md) = always-on facts and constraints. Anthropic: "Create a skill when you keep pasting the same instructions… or when a section of CLAUDE.md has grown into a procedure rather than a fact." Subagents = separate personas/contexts that can *consume* skills.

6. **Loaded skills persist in context for the session — every line is a recurring token cost.** Claude Code: "once a skill loads, its content stays in context across turns… State what to do rather than narrating how or why."

7. **Skill listings are budgeted and descriptions get truncated.** Claude Code caps the listing at ~1% of context (descriptions capped at 1,536 chars); OpenAI Codex caps it at 2% or 8,000 chars and *shortens descriptions first*. Front-loading trigger words is a robustness requirement, not a style choice.

8. **Description misrouting is a documented, measured failure mode.** Anthropic skill-creator postmortem: "too broad and you get false triggers, too narrow and it never fires" — improved triggering on 5 of 6 skills after description tuning. Trigger rate and output quality are measured as *separate* signals.

9. **Match instruction specificity to task fragility ("degrees of freedom").** Fragile operations (DB migrations, releases) need exact scripts + guardrails; judgment tasks (code review) need general direction. Anthropic's analogy: *narrow bridge with cliffs* vs *open field*.

10. **Skills are privileged instructions — security is first-class.** Anthropic and OpenAI warn skills can carry prompt-injection/exfiltration; OpenAI explicitly warns against exposing an open user-browsable skill repository.

---

## Vendor-by-Vendor Breakdown

### 1. OpenCode — https://opencode.ai/docs/skills/
- **Location:** `.opencode/skills/<name>/SKILL.md` (project), `~/.config/opencode/skills/` (global), plus `.claude/skills/` and `.agents/skills/` in both scopes. Discovery walks up to the git worktree.
- **Frontmatter — only these recognized; unknown fields ignored:** `name` (req), `description` (req), `license`, `compatibility`, `metadata`.
- **Name validation:** 1–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, must match the directory name.
- **Description:** 1–1024 chars; "specific enough for the agent to choose correctly."
- **Discovery/loading:** available skills listed in the `skill` tool description as `<available_skills>` (name + description). Agent loads via `skill({ name: ... })`.
- **Permissions:** per-skill `allow`/`ask`/`deny`, wildcards like `internal-*`. Per-agent override via agent frontmatter or `opencode.json` `agent.<name>.permission.skill`. `tools.skill: false` removes the block entirely.
- **Troubleshooting:** file must be all-caps `SKILL.md`; `name`+`description` required; names unique; `deny`-permissioned skills hidden.

### 2. Anthropic / Claude Code — https://code.claude.com/docs/en/skills
- **Location/precedence:** enterprise → personal → project → bundled; nested `.claude/skills/` for monorepo scoping.
- **Frontmatter (all optional except description):** `description`, `when_to_use`, `name`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell`, `argument-hint`, `arguments`.
- **Content lifecycle:** invoked SKILL.md enters context as a single message and stays for the whole session. After compaction, most recent invocation of each skill re-attached (first 5,000 tokens each, shared 25,000-token budget).
- **Budget:** listing scales at **1% of context**; descriptions dropped starting with least-used skills. `skillListingBudgetFraction` configurable.
- **Types:** "reference content" (knowledge applied inline) vs "task content" (step-by-step actions, often `disable-model-invocation: true`).
- **Dynamic injection:** `` !`git diff HEAD` `` runs a command before the skill loads and inlines output.
- **Guidance:** keep SKILL.md **under 500 lines**; body concise (recurring token cost); description critical for selection from "potentially 100+ skills."

### 3. OpenAI — Codex + API
- **Codex skills** (https://developers.openai.com/codex/build-skills): builds on the open standard. Directory `SKILL.md` + optional `scripts/`, `references/`, `assets/`, `agents/openai.yaml`. Invocation explicit (`@skill`/`$skill`/`/skills`) or implicit (description match). **Context budget:** list uses at most 2% of context or 8,000 chars; Codex **shortens descriptions first**, may omit skills entirely with a warning. "Front-load the key use case and trigger words."
- **Best practices:** one job per skill; prefer instructions over scripts unless deterministic; imperative steps with explicit inputs/outputs.
- **API Skills** (different concept, https://developers.openai.com/api/docs/guides/tools-skills): versioned bundles; skill metadata added to **user prompt context** (not system). Safety: skills are "privileged code and instructions"; review as untrusted input; **don't expose an open skills repo to end users**; gate high-impact actions behind approval.

### 4. Cline — https://docs.cline.bot/features/skills
- Explicit token table: Metadata (~100 tokens, always) → Instructions (<5k tokens, on trigger) → Resources (unlimited, on demand).
- `name` matches directory; `description` max 1,024 chars. Naming kebab-case; good = `aws-cdk-deploy`; avoid `aws`, `my_skill`, `DeployToAWS`, `misc-helpers`.
- Keep SKILL.md **under 5k tokens**; split into `docs/`, `templates/`, `scripts/`. Scripts token-efficient (only output enters context).
- **Disagreement:** Cline says global > project precedence; Roo says project > global.

### 5. Roo Code — https://docs.roocode.com/features/skills
- 3-level progressive disclosure; follows agentskills.io.
- **Mode-targeted skills:** `skills-{mode}/` dirs so a skill only activates in a given mode.
- **Override priority (opposite of Cline):** project > global, mode > generic, `.roo/` > `.agents/`.
- **Troubleshooting (anti-pattern list):** name mismatch with directory, missing required fields, wrong mode, "description too vague" (`Handle files` ✗ vs `Extract text and tables from PDF files using Python libraries` ✓).
- Comparison table: Skills (on-demand, task workflows) vs Custom Instructions (always in base prompt) vs Slash Commands (retrieve pre-written content).

### 6. Gemini CLI — https://geminicli.com/docs/cli/skills/
- Implements the agentskills.io standard. Lifecycle: **discovery** (metadata into system prompt) → **activation** (`activate_skill` tool) → **user consent prompt** (Gemini asks before injecting) → **injection** → **execution**.
- Discovery tiers: built-in → extension → user → workspace. Within a tier, `.agents/skills` beats `.gemini/skills`.
- Best practices: **description is the most important part** — specific, user-prompt keywords, define trigger, avoid overlap with other skills and the model's own capabilities. Progressive disclosure: ~100-word metadata, <5k-word body. Degrees of freedom (high/medium/low). Scripts for deterministic tasks with "agentic ergonomics."

### 7. The Open Standard — https://agentskills.io/specification
- **Frontmatter:** `name` (req, ≤64, regex, must match dir), `description` (req, 1–1024, "what + when" + keywords), `license`, `compatibility` (≤500), `metadata`, `allowed-tools` (experimental).
- **Directory:** `SKILL.md` + `scripts/`, `references/`, `assets/`.
- **Progressive disclosure:** ~100 tokens metadata → <5,000 tokens instructions → resources on demand. **"Keep your main SKILL.md under 500 lines."**
- **File references:** relative, **one level deep**, avoid nested chains (agents do partial reads like `head -100`).
- **Validation:** `skills-ref validate ./my-skill`.

---

## The OpenCode SKILL.md Format Spec

```
.opencode/skills/<name>/SKILL.md
```

**Frontmatter (only these recognized; unknown fields ignored):**

| Field | Required | Rules |
|---|---|---|
| `name` | Yes | 1–64 chars; `^[a-z0-9]+(-[a-z0-9]+)*$`; must match directory |
| `description` | Yes | 1–1024 chars; "specific enough for the agent to choose correctly" |
| `license` | No | e.g. `MIT` |
| `compatibility` | No | e.g. `opencode` |
| `metadata` | No | string→string map |

**Body:** arbitrary Markdown. OpenCode's example skill uses "What I do" + "When to use me" structure.

**Discovery & loading:**
- Scan: `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` (project + global), up to git worktree.
- Appears in `skill` tool description as `<available_skills>` (name + description).
- Load via `skill({ name: ... })`.

**Resource files:** `SKILL.md` references files in its directory (scripts, reference docs) read/executed when needed — levels 2 and 3 of progressive disclosure.

**Permissions:** `permission.skill` with patterns (`"*": "allow"`, `"pr-review": "allow"`, `"internal-*": "deny"`, `"experimental-*": "ask"`). Per-agent override via frontmatter or opencode.json.

---

## Documented Anti-Patterns

1. **Skill bloat** — verbose prose explaining what the model already knows (Anthropic's 150-token "PDF is a common file format" example vs the 50-token concise version). "Every line is a recurring token cost."
2. **Vague descriptions** — `Helps with AWS stuff`, `Data analysis helper`, `Handle files`. Never triggers or triggers on wrong requests.
3. **Description misrouting** — too broad → false triggers; too narrow → never fires. First/second-person descriptions ("I can help you…") cause discovery problems — always third person.
4. **Description overlap** — two skills matching the same request, or a skill duplicating the model's native capability.
5. **Over-constraining / over-generalizing** — too many rules plateau; too-general instructions (no function names, no templates) useless.
6. **Deeply nested references** — `SKILL.md → advanced.md → details.md`. Agents partial-read nested files and miss content. Keep references one level deep.
7. **Time-sensitive content** — "before August 2025 use the old API" becomes wrong; use an "old patterns" `<details>` section.
8. **Windows-style paths** — `scripts\helper.py` breaks on Unix; always forward slashes.
9. **Too many options** — "use pypdf, or pdfplumber, or PyMuPDF…" — provide a default with an escape hatch.
10. **Hardcoded secrets & unvetted third-party skills** — skills can carry prompt injection/exfiltration.
11. **Unbounded skill counts** — listing budget means descriptions get truncated/omitted; low-value skills crowd out high-value ones.
12. **Malformed YAML** — frontmatter parse errors load the body with empty metadata → invocable but never auto-matches.
13. **Name/directory mismatch** — `name: pdf_processing` in dir `pdf-processing` silently breaks discovery.
14. **`context: fork` misuse** — a forked skill needs explicit task instructions; guidelines-only skills return nothing in a subagent.

---

## Concrete Recommendations for Writing a Good SKILL.md

1. **Put the trigger decision in the `description`, and nothing else there.** Format: `What it does + specific trigger phrases + domains/files/tools. Use when the user asks to <X> or mentions <Y>.` Third person, imperative, front-load the key use case. Description capped at 1,024 chars and *will* be truncated under budget pressure — first ~120 chars must be self-sufficient.
2. **Keep SKILL.md under 500 lines / ~5k tokens.** Body = table of contents + core procedure; push schemas/API docs/examples/edge cases into `references/`.
3. **Follow the three-level progressive disclosure structure.** (1) tight frontmatter (~100 tokens), (2) lean body naming each bundled file + when to load it, (3) one-level-deep `references/` + `scripts/` + `assets/`.
4. **Match "degrees of freedom" to task fragility.** Fragile operations → exact commands, guardrails, "run exactly this, do not add flags" (low freedom). Judgment tasks → brief directional steps (high freedom).
5. **Distinguish what/why from how.** Use "reasoning-based instructions" (`Do X because Y causes Z`) over rigid absolutes (`ALWAYS X, NEVER Y`) — reason-based instructions followed more reliably.
6. **Use `scripts/` for deterministic work with "agentic-ergonomic" output.** Only stdout enters context: suppress tracebacks, print concise success/failure, return structured results, handle errors instead of deferring to the model.
7. **Name skills kebab-case, unique, descriptive** (`git-release`, `pr-review-checklist`, `database-migration`), matching the directory exactly.
8. **Test the trigger separately from the output.** Run should-trigger and should-not-trigger prompts against the description; verify it fires correctly. Then eval output quality with a with/without-skill baseline.
9. **Write for the weakest model in your fleet.** What works on the strongest model may need more detail for weaker ones.
10. **Mind the budget math.** With many skills, descriptions get shortened/omitted. Trim descriptions at the source; use permission `deny` to keep low-value skills from crowding the listing.
11. **No secrets, no time bombs, forward slashes.** Review third-party skills before trusting them; keep references one level deep; validate with `skills-ref validate`.

---

## Where Vendors Disagree

- **Precedence of same-named skills:** Roo says project overrides global; Anthropic says personal overrides project; Cline says global takes precedence. Use distinct names.
- **Consent on activation:** Gemini prompts the user; OpenCode `ask` permission opt-in; Claude/OpenAI load automatically.
- **System vs user prompt:** OpenAI API mounts skill metadata into *user* prompt (lower priority); Anthropic/OpenCode inject into system prompt/tool descriptions (higher routing authority).
- **`name` semantics:** Anthropic uses `name` as display label; OpenCode requires it match the directory.
- **Description caps:** 1,024 chars (OpenCode/agentskills) vs 1,536 combined (Claude Code); listing budgets 1% vs 2%. Write for the most restrictive.

---

## Source List

**OpenCode:** https://opencode.ai/docs/skills/
**Anthropic:** https://code.claude.com/docs/en/skills · https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices · https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills · https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills
**OpenAI:** https://developers.openai.com/codex/build-skills · https://developers.openai.com/codex/skills-and-plugins · https://developers.openai.com/api/docs/guides/tools-skills
**Cline:** https://docs.cline.bot/features/skills
**Roo Code:** https://docs.roocode.com/features/skills
**Gemini CLI:** https://geminicli.com/docs/cli/skills/ · https://geminicli.com/docs/cli/creating-skills/ · https://geminicli.com/docs/cli/skills-best-practices/
**Open standard:** https://agentskills.io/ · https://agentskills.io/specification · https://agentskills.io/skill-creation/evaluating-skills

**Unverified/flagged:** Google Gems official pages 404'd during research; Gemini CLI skills documented but Gems' mechanism unconfirmed.
