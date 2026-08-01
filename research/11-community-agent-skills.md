# Research Report: Practitioner Communities on Agent Skills

**Agent:** Research Analyst (community survey)
**Date:** 2026-08-01
**Scope:** r/ClaudeAI, r/ClaudeCode, r/cursor, Anthropic docs, Simon Willison's blog, Vercel engineering, GitHub
**Research window:** Oct 2025 – Jul 2026 (post-Skills-launch era)

---

## Executive Summary — Top 10 Findings

1. **The #1 failure mode is activation, not content.** Practitioners report writing large, careful skills the agent *never loads* — even when the user types the skill's own keywords. Vercel's eval quantified it: a skills default behavior scored **53% = baseline (0pp gain)** because the skill was never invoked in 56% of cases. "The agent had access to the documentation but didn't use it."

2. **The description is the entire product.** Only the frontmatter `description` (a few dozen tokens) sits in context at startup; the agent picks a skill from that text alone, from potentially 100+ skills. "Critical for skill selection."

3. **Vague descriptions = dead skills.** Canonical failures: `"Helps with documents"`, `"Processes data"`, `"Does stuff with files"`. Skills whose descriptions don't state trigger conditions sit unused.

4. **Length guidance converges hard: <500 lines for SKILL.md body, ~100 lines for CLAUDE.md.** Most widely-corroborated number (Anthropic + Claude Code docs + the "6 months" power user's measured 1,500-line → 398-line restructure).

5. **Progressive disclosure (thin SKILL.md + resource files) is universally praised** — with a caveat: reference files must hang **one level deep** off SKILL.md. Deeply nested references cause partial `head -100` reads and lost information.

6. **The highest-ceiling pattern for "always-relevant" knowledge is NOT a skill.** Vercel's evals: a compressed 8KB docs index in `AGENTS.md` hit **100%** vs 79% for skills-with-instructions. Passive context beats active retrieval when knowledge is needed for *every* task. Skills win for *vertical, explicitly-triggered* workflows.

7. **Wording is fragile.** Vercel: "You MUST invoke the skill" vs "Explore project first, then invoke skill" produced dramatically different outcomes on the *same* skill and docs.

8. **Cost of unused skills is real and measurable.** A practitioner's 858-session token audit: 42 installed skills, **19 invoked ≤2 times**, each still occupying context on every turn. Context hygiene was his highest-leverage optimization.

9. **The skills vs rules vs subagents line:** CLAUDE.md/AGENTS.md = always-on, load-bearing, universal facts and hard rules. Skills = modular procedures/domains loaded on demand. Hooks = determinism. Subagents = skill content but with *its own context window*, different model, parallelism. "A rule the model only meets after it decides to load a skill file is a rule it meets too late."

10. **The community is moving toward treating skills as software:** evals before writing, "Claude A authors / Claude B tests" loops, session-wrap retro skills that rewrite their own rules, `/doctor` audits, dashboards flagging "skills to consider disabling."

---

## What FAILS with skills

### 1. Skills that sat unused — the dominant complaint
- **r/ClaudeAI, "Claude Code is a Beast"** (2,332 pts): wrote "comprehensive skills... thousands of lines of best practices." Result: *"And then... nothing. Claude just wouldn't use them. I'd literally use the exact keywords from the skill descriptions. Nothing... the skills just sat there like expensive decorations."* Fixed only with a UserPromptSubmit hook + regex trigger config that force-injects skill suggestions. → **Widely-corroborated (the archetypal complaint).**
- **Vercel engineering, "AGENTS.md outperforms skills in our agent evals"** (Jan 2026): skill default behavior = 53% pass, identical to no-docs baseline. Skill never invoked in 56% of cases. **Unused skill slightly hurt metrics** (58% vs 63% on tests) — "an unused skill in the environment may introduce noise or distraction." → **Data-driven; the strongest single source.**
- **r/cursor, "Agents/Claude.md vs SKILLS - research by vercel"** (83 pts): practitioner considering converting all workflows to skills reversed course after reading the Vercel data.

### 2. Description/content mismatch → wrong or never-loaded skills
- **Anthropic best-practices docs** explicitly: vague descriptions (`"Helps with documents"`) break discovery. → Vendor docs, matches practitioner reports.
- **r/ClaudeCode, "Can someone explain the real difference between Hooks, Skills, Plugins, SKILL.md, CLAUDE.md and agents.md?"** (778 pts): several commenters confirmed skills with weak triggers don't fire.

### 3. Bloat / monolithic skills
- **"Claude Code is a Beast"**: his `frontend-dev-guidelines` was 1,500+ lines; "These monolithic files were defeating the whole purpose of skills." Restructured to 398-line main + 10 resource files; reported **40–60% token-efficiency improvement**.
- **Anthropic docs:** "Keep SKILL.md under 500 lines." → Widely-corroborated.

### 4. Rules/CONTEXT bloat — CLAUDE.md past ~100 lines becomes suggestions
- **r/ClaudeAI, "What happens when you stop adding rules to CLAUDE.md and start building infrastructure instead"** (542 pts): "It started lean. 45 lines... Three months later 190 lines and Claude was ignoring more instructions than when I started. Instructions past about line 100 start getting treated as suggestions, not rules." → **Widely-corroborated** (about CLAUDE.md, not SKILL.md — but the bloat principle transfers).

### 5. Hard rules built for older models now *fight* the model
- **r/ClaudeAI, "Anthropic cut 80% of Claude Code's system prompt for the Claude 5 models"** (1,557 pts): Anthropic removed most hard rules in favor of judgment; recommends a **tree of files loaded when needed** instead of one big CLAUDE.md. "A lot of what accumulates in these files is scar tissue from older models, and those lines now fight the model instead of helping it."

### 6. Resource-file / reference-sinking failures
- **Anthropic best-practices, "Avoid deeply nested references"**: agents `head -100` preview files and get incomplete info. Keep references one level deep.
- Skills "went stale as the codebase evolved" — "Best structure in the world doesn't matter if the docs don't update when the code does."

### 7. Skills as cargo cult
- **r/ClaudeCode, "Inherited a 3-month old repo from a Vibe Engineer"** (7,330 pts): "dozens of skills and different agent roles," "309k lines of code covered by 240k lines of docs." OP: "how do you know if it helps or just produces the feeling that you are doing a lot?" → Cautionary tale about skills as process theater.

### 8. Skill descriptions themselves cost tokens
- **r/ClaudeCode, "i did audit of 926 sessions"** (553 pts): 45k-token startup payload; 42 skills of which 19 had ≤2 invocations across 858 sessions; every skill's schema sat in context on every turn.

---

## What WORKS with skills

1. **Short, sharp, single-purpose skills.** Lightweight main file + resource files; skills per domain; CLAUDE.md reduced to ~200 lines, skills carry the "how to write code" guidelines. "Separation of concerns for the win."
2. **Force activation with hooks** (when auto-invocation fails). UserPromptSubmit hook + keyword/intent regex config made skills reliably load: "The difference is night and day... Auto-activation is the only way skills actually work reliably."
3. **Examples *inside* the skill.** The viral humanizer skill: pure before/after examples organized into a "tells catalog" + two-pass/audit workflow. "Examples convey the desired style... more clearly than descriptions alone."
4. **Procedural/checklist skills for recurring boring work.** `/wrap-up` — "basically a glorified checklist." "The best skills aren't the ones that do impressive things. They're the ones that run the boring routines you'd skip."
5. **Explicit instructions to use a skill** (solves activation, partially). Vercel: adding "Before writing code, first explore the project structure, then invoke the nextjs-doc skill" to AGENTS.md raised trigger rate to 95%+ and pass rate to 79% (+26pp). **Caveat: wording is fragile.**
6. **Passive context (AGENTS.md/CLAUDE.md) for always-needed knowledge — the "skill-killer" pattern.** Vercel: compressed 8KB docs index in `AGENTS.md` = 100% pass. "Skills... work better for vertical, action-specific workflows that users explicitly trigger." → **Most important nuance in the corpus.**
7. **Progressive disclosure with scripts.** Doc skills use scripts + validators; "scripts are executed, not loaded" → only output consumes tokens. Pre-made scripts "more reliable than generated code, save tokens."
8. **Adversarial-reviewer / post-processing skill pattern.** "It fixed the one thing I could never get Claude to do." Style as post-processing, not front-loaded rules.
9. **Meta-skills and skill-chaining.** `skill-creator` (a skill that writes skills), chaining demo (PowerPoint → Brand Guidelines → Poster in one conversation).
10. **Reference skills as dynamic context (injection).** `` !`git diff HEAD` `` runs commands before Claude sees the skill, so instructions arrive with live data.

---

## Description-quality evidence

- **Mechanism:** skill metadata (name + description) is pre-loaded at startup; the body loads only on invocation.
- **What makes a description selectable** (Anthropic, verbatim + practitioner agreement):
  1. **Third person only** ("Processes Excel files..." — NOT "I can help you..."); inconsistent POV "can cause discovery problems."
  2. **What + when**: state what it does *and* specific triggers.
  3. **Key terms / keywords** matching how users phrase requests.
  4. Claude Code adds: "Put the key use case first"; combined `description` + `when_to_use` truncated at 1,536 chars.
  5. **Naming:** gerund form (`processing-pdfs`, `testing-code`); avoid `helper`, `utils`, `tools`.
- **Anti-evidence / honest caveat:** one commenter documented the skill index + CLAUDE.md are conversation-history artifacts, not system-prompt items — "they get forgotten more and more as context fills," so description quality cannot fully compensate for long sessions. Credibility: mid (source-code-based, disputed in-thread).

---

## Length & structure evidence

| Guidance | Source | Credibility |
|---|---|---|
| SKILL.md body **< 500 lines**; split above that | Anthropic best-practices; Claude Code docs | Vendor-doc / widely-corroborated |
| Monolithic 1,000–1,500-line skills "defeated the purpose" → ~400 lines | "Claude Code is a Beast" (measured 40–60% token savings) | Strong practitioner data |
| CLAUDE.md ceiling ~100 lines | "What happens when you stop adding rules..." + mod consensus | Widely-corroborated (CLAUDE.md) |
| "200 lines is what I meant by short" | r/ClaudeCode | Anecdotal |
| Keep references **one level deep**; refs >100 lines need TOC | Anthropic best-practices | Vendor-doc |

**Structural findings:**
- Progressive disclosure (SKILL.md = overview + links → reference files loaded on demand) endorsed by vendor and practitioners.
- Vercel twist: for *broad horizontal knowledge*, an 8KB compressed *index* in AGENTS.md pointing to retrievable files beats skills entirely.
- Per-domain organization keeps "sales questions from loading finance schema."

---

## Skills vs rules vs subagents — where practitioners draw the line

- **The canonical thread:** r/ClaudeCode "Can someone explain the real difference..." (778 pts). Best comment (522 pts): CLAUDE.md = first-day onboarding (always on); Skill = "basically just a prompt you save for later... Claude sees these and decides when to use them"; Hook = "when skills are too loosey-goosey and I want hard programmatic determinism"; Plugin = bundle; Agent/Subagent = LLM program with its *own* context, can run different models in parallel.
- **"CLAUDE.md + front matter of your skills is loaded at the start of every conversation. Everything in CLAUDE.md is for every prompt; anything that doesn't need to be understood for every prompt belongs in a skill."**
- **"CLAUDE.md is a router, not a rulebook."** The less you put in CLAUDE.md, the more reliably the agent follows what's there.
- **Split by consequence, not topic:** "Anything whose failure costs something irreversible stays inline in CLAUDE.md... A rule the model only meets after it decides to load a skill file is a rule it meets too late."
- **Vercel (data-driven):** passive context for horizontal/always-needed knowledge; skills for **vertical, explicitly-triggered workflows**.

---

## Iteration / eval practices

- **Eval-first development** (Anthropic): build 3 evals *before* writing docs; baseline without skill; write minimal content; iterate. "Evaluations are your source of truth."
- **Claude A / Claude B loop:** one instance authors/refines the skill, another tests it on real tasks.
- **Observe how the agent navigates the skill:** watch for ignored resource files, files read repeatedly (→ promote to main SKILL.md), unexpected read order.
- **Self-improvement loops (practitioner innovation):** `/wrap-up` retro that auto-writes rules; `/retro` 3-phase loop (summarize → update CLAUDE.md/skills → audit >95 lines); "Had to explicitly add 'log mistakes and near-misses' as a required step. The self-improvement loop only works if agents are honest about failure."
- **Logging which skills actually load:** the 926-session token auditor parses session JSONL into SQLite, auto-flags "skills to consider disabling" with reasons (never used / low frequency / errors). → **The strongest "measure it" practice.**
- **Audit tooling:** `/doctor` (audits CLAUDE.md + skills for stale-model rules), `claude-md-management` plugin ("76K–93K installs," letter grades on CLAUDE.md quality).

---

## Concrete, actionable recommendations for writing a good SKILL.md

1. **Write the description like a function signature for a search engine.** Third person, `<does X> + <use when>` in one or two sentences, concrete key terms first, no "I can…/you can…" POV. It is the only thing the agent sees at selection time, and it is truncated.
2. **Put trigger conditions and trigger phrases in the description explicitly** — then test that a fresh session loads it on a natural-sounding prompt. If it doesn't load, fix the description before adding more content.
3. **Keep SKILL.md under 500 lines — aim for ~200–400.** State what to do; strip explanations the model already knows. Every loaded line is a recurring per-turn token cost.
4. **Use progressive disclosure, exactly one level deep.** SKILL.md = overview + explicit pointers. Do NOT nest references. Reference files >100 lines get a table of contents. Bundle scripts (executed, not loaded) for deterministic steps.
5. **Decide who can invoke it and say so in frontmatter.** Recurring-but-dangerous actions → `disable-model-invocation: true`. Pure background knowledge → `user-invocable: false`.
6. **Include concrete before/after examples, not adjectives.** Examples convey style more clearly than descriptions alone.
7. **Prefer scripts and validation loops over prose** for fragile steps: "run validate.py; if it fails, fix and rerun; only proceed when it passes."
8. **Give complex workflows a copyable checklist** so the agent tracks progress and doesn't skip validation steps.
9. **Match instruction rigidity to task fragility** ("degrees of freedom"): exact script + "do not modify" for migrations; loose guidance for reviews.
10. **Keep time-sensitive info out, or quarantine it** in an `<details>` "old patterns" section.
11. **For knowledge needed every task, don't use a skill at all** — put a compressed index in AGENTS.md pointing to retrievable docs. Reserve skills for vertical, explicit-trigger workflows.
12. **Never write "hard rules" into skills that must always hold** (irreversible constraints). Those belong inline in CLAUDE.md — "a rule the model only meets after it decides to load a skill file is a rule it meets too late."
13. **Build evals before writing the skill.** Three tasks it must pass; baseline without it; iterate. Test against every model you'll actually run.
14. **Iterate with two roles:** one instance authors/edits, a fresh instance uses it on real work. Watch which resource files it reads/ignores.
15. **Instrument activation.** Run a periodic audit of which skills actually loaded; delete or archive skills with ~zero invocations — each costs context every turn and can add noise.
16. **Prefer a plain textual skill over attaching an MCP server.** A markdown file + CLI beats an MCP server on token cost and shareability for most cases.
17. **Version your rules/skills like code.** The single biggest recurring lesson is to audit and prune rather than accumulate.

---

## Source list

**Reddit:** "Claude Code is a Beast" (r/ClaudeAI 1oivjvm / r/ClaudeCode 1oivs81, 2,332 pts) · "What happens when you stop adding rules..." (r/ClaudeAI 1rz2oo3, 542 pts) · "Anthropic cut 80% of Claude Code's system prompt" (r/ClaudeAI 1v5mhhl, 1,557 pts) · "Can someone explain the real difference between Hooks, Skills, Plugins..." (r/ClaudeCode 1tmq9kz, 778 pts) · "i did audit of 926 sessions" (r/ClaudeCode 1sd8t5u, 553 pts) · "humanizer" (r/ClaudeCode 1sy4137, 617 pts) · "Self-improvement Loop" (r/ClaudeCode 1r89084, 292 pts) · "I've been tracking what people are building with Claude Skills" (r/ClaudeAI 1o9ph4u, 1,059 pts) · "Inherited a 3-month old repo" (r/ClaudeCode 1tb7edc, 7,330 pts) · "Agents/Claude.md vs SKILLS - research by vercel" (r/cursor 1qvhpw5, 83 pts) · "adversarial reviewer skill pattern" (r/ClaudeAI 1vc11nl, 378 pts)
**Vendor/engineering:** Vercel "AGENTS.md outperforms skills in our agent evals" · Anthropic "Skill authoring best practices" · Claude Code "Extend Claude with skills" · Anthropic "The new rules of context engineering for Claude 5 generation models"
**Blogs:** Simon Willison "Claude Skills are awesome, maybe a bigger deal than MCP"

**Quality caveats:** Strongest = Vercel eval + 926-session audit (data-driven). Widely-corroborated = skills-not-activating, <500-line SKILL.md / ~100-line CLAUDE.md, CLAUDE.md-is-a-router, description quality decisive, retro/self-improvement loops, bloat-must-be-pruned. Anecdotal = 40–60% token-efficiency figure, exact invocation drop-off mechanism (disputed), unused-skills-hurt-metrics (Vercel, small n).
