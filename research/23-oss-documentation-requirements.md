# OSS Documentation Requirements — Research from Successful GitHub Projects

> Studied: opensource.guide, choosealicense.com, and repo layouts of tauri-apps/tauri,
> microsoft/vscode, ast-grep/ast-grep, sst/opencode, calcom/cal.diy, excalidraw/excalidraw.
> Framing: Tauri v2 + React + Rust desktop app (Fredo) going public.

## 1. The Standard Doc Set

Per [opensource.guide](https://opensource.guide/starting-a-project/), the **minimum four**:
**LICENSE, README, CONTRIBUTING, CODE_OF_CONDUCT** — repo root, canonical filenames so GitHub
auto-surfaces them.

| Document | Required? | What the studied projects do |
|---|---|---|
| LICENSE | Yes (non-negotiable) | All six have one (see below) |
| README.md | Yes | All six; see §2 |
| CONTRIBUTING.md | Strongly recommended | Tauri (.github/CONTRIBUTING.md), VS Code (root + wiki), opencode, cal.diy, excalidraw, ast-grep |
| CODE_OF_CONDUCT.md | Strongly recommended | Tauri, VS Code (Microsoft OSS CoC), cal.diy (Contributor Covenant) |
| SECURITY.md | Recommended for anything users install | Tauri, VS Code, opencode, cal.diy — disclosure policy |
| CHANGELOG.md | Optional | ast-grep root file; Tauri `.changes/` fragment dir; VS Code site release notes. GitHub Releases-based changelog acceptable for solo dev |
| ARCHITECTURE.md | Optional but high-value | Tauri root ARCHITECTURE.md (how tao/WRY fit together) |
| Screenshots/demo GIF | Recommended for UI apps | opencode (screenshot + download table), VS Code, cal.diy (GIF), ast-grep, excalidraw |

### License choices of the studied projects

- **MIT:** VS Code, opencode, ast-grep, excalidraw, cal.diy
- **MIT OR Apache-2.0 (dual):** Tauri — the Rust ecosystem norm (Apache-2.0 adds explicit patent grant)
- **AGPL:** none of the six. Chosen by server/SaaS projects wanting network-service copyleft
  (Cal.com historically — which is why community fork cal.diy re-licensed to "100% MIT, no Open Core")

**Verdict for Fredo:** `MIT` (simplest) or `MIT OR Apache-2.0` (Tauri/Rust convention).
AGPL only if planning a hosted companion service.

## 2. README Structure of Top Projects

Common section order across all six:

1. **Logo/banner + one-line tagline** ("The open source coding agent" — opencode)
2. **Badges** (License, CI status, community, downloads) — one row max
3. **Screenshot or demo GIF** (all UI-adjacent projects)
4. **What it is / why** — short intro + feature list (excalidraw's emoji feature list is the template)
5. **Quick start / Installation** — as high as possible; end-user download/install FIRST
6. **Usage examples** (ast-grep shows real one-liners; `<details>` collapse for more methods)
7. **Contributing** — link to CONTRIBUTING.md
8. **Community/support links** (Discord, Discussions — VS Code lists channels explicitly)
9. **Sponsors / funding**
10. **License + trademark/attribution note** (Tauri: "Code: MIT or MIT/Apache 2.0. Logo: CC-BY-NC-ND")

Notable extras: opencode maintains 20+ translated READMEs; cal.diy opens with a warning callout
about self-hosting scope; VS Code distinguishes "Code - OSS" repo from the branded product.

## 3. docs/ Folder vs Website vs Wiki

- **Docs site (Docusaurus/VitePress):** where user guides, config references, tutorials live —
  tauri.app, opencode.ai/docs, ast-grep.github.io, docs.excalidraw.com, vscode docs repo.
- **In-repo folders:** excalidraw `dev-docs/` for contributor docs; cal.diy `docs/api-reference/`.
  Tauri's repo has NO user docs — only ARCHITECTURE.md + inline source doc comments.
- **Wiki:** VS Code uses it for roadmap/iteration plans; most modern projects avoid wikis.

**Rule of thumb:** README = marketing + quick start; docs site = user manual;
ARCHITECTURE.md / dev-docs/ = contributor internals; wiki = roadmap only (or skip).

**Fredo mapping:** README (public rework) + docs/ folder already covers ARCHITECTURE/SETUP/CLI/FAQ
— sufficient for v1. Add a VitePress site only if docs grow.

## 4. Trademark / Branding

- Pick a name that hints at function; check conflicts via namechecker + [WIPO Global Brand
  Database](http://www.wipo.int/branddb/en/); reserve domain + social handles BEFORE launch.
- **Code and brand assets are licensed separately.** Tauri: code MIT/Apache-2.0, logo CC-BY-NC-ND —
  prevents forks rebranding as official. Same pattern: VS Code name/icons are Microsoft trademark
  (OSS builds must be called VSCodium).
- **Naming policy for ecosystem projects:** opencode's "Building on OpenCode" clause — derivatives
  using the name must state they are not affiliated.
- Practical: logo under CC-BY-NC-ND or custom "no derivative branding" license; trademark policy
  note in README; check the name doesn't resemble existing trademarks.

## 5. Checklist for a Solo Dev Open-Sourcing a Desktop App

**Legal**
- [ ] LICENSE (MIT, or MIT OR Apache-2.0 for Rust side)
- [ ] License logo/brand separately (CC-BY-NC-ND)
- [ ] Name conflicts: WIPO Global Brand Database, GitHub/npm search; reserve domain + handles
- [ ] Scrub git history for secrets/keys

**Docs (repo root)**
- [ ] README: tagline → badges → screenshot/GIF → features → install/quick start → usage →
      contributing link → community → license note
- [ ] CONTRIBUTING.md (even minimal: bugs, build from source, run tests)
- [ ] CODE_OF_CONDUCT.md (Contributor Covenant — adopted by 40k+ projects)
- [ ] SECURITY.md (supported versions + private reporting)
- [ ] ARCHITECTURE.md (Fredo already has docs/ARCHITECTURE.md)
- [ ] .github/ issue + PR templates; FUNDING.yml if accepting donations

**Docs (beyond repo)**
- [ ] Decide: docs site (VitePress/Docusaurus) vs in-repo docs/ — both acceptable at solo scale
- [ ] CHANGELOG.md or GitHub Releases-based notes
- [ ] Screenshots/demo GIF for major features

**Housekeeping**
- [ ] Issue queue labeled and triaged before launch
- [ ] CI badge + build-from-source verified on a clean machine
- [ ] Trademark/attribution note in README
- [ ] Repo topics/tags set for discoverability

## Citations

- https://opensource.guide/starting-a-project/
- https://www.choosealicense.com/
- https://github.com/tauri-apps/tauri (ARCHITECTURE.md, dual MIT/Apache, CC-BY-NC-ND logo)
- https://github.com/microsoft/vscode (MIT, wiki-based contributor docs)
- https://github.com/ast-grep/ast-grep (MIT, root CHANGELOG.md, docs site)
- https://github.com/anomalyco/opencode (MIT, translated READMEs, naming clause)
- https://github.com/calcom/cal.diy (full MIT community edition)
- https://github.com/excalidraw/excalidraw (MIT, docs site + dev-docs/ split)
- https://contributor-covenant.org/
