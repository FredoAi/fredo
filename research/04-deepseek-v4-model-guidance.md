# Research Report: DeepSeek V4 Model-Specific Guidance

**Agent:** Research Analyst (DeepSeek model survey)
**Date:** 2026-07-31
**Scope:** `deepseek-v4-flash` / `deepseek-v4-pro` (aliased locally as `deepseek-v4-flash-free`), plus `mimo` (vision, NOT DeepSeek)

**Naming clarification:** `deepseek-v4-flash-free` (referenced in `.opencode/agents/software-architect.md:109`) is a project-local alias; the actual API model is `deepseek-v4-flash` (API docs confirm `deepseek-v4-flash` now points to **DeepSeek-V4-Flash-0731**, a substantially upgraded agentic release). All guidance applies to both spellings.

---

## 1. Executive Summary (Top 8 Findings)

1. **V4 is a reasoning-model generation with three effort modes (non-think / think-high / think-max), and thinking is ON by default at effort `high`.** In thinking mode, `temperature`, `top_p`, and presence/frequency penalties are **silently ignored** — they do not error and do nothing. This is the single most important fact for agent tuning: sampler settings you configure in opencode are inert unless thinking mode is disabled (`api-docs.deepseek.com/guides/thinking_mode`).

2. **1M-token context and 384K max output.** Both V4-Pro (1.6T total / 49B active) and V4-Flash (284B / 13B active) support 1M context; recommended max output for high/max reasoning is **384K**. System prompts of 10–30k tokens are far below any degradation risk; the real constraint is agent loop cost, not context (`api-docs.deepseek.com/quick_start/pricing`, model cards).

3. **`reasoning_content` is a first-class API field and MUST be passed back when tools are in play.** If a request carries the `tools` parameter, omitting `reasoning_content` in subsequent turns returns **HTTP 400**. Between plain user turns (no tool call) the API ignores prior `reasoning_content` — the agent layer must pass it back anyway to be safe. Reasonix, DeepSeek's own coding agent, ships "automatic tool-call repair" as a headline feature — evidence that tool-call reliability is the known weak spot (`api-docs.deepseek.com/guides/thinking_mode`, awesome-deepseek-agent/docs/reasonix.md).

4. **Agentic coding is the model's headline strength — V4-Flash-0731 exceeds V4-Pro-Preview on agent benchmarks** (Terminal Bench 2.1: 82.7 vs 72.1; Toolathlon-Verified 70.3 vs 55.9), evaluated at `max` reasoning effort with **temperature=1.0, top_p=0.95**. DeepSeek's own agent harness settings are the best starting point for agent definitions (DeepSeek-V4-Flash-0731 model card).

5. **The model speaks XML-ish "DSML" for tool calls and can emit it degraded.** The encoding format injects a `## Tools` schema block into the prompt and the model replies with `<｜DSML｜tool_calls>` markup. Community reports (HF #209) show V4-Pro sometimes emits an ASCII-degraded variant `<||DSML||...>` without newlines, which OpenCode-style clients fail to parse as structured tool_calls — the agent layer must tolerate/normalize these. Downstream parsing of `message.content` must be defensive.

6. **Raw safety metadata occasionally leaks into output.** Community reports on both V4-Pro (HF #201) and V4-Flash (#27) show `<ds_safety>...</ds_safety>` tags appearing inline in responses. Agent harnesses should strip `<ds_safety>...</ds_safety>` artifacts before surfacing text to the user.

7. **Structured JSON needs the official contract: `response_format={'type':'json_object'}` + the literal word "json" in the prompt + an example; empty content is a documented occasional failure.** For agent definitions, this favors tool-calls-as-schema over free-text-JSON instructions — and "strict" schema mode exists but is beta-gated behind the `/beta` base URL (`api-docs.deepseek.com/guides/json_mode`, `guides/tool_calls`).

8. **DeepSeek officially supports Anthropic-format and OpenAI-format endpoints and explicitly maps model tiers in agent tools** (Claude Code: `claude-opus*`→`deepseek-v4-pro`, `claude-sonnet*`/`claude-haiku*`→`deepseek-v4-flash`; recommends `CLAUDE_CODE_EFFORT_LEVEL=max`; supports the `[1m]` context suffix `deepseek-v4-pro[1m]`). OpenCode is a first-class supported integration (≥ v1.14.24). This means agent definitions written for Anthropic/OpenCode conventions translate directly (`api-docs.deepseek.com/quick_start/agent_integrations/claude_code`, `opencode`).

---

## 2. Official DeepSeek API Docs Findings

| Topic | Finding | URL |
|---|---|---|
| Models & endpoints | `deepseek-v4-flash` (now DeepSeek-V4-Flash-0731) and `deepseek-v4-pro`; OpenAI base `https://api.deepseek.com`, Anthropic base `https://api.deepseek.com/anthropic`. `deepseek-chat`/`deepseek-reasoner` retired Jul 24 2026 | https://api-docs.deepseek.com/ |
| Context / output | 1M context, **max 384K output** both models; thinking mode default | https://api-docs.deepseek.com/quick_start/pricing |
| Thinking mode | Default **on**, effort default **high**; `thinking: {"type":"enabled/disabled"}` (OpenAI), `reasoning:{effort:"none/low/high/max"}` (Anthropic); `reasoning_effort: "low/high/max"`. **temp/top_p ignored in thinking mode.** Effort mapping differs per model (Flash: low→low, high→high, xhigh→high, max→max; Pro currently maps all to high except max) | https://api-docs.deepseek.com/guides/thinking_mode |
| CoT field | `reasoning_content` returned parallel to `content`; must be passed back when `tools` present (400 otherwise); ignored between plain user turns | https://api-docs.deepseek.com/guides/thinking_mode |
| Tool calls | Full function-calling; strict-mode JSON-schema enforcement is beta (`base_url=.../beta`, `"strict": true`, all object props required, `additionalProperties:false`) | https://api-docs.deepseek.com/guides/tool_calls |
| JSON output | `response_format={'type':'json_object'}` + word "json" + example in prompt; "may occasionally return empty content" | https://api-docs.deepseek.com/guides/json_mode |
| Agent integrations | Claude Code env-var recipe; model mapping table; `CLAUDE_CODE_EFFORT_LEVEL=max`; `[1m]` model suffix; web-search tool supported | https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code |
| OpenCode integration | Native `deepseek` provider via `/connect`; requires opencode ≥ v1.14.24; select DeepSeek-V4-Pro | https://api-docs.deepseek.com/quick_start/agent_integrations/opencode |
| Release notes | V4 "dedicated optimizations for agent capabilities"; drives DeepSeek's in-house agentic coding; 1M context standard | https://api-docs.deepseek.com/news/news260424 |

---

## 3. HuggingFace Model Card Findings

| Model | Params | Key guidance | URL |
|---|---|---|---|
| **DeepSeek-V4-Pro** | 1.6T / 49B act. | Three reasoning modes with defined response formats: Non-think (`</think>` summary), Think High (`<think>...</think>` summary), Think Max ("special system prompt" + `<think>`). Local sampling: `temperature=1.0, top_p=1.0`; Think Max needs ≥384K context. SWE-bench Verified 80.6. **No Jinja template — dedicated `encoding` folder** | https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro |
| **DeepSeek-V4-Flash-0731** (current `deepseek-v4-flash`) | 304B (w/ DSpark spec-decode) | Agentic release; beats Pro-Preview on Terminal Bench 2.1 (82.7), NL2Repo, Toolathlon, DSBench. **Eval recipe: `max` effort, `temperature=1.0, top_p=0.95`.** Local: temp 1.0 / top_p 0.95 (agentic) or 1.0 (general); 384K max output for high/max | https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731 |
| DeepSeek-V4-Flash (preview) | 284B / 13B act. | Same reasoning-mode table; local temp 1.0/top_p 1.0; 384K for Think Max | https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash |
| Collection | — | All 7 V4 artifacts | https://huggingface.co/collections/deepseek-ai/deepseek-v4 |
| Technical report | — | CSA/HCA long-context architecture; 32T pretrain; "Towards Highly Efficient Million-Token Context Intelligence" | https://arxiv.org/abs/2606.19348 |

**Encoding / chat-template facts (from `encoding/README.md` on both cards — this is the canonical prompt format):**
- Special tokens: `<｜begin▁of▁sentence｜>`, `<｜end▁of▁sentence｜>`, `<｜User｜>`, `<｜Assistant｜>`, `<think>/</think>`, `<｜DSML｜>`.
- Roles: `system`, `user`, `assistant`, `tool`, `latest_reminder`, and `developer` — **`developer` is accepted ONLY in DeepSeek's internal search-agent pipeline; the public API rejects it.** Do not put agent definitions in a developer role.
- System prompt is a plain prefix right after BOS; there is no special "emphasis" treatment of the system message beyond position.
- `drop_thinking` (default true): without tools, earlier reasoning is stripped; **with tools, all reasoning is preserved across turns** — long agent loops with tools accumulate full CoT in context (cost/context driver).
- `reasoning_effort="max"` prepends a fixed "Absolute maximum with no shortcuts permitted…" prefix *before the system message* — so don't duplicate "be thorough" instructions at max effort.
- Tool definitions are injected into the system/user prompt as a `## Tools` block and the model replies in `<｜DSML｜tool_calls>` markup — this is the model's native format; OpenAI-format `tool_calls` in the response is produced by the API server, not the local model.

---

## 4. Community / Agent-Integration Findings

| Source | Finding | URL |
|---|---|---|
| HF discussion #209 (V4-Pro) | Model output sometimes contains **DSML tool-call markup inside `message.content` instead of structured `tool_calls`**, emitted as degraded `<\|DSML\|>` (ASCII) with no newlines; community workaround = regex-normalize DSML variants + newlines before parsing. Tool-call parsing must be defensive | https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/209 |
| HF discussion #201 (V4-Pro) | Raw `<ds_safety>不涉及…</ds_safety>Safe` moderation tag intermittently leaks into visible output; breaks response format | https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/201 |
| HF discussion #27 (V4-Flash) | Same `<ds_safety>` leakage on Flash | https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/discussions/27 |
| HF discussion #169 | Community report of "too much positivity bias" (relevant when weighting persona) | https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/169 |
| Reasonix (DeepSeek-native agent) | Designed around the API "without a translation shim": **cache-first loop, flash-first cost control, automatic tool-call repair** — i.e., even DeepSeek's own ecosystem treats tool-call repair as required functionality | https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/reasonix.md |
| Deep Code (DeepSeek-native agent) | Defaults `thinkingEnabled: true`, `reasoningEffort: "max"` for `deepseek-v4-pro`; supports Agent Skills from `~/.agents/skills/<name>/SKILL.md` | https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/deepcode.md |
| OpenCode docs (Models) | "Only a few models are good at both generating code and tool calling"; recommended list does **not** currently include DeepSeek (it lists GPT-5.2, Claude Opus/Sonnet 4.5, Minimax M2.1, Gemini 3 Pro) — treat DeepSeek tool reliability as "good but requires hardening," consistent with #209 | https://opencode.ai/docs/models/ |
| awesome-deepseek-agent | 20+ curated agent integrations (Claude Code, Cline, Codex, OpenCode, GitHub Copilot, DeepSeek-TUI with "1M context", etc.) — official ecosystem index | https://github.com/deepseek-ai/awesome-deepseek-agent |
| Project-local telemetry (fredo) | Real-world signal from this repo's own pipeline: on `deepseek-v4-flash-free`, `session.status` delta spans = **zero** observed; `message.part.updated` with `part.type='subtask'` **never emitted** (0/243 spans) — event streams assumed for other models must be verified against DeepSeek runtime emission, not assumed | `.opencode/agents/software-architect.md`, `.opencode/skills/fredo-cli-events/SKILL.md`, `apps/tauri/src-tauri/.../adapters/opencode.rs` |

---

## 5. Concrete Recommendations for Writing Agent Definition Files Running on DeepSeek V4

1. **Put the agent definition in the `system` message (never `developer`).** The public API rejects the `developer` role; system is the only first-class long-lived role the API accepts. `system` renders as a plain prefix after BOS — position it before all tool definitions and conversation so it anchors behavior.

2. **Write for the thinking-mode contract, and remember temp/top_p are inert when thinking is on.** Because thinking defaults to on (effort `high`), any `temperature`/`top_p` you set in agent config has **zero effect** unless you explicitly disable thinking. Don't rely on low temperature to enforce format discipline — rely on schema + examples instead. If you do tune sampling, use the official agentic recipe `temperature=1.0, top_p=0.95` (Flash-0731 card) or `1.0/1.0` (Pro card) in non-thinking mode.

3. **Don't write "think step by step" boilerplate into agent definitions.** At `reasoning_effort="max"` the API already prepends an official "Absolute maximum with no shortcuts permitted…" reasoning preamble before the system message. Redundant exhortations waste tokens and can fight the built-in preamble. Keep the definition *functional* (goals, constraints, output contracts), not motivational.

4. **Never instruct the model to emit JSON in free text.** Require tool calls or `response_format=json_object`. When you need JSON from a non-tool turn, include the word "json" and an explicit example in the prompt, and treat empty-content as a documented failure mode (retry-on-empty logic in the harness).

5. **Be explicit about the model's own thinking block.** In thinking mode the final answer is emitted after `<think>...</think>`; agent code that renders or logs assistant output should separate `reasoning_content` from `content` and should **not** rely on the visible `<think>` tags being present in `content` (the API strips/returns them via `reasoning_content`; local serving differs).

6. **Plan for tool-call-markup fragility in the harness, not just the prompt.** On self-hosted/local paths, V4 may emit DSML tool-call markup (canonical `<｜DSML｜…>` or degraded `<||DSML||…>`) inline in `content` rather than as structured `tool_calls`. The agent layer must: (a) parse tool calls from either the structured field or a DSML block, (b) normalize ASCII `|` → full-width `｜`, (c) tolerate compact markup without newlines. Do not let raw DSML leak to the user or to downstream consumers. When using the official hosted API (opencode `deepseek` provider), rely on its structured-tool-call pipeline and treat any inline DSML as a residual edge case.

7. **Remember `reasoning_content` must round-trip.** Any harness that builds its own API requests with tools must pass the previous assistant `reasoning_content` back or it will get HTTP 400. Using opencode's built-in DeepSeek provider (≥ v1.14.24) handles this for you — a strong argument for not hand-rolling the Anthropic/OpenAI shim.

8. **Strip safety artifacts.** Add a filter for `<ds_safety>…</ds_safety>` (and any trailing "Safe") in agent output before display or persistence; both Flash and Pro leak it intermittently.

9. **Exploit 1M context, but budget CoT accumulation.** System prompts of 10–30k tokens are safe (DeepSeek's long-context design is 27% FLOPs / 10% KV-cache vs V3.2 at 1M). However, in tool-using loops **all** prior reasoning is preserved (drop_thinking off), so long agent sessions grow fast — prefer compact agent definitions, prune earlier tool results, and consider context-caching (DeepSeek supports cache-hit pricing, ~50x cheaper input on cache hit) rather than stuffing agent definitions with static reference material.

10. **Use the `[1m]` context suffix and tier mapping when driving Anthropic-format agents.** For Claude Code-style harnesses: `deepseek-v4-pro[1m]` for main, `deepseek-v4-flash` for subagents, `CLAUDE_CODE_EFFORT_LEVEL=max` (DeepSeek's own recommended recipe). Because opus→pro and sonnet/haiku→flash, agent definitions that reference model tiers will resolve to Flash for cheap subagents — write subagent definitions to be efficient on Flash, reserve deep-reasoning work for Pro.

11. **Set effort per role.** `deepseek-v4-flash`'s effort mapping (`xhigh`→`high`, `max`→`max`) means subagents get real quality gains at `max`. Map: cheap/high-volume agents (developer, documentation) → flash @ high/max; planning/architecture/review agents → pro @ max. This mirrors the pipeline already in this repo (flash for product-owner/developer, pro for architect/QA/self-improver).

12. **Persona: keep it light and functional.** Community reports flag positivity bias/over-empathy rather than persona-sensitivity. A short role line ("You are the Software Architect in an SDD pipeline…") helps; extensive persona flavor is wasted tokens and can amplify the model's cheerfulness. Prefer crisp "always/never" behavioral rules over personality description.

13. **Verify event/format assumptions against the actual model** (DeepSeek-specific). Do not assume event streams or field paths port from other backends: this repo's telemetry shows `session.status` deltas and `message.part.updated(subtask)` **never fire** on `deepseek-v4-flash-free`. Agent/harness designs that depend on streaming delta events or sub-task part types must have a fallback path (e.g., extract from `session.updated` final payloads).

---

## 6. Source List

**Official docs**
- https://api-docs.deepseek.com/ — Your First API Call (models, base URLs, agent integrations)
- https://api-docs.deepseek.com/quick_start/pricing — context 1M / output 384K / thinking default / features
- https://api-docs.deepseek.com/guides/thinking_mode — thinking toggle, effort mapping, temperature ignored, `reasoning_content` rules, tool-call passback (400)
- https://api-docs.deepseek.com/guides/tool_calls — function calling, `strict` beta mode, supported JSON-schema types
- https://api-docs.deepseek.com/guides/json_mode — JSON output contract + empty-content caveat
- https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code — env vars, model mapping, `[1m]`, effort=max
- https://api-docs.deepseek.com/quick_start/agent_integrations/opencode — native opencode provider, v1.14.24+
- https://api-docs.deepseek.com/news/news260424 — V4 preview release notes, agent optimizations, legacy-model retirement

**Model cards / HuggingFace**
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro — 1.6T, reasoning-mode table, sampling + 384K guidance
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731 — current flash release, agentic benchmarks, temp 1.0/top_p 0.95 agentic recipe
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash — preview flash card
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/encoding/README.md — canonical encoding: tokens, roles, thinking/drop_thinking, DSML tool format, max-effort preamble
- https://huggingface.co/collections/deepseek-ai/deepseek-v4 — official V4 collection
- https://arxiv.org/abs/2606.19348 — DeepSeek-V4 technical report (1M-context architecture)

**Community / agent-integration**
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/209 — DSML markup degradation quirk + normalizer
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/201 — `<ds_safety>` tag leak (Pro)
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/discussions/27 — `<ds_safety>` tag leak (Flash)
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/discussions/169 — positivity-bias report
- https://github.com/deepseek-ai/awesome-deepseek-agent — official agent-integration index (Claude Code, Cline, OpenCode, Copilot, etc.)
- https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/reasonix.md — cache-first, flash-first, automatic tool-call repair
- https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/deepcode.md — thinking enabled + max effort defaults
- https://opencode.ai/docs/models/ — recommended models + tool-calling commentary
- Project-local: `opencode.json`, `.opencode/agents/software-architect.md`, `.opencode/skills/fredo-cli-events/SKILL.md` — telemetry-verified DeepSeek event-emission gaps

**Caveats:** search engines (DuckDuckGo/Bing) blocked bot access, so live Reddit/r/LocalLLaMA threads were not directly captured; the community findings above are from primary HF discussion threads and official repos. The environment date is Jul 31 2026; V4-Pro is still a "preview" per DeepSeek, and effort-mapping for Pro is scheduled to change in early Aug 2026 — re-verify before locking config.
