# Fredo Open-Source Launch — Synthesis & Roadmap

> Synthesis of research files 21–24 mapped against Fredo's current state (as of Aug 2026).
> Repo: FredoAi/fredo, solo maintainer on `main`, Tauri v2 + React 19 + Rust.

## Gap Analysis — Fredo today vs OSS standard

| Item | Status | Action |
|---|---|---|
| README.md | ⚠️ Developer-only | Rework: tagline → badges → screenshot/GIF → features → **end-user install first** → dev setup lower → contributing link → license note |
| Screenshots/demo GIF | ❌ Missing | Biggest gap — every UI project studied has one |
| LICENSE | ❌ Missing | `MIT OR Apache-2.0` (Tauri/Rust convention) or plain MIT |
| CONTRIBUTING.md | ❌ Missing | Minimal: bugs, build from source, `pnpm --filter @fredo/ui build` + `cargo check`, PR expectations; add non-goals (no refactor-only PRs, closed core / plugins-external) |
| CODE_OF_CONDUCT.md | ❌ Missing | Contributor Covenant verbatim |
| SECURITY.md (policy) | ⚠️ Have technical model only | `docs/SECURITY.md` is a good trust model — add root `.github/SECURITY.md` as the *policy*: private reporting, supported versions, 90-day disclosure, "what is NOT a vulnerability" (OpenClaw: 87% of 1,309 reports invalid) |
| CHANGELOG.md | ✅ Have | Keep maintainer-only |
| ARCHITECTURE.md | ✅ Have (docs/) | Already on par with Tauri's pattern |
| .github/CODEOWNERS | ❌ Missing | `* @owner` |
| .github/dependabot.yml | ❌ Missing | github-actions + npm + cargo ecosystems |
| Issue/PR templates | ❌ Missing | Forms + config.yml; PR template with "Problem / Evidence / checklist" |
| FUNDING.yml | ❌ Missing | Optional |
| Branch rulesets | ❌ Missing | See below |
| Release pipeline | ❌ Missing | tauri-action + updater keypair (later phase) |

## Phase 1 — Legal (before making public)

1. Add `LICENSE` (MIT OR Apache-2.0)
2. Logo/brand license note (CC-BY-NC-ND, Tauri pattern) + trademark/attribution note in README
3. Name check: WIPO Global Brand Database, GitHub/npm/crates.io search; reserve domain + handles
4. Scrub git history for secrets (`git log -p` review); secret scanning will verify after public

## Phase 2 — Repo files

1. Root `README.md` rework (see gap table)
2. `.github/SECURITY.md` (policy) — link to docs/SECURITY.md (trust model)
3. `CONTRIBUTING.md` — with contribution priority ordering (Hermes pattern) and non-goals
4. `CODE_OF_CONDUCT.md` — Contributor Covenant
5. `.github/CODEOWNERS` — `* @owner`
6. `.github/dependabot.yml` — actions/npm/cargo, weekly
7. `.github/ISSUE_TEMPLATE/` — bug_report.yml + feature_request.yml + config.yml
8. `.github/PULL_REQUEST_TEMPLATE.md` — Problem / Evidence / build-checklist
9. Audit workflow — daily `rustsec/audit-check@v2` + `pnpm audit` cron + on Cargo.lock changes
10. Verify CI workflow covers `cargo check` + `pnpm --filter @fredo/ui build` (needed as status checks)

## Phase 3 — GitHub settings (only I merge)

1. Branch ruleset `protect-main` on default branch: block force pushes/deletions, require PR
   (0 required approvals), require status checks (CI jobs), optional linear history
2. Tag ruleset on `v*`: restrict creations/deletions, block force pushes
3. Secret scanning + push protection (verify on)
4. Dependabot alerts + security updates
5. CodeQL Default setup
6. Private vulnerability reporting ← critical
7. Actions: workflow permissions default read-only; disable "Actions create/approve PRs"
8. Enable 2FA + passkey on account
9. Pin third-party Actions to full SHA (or enable repo SHA-pinning policy)
10. Set repo topics/tags for discoverability

## Phase 4 — Release & distribution (later)

1. `tauri signer generate` → updater keypair; pubkey in `tauri.conf.json`, private key as secret
2. `bundle.createUpdaterArtifacts: true` + updater endpoints config
3. Release workflow via `tauri-apps/tauri-action@v1` matrix (windows/macos/ubuntu) → draft releases
4. OS code-signing when budget allows (macOS notarization; Windows Authenticode vs SmartScreen)
5. Optional: Calver `YYYY.M.PATCH` + stable/beta channels; auto-update opt-in
6. Optional: `fredo doctor` command validating ports/permissions (OpenClaw `security audit` pattern)

## Cross-cutting policies worth adopting (from OpenClaw/Hermes)

- **Trust model honesty:** "the OS user is the security boundary; in-process checks are
  accident-prevention" — already in docs/SECURITY.md, surface it publicly
- **Fail-closed defaults documented as features:** 127.0.0.1-only binds, no network port
- **Closed core, open ecosystem:** third-party integrations ship as plugins, not in-tree
- **AI-assisted PRs welcome with disclosure + evidence** — fits Fredo's agentic pipeline
- **Supply-chain pinning policy:** deps capped `<next_major`, SHA-pinned actions, CI flags
  manifest changes
- **Maintainers-only CHANGELOG**
- **Post-incident transparency:** tie incidents to concrete doc/tool changes
