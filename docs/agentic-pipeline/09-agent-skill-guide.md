# Agent Skill Guide (Research-Backed)

> **Status: GUIDANCE.** How to write a good `.opencode/skills/<name>/SKILL.md` file. Source list at the bottom. This is the skill-writing companion to [08-agent-definition-guide.md](08-agent-definition-guide.md).

---

## 1. Executive Summary

1. **The description is the entire product.** Only `name` + `description` sit in context at startup; the agent picks the skill from that text alone, from potentially 100+ skills. Description quality drives selection *more than* the skill's content (measured: standard-compliant descriptions selected at 72% vs 20% baseline). Write it as a *router*, not a summary.
2. **Activation is the #1 failure mode — not content.** Practitioners' dominant complaint: skills that never load. Vercel measured a skills default behavior at baseline (0pp gain) because the skill wasn't invoked in 56% of cases. If it doesn't trigger, fix the description before adding more content.
3. **Keep SKILL.md under 500 lines / ~5k tokens.** The single most-corroborated number (agentskills.io spec, Claude Code, Cline, Gemini). Measured: focused skills (≤3 modules) beat exhaustive bundles; large skills cost up to +451% tokens with zero gain.
4. **Follow three-level progressive disclosure.** (1) tight frontmatter (~100 tokens, always loaded) → (2) lean body loaded on trigger → (3) one-level-deep `references/` + `scripts/` + `assets/` on demand. Never nest references — agents `head -100` deep files and lose content.
5. **Skills are for vertical, explicitly-triggered workflows — not always-needed knowledge.** Vercel measured: an 8KB compressed index in AGENTS.md hit 100% vs 79% for skills-with-instructions. If it must be true every turn, put it in AGENTS.md, not a skill. "A rule the model only meets after it decides to load a skill file is a rule it meets too late."
6. **Concrete contracts beat prose.** Structured, contract-like skills (when-to-use / inputs / outputs / failure modes) outperform free-form prose (measured: −22.8% tokens, −14.5% calls). Include invocation templates and examples, not descriptions of the skill.
7. **Match instruction rigidity to task fragility ("degrees of freedom").** Fragile operations (releases, migrations) → exact scripts + "do not modify"; judgment tasks (review) → brief directional principles. Reason-based instructions (`Do X because Y`) beat rigid absolutes (`ALWAYS X`).
8. **Skills are privileged instructions — security is first-class.** Malicious skills are a studied attack vector (prompt injection + tool abuse). Scope `permission.skill` narrowly; audit third-party skills; never expose an open skill catalog.
9. **Skills are a narrow, measured intervention.** SWE-Skills-Bench: 39 of 49 real SWE skills gave zero improvement. Build evals (3 scenarios) before writing; measure with/without; cut skills that don't move the metric. Instrument which skills actually load and prune ~zero-invocation ones.
10. **The format is a de facto open standard.** `SKILL.md` + YAML frontmatter (`name` + `description` required), kebab-case name matching the directory, 1–1024-char description. Same file works across opencode, Claude Code, Cline, Codex, Gemini CLI, Copilot.

---

## 2. The Canonical Anatomy

### Frontmatter (only these fields; unknown fields ignored by opencode)

| Field | Required | Rules |
|-------|----------|-------|
| `name` | Yes | 1–64 chars; `^[a-z0-9]+(-[a-z0-9]+)*$`; **must match the directory name** |
| `description` | Yes | 1–1024 chars; the **routing contract** — what + when + trigger keywords, third person |
| `license` | No | e.g. `MIT` |
| `compatibility` | No | environment/product requirements |
| `metadata` | No | string→string map |

### Body section order (fixed)

```
## What this skill does
## When to use it
## Procedure / Steps
## Examples
## Resources (navigation — one level deep only)
```

### Directory layout

```
.opencode/skills/<name>/
├── SKILL.md          # required: metadata + overview + navigation
├── reference.md      # loaded only when referenced (one level deep)
├── examples.md
├── scripts/          # executed deterministically (output only enters context)
└── assets/           # templates, schemas, non-executable resources
```

---

## 3. What the Research Says, Rule by Rule

### 3.1 The description is the router

- **Only `name` + `description` are always in context.** The body loads only on activation (Anthropic, opencode, all vendors). The agent decides to load from the description alone, from potentially 100+ skills.
- **Description quality beats content quality for selection.** From Docs to Descriptions (10,831 MCP servers): standard-compliant descriptions selected at 72% vs a 20% baseline; functionality/accuracy smells shift selection by +11.6%/+8.8%. BiasBusters: small perturbations to descriptions change choices; semantic alignment with the query is the strongest driver.
- **Selection degrades as the catalog grows.** MetaTool, Trace-Free+ (description rewriting: −29.2% degradation, +60.9% success at 150+ candidates). The description is the binding constraint as skill counts rise.

**Write:** `Extracts text and tables from PDF files, fills forms, merges documents. Use when working with PDFs or when the user mentions PDFs, forms, or document extraction.` — third person, imperative, trigger keywords first, ≤~200 chars self-sufficient (descriptions get truncated under budget pressure).

### 3.2 Progressive disclosure

- Anthropic's Agent Skills standard: metadata (~100 tokens) → SKILL.md body (<5k tokens) → resources on demand. "The amount of context that can be bundled into a skill is effectively unbounded."
- Nielsen's HCI foundation: put frequently-needed items in level 1; give each progression **strong information scent** (a description that makes triggering obvious).
- **Never nest references.** `SKILL.md → advanced.md → details.md` fails because agents partial-read (`head -100`) deeply nested files. Keep references exactly one level deep; reference files >100 lines get a table of contents.

### 3.3 Length and bloat

- **<500 lines / ~5k tokens** for SKILL.md (agentskills.io, Claude Code, Cline, Gemini — universal consensus).
- Measured: SkillsBench "Focused Skills with at most three modules outperform larger or exhaustive bundles." SWE-Skills-Bench: token overhead up to +451% with zero gain.
- Practitioner data: 1,500-line skill → 398-line main + 10 resource files = 40–60% token efficiency improvement.
- **Loaded skill content persists in context across turns** — every line is a recurring token cost. State what to do, not what the model already knows.

### 3.4 Skills vs rules vs subagents

- **Skills** = on-demand procedural knowledge (loads only when used).
- **Rules (AGENTS.md/CLAUDE.md)** = always-on facts and constraints. Anthropic: "Create a skill when you keep pasting the same instructions… or when a section of CLAUDE.md has grown into a procedure rather than a fact."
- **Subagents** = separate personas/contexts that can consume skills.
- Practitioner rule: "CLAUDE.md is a router, not a rulebook." Irreversible constraints stay inline in AGENTS.md — a rule the model only meets after loading a skill is met too late.
- **Vercel's data-driven line:** passive context (AGENTS.md index) for horizontal/always-needed knowledge; skills for **vertical, explicitly-triggered workflows**.

### 3.5 Verification and self-checking

- **Include a check the skill can run** — a validation script, expected output, or self-test (Voyager's self-verification is what lets its library compound reliably).
- **Include a validate→fix→re-verify loop** for fragile workflows: "run validate.py; if it fails, fix and rerun; only proceed when it passes."
- **Prefer scripts for deterministic steps.** Only the script's stdout enters context: suppress tracebacks, print concise success/failure, return structured results, handle errors rather than deferring to the model.

### 3.6 Degrees of freedom

- **Low freedom (fragile):** releases, DB migrations, config. Exact scripts + guardrails + "run exactly this, do not add flags."
- **High freedom (judgment):** code review, summarization. Brief directional principles.
- **Medium:** templates with parameters.
- Reason-based instructions (`Do X because Y causes Z`) are followed more reliably than rigid absolutes (`ALWAYS X, NEVER Y`).

### 3.7 Security

- Skills are **privileged code and instructions** — a prompt-injection/tool-abuse attack surface (multiple 2025–26 papers).
- Scope `permission.skill` narrowly (`allow`/`ask`/`deny`, `internal-*` wildcards). Audit third-party skills. Never expose an open skill catalog to end users.
- The `description` itself is an attack surface (tool-poisoning embeds malicious claims inside descriptions).

---

## 4. Anti-Patterns to Avoid

| Anti-pattern | Why it fails |
|--------------|--------------|
| **Vague description** (`Helps with documents`, `Handle files`) | Never triggers or triggers on the wrong requests |
| **Description misrouting** (too broad / too narrow) | False triggers or never fires (Anthropic measured: tuned 5/6 skills) |
| **First/second-person description** (`I can help you…`) | Breaks discovery — always third person |
| **Skill bloat** (explaining what the model knows) | Every loaded line is a recurring token cost |
| **Deeply nested references** (`SKILL.md → a.md → b.md`) | Agents `head -100` deep files, lose content |
| **Hard rules inside skills** | A rule met only after loading is met too late — belongs in AGENTS.md |
| **Always-needed knowledge as a skill** | Passive context (AGENTS.md index) measured 100% vs skills' 79% |
| **Time-sensitive content** | "before August 2025" rots; quarantine in an "Old patterns" `<details>` |
| **Windows backslash paths** | Break on Unix hosts — always forward slashes |
| **Multi-tool choice menus** | "use pypdf, or pdfplumber, or PyMuPDF…" — one default + escape hatch |
| **Name/directory mismatch** | Silent load failure in opencode and VS Code |
| **Malformed YAML** | Body loads with empty metadata → invocable but never auto-matches |
| **Unused skills in the catalog** | Each costs context every turn; Vercel measured unused skills slightly *hurt* metrics |
| **Hardcoded secrets / unvetted third-party skills** | Privileged instruction injection |

---

## 5. The Suggested Skeleton

```markdown
---
name: <kebab-case-name-matching-directory>
description: |-
  <Third person. Does X. Use when [trigger phrases, file types, tools, verbs].
  Key use case first — listings may truncate.>
license: MIT
---

# <Skill Name>

## What this skill does
<One or two sentences. Assume the agent already knows the domain.>

## When to use it
<Mirror the description's trigger conditions. Bullet the concrete situations.>

## Procedure / Steps
<Fragile work: numbered steps + a validate→fix→re-verify loop.
 Judgment work: directional principles. Match rigidity to fragility.>

## Examples
<Input → output pairs showing expected style and detail.>

## Resources
- <Reference docs: see [reference.md](reference.md)>
- <Validation: run `python scripts/validate.py` — script output, not code, enters context>
```

---

## 6. Iteration & Evaluation

- **Eval-first development.** Build 3 eval scenarios *before* writing the skill; baseline without it; write minimal content; iterate until it passes. Anthropic: "Evaluations are your source of truth."
- **Test trigger separately from output.** Run should-trigger and should-not-trigger prompts against the description. If it doesn't load on a natural prompt, fix the description before adding content.
- **Two-role iteration.** One instance authors/edits the skill; a fresh instance uses it on real work. Watch which resource files it reads (promote to main SKILL.md) vs ignores (relegate or cut).
- **Instrument activation.** Parse session logs to see which skills actually load; archive skills with ~zero invocations — each costs context every turn and can add noise.
- **Measure with/without.** Skills are a narrow intervention (SWE-Skills-Bench: 39/49 zero gain). Cut skills that don't move the metric.
- **Treat skills like code.** Version them, audit for staleness (skills silently drift as referenced APIs change), prune rather than accumulate.

---

## 7. Sources

**Scientific literature**
- Lost in the Middle — Liu et al., TACL 2023 — arxiv.org/abs/2307.03172
- LLMLingua — Jiang et al., EMNLP 2023 — arxiv.org/abs/2310.05736
- MemGPT — Packer et al., 2023 — arxiv.org/abs/2310.08560
- Voyager — Wang et al., 2023 — arxiv.org/abs/2305.16291
- Generative Agents — Park et al., UIST 2023 — arxiv.org/abs/2304.03442
- RAG-MCP — Gan & Sun, 2025 — arxiv.org/abs/2505.03275
- From Docs to Descriptions — Wang et al., 2026 — arxiv.org/abs/2602.18914
- BiasBusters — Blankenstein et al., ICLR 2026 — arxiv.org/abs/2510.00307
- Self-RAG — Asai et al., ICLR 2024 — arxiv.org/abs/2310.11511
- Skill-as-Pseudocode — Li et al., 2026 — arxiv.org/abs/2605.27955
- GoSkills — Zeng et al., 2026 — arxiv.org/abs/2605.06978
- Dynamic Agent Skills — Li, TMLR 2026 — arxiv.org/abs/2607.10113
- SkillOps — Pu et al., 2026 — arxiv.org/abs/2605.13716
- Skill Drift — Fan et al., 2026 — arxiv.org/abs/2605.10990
- Instruction Hierarchy — Wallace et al., 2024 — arxiv.org/abs/2404.13208
- SkillsBench — arxiv.org/abs/2602.12670
- SWE-Skills-Bench — arxiv.org/abs/2603.15401
- MetaTool — arxiv.org/abs/2310.03128
- Trace-Free+ — arxiv.org/abs/2602.20426

**Vendor docs**
- OpenCode skills: opencode.ai/docs/skills (+ loader/tool source in the opencode repo)
- Anthropic Agent Skills: agentskills.io/specification · anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills · platform.claude.com/.../agent-skills/best-practices · code.claude.com/docs/en/skills
- OpenAI Codex: developers.openai.com/codex/build-skills · developers.openai.com/api/docs/guides/tools-skills
- Cline: docs.cline.bot/features/skills · Roo Code: docs.roocode.com/features/skills
- Gemini CLI: geminicli.com/docs/cli/skills/ (+ creating-skills, skills-best-practices)

**Community (anecdotal — directional)**
- Vercel: "AGENTS.md outperforms skills in our agent evals" (vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) — data-driven
- r/ClaudeAI "Claude Code is a Beast" · "What happens when you stop adding rules to CLAUDE.md" · "Anthropic cut 80% of Claude Code's system prompt" · "humanizer" skill · "Self-improvement Loop" skill
- r/ClaudeCode "Can someone explain the real difference between Hooks, Skills, Plugins..." · 926-session token audit
- Simon Willison: "Claude Skills are awesome, maybe a bigger deal than MCP"

**Honest caveat:** no public benchmark yet isolates description-phrasing on skill-selection accuracy end-to-end (closest are MetaTool/Trace-Free+ on tool descriptions). The load-bearing claims — description-is-the-router, <500-line ceiling, one-level-deep references, progressive disclosure, AGENTS.md-for-always-needed — are each supported by at least one measured source plus multiple corroborating practitioner reports. Community numbers are directional.
