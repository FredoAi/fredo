# Research Report: Packaging Agent Capabilities — Skills, Tools, and MCP

**Agent:** Research Analyst (external literature + community/standards sources)
**Date:** 2026-10-25
**Scope:** How to package reusable agent capabilities (tools/skills) so agents call vetted, parameterized, allowlisted capabilities instead of writing ad-hoc scripts. Design, scoping, naming, and security boundaries for a skill/tool library.
**Method:** Primary papers (Toolformer, Gorilla, ToolLLM, Voyager, API-Bank, BFCL, tool-learning surveys) + standards/vendor docs (Anthropic Agent Skills + best practices, Model Context Protocol spec + security best practices, OpenAI function calling, LangChain tools) + security literature (lethal trifecta, design patterns for securing LLM agents).

---

## Executive Summary

- **Two complementary packaging models dominate.** *Skills* package procedural knowledge as a folder (`SKILL.md` + optional scripts/resources) loaded by **progressive disclosure**; *tools/MCP* expose callable, schema-typed functions. The consensus is to use both: tools for the *verbs*, skills for the *how/when*.
- **Progressive disclosure is the core scalability mechanism.** Load only `name`+`description` at startup (~100 tokens/skill), the `SKILL.md` body on trigger (<5k tokens), and bundled files only on demand.
- **Granularity should be tuned to task fragility, not minimized.** Provide *high freedom* (prose guidance) where many approaches work and *low freedom* (an exact script, no parameters) where consistency is critical.
- **Deterministic operations belong in committed code, not model-generated code.** Sorting, parsing, form-filling, validation are cheaper, more reliable, and token-efficient as pre-written scripts.
- **Tool surfaces must stay small and discoverable.** OpenAI recommends <20 functions available at once and offers deferred "tool search"; MCP adds `tools/list` discovery and `listChanged` notifications.
- **Naming and description are load-bearing.** The description is the sole selection signal among 100+ skills/tools; write it in third person, state *what* and *when*, avoid vague names (`utils`, `helper`).
- **Security is the sharpest edge: capabilities that combine private data + untrusted content + external communication form the "lethal trifecta."** Once an agent ingests untrusted input, it must be constrained so that input cannot trigger consequential actions.
- **Least privilege, allowlisting, and input validation are mandatory across the ecosystem.** MCP servers MUST validate inputs, rate-limit, and sanitize outputs; clients SHOULD confirm sensitive calls.
- **The ad-hoc-script escape hatch is the primary anti-pattern.** Prefer many small typed tools over arbitrary code execution; treat "agent writes AND executes code" as a high-risk posture requiring isolation.
- **The ecosystem has standardized on a folder format.** `SKILL.md` with YAML frontmatter (`name`, `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools`) + `scripts/`, `references/`, `assets/` — now an open standard with a reference validator.

---

## Principle → Rationale → Citation

| Principle | Rationale | Citation |
|---|---|---|
| Progressive disclosure (metadata → instructions → resources) | Keeps idle context cost to ~100 tokens/skill | Anthropic Agent Skills |
| Keep `SKILL.md` under ~500 lines; one-level-deep references | Deep reference chains cause partial reads | Anthropic best practices |
| Tune "degrees of freedom" to fragility | Narrow bridge (migrations) needs exact scripts; open field (reviews) needs heuristics | Anthropic best practices |
| Prefer deterministic code over model-generated code for fragile ops | Code is reliable, repeatable, cheaper than token generation | Anthropic / Toolformer |
| Write descriptions in third person, stating what + when | The description is the single selection signal | Anthropic / OpenAI |
| Avoid vague/generic names (`utils`, `helper`) | Vague names impede discovery and maintenance | Anthropic best practices |
| Keep initially-available tool count small (<20) | Fewer upfront tools → higher selection accuracy | OpenAI function calling |
| Defer large tool surfaces via search/discovery | Lets agents hold thousands of tools without context bloat | OpenAI `tool_search`; MCP `tools/list` |
| Use enums/typed schemas to make invalid states unrepresentable | `toggle_light(on, off)` permits invalid calls | OpenAI / MCP / LangChain |
| Offload known arguments to code; combine always-sequential calls | Don't make the model fill IDs you already hold | OpenAI function calling |
| Package reusable, compositional, executable skills | A growing library compounds ability and reduces forgetting | Voyager |
| Retrieve/version tool docs at call time | Retriever grounding mitigates wrong-argument hallucination | Gorilla |
| Validate all tool inputs; rate-limit; sanitize outputs | Inputs/outputs are the trust boundary | MCP Tools spec |
| Human-in-the-loop confirmation for sensitive invocations | Model-controlled tools need visible confirmation + audit | MCP Tools spec |
| Least-privilege, minimal initial scopes; incremental elevation | Broad tokens expand blast radius | MCP Security Best Practices |
| Treat tool annotations/descriptions as untrusted | Malicious servers can lie about behavior | MCP Tools spec |
| Avoid the "lethal trifecta" (private data + untrusted content + egress) | Combined, an attacker can trick the agent into exfiltration | Willison; Beurer-Kellner et al. |
| Constrain post-ingestion agents so untrusted input can't act | "Once an agent ingests untrusted input, it must be constrained…" | Design Patterns for Securing LLM Agents |
| Audit skills like installing software; scan dependencies | Malicious skills can call tools/run code against the stated purpose | Anthropic skills security guidance |
| Sandbox local servers; never shell-exec URLs/commands | Local MCP servers = arbitrary code execution with client privileges | MCP Security Best Practices |
| Standard folder + frontmatter; validate with `skills-ref` | Interoperability, discovery, mechanical validation | Agent Skills spec |

---

## Design Guidance for a Skill/Tool Library That Replaces Ad-Hoc Agent Scripts

### 1. Scope — what becomes a committed capability vs a one-off

**Commit as a tool/skill when any hold:**
- The operation is **deterministic and repeated** (parsing, extraction, formatting, validation, DB migration).
- The operation is **fragile** (destructive, ordered, high-stakes) → *low freedom*: an exact script with few/no parameters.
- The operation **requires capabilities the model lacks reliably** (arithmetic, precise lookup).
- The behavior must be **reused across agents/sessions** or **audited/versioned**.

**Leave as agent-authored/ad-hoc when:**
- The task is **open-ended, exploratory, or context-dependent** with many valid paths (*high freedom*).
- It is a **genuine one-off** with no reuse and no fragility.
- **Crucially:** even then, prefer a **typed tool call** over handing the model an arbitrary code-execution primitive.

**Anti-pattern to ban:** agents that both **write and execute arbitrary code** without isolation — the escape hatch that turns a prompt injection into RCE.

### 2. Method / Interface

- **One folder per capability, `SKILL.md`-first.** Frontmatter: `name` (lowercase/hyphen, ≤64 chars), `description` (≤1024 chars, third person, what + when); optional `license`, `compatibility`, `metadata`, `allowed-tools`.
- **Conventional subdirectories:** `scripts/` (executable, self-contained), `references/` (on-demand docs), `assets/` (templates/data). Validate with `skills-ref validate`.
- **Interface surface = typed schema.** JSON Schema with `enum`s, per-parameter descriptions, strict/required fields. Bar: could an intern use it given only the description?
- **Progressive disclosure inside the skill.** `SKILL.md` is a table of contents; push detail one level deep.
- **Feedback loops and verifiable intermediate outputs.** Plan → validate → execute with a machine-checkable intermediate file.
- **Evaluation-driven authoring.** Build 3+ evaluations before writing docs.
- **Discovery at scale.** Namespace/group related tools; defer rarely-used tools behind search.
- **Return typed structured content** where downstream reasoning benefits.
- **Standardize naming** (gerund/noun-phrase; `snake_case` identifiers).

### 3. Security Boundaries

- **Least privilege by default.** Minimal scopes (read/discovery first); elevate incrementally; log elevation.
- **Allowlist, don't blocklist.** Reject `javascript:`/`data:`/`file:`; validate redirect targets; block private IP ranges / cloud metadata (SSRF).
- **Validate every input, sanitize every output, rate-limit, audit** (MUST-level in MCP).
- **Keep a human in the loop** for sensitive operations; show exact inputs before invocation.
- **Treat descriptions/annotations as untrusted** unless from a trusted server.
- **Isolate execution.** Sandboxed filesystem/network; prefer `stdio`; never shell-execute URLs/commands; no token passthrough.
- **Vet and audit third-party skills like installing software.**
- **Design against the lethal trifecta.** Remove one leg, or apply a provable pattern (constrain the agent so untrusted input cannot trigger consequential actions; dual-LLM / planner-executor separation).
- **Runtime tool allowlisting** (e.g. `allowed-tools: Bash(git:*) Read`) and per-role dynamic filtering are concrete enforcement points.

### 4. Package Structure & Versioning

```
skill-name/                  # directory name MUST match `name`
├── SKILL.md                 # required: YAML frontmatter + instructions
├── scripts/                 # optional: executable code (run, not loaded)
├── references/              # optional: docs loaded on demand
├── assets/                  # optional: templates, data, images
└── metadata:                # version, author (via frontmatter `metadata`)
```

- Frontmatter fields/constraints are standardized (open spec, reference validator).
- Version via `metadata.version`.
- For tools: namespace by domain; rely on discovery (`listChanged` / `tool_search`).
- Beware runtime constraints: Anthropic's API sandbox has **no network and no runtime package install**, whereas Claude Code has full host network access — declare a skill's `compatibility` and security posture per surface.

---

## Full Citation List

**[1]** Zhang, B., Lazuka, K., & Murag, M. (Anthropic Engineering). *Equipping agents for the real world with Agent Skills.* 2025. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
**[2]** Anthropic / Agent Skills open standard. *Overview* and *Specification.* https://agentskills.io/ · https://agentskills.io/specification
**[3]** Anthropic. *Agent Skills* (platform docs). https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
**[4]** Anthropic. *Skill authoring best practices.* https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
**[5]** Model Context Protocol. *Specification (2025-06-18) — Overview & Security.* https://modelcontextprotocol.io/specification/2025-06-18
**[6]** Model Context Protocol. *Security Best Practices.* https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices
**[7]** Model Context Protocol. *Server Features — Tools.* https://modelcontextprotocol.io/specification/2025-06-18/server/tools
**[8]** Schick, T., et al. *Toolformer.* arXiv:2302.04761, 2023. https://arxiv.org/abs/2302.04761
**[9]** Patil, S. G., Zhang, T., Wang, X., & Gonzalez, J. E. *Gorilla: LLM Connected with Massive APIs.* arXiv:2305.15334, 2023. https://arxiv.org/abs/2305.15334
**[10]** Qin, Y., et al. *ToolLLM.* arXiv:2307.16789, 2023. https://arxiv.org/abs/2307.16789
**[11]** Wang, G., et al. *Voyager.* arXiv:2305.16291, 2023. https://arxiv.org/abs/2305.16291
**[12]** Li, M., et al. *API-Bank.* arXiv:2304.08244 (EMNLP 2023). https://arxiv.org/abs/2304.08244
**[13]** Patil, S. G., et al. *Berkeley Function Calling Leaderboard (BFCL).* ICML 2025. https://gorilla.cs.berkeley.edu/leaderboard.html
**[14]** Qin, Y., et al. *Tool Learning with Foundation Models.* arXiv:2304.08354, 2023. https://arxiv.org/abs/2304.08354
**[15]** Qu, C., et al. *Tool Learning with Large Language Models: A Survey.* arXiv:2405.17935, 2024. https://arxiv.org/abs/2405.17935
**[16]** OpenAI. *Function calling* (API guides). https://platform.openai.com/docs/guides/function-calling
**[17]** LangChain. *Tools* (OSS Python docs). https://docs.langchain.com/oss/python/langchain/tools
**[18]** Anthropic. *Tool use with Claude — Overview.* https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
**[19]** Willison, S. *The lethal trifecta for AI agents.* 2025. https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
**[20]** Beurer-Kellner, L., et al. *Design Patterns for Securing LLM Agents against Prompt Injections.* arXiv:2506.08837, 2025. https://arxiv.org/abs/2506.08837

**Source hygiene note:** arXiv:2306.11698 is *DecodingTrust*, not Gorilla; the Gorilla paper is arXiv:2305.15334. Verify identifiers before citing.
