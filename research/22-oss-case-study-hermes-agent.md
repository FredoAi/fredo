# Hermes Agent — Open-Source Setup Research

> Case study for Fredo open-sourcing. Identification: the user-facing "Hermes agent" alongside
> OpenClaw is **NousResearch/hermes-agent** — "The agent that grows with you" (self-improving
> personal AI agent). ~238k stars, 48.3k forks, MIT, Python, extremely active.
> Repo: https://github.com/NousResearch/hermes-agent — Docs: https://hermes-agent.nousresearch.com/docs/
>
> Ecosystem peers list them together: cc-switch ("Claude Code, Codex, OpenCode, OpenClaw, Grok
> Build & Hermes Agent"), AionUi, gbrain. Hermes even ships a `hermes claw migrate` command
> importing OpenClaw data (SOUL.md, skills, keys) — migration importers as growth strategy.

## 1. Repo Structure, Docs, License

Flat Python core + plugin dirs:

```
hermes-agent/
├── run_agent.py          # core loop
├── cli.py                # TUI
├── hermes_state.py       # SQLite sessions + FTS5
├── agent/                # prompt_builder, context_compressor…
├── hermes_cli/           # config, setup wizard, doctor, skills_hub
├── tools/                # self-registering tools + environments/ (7 sandbox backends)
├── gateway/              # messaging gateway + platforms/
├── plugins/, skills/, optional-skills/, optional-mcps/
├── docs/, website/       # Docusaurus docs site
├── evals/, tests/
├── contributors/         # contributor attribution directory
└── README.{es,zh-CN,ur-pk}.md, CONTRIBUTING.md (+es), SECURITY.md (+es), AGENTS.md
```

- **LICENSE:** MIT
- **README:** hero + feature table → Quick Install (curl + PowerShell installers) → CLI quickstart
  → docs table → command matrix (CLI vs messaging) → OpenClaw migration → Contributing →
  Community → License. Multilingual READMEs.
- **Docs:** Docusaurus — Getting Started / Using Hermes / Features / Messaging Platforms /
  Integrations / Guides / Developer Guide / Reference (CLI + env-var reference).

## 2. Security & Configuration

**SECURITY.md is a formal trust model:**
- **§2.2 The one load-bearing boundary:** "The only security boundary against an adversarial LLM
  is the operating system." Everything in-process (approval gate, redaction, allowlists) is
  explicitly declared heuristic / not-a-boundary.
- Two supported isolation postures: terminal-backend isolation (container/cloud sandbox) vs
  whole-process wrapping (own Docker/Compose). Operating outside documented postures = out of support.
- **Credential scoping:** env vars matching KEY/TOKEN/SECRET/etc. stripped from subprocesses,
  MCP subprocesses, and code-exec children; explicit passthrough only.
- **Plugin/skill trust model:** third-party skills run with full agent privileges → operator
  review before install is the boundary; scanners are "review aids" only.
- External surfaces: mandatory caller allowlists, fail-closed required by policy. Prompt
  injection per se out of scope; trust-model documentation violations in scope. 90-day disclosure.

**Runtime security layers** (docs/user-guide/security) — 8-layer defense:
- Dangerous-command approval (smart/manual/off modes)
- **Always-on hardline blocklist that survives `--yolo`** (`rm -rf /`, fork bombs…) + user-defined
  `approvals.deny` globs — "give users a footgun, but floor it"
- File-write denylist (~/.ssh, .env) + optional safe-root
- Hardened Docker defaults (`--cap-drop ALL`, no-new-privileges, pids-limit)
- SSRF protection (RFC1918/loopback/metadata, fail-closed DNS)
- Prompt-injection scanning of context files, website blocklist, supply-chain advisory banner

**Configuration split:** everything under `~/.hermes/` — `config.yaml` (settings only),
`.env` for secrets (chmod 600 guidance), `auth.json`, `state.db`, `skills/`, `memories/`.
**Secrets never in config.yaml.**

## 3. Contributing / Governance / Community

- **CONTRIBUTING.md is an engineering handbook:** explicit **contribution priority ordering**
  (bug fixes > cross-platform > security hardening > performance > new skills > new tools > docs),
  "search first" duplicate discipline, skill-vs-tool decision matrix, and a **closed-lists policy**:
  memory providers and third-party product integrations are NOT accepted in-repo — they must ship
  as standalone plugin repos (explicit maintenance-coupling rationale).
- **Skill authoring "HARDLINE" standards:** ≤60-char description, mandated SKILL.md section order,
  native-tool naming rules, human credited first, required tests per skill.
- **Supply-chain policy born from real incidents** (Mar 2026 litellm compromise, May 2026 npm worm):
  PyPI deps need `<next_major` ceilings, git deps pinned to full SHA, GitHub Actions pinned to SHA,
  CI `supply-chain-audit.yml` flags manifest changes. PRs with unbounded `>=` auto-rejected.
- Conventional commits, branch naming (`fix/`, `feat/`), hermetic CI test wrapper,
  **Windows-footgun linter run in CI** (`check-windows-footguns.py` greps PRs for POSIX-only patterns).
- Discord as community hub; Skills Hub at agentskills.io; Spanish translations of CONTRIBUTING
  and SECURITY; `AGENTS.md` for AI assistants; `hermes doctor` + `hermes update` command pair.

## 4. Practices Worth Copying for Fredo

1. **Write a real trust model, not a security disclaimer.** Fredo's docs/SECURITY.md already does
   this for IPC/OTLP — surface it publicly and copy the "what is out of scope" section.
2. **Fail-closed by default + always-on blocklist below all bypass flags.**
3. **Closed core, open ecosystem.** Reject in-tree third-party integrations; features ship as
   plugins/standalone repos. Fredo's feature-module architecture maps to this — write it into
   CONTRIBUTING as a non-goal.
4. **Supply-chain pinning policy with rationale tied to named incidents:** `<next_major` ceilings,
   SHA-pinned actions, CI audit workflow for manifest changes.
5. **Config split:** one YAML for settings, one `.env` for secrets, never mixed.
6. **Windows-footgun checklist as CI script** — directly relevant (Fredo is Windows-first).
7. **Migration importers as growth strategy** — lower switching costs.
8. **Approval-history mining** (`approvals suggest`) — delightful DX/security hybrid.
9. **Docs site separate from README** with command matrix + env-var reference.
10. **Multilingual README + SECURITY + CONTRIBUTING** (even just Spanish) — high leverage.

## Citations

- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/
- https://hermes-agent.nousresearch.com/docs/user-guide/security
- https://github.com/farion1231/cc-switch
- https://agentskills.io
