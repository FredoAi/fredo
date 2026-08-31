# OpenClaw — Open-Source Setup Research

> Case study for Fredo open-sourcing. OpenClaw is the viral open-source personal AI assistant
> (formerly "Clawdbot" → "Moltbot" → renamed **OpenClaw** Jan 2026). ~388k stars, MIT, pnpm workspace.
> Repo: https://github.com/openclaw/openclaw — Docs: https://docs.openclaw.ai (note: `.ai`, not `.com`)

## 1. Repo & Docs Structure

Top-level root files: `README.md`, `VISION.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`THIRD_PARTY_NOTICES.md`, `LICENSE`, plus `AGENTS.md`/`CLAUDE.md` (agent dev instructions),
`.pre-commit-config.yaml`, `.semgrepignore`, Dockerfile, `appcast.xml` (macOS Sparkle updates).
Notable dirs: `security/` (OpenGrep rulepacks, incident-response plan), `qa/`, `extensions/`,
`skills/`, `ui/`, `apps/` (macOS/iOS/Android).

**README sections**: hero + badges → Install (curl scripts) → Quick start → How it fits together →
Security (3-line summary + links) → goal→link Documentation table → Development → Community →
Sponsors → Contributors.

**Docs site** — every page has YAML frontmatter (`summary`, `read_when`) and a hub index at
[/start/hubs](https://docs.openclaw.ai/start/hubs):
- **Start**: getting-started, onboarding, setup, showcase, docs-directory
- **Install**: install, updating, release channels, installer internals, docker, nix, backups, migrating, uninstall
- **Gateway & Ops**: security, sandboxing, exposure runbook, audit checks, doctor, troubleshooting
- **Project meta**: release policy (`/reference/RELEASING`), testing, PR review flow

## 2. Security Handling

- **SECURITY.md is a full trust model document**, not just a contact page: private GitHub Security
  Advisory disclosure, per-repo routing, strict report acceptance gate (required repro +
  demonstrated boundary-crossing impact), "what is NOT a vulnerability" lists, deployment
  assumptions, "one trusted operator per gateway" model. No paid bug bounty. Warns of AI-scanner slop.
- **Security guide**: safe defaults (loopback bind, pairing codes, allowlists), built-in
  **`openclaw security audit [--deep|--fix]`** command with structured check IDs, trust-boundary
  matrix, threat model ("Identity first, scope next, model last"), prompt-injection guidance.
- **Incidents & responses**:
  - **Rename churn**: Anthropic legal ask → rename → they did trademark searches and bought domains this time.
  - **Advisory flood**: [1,309 GHSA reports in ~3.5 months, 87% of "critical" invalid](https://openclaw.ai/blog/openclaw-security-in-public). Response: SECURITY.md as triage contract, bot triage (ClawSweeper), CodeQL/OpenGrep scanning.
  - **Stability crisis (Apr–May 2026)**: releases broke installs → apology post ("rough week"),
    delivered **Extended-Stable + Maturity Scorecard** (LTS-ish channel, Jul 2026).
  - **Supply chain**: VirusTotal scanning of marketplace skills; NVIDIA SkillSpector + Skill Cards.
- Tooling added post-incident: `security audit` command, exposure runbook, exec approvals,
  security roadmap, `security/` dir with incident-response plan.

## 3. Releases, Versioning & Distribution

- **Calver versioning**: `YYYY.M.PATCH` (e.g. 2026.4.29); git tags `vYYYY.M.PATCH`, immutable.
- **Four channels**: `stable`, `extended-stable` (trailing LTS, never auto-applies), `beta`, `dev`
  (git main). Stable ships to beta first, then promotes. Auto-rollback on failed updates.
- **Distribution**: npm package, curl installer, PowerShell installer, source checkout, Docker
  (non-root, `--read-only`, `--cap-drop=ALL`), Nix, cloud one-clicks. Desktop: signed macOS DMG
  via GitHub Releases + Sparkle `appcast.xml`; signed Windows installer via separate releases repo.
- **Auto-updater is off by default.** Post-update health checks + verified pre-update backups.

## 4. Governance & Contributing

- **CONTRIBUTING.md**: explicit "what we don't accept" (refactor-only PRs, test/CI-only PRs for
  known main failures; features go to plugins via SDK), routing table for issues/PRs/support,
  **20 open PRs per author cap**, PR template requiring "What Problem This Solves" + "Evidence"
  (screenshots before/after), maintainers-only `CHANGELOG.md` edits, CODEOWNERS for security paths,
  and a **"AI/Vibe-Coded PRs Welcome"** section (must be marked, include evidence/prompts).
- No CLA/DCO — governance rests on MIT license + Foundation stewardship.
- **Funding**: OpenClaw Foundation (501(c)(3), Jul 2026), GitHub Sponsors, sponsor logos in README.
- Community: Discord (support routed there, not GitHub issues), issue templates/forms, meetups.

## 5. Practices Worth Copying for Fredo

1. **SECURITY.md as a trust model** — state security boundaries (IPC bridge, local socket, fs
   access), what is NOT a vulnerability, private reporting path + required report contents.
2. **A self-audit / `doctor` command** — maps to a future `fredo doctor` validating local config,
   file permissions, port bindings (Fredo already binds MCP/OTLP to 127.0.0.1).
3. **Document defaults as security features** — "binds loopback, no network port" belongs in the
   public README, not just internal docs; warn when someone changes it.
4. **Explicit non-goals in CONTRIBUTING** — no refactor-only PRs, PR cap, evidence-based template.
5. **Welcome AI-assisted PRs with disclosure rules** — fits Fredo's agentic pipeline.
6. **Calver + staged channels** — even a lightweight GitHub pre-release channel beats ad-hoc
   versioning; keep auto-update opt-in (Tauri updater default-off mirrors this).
7. **Signed artifacts + update feed** — signed installers + appcast/updater JSON.
8. **Frontmatter'd docs with `read_when` + hub index** — cheap, works for humans and AI agents.
9. **Post-incident transparency posts** — tie each incident to a concrete doc/tool addition.
10. **Maintainers-only changelog**, CODEOWNERS for sensitive paths, `THIRD_PARTY_NOTICES.md`,
    `VISION.md` separate from README.

## Citations

- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai/start/hubs
- https://docs.openclaw.ai/gateway/security
- https://openclaw.ai/blog/openclaw-security-in-public
- https://openclaw.ai/blog/openclaw-rough-week
- https://openclaw.ai/blog/extended-stable-releases-and-maturity-scorecards
- https://openclaw.ai/blog/introducing-openclaw-foundation
