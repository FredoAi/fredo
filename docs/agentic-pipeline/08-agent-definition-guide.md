# Agent Definition Guide (Research-Backed)

> **Status: GUIDANCE.** How to write a good `.opencode/agents/*.md` file. Source list at the bottom. This is the *how* behind principle 1 of [01-principles.md](01-principles.md) ("Agents Are People, Not Functions") — that rule states the *why*, this guide is the *how*.

---

## 1. Executive Summary

1. **Identity line is the highest-leverage instruction.** A concrete role reliably improves reasoning and sets the standard of work; "even a single sentence [of role] makes a difference" (Anthropic). Persona is scope/standard, not voice.
2. **Personality flavor hurts code.** Tone adjectives, verbosity caps, "be concise", and emotional framing measurably degrade output (Anthropic postmortem: ~3% eval regression from one verbosity line). Zero evidence they improve coding.
3. **Short beats comprehensive.** Instruction-following collapses toward zero at ~80 rules (VeyraBench); target < ~50 directives. "Bloated agent files cause Claude to ignore your instructions" (Anthropic).
4. **Affirmative over negation.** "Do X / when Y, do Z" outperforms "never / don't" (+36.4% correctness in the 26-Principles eval).
5. **Verification conditions are the #1 lever.** A check the agent can run (build, tests, screenshot) outperforms prose about quality.
6. **Front-load critical rules.** "Lost in the middle": models follow start and end of context best. Repeat top constraints near the end.
7. **Enforce in permissions, not prose.** Tool/file access is declarative (`permission:` allow/ask/deny + globs); the prompt doesn't plead for scope discipline.
8. **Model behavior as states.** Explicit step/state structure (plan → implement → verify → report) beats free-text behavior narration (Codified FSM papers).
9. **Structured sections beat prose.** Consistent headers/delimiters; fixed section order; important rules first.
10. **Iterate like code.** Ablate one rule at a time against a fixed small eval set; log failures; A/B from fresh sessions. Don't ship unmeasured prompt changes.

---

## 2. The Canonical Anatomy

The industry converged on **Markdown with YAML frontmatter**: frontmatter = machine-readable config the runtime reads; body = the system prompt the model reads. Keep them strictly separated.

### Frontmatter

| Field | Why it matters |
|-------|----------------|
| `description` | **The routing contract.** The orchestrating agent (and `@`-mention) uses it to decide when to delegate. Write it for a model, not a human: action-verb-led, with trigger conditions. *"Does X. Use when [scenario]."* Vague descriptions are the #1 failure mode. |
| `mode` | `primary` (human-facing entry) vs `subagent` (invoked via `task`) vs `all`. |
| `model` | Provider/model per role: cheap+fast for high-volume (developer), capable for reasoning (architect/QA). |
| `temperature` / `top_p` | **Only effective when thinking is disabled** on reasoning models (see §5 DeepSeek). |
| `permission` | Declarative least-privilege: `read`/`edit`/`bash`/`task`/`skill`/`external_directory`, `allow`/`ask`/`deny`, glob patterns, **last matching rule wins** (put `"*"` first, specifics after). `deny` on a subagent's `task` removes it from the tool list entirely. |
| `steps` | Max agentic iterations; forces a text summary when exhausted — bounds cost on unattended agents. |

**This pipeline's minimal agent files use only `description` + `mode`.** The `permission` field above is a general platform feature, but this pipeline does **not** declare permissions in the agent file — they live in `opencode.json` (per-agent `bash` allow/deny rules, tool access, and role gating), and `model`/`temperature` are set per role there as well. Keep the frontmatter to `description` + `mode` so the config that enforces access stays in one authoritative place.

### Body section order (fixed)

```
You are the **<Role>** agent. <one-line judgment standard — who you are + how you judge, NOT a step list>.

## Assignment          (the state call — every wake, get your work from the state machine + the ticket)
## Playbook            (link — the context block also prints it)
## References
```

**The agent file is deliberately thin: identity + one directive.** It holds *who the agent is* (a judgment standard) and the single rule that its work comes from the state machine and the ticket — the context block (phase, goals, playbook path, validation, handoff) plus the issue itself. It does **not** hold mechanics: no `In scope`/`Out of scope`/`Guardrails` step lists, no pipeline steps, no per-action instructions. Those live in the agent's playbook (`docs/agentic-pipeline/playbooks/<agent>.md`) and in the state machine, which the context block points to at runtime. This is principle 2 point 9 made concrete: *the state machine owns the mechanics; the agent keeps the judgment.* Keeping mechanics out of the agent file makes it stable across pipeline changes and keeps the always-loaded prompt small — the assignment directive is the same for every agent, so the only per-agent content is the identity line.

Order rationale: identity + most critical rules at top (attention weight + cache stability), volatile specifics at the bottom, top 2–3 non-negotiables restated near the end ("lost in the middle").

---

## 3. What the Research Says, Rule by Rule

### 3.1 Identity and persona

| Claim | Evidence |
|-------|----------|
| Role-play reliably changes reasoning | Kong et al. NAACL 2024 — role-play beats plain zero-shot across 12 reasoning benchmarks; more effective CoT trigger than "think step by step". |
| Personas don't improve objective accuracy | Zheng et al., Findings EMNLP 2024 — 162-role controlled study; per-persona effects largely random. |
| Persona can hurt reliability | Taday Morocho et al. 2026 (multi-attribute personas degrade survey alignment); The Persona Paradox (2026) — context-dependent, both directions. |
| Tone/verbosity constraints regress code | Anthropic postmortem (Apr 2026) — one "≤100 words" line → ~3% eval regression, reverted; 6,852-session community study — "simplest" +642% correlated with reasoning collapse. |
| Best practice: role sets standard, not voice | Practitioner consensus (SNOWFLOW brief, tweakcc author): "You are the sole engineer; quality is the product" — objective-setting, not chattiness. |

**Write:** `You are an expert <role> specialized in <stack/domain>. You are accountable for <standard>.` — 1–3 sentences max. Then stop.

### 3.2 Length and rule count

- **Ceiling:** instruction-following collapses to 0% by ~80 rules across all tested models/formats (VeyraBench). Target < 50 directives.
- **Prune test (Anthropic):** "Would removing this line cause Claude to make mistakes? If not, cut it."
- **Semantic density:** more info per token beats diluted prompts (+8.4pp avg); cut filler, redundancy, politeness.
- **Token cost of markup:** Markdown adds ~+22–37% tokens vs plain text — fine at this scale, but don't stuff static reference material into the file (use skills/on-demand loading instead).

### 3.3 Affirmative vs negative directives

- "Employ affirmative directives such as 'do,' while steering clear of negative language like 'don't'" — 26 Principles, evaluated **+36.4% correctness** on GPT-4. LLMs are measurably weak at negation.
- **Exceptions:** when a prohibition is essential, keep it short, place it as an explicit guardrail near the output point, and if it's truly non-negotiable, enforce it in a deterministic layer (permission/hook) — guardrails written once at the top get forgotten (system-prompt robustness research). In this pipeline, guardrails belong in the agent's **playbook**, not the agent file — the agent file stays identity + state-call.

### 3.4 Structure and position

- **Lost in the middle** (Liu et al., TACL 2023): U-shaped performance — best at start/end, worst mid-file. Front-load critical rules; restate top constraints near the end.
- **Fixed order is a feature:** prompt position changes behavior (Mao et al. NAACL 2024; Position is Power, FAccT 2025). Keep section order stable across versions.
- **Structured input pays off on instruction-following-heavy models** (Braun et al. 2025: +20pp then +10–13pp): use headers/delimiters and explicitly tell the agent "the input is structured; use the structure".
- **Conflict flag:** markdown advantage is model-specific (He et al. 2024: up to 40% variance on GPT-3.5, robust on GPT-4; VeyraBench: no reliable advantage). Test your format on your actual model.

### 3.5 Verification conditions

The single most repeated "what works" across all sources:

- Anthropic: "Give Claude a check it can run — tests, a build, a screenshot. It's the difference between a session you watch and one you walk away from."
- OpenAI: "define what counts as done and how the model should verify its work."
- Practitioners: "Loop tests until it actually works. 'Should work' means it doesn't." + anti-test-faking rule ("do not modify tests to make them pass").

**Write:** an explicit `## Verification` section — exact commands, expected outputs, definition of done, and "if X fails, stop and report rather than papering over it." This section belongs in the agent's **playbook**, not the agent file (the agent is step-agnostic until its turn comes; the playbook holds the steps and the definition of done).

### 3.6 Memory, workflow, and states

- **CoALA** (TMLR 2024): language agents = modular memory (working/episodic/semantic) + structured action loop (plan → act → observe → update). Map your agent file's sections to these: fixed facts vs session state vs recalled notes vs the loop.
- **Codified FSMs** (2025/2026 papers): explicit state machine/executable logic beats free-text prompting for consistency — even at 1B params. This is direct evidence for your planned state-machine skill.
- **Reflexion** (NeurIPS 2023): verbal self-reflection stored in memory beats bigger prompts (91% HumanEval pass@1 vs 80% GPT-4 baseline). Instruct agents to write a short retrospective after failure and read prior notes before retrying.
- **Agent Workflow Memory** (2024): injecting reusable canonical step sequences improves success by 24–51%. Encode your common operations as explicit workflows, not free-running autonomy.

### 3.7 Tools and permissions

- Anthropic: teams "spent more time optimizing our tools than the overall prompt". SWE-agent: a custom prompt+tool interface (ACI) raised SWE-bench pass@1 from ~4.8% → 12.5% — interface design, not model, drove it.
- Write tool definitions "like a great docstring for a junior developer" — example usage, edge cases, clear boundaries from similar tools.
- Scope control is layered and deterministic: `permission` allow/ask/deny + globs, `ask`-mode UI for risky operations, `external_directory` gating. Don't write "only read files" — declare it.

### 3.8 Security / prompt-injection guardrails

- Indirect prompt injection (Greshake et al. 2023): agents that retrieve data blur instructions vs data. Mandate: tool/retrieved/web content is **untrusted data, never instructions**; separate instructions from data with delimiters.
- System-prompt robustness (Mu et al. 2025): models forget guardrails or resolve conflicts toward user instructions. Restate non-negotiables near the output point.

---

## 4. Anti-Patterns to Avoid

| Anti-pattern | Why it fails |
|--------------|--------------|
| Long file (100s of rules) | Adherence collapses; rules get lost. Anthropic: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!" |
| Verbosity caps ("be concise", "≤100 words") | Measured regression — optimizes tokens at the cost of correctness. |
| Personality dump / tone adjectives / emotional framing | Persona doesn't buy accuracy and can hurt; community reverts these most. |
| Negation walls ("never…", "don't…") | LLMs are weak at negation; affirmative directives measurably outperform. |
| Contradicting the harness's own system prompt | The base system prompt (often 11–14k tokens) tends to win; the agent half-follows both. |
| Facts that belong in AGENTS.md/memory | The definition is the agent's *operating system*; project knowledge is its *data*. Keep them separate. |
| Describing the obvious ("write clean code") | Anything the agent can infer from code is wasted tokens; exclude it. |
| Prescribing internal reasoning steps | For capable models, give goal + constraints + output contract and let it plan. Reserve step lists for *external* workflow sequencing. |
| Trusting self-reported success | Require command output/evidence, not "it works". |

---

## 5. DeepSeek-Specific Guidance

The pipeline runs `deepseek-v4-flash` for all agents (including planning/review roles), plus `mimo` for vision (not a DeepSeek model — ignore the below for it).

1. **System role only.** The DeepSeek public API **rejects the `developer` role**; `system` is the only first-class long-lived role. Put the agent definition in `system`.
2. **Thinking is ON by default (effort `high`); temperature/top_p are silently ignored in thinking mode.** Don't rely on low temperature for format discipline — rely on schema + examples. If tuning sampling, use the official agentic recipe `temperature=1.0, top_p=0.95` (Flash-0731 card) / `1.0/1.0` (Pro card) in non-thinking mode.
3. **Don't write "think step by step" boilerplate.** At `reasoning_effort=max` the API already prepends an official "Absolute maximum with no shortcuts permitted…" preamble. Redundant exhortations waste tokens and fight the built-in preamble. Keep definitions functional, not motivational.
4. **Never instruct free-text JSON.** Require tool calls or `response_format=json_object` (which needs the literal word "json" + an example in the prompt). Empty content is a documented failure mode — add retry-on-empty in the harness.
5. **Expect tool-call markup fragility.** V4 may emit DSML tool-call markup inline in `content` (canonical `<｜DSML｜…>` or degraded `<||DSML||…>` without newlines) instead of structured `tool_calls`. The harness must parse from either field and normalize. Use opencode's built-in DeepSeek provider (≥ v1.14.24) which handles this.
6. **`reasoning_content` must round-trip.** If the harness builds raw requests with tools, omitting the prior `reasoning_content` returns HTTP 400. The native opencode provider handles this for you.
7. **Strip safety artifacts.** Both models intermittently leak `<ds_safety>…</ds_safety>` (and a trailing "Safe") into output — filter before display/persistence.
8. **Exploit 1M context, but budget reasoning accumulation.** In tool-using loops DeepSeek preserves all prior reasoning in context (fast growth). Prefer compact agent definitions, prune old tool results, use cache-hit pricing.
9. **Set effort per role.** Flash maps `max→max` (real gains at max); map cheap/high-volume agents → flash @ high/max, planning/review → pro @ max.
10. **Verify runtime behavior, don't assume.** This repo's telemetry shows event streams (`session.status` deltas, `message.part.updated` subtask parts) that other models emit **never fire** on `deepseek-v4-flash-free`. Agent/harness designs must have fallback paths, verified against the actual model.
11. **Persona: keep it light.** DeepSeek reports positivity bias rather than persona sensitivity — a short role line helps; extensive persona flavor amplifies cheerfulness and wastes tokens.

---

## 6. The Suggested Skeleton

```markdown
---
description: Does X. Use when [trigger scenario]. Outputs [artifact].
mode: subagent
---
You are an expert <role> specialized in <stack>. <One-sentence judgment standard / prime directive>.

## Assignment
Your work comes from the state machine and the ticket — on every wake:
1. Load the `pipeline-state` skill and read it — the state machine is reached only through its skill (principle 9).
2. Run `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <name>` and read the context block: phase, goals, playbook, validation, handoff.
3. If the context block says `BLOCKED: <reason>`, report it — do not attempt the phase.
4. Do the work per your playbook; every GitHub write is requested through the state machine, never by calling `gh`/`git` directly.

## Playbook
Your steps live in the playbook — read it before you start:
See ../../docs/agentic-pipeline/playbooks/<agent>.md for the operational how-to (workflow, verification).

## References
- <pipeline docs and canonical references for this agent's phase>
```

**The steps belong in the playbook, not here.** The agent file holds identity (a judgment standard) and the state-call directive only; scope boundaries, guardrails, and mechanics live in the playbook (`docs/agentic-pipeline/playbooks/<agent>.md`), which holds the `## Workflow` (numbered steps with transitions, starting with the "Start of work" load-skill step) and `## Verification` (definition of done) sections. The agent reads its playbook when its turn comes — it is step-agnostic until then.

---

## 7. Iteration & Evaluation

- **Ablate one rule at a time** against a fixed 3–5 task eval set. Anthropic's postmortem governance: per-model evals + line-level ablations for every system-prompt change. If a change doesn't measurably shift behavior, revert or rewrite — don't add more lines.
- **Log failures as a first-class artifact** (a `DONT_DO.md` / retro note per agent) — the agents that show cause/effect are the ones that log sessions.
- **A/B only from fresh sessions** — accumulated context contaminates comparisons.
- **Use verifiable checks + a calibrated judge.** IFEval-style machine-checkable rules + an LLM judge with position-swapping and human calibration; LLM judges are biased toward LLM text.
- **One canonical, well-tested definition beats many ad-hoc ones** (SPRIG, ICLR 2026: a single optimized system prompt matched per-task prompts across 47 task types).
- **Iterate in the loop, not just the file.** After two failed corrections, `/clear` and write a better prompt rather than fighting polluted context.

---

## 8. Sources

**Scientific literature**
- Kong et al., "Better Zero-Shot Reasoning with Role-Play Prompting", NAACL 2024 — arxiv.org/abs/2308.07702
- Zheng et al., "When 'A Helpful Assistant' Is Not Really Helpful", EMNLP 2024 — arxiv.org/abs/2311.10054
- The Prompt Report, Schulhoff et al. 2024 — arxiv.org/abs/2406.06608
- Principled Instructions Are All You Need, Bsharat et al. 2023 — arxiv.org/abs/2312.16171
- Lost in the Middle, Liu et al., TACL 2023 — arxiv.org/abs/2307.03172
- CoALA (Cognitive Architectures for Language Agents), TMLR 2024 — arxiv.org/abs/2309.02427
- ReAct, ICLR 2023 — arxiv.org/abs/2210.03629
- Reflexion, NeurIPS 2023 — arxiv.org/abs/2303.11366
- MemGPT, ICLR 2024 — arxiv.org/abs/2310.08560
- Codified Finite-State Machines for Role-Playing, 2026 — arxiv.org/abs/2602.05905 (+ Codifying Character Logic, 2505.07705)
- Agent Workflow Memory, 2024 — arxiv.org/abs/2409.07429
- Indirect Prompt Injection, Greshake et al. 2023 — arxiv.org/abs/2302.12173
- System Prompt Robustness, Mu et al. 2025 — arxiv.org/abs/2502.12197
- AgentBench, ICLR 2024 — arxiv.org/abs/2308.03688
- SWE-bench, ICLR 2024 — arxiv.org/abs/2310.06770
- SWE-agent (ACI), ICLR 2025 — arxiv.org/abs/2405.15793
- VeyraBench "Prompt Design at Scale", 2026 — arxiv.org/abs/2607.19257
- IFEval — arxiv.org/abs/2311.07911 · G-Eval — arxiv.org/abs/2303.16634 · LLM-as-a-Judge — arxiv.org/abs/2306.05685
- The Persona Paradox, 2026 — arxiv.org/abs/2601.05376 · Persona Reliability, 2026 — arxiv.org/abs/2602.18462

**Vendor docs**
- Anthropic — Building effective agents, context engineering, Claude Code best practices, April 2026 postmortem, subagents/skills docs
- OpenAI — Practical Guide to Building Agents, Agents SDK, Reasoning models, Prompt engineering guide
- Google — Gemini prompting strategies, system instructions, agents overview
- OpenCode — docs: agents, permissions, skills, rules, models

**DeepSeek**
- api-docs.deepseek.com — thinking mode, tool calls, JSON mode, Anthropic API compat, OpenCode integration, pricing (1M ctx / 384K out)
- HuggingFace model cards — DeepSeek-V4-Pro, DeepSeek-V4-Flash-0731 (+ `encoding/README.md`), DeepSeek-V4 technical report (arxiv.org/abs/2606.19348)
- HF discussions — DSML markup degradation (#209), `<ds_safety>` leaks (#201, #27)
- github.com/deepseek-ai/awesome-deepseek-agent

**Community (anecdotal — directional, flagged as such)**
- r/ClaudeCode: 25 things I've learned (462pts), Claude Code is a Beast (869pts), CLAUDE.md handling (702pts), Anthropic made Claude 67% dumber / 6,852-session study (1,922pts), ~100h vs ~20h comparison (2,188pts), SNOWFLOW base prompt (5,255pts), DeepSeek v3.2 in Claude Code (293pts)
- r/LocalLLaMA: backend-lead context budget (1,971pts), 4B coding agent (901pts)
- r/ClaudeAI: gaslighting/persona tricks (3,428pts — entertainment, not evidence)

**Honest caveat:** there is no public benchmark comparing "agent definition file structures" head-to-head. The load-bearing claims above (length→ignored rules, verbosity→regression, context-fill→forgetting, front-loading, affirmative>negative, verification>prose) are each supported by at least one measured/Tier-1 source plus multiple corroborating practitioner reports. Community numbers are directional, not precise.
