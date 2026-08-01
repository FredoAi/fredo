# Research Report: Agent Skill Formats — Cross-Tool Survey & Design Evidence

**Agent:** Research Analyst (format survey)
**Date:** 2026-08-01
**Scope:** SKILL.md format across tools, discovery/loading mechanics, benchmarks/evals of skill design, community collections

---

## Executive Summary — Top 10 Findings

1. **The industry has converged on one format.** Anthropic's Agent Skills open standard (`agentskills.io`, Dec 2025) — a directory containing a `SKILL.md` with YAML frontmatter (`name` + `description`) — is now adopted by opencode, Claude Code, GitHub Copilot, VS Code, Cline, Gemini CLI, Cursor, Roo Code, OpenAI Codex, and 30+ clients. Cross-tool portability is now the norm.

2. **Discovery is *entirely* description-driven.** Every tool injects only `name` + `description` into the system prompt at startup; the agent decides to load a skill by matching the description against the task. Anthropic: "The description is the most important part of a skill." **Measured:** MetaTool and Trace-Free+ find LLM tool/skill *selection accuracy degrades as the candidate catalog grows* and description quality is the binding constraint.

3. **Progressive disclosure is the core design principle** — 3 levels: (1) metadata always loaded (~100 tokens/skill), (2) SKILL.md body loaded on activation (<5k tokens recommended), (3) bundled resource files loaded only as needed. This lets agents carry dozens of skills for ~100 tokens each.

4. **`SKILL.md` body length matters; hard number: under 500 lines.** Anthropic/Claude Code/agentskills.io recommend **<500 lines** and moving reference material into `references/`, `scripts/`, `assets/`. **Measured:** SkillsBench found "Focused Skills with at most three modules outperform larger or exhaustive bundles."

5. **Description length limits consistent: 1–1024 characters** (opencode, agentskills.io spec, VS Code, Cline, Claude API). Claude Code truncates at 1,536 chars for `description` + `when_to_use` combined.

6. **Skill names validated the same way everywhere:** kebab-case, lowercase alphanumerics + hyphens only, 1–64 chars, must match the parent directory, no leading/trailing/consecutive hyphens. opencode regex: `^[a-z0-9]+(-[a-z0-9]+)*$`. Invalid names cause **silent load failure**.

7. **opencode's actual loader (verified in source):** discovers `.opencode/{skill,skills}/**/SKILL.md`, `.claude/skills/`, `.agents/skills/` up to the git worktree + global dirs + remote `skills.urls`. **Skills without a description are filtered out of the `<available_skills>` listing entirely.** The `skill` tool checks `permission.skill`, injects the full SKILL.md body, and attaches a **sampled list of up to 10 resource files**.

8. **Measured impact is real but uneven.** SkillsBench: curated skills raise avg pass rate 33.9% → 50.5% (+16.6pp); smaller models + skills can match larger models without them. **But SWE-Skills-Bench: 39 of 49 real SWE skills gave ZERO pass-rate improvement, avg gain only +1.2%, token overhead up to +451%, 3 skills degraded performance up to −10%.** Skills are a "narrow intervention."

9. **Security is now a first-class research topic.** Multiple 2025–26 papers find malicious skills are a practical attack vector (prompt injection + tool abuse). All vendors now publish install-audit guidance.

10. **Gems and GPTs are NOT auto-invoking skills.** Gemini Gems and OpenAI GPTs are **manually selected by the user** — prompt-packages with attached knowledge, not progressive-disclosure skill folders.

---

## Skill Format Comparison Table

| Tool / Standard | Location | Frontmatter fields | Discovery / loading | Resource files |
|---|---|---|---|---|
| **Agent Skills open standard** (agentskills.io) | any dir `<name>/SKILL.md` | `name` (req), `description` (req, 1–1024), `license`, `compatibility`, `metadata`, `allowed-tools` (experimental) | 3-level progressive disclosure; name+desc pre-loaded; body on activation; resources on demand | `scripts/` (executed), `references/` (docs), `assets/` (templates/data); refs 1 level deep; SKILL.md < 500 lines |
| **opencode** | `.opencode/skills/<n>/SKILL.md`, `~/.config/opencode/skills/`, `.claude/skills/`, `.agents/skills/`; remote via `skills.urls` | `name` (req, 1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`), `description` (req, 1–1024), `license`, `compatibility`, `metadata`. Unknown fields ignored | `skill` tool lists `<available_skills>` (name+desc only; skills without desc hidden); permission gating `permission.skill`; body + sampled file list (≤10) injected on load | any files in the skill dir; relative paths; `Base directory` + `<skill_files>` sample |
| **Claude Code** (Anthropic) | `~/.claude/skills/`, `.claude/skills/` (project), `<plugin>/skills/` | all optional; `description` recommended; `when_to_use`, `name`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell` | progressive disclosure; desc+`when_to_use` truncated at 1,536 chars; invoked by `/skill` or model auto-load; dynamic context `` !`cmd` ``; content persists in context; compaction re-attaches last skills | `SKILL.md` (req), `template.md`, `examples/`, `scripts/`, reference docs; keep SKILL.md < 500 lines; `${CLAUDE_SKILL_DIR}` |
| **Cline** | `.cline/skills/`, `~/.cline/skills/`, `.clinerules/skills/`, `.claude/skills/` | `name` (must match dir), `description` (max 1024) | `use_skill` tool + `/` slash commands; metadata always (~100 tokens), instructions <5k tokens; per-skill enable toggle | `docs/`, `templates/`, `scripts/`; scripts execute, only output enters context |
| **GitHub Copilot / VS Code** | `.github/skills/`, `~/.copilot/skills/`, `.claude/skills/`, `.agents/skills/` | `name` (req, 64 max, must match dir), `description` (req, 1024 max), `argument-hint`, `user-invocable`, `disable-model-invocation`, `context: fork` | 3-level loading; slash-command menu; invalid name/prefix → silent load failure | relative-path markdown links; files only picked up if referenced from SKILL.md |
| **Gemini CLI** (Agent Skills) | `~/.gemini/skills/`, `.gemini/skills/`, `~/.agents/skills/` | standard spec (name/description/…) | scans at session start; `activate_skill` tool; **explicit consent prompt**; `/skills list`, `/skills install <git>` | scripts/templates/assets |
| **Gemini Gems** (consumer app) | no filesystem | name, instructions (Persona/Task/Context/Format), knowledge files | **manual selection by user**; no automatic relevance trigger | knowledge files only; no scripts |
| **OpenAI GPTs** | built in chatgpt.com | name, description, instructions, knowledge, conversation starters, capabilities, actions | **manual selection by user**; GPT Store search uses description | knowledge up to 20 files, 512MB each; actions = external APIs |
| **OpenHands** | `.agents/skills/`, `~/.agents/skills/` | spec + extensions: `triggers` (keyword auto-inject), `paths` | spec progressive disclosure; triggers/paths add deterministic injection | standard scripts/references/assets |

---

## What the Best Shared Skills Have in Common

Based on `anthropics/skills` (166k stars), `github/awesome-copilot` (37k stars), OpenHands registry, and the skills already shipping in this repo (`chakra-ui-builder`, `telemetry-query`, `fredo-cli-events`):

1. **A description that is a *selector contract*, not a summary.** Pattern: third-person declarative "what it does" + explicit trigger clause. "Extracts text and tables from PDF files... **Use when** working with PDFs or when the user mentions PDFs, forms, or document extraction." The "Use when…" clause names real user vocabulary.
2. **Specific, keyword-dense descriptions, zero fluff.** Vague descriptions ("Helps with AWS stuff") mean the skill "won't trigger when you expect it to."
3. **Small focused bodies.** Keep SKILL.md lean (<500 lines, <5k tokens); move anything conditional or verbose to `references/`/`scripts/`. SkillsBench *measured* focused skills (≤3 modules) beat large exhaustive bundles.
4. **One level of file indirection.** Everything links directly from SKILL.md — no `reference.md → details.md` chains, because agents partial-read (`head -100`) deeply nested refs and lose information.
5. **Scripts for deterministic operations, instructions for judgment.** Scripts are executed (only output enters context); instructions guide open-ended work.
6. **Consistent kebab-case naming, gerund or noun-phrase style:** `pdf-processing`, `analyzing-spreadsheets`, `git-release`, `telemetry-query`. Avoid `helper`, `utils`, `misc-helpers`.
7. **Concrete examples and checklists.** Input/output pairs and copyable checklists with verification loops measurably improve compliance.
8. **No time-sensitive content; no magic numbers; forward-slash paths everywhere.**

---

## Benchmarks & Evals of Skill Design

| Work | URL | Key finding |
|---|---|---|
| **SkillsBench** | https://arxiv.org/abs/2602.12670 | 87 tasks, 8 domains. Skills raise pass rate 33.9% → 50.5% (+16.6pp). **Focused skills (≤3 modules) beat larger/exhaustive bundles. Smaller models + skills match larger models without them.** |
| **SWE-Skills-Bench** | https://arxiv.org/abs/2603.15401 | 49 real SWE skills × 565 tasks. **39/49 → zero improvement; avg +1.2%; token overhead up to +451%; 3 skills −10% from version-mismatched guidance.** Skills are a narrow intervention. |
| **MetaTool** | https://arxiv.org/abs/2310.03128 | Most LLMs struggle to select tools correctly; **description quality is the lever — rewrite descriptions for the downstream LLM.** |
| **Trace-Free+** | https://arxiv.org/abs/2602.20426 | Rewriting tool descriptions reduces accuracy degradation by **29.23%** and raises success by **60.89%** as the catalog scales to 150+ candidates. |
| **SoK: Agentic Skills** | https://arxiv.org/abs/2602.20867 | Systematizes skill definition, retrieval, security. |
| **Graph of Skills** | https://arxiv.org/abs/2604.05333 | Dependency-aware retrieval for *massive* libraries; description-only selection degrades at scale. |
| **SkillTester** | https://arxiv.org/abs/2603.28815 | Benchmarks utility *and* security of agent skills. |

**Honest gap:** no public benchmark yet isolates description-phrasing on skill-selection accuracy end-to-end; closest are MetaTool/Trace-Free+ on tool descriptions (generalize plausibly, still an analogy).

---

## The Canonical SKILL.md Structure (synthesized across all tools)

```markdown
---
name: <kebab-case, 1-64 chars, matches directory: ^[a-z0-9]+(-[a-z0-9]+)*$>
description: |-
  <Third person. What it does + when to use. 1-1024 chars.
  Include trigger keywords (file types, tool names, verbs users say).
  Put the key use case FIRST; discovery listings may truncate.>
license: Apache-2.0
compatibility: Requires git, docker, and network access
metadata:
  author: your-org
  version: "1.0"
when_to_use: Trigger phrases and example requests
disable-model-invocation: true      # manual-only, for side-effect workflows
user-invocable: false               # agent-only, background knowledge
---

# <Skill Name>

## What this skill does
One or two sentences. Assume the model is already smart.

## When to use it
Mirror the description's trigger conditions.

## Procedure / Steps
Numbered steps for fragile work; principles for judgment work (match to fragility).

## Examples
Input → output pairs showing expected style and detail.

## Resources (navigation — one level deep only)
- Advanced API details: see [reference.md](reference.md)
- Validation: run `python scripts/validate.py`
```

Directory layout:
```
my-skill/
├── SKILL.md          # required: metadata + overview + navigation
├── reference.md      # loaded only when referenced
├── examples.md
├── scripts/          # executed deterministically (output only)
└── assets/           # templates, schemas, non-executable resources
```

---

## Concrete Actionable Recommendations for Writing a Good SKILL.md

1. **Write the description last, then test it first.** Draft the body, then write a description that would let a *different* agent pick this skill from a list of 50. Run 3–5 real user-phrasings past the description and confirm it triggers. (Measured rationale: MetaTool/Trace-Free+ — selection degrades as catalog grows.)
2. **Follow the "Does X. Use when Y." template.** Third person, active verb first, then a "Use when…" clause naming concrete triggers (file types, tools, verbs). The single most consistent pattern across anthropics/skills, awesome-copilot, Cline, Gemini CLI, and opencode's docs.
3. **Keep the description under ~200 characters even though 1024 is allowed.** Listings are truncated. Put the primary use case in the first sentence so truncation never removes it.
4. **Keep SKILL.md under 500 lines / ~5k tokens; split aggressively.** Move schemas, API reference, troubleshooting, per-domain material into `references/`/`docs/`. SWE-Skills-Bench measured up to 451% token overhead from large skills.
5. **Keep file references one level deep from SKILL.md only.** Agents partial-read deeply nested files. For reference files >100 lines, add a table of contents.
6. **Use scripts for deterministic operations; mark the intent.** "Run `scripts/validate.py`" vs "See `scripts/analyze.py` for the algorithm." Make scripts emit LLM-friendly stdout, handle errors explicitly, avoid magic numbers.
7. **Front-load the common case; use checklists for fragile workflows.** Sequential readers benefit from front-loading; copyable checklists with a validate→fix→re-verify loop improve adherence.
8. **Match specificity to task fragility (degrees of freedom).** Exact scripts + "do not modify" for brittle operations; principles for judgment tasks; templates with parameters for medium freedom.
9. **Name skills kebab-case with gerund or noun phrases**, matching the directory exactly. A name mismatch or invalid character silently disables the skill.
10. **Avoid time-sensitive content, Windows backslash paths, multi-tool choice menus.** Put legacy info in "Old patterns" `<details>`; forward slashes; one default approach with one escape hatch.
11. **Treat skills as a narrow, measured intervention.** Don't add speculatively — build evals first (3 scenarios), measure baseline vs with-skill, cut skills that don't move pass rate (SWE-Skills-Bench: 39/49 provided nothing).
12. **Audit before install and scope permissions narrowly.** Skills execute code and can grant tool access; malicious skills are a studied attack surface. Use `permission.skill` (allow/ask/deny, `internal-*` wildcards) scoped to exactly what the skill needs.

---

## Source List

**opencode:** https://opencode.ai/docs/skills · https://opencode.ai/docs/config · loader source `packages/opencode/src/skill/index.ts` · tool source `packages/opencode/src/tool/skill.ts` · discovery source `packages/opencode/src/skill/discovery.ts`
**Anthropic/Claude:** https://agentskills.io/specification · https://agentskills.io/ · https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills · https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview · https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices · https://code.claude.com/docs/en/skills · https://github.com/anthropics/skills
**Other tools:** https://docs.cline.bot/features/skills · https://docs.github.com/en/copilot/concepts/agents/about-agent-skills · https://code.visualstudio.com/docs/copilot/customization/agent-skills · https://geminicli.com/docs/cli/skills/ · https://geminicli.com/docs/cli/skills-best-practices/ · https://help.openai.com/en/articles/8843948-creating-a-gpt · https://docs.openhands.dev/overview/skills
**Benchmarks/evals:** https://arxiv.org/abs/2602.12670 (SkillsBench) · https://arxiv.org/abs/2603.15401 (SWE-Skills-Bench) · https://arxiv.org/abs/2310.03128 (MetaTool) · https://arxiv.org/abs/2602.20426 (Trace-Free+) · https://arxiv.org/abs/2602.20867 (SoK Agentic Skills) · https://arxiv.org/abs/2604.05333 (Graph of Skills) · https://arxiv.org/abs/2603.28815 (SkillTester)
**Community:** https://github.com/anthropics/skills · https://github.com/github/awesome-copilot · https://github.com/Prat011/awesome-llm-skills · https://github.com/OpenHands/extensions · https://github.com/wmmthu/awesome-llm-agent-skills-papers

**Bottom line:** format is standardized and simple (SKILL.md + name/description frontmatter, kebab-case, ≤1024-char description, ≤500-line body, one-level resource references, scripts for determinism). The two highest-leverage quality levers: (1) description trigger quality — the *only* selector signal — and (2) keeping the body small and focused. Caution: untested, poorly-targeted skills can add tokens without adding value.
